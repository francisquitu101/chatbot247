import { createBackendClient } from "../_shared/supabase.ts";
import {
  errorResponse,
  handleOptions,
  ok,
} from "../_shared/response.ts";
import {
  getPayPalAccessToken,
  getPayPalApiUrl,
} from "../_shared/paypal.ts";

const PAYPAL_TIMEOUT_MS = 15_000;

type PayPalWebhookEvent = {
  id?: unknown;
  event_type?: unknown;
  create_time?: unknown;
  resource?: {
    id?: unknown;
    plan_id?: unknown;
    custom_id?: unknown;
    billing_agreement_id?: unknown;
    billing_info?: {
      next_billing_time?: unknown;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function subscriptionEvent(
  eventType: string,
): { status: string; subscriptionIdField: "id" | "billing_agreement_id" } | null {
  switch (eventType) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      return { status: "active", subscriptionIdField: "id" };
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      return { status: "suspended", subscriptionIdField: "id" };
    case "BILLING.SUBSCRIPTION.CANCELLED":
      return { status: "cancelled", subscriptionIdField: "id" };
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return { status: "expired", subscriptionIdField: "id" };
    case "PAYMENT.SALE.COMPLETED":
      return { status: "active", subscriptionIdField: "billing_agreement_id" };
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
    const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID");
    if (!webhookId) {
      console.error(JSON.stringify({
        event: "paypal_webhook_configuration_error",
        code: "PAYPAL_WEBHOOK_ID_MISSING",
      }));
      return errorResponse(
        "WEBHOOK_NOT_CONFIGURED",
        "The PayPal webhook is not configured.",
        500,
        request,
      );
    }

    const webhookEvent: unknown = await request.json().catch(() => null);
    if (!isRecord(webhookEvent)) {
      return errorResponse(
        "INVALID_WEBHOOK_EVENT",
        "PayPal must send a valid event payload.",
        400,
        request,
      );
    }

    const requiredHeaders = {
      auth_algo: request.headers.get("paypal-auth-algo"),
      cert_url: request.headers.get("paypal-cert-url"),
      transmission_id: request.headers.get("paypal-transmission-id"),
      transmission_sig: request.headers.get("paypal-transmission-sig"),
      transmission_time: request.headers.get("paypal-transmission-time"),
    };
    if (Object.values(requiredHeaders).some((value) => !value)) {
      return errorResponse(
        "WEBHOOK_SIGNATURE_MISSING",
        "PayPal signature headers are required.",
        400,
        request,
      );
    }

    const apiUrl = getPayPalApiUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
    let response: Response;
    try {
      const accessToken = await getPayPalAccessToken();
      response = await fetch(
        `${apiUrl}/v1/notifications/verify-webhook-signature`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...requiredHeaders,
            webhook_id: webhookId,
            webhook_event: webhookEvent,
          }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.error(JSON.stringify({
        event: "paypal_webhook_verification_request_failed",
        status: response.status,
      }));
      return errorResponse(
        "WEBHOOK_VERIFICATION_FAILED",
        "Unable to verify the PayPal event.",
        502,
        request,
      );
    }

    const verification: unknown = await response.json();
    if (!isRecord(verification) || verification.verification_status !== "SUCCESS") {
      return errorResponse(
        "WEBHOOK_SIGNATURE_INVALID",
        "The PayPal event signature is invalid.",
        401,
        request,
      );
    }

    const event = webhookEvent as PayPalWebhookEvent;
    const eventId = typeof event.id === "string" ? event.id : "";
    const eventType = typeof event.event_type === "string"
      ? event.event_type
      : "";
    const eventDetails = subscriptionEvent(eventType);
    if (!eventId || !eventDetails || !isRecord(event.resource)) {
      return ok({ received: true }, request);
    }

    const resource = event.resource;
    const subscriptionId = resource[eventDetails.subscriptionIdField];
    if (typeof subscriptionId !== "string" || !subscriptionId) {
      return ok({ received: true }, request);
    }

    const client = createBackendClient("service_role");
    const { data: storedSubscription, error: lookupError } = await client
      .from("pro_subscriptions")
      .select("user_id, paypal_plan_id")
      .eq("paypal_subscription_id", subscriptionId)
      .maybeSingle();
    if (lookupError) {
      console.error(JSON.stringify({
        event: "paypal_webhook_subscription_lookup_failed",
        code: lookupError.code ?? "SUBSCRIPTION_LOOKUP_FAILED",
      }));
      return errorResponse(
        "WEBHOOK_PROCESSING_FAILED",
        "Unable to process the PayPal event.",
        500,
        request,
      );
    }
    if (!storedSubscription) {
      return errorResponse(
        "WEBHOOK_SUBSCRIPTION_NOT_FOUND",
        "The subscription has not been recorded yet.",
        500,
        request,
      );
    }

    if (
      typeof resource.plan_id === "string" &&
      resource.plan_id !== storedSubscription.paypal_plan_id
    ) {
      return errorResponse(
        "WEBHOOK_PLAN_MISMATCH",
        "The PayPal event does not match the recorded plan.",
        400,
        request,
      );
    }
    if (
      typeof resource.custom_id === "string" &&
      resource.custom_id !== storedSubscription.user_id
    ) {
      return errorResponse(
        "WEBHOOK_ACCOUNT_MISMATCH",
        "The PayPal event does not match the recorded account.",
        400,
        request,
      );
    }

    const eventTime = typeof event.create_time === "string"
      ? Date.parse(event.create_time)
      : NaN;
    if (!Number.isFinite(eventTime)) {
      return errorResponse(
        "WEBHOOK_EVENT_TIME_INVALID",
        "PayPal sent an invalid event timestamp.",
        400,
        request,
      );
    }
    const nextBillingTime = resource.billing_info?.next_billing_time;
    const currentPeriodEnd = typeof nextBillingTime === "string" &&
        Number.isFinite(Date.parse(nextBillingTime))
      ? new Date(nextBillingTime).toISOString()
      : null;

    const { error: updateError } = await client.rpc(
      "apply_paypal_subscription_event",
      {
        p_event_id: eventId,
        p_subscription_id: subscriptionId,
        p_event_type: eventType,
        p_status: eventDetails.status,
        p_event_at: new Date(eventTime).toISOString(),
        p_current_period_end: currentPeriodEnd,
      },
    );
    if (updateError) {
      console.error(JSON.stringify({
        event: "paypal_webhook_subscription_update_failed",
        code: updateError.code ?? "SUBSCRIPTION_UPDATE_FAILED",
      }));
      return errorResponse(
        "WEBHOOK_PROCESSING_FAILED",
        "Unable to update the subscription.",
        500,
        request,
      );
    }

    return ok({ received: true }, request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "WEBHOOK_FAILED";
    if (
      code === "PAYPAL_CREDENTIALS_MISSING" ||
      code === "PAYPAL_API_URL_MISSING" ||
      code === "PAYPAL_API_URL_INVALID" ||
      code === "BACKEND_CONFIG_MISSING"
    ) {
      console.error(JSON.stringify({
        event: "paypal_webhook_configuration_error",
        code,
      }));
      return errorResponse(
        "WEBHOOK_NOT_CONFIGURED",
        "The PayPal webhook backend is not configured.",
        500,
        request,
      );
    }
    console.error(JSON.stringify({ event: "paypal_webhook_failed", code }));
    return errorResponse(
      "WEBHOOK_PROCESSING_FAILED",
      "Unable to process the PayPal event.",
      500,
      request,
    );
  }
});
