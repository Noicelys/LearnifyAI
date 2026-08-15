import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("./web"),
  base: "/",
  build: {
    outDir: r("./public"),
    emptyOutDir: true,
    rollupOptions: {
      input: { main: r("./web/index.html"), feedback: r("./web/feedback.html") },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/f": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
