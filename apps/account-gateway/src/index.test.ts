import assert from "node:assert/strict";
import test from "node:test";
import { createGateway, type Env } from "./index.ts";

const configuredEnv: Env = {
  ACCOUNT_ORIGIN: "https://conduit.seyser.org",
  NEON_AUTH_JWKS_URL: "https://auth.example/.well-known/jwks.json",
  STRIPE_PRICE_ID: "price_test",
  STRIPE_SECRET_KEY: "sk_placeholder",
};

test("health endpoint works without billing secrets", async () => {
  const gateway = createGateway();
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/health"), {
    ACCOUNT_ORIGIN: configuredEnv.ACCOUNT_ORIGIN,
    NEON_AUTH_JWKS_URL: configuredEnv.NEON_AUTH_JWKS_URL,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "conduit-account-gateway",
    billingConfigured: false,
  });
});

test("health rejects product IDs in place of a recurring Price ID", async () => {
  const gateway = createGateway();
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/health"), {
    ...configuredEnv,
    STRIPE_PRICE_ID: "prod_wrong_identifier",
  });
  const payload = await response.json() as { billingConfigured: boolean };
  assert.equal(payload.billingConfigured, false);
});

test("checkout creates a managed payment session for the authenticated account", async () => {
  const calls: Array<{ path: string; body?: URLSearchParams }> = [];
  const gateway = createGateway({
    authenticate: async () => ({ id: "user_123", email: "dev@example.com" }),
    stripe: async <T>(_env: Env, path: string, body?: URLSearchParams): Promise<T> => {
      calls.push({ path, body });
      if (path.startsWith("/v1/customers/search")) return { data: [] } as T;
      if (path === "/v1/customers") return { id: "cus_123" } as T;
      if (path === "/v1/checkout/sessions") return { url: "https://checkout.stripe.test/session" } as T;
      throw new Error(`Unexpected Stripe path: ${path}`);
    },
  });
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/v1/checkout", {
    method: "POST",
    headers: { origin: "tauri://localhost", authorization: "Bearer token" },
  }), configuredEnv);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://checkout.stripe.test/session" });
  assert.equal(calls[2]?.body?.get("managed_payments[enabled]"), "true");
  assert.equal(calls[2]?.body?.get("customer"), "cus_123");
  assert.equal(response.headers.get("access-control-allow-origin"), "tauri://localhost");
});

test("billing endpoints reject untrusted browser origins", async () => {
  const gateway = createGateway({
    authenticate: async () => ({ id: "user_123" }),
    stripe: async <T>(): Promise<T> => { throw new Error("must not call Stripe"); },
  });
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/v1/subscription", {
    headers: { origin: "https://evil.example", authorization: "Bearer token" },
  }), configuredEnv);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Origin not allowed" });
});
