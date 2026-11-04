/**
 * voir-rich — the voir side of the rich-content nudge
 * (docs/rich-content.md — "Nudging the agent").
 *
 * Voir ships as a pi package (this repo IS the package: the `pi`
 * manifest in package.json lists extensions/ + skills/). Installed
 * by path (`pi install /path/to/voir`) it is read live from the
 * checkout — skills and this extension update with `git pull`,
 * no reinstall.
 *
 * Layer 0: a compact system-prompt section, appended ONLY when the
 * session runs under voir. Detection is the spawn env: acp-lib.mjs
 * sets `VOIR=1` next to `ACP_FOLDER`, so every voir-attached agent
 * gets the nudge and terminal pi, print-mode scripts (the hiet
 * checkup) and other hosts stay silent. The section text is
 * ASSEMBLED FROM THE MODULE GUIDES (registry.ts assembleNudge())
 * — the single source of truth lives with the modules; a module
 * without a `guide` is invisible to agents.
 *
 * Opt-out: `VOIR_NUDGE=off` skips the section (the skill stays
 * available — the model can still consult it on mention).
 *
 * Layer 1 (full schemas + examples) is the `voir-rich` skill in
 * this package — its name+description ride the system prompt
 * cheaply everywhere; the body loads only when needed.
 *
 * The extension avoids importing the host's ExtensionAPI type:
 * pi maps `@earendil-works/*` for extensions at RUNTIME, but
 * tsc (voir's own typecheck) can't resolve it — the structural
 * local type below is the same contract.
 */

interface BeforeAgentStartEvent {
  systemPromptOptions: {
    sections: Record<string, string>;
  };
}
interface VoirExtensionAPI {
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent) => void): void;
}

import { assembleNudge } from "../../app/lib/render/registry.ts";

export default function voirRichExtension(pi: VoirExtensionAPI) {
  // Registration-time env check: acp-lib sets VOIR before spawning
  // the agent process, so process.env is the honest gate — no
  // mode-detection needed, no leakage into terminal/print runs.
  if (process.env.VOIR !== "1") return;
  if (process.env.VOIR !== "1") return;
  if (process.env.VOIR_NUDGE === "off") return;
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.voir_rich = assembleNudge();
  });
}