# Sandbox / fence integration

Voir ships with a per-folder launcher, `bin/acp-spawn`, that
spawns the agent in a worktree, exposes it as an ACP JSON-RPC 2.0
HTTP endpoint, and registers it with Voir. The launcher is the
official way to attach a worktree to a running Voir.

The launcher itself does **not** sandbox the agent — that's your
responsibility. Wrap the agent in `fence` / `bwrap` / `firejail` /
namespace-tools however you like, then point the launcher at the
wrapped command via `--agent`.

## Basic usage

```sh
cd /home/me/worktrees/feat-42
acp-spawn --agent pi-acp --name pi --ui http://localhost:9000
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

Both folders show up in Voir, both bound to the same path, but
their session threads are independent.

## Programmatic use

If you want to drive registration yourself (e.g. embed Voir in a
custom worktree manager), the endpoints are:

```
POST /api/folders
Content-Type: application/json
{ "path": "/abs", "agentUrl": "http://127.0.0.1:8123/", "agentName": "pi" }
→ 201 { ... "browse": "/f/<path>" }

DELETE /api/folders?path=/abs
→ 204

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
