// npm run registry: serves the local development registry until interrupted.
import { createToken, startRegistry } from "./lib/registry.mjs";

const port = Number(process.env.REPO_FACTS_REGISTRY_PORT ?? 4873);
const registry = await startRegistry({ port });
let token;
try {
  token = await createToken(registry.url);
} catch (error) {
  // Never leave the registry running when this script cannot finish starting it.
  await registry.stop();
  console.error(error.message);
  process.exit(1);
}
console.log(`Local registry: ${registry.url}`);
console.log("To publish or install @repo-facts packages from another shell:");
console.log(`  export REPO_FACTS_NPM_REGISTRY=${registry.url}`);
console.log(`  export REPO_FACTS_NPM_TOKEN=${token}`);
const stop = async () => {
  await registry.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
