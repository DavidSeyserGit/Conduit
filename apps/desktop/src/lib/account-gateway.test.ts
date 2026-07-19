import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAccountGatewayUrl } from "./account-gateway-config.ts";

test("accepts an HTTPS account gateway origin", () => {
  assert.equal(normalizeAccountGatewayUrl("https://conduit.seyser.org/"), "https://conduit.seyser.org");
});

test("allows HTTP only for a local gateway", () => {
  assert.equal(normalizeAccountGatewayUrl("http://localhost:8787"), "http://localhost:8787");
  assert.equal(normalizeAccountGatewayUrl("http://conduit.example"), null);
});

test("rejects credentials and path-based gateway URLs", () => {
  assert.equal(normalizeAccountGatewayUrl("https://user:pass@conduit.example"), null);
  assert.equal(normalizeAccountGatewayUrl("https://conduit.example/api"), null);
  assert.equal(normalizeAccountGatewayUrl(undefined), null);
});
