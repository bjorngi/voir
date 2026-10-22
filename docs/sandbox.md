# Sandbox / fence integration

Voir ships with two ways to run agents on a machine:

- `bin/acp-spawn` — the per-folder launcher. One shot: spawn,
  expose, register, die with the terminal. The official way to
  attach a worktree to a running Voir by hand.
- `bin/voir-supervisor` — the resident supervisor. Owns what
  *should* be running on the machine, converges to it, and
  restarts crashed agents. For standing folders that must
  survive reboots. Full reference: [docs/supervisor.md](./supervisor.md).

Both share the same bridge and registration core
(`bin/acp-lib.mjs`); a supervised agent and a one-shot one are
indistinguishable to Voir.

Neither sandboxes the agent — that's your responsibility. Wrap
the agent in `fence` / `bwrap` / `firejail` / namespace-tools
however you like, then point the preset or `--agent` flag at the
wrapped command.

## Basic usage

```sh
cd /home/me/worktrees/feat-42
acp-spawn --agent pi-acp --ui http://localhost:9000
# --name is optional: omitted, a random agent-<hex6> identity is
# generated, so several ad-hoc agents can share a worktree.
```

That spawns `pi-acp` in the current directory, picks a free port,
starts the stdio-to-HTTP bridge, and registers the folder with
Voir. `Ctrl-C` to unregister and shut everything down.

## Sandboxing

The `--agent` flag takes any command. Wrap your real command with
your sandbox binary:

```sh
# fence
acp-spawn --agent 'fence exec --private . -- pi-acp' --name pi --ui http://localhost:9000

# bwrap
acp-spawn --agent 'bwrap --unshare-all --bind . . --tmpfs /tmp --dev --proc -- pi-acp' --name pi --ui http://localhost:9000

# firejail
acp-spawn --agent 'firejail --noprofile --private=. -- pi-acp' --name pi --ui http://localhost:9000
```

The launcher invokes the whole string as a single shell command, so
quotes / globs work as expected.

## Multiple agents per worktree

The launcher's `--name` flag becomes the badge in the Voir UI.
If you want to compare two agents in the same worktree, run two
launchers with different `--name`s and different `--port`s:

```sh
# In a worktree, run pi and another agent side-by-side
acp-spawn --agent pi-acp --name pi --ui http://localhost:9000 --port 8101
acp-spawn --agent 'other-acp' --name other --ui http://localhost:9000 --port 8102
```

Both show up in Voir under the same path with independent
session threads, heartbeats and reconnects. Sessions resolve to
their owning agent by session id, so the chat URLs are
unchanged. Folder-level calls that can't tell the agents apart
(creating a chat from the folder view) pick the most recently
registered agent; the registration API accepts an explicit
`agentName` when you care.

Tear down one agent with `?name=`; a bare `DELETE` refuses to
guess when a path hosts several:

```sh
curl -X DELETE 'http://localhost:9000/api/folders?path=/abs&name=pi'
```

## Resident supervisor

`bin/voir-supervisor` keeps a fleet of agents alive on one
machine. This section is the overview — the full configuration
and behavior reference is [docs/supervisor.md](./supervisor.md).
Two files, two owners:

```jsonc
// ~/.config/voir/supervisor.json  — authored by you, never written
// by the supervisor. The preset commands are where sandboxes
// live; raw commands never cross the API.
{
  "ui": "https://chat.lab",
  "presets": {
    "pi": "pi-acp",
    "pi-fenced": "fence exec --private . -- pi-acp"
  }
}

// ~/.local/state/voir/agents.json — managed by the supervisor:
// desired state only (what SHOULD exist), written atomically on
// every add/remove, watched for hand edits.
[
  { "dir": "/home/me/code/infra", "preset": "pi-fenced", "name": "infra" }
]
```

Run `voir-supervisor` (default subcommand `run`) and it
converges: every desired entry gets a child, a bridge and the
30-second registration loop, so a Voir restart heals on its own.
A crashed child is restarted with backoff (1s doubling to a 30s
cap, reset after a minute of uptime); ten consecutive crashes
mark the entry errored — it stays in the state file until a human
fixes the preset or removes it. Absence is status, never a
command to delete.

Day-to-day:

```sh
voir-supervisor add ~/code/infra --preset pi-fenced   # launch + persist
voir-supervisor ls                                     # fleet status
voir-supervisor rm infra                               # stop + remove
```

`add`/`rm` talk to the running daemon (found via a discovery
file next to the state file); if the daemon is down they edit
the desired state directly and say so. The daemon's loopback API
is also documented surface — `GET /agents`, `GET /presets`,
`POST /agents { dir, preset, name? }`, `DELETE /agents/<name>`
(default :7420, `apiToken` in the config enables bearer auth) —
so a future UI launch flow can be a thin forward, with no new
machinery in Voir.

One-shot agents (`acp-spawn`) are invisible to the supervisor by
design: scratch worktrees, comparisons and CI keep the old
die-with-the-terminal behavior, and both kinds coexist in the
same Voir.

## Programmatic use

If you want to drive registration yourself (e.g. embed Voir in a
custom worktree manager), the endpoints are:

```
POST /api/folders
Content-Type: application/json
{ "path": "/abs", "agentUrl": "http://127.0.0.1:8123/", "agentName": "pi" }
→ 201 { ... "browse": "/f/<path>" }

DELETE /api/folders?path=/abs             → 204 (one agent on the path)
DELETE /api/folders?path=/abs&name=pi    → 204 (picks that agent;
                                            required when several share it)

GET /api/folders
→ { folders: [ ... ] }
```

The `agentUrl` just has to speak ACP JSON-RPC 2.0 over HTTP. See
[ACP Transports](https://agentclientprotocol.com/protocol/transports)
for the protocol details; the launcher implements the simplest
shape:

- `POST <url>`  body = single JSON-RPC message
                 `200` with JSON-RPC response (for requests),
                 `204 No Content` (for notifications)
- `GET <url>`   `Content-Type: text/event-stream`; one JSON-RPC
                 message per `data:` line (server-pushed notifications)
