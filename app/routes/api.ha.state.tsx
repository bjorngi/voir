import type { Route } from "./+types/api.ha.state";

/**
 * Home Assistant state proxy for the inline `ha:` chips
 * (docs/rich-content.md — Live state). Read-only, single entity:
 *
 *   GET /api/ha/state/:entity
 *     → 200 { state: string, unit?: string }
 *     → 503 { disabled: true }   (no VOIR_HA_URL/VOIR_HA_TOKEN —
 *                                the chip renders name-only)
 *     → 404 unknown entity · 502 HA unreachable
 *
 * The token never reaches the browser (the voice-STT / inbox
 * pattern). GET only — mutations would need the v2 proxy-action
 * allowlist design, deliberately out of scope here.
 */

const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_-]+$/i;

export async function loader({ params }: Route.LoaderArgs) {
  const { entity } = params;
  const haUrl = process.env.VOIR_HA_URL;
  const token = process.env.VOIR_HA_TOKEN;
  if (!haUrl || !token) {
    return Response.json({ disabled: true }, { status: 503 });
  }
  if (!entity || !ENTITY_RE.test(entity)) {
    return Response.json(
      { error: "entity must be <domain>.<slug>" },
      { status: 400 },
    );
  }
  try {
    const res = await fetch(
      `${haUrl.replace(/\/+$/, "")}/api/states/${encodeURIComponent(entity)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (res.status === 404) {
      return Response.json({ error: "Unknown entity" }, { status: 404 });
    }
    if (!res.ok) {
      return Response.json(
        { error: `HA answered ${res.status}` },
        { status: 502 },
      );
    }
    const st = (await res.json()) as {
      state?: unknown;
      attributes?: Record<string, unknown>;
    };
    const unit =
      st.attributes && typeof st.attributes.unit_of_measurement === "string"
        ? st.attributes.unit_of_measurement
        : undefined;
    return Response.json({
      state: typeof st.state === "string" ? st.state : String(st.state ?? ""),
      unit,
    });
  } catch {
    return Response.json({ error: "HA unreachable" }, { status: 502 });
  }
}