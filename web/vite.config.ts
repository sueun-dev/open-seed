import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8200",
        timeout: 300000,  // 5 minutes — intake can take a while
      },
      "/ws": { target: "ws://127.0.0.1:8200", ws: true },
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
} as any);
