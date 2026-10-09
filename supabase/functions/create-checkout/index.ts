import {
  createBackendClient,
  requireAuthenticatedUser,
} from "../_shared/supabase.ts";
import { errorResponse, handleOptions, ok } from "../_shared/response.ts";
import { getPayPalAccessToken, getPayPalApiUrl } from "../_shared/paypal.ts";

const CHECKOUT_AMOUNT = "6.90";
const CHECKOUT_TITLE = "MarketMole Pro - 10 Tickers Watchlist & Advanced Charts";
const PAYPAL_TIMEOUT_MS = 15_000;

type PayPalOrder = {
  id?: unknown;
  links?: Array<{ href?: unknown; rel?: unknown }>;
};

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405, request);
  }

  try {
    const user = await requireAuthenticatedUser(request);
    const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
    const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      console.error(JSON.stringify({
        event: "paypal_checkout_configuration_error",
        code: "PAYPAL_CREDENTIALS_MISSING",
      }));
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "Checkout is not configured.",
        500,
        request,
      );
    }

    let appBaseUrl: URL;
    try {
      appBaseUrl = new URL(
        Deno.env.get("VITE_APP_BASE_URL") || "http://localhost:5173",
      );
      if (appBaseUrl.protocol !== "https:" && appBaseUrl.hostname !== "localhost" && appBaseUrl.hostname !== "127.0.0.1") {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
    let paypalOrderResponse: Response;
    try {
      const accessToken = await getPayPalAccessToken();
      paypalOrderResponse = await fetch(
        `${getPayPalApiUrl()}/v2/checkout/orders`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [{
              description: CHECKOUT_TITLE,
              amount: {
                currency_code: "USD",
                value: CHECKOUT_AMOUNT,
              },
            }],
            application_context: {
              return_url: new URL("/checkout/success", appBaseUrl).toString(),
              cancel_url: new URL("/checkout/failure", appBaseUrl).toString(),
              user_action: "PAY_NOW",
            },
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      const code = error instanceof DOMException && error.name === "AbortError"
        ? "PAYPAL_TIMEOUT"
        : "PAYPAL_UNAVAILABLE";
      console.error(
        JSON.stringify({ event: "paypal_order_creation_failed", code }),
      );
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "Unable to start checkout. Please try again.",
        502,
        request,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!paypalOrderResponse.ok) {
      const providerError = await paypalOrderResponse.text();
      console.error(JSON.stringify({
        event: "paypal_order_rejected",
        status: paypalOrderResponse.status,
        provider_error: providerError,
      }));
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "Unable to start checkout. Please try again.",
        502,
        request,
      );
    }

    const paypalOrder = await paypalOrderResponse.json() as PayPalOrder;
    const paypalOrderId = typeof paypalOrder.id === "string"
      ? paypalOrder.id
      : null;
    const approvalUrl = paypalOrder.links?.find((link) => link.rel === "approve")
      ?.href;
    if (paypalOrderId === null || typeof approvalUrl !== "string") {
      console.error(
        JSON.stringify({ event: "paypal_order_invalid_response" }),
      );
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "The payment provider returned an invalid checkout link.",
        502,
        request,
      );
    }

    const parsedApprovalUrl = new URL(approvalUrl);
    const approvalHost = parsedApprovalUrl.hostname.toLowerCase();
    if (
      parsedApprovalUrl.protocol !== "https:" ||
      !(approvalHost === "paypal.com" || approvalHost.endsWith(".paypal.com"))
    ) {
      console.error(
        JSON.stringify({ event: "paypal_order_invalid_approval_url" }),
      );
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "The payment provider returned an invalid checkout link.",
        502,
        request,
      );
    }

    const client = createBackendClient("service_role");
    const { error: orderError } = await client
      .from("orders")
      .insert({
        user_id: user.id,
        paypal_order_id: paypalOrderId,
        status: "pending",
        amount: CHECKOUT_AMOUNT,
      });
    if (orderError) {
      console.error(JSON.stringify({
        event: "checkout_order_insert_failed",
        code: orderError.code ?? "ORDER_INSERT_FAILED",
      }));
      return errorResponse(
        "CHECKOUT_ORDER_ERROR",
        "Unable to record the checkout. Please try again.",
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
      console.error(
        JSON.stringify({ event: "paypal_checkout_configuration_error", code }),
      );
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "Checkout is not configured.",
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
