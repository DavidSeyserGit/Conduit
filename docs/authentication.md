# Desktop authentication

Conduit Desktop uses Neon Auth for email/password accounts. The account UI is lazy-loaded when the user selects the profile icon, so authentication code does not delay the initial desktop render.

## Local development

Copy `.env.example` to `apps/desktop/.env.local` and set the public Neon Auth base URL, including its database and `/auth` path:

```text
VITE_NEON_AUTH_URL=https://your-project.neonauth.region.aws.neon.tech/neondb/auth
VITE_CONDUIT_ACCOUNT_URL=https://conduit.seyser.org
```

`VITE_NEON_AUTH_URL` is a public client endpoint. Database connection strings, Stripe keys, webhook secrets, and other credentials must never use the `VITE_` prefix or be bundled into Desktop.

Start the browser preview with `pnpm dev`, or the native application with:

```sh
pnpm --filter @conduit/desktop tauri:dev
```

## CI and release builds

Set the GitHub Actions repository variables `VITE_NEON_AUTH_URL` and `VITE_CONDUIT_ACCOUNT_URL`. The verify, native bundle, and release workflows pass them to Vite when compiling Desktop. Because Vite substitutes renderer variables at build time, changing a repository variable affects newly built installers, not already installed releases.

The Tauri content security policy permits HTTPS connections to Neon. Neon Auth must also allow the relevant development and desktop origins.

## Account gateway and billing boundary

`apps/account-gateway` is a small Cloudflare Worker hosted at `conduit.seyser.org`. It verifies Neon JWTs, creates Stripe Managed Payments Checkout sessions, opens Stripe's customer portal, and queries live subscription state. It does not receive or store repositories, goals, prompts, runs, evidence, reports, or provider credentials.

The Stripe secret is a Cloudflare secret and must never be committed or exposed through a `VITE_` variable. Configure the sandbox integration from the gateway directory:

```sh
pnpm exec wrangler secret put STRIPE_SECRET_KEY
pnpm exec wrangler secret put STRIPE_PRICE_ID
pnpm deploy
```

The Worker can be deployed without those secrets; `/health` and the status page remain available while billing endpoints return a controlled `503`. Desktop receives only verified entitlement state and Stripe-hosted URLs. It never handles payment details.

Stripe Managed Payments is enabled explicitly on each Checkout Session. The subscription endpoint queries Stripe rather than trusting the checkout success redirect, so a redirect alone cannot unlock an entitlement.
