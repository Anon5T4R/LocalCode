import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    dedupe: ["react", "react-dom"],
  },

  clearScreen: false,
  build: {
    // Split the heavy Monaco core into its own chunk so the app entry stays
    // small. All chunks are still loaded locally, so this is purely cosmetic
    // (no lazy-loading) — it just silences the size warning and speeds parsing.
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/monaco-editor") || id.includes("node_modules/@monaco-editor")) {
            return "monaco";
          }
        },
      },
    },
  },
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1423,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
