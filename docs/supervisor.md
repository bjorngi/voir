# voir-supervisor — configuration and behavior reference

**Status:** implemented; this documents the behavior as built
(`bin/voir-supervisor.mjs`). For the launch-anywhere one-shot, see
[acp-spawn](./sandbox.md).

The supervisor owns what *should* be running on one machine and
converges to it. It never talks to agents in the abstract — it
runs preset commands in directories, bridges them, and registers
them with a Voir instance. Voir has no supervisor awareness: a
supervised agent and a one-shot `acp-spawn` are indistinguishable
to it, by design.

## The three files

Two files with two owners, plus a discovery file the CLI uses:

### 1. Config — authored by you, never written by the supervisor

Default path: `~/.config/voir/supervisor.json` (override:
`--config <path>`).

```jsonc
{
  // Where the running Voir is. Registration POSTs go to
  // <ui>/api/folders — the same seam the one-shot launcher
  // uses.
  "ui": "https://chat.lab",

  // The fleet catalog: name → command. This is where
  // sandboxing lives; the raw command never crosses the API,
  // so the UI can only ever ask for a preset by name.
  "presets": {
    "pi": "pi-acp",
    "pi-fenced": "fence exec --private . -- pi-acp",
    "opencode": "opencode acp"
  },

  // Optional. When set, every API request except GET /health
  // must carry `Authorization: Bearer <apiToken>`.
  "apiToken": "a-long-random-string"
}
```

Reloaded on `SIGHUP` (presets and ui only) — edit and
`pkill -HUP voir-supervisor` to apply without a restart. The
next re-registration to Voir (within 30s) carries the change.

### Registration payload — supervisor awareness

An agent the supervisor launched registers with more than
`path`, `agentUrl` and `agentName`. The POST to Voir also
carries the fence switching bookkeeping:

```jsonc
{
  "path": "/home/bjorn/code/infra",
  "agentUrl": "http://127.0.0.1:43127/",
  "agentName": "infra",
  "preset": "pi-fenced",                // which preset launched it
  "presetOptions": ["pi", "pi-fenced"], // the catalog's names
  "supervisor": { "port": 7420, "token": "…" } // the daemon's loopback API
}
```

The raw preset commands never cross the API — Voir only ever
learns preset *names* and how to reach the daemon (it proxies
switches through it; see [Switching a preset from Voir](#switching-a-preset-from-voir)).
When `apiToken` is configured, the token is part of this
payload — it crosses to Voir over the registration POST and is
held server-side only (`FolderState.supervisor`, never the
browser). One-shot `acp-spawn` agents send none of this; Voir
treats them as having no fence to switch.

**Not supported today:** per-agent `--bind`/`--url` overrides (the
containerized case). The supervisor always binds bridges on
127.0.0.1 with self-derived URLs — i.e. the on-host deployment
where supervisor and Voir share the machine. Containerized agents
still go through one-shot `acp-spawn --bind 0.0.0.0 --url …`.

### 2. State — managed by the supervisor, desired state only

Default path: `~/.local/state/voir/agents.json` (override:
`--state <path>`).

```jsonc
[
  { "dir": "/home/bjorn/code/infra", "preset": "pi-fenced", "name": "infra" },
  { "dir": "/home/bjorn/code/voir",   "preset": "pi" }
]
```

- `dir` — absolute worktree path. Must exist when the agent
  starts; a missing directory logs and skips, it never deletes
  the entry.
- `preset` — must name a key in the config's `presets`. A missing
  preset (config edited away) marks the entry errored and leaves
  the state alone — desired state is never silently rewritten to
  fix a config problem.
- `name` — optional identity. Via the API/CLI it is generated
  when omitted (`<preset>-<hex6>`) and **persisted in the state
  file**, so identity survives boots (per-boot generation would
  orphan the Voir agent on every restart). Hand-written entries
  without a name default to the preset as their identity — so
  hand-write a name when two agents share one path. This is
  what Voir keys the agent by (path + name) and what the API and
  CLI use.

The file is *desired* state, not observed: what should exist, not
what does. What actually runs lives in the supervisor's memory.
The supervisor writes the file atomically (temp + rename) on every
add/remove, watches it, and converges on any change — hand edits
are supported and honored within ~50ms.

### 3. Discovery — how the CLI finds a running daemon

Written next to the state file (same directory,
`supervisor.json`):

```jsonc
{ "pid": 1234, "port": 7420, "startedAt": 1764000000000 }
```

Written on boot, removed on clean shutdown. The CLI reads it,
checks the pid is alive, probes `GET /health`, and only then
talks to the daemon.

## How convergence works

- **Boot:** every state entry gets a child (preset command, cwd =
  `dir`), a bridge on a free loopback port, and the registration
  loop. Entries whose preset no longer exists are skipped and
  logged.
- **Registration:** initial POST to `<ui>/api/folders` retries
  every 10s until it lands (a Voir restarting is expected), then
  re-registers every 30s so a Voir restart self-heals. State
  transitions are logged; routine re-registrations are silent.
- **Crash:** the child exiting on its own schedules a restart with
  per-entry backoff — 1s doubling to a 30s cap. Backoff resets
  after 60s of uptime. Ten consecutive crashes mark the entry
  `errored`: no
  more restarts, the entry stays in the state file, a human fixes
  the preset or removes the entry.
- **Safety net:** a full reconcile pass runs every 30s regardless,
  so even a missed file event or a wedged child self-heals.
- **Shutdown (SIGINT/SIGTERM):** every running agent gets a
  best-effort `DELETE /api/folders` (by path + name), its child is
  SIGTERMed, the API server closes, the discovery file is removed.

## The HTTP API

Loopback only, default port 7420 (override: `--api-port`).
`apiToken` in the config enables bearer auth on everything except
`/health`. This is the seam a future "launch from the UI" flow
forwards to — no new machinery in Voir required.

```
GET  /health               → 200 { ok, uptimeMs, agents }   (no token)
GET  /presets              → 200 { presets: { … } }
GET  /agents               → 200 { agents: [
                                 { name, dir, preset,
                                   status: "running" | "errored" | "stopped",
                                   agentUrl, crashes } ] }
POST /agents               → 201 { name }
     body: { dir, preset, name? }
     name is generated (<preset>-<hex6>) when omitted
     400 unknown preset (response lists the available names)
     400 not a directory
     409 name already in use
PATCH /agents/<name|dir>   → 200 { name, preset, previous, changed } | 404
     body: { preset }
     switches the agent's preset: desired state is rewritten, the
     child is stopped and immediately restarted under the new
     command (Voir is NOT unregistered — the folder stays, the
     new child's registration swaps the agent leg under open
     chats). Crash bookkeeping is cleared; an errored entry
     gets a fresh attempt under the new preset. A refused
     switch (unknown preset) writes nothing.
DELETE /agents/<name|dir>  → 200 { removed }   | 404
```

`status` semantics: `running` (a live child), `errored` (crashed
too often; kept in state), `stopped` (desired but not currently
running — e.g. waiting on its restart backoff).

## The CLI

```
voir-supervisor run                          # the daemon (default subcommand)
voir-supervisor add <dir> --preset <p> [--name <n>]
voir-supervisor set <name|dir> --preset <p>  # switch the preset, restart
voir-supervisor rm <name|dir>
voir-supervisor ls
```

`--name` is optional everywhere: omitted names are generated
(`<preset>-<hex6>` via the daemon, `agent-<hex6>` for one-shot
`acp-spawn`), so spawning another agent in the same folder never
requires inventing a name.

Flags: `--config`, `--state`, `--api-port` (all with the defaults
above). `add` expands `~` in `<dir>`.

Behavior when the daemon is up: `add`/`set`/`rm`/`ls` go through
the API — add triggers an immediate launch, set restarts the
agent under the new preset, rm stops and unregisters it.

Behavior when the daemon is down: `add` validates the preset
against the config and appends to the state file directly, then
says so ("it will start on next boot"); `set` validates and
rewrites the entry in place (apply on next boot); `rm` rewrites
the state file; `ls` lists the desired state. The daemon
converges on its next boot. Desired state is always the truth;
the daemon is just the thing that makes it true.

One-shot agents (`acp-spawn` in a scratch worktree) are invisible
to the supervisor by design: they never appear in the state file,
never get restarted, and die with their terminal.

The folder appears in Voir within seconds (registration), and
again after every Voir restart (30s re-registration), every
machine reboot (run the daemon from systemd), and every agent
crash (backoff restart).

## Switching a preset from Voir

The fence an agent runs under is not frozen at launch. Where
the preset catalog defines the fleet, the chat's model/mode
drawer carries a third select — **Fence** — listing the
catalog's presets. Pick one and:

1. the chat POSTs `PATCH /api/folders` with the path, the
   session id and the preset;
2. Voir resolves the agent that owns that chat (even when
   several agents share the worktree) and proxies the switch
   to the supervisor's loopback API (`PATCH /agents/<key>`,
   bearer when configured) — `app/lib/supervisor-proxy.server.ts`;
3. the supervisor validates the preset against its catalog,
   rewrites the desired state, and restarts the agent under
   the new command immediately.

The agent identity (path + name) survives the switch, so open
chats keep their session: Voir never sees an unregister — the
new child's registration swaps the agent leg under the live
connection (the same self-heal path an agent crash uses, minus
the crash). An in-flight turn dies like one. The CLI
equivalent is `voir-supervisor set <name|dir> --preset <p>`.

**What Voir clears on a switch.** Voir detects the completed
switch at the restarted agent's re-registration (its POST now
names a different preset). Everything the old fence cached is
dropped: the session/list TTL cache (a different fence profile
may keep its store elsewhere), the advertised models / modes /
commands, and the transcripts — replayed from agent truth, with
open tabs resnapshooting. The folder list reads fences, not
agent names: the row chip shows the preset (the agent's
generated name only ever shows when the agent isn't
supervisor-managed). The same clearing is available on demand:
the model drawer's bottom row — **Clear cache** — POSTs
`PATCH /api/folders { cache: "clear" }` and re-syncs this chat's
agent without touching the preset.

One-shot `acp-spawn` agents have no preset and no picker —
restart them with the command you want instead. Voir's PATCH
is a proxy, not a policy: on a host where Voir has no auth, a
preset switch is as reachable as every other endpoint (prompt,
cancel, unregister) — put auth in front of Voir before
exposing it.

## Walkthrough: a machine's first run

```sh
mkdir -p ~/.config/voir
cat > ~/.config/voir/supervisor.json <<'EOF'
{
  "ui": "https://chat.lab",
  "presets": { "pi": "pi-acp", "pi-fenced": "fence exec --private . -- pi-acp" }
}
EOF

voir-supervisor add ~/code/infra --preset pi-fenced   # or edit agents.json
voir-supervisor                                        # run the daemon
voir-supervisor ls                                      # ▶ pi-fenced … /home/bjorn/code/infra
```

The folder appears in Voir within seconds (registration), and
again after every Voir restart (30s re-registration), every
machine reboot (run the daemon from systemd), and every agent
crash (backoff restart).

### systemd user unit

`~/.config/systemd/user/voir-supervisor.service`:

```ini
[Unit]
Description=voir-supervisor — agent fleet for one machine
After=network-online.target

[Service]
ExecStart=%h/.npm-global/bin/voir-supervisor run
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now voir-supervisor
```

## Not in scope today

- **Auth between supervisor and Voir** — registration is
  unauthenticated, same as the one-shot launcher. The token
  story (registration token, bridge bearer auth) is a separate
  change that lands before any remote-machine setup. The
  `apiToken` (Voir → supervisor, for the preset-switch proxy)
  exists and travels to Voir in the registration payload; see
  the payload section above.
- **Launch from the Voir UI** — deliberately deferred; the API
  is the seam such a flow needs. (Preset *switching* from Voir
  is in — same seam, one PATCH.)
- **Containerized agents** — no `--bind`/`--url` pass-through;
  use one-shot `acp-spawn` in compose today. For the same
  reason the switch proxy targets `127.0.0.1` only: it covers
  the supported on-host deployment.
- **Cluster anything** — one supervisor per machine, no
  supervisor-to-supervisor awareness. Voir's sidebar is the only
  place the fleet is ever seen together.