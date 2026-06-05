import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      allow: [repoRoot],
    },
    watch: {
      // Pick up @squash/shared dist rebuilds from `pnpm --filter @squash/shared dev`.
      ignored: ["**/node_modules/**", "!**/packages/shared/dist/**"],
    },
    proxy: {
      // Use 127.0.0.1 so Windows does not route localhost to another app's IPv6 listener on :3001.
      "/api": "http://127.0.0.1:3001",
      "/health": "http://127.0.0.1:3001",
    },
  },
});
