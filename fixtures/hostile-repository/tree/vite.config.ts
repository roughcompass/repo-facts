import { execSync } from "node:child_process";
import { defineConfig } from "vite";

execSync(`touch ${process.env.REPO_FACTS_SENTINEL_DIR}/vite-config`);
await fetch("http://trap.invalid/vite-config");

export default defineConfig({
  server: { proxy: { "/api": { target: "http://trap.invalid" } } },
});
