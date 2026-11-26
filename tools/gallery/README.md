# tools/gallery — a reusable visual-review surface

Copy this directory into any repo that wants the same review loop Voir has:

```
tools/gallery/gallery.ts     # writeGallery(opts) — page + manifest, zero deps
tools/gallery/README.md      # this file
```

It produces a single self-contained `index.html`:

- contact sheet grouped by device, captions with the file name;
- click any shot → lightbox; `←`/`→` walk the whole sequence, `Home`/`End`
  jump, `Esc` closes, swipe works on touch; neighbours preload;
- a `manifest.json` describing the run (stamp, commit, devices, shots).

## Contract

```ts
writeGallery({
  outDir: "site",              // where index.html + manifest.json go
  imgDir: "site/shots",        // where the images are (created if missing)
  imgPrefix: "shots/",         // src/href prefix used in the HTML
  title: "Torin — visual review",
  stamp: "2026-11-27_09-12-00",
  commit: { sha: "abc1234", subject: "feat: …" },   // optional provenance
  devices: [{ id: "phone", label: "Phone", note: "390 × 844 CSS · 19.5:9" }],
  shots: [
    { file: "phone-home.webp", label: "Home", group: "home", device: "phone" },
  ],
});
```

- `device` must be one of the `devices[].id` values — sections are built in
  that order, shots keep their order inside a section.
- `group` becomes a CSS class on the `<figure>`. The stylesheet ships with
  sensible sizing for `chat`, `rich`, `tabs` (cropped to 620px) and everything
  else (full height).
- Images may be PNG or WebP. For published runs use WebP at quality 90: UI
  screenshots keep their fidelity at a fraction of the bytes, which matters
  when the gallery is committed on every commit.

## Serving and publishing

- Local: any static server over the directory, e.g.
  `python3 -m http.server -d site 9310`.
- Tailed/remote: bind the tailnet interface only (see Voir's
  `bin/shots-serve.mjs` for a 40-line version that also picks the newest run).
- GitHub Pages: commit `site/`, then add

  ```yaml
  # .github/workflows/pages.yml
  on: { push: { branches: [main], paths: ["site/**"] }, workflow_dispatch: {} }
  permissions: { contents: read, pages: write, id-token: write }
  jobs:
    deploy:
      runs-on: ubuntu-latest
      environment: { name: github-pages, url: "${{ steps.d.outputs.page_url }}" }
      steps:
        - uses: actions/checkout@v4
        - uses: actions/configure-pages@v5
        - uses: actions/upload-pages-artifact@v3
          with: { path: site }
        - id: d
          uses: actions/deploy-pages@v4
  ```

  and enable Pages once with `build_type: workflow`:
  `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`.

## Why commit the images

The gallery is the "what did it look like at this commit" record. Stable file
names (no timestamps in the file, only in the header) keep the diff small and
make before/after a `git diff` of two `.webp` files. If a repo grows tired of
the bytes, publish to a `gh-pages` branch instead — the page itself does not
care where it is served from.
