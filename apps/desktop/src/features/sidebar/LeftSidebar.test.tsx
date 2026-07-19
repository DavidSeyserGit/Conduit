import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("project add flow exposes local folders and GitHub as distinct actions", () => {
  const sidebar = readFileSync(new URL("./LeftSidebar.tsx", import.meta.url), "utf8");

  assert.match(sidebar, /title="Add project"/);
  assert.match(sidebar, />Open local folder</);
  assert.match(sidebar, />Clone from GitHub</);
  assert.match(sidebar, /pickLocalProject\(open\)/);
  assert.match(sidebar, /role="alert"/);
});
