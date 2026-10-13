import {
  createBackendClient,
  requireAuthenticatedUser,
} from "../_shared/supabase.ts";
import {
  errorResponse,
  handleOptions,
  ok,
  readJson,
} from "../_shared/response.ts";
import {
  getPayPalAccessToken,
  getPayPalApiUrl,
} from "../_shared/paypal.ts";

const PAYPAL_TIMEOUT_MS = 15_000;

type PayPalSubscription = {
  status?: unknown;
  plan_id?: unknown;
  custom_id?: unknown;
  billing_info?: {
    next_billing_time?: unknown;
  };
};

function mapSubscriptionStatus(status: unknown): string | null {
  switch (status) {
    case "APPROVAL_PENDING":
      return "approval_pending";
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "suspended";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      return null;
  }
}

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405, request);
  }

  try {
    const user = await requireAuthenticatedUser(request);
    const body = await readJson(request);
    const subscriptionId = typeof body?.subscription_id === "string"
      ? body.subscription_id.trim()
      : "";
    if (!/^[A-Z0-9-]{1,64}$/i.test(subscriptionId)) {
      return errorResponse(
        "INVALID_SUBSCRIPTION_ID",
        "A valid PayPal subscription ID is required.",
        400,
        request,
      );
    }

    const client = createBackendClient("service_role");
    const { data: storedSubscription, error: lookupError } = await client
      .from("pro_subscriptions")
      .select("user_id, paypal_plan_id")
      .eq("paypal_subscription_id", subscriptionId)
      .maybeSingle();
    if (lookupError) {
      console.error(JSON.stringify({
        event: "paypal_subscription_lookup_failed",
        code: lookupError.code ?? "SUBSCRIPTION_LOOKUP_FAILED",
      }));
      return errorResponse(
        "SUBSCRIPTION_LOOKUP_FAILED",
        "Unable to verify this subscription.",
        500,
        request,
      );
    }
    if (!storedSubscription || storedSubscription.user_id !== user.id) {
      return errorResponse(
        "SUBSCRIPTION_NOT_FOUND",
        "This subscription does not belong to the signed-in user.",
        404,
        request,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
    let response: Response;
    try {
      const accessToken = await getPayPalAccessToken();
      response = await fetch(
        `${getPayPalApiUrl()}/v1/billing/subscriptions/${
          encodeURIComponent(subscriptionId)
        }`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      console.error(JSON.stringify({
        event: "paypal_subscription_verification_failed",
        status: response.status,
      }));
      return errorResponse(
        "SUBSCRIPTION_VERIFICATION_FAILED",
        "PayPal could not confirm the subscription.",
        502,
        request,
      );
    }

    const subscription = await response.json() as PayPalSubscription;
    if (
      subscription.custom_id !== user.id ||
      subscription.plan_id !== storedSubscription.paypal_plan_id
    ) {
      console.error(JSON.stringify({
        event: "paypal_subscription_ownership_mismatch",
        subscription_id: subscriptionId,
      }));
      return errorResponse(
        "SUBSCRIPTION_VERIFICATION_FAILED",
        "The PayPal subscription does not match this account or plan.",
        409,
        request,
      );
    }

    const status = mapSubscriptionStatus(subscription.status);
    if (!status) {
      return errorResponse(
        "SUBSCRIPTION_STATUS_INVALID",
        "PayPal returned an unsupported subscription status.",
        502,
        request,
      );
    }
    const nextBillingTime = subscription.billing_info?.next_billing_time;
    const currentPeriodEnd = typeof nextBillingTime === "string" &&
        Number.isFinite(Date.parse(nextBillingTime))
      ? new Date(nextBillingTime).toISOString()
      : null;

    const { error: syncError } = await client.rpc(
      "apply_paypal_subscription_event",
      {
        p_event_id: null,
        p_subscription_id: subscriptionId,
        p_event_type: "CLIENT_CONFIRMATION",
        p_status: status,
        p_event_at: null,
        p_current_period_end: currentPeriodEnd,
      },
    );
    if (syncError) {
      console.error(JSON.stringify({
        event: "paypal_subscription_sync_failed",
        code: syncError.code ?? "SUBSCRIPTION_SYNC_FAILED",
      }));
      return errorResponse(
        "SUBSCRIPTION_SYNC_FAILED",
        "PayPal confirmed the subscription, but Pro access could not be updated yet.",
        500,
        request,
      );
    }

    return ok({ status }, request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "CONFIRMATION_FAILED";
    if (code === "AUTHORIZATION_REQUIRED" || code === "INVALID_ACCESS_TOKEN") {
      return errorResponse(
        "UNAUTHORIZED",
        "A valid Supabase access token is required.",
        401,
        request,
      );
    }
    if (code === "BACKEND_CONFIG_MISSING") {
      return errorResponse(
        "BACKEND_CONFIG_MISSING",
        "The checkout backend is not configured.",
        500,
        request,
      );
    }
    if (
      code === "PAYPAL_CREDENTIALS_MISSING" ||
      code === "PAYPAL_API_URL_MISSING" ||
      code === "PAYPAL_API_URL_INVALID"
    ) {
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "The PayPal integration is not configured.",
        500,
        request,
      );
    }
    console.error(JSON.stringify({ event: "paypal_confirmation_failed", code }));
    return errorResponse(
      "SUBSCRIPTION_CONFIRMATION_FAILED",
      "Unable to confirm this subscription. Please try again.",
      500,
      request,
    );
  }
});
