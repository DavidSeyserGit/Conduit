import { createRemoteJWKSet, jwtVerify } from "jose";

export interface Env {
  ACCOUNT_ORIGIN: string;
  NEON_AUTH_JWKS_URL: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_SECRET_KEY?: string;
}

interface Identity {
  id: string;
  email?: string;
}

interface StripeCustomer {
  id: string;
}

interface StripeSubscription {
  id: string;
  status: string;
  current_period_end?: number;
  items?: { data?: Array<{ price?: { id?: string } }> };
}

interface StripeList<T> {
  data: T[];
}

interface GatewayDependencies {
  authenticate(request: Request, env: Env): Promise<Identity>;
  stripe<T>(env: Env, path: string, body?: URLSearchParams): Promise<T>;
}

const ALLOWED_ORIGINS = new Set([
  "http://localhost:1420",
  "tauri://localhost",
  "https://tauri.localhost",
]);

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function authenticate(request: Request, env: Env): Promise<Identity> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new HttpError(401, "Authentication required");

  const jwks = jwksByUrl.get(env.NEON_AUTH_JWKS_URL)
    ?? createRemoteJWKSet(new URL(env.NEON_AUTH_JWKS_URL));
  jwksByUrl.set(env.NEON_AUTH_JWKS_URL, jwks);

  try {
    const { payload } = await jwtVerify(token, jwks);
    if (!payload.sub) throw new HttpError(401, "Invalid account token");
    return {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Invalid or expired account token");
  }
}

async function stripe<T>(env: Env, path: string, body?: URLSearchParams): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "Billing is not configured yet");
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": "2026-03-04.preview",
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  const payload = await response.json() as { error?: { message?: string } } & T;
  if (!response.ok) {
    throw new HttpError(response.status >= 500 ? 502 : 400, payload.error?.message ?? "Stripe request failed");
  }
  return payload;
}

const defaultDependencies: GatewayDependencies = { authenticate, stripe };

export function createGateway(dependencies: GatewayDependencies = defaultDependencies) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const origin = request.headers.get("origin");
      const cors = corsHeaders(origin);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: origin && !cors ? 403 : 204, headers: cors ?? undefined });
      }

      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/") return statusPage(env);
        if (request.method === "GET" && url.pathname === "/health") {
          return json({ ok: true, service: "conduit-account-gateway", billingConfigured: billingConfigured(env) });
        }
        if (request.method === "GET" && url.pathname === "/billing/success") return resultPage("Subscription updated", "You can return to Conduit Desktop.");
        if (request.method === "GET" && url.pathname === "/billing/cancelled") return resultPage("Checkout cancelled", "No changes were made.");

        if (!cors && origin) throw new HttpError(403, "Origin not allowed");
        if (!billingConfigured(env)) throw new HttpError(503, "Billing is not configured yet");

        const identity = await dependencies.authenticate(request, env);
        if (request.method === "POST" && url.pathname === "/v1/checkout") {
          const customer = await findOrCreateCustomer(dependencies, env, identity);
          const session = await dependencies.stripe<{ url?: string }>(env, "/v1/checkout/sessions", params({
            "line_items[0][price]": env.STRIPE_PRICE_ID!,
            "line_items[0][quantity]": "1",
            "managed_payments[enabled]": "true",
            mode: "subscription",
            customer: customer.id,
            client_reference_id: identity.id,
            success_url: `${env.ACCOUNT_ORIGIN}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${env.ACCOUNT_ORIGIN}/billing/cancelled`,
          }));
          if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
          return json({ url: session.url }, 200, cors ?? undefined);
        }

        if (request.method === "POST" && url.pathname === "/v1/billing-portal") {
          const customer = await findCustomer(dependencies, env, identity.id);
          if (!customer) throw new HttpError(404, "No Stripe customer exists for this account");
          const session = await dependencies.stripe<{ url?: string }>(env, "/v1/billing_portal/sessions", params({
            customer: customer.id,
            return_url: env.ACCOUNT_ORIGIN,
          }));
          if (!session.url) throw new HttpError(502, "Stripe did not return a portal URL");
          return json({ url: session.url }, 200, cors ?? undefined);
        }

        if (request.method === "GET" && url.pathname === "/v1/subscription") {
          const customer = await findCustomer(dependencies, env, identity.id);
          if (!customer) return json({ entitled: false, status: "none" }, 200, cors ?? undefined);
          const subscriptions = await dependencies.stripe<StripeList<StripeSubscription>>(
            env,
            `/v1/subscriptions?customer=${encodeURIComponent(customer.id)}&status=all&limit=100`,
          );
          const subscription = subscriptions.data.find((candidate) =>
            candidate.items?.data?.some((item) => item.price?.id === env.STRIPE_PRICE_ID),
          );
          return json({
            entitled: subscription?.status === "active" || subscription?.status === "trialing",
            status: subscription?.status ?? "none",
            currentPeriodEnd: subscription?.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : undefined,
          }, 200, cors ?? undefined);
        }

        throw new HttpError(404, "Not found");
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError ? error.message : "Unexpected gateway error";
        return json({ error: message }, status, cors ?? undefined);
      }
    },
  };
}

async function findCustomer(
  dependencies: GatewayDependencies,
  env: Env,
  userId: string,
): Promise<StripeCustomer | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new HttpError(400, "Unsupported account identifier");
  const query = `metadata['conduit_user_id']:'${userId}'`;
  const result = await dependencies.stripe<StripeList<StripeCustomer>>(
    env,
    `/v1/customers/search?query=${encodeURIComponent(query)}&limit=1`,
  );
  return result.data[0] ?? null;
}

async function findOrCreateCustomer(
  dependencies: GatewayDependencies,
  env: Env,
  identity: Identity,
): Promise<StripeCustomer> {
  const existing = await findCustomer(dependencies, env, identity.id);
  if (existing) return existing;
  return dependencies.stripe<StripeCustomer>(env, "/v1/customers", params({
    ...(identity.email ? { email: identity.email } : {}),
    "metadata[conduit_user_id]": identity.id,
  }));
}

function params(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function billingConfigured(env: Env): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY?.startsWith("sk_")
      && env.STRIPE_PRICE_ID?.startsWith("price_"),
  );
}

function corsHeaders(origin: string | null): Headers | null {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return null;
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  });
}

function json(body: unknown, status = 200, headers?: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function statusPage(env: Env): Response {
  return html(`
    <main><div class="mark">C</div><h1>Conduit account service</h1>
    <p>The optional identity and billing gateway for Conduit Desktop.</p>
    <span class="status">${billingConfigured(env) ? "Billing is ready" : "Billing setup in progress"}</span>
    <small>Conduit projects, goals, prompts, evidence, and reports remain on your device.</small></main>
  `);
}

function resultPage(title: string, message: string): Response {
  return html(`<main><div class="mark">C</div><h1>${title}</h1><p>${message}</p></main>`);
}

function html(content: string): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conduit</title><style>body{margin:0;background:#f7f7f8;color:#17171b;font:16px system-ui,sans-serif}main{max-width:520px;margin:18vh auto;padding:32px;text-align:center}.mark{display:grid;place-items:center;width:52px;height:52px;margin:auto;border-radius:16px;background:#17171b;color:white;font-weight:700}h1{font-size:26px;margin:20px 0 8px}p{color:#666;line-height:1.5}.status{display:inline-block;margin:18px 0;padding:8px 12px;border-radius:999px;background:#ece9ff;color:#5a43bd;font-size:13px}small{display:block;color:#888;line-height:1.5}</style>${content}</html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export default createGateway();
