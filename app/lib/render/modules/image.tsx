/**
 * image (docs/rich-content.md, module 7): ```image fences holding
 * a data URI, plus tool-result image content blocks. Same <img>
 * rendering as user-message attachments.
 */
import type { ReactNode } from "react";
import type { RenderProps } from "../registry";

export default function Image({ data, fallback }: RenderProps<string> & { fallback?: ReactNode }) {
  const src = normalize(data);
  if (!src || !src.startsWith("data:image/")) return <>{fallback ?? null}</>;
  return (
    <div className="flex justify-center border border-neutral-800 bg-neutral-950 p-2">
      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
        <img
          src={src}
          alt="Image from the agent"
          loading="lazy"
          className="max-h-[70vh] max-w-full rounded-none object-contain"
          data-testid="rich-image"
        />
      </a>
    </div>
  );
}

/** Accept `data:image/…;base64,…` body (the fence); tolerate a
 *  bare base64 blob after the mimeType hint couldn't parse. */
function normalize(body: string): string | null {
  const s = body.trim();
  if (s.startsWith("data:image/")) return s;
  // Bare base64: sniff the type from the payload header.
  const header = atob(s.slice(0, 80));
  if (header.startsWith("\u0089PNG")) return "data:image/png;base64," + s;
  if (header.startsWith("\u00ff\u00d8")) return "data:image/jpeg;base64," + s;
  return null;
}