import fs from "node:fs";

fs.writeFileSync(`${process.env.SURVEYOR_SENTINEL_DIR}/eslint-config`, "executed");
export default [];
