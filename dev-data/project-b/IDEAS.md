# Ideas

Loose thoughts about where this experiment could go.

- A `--pretty` flag that maps the summary onto colours (arrays cyan,
  objects amber) so scanning a directory's JSON files is instant.
- Stream the file instead of `readFileSync` once the inputs get big;
  the summariser could then report partial shapes as they arrive.
- Cache summaries keyed by (path, mtime) to make repeated runs free.
- A `--diff a.json b.json` mode that summarises the *shape* change,
  which is usually what you actually want to know.
