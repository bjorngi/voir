// Shared message / update types. Isomorphic (no Node-only imports) so
// both the server (sessions.server.ts) and the client (components/) can
// import them.

/**
 * One piece of a prompt to the agent. `text` and `resource_link`
 * are the ones Voir actually emits; the other variants are
 * accepted so a future caller can pass through what the agent
 * sent us.
 *
 * Kept as a single interface rather than a discriminated union
 * so the existing `c.type === "text" ? c.text : c.name` patterns
 * in the server continue to type-check without a switch. The
 * agent only ever sends us a `type` tag plus a small number of
 * fields, and we forward those along unchanged.
 */
export interface ContentBlock {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  resource?: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

/** Body of a tool-call message. Diff pairs are how the agent reports edits. */
export interface ToolCallContentBlock {
  type: "content" | "diff";
  content?: ContentBlock;
  path?: string;
  oldText?: string;
  newText?: string;
}

/**
 * A model advertised by the agent. The id is the stable handle
 * the client uses to select a model; name/description are UI
 * hints. Mirrors the ACP `ModelInfo` shape as exposed by
 * pi-acp.
 */
export interface AvailableModel {
  modelId: string;
  name?: string;
  description?: string;
}

/**
 * A thinking-level / mode advertised by the agent. pi-acp
 * uses the same id space for modes as for thinking levels
 * (off, minimal, low, medium, high, xhigh).
 */
export interface AvailableMode {
  id: string;
  name?: string;
  description?: string;
}

/**
 * A turn-scoped piece of state streamed from the server to the browser.
 *
 *   text:    a chunk of an agent's reply (or thought) being assembled
 *   tool:    a tool call and its live status / content
 *   plan:    the agent's current plan (replaced wholesale on each update)
 *   system:  developer-facing message; rarely rendered to the user
 *   info/error: protocol-level noise; not for the chat transcript
 *   busy:    internal — toggles the "Agent is working…" indicator
 */
export type ChatMessage =
  | {
      id: string;
      role: "user" | "agent";
      kind: "text";
      text: string;
      /** True for the currently-streaming text message of a turn. */
      streaming?: boolean;
      at: number;
    }
  | {
      id: string;
      role: "agent";
      kind: "thought";
      text: string;
      streaming?: boolean;
      at: number;
    }
  | {
      id: string;
      role: "agent";
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      content?: ToolCallContentBlock[];
      locations?: Array<{ path: string; line?: number }>;
      at: number;
    }
  | {
      id: string;
      role: "agent";
      kind: "plan";
      entries: Array<{
        content: string;
        priority?: "high" | "medium" | "low";
        status?: "pending" | "in_progress" | "completed";
      }>;
      at: number;
    }
  | {
      id: string;
      role: "system";
      kind: "info" | "error";
      text: string;
      at: number;
    }
  | {
      // Internal control message. The handler in chat.tsx updates state
      // but never renders this to the user.
      id: string;
      role: "system";
      kind: "busy";
      busy: boolean;
      at: number;
    }
  | {
      // Out-of-band update from the agent that isn't part of the
      // transcript. The server emits these when the agent advertises
      // a new model/mode/command list, switches the active model or
      // mode, or reports a change in the prompt-queue depth. The
      // chat intercepts them to keep its local state in sync without
      // round-tripping through the loader.
      id: string;
      role: "system";
      kind: "control";
      control: ControlUpdate;
      at: number;
    };

/** Discriminated payload of a `kind: "control"` system message. */
export type ControlUpdate =
  | { type: "currentMode"; modeId: string }
  | { type: "currentModel"; modelId: string }
  | { type: "availableCommands"; commands: SlashCommand[] }
  | { type: "availableModels"; models: AvailableModel[] }
  | { type: "availableModes"; modes: AvailableMode[] }
  | { type: "queueDepth"; depth: number }
  /**
   * The server rebuilt this session's transcript from agent
   * truth (agent leg dropped and healed). Live tabs should
   * reconnect their stream and re-snapshot — no payload.
   */
  | { type: "resync" };

/** A folder in the sidebar. */
export interface FolderSummary {
  path: string;
  agentName?: string;
  agentUrl: string;
  registeredAt: number;
  /** Agent-leg liveness: `degraded` while heartbeats are failing. */
  status: "ok" | "degraded";
  /** Epoch ms of the last successful heartbeat ping. */
  lastSeenAt: number;
  sessions: SessionSummary[];
  /**
   * Cheap diff summary for the worktree: how many files
   * changed vs the auto-detected base branch, plus the
   * insertion / deletion totals. `undefined` when the folder
   * isn't a git repo, or no obvious base branch (main /
   * master / develop / trunk) could be located. The root
   * view renders a `+N -M` pill from this; the diff tab uses
   * the heavier `/api/folder-diff` payload instead.
   */
  diffSummary?: DiffSummary;
}

/**
 * A line of a diff. Mirrors the shape the `Message` component
 * already uses for inline edit previews, so we can share the
 * renderer between the chat and the diff tab.
 */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** A `@@` hunk header plus its body lines. */
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/**
 * One file in the diff. `oldPath` is set for renames; for
 * every other status it's omitted. `truncated: true` means
 * the body was clipped because it exceeded the diff size
 * cap — the file list is still accurate.
 */
export interface DiffFile {
  path: string;
  oldPath?: string;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "typechange"
    | "untracked";
  truncated?: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/**
 * Cheap counts used in the folder list and folder header. The
 * diff tab uses the heavier `DiffResult` payload instead.
 */
export interface DiffSummary {
  /** The resolved base ref, e.g. "main" or "origin/main". */
  base: string;
  /** True when the base is a local branch; false for a remote ref. */
  baseLocal: boolean;
  files: number;
  additions: number;
  deletions: number;
  /**
   * Number of untracked files. They're already included in
   * `files`; this is broken out so the UI can render a
   * "+3 untracked" suffix.
   */
  untracked: number;
}

export interface SessionSummary {
  id: string;
  title?: string;
  createdAt: number;
  messageCount: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Hint shown as a placeholder in the composer. */
  inputHint?: string;
}
