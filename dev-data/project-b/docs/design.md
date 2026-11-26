# Design

The CLI takes a path to a JSON file and prints either a
human-readable summary or a machine-readable form.

```
cli summary path/to/data.json
cli summary --format json path/to/data.json
```

For now `cli` is just a single function in `src/parse.ts`.
The user calls it via `node --import tsx src/cli.ts …`.
