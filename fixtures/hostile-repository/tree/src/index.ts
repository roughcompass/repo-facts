const name = "payload";
export const loaded = await import(`./${name}.js`);
export const plugin = await import(process.env.PLUGIN ?? "./payload.js");
export const required = require("./payload.cjs");
export const evaluated = eval("globalThis.process.getBuiltinModule('node:fs').writeFileSync(globalThis.process.env.REPO_FACTS_SENTINEL_DIR + '/eval', 'x')");
export const constructed = new Function("return globalThis.process")();
export const parsed = JSON.parse('{"__proto__": {"polluted": "source"}}');
Object.assign(Object.prototype, { polluted: "assign" });
