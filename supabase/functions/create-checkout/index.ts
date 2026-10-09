import {
  createBackendClient,
  requireAuthenticatedUser,
} from "../_shared/supabase.ts";
import { errorResponse, handleOptions, ok } from "../_shared/response.ts";

const CHECKOUT_AMOUNT = 49.9;
const CHECKOUT_TITLE = "MarketMole Pro - Lifetime Access";
const MERCADO_PAGO_TIMEOUT_MS = 15_000;

type MercadoPagoPreference = {
  id?: unknown;
  init_point?: unknown;
};

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405, request);
  }

  try {
    const user = await requireAuthenticatedUser(request);
    const accessToken = Deno.env.get("MP_ACCESS_TOKEN");
    if (!accessToken) {
      console.error(
        JSON.stringify({
          event: "checkout_configuration_error",
          code: "MP_ACCESS_TOKEN_MISSING",
        }),
      );
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "Checkout is not configured.",
        500,
        request,
      );
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(
        Deno.env.get("VITE_APP_BASE_URL") || "http://localhost:5173",
      );
      if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
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

    const orderId = crypto.randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      MERCADO_PAGO_TIMEOUT_MS,
    );
    let preferenceResponse: Response;
    try {
      preferenceResponse = await fetch(
        "https://api.mercadopago.com/checkout/preferences",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            items: [{
              title: CHECKOUT_TITLE,
              unit_price: CHECKOUT_AMOUNT,
              quantity: 1,
              currency_id: "USD",
            }],
            external_reference: orderId,
            back_urls: {
              success: new URL("/checkout/success", baseUrl).toString(),
              failure: new URL("/checkout/failure", baseUrl).toString(),
              pending: new URL("/checkout/pending", baseUrl).toString(),
            },
            auto_return: "approved",
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      const code = error instanceof DOMException && error.name === "AbortError"
        ? "MERCADO_PAGO_TIMEOUT"
        : "MERCADO_PAGO_UNAVAILABLE";
      console.error(
        JSON.stringify({ event: "checkout_preference_failed", code }),
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

    if (!preferenceResponse.ok) {
      console.error(JSON.stringify({
        event: "checkout_preference_rejected",
        status: preferenceResponse.status,
      }));
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "Unable to start checkout. Please try again.",
        502,
        request,
      );
    }

    const preference = await preferenceResponse.json() as MercadoPagoPreference;
    if (
      typeof preference.id !== "string" ||
      typeof preference.init_point !== "string"
    ) {
      console.error(
        JSON.stringify({ event: "checkout_preference_invalid_response" }),
      );
      return errorResponse(
        "CHECKOUT_PROVIDER_ERROR",
        "The checkout provider returned an invalid response.",
        502,
        request,
      );
    }

    const client = createBackendClient("service_role");
    const { error: orderError } = await client
      .from("orders")
      .insert({
        id: orderId,
        user_id: user.id,
        mp_preference_id: preference.id,
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

    return ok({
      init_point: preference.init_point,
      preference_id: preference.id,
    }, request);
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
        JSON.stringify({ event: "checkout_configuration_error", code }),
      );
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "Checkout is not configured.",
        500,
        request,
      );
    }
    console.error(JSON.stringify({ event: "checkout_failed", code }));
    return errorResponse(
      "CHECKOUT_FAILED",
      "Unable to start checkout. Please try again.",
      500,
      request,
    );
  }
});
