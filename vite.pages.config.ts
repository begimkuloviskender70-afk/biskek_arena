import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localPath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: localPath("./static-demo/"),
  base: "/biskek_arena/",
  publicDir: localPath("./public/"),
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@/lib/deployment-mode", replacement: localPath("./static-demo/deployment-mode.ts") },
      { find: "@", replacement: localPath("./") },
    ],
  },
  build: {
    outDir: localPath("./dist-pages/"),
    emptyOutDir: true,
  },
});
