/**
 * ha-entity (docs/rich-content.md, module 8): `ha:<entity_id>`
 * inline spans → entity chips inside the prose. Live state via
 * GET /api/ha/state/:entity (voir proxy, token server-side); the
 * env pair unset → 503 {disabled} → the chip renders name-only
 * (honest: no fake values). READ-ONLY in v1 — chips are
 * decoration; interaction lives on cards (docs/rich-content.md —
 * Interaction).
 */
import { useEffect, useState } from "react";

export default function HaEntity({ ref_, token }: { ref_: string; token: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "disabled" }
    | { kind: "error" }
    | { kind: "ok"; value: string; unit?: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const fetchState = async () => {
      try {
        const res = await fetch(
          `/api/ha/state/${encodeURIComponent(ref_)}`,
        );
        if (res.status === 503) {
          if (!cancelled) setState({ kind: "disabled" });
          return;
        }
        if (!res.ok) {
          if (!cancelled) setState({ kind: "error" });
          return;
        }
        const d = await res.json();
        if (!cancelled) {
          setState({
            kind: "ok",
            value: String(d.state ?? ""),
            unit: typeof d.unit === "string" ? d.unit : undefined,
          });
        }
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    };
    void fetchState();
    // While the chat is visible, keep it current (60s cadence; the
    // interval itself is cheap and dies with the chip unmount).
    const timer = setInterval(fetchState, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ref_]);

  const short = token.includes(".") ? token.slice(token.lastIndexOf(".") + 1) : token;
  return (
    <span
      className="inline-flex items-baseline gap-1 whitespace-nowrap rounded-none border border-neutral-700 bg-neutral-900 px-1.5 py-0 align-middle"
      data-testid="ha-chip"
    >
      <span className="font-mono text-[12px] text-neutral-400">{short}</span>
      {state.kind === "ok" ? (
        <span className="font-mono text-[12px] text-neutral-100">
          {state.value}
          {state.unit ? <span className="ml-0.5 text-neutral-500">{state.unit}</span> : null}
        </span>
      ) : state.kind === "loading" ? (
        <span className="font-mono text-[12px] text-neutral-600">…</span>
      ) : state.kind === "error" ? (
        <span className="font-mono text-[12px] text-neutral-600" title="state unavailable">
          —
        </span>
      ) : null}
    </span>
  );
}