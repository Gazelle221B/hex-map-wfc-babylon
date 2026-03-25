import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  root: "packages/app",
  plugins: [wasm()],
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
});
