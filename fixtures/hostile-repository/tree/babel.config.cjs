require("node:child_process").spawnSync("sh", ["-c", `touch ${process.env.REPO_FACTS_SENTINEL_DIR}/babel-config`]);
module.exports = { presets: [] };
