// The website: web/ is the page, src/ is shared with the command-line tools.
//   npm run dev     -> http://localhost:5173 while working on it
//   npm run build   -> dist/, a static site that can go on any web host (e.g. GitHub Pages)

import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  worker: { format: "es" },
  // OpenCASCADE's loader is large and loads its .wasm itself; leave it as it is.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
});
