import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("settings exposes lazy-loaded Privacy and User tabs", () => {
  const source = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /lazy\(\(\) => import\("@\/features\/settings\/UserSettings"\)\)/);
  assert.match(source, /lazy\(\(\) => import\("@\/features\/settings\/PrivacySettings"\)\)/);
  assert.match(source, /"updates", "privacy", "user"/);
  assert.match(source, /tab === "privacy"/);
  assert.match(source, /tab === "user"/);
});

test("privacy analytics is explicit opt-in and exposes its exact payload", () => {
  const source = readFileSync(new URL("./PrivacySettings.tsx", import.meta.url), "utf8");
  assert.match(source, /disabled until you choose to share them/);
  assert.match(source, /anonymousAnalyticsEnabled === true/);
  assert.match(source, /No stable user, account, installation, device, or session identifier/);
  assert.match(source, /pendingAnonymousAnalyticsPayload/);
});

test("User settings manages membership and confirms destructive deletion", () => {
  const source = readFileSync(new URL("./UserSettings.tsx", import.meta.url), "utf8");
  assert.match(source, />Membership</);
  assert.match(source, /"Manage billing"/);
  assert.match(source, /setShowPlans\(true\)/);
  assert.match(source, /<SubscriptionPlans onClose=/);
  assert.match(source, /"canceled", "incomplete_expired"/);
  assert.match(source, /"Choose a plan"/);
  assert.match(source, />Delete account</);
  assert.match(source, /deleteConfirmation\.trim\(\)\.toLowerCase\(\) !== user\.email\.toLowerCase\(\)/);
  assert.ok(source.indexOf("await deleteBillingAccount()") < source.indexOf("await client.deleteUser()"));
});

test("subscription chooser presents a focused three-card pricing modal", () => {
  const source = readFileSync(new URL("./SubscriptionPlans.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  assert.match(source, /Pick the plan that works for you/);
  assert.match(source, /md:grid-cols-3/);
  assert.match(source, /yearly:/);
  assert.match(source, /three_month:/);
  assert.match(source, /team:/);
  assert.match(source, /formatPrice\(plan\)/);
  assert.match(source, /createCheckout\(planId\)/);
  assert.match(source, /subscription-plan-featured/);
  assert.match(css, /\.dark \.subscription-plan-featured/);
});
