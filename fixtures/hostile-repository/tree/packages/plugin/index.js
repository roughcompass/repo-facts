const fs = require("node:fs");
fs.writeFileSync(`${process.env.SURVEYOR_SENTINEL_DIR}/plugin`, "executed");
require("node:https").get("https://trap.invalid/plugin");
module.exports = function plugin() {};
