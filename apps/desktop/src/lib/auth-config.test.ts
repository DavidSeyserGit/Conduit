import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNeonAuthUrl } from "./auth-config.ts";

test("accepts secure Neon Auth endpoints and preserves the database auth path", () => {
  assert.equal(
    normalizeNeonAuthUrl("https://example.neonauth.us-east-1.aws.neon.tech/neondb/auth/"),
    "https://example.neonauth.us-east-1.aws.neon.tech/neondb/auth",
  );
});

test("allows HTTP only for local development", () => {
  assert.equal(normalizeNeonAuthUrl("http://localhost:3000/auth/"), "http://localhost:3000/auth");
  assert.equal(normalizeNeonAuthUrl("http://auth.example.com"), null);
});

test("rejects missing, malformed, or credential-bearing URLs", () => {
  assert.equal(normalizeNeonAuthUrl(undefined), null);
  assert.equal(normalizeNeonAuthUrl("not a url"), null);
  assert.equal(normalizeNeonAuthUrl("https://user:pass@auth.example.com"), null);
});
