# Anonymous usage analytics

Conduit Desktop can optionally share aggregate feature counters. Collection is disabled by default and begins only after the user enables **Settings → Privacy → Share anonymous usage analytics**.

This telemetry is intentionally separate from Conduit accounts and billing. The Desktop does not send an authorization token or cookies, and the telemetry service does not accept a user, account, installation, device, or session identifier.

## Collected fields

Each batch has exactly four fields:

```json
{
  "schemaVersion": 1,
  "appVersion": "0.4.0",
  "platform": "macos",
  "counts": {
    "goal_started": 2,
    "goal_completed": 1
  }
}
```

`platform` is limited to `macos`, `windows`, `linux`, or `other`. `counts` accepts only these fixed event names:

- `app_opened`
- `goal_started`
- `goal_completed`
- `goal_failed`
- `goal_cancelled`
- `profile_opened`
- `plan_chooser_opened`
- `billing_manage_opened`
- `checkout_yearly_started`
- `checkout_three_month_started`
- `checkout_team_started`

The payload never contains goal text, prompts, code, repository data, file paths, commands, model output, evidence, reports, account data, payment data, or free-form event properties.

## Collection behavior

Counters are batched locally and sent to the dedicated `conduit-telemetry-gateway` Cloudflare Worker. Disabling analytics immediately removes locally queued counters. The Desktop sends requests with credentials omitted. The Worker rejects unknown fields and unknown event names, then increments daily aggregate rows in a dedicated D1 database. Individual requests are not stored, and Worker observability is disabled to avoid retaining request logs.

The account gateway and telemetry gateway are separate services and datasets. Telemetry is never joined to Neon Auth or Stripe records.

## Adding an event

An event must be a product-level counter that is useful without identity or content. Add it to both allowlists, add a test proving its payload remains identifier-free, and update this document. Do not add dynamic properties, identifiers, timestamps, URLs, project names, model names, or user-provided values.
