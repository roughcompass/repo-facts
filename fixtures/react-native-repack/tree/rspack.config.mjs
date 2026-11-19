import * as Repack from "@callstack/repack";

export default {
  context: import.meta.dirname,
  entry: "./index.js",
  plugins: [
    new Repack.RepackPlugin(),
    new Repack.plugins.ModuleFederationPluginV2({
      name: "host",
      dts: false,
      remotes: {
        booking: "booking@http://localhost:9000/android/mf-manifest.json",
      },
      shared: {
        react: { singleton: true, eager: true },
        "react-native": { singleton: true, eager: true },
      },
    }),
  ],
};
