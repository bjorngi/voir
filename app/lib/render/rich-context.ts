/**
 * Rich-content context (docs/rich-content.md): the chat's folder,
 * provided by ChatView — the one piece of carrier context inline
 * module components need that the token itself doesn't carry
 * (file chips resolve against the worktree).
 */
import { createContext, useContext } from "react";

export interface RichChatContext {
  /** Absolute folder path of the chat being rendered. */
  folder: string;
}

export const RichContext = createContext<RichChatContext | null>(null);

export function useRichChat(): RichChatContext | null {
  return useContext(RichContext);
}
