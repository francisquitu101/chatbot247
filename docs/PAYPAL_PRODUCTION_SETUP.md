# PayPal Pro production setup

The Pro checkout is a recurring PayPal Subscriptions plan. The server verifies that the configured plan is active and charges exactly **US$6.90 every month** before it creates a subscription. It activates access only after PayPal confirms an active subscription, either through the authenticated return flow or a signature-verified webhook.

## 1. Create the live PayPal plan

In the PayPal **Live** app, create a product and an active billing plan with exactly one regular billing cycle:

- Frequency: every 1 month
- Fixed price: USD 6.90
- Total cycles: unlimited
- No trial cycle

Copy the plan ID (`P-...`). The checkout function checks the plan settings with PayPal and refuses to start checkout if the plan is inactive or does not match these terms.

## 2. Register the webhook

Register this callback URL with the same Live PayPal app:

`https://osykwhhsvxbcaldczrdd.supabase.co/functions/v1/paypal-webhook`

Subscribe to these events:

- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.EXPIRED`
- `PAYMENT.SALE.COMPLETED`

Save the webhook ID from PayPal (`WH-...`). The webhook endpoint verifies each event against PayPal before changing subscription or profile data. PayPal retries processing errors; event IDs are recorded so duplicate deliveries do not reapply changes.

## 3. Configure Supabase Edge Function secrets

In the Supabase project's **Edge Functions → Secrets** settings, set these values using the Live credentials from the PayPal Live app:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_API_URL` = `https://api-m.paypal.com`
- `PAYPAL_PLAN_ID` = the Live `P-...` plan ID
- `PAYPAL_WEBHOOK_ID` = the Live `WH-...` webhook ID
- `VITE_APP_BASE_URL` = the production HTTPS site URL

The local `.env` file is not automatically available to deployed Edge Functions. Do not upload the whole `.env` file: it contains unrelated secrets. Keep the PayPal secret in Supabase's secret store, never in a `VITE_` variable or browser code. For local Edge Function testing, use the PayPal Sandbox app, Sandbox plan, Sandbox webhook ID, and `https://api-m.sandbox.paypal.com`.

If testing Edge Functions locally, put only the Sandbox PayPal values and `VITE_APP_BASE_URL` in the ignored `.env.paypal.local` file, then run `supabase functions serve --env-file .env.paypal.local`. Do not point local tests at Live credentials unless you intend to create real subscriptions.

## 4. Apply and deploy

From the repository root, after confirming the linked Supabase project:

```powershell
& "$env:LOCALAPPDATA\Programs\chatbot247-tools\supabase\supabase.exe" db push
& "$env:LOCALAPPDATA\Programs\chatbot247-tools\supabase\supabase.exe" functions deploy create-checkout
& "$env:LOCALAPPDATA\Programs\chatbot247-tools\supabase\supabase.exe" functions deploy confirm-paypal-subscription
& "$env:LOCALAPPDATA\Programs\chatbot247-tools\supabase\supabase.exe" functions deploy paypal-webhook
& "$env:LOCALAPPDATA\Programs\chatbot247-tools\supabase\supabase.exe" functions deploy manage-watchlist
```

Review the migration and target project before applying `db push`. This repository does not deploy migrations or functions automatically.

## Plan behavior

- Free accounts may save up to 3 tickers.
- Active Pro subscriptions may save up to 10 tickers.
- The database enforces the limit for Edge Function and direct authenticated API writes.
- Failed, suspended, cancelled, or expired subscriptions do not grant Pro access. Existing one-time Pro entitlements are retained as legacy access.
- The recurring US$6.90 charge renews monthly until cancelled. Subscription cancellation must be performed from the subscriber's PayPal account for now; the app reflects cancellation and payment-failure webhook events.
