const path = require("node:path");
const { ModuleFederationPlugin } = require("webpack").container;

// new ModuleFederationPlugin({ name: "decoy-comment" })
module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: "mfShell",
      remotes: {
        mfAdmin: "mfAdmin@http://127.0.0.1:9101/remoteEntry.js",
        mfBilling: 'promise import("http://127.0.0.1:9102/assets/remoteEntry.js")',
      },
      shared: {
        react: { singleton: true, requiredVersion: "18.3.1" },
        "react-dom": { singleton: true, requiredVersion: "18.3.1" },
      },
    }),
  ],
};
