import { getNeonAccessToken } from "@/lib/neon-auth";
import { normalizeAccountGatewayUrl } from "@/lib/account-gateway-config";

export const accountGatewayUrl = normalizeAccountGatewayUrl(import.meta.env.VITE_CONDUIT_ACCOUNT_URL);

export interface SubscriptionState {
  entitled: boolean;
  status: string;
  currentPeriodEnd?: string;
}

export async function getSubscription(): Promise<SubscriptionState> {
  return gatewayRequest<SubscriptionState>("/v1/subscription", "GET");
}

export async function createCheckout(): Promise<string> {
  const result = await gatewayRequest<{ url: string }>("/v1/checkout", "POST");
  return requireHostedUrl(result.url);
}

export async function createBillingPortal(): Promise<string> {
  const result = await gatewayRequest<{ url: string }>("/v1/billing-portal", "POST");
  return requireHostedUrl(result.url);
}

async function gatewayRequest<T>(path: string, method: "GET" | "POST"): Promise<T> {
  if (!accountGatewayUrl) throw new Error("Account billing is not configured in this build.");
  const token = await getNeonAccessToken();
  if (!token) throw new Error("Please sign in before managing a subscription.");
  const response = await fetch(`${accountGatewayUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "The account service could not complete the request.");
  return payload;
}

function requireHostedUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("The account service returned an invalid billing URL.");
  return url.toString();
}
