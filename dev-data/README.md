# dev-data/

Sample worktrees for the Voir dev compose. Each subdirectory
is mounted as `/work` inside one of the `acp-spawn-*`
containers, so the chat's `@`-mention picker surfaces the
files inside that subdirectory as candidates for the
matching agent's session.

The contents are deliberately small and curated — short
markdown notes, a couple of `.ts` files, a `package.json`
or two — so the picker is easy to scan in a screenshot or
demo. Real worktrees would have many more files.

`runtime/` is different: it's generated state for the
`npm run dev:mock` / e2e stacks (bin/dev.mjs points their
`VOIR_DATA_DIR` here so they never touch a real instance's
durable state). It's gitignored; delete it freely.
