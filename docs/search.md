# Cross-session search (docs/search.md)

**Status:** implemented (v1 — see "Not in v1" for the honest gaps).
**Scope:** find any past conversation across all folders/agents,
from the picker (the hamburger menu), and jump straight to the
matched message. Message-content search for sessions voir has
transcripts of; title search for everything else.

## The surface

- The picker (menu panel) grew a search box. Empty query → the
  "Working on" shortlist as before; typing → debounced
  `GET /api/search?q=<terms>` (250 ms), results grouped by
  session: title + folder chip, up to 3 message snippets with
  the matched terms emphasized, newest session first.
- A tap opens the chat and deep-links the first hit:
  `/f/<folder>/s/<id>?focus=<message id>`. ChatView scrolls the
  message into view once and flashes it (`.msg-flash`, app.css).
  A focus id the transcript no longer has (compaction, trimmed
  agent truth) degrades to a plain chat open — no crash, nothing
  to clean up.

## What is searched, per session — freshest source wins

1. **In-memory transcript** — sessions loaded or active this
   server run (`SessionState.messages`, non-stub). Authoritative:
   a held session never reads its index file, even when the
   in-memory transcript is empty (replayed-empty beats a stale
   index; memory is truth, the index is a cache).
2. **The persisted search index** — one JSON file per session:
   `$VOIR_DATA_DIR/search-index/<agentHash>/<sessionId>.json`
   (agentHash = sha1 of path+agentName — several agents can share
   one path with separate session stores). Written **debounced
   (3s)** on every live message (`broadcast` in
   sessions.server.ts) and **immediately** after each
   session/load replay (`loadSession`) — so a transcript enters
   the index the first time it is opened, and stays findable
   across voir restarts. Atomic writes (tmp + rename); the files
   are a search-only artifact — never rendered as chat, agent
   truth (`session/load`) always owns what the chat surface
   shows.
3. **The session title** — every session the agent lists,
   including ones never opened since search shipped (pi titles
   sessions from the first prompt, so title search has real
   recall). Title-only matches render without snippets.

## Semantics

- Whitespace-separated terms, **all must appear in one message**
  (or in the title) — the find-in-page contract, not a bag of
  words across a session. Case-insensitive substring.
- Snippets: ≤48 chars before, ≤140 after the first match,
  `…`-elided, all term occurrences inside the window marked.
- Caps: 40 sessions, 3 hits per session. Sorted newest first
  (max of session activity and hit timestamps).
- Multi-agent paths: searched once per path (`listSessions`
  merges agents), index reads resolved to the *owning* agent
  (`agentOfSession`); session ids are UUIDs, so one `seen` set
  dedupes across agents.

## The honest cold-start bound

Sessions **never opened since the index shipped** are searchable
by title only — message content lives in the agents' session
stores (pi session files), and the only transcript access ACP
offers is `session/load` (a full replay). Coverage compounds:
every session opened or active after this feature ships is
content-searchable forever.

## Not in v1 (deliberate)

- **Backfill** — a background loop that loads-and-indexes every
  stub session (bounded rate, per-agent) would close the cold
  start; deferred because replays are expensive (seconds per
  session × hundreds) and nothing presses yet.
- **Agent-side search** — an ACP/pi-acp extension RPC
  (`pi/searchSessions`?) would search the store directly with no
  replays and no index; the protocol has no such method, and
  extending it is a separate decision.
- Tool titles, thought text, plan entries as match targets
  (the index schema is versioned for adding them).
- Pagination / offset — 40 sessions covers today's estate.
