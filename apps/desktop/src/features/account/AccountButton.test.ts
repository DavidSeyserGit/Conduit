import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("account control stays lightweight until the user opens it", () => {
  const source = readFileSync(new URL("./AccountButton.tsx", import.meta.url), "utf8");

  assert.match(source, /lazy\(\(\) => import\("@\/features\/account\/AccountDialog"\)\)/);
  assert.match(source, /aria-label=.*Open account/);
  assert.match(source, /<UserIcon \/>/);
  assert.match(source, /pro-avatar/);
  assert.match(source, /onEntitlementChange=\{setIsPro\}/);
});

test("account dialog exposes Neon sign-in and account creation", () => {
  const source = readFileSync(new URL("./AccountDialog.tsx", import.meta.url), "utf8");

  assert.match(source, />Sign in</);
  assert.match(source, />Create account</);
  assert.match(source, /client\.signIn\.email/);
  assert.match(source, /client\.signUp\.email/);
  assert.match(source, /Continue with Google/);
  assert.match(source, /beginGoogleOAuth\(client\)/);
  assert.match(source, /refreshSession=\{session\.refetch\}/);
  assert.match(source, /void refreshSession\(\)/);
  assert.match(source, /client\.signOut/);
  assert.match(source, /className="pro-badge/);
  assert.match(source, /onEntitlementChange\(result\.entitled\)/);
});
