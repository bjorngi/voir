// Client entry. initFaro() FIRST — before hydration and before the
// service-worker registration script in root.tsx runs — so boot-time
// errors are caught too (estate observability pattern, app/faro.ts).
import { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { initFaro } from "./faro";

initFaro();

startTransition(() => {
  hydrateRoot(document, <HydratedRouter />);
});