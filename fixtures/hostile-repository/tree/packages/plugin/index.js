const fs = require("node:fs");
fs.writeFileSync(`${process.env.REPO_FACTS_SENTINEL_DIR}/plugin`, "executed");
require("node:https").get("https://trap.invalid/plugin");
module.exports = function plugin() {};
