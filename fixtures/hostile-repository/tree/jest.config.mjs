const { Worker } = await import("node:worker_threads");
new Worker(`require("node:fs").writeFileSync(process.env.SURVEYOR_SENTINEL_DIR + "/jest-config", "x")`, { eval: true });
export default { testEnvironment: "node" };
