import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogBuildError, buildFromRegistry, companionVersion, fetchPackage, fetchPackument } from "../../src/index.js";
import { tarball } from "../support.js";

// reference-catalog: the Catalog Builder fetches tarballs at an exact version from a configured registry and reads them as data.
// The registry here is a local fixture registry serving packuments and tarballs, so the test needs no network.

interface Published {
  name: string;
  version: string;
  time: string;
  bytes: Buffer;
  dependencies?: Record<string, string>;
}

const DEMO_RULES = `format: 1
id: demo
name: Demo
packages: ["@demo/core", "@demo/theme"]
providers: [{ package: "@demo/core", component: DemoProvider }]
token_prefix: --demo-
equivalents: [{ tag: button, package: "@demo/core", component: Button }]
render_props: [as]
`;

describe("building from a registry", () => {
  let server: http.Server;
  let registry: string;
  let sentinel: string;
  const published: Published[] = [];
  const requests: string[] = [];

  /** A package whose install scripts would write +sentinel+ if anything ran them. */
  const pkg = (name: string, version: string, time: string, files: Record<string, string>, dependencies?: Record<string, string>): Published => {
    const manifest = { name, version, scripts: { preinstall: `node -e "require('fs').writeFileSync('${sentinel}','pre')"`, postinstall: `node postinstall.js` }, ...(dependencies && { dependencies }) };
    const bytes = tarball([
      { path: "package/package.json", content: JSON.stringify(manifest) },
      { path: "package/postinstall.js", content: `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "post");\n` },
      ...Object.entries(files).map(([file, content]) => ({ path: `package/${file}`, content })),
    ]);
    return { name, version, time, bytes, ...(dependencies && { dependencies }) };
  };

  beforeAll(async () => {
    sentinel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "surveyor-builder-")), "install-script-ran");
    const types = (button: string) => ({ "index.d.ts": `export declare function Button(props: { appearance?: ${button}; label?: string }): JSX.Element;\nexport declare function DemoProvider(props: { mode?: "light" | "dark" }): JSX.Element;\n` });
    published.push(
      pkg("@demo/core", "2.0.0", "2026-10-01T00:00:00.000Z", types('"solid" | "bordered"'), { "@demo/theme": "^3.1.0" }),
      pkg("@demo/core", "2.1.0", "2026-11-01T00:00:00.000Z", types('"solid" | "bordered" | "ghost"'), { "@demo/theme": "^3.2.0" }),
      pkg("@demo/theme", "3.1.0", "2026-09-01T00:00:00.000Z", { "theme.css": ".demo { --demo-spacing-100: 4px; }\n" }),
      pkg("@demo/theme", "3.2.0", "2026-10-20T00:00:00.000Z", { "theme.css": ".demo { --demo-spacing-100: 4px; --demo-spacing-200: 8px; }\n" }),
      pkg("@demo/theme", "3.3.0", "2026-11-15T00:00:00.000Z", { "theme.css": ".demo { --demo-spacing-300: 12px; }\n" }),
    );
    server = http.createServer((request, response) => {
      const url = new URL(request.url!, "http://registry.invalid");
      requests.push(url.pathname);
      const tarballMatch = /^\/tarballs\/(.+)-(\d+\.\d+\.\d+)\.tgz$/.exec(url.pathname);
      if (tarballMatch) {
        const found = published.find((item) => item.name === decodeURIComponent(tarballMatch[1]!) && item.version === tarballMatch[2]);
        if (!found) return void response.writeHead(404).end();
        // The registry serves altered bytes for 2.0.0, as a compromised mirror would.
        const bytes = found.name === "@demo/core" && found.version === "2.0.0" && url.searchParams.has("tampered") ? Buffer.concat([found.bytes, Buffer.from("x")]) : found.bytes;
        return void response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const versions = published.filter((item) => item.name === name);
      if (!versions.length) return void response.writeHead(404).end();
      const packument = {
        name,
        "dist-tags": { latest: versions.at(-1)!.version },
        time: Object.fromEntries(versions.map((item) => [item.version, item.time])),
        versions: Object.fromEntries(
          versions.map((item) => [
            item.version,
            { name, version: item.version, ...(item.dependencies && { dependencies: item.dependencies }), dist: { tarball: `${registry}tarballs/${encodeURIComponent(name)}-${item.version}.tgz`, integrity: `sha512-${crypto.createHash("sha512").update(item.bytes).digest("base64")}` } },
          ]),
        ),
      };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packument));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.dirname(sentinel), { recursive: true, force: true });
  });

  const DEMO = { kind: "design_system" as const, id: "demo", package: "@demo/core", tokens: "@demo/theme" };

  it("builds an entry from the exact version's tarball and the theme released with it, without running install scripts", async () => {
    const entry = await buildFromRegistry(DEMO, "2.0.0", { registry, rules: DEMO_RULES, now: () => new Date("2026-11-19T00:00:00.000Z") });
    expect(entry.version).toBe("2.0.0");
    // @demo/core 2.0.0 depends on @demo/theme ^3.1.0, so the theme is 3.1.0, though 3.2.0 and 3.3.0 are published.
    expect(entry.packages).toEqual([{ name: "@demo/core", version: "2.0.0" }, { name: "@demo/theme", version: "3.1.0" }]);
    expect(entry.content.components!.find((component) => component.name === "Button")!.props).toEqual([{ name: "appearance", values: ["bordered", "solid"] }, { name: "label" }]);
    expect(entry.content.tokens).toEqual([{ name: "--demo-spacing-100" }]);
    expect(entry.built_at).toBe("2026-11-19T00:00:00.000Z");
    expect(requests).toEqual(expect.arrayContaining(["/@demo%2fcore", "/tarballs/%40demo%2Fcore-2.0.0.tgz", "/@demo%2ftheme", "/tarballs/%40demo%2Ftheme-3.1.0.tgz"]));
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("builds a later version against its own release, and the same inputs give the same digest", async () => {
    const later = await buildFromRegistry(DEMO, "2.1.0", { registry, rules: DEMO_RULES });
    expect(later.packages).toEqual([{ name: "@demo/core", version: "2.1.0" }, { name: "@demo/theme", version: "3.2.0" }]);
    expect(later.content.components!.find((component) => component.name === "Button")!.props[0]).toEqual({ name: "appearance", values: ["bordered", "ghost", "solid"] });
    expect((await buildFromRegistry(DEMO, "2.1.0", { registry, rules: DEMO_RULES })).digest).toBe(later.digest);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("chooses a companion's version by the release's dependency range, else by publication time", async () => {
    const core = await fetchPackument("@demo/core", { registry });
    const theme = await fetchPackument("@demo/theme", { registry });
    expect(companionVersion(core.versions.get("2.1.0")!, theme)).toBe("3.2.0");
    const undeclared = { ...core.versions.get("2.1.0")!, dependencies: {} };
    expect(companionVersion(undeclared, theme)).toBe("3.2.0");
    expect(companionVersion({ ...undeclared, time: "2026-12-01T00:00:00.000Z" }, theme)).toBe("3.3.0");
  });

  it("rejects a tarball whose bytes don't match the registry's integrity", async () => {
    const packument = await fetchPackument("@demo/core", { registry });
    const version = packument.versions.get("2.0.0")!;
    const tampered = { ...packument, versions: new Map([["2.0.0", { ...version, tarball: `${version.tarball}?tampered` }]]) };
    await expect(fetchPackage(tampered, "2.0.0", { registry })).rejects.toMatchObject({ reason: "integrity_mismatch" });
  });

  it("fails with a reason when the version isn't published or the registry can't be reached", async () => {
    await expect(buildFromRegistry(DEMO, "9.9.9", { registry, rules: DEMO_RULES })).rejects.toMatchObject({ reason: "not_found" });
    await expect(buildFromRegistry({ ...DEMO, package: "@demo/missing" }, "1.0.0", { registry, rules: DEMO_RULES })).rejects.toMatchObject({ reason: "not_found" });
    const unreachable = buildFromRegistry(DEMO, "2.0.0", { registry: "http://127.0.0.1:9/", rules: DEMO_RULES, timeoutMs: 5_000 });
    await expect(unreachable).rejects.toBeInstanceOf(CatalogBuildError);
    await expect(unreachable).rejects.toMatchObject({ reason: "registry_unreachable" });
  });
});
