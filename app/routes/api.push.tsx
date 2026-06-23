import type { Route } from "./+types/api.push";
import { execFile } from "node:child_process";
import { isGitRepo } from "~/lib/diff.server";

/**
 * POST /api/push
 *
 * Body: { folder: string }
 *
 * Runs `git push` in the worktree. Returns { ok: true } on success
 * or { ok: false, error: string } on failure.
 */
export async function action({ request }: Route.ActionArgs) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const folder = (body as { folder?: unknown }).folder;
  if (typeof folder !== "string") {
    return Response.json({ ok: false, error: "Missing folder" }, { status: 400 });
  }
  if (!isGitRepo(folder)) {
    return Response.json(
      { ok: false, error: "Not a git repository" },
      { status: 400 },
    );
  }

  try {
    await execGit(folder, ["push"]);
    return Response.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

function execGit(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(
        "git",
        ["-C", folder, ...args],
        { timeout: 30_000, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          resolve(stdout ?? "");
        },
      );
    });
  });
}
