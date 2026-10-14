import {
  createBackendClient,
  requireAuthenticatedUser,
} from "../_shared/supabase.ts";
import {
  errorResponse,
  handleOptions,
  ok,
} from "../_shared/response.ts";
import {
  getPayPalAccessToken,
  getPayPalApiUrl,
  getPayPalPlanId,
} from "../_shared/paypal.ts";

const PAYPAL_TIMEOUT_MS = 15_000;

type PayPalSubscription = {
  id?: unknown;
  status?: unknown;
  links?: Array<{ href?: unknown; rel?: unknown }>;
};

type PayPalPlan = {
  status?: unknown;
  billing_cycles?: Array<{
    tenure_type?: unknown;
    total_cycles?: unknown;
    frequency?: {
      interval_unit?: unknown;
      interval_count?: unknown;
    };
    pricing_scheme?: {
      fixed_price?: {
        currency_code?: unknown;
        value?: unknown;
      };
    };
  }>;
};

function isMonthlyProPlan(plan: PayPalPlan): boolean {
  const billingCycle = plan.billing_cycles?.[0];
  const priceValue = billingCycle?.pricing_scheme?.fixed_price?.value;
  const price = typeof priceValue === "number"
    ? priceValue
    : typeof priceValue === "string" && /^\d+(?:\.\d{1,2})?$/.test(priceValue)
    ? Number(priceValue)
    : Number.NaN;

  return plan.status === "ACTIVE" &&
    plan.billing_cycles?.length === 1 &&
    billingCycle?.tenure_type === "REGULAR" &&
    billingCycle.total_cycles === 0 &&
    billingCycle.frequency?.interval_unit === "MONTH" &&
    billingCycle.frequency?.interval_count === 1 &&
    billingCycle.pricing_scheme?.fixed_price?.currency_code === "USD" &&
    Number.isFinite(price) &&
    price === 6.9;
}

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405, request);
  }

  try {
    const user = await requireAuthenticatedUser(request);
    const apiUrl = getPayPalApiUrl();
    const planId = getPayPalPlanId();

    let appBaseUrl: URL;
    try {
      appBaseUrl = new URL(
        Deno.env.get("VITE_APP_BASE_URL") || "http://localhost:5173",
      );
      if (
        appBaseUrl.protocol !== "https:" &&
        appBaseUrl.hostname !== "localhost" &&
        appBaseUrl.hostname !== "127.0.0.1"
      ) {
        throw new Error("INVALID_APP_BASE_URL");
      }
    } catch {
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "The checkout return URL is invalid.",
        500,
        request,
      );
    }

    const client = createBackendClient("service_role");
    const { data: existingSubscription, error: existingError } = await client
      .from("pro_subscriptions")
      .select("id")
      .eq("user_id", user.id)
      .in("status", ["approval_pending", "active", "suspended"])
      .limit(1)
      .maybeSingle();
    if (existingError) {
      console.error(JSON.stringify({
        event: "paypal_subscription_lookup_failed",
        code: existingError.code ?? "SUBSCRIPTION_LOOKUP_FAILED",
      }));
      return errorResponse(
        "CHECKOUT_ERROR",
        "Unable to check your current Pro plan.",
        500,
        request,
      );
    }
    if (existingSubscription) {
      return errorResponse(
        "SUBSCRIPTION_EXISTS",
        "You already have a Pro subscription awaiting approval or in progress.",
        409,
        request,
      );
    }

    const accessToken = await getPayPalAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
    let response: Response;
    try {
      const planResponse = await fetch(
        `${apiUrl}/v1/billing/plans/${encodeURIComponent(planId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        },
      );
      if (!planResponse.ok) {
        console.error(JSON.stringify({
          event: "paypal_plan_lookup_failed",
          status: planResponse.status,
        }));
        return errorResponse(
          "CHECKOUT_NOT_CONFIGURED",
          "The configured PayPal Pro plan could not be verified.",
          500,
          request,
        );
      }
      const plan = await planResponse.json() as PayPalPlan;
      if (!isMonthlyProPlan(plan)) {
        console.error(JSON.stringify({
          event: "paypal_plan_mismatch",
          plan_id: planId,
        }));
        return errorResponse(
          "CHECKOUT_NOT_CONFIGURED",
          "The PayPal plan must be active and charge US$6.90 every month.",
          500,
          request,
        );
      }

      response = await fetch(`${apiUrl}/v1/billing/subscriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          "PayPal-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          plan_id: planId,
          custom_id: user.id,
          application_context: {
            brand_name: "MarketMole",
            locale: "en-US",
            shipping_preference: "NO_SHIPPING",
            user_action: "SUBSCRIBE_NOW",
            payment_method: {
              payer_selected: "PAYPAL",
              payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
            },
            return_url: new URL("/checkout/success", appBaseUrl).toString(),
            cancel_url: new URL("/checkout/failure", appBaseUrl).toString(),
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const code = error instanceof DOMException && error.name === "AbortError"
        ? "PAYPAL_TIMEOUT"
        : error instanceof Error
        ? error.message
        : "PAYPAL_UNAVAILABLE";
      console.error(JSON.stringify({
        event: "paypal_subscription_creation_failed",
        code,
      }));
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "Unable to start checkout. Please try again.",
        502,
        request,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.error(JSON.stringify({
        event: "paypal_subscription_rejected",
        status: response.status,
      }));
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "Unable to start checkout. Please try again.",
        502,
        request,
      );
    }

    const subscription = await response.json() as PayPalSubscription;
    const subscriptionId = typeof subscription.id === "string"
      ? subscription.id
      : null;
    const approvalUrl = subscription.links?.find((link) =>
      link.rel === "approve"
    )?.href;
    if (subscriptionId === null || typeof approvalUrl !== "string") {
      console.error(JSON.stringify({
        event: "paypal_subscription_invalid_response",
      }));
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "The payment provider returned an invalid checkout link.",
        502,
        request,
      );
    }

    let parsedApprovalUrl: URL;
    try {
      parsedApprovalUrl = new URL(approvalUrl);
    } catch {
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "The payment provider returned an invalid checkout link.",
        502,
        request,
      );
    }
    const approvalHost = parsedApprovalUrl.hostname.toLowerCase();
    if (
      parsedApprovalUrl.protocol !== "https:" ||
      !(approvalHost === "paypal.com" || approvalHost.endsWith(".paypal.com"))
    ) {
      console.error(JSON.stringify({
        event: "paypal_subscription_invalid_approval_url",
      }));
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "The payment provider returned an invalid checkout link.",
        502,
        request,
      );
    }

    const { error: insertError } = await client
      .from("pro_subscriptions")
      .insert({
        user_id: user.id,
        paypal_subscription_id: subscriptionId,
        paypal_plan_id: planId,
        status: subscription.status === "ACTIVE" ? "active" : "approval_pending",
      });
    if (insertError) {
        const cancelController = new AbortController();
        const cancelTimeout = setTimeout(
          () => cancelController.abort(),
          PAYPAL_TIMEOUT_MS,
        );
        try {
          const cancelResponse = await fetch(
            `${apiUrl}/v1/billing/subscriptions/${
              encodeURIComponent(subscriptionId)
            }/cancel`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "PayPal-Request-Id": crypto.randomUUID(),
              },
              body: JSON.stringify({
                reason: "MarketMole could not record the subscription.",
              }),
              signal: cancelController.signal,
            },
          );
          if (!cancelResponse.ok) {
            console.error(JSON.stringify({
              event: "paypal_orphan_subscription_cancel_failed",
              status: cancelResponse.status,
            }));
          }
        } catch (cancelError) {
          console.error(JSON.stringify({
            event: "paypal_orphan_subscription_cancel_failed",
            code: cancelError instanceof Error
              ? cancelError.name
              : "CANCEL_FAILED",
          }));
        } finally {
          clearTimeout(cancelTimeout);
        }

        console.error(JSON.stringify({
          event: "paypal_subscription_record_failed",
          code: insertError.code ?? "SUBSCRIPTION_INSERT_FAILED",
      }));
      return errorResponse(
        "CHECKOUT_ERROR",
        "Unable to record the subscription. Please contact support before retrying.",
        500,
        request,
      );
    }

    return ok({ approval_url: approvalUrl }, request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "CHECKOUT_FAILED";
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
        "CHECKOUT_NOT_CONFIGURED",
        "The checkout backend is not configured.",
        500,
        request,
      );
    }
    if (
      code === "PAYPAL_CREDENTIALS_MISSING" ||
      code === "PAYPAL_API_URL_MISSING" ||
      code === "PAYPAL_API_URL_INVALID" ||
      code === "PAYPAL_PLAN_ID_INVALID"
    ) {
      console.error(JSON.stringify({
        event: "paypal_checkout_configuration_error",
        code,
      }));
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "The recurring Pro plan is not configured.",
        500,
        request,
      );
    }
    console.error(JSON.stringify({ event: "paypal_checkout_failed", code }));
    return errorResponse(
      "CHECKOUT_FAILED",
      "Unable to start checkout. Please try again.",
      500,
      request,
    );
  }
});
