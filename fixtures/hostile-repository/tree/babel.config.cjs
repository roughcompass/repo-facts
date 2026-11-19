require("node:child_process").spawnSync("sh", ["-c", `touch ${process.env.SURVEYOR_SENTINEL_DIR}/babel-config`]);
module.exports = { presets: [] };
