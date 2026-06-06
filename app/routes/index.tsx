// Re-export the chat app for the / index route. The actual logic is in
// routes/chat.tsx (splat) — this file is just an alias so React Router
// can have a separate id for the index.
export { default, loader, action } from "./chat";
