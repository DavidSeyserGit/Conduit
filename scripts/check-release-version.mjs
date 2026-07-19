import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tag = process.argv.slice(2).filter((arg) => arg !== "--")[0];
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const desktopPackage = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const runtimePackage = JSON.parse(await readFile("packages/agent-runtime/package.json", "utf8"));
const cgsPackage = JSON.parse(await readFile("packages/cgs/package.json", "utf8"));
const tauriConfig = JSON.parse(await readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const cargoManifest = await readFile("apps/desktop/src-tauri/Cargo.toml", "utf8");
const desktopVersionSource = await readFile("apps/desktop/src/version.ts", "utf8");
const runtimeVersionSource = await readFile("packages/agent-runtime/src/version.ts", "utf8");
const cgsVersionSource = await readFile("packages/cgs/src/common.ts", "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const desktopSourceVersion = desktopVersionSource.match(/CONDUIT_DESKTOP_VERSION\s*=\s*"([^"]+)"/)?.[1];
const runtimeSourceVersion = runtimeVersionSource.match(/CONDUIT_RUNTIME_VERSION\s*=\s*"([^"]+)"/)?.[1];
const cgsSourceVersion = cgsVersionSource.match(/CGS_VERSION\s*=\s*"([^"]+)"/)?.[1];

const versions = {
  "package.json": rootPackage.version,
  "apps/desktop/package.json": desktopPackage.version,
  "apps/desktop/src-tauri/tauri.conf.json": tauriConfig.version,
  "apps/desktop/src-tauri/Cargo.toml": cargoVersion,
  "packages/agent-runtime/package.json": runtimePackage.version,
  "apps/desktop/src/version.ts": desktopSourceVersion,
  "packages/agent-runtime/src/version.ts": runtimeSourceVersion,
};

assert.equal(cgsPackage.version, "0.1.0", "CGS package must remain independently versioned at 0.1.0 for this release");
assert.equal(cgsSourceVersion, cgsPackage.version, "CGS source and package versions disagree");

// Without a tag argument, verify that all version sources agree with each other.
if (!tag) {
  const distinct = new Set(Object.values(versions));
  assert.equal(
    distinct.size,
    1,
    `Version sources disagree: ${Object.entries(versions).map(([s, v]) => `${s}=${String(v)}`).join(", ")}`,
  );
  process.stdout.write(`All version sources agree: ${[...distinct][0]}\n`);
  process.exit(0);
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error("Expected a release tag such as v0.1.0 or v0.1.0-beta.1");
}
const expectedVersion = tag.slice(1);

for (const [source, version] of Object.entries(versions)) {
  assert.equal(
    version,
    expectedVersion,
    `${source} version ${String(version)} does not match release tag ${tag}`,
  );
}

process.stdout.write(`Release versions match ${tag}\n`);
