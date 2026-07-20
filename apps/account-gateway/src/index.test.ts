import assert from "node:assert/strict";
import test from "node:test";
import { createGateway, stripeErrorMessage, type Env } from "./index.ts";

const configuredEnv: Env = {
  ACCOUNT_ORIGIN: "https://conduit.seyser.org",
  NEON_AUTH_URL: "https://auth.example/neondb/auth",
  NEON_AUTH_JWKS_URL: "https://auth.example/.well-known/jwks.json",
  STRIPE_PRICE_ID: "price_test",
  STRIPE_PRICE_THREE_MONTH_ID: "price_three_month",
  STRIPE_PRICE_TEAM_ID: "price_team",
  STRIPE_SECRET_KEY: "sk_placeholder",
};

test("health endpoint works without billing secrets", async () => {
  const gateway = createGateway();
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/health"), {
    ACCOUNT_ORIGIN: configuredEnv.ACCOUNT_ORIGIN,
    NEON_AUTH_URL: configuredEnv.NEON_AUTH_URL,
    NEON_AUTH_JWKS_URL: configuredEnv.NEON_AUTH_JWKS_URL,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "conduit-account-gateway",
    billingConfigured: false,
  });
});

test("Neon Auth proxy normalizes the packaged desktop origin and session cookie", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamOrigin: string | null = null;
  globalThis.fetch = async (input, init) => {
    upstreamOrigin = new Request(input, init).headers.get("origin");
    return new Response(JSON.stringify({ user: { id: "user_123" }, session: { id: "session_123" } }), {
      headers: {
        "content-type": "application/json",
        "set-auth-jwt": "jwt_123",
        "set-cookie": "__Secure-neon-auth.session_token=token_123; Path=/; HttpOnly; SameSite=Lax; Secure",
      },
    });
  };
  try {
    const gateway = createGateway();
    const response = await gateway.fetch(new Request("https://conduit.seyser.org/neon-auth/get-session", {
      headers: { origin: "tauri://localhost", cookie: "challenge=abc" },
    }), configuredEnv);
    assert.equal(response.status, 200);
    assert.equal(upstreamOrigin, "https://conduit.seyser.org");
    assert.equal(response.headers.get("access-control-allow-origin"), "tauri://localhost");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /X-Neon-Client-Info/);
    assert.match(response.headers.get("set-cookie") ?? "", /SameSite=None; Secure/);
    assert.equal(response.headers.get("set-auth-jwt"), "jwt_123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health rejects product IDs in place of a recurring Price ID", async () => {
  const gateway = createGateway();
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/health"), {
    ...configuredEnv,
    STRIPE_PRICE_ID: "prod_wrong_identifier",
    STRIPE_PRICE_THREE_MONTH_ID: undefined,
    STRIPE_PRICE_TEAM_ID: undefined,
  });
  const payload = await response.json() as { billingConfigured: boolean };
  assert.equal(payload.billingConfigured, false);
});

test("OAuth callback returns the Neon verifier to the Conduit app without exposing a session token", async () => {
  const gateway = createGateway();
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/auth/callback?neon_auth_session_verifier=verify_123&state=state_456"), configuredEnv);
  const page = await response.text();

  assert.equal(response.status, 200);
  assert.match(page, /conduit:\/\/auth\/callback\?neon_auth_session_verifier=verify_123/);
  assert.match(page, /state=state_456/);
  assert.doesNotMatch(page, /access_token|session_token/);
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
    headers: { origin: "tauri://localhost", authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify({ planId: "team" }),
  }), configuredEnv);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://checkout.stripe.test/session" });
  assert.equal(calls[2]?.body?.get("managed_payments[enabled]"), "true");
  assert.equal(calls[2]?.body?.get("customer"), "cus_123");
  assert.equal(calls[2]?.body?.get("line_items[0][price]"), "price_team");
  assert.equal(response.headers.get("access-control-allow-origin"), "tauri://localhost");
});

test("plan catalog returns Stripe amounts for every configured membership", async () => {
  const gateway = createGateway({
    authenticate: async () => ({ id: "user_123" }),
    stripe: async <T>(_env: Env, path: string): Promise<T> => {
      const priceId = path.split("/").at(-1)!;
      return {
        id: priceId,
        active: true,
        currency: "eur",
        unit_amount: priceId === "price_team" ? 9900 : 2400,
        recurring: { interval: priceId === "price_test" ? "year" : "month", interval_count: priceId === "price_three_month" ? 3 : 1 },
      } as T;
    },
  });
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/v1/plans", {
    headers: { origin: "tauri://localhost", authorization: "Bearer token" },
  }), configuredEnv);
  const payload = await response.json() as { plans: Array<{ id: string; unitAmount: number; intervalCount: number }> };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.plans.map((plan) => plan.id), ["yearly", "three_month", "team"]);
  assert.equal(payload.plans[1]?.intervalCount, 3);
  assert.equal(payload.plans[2]?.unitAmount, 9900);
});

test("account deletion removes the matching Stripe customer", async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  const gateway = createGateway({
    authenticate: async () => ({ id: "user_123" }),
    stripe: async <T>(_env: Env, path: string, _body?: URLSearchParams, method?: "GET" | "POST" | "DELETE"): Promise<T> => {
      calls.push({ path, method });
      if (path.startsWith("/v1/customers/search")) return { data: [{ id: "cus_123" }] } as T;
      if (path === "/v1/customers/cus_123" && method === "DELETE") return { deleted: true } as T;
      throw new Error(`Unexpected Stripe path: ${path}`);
    },
  });
  const response = await gateway.fetch(new Request("https://conduit.seyser.org/v1/account", {
    method: "DELETE",
    headers: { origin: "tauri://localhost", authorization: "Bearer token" },
  }), configuredEnv);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.deepEqual(calls.at(-1), { path: "/v1/customers/cus_123", method: "DELETE" });
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

test("Stripe product configuration failures become a clear plan error", async () => {
  assert.equal(
    stripeErrorMessage("Invalid line_items[0]: the product_tax_code is missing"),
    "This plan is not available yet because its Stripe product needs a Managed Payments-eligible tax code.",
  );
  assert.equal(stripeErrorMessage("A different Stripe error"), "A different Stripe error");
});
