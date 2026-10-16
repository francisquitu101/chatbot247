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
  getPayPalClientId,
  getPayPalPlanId,
} from "../_shared/paypal.ts";

const PAYPAL_TIMEOUT_MS = 15_000;

type PayPalSubscription = {
  id?: unknown;
  status?: unknown;
  plan_id?: unknown;
  custom_id?: unknown;
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

function getApprovalUrl(subscription: PayPalSubscription): string | null {
  const approvalUrl = subscription.links?.find((link) =>
    link.rel === "approve"
  )?.href;
  if (typeof approvalUrl !== "string") return null;

  try {
    const parsedUrl = new URL(approvalUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      parsedUrl.protocol === "https:" &&
      (hostname === "paypal.com" || hostname.endsWith(".paypal.com"))
    ) {
      return approvalUrl;
    }
  } catch {
    return null;
  }
  return null;
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
    const clientId = getPayPalClientId();
    const client = createBackendClient("service_role");
    const body = await readJson(request);
    if (body?.subscription_id !== undefined) {
      const subscriptionId = typeof body.subscription_id === "string"
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

      const { data: recordedSubscription, error: recordedLookupError } =
        await client
          .from("pro_subscriptions")
          .select("user_id, paypal_plan_id, status")
          .eq("paypal_subscription_id", subscriptionId)
          .maybeSingle();
      if (recordedLookupError) {
        console.error(JSON.stringify({
          event: "paypal_subscription_lookup_failed",
          code: recordedLookupError.code ?? "SUBSCRIPTION_LOOKUP_FAILED",
        }));
        return errorResponse(
          "CHECKOUT_ERROR",
          "Unable to verify this PayPal subscription.",
          500,
          request,
        );
      }
      if (recordedSubscription) {
        if (
          recordedSubscription.user_id === user.id &&
          recordedSubscription.paypal_plan_id === planId
        ) {
          return ok({
            subscription_id: subscriptionId,
            status: recordedSubscription.status,
          }, request);
        }
        return errorResponse(
          "SUBSCRIPTION_OWNERSHIP_MISMATCH",
          "This PayPal subscription is already linked to another account.",
          409,
          request,
        );
      }

      let subscriptionResponse: Response;
      const accessToken = await getPayPalAccessToken();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
      try {
        subscriptionResponse = await fetch(
          `${apiUrl}/v1/billing/subscriptions/${
            encodeURIComponent(subscriptionId)
          }`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          },
        );
      } catch (error) {
        const code = error instanceof DOMException &&
            error.name === "AbortError"
          ? "PAYPAL_TIMEOUT"
          : error instanceof Error
          ? error.message
          : "PAYPAL_UNAVAILABLE";
        console.error(JSON.stringify({
          event: "paypal_subscription_registration_lookup_failed",
          code,
        }));
        return errorResponse(
          "CHECKOUT_PROVIDER_ERROR",
          "Unable to verify the PayPal subscription. Please try again.",
          502,
          request,
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!subscriptionResponse.ok) {
        console.error(JSON.stringify({
          event: "paypal_subscription_registration_lookup_failed",
          status: subscriptionResponse.status,
        }));
        return errorResponse(
          "CHECKOUT_PROVIDER_ERROR",
          "Unable to verify the PayPal subscription. Please try again.",
          502,
          request,
        );
      }

      const subscription = await subscriptionResponse.json() as PayPalSubscription;
      if (
        subscription.id !== subscriptionId ||
        subscription.custom_id !== user.id ||
        subscription.plan_id !== planId ||
        !["APPROVAL_PENDING", "ACTIVE"].includes(String(subscription.status))
      ) {
        console.error(JSON.stringify({
          event: "paypal_subscription_registration_mismatch",
        }));
        return errorResponse(
          "SUBSCRIPTION_VERIFICATION_FAILED",
          "The PayPal subscription does not match this account or plan.",
          409,
          request,
        );
      }

      const { error: insertError } = await client
        .from("pro_subscriptions")
        .insert({
          user_id: user.id,
          paypal_subscription_id: subscriptionId,
          paypal_plan_id: planId,
          status: subscription.status === "ACTIVE"
            ? "active"
            : "approval_pending",
        });
      if (insertError) {
        const { data: racedSubscription } = await client
          .from("pro_subscriptions")
          .select("user_id, paypal_plan_id, status")
          .eq("paypal_subscription_id", subscriptionId)
          .maybeSingle();
        if (
          racedSubscription?.user_id === user.id &&
          racedSubscription.paypal_plan_id === planId
        ) {
          return ok({
            subscription_id: subscriptionId,
            status: racedSubscription.status,
          }, request);
        }

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

      return ok({
        subscription_id: subscriptionId,
        status: subscription.status === "ACTIVE" ? "active" : "approval_pending",
      }, request);
    }

    const { data: existingSubscription, error: existingError } = await client
      .from("pro_subscriptions")
      .select("paypal_subscription_id, paypal_plan_id, status")
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
      if (existingSubscription.status === "approval_pending") {
        const accessToken = await getPayPalAccessToken();
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          PAYPAL_TIMEOUT_MS,
        );
        let subscriptionResponse: Response;
        try {
          subscriptionResponse = await fetch(
            `${apiUrl}/v1/billing/subscriptions/${
              encodeURIComponent(existingSubscription.paypal_subscription_id)
            }`,
            {
              headers: { Authorization: "Bearer " + accessToken },
              signal: controller.signal,
            },
          );
        } catch (error) {
          const code = error instanceof DOMException &&
              error.name === "AbortError"
            ? "PAYPAL_TIMEOUT"
            : error instanceof Error
            ? error.message
            : "PAYPAL_UNAVAILABLE";
          console.error(JSON.stringify({
            event: "paypal_pending_subscription_lookup_failed",
            code,
          }));
          return errorResponse(
            "CHECKOUT_PROVIDER_ERROR",
            "Unable to resume your pending PayPal approval. Please try again.",
            502,
            request,
          );
        } finally {
          clearTimeout(timeout);
        }

        if (!subscriptionResponse.ok) {
          console.error(JSON.stringify({
            event: "paypal_pending_subscription_lookup_failed",
            status: subscriptionResponse.status,
          }));
          return errorResponse(
            "CHECKOUT_PROVIDER_ERROR",
            "Unable to resume your pending PayPal approval. Please try again.",
            502,
            request,
          );
        }

        const subscription = await subscriptionResponse.json() as PayPalSubscription;
        if (
          subscription.custom_id !== user.id ||
          subscription.plan_id !== existingSubscription.paypal_plan_id ||
          subscription.plan_id !== planId
        ) {
          console.error(JSON.stringify({
            event: "paypal_pending_subscription_ownership_mismatch",
          }));
          return errorResponse(
            "SUBSCRIPTION_VERIFICATION_FAILED",
            "The pending PayPal subscription does not match this account or plan.",
            409,
            request,
          );
        }

        if (subscription.status === "APPROVAL_PENDING") {
          const approvalUrl = getApprovalUrl(subscription);
          if (approvalUrl) return ok({ approval_url: approvalUrl }, request);
        }

        console.error(JSON.stringify({
          event: "paypal_pending_subscription_not_resumable",
          status: subscription.status ?? "UNKNOWN",
        }));
        return errorResponse(
          "SUBSCRIPTION_EXISTS",
          "A PayPal subscription is already in progress or has changed status. Check your PayPal account before starting another checkout.",
          409,
          request,
        );
      }

      return errorResponse(
        "SUBSCRIPTION_EXISTS",
        "You already have a Pro subscription in progress.",
        409,
        request,
      );
    }

    const accessToken = await getPayPalAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
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

      return ok({
        client_id: clientId,
        plan_id: planId,
      }, request);
    } catch (error) {
      const code = error instanceof DOMException && error.name === "AbortError"
        ? "PAYPAL_TIMEOUT"
        : error instanceof Error
        ? error.message
        : "PAYPAL_UNAVAILABLE";
      console.error(JSON.stringify({
        event: "paypal_checkout_preparation_failed",
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
      code === "PAYPAL_CLIENT_ID_MISSING" ||
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
