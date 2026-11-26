---
name: voir-design
description: Voir's look-and-feel and layout rules — the five target displays, the one-bar chrome, density/space budget on phone panes, coarse-vs-fine pointer rules, safe-area insets, the dark token set — plus how to reuse the screenshot gallery (tools/gallery) and the e2e/violation checks for another app's own visual review. Load when designing or refactoring UI in Voir, when reviewing a redesign across devices, or when giving a new app the same look and feel.
---

# Voir look & feel — rules, budget, and the review loop

This is the design system Voir settled on, written down so a new app (torin,
anything on the estate) can start from it, and so a refactor has a standard to
be measured against. It is deliberately opinionated; the numbers come from
measuring real panes, not from taste.

## 1. The five displays are the spec

Layout is designed against these, not against "mobile and desktop"
(`test/displays.ts` is the single source of truth):

| id | CSS viewport | panel | shape |
|---|---|---|---|
| `fold-cover-portrait` | 416 × 657 | 1248 × 1972 | 10:16 phone |
| `fold-cover-landscape` | 657 × 416 | 1972 × 1248 | phone, sideways |
| `fold-inner-portrait` | 609 × 816 | 1828 × 2448 | 3:4 tablet-ish |
| `fold-inner-landscape` | 816 × 609 | 2448 × 1828 | 4:3 slab |
| `laptop` | 1728 × 1117 | 3456 × 2234 | 16:10 |

A change that only looks right at one of these is not done. Two rules follow:

- **Design for the short axis.** 416px of height is the harshest constraint.
  Anything that costs vertical space must justify itself in pixels.
- **Never assume one aspect.** The same view is tall-narrow and wide-short
  within one device, seconds apart.

## 2. The space budget (measured)

Cover portrait, chat view, before → after the density pass:

```
bar 48 → 40      composer 133 → 61      drawer row 28 → 0
transcript 448px (68%) → 548px (83%)
```

Targets to hold new work to:

- **Chrome ≤ 88px total** at the top (one bar, 40px on touch). There is no
  second row: view switching lives *inside* the bar.
- **Composer ≤ 64px** resting (one row: field + 2–3 controls). It grows with
  content, never with the placeholder.
- **Transcript ≥ 80%** of viewport height in a conversation.

## 3. One bar, and what may live in it

```
[☰]  ● context · folder        [Chat|Files|Changes +n −m]   ⌃  ⋯
```

- **Left:** navigation (☰ opens the picker sheet — folders, sessions, search)
  and the context label. The label is the way home; the PWA has no back button.
- **Middle:** the view switcher as a segmented control. Labels from 480px,
  icons below. Keep the accessible names regardless (`aria-label`).
- **Right:** secondary actions (working-on star, voice, push, reload, hide bar).
  Inline from 768px; in the ⋯ menu below. **Same labels in both places.**
- The bar hides itself when the on-screen keyboard opens, and can be collapsed
  by hand; the restore handle pinned to the top-right corner carries the busy
  dot, because a hidden bar must not hide a running turn.

## 4. Pointer, not "mobile"

Media queries key on **capability**, never on width alone:

- `(pointer: coarse)` → 40px bar, "hold Send to dictate" hint, blur the
  composer after sending (the keyboard must close), larger tap targets.
- `(hover: hover)`/fine → "⌘+Enter to send", keep focus after sending.
- `(max-height: 560px)` → the landscape panes; further compaction.
- Viewport width → reading measure (768 → 896 → 1024px) and tab labels.

**Never gate a control on a capability.** Voice and push are unavailable over
plain HTTP (no secure context). They still render, dimmed, with the reason
("Needs HTTPS — open the app via `tailscale serve`"). A control that silently
disappears reads as a bug.

## 5. Tokens

- Surface `#0a0a0b` / `#0b0d10`; panels `neutral-950`; borders `neutral-800`.
- Text: primary `neutral-100/200`, secondary `neutral-400`, meta `neutral-600`.
- Accent: amber = working/attention, sky = connecting, emerald = additions,
  rose = deletions. Blue only for selected/active rows.
- Mono for data (`ui-monospace`): paths, ids, diffs, counts. Sans for prose.
- Radius ≤ 6px; 1px borders are the whole visual language — no shadows except
  over content (lightbox, popover, floating handle).

## 6. Interaction defaults

- **Every action has a visible affordance at every width.** A keyboard
  shortcut may be a convenience; it must never be the only path. (Send was
  `sm:hidden` and three of five displays had no way to send.)
- **Optimistic, then reconcile.** Star, archive, and message send update the
  list immediately; the server is the truth on the next snapshot.
- **Status is one dot, one meaning.** Busy outranks connection state; idle and
  live are deliberately quiet. No banners over text.
- **Navigation aids scale with the transcript.** The message rail is the
  scrollbar for long conversations: a textless minimap, one colour-coded mark
  per *message*, viewport band, tap to jump, drag to scrub. Role colour, not
  content: sky = you, grey = agent, dim = thinking, violet = plans. **Tool
  calls are filtered out** — they dominate a long agent session and turn the
  map into a solid column where the messages you want are slivers.
  Align it to the reading measure, never the window edge; hide it under ~1.2
  screens of transcript. At rest it is a 3px slit inside a 24px hit strip
  (a 3px target is unhittable); hovering or pressing slides it out to ~14px.
  That pattern — thin visual, fat hit area, expands under the finger — is the
  one to reuse for any precision control on a phone.
- **Deep-linkable state lives in the URL** (`?view=changes`, `?focus=<msg id>`);
  ephemeral UI state (drawer, show-archived) stays in components.
- **Transient layers never reserve space and never swallow taps**
  (`pointer-events-none` on overlays that are informational).

## 7. Safe areas (installed PWA)

`viewport-fit=cover` + `display_override: ["fullscreen","standalone"]` means
the app owns every inset: body pads top/left/right, the composer pads bottom
(and keeps a floor of `0.5rem`). All insets are 0 in a browser tab.

## 8. The review loop (reuse this in other apps)

The loop that makes all of the above checkable:

1. `npm run dev:mock` — a deterministic stack with seeded data
   (Voir: two mock ACP agents, a 18-file fixture diff, isolated runtime state).
2. `npm run test:e2e` — one walkthrough per display. The assertions are
   **affordance-shaped**: roles, labels and `data-testid`s from the render
   modules, never layout classes. Every view also asserts *no horizontal
   overflow*; that single check catches most aspect-ratio breakage.
3. `npm run shots` — capture 12 views × 5 displays into a local gallery.
4. `npm run shots:publish` — write `site/` (stable names, WebP q90) and commit
   it; `.github/workflows/pages.yml` deploys it, so every commit keeps a
   browsable "what it looked like" record. `npm run shots:serve` serves the
   newest gallery loopback + tailnet for phone review.

### Reusing the gallery in another app

The page is app-agnostic: `tools/gallery/gallery.ts` exports `writeGallery()`.
It takes a flat list of shots and a device list — it knows nothing about Voir.

```
tools/gallery/gallery.ts          # copy into the other repo (no deps)
tools/gallery/README.md           # the contract
```

Minimal capture script for a new app:

```ts
import { writeGallery } from "../tools/gallery/gallery";
const shots = [];
for (const d of DEVICES) {                 // your own display list
  const ctx = await browser.newContext({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dpr, hasTouch: d.touch, isMobile: d.touch,
  });
  const page = await ctx.newPage();
  for (const view of VIEWS) {             // your own route list
    await page.goto(`${base}${view.path}`);
    await page.waitForLoadState("networkidle");
    const file = `${d.id}-${view.name}.webp`;
    await page.screenshot({ path: `${imgDir}/${file}`, type: "webp", quality: 90 });
    shots.push({ file, label: view.label, group: view.group, device: d.id });
  }
  await ctx.close();
}
writeGallery({ outDir: "site", imgDir: "site/shots", imgPrefix: "shots/",
  title: "Torin — visual review", stamp, devices, shots });
```

Then add the same `.github/workflows/pages.yml` (upload `site/`, deploy-pages)
and enable Pages with `build_type: workflow`.

## 9. Checklist before calling a UI change done

- [ ] Five displays captured; the short axis looked at first.
- [ ] No horizontal overflow anywhere (e2e asserts it).
- [ ] Chrome ≤ 88px, composer ≤ 64px resting, transcript ≥ 80% in chat.
- [ ] Every action reachable at every width; nothing disappears silently.
- [ ] Coarse-pointer rules applied (hints, blur-after-send, tap targets).
- [ ] Insets respected; nothing under the notch or the keyboard.
- [ ] Gallery regenerated and published in the same commit as the change.
