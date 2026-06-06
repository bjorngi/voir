# Voir

A web UI for [ACP](https://agentclientprotocol.com)-compatible
coding agents. One Voir process, many worktrees, each with its
own agent. Mobile-first, single screen — the chat.

Voir is the shell, not the agent. It doesn't spawn, sandbox, or
kill agents — it talks JSON-RPC 2.0 to one or more ACP endpoints
that you (or your worktree manager, IDE plugin, sandbox wrapper)
control. The reference launcher in `bin/acp-spawn.mjs` shows how
thin that boundary can be.

## Get started

You need two things: a running Voir server, and an `acp-spawn`
launcher running inside each worktree you want to chat with.

### 1. Start Voir

```sh
git clone <this-repo> voir
cd voir
npm install
npm run dev          # http://localhost:9000
```

Open `http://localhost:9000` in your browser. You'll see an
empty **Folders** list — that's expected; no worktrees are
attached yet.

For a production-style run:

```sh
npm run build
npm start            # http://localhost:9000
```

A [Dockerfile](./Dockerfile) and [docker-compose.yml](./docker-compose.yml)
are included for the server. The launcher is a plain Node
script — run it on the host, in the worktree, not in a
container.

### 2. Start a launcher in a worktree

In another terminal, `cd` into the worktree you want to chat
with and run the launcher:

```sh
cd ~/worktrees/feat-42
/path/to/voir/bin/acp-spawn.mjs \
  --agent pi-acp --name pi --ui http://localhost:9000
```

The launcher spawns `pi-acp` in the current directory, exposes
it on a local HTTP port, and registers the folder with Voir.
You'll see something like:

```
pi-acp bridge for /home/you/worktrees/feat-42 on http://127.0.0.1:43127/
registered with Voir → browse: http://localhost:9000/f/home/you/worktrees/feat-42
```

Open the `browse` URL (or just refresh `http://localhost:9000`)
and the folder appears in the list.

### 3. Chat

Tap **+ New chat** to start a conversation, or pick a previous
session. Type, hit send, watch the agent stream its reply.

A few things to know:

- The **+N −M** pill on each folder row is a one-tap jump to
  that worktree's diff.
- The **Diff** tab in the chat (and on the session list) shows
  the full per-file diff between the auto-detected base branch
  and your worktree, including uncommitted changes.
- The composer supports `/` slash commands if the agent
  advertises them — type `/` to see the list.
- The composer also accepts `@` file mentions; selecting one
  attaches the file as a resource to your next message.
- The chevron above the composer opens the model/mode drawer
  for switching the active session's model and thinking level.

### 4. Tear down

`Ctrl-C` the launcher. The folder disappears from Voir, the
`pi-acp` subprocess is killed, the bridge port is freed.

If you kill the launcher abruptly (e.g. `kill -9`), Voir's
10-second heartbeat will notice the endpoint is gone and drop
the folder on its own.

### 5. Run more worktrees

Just `cd` to another worktree and start another launcher. Each
one gets its own port, its own `pi-acp`, and its own slot in
Voir's folder list. They don't interfere with each other.

## Run the launcher from anywhere

The launcher is a single self-contained Node script. You can:

- Run it directly: `/path/to/voir/bin/acp-spawn.mjs`
- Symlink it: `ln -s /path/to/voir/bin/acp-spawn.mjs ~/.local/bin/acp-spawn`
- Install Voir globally: `npm install -g .` from this
  directory, then `acp-spawn --agent pi-acp --name pi --ui http://localhost:9000`
  from anywhere.
- Wrap it in your own launcher (IDE plugin, worktree manager,
  …) that does `cd <worktree> && exec acp-spawn --agent … --name … --ui …`.

### Flags

`--agent`, `--name`, and `--ui` are required. The launcher
doesn't default any of them — pick whichever agent, label, and
UI URL fits your setup.

```sh
acp-spawn --agent <cmd>     # required
acp-spawn --name  <name>    # required
acp-spawn --ui    <url>     # required
acp-spawn --port  <n>       # default: pick a free port
acp-spawn --no-register     # bridge only, don't call /api/folders
```

The required flags also have env-var equivalents
(`AGENT`, `NAME`, `UI`, `PORT`).

### Wrap in a sandbox

`--agent` takes any shell command, so wrap your real agent in
`fence` / `bwrap` / `firejail`:

```sh
acp-spawn --agent 'fence exec --private . -- pi-acp'     --name pi --ui http://localhost:9000
acp-spawn --agent 'bwrap --unshare-all --bind . . --tmpfs /tmp --dev --proc -- pi-acp' \
  --name pi --ui http://localhost:9000
acp-spawn --agent 'firejail --noprofile --private=. -- pi-acp' --name pi --ui http://localhost:9000
```

### Try a different agent

`pi-acp` is one implementation; any ACP-compatible agent
works:

```sh
acp-spawn --agent 'other-acp-agent' --name other --ui http://localhost:9000
```

Voir itself doesn't care which agent is behind the endpoint —
it just speaks ACP JSON-RPC 2.0.

## Manual control (no launcher)

If you want to drive registration yourself, the API is:

```sh
# Register a folder
curl -X POST http://localhost:9000/api/folders \
  -H "Content-Type: application/json" \
  -d '{
    "path":      "/home/you/worktrees/feat-42",
    "agentUrl":  "http://127.0.0.1:8123/",
    "agentName": "pi"
  }'
# → 201 { "path": "...", "browse": "/f/home/you/worktrees/feat-42" }

# Inspect registered folders
curl http://localhost:9000/api/folders

# Tear down
curl -X DELETE 'http://localhost:9000/api/folders?path=/home/you/worktrees/feat-42'
```

The `agentUrl` just has to speak ACP JSON-RPC 2.0 over HTTP.
See [`docs/sandbox.md`](./docs/sandbox.md) for the wire
contract.

## Architecture

```
┌─────────────────────────── Browser ───────────────────────────┐
│  /                       list of folders                      │
│  /f/<path>               sessions in a folder                  │
│  /f/<path>?view=diff     full worktree diff                    │
│  /f/<path>/s/<id>        chat                                  │
│  /f/<path>/s/<id>?view=diff diff for the chat's folder         │
│  /api/sessions/:id/stream   SSE: live chat updates             │
│  /api/folder-files          file index for @-mentions          │
│  /api/folder-diff           full diff payload                  │
│  /api/sessions/:id/action   set_model / set_mode / cancel      │
│  /api/sessions/:id/meta     ad-hoc session info lookup         │
│  /api/folders               script-only folder registry        │
└────────────────┬─────────────────────────────────────────────┘
                 │
┌────────────────▼─────────────────── Node ─────────────────────┐
│  SessionManager (in-memory, per-process)                    │
│   ├─ Folder "A"  ── AcpClient ──►  http://127.0.0.1:8123/    │
│   │   └─ sessionId_1                                        │
│   └─ Folder "B"  ── AcpClient ──►  http://127.0.0.1:8124/    │
│       └─ sessionId_2                                         │
└──────────────────────────────────────────────────────────────┘
                 ▲                       ▲
                 │ POST/DELETE            │ ACP JSON-RPC 2.0
                 │ /api/folders           │ over HTTP
        ┌────────┴────────┐               │
        │  acp-spawn      │ ──────────────┘
        │  (per worktree) │
        └─────────────────┘
```

- A **folder** is one ACP agent connection.
- A **session** is one conversation thread inside a folder.
- The launcher owns the agent process and its lifecycle; Voir
  just talks to the HTTP endpoint.

## Layout

```
app/
├─ root.tsx                          # html shell, error boundary
├─ routes.ts                         # route table
├─ app.css                           # tailwind + small CSS
├─ lib/
│  ├─ acp-client.server.ts           # transport-agnostic ACP client
│  ├─ brand.ts                       # product name (single source of truth)
│  ├─ chat-types.ts                  # shared message/folder types
│  ├─ diff.server.ts                 # git diff: parse + summarise
│  ├─ files.server.ts                # server-side file index for @-mentions
│  ├─ format.ts                      # small formatting helpers
│  ├─ hooks.ts                       # useAutoScroll, usePageVisible
│  ├─ inline-diff.ts                 # LCS diff for tool-call previews
│  ├─ route-parse.ts                 # /f/<path> URL → ChatRoute union
│  ├─ sessions.server.ts             # folder/session manager
│  └─ urls.ts                        # folderUrl / sessionUrl / streamUrl
├─ routes/
│  ├─ index.tsx                      # re-exports chat for the / route
│  ├─ chat.tsx                       # /, /f/<path>, /f/<path>/s/<id>
│  ├─ api.stream.tsx                 # SSE chat stream
│  ├─ api.folders.tsx                # script-only folder registry
│  ├─ api.folder-files.tsx           # file index for @-mentions
│  ├─ api.folder-diff.tsx            # full worktree diff
│  ├─ api.session-action.tsx         # set_model / set_mode / cancel
│  └─ api.session-meta.tsx           # ad-hoc session info lookup
└─ components/
   ├─ Composer.tsx                   # message composer + /-@ popovers
   ├─ DebugPopover.tsx               # "···" popover (shared)
   ├─ DiffView.tsx                   # full worktree diff renderer
   ├─ FolderTree.tsx                 # folder/session tree on /
   ├─ Message.tsx                    # one chat message
   ├─ ModelDrawer.tsx                # model/mode drawer
   ├─ Picker.tsx                     # overlay folder/session picker
   ├─ SessionDebugButton.tsx         # per-session "···" popover
   └─ chat/
      ├─ ChatApp.tsx                 # the route component (orchestrator)
      ├─ ChatTabs.tsx                # Chat/Diff tab bar
      ├─ ChatView.tsx                # messages, drawer, composer
      └─ Header.tsx                  # page header (label + menu)

bin/
└─ acp-spawn.mjs                     # per-worktree launcher

test/
├─ acp-client.test.ts                # in-band vs SSE response race
├─ diff.test.ts                      # parseNameStatus, parseUnifiedDiff
├─ format.test.ts                    # shortPath
├─ inline-diff.test.ts               # LCS-based line diff
├─ route-parse.test.ts               # /f/<path> URL parser
└─ urls.test.ts                      # folderUrl / sessionUrl / streamUrl

docs/
└─ sandbox.md                        # wire contract for ACP agents
```

## Commands

| Command           | What it does                                  |
| ----------------- | --------------------------------------------- |
| `npm run dev`     | Vite dev server with HMR on port 9000         |
| `npm run build`   | Production build of the SSR bundle            |
| `npm start`       | Serve the built bundle (defaults to port 9000)|
| `npm test`        | Run unit tests (Node's built-in test runner)  |
| `npm run typecheck` | Generate route types and run `tsc`          |

## Stack

- [React Router v7](https://reactrouter.com) framework mode
  (SSR)
- Vite + Tailwind v4
- Server-sent events for streaming agent output
- ACP JSON-RPC 2.0 over HTTP to talk to agents
- Node 22 with the built-in test runner

## License

MIT.
