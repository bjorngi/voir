import type { Route } from "./+types/api.commits";
import { execFile } from "node:child_process";
import { isGitRepo } from "~/lib/diff.server";

/**
 * GET /api/commits?folder=<path>
 *
 * Returns the last 50 commits on the current branch, newest first.
 * Used by the Changes view to render commit history below the
 * uncommitted/snapshot section.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  if (!folder) {
    return Response.json({ error: "Missing folder" }, { status: 400 });
  }
  if (!isGitRepo(folder)) {
    return Response.json({ commits: [] });
  }

  const out = await execGit(folder, [
    "log",
    "-50",
    "--format=%H%x00%an%x00%at%x00%s",
  ]);
  const commits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, at, ...messageParts] = line.split("\0");
      return {
        sha: sha ?? "",
        author: author ?? "",
        date: Number(at ?? "0"),
        message: messageParts.join("\0"),
      };
    });
  return Response.json({ commits });
}

function execGit(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      { timeout: 10_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}
