import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Verifies updater artifacts produced by `tauri build`:
// every .sig is non-empty minisign data whose key ID matches the key ID of the
// updater pubkey in tauri.conf.json, and each signature has a non-empty payload.
// Catches pubkey/secret mismatches that otherwise only surface as failed updates.
const bundleDir = process.argv[2];
if (!bundleDir) throw new Error("Usage: node scripts/verify-updater-artifacts.mjs <bundle-dir>");

const tauriConfig = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const pubkeyField = tauriConfig.plugins?.updater?.pubkey;
if (!pubkeyField) throw new Error("no updater pubkey in tauri.conf.json");

// Minisign blobs are base64 of: 2-byte algorithm ("Ed"/"ED") + 8-byte key ID + key data.
function keyIdFromBlob(blob, what) {
  const algorithm = blob.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`${what}: unexpected signature algorithm ${JSON.stringify(algorithm)}`);
  }
  return blob.subarray(2, 10).toString("hex");
}

// The pubkey in tauri.conf.json is base64 of the minisign public key text,
// whose second line is the base64 key blob.
const pubkeyText = Buffer.from(pubkeyField.trim(), "base64").toString("utf8");
const pubkeyBlobLine = pubkeyText.split("\n").filter(Boolean).at(-1);
const expectedKeyId = keyIdFromBlob(Buffer.from(pubkeyBlobLine, "base64"), "updater pubkey");

const sigFiles = readdirSync(bundleDir).filter((name) => name.endsWith(".sig"));
if (sigFiles.length === 0) {
  throw new Error(`no updater signature files found in ${bundleDir}`);
}

for (const name of sigFiles) {
  const sigPath = join(bundleDir, name);
  const payloadPath = join(bundleDir, name.slice(0, -".sig".length));
  if (statSync(sigPath).size === 0) throw new Error(`${name}: empty signature file`);
  if (statSync(payloadPath).size === 0) throw new Error(`${name}: missing or empty payload`);

  const sigText = Buffer.from(readFileSync(sigPath, "utf8").trim(), "base64").toString("utf8");
  const lines = sigText.split("\n").filter(Boolean);
  const sigBlobLine = lines.find((line) => !line.includes("comment:"));
  if (!sigBlobLine) throw new Error(`${name}: no signature blob found`);
  const keyId = keyIdFromBlob(Buffer.from(sigBlobLine, "base64"), name);
  if (keyId !== expectedKeyId) {
    throw new Error(`${name}: signed with key ${keyId}, but tauri.conf.json pubkey is ${expectedKeyId}`);
  }
  process.stdout.write(`${name}: signature key matches updater pubkey\n`);
}
process.stdout.write(`Verified ${sigFiles.length} updater artifact signature(s)\n`);
