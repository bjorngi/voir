# Images & the share target

**Status:** implemented (upload store, composer attach,
wire markers with replay re-attachment, share-target staging +
ShareSheet — see the anchors below). Verified by
`test/composer-payload.test.ts`, `test/uploads.test.ts`,
`test/share.test.ts` and `test/images-e2e.test.ts` (real
acp-spawn bridge with the mock agent, which now advertises
`promptCapabilities.image: true` and counts the image blocks
it receives).

**Scope:** sending images to ACP agents from the phone
(paperclip / paste / drop) and from the whole OS (Android
share target → pick a chat), with thumbnails that survive
voir restarts and agent resyncs.

```
paperclip / paste / drop ──POST──▶ /api/uploads ──▶ $VOIR_DATA_DIR/uploads/
                                                                      │
OS share sheet ──POST /share──▶ sw.js ──POST──▶ /api/share ──▶ $VOIR_DATA_DIR/shares.json
                                     │                              (files → the upload store)
                                     ▼
                        303 /?shared=<id> ──▶ ShareSheet ──pick──▶ chat ?shared=<id>
                                                                      │
                                                  Composer seeds text + image chips
                                                                      │
                                                  send ──▶ chat action ──▶ session/prompt
                                                            [text, image(base64),
                                                             "[Image: <id>]", …]
```

## The wire contract (agent-agnostic)

`session/prompt` carries image content blocks — the ACP
stable method; pi-acp advertises `promptCapabilities.image:
true` and translates them into pi's own image support.
Voir gates every affordance on that advertisement
(`FolderState.promptCapabilities`, captured from the
initialize handshake in `registerFolder`, projected as
`FolderSummary.image`): the paperclip, paste, drop, and the
ShareSheet's image seeding all vanish for agents that never
advertised it, and the chat action rejects image payloads to
them (`chat.tsx` → "This agent doesn't accept images").

Content blocks per attachment, in order:

```json
{ "type": "image", "mimeType": "image/jpeg", "data": "<base64>" },
{ "type": "text",  "text": "[Image: <12-hex-id>]" }
```

The marker is the replay-survival trick. ACP's replay
direction (`session/load`) only returns the **text** of user
messages — pi-acp normalizes content and drops image parts
(verified in its dist: `normalizePiMessageText`). Without
voir-side persistence the thumbnails would vanish from the
transcript after every voir restart or agent resync. So:

- every image lives in voir's own store
  (`$VOIR_DATA_DIR/uploads/<id>.<ext>` + `index.json`,
  `app/lib/uploads.server.ts` — the same durable-state-on-the-
  filesystem convention as push subscriptions),
- its marker rides the prompt text, which *does* survive
  replay,
- the replay handler (`user_message_chunk` in
  `sessions.server.ts`) parses the markers and re-attaches
  the `images` array to the message; resolved markers drop
  from the display text (thumbnails speak for themselves),
  unknown ids keep their raw line (store wiped → honest
  degradation, not a silent gap).

The same projection (`rewriteImageMarkers` in
`app/lib/composer-payload.ts`) runs on the live send path
(`sendMessage`) and on replay, so both transcripts render
identically. The marker regex is deliberately not
line-anchored: pi-acp concatenates a turn's text blocks with
no separator, so on replay the marker comes back glued to
the user's text ("what is this[Image: abc…]"). Live sends
see it on its own line; both must parse.

The model reads the marker as an honest label ("an image
accompanies this message, handle `<id>`"); hosts that don't
know the convention degrade to showing the text.

## Client-side shrinking

`app/lib/image-attach.ts`: browser-side canvas downscale
(longest edge ≤ 2048px, JPEG 0.85) before upload, because an
image content block is base64 inside the JSON-RPC prompt
frame and phone photos are 4–12MB. Files ≤ 512KB and SVGs
pass through; undecodable formats (HEIC on Android Chrome)
pass through and the server caps apply instead
(`MAX_UPLOAD_BYTES`, env `VOIR_IMAGE_MAX_BYTES`, default
15MB; the share target accepts the same cap since the OS
hands over original bytes).

## The routes

```
POST /api/uploads            multipart, field `file` → 201 {id, name, mimeType, size}
                            (Origin-guarded like /api/notify/*; 400 non-image, 413 too large)
GET  /api/uploads/:id        the bytes (immutable cache — ids are random, never rewritten)
POST /api/share              multipart: title?, text?, `images` file fields
                            → 201 {id, title, text, images: ImageRef[]}
GET  /api/share/:id          the staged manifest (the ShareSheet's preview fetch)
```

The uploads store is the single durable home for prompt
images — the composer's send resolves ids to base64 content
blocks at `session/prompt` time (`chat.tsx` action), nothing
is re-uploaded from the landing page.

Validation, per file: `image/*` only, ≤ `MAX_UPLOAD_BYTES`
(env `VOIR_IMAGE_MAX_BYTES`, default 15MB), and **SVG
rejected** — an SVG is an XML document with script rights,
`/api/uploads/:id` is same-origin, and serving user SVG there
would be stored XSS (the error tells the user to @-mention
the file instead — agents read SVG as text anyway). The GET
adds `Content-Security-Policy: sandbox` +
`X-Content-Type-Options: nosniff` so even a future
active-content slip-through can't script a direct tab;
neither header affects `<img>` embedding. The share route
pre-checks sizes before staging and caps the title/text
fields (128KB — an article share must not blow the composer's
sessionStorage draft quota).

## Share target flow

1. **Manifest** (`public/manifest.webmanifest`):
   `share_target` POSTs multipart to `/share`, with the file
   field named `images` (`accept: ["image/*"]`).
2. **Service worker** (`public/sw.js`): intercepts the POST
   *before* the navigate handler (the OS share arrives as a
   navigate-mode POST; the old handler would have fetched
   `/share` from the server and 404'd). It forwards the
   FormData to `POST /api/share`, then
   `Response.redirect("/?shared=<id>", 303)`. Server
   unreachable → a plain-text 502 page. `respondWith` is
   called synchronously (Chrome requires it); the async work
   happens inside.
3. **Staging** (`app/lib/share.server.ts`): files go through
   the normal upload store; the manifest
   (`$VOIR_DATA_DIR/shares.json`) references them by id.
   Non-image fields and fields past the count cap
   (`MAX_SHARE_IMAGES`, 8) are skipped, not fatal — a shared
   text with a broken 9th image still arrives.
4. **ShareSheet** (`app/components/ShareSheet.tsx`): rendered
   by ChatApp whenever `?shared=<id>` is in the URL — preview
   (text + thumbnails, fetched from `GET /api/share/:id`),
   then the target list: Working-on rows, each folder's three
   most recent sessions, and "+ New chat" per folder (a form
   POST `intent=new` + the shared id; the chat action's
   redirect carries `?shared=` along — `chat.tsx`). Folders
   whose agent never advertised images show a "text only"
   pill when the share carries them; picking them still
   works, the Composer just seeds text (the chips are skipped
   rather than failing at send time).
5. **Chat seeding**: the chat *loader* resolves the manifest
   server-side (`chat.tsx` — no client fetch flash) and the
   Composer seeds once on mount (`initialShared`), then
   strips the param from the URL — the same consume-once
   pattern as `?attach=`. Uploaded images seed as chips
   (preview from `/api/uploads/<id>`) and send as normal
   payload `images: [{id, name}]`.

iOS Safari doesn't implement `share_target`; Android Chrome
does (PWA installed). The paperclip covers iOS.

## Vision awareness (per-model)

*Added 2026-11-04, after the kimi-k3 debug.*

Agent-level `promptCapabilities.image` (above) says the
*runtime* can carry images — not that the *active model* can
see them. pi checks the model's `input` modalities
(`~/.pi/agent/models.json`, pi-ai `Model.input`) at stream
time: on a text-only model it replaces image blocks with the
literal context placeholder
`(image omitted: model does not support images)` — the model
then answers "the image was omitted", exactly what we saw for
`glm-5.3:cloud` (text-only — correctly catalogued) and
initially for `kimi-k3:cloud`:

- **kimi-k3:cloud, kimi-k2.6:cloud, gemma4:31b-cloud** are
  native multimodal upstream (ollama.com/library tags "Text,
  Image") but the catalog entries said `["text"]` — fixed in
  place (`input: ["text","image"]`). Catalog truth is the
  gate; keep it honest after adding models.
- The **pi-acp voir patch** (installed dist `0.0.27`,
  `~/.npm-global/lib/node_modules/pi-acp/dist/index.js` —
  backup at `index.js.voir-orig`): `getModelState()` now
  carries each model's `input` list through the ACP
  `_meta` extension point as `_meta.piAcp.input`. Verified
  live: 51 models advertised, 25 vision-capable (all
  `google/*` via models-store). **Re-apply after any pi-acp
  update** — the patch lives in dist, not a source repo.
- **voir's tri-state UI:** `modelVision()` in
  `chat-types.ts` (true/false/undefined = unknown). The
  ModelDrawer marks vision-capable models in the picker
  (`· vision` suffix) and shows an Images line for the
  current model (✓ / ✗ with the count of qualifying
  models); the Composer warns above the attach chips when
  images ride under a text-only model. `undefined` (agents
  without the patch — e.g. stock non-pi agents) renders
  nothing rather than guessing.
- **litellm provider entries weren't touched** — the
  `llm.devbox` proxy's backend mapping decides what
  `litellm/kimi-k3:cloud` really fronts; flip its `input`
  when that's confirmed.
- Sending to a text-only model stays allowed (thumbnail
  still matters to the human; models switch mid-chat). And
  the placeholder is applied per-request — pi persists the
  real image block in the session file, so fixing the
  catalog + restarting the agent also makes *previously
  attached* images visible on the next turn, no re-send
  needed.

## Interaction with the rest

- **Drafts**: the per-session sessionStorage draft
  (`Composer.tsx`) now carries uploaded images too; in-flight
  or failed uploads don't persist.
- **Busy sessions**: image sends queue like text sends
  (pi-acp's turn queue); the chips stay visible until sent.
- **Voice mode / question cards / push inline reply** send
  text-only payloads — unchanged.
- **Timeline snapshots** (`captureTimeline`) record the
  prompt's wire text, markers included — honest.
- **Retention**: none, by the same stance as session files.
  A replay of a year-old conversation must still find its
  thumbnails; a downscaled image is a few hundred KB. If disk
  growth ever matters, prune by last-reference instead.
- **Security**: uploads are same-origin app data like the
  transcript itself; `/api/uploads` is Origin-guarded, bytes
  are served with a private immutable cache and no auth (the
  front-door auth story is the app's, see README). SVG never
  enters the store (see Validation). Push payloads never
  contain image bytes (≤4KB by protocol).

## Dev verification

`npm run dev` + the mock agent (`bin/mock-acp.mjs` — it
advertises `image: true` and echoes `(+N images)` in its
thought):

1. Paperclip/camera in a mock chat → chip appears → send →
   the mock's thought says `(+1 image)`, the user message
   shows the thumbnail.
2. Drawer → Clear cache (a resync) → the thumbnail survives
   the replay (`test/images-e2e.test.ts` asserts this).
3. Share target: needs HTTPS + installed PWA
   (`tailscale serve`), then share a screenshot from the
   gallery → ShareSheet lands → pick a chat → the composer
   seeds it. On desktop, `curl -F` the multipart shape at
   `/api/share` and open `/?shared=<id>` directly.