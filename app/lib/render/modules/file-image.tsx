/**
 * file-image (docs/rich-content.md, inline module): a backticked
 * image path in agent text (`covid-dashboard-2020-06-09.png`,
 * `figs/loss.png`, or explicit `file:figs/loss.png`) → a worktree
 * thumbnail, served by the existing /api/folder-file raw=1 route
 * (the Files tab's image preview plumbing — traversal-checked,
 * read-only). Plain markdown link on tap: full size, new tab.
 *
 * This is the last mile for agents that build artifacts as files
 * (matplotlib dashboards, generated diagrams, plots) and mention
 * them in prose: voir shows the thing, not the mention.
 *
 * Degradation: a 404 (file moved/deleted) or non-image falls back
 * to the plain inline-code span — the reference stays readable,
 * nothing breaks the prose.
 */
import { useEffect, useState } from "react";
import { useRichChat } from "../rich-context";

export default function FileImage({
  ref_,
  token,
}: {
  ref_: string;
  token: string;
}) {
  const chat = useRichChat();
  const [failed, setFailed] = useState(false);
  const src = buildSrc(chat?.folder, ref_);

  useEffect(() => {
    setFailed(false);
  }, [ref_, chat?.folder]);

  if (!chat || !src) return <InlineFallback token={token} />;
  if (failed) return <InlineFallback token={token} />;

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-none border border-neutral-700 bg-neutral-900 px-1 py-0.5 align-middle"
      data-testid="file-image-chip"
      title={`${ref_} (opens full size)`}
    >
      <img
        src={src}
        alt={ref_}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-5 w-8 object-cover"
      />
      <span className="max-w-[16em] truncate font-mono text-[12px] text-neutral-300">
        {ref_.slice(ref_.lastIndexOf("/") + 1)}
      </span>
    </a>
  );
}

function InlineFallback({ token }: { token: string }) {
  return (
    <code className="rounded-none bg-neutral-800/80 px-1 py-0.5 font-mono text-[13px] text-neutral-200">
      {token}
    </code>
  );
}

function buildSrc(folder: string | undefined, path: string): string | null {
  if (!folder) return null;
  return `/api/folder-file?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(path)}&raw=1`;
}