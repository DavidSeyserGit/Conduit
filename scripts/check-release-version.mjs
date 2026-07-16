import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error("Expected a release tag such as v0.1.0 or v0.1.0-beta.1");
}
const expectedVersion = tag.slice(1);
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const desktopPackage = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const tauriConfig = JSON.parse(await readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const cargoManifest = await readFile("apps/desktop/src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = {
  "package.json": rootPackage.version,
  "apps/desktop/package.json": desktopPackage.version,
  "apps/desktop/src-tauri/tauri.conf.json": tauriConfig.version,
  "apps/desktop/src-tauri/Cargo.toml": cargoVersion,
};

for (const [source, version] of Object.entries(versions)) {
  assert.equal(
    version,
    expectedVersion,
    `${source} version ${String(version)} does not match release tag ${tag}`,
  );
}

process.stdout.write(`Release versions match ${tag}\n`);
