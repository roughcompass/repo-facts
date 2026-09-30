import fs from "node:fs";

fs.writeFileSync(`${process.env.REPO_FACTS_SENTINEL_DIR}/eslint-config`, "executed");
export default [];
