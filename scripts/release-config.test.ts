import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("all application version sources stay aligned", async () => {
  const rootPackage = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const desktopPackage = JSON.parse(await readFile("apps/desktop/package.json", "utf8")) as {
    version: string;
  };
  const tauriConfig = JSON.parse(
    await readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
  ) as { version: string };
  const cargoManifest = await readFile("apps/desktop/src-tauri/Cargo.toml", "utf8");
  const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

  assert.equal(desktopPackage.version, rootPackage.version);
  assert.equal(tauriConfig.version, rootPackage.version);
  assert.equal(cargoVersion, rootPackage.version);
  assert.match(
    execFileSync(process.execPath, ["scripts/check-release-version.mjs", `v${rootPackage.version}`], {
      encoding: "utf8",
    }),
    /Release versions match/,
  );

  const mismatch = spawnSync(
    process.execPath,
    ["scripts/check-release-version.mjs", "v99.99.99"],
    { encoding: "utf8" },
  );
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match release tag v99\.99\.99/);
});

test("CI is reusable without duplicate feature-branch or tag workflows", async () => {
  const workflow = await readFile(".github/workflows/verify.yml", "utf8");

  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  assert.doesNotMatch(workflow, /push:\n\s+tags:/);
  assert.match(workflow, /run: pnpm verify/);
  assert.match(workflow, /tauri build --ci --bundles deb -- --locked/);
  assert.doesNotMatch(workflow, /version: 11\.0\.9/);
});

test("release publishing is gated and covers every desktop platform", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /check-release-version\.mjs/);
  assert.match(workflow, /tauri-apps\/tauri-action@v1/);
  assert.match(workflow, /--locked/);
  assert.match(workflow, /macOS Apple Silicon/);
  assert.match(workflow, /macOS Intel/);
  assert.match(workflow, /Linux x64/);
  // Windows is parked: icon.ico is broken and there is no Windows demand; see releasing.md.
  assert.doesNotMatch(workflow, /Windows x64/);
  assert.match(workflow, /releaseDraft: false/);
});
