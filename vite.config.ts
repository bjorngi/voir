import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    host: "0.0.0.0",
    port: 9000,
    // The dev server is reachable from the LAN, from inside
    // docker compose (acp-spawn talks to it as `http://web:9000`),
    // and from anywhere else your dev workflow needs. DNS-rebinding
    // protection is a fine default for the public internet, but
    // this is a dev server bound to 0.0.0.0 — accept everything.
    allowedHosts: true,
  },
});
