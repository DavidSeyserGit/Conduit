import assert from "node:assert/strict";
import test from "node:test";
import { localProjectFromPath, pickLocalProject, upsertProjectByPath } from "./local-project.ts";

test("local folders become projects with human-readable Unix and Windows names", () => {
  assert.deepEqual(localProjectFromPath("/Users/david/code/conduit"), {
    name: "conduit",
    path: "/Users/david/code/conduit",
  });
  assert.deepEqual(localProjectFromPath("C:\\work\\robot\\"), {
    name: "robot",
    path: "C:\\work\\robot\\",
  });
});

test("folder selection returns a project and cancellation leaves no result", async () => {
  const selected = await pickLocalProject(async (options) => {
    assert.deepEqual(options, {
      directory: true,
      multiple: false,
      title: "Open local project folder",
    });
    return "/work/local-project";
  });
  assert.deepEqual(selected, { name: "local-project", path: "/work/local-project" });
  assert.equal(await pickLocalProject(async () => null), null);
});

test("duplicate folder paths are replaced instead of appended", () => {
  const existing = [
    { name: "First", path: "/work/first" },
    { name: "Old name", path: "/work/local", remote: "owner/local" },
  ];
  assert.deepEqual(upsertProjectByPath(existing, { name: "Local", path: "/work/local" }), [
    { name: "First", path: "/work/first" },
    { name: "Local", path: "/work/local", remote: "owner/local" },
  ]);
});

test("invalid picker results fail clearly", async () => {
  await assert.rejects(
    pickLocalProject(async () => ["/work/one"]),
    /unexpected selection/,
  );
  assert.throws(() => localProjectFromPath("   "), /valid path/);
});
