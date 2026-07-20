# Desktop authentication

Conduit Desktop uses Neon Auth for email/password and Google accounts. The account UI is lazy-loaded when the user selects the profile icon, so authentication code does not delay the initial desktop render.

Google OAuth opens in the system browser. Neon returns a one-time session verifier to `https://conduit.seyser.org/auth/callback`, which hands it back to the installed app through the registered `conduit://auth/callback` protocol. The matching session challenge never leaves Conduit Desktop, and access or session tokens are not placed in callback URLs.

## Local development

Copy `.env.example` to `apps/desktop/.env.local` and set the public Neon Auth base URL, including its database and `/auth` path:

```text
VITE_NEON_AUTH_URL=https://conduit.seyser.org/neon-auth
VITE_CONDUIT_ACCOUNT_URL=https://conduit.seyser.org
```

`VITE_NEON_AUTH_URL` is the public HTTPS Neon Auth proxy exposed by the stateless account gateway. Packaged Tauri apps have a custom-protocol origin that Neon cannot list as a trusted HTTP(S) domain, so the proxy normalizes the browser origin and auth cookies without storing account data. Database connection strings, Stripe keys, webhook secrets, and other credentials must never use the `VITE_` prefix or be bundled into Desktop.

Start the browser preview with `pnpm dev`, or the native application with:

```sh
pnpm --filter @conduit/desktop tauri:dev
```

On macOS, custom URL schemes are registered from an application bundle. Email/password works under `tauri:dev`, but a complete Google callback should be tested with a debug or release `.app` bundle (for example, `pnpm --filter @conduit/desktop tauri build --debug --bundles app`). Windows and Linux can register the scheme dynamically during development.

## CI and release builds

Set the GitHub Actions repository variables `VITE_NEON_AUTH_URL` and `VITE_CONDUIT_ACCOUNT_URL`. The verify, native bundle, and release workflows pass them to Vite when compiling Desktop. Because Vite substitutes renderer variables at build time, changing a repository variable affects newly built installers, not already installed releases.

The Tauri content security policy permits HTTPS connections to Neon. Neon Auth must also allow the relevant development and desktop origins.

Enable Google in Neon Auth and add `https://conduit.seyser.org` as a trusted domain. Neon's shared Google credentials are suitable for development; configure project-owned Google OAuth credentials before a production release. Google still redirects to Neon's provider callback endpoint—Conduit's HTTPS callback is the post-authentication return URL for the desktop app.

## Account gateway and billing boundary

`apps/account-gateway` is a small Cloudflare Worker hosted at `conduit.seyser.org`. It verifies Neon JWTs, creates Stripe Managed Payments Checkout sessions, opens Stripe's customer portal, and queries live subscription state. It does not receive or store repositories, goals, prompts, runs, evidence, reports, or provider credentials.

Authenticated users manage membership and account deletion from the Desktop **Settings → User** tab. Deletion first removes the matching Stripe customer, which immediately cancels active subscriptions, and then requests deletion of the Neon Auth user. Local Conduit work is deliberately not deleted with the optional online account.

The Stripe secret is a Cloudflare secret and must never be committed or exposed through a `VITE_` variable. Configure the sandbox integration from the gateway directory:

```sh
pnpm exec wrangler secret put STRIPE_SECRET_KEY
pnpm exec wrangler secret put STRIPE_PRICE_YEARLY_ID
pnpm exec wrangler secret put STRIPE_PRICE_THREE_MONTH_ID
pnpm exec wrangler secret put STRIPE_PRICE_TEAM_ID
pnpm deploy
```

Each value must be a recurring Stripe Price ID (`price_...`), not a Product ID. Existing deployments may keep `STRIPE_PRICE_ID` as a compatibility alias for the yearly plan. The Desktop loads display prices from Stripe through the gateway and submits only the selected stable plan ID (`yearly`, `three_month`, or `team`) to Checkout.

The Worker can be deployed without those secrets; `/health` and the status page remain available while billing endpoints return a controlled `503`. Desktop receives only verified entitlement state and Stripe-hosted URLs. It never handles payment details.

Stripe Managed Payments is enabled explicitly on each Checkout Session. The subscription endpoint queries Stripe rather than trusting the checkout success redirect, so a redirect alone cannot unlock an entitlement.
