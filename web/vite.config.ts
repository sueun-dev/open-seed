import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8200",
        timeout: 600000,       // 10 minutes
        proxyTimeout: 600000,  // 10 minutes — codex subprocess can be slow
        configure: (proxy) => {
          proxy.on("error", (err) => {
            console.log("[proxy error]", err.message);
          });
        },
      },
      "/ws": { target: "ws://127.0.0.1:8200", ws: true },
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
} as any);
