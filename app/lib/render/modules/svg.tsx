/**
 * svg (docs/rich-content.md, module 3): ```svg blocks → <img> via
 * an object URL. SVG in `<img>` runs no scripts (native browser
 * rule) — the safe static tier; we deliberately never inline the
 * markup (same stored-XSS reasoning as the upload store's SVG
 * rejection).
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { RenderProps } from "../registry";

export default function Svg({ data, fallback }: RenderProps<string> & { fallback?: ReactNode }) {
  const body = data;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      const blob = new Blob([body], { type: "image/svg+xml" });
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    } catch {
      return;
    }
  }, [body]);

  if (!url) return <>{fallback ?? null}</>;
  return (
    <div className="flex justify-center border border-neutral-800 bg-neutral-950 p-3">
      <img
        src={url}
        alt="SVG diagram"
        className="max-h-[70vh] max-w-full object-contain"
        data-testid="svg-img"
      />
    </div>
  );
}