import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchReleaseChangelog, shouldShowChangelog, shouldShowUpdatePopup } from "./update-prompts.ts";

test("shouldShowUpdatePopup respects availability and skipped versions", () => {
  assert.equal(shouldShowUpdatePopup(null), false);
  assert.equal(shouldShowUpdatePopup({ available: false, latestVersion: "0.2.3" }), false);
  assert.equal(shouldShowUpdatePopup({ available: true, latestVersion: "0.2.3" }), true);
  assert.equal(shouldShowUpdatePopup({ available: true, latestVersion: "0.2.3" }, "0.2.3"), false);
  assert.equal(shouldShowUpdatePopup({ available: true, latestVersion: "0.2.3" }, "0.2.2"), true);
});

test("shouldShowChangelog fires on version change and on a missing lastSeen", () => {
  assert.equal(shouldShowChangelog(null, "0.2.2"), false);
  assert.equal(shouldShowChangelog("0.2.3", undefined), true);
  assert.equal(shouldShowChangelog("0.2.3", "0.2.3"), false);
  assert.equal(shouldShowChangelog("0.2.3", "0.2.2"), true);
});

test("fetchReleaseChangelog maps the GitHub release body", async () => {
  const changelog = await fetchReleaseChangelog("0.2.2", async () =>
    new Response(JSON.stringify({ tag_name: "v0.2.2", body: "What's Changed\n* fix things", published_at: "2026-07-17T00:00:00Z" }), { status: 200 }));
  assert.deepEqual(changelog, { version: "0.2.2", body: "What's Changed\n* fix things", publishedAt: "2026-07-17T00:00:00Z" });
});

test("fetchReleaseChangelog returns null on errors and empty bodies", async () => {
  assert.equal(await fetchReleaseChangelog("0.2.2", async () => new Response("nope", { status: 404 })), null);
  assert.equal(await fetchReleaseChangelog("0.2.2", async () => new Response(JSON.stringify({ tag_name: "v0.2.2" }), { status: 200 })), null);
  assert.equal(await fetchReleaseChangelog("0.2.2", async () => { throw new Error("offline"); }), null);
});
