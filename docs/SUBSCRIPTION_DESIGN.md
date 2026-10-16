# Subscription & Billing — Design for Later (DEFERRED)

**Status:** Subscriptions are **removed from the product** as of 2026-10-13 (UI page, nav item, `/api/subscription`, `subscription_plans`, `tenant_subscriptions`, trial auto-creation). This document is the blueprint to add them later **without touching business modules**.

## 1. Why this is safe to defer
The only things business code needs from billing are *"may this tenant do X?"* and *"record that X happened"*. We keep exactly one seam for both, so billing becomes an additive module.

### The seam (built now, tiny)
```ts
// platform/entitlements.ts
interface EntitlementService {
  can(tenantId, feature: Feature): Promise<boolean>;             // boolean features: api_access, sso, automation, ai_copilot…
  limit(tenantId, metric: Metric): Promise<number | 'unlimited'>; // numeric caps: seats, leads, properties, automation_rules, api_rps
  assertWithin(tenantId, metric, requested: number): Promise<void>; // throws AppError('ENTITLEMENT_EXCEEDED', 402)
}
// default implementation today: everything allowed / unlimited
```
Rule: **no module reads plan tables or hard-codes limits.** Every creation path (invite member, create lead, create rule, create API key…) calls `assertWithin`. Today it is a no-op; later it is real.

## 2. Domain model to add later (new migration, forward-only)
```
plans(id, code, name, interval, price_minor, currency, active, version)
plan_entitlements(plan_id, key, value_int, value_bool)        -- data-driven: no code change to retune a plan
prices(id, plan_id, provider, provider_price_id, currency, amount_minor, interval)
customers(tenant_id PK, provider, provider_customer_id, billing_email, tax_id, billing_address jsonb)
subscriptions(id, tenant_id UNIQUE, plan_id, status, period_start, period_end, trial_end,
              cancel_at_period_end, provider_subscription_id UNIQUE, seats)
invoices(id, tenant_id, provider_invoice_id UNIQUE, status, amount_minor, currency, hosted_url, period)
usage_counters(tenant_id, metric, period, value)               -- seats, leads, api_calls, messages, ai_tokens
usage_events(id, tenant_id, metric, qty, occurred_at, idempotency_key UNIQUE)   -- metering source of truth
billing_events(provider, provider_event_id UNIQUE, payload, processed_at)       -- webhook inbox (idempotent)
tenant_overrides(tenant_id, key, value, reason, expires_at)    -- support/enterprise exceptions, audited
```
Tenant lifecycle states: `trialing → active → past_due → (grace) → suspended(read-only) → canceled → deleted(after retention)`.
`suspended` is enforced centrally (middleware sets `ctx.readOnly`), not per module.

## 3. Provider choice (India-first)
- **Razorpay Subscriptions** (UPI AutoPay / cards / e-mandate, INR, GST invoices) for domestic; **Stripe Billing** for international. Hide behind `BillingProvider` interface (`createCustomer, createCheckout, changePlan, cancel, portalUrl, parseWebhook`).
- Never store card data (hosted checkout / portal only → PCI SAQ-A).
- GST: collect GSTIN, place-of-supply, issue tax invoice; keep invoices 8 years.

## 4. Flows
1. **Signup → trial** (14 d, no card) → `subscriptions(status=trialing)`; reminder emails at T-3, T-1; auto-downgrade/suspend at expiry (policy decision).
2. **Upgrade/downgrade**: proration by provider; downgrade blocked if usage > new limits (return which limits, let admin fix) — enforced in `changePlan` using `usage_counters`.
3. **Webhooks** `/hooks/billing/{provider}`: verify signature on raw body → insert `billing_events` (unique provider_event_id) → worker applies state machine idempotently → emits `billing.subscription.updated`.
4. **Dunning**: retries per provider settings; `past_due` banner + email; 7-day grace then `suspended` (read-only, exports allowed).
5. **Metering**: services call `usage.record(tenant, metric, qty, idemKey)` inside the business TX (outbox pattern) → rolled into `usage_counters` by worker; plan limits read counters (cached ≤60 s) except hard security limits (seats) which count live.
6. **Enterprise**: manual invoices via `tenant_overrides` + `plan=enterprise`, no provider subscription.

## 5. API / UI to add later
- `GET /api/v1/billing` (plan, usage vs limits, invoices), `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/change-plan`; permissions `billing:read|manage` → owner/admin.
- UI: Settings → Billing (plan card, usage meters, invoices, upgrade dialog); soft-limit banners at 80/100 %; 402 handler that opens upgrade dialog.
- Public API: `402 Payment Required` problem type `entitlement-exceeded` with `limit`, `current`, `upgradeUrl`.

## 6. Security / compliance checklist
Provider webhook signature + replay window · idempotent processing · no PAN storage · audit every plan/override change · separate `platform_admin` role for overrides · DPDP/GST retention rules · test with provider sandbox, mark live `BLOCKED` until keys.

## 7. Migration/rollout plan when approved
1. Add tables (forward migration) and `DbEntitlementService` behind env flag `BILLING_ENABLED=false`.
2. Seed plans (data, not code); backfill every existing tenant to `internal` plan with unlimited entitlements.
3. Ship provider adapter + webhooks in shadow mode (log only) → compare with provider dashboard.
4. Enable enforcement per tenant via `tenant_overrides` (canary), then globally.
5. Turn on checkout for new signups last.

## 8. What was removed (for reference)
`server/src/routes/subscription.ts`, `src/pages/settings/SubscriptionPage.tsx`, nav + route, `subscription_plans`/`tenant_subscriptions` tables and seed rows, `app.create_trial_subscription()`. History remains in git (`a9363b9` and earlier).
