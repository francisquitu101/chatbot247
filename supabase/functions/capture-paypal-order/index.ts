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
import { getPayPalAccessToken, getPayPalApiUrl } from "../_shared/paypal.ts";

const PAYPAL_TIMEOUT_MS = 15_000;

type PayPalCapture = {
  id?: unknown;
  status?: unknown;
  amount?: {
    currency_code?: unknown;
    value?: unknown;
  };
};

type PayPalOrder = {
  status?: unknown;
  purchase_units?: Array<{
    payments?: {
      captures?: PayPalCapture[];
    };
  }>;
};

function getCompletedCapture(order: PayPalOrder): PayPalCapture | null {
  if (order.status !== "COMPLETED") return null;
  for (const purchaseUnit of order.purchase_units ?? []) {
    const capture = purchaseUnit.payments?.captures?.find((item) =>
      item.status === "COMPLETED"
    );
    if (capture) return capture;
  }
  return null;
}

async function paypalRequest(
  orderId: string,
  accessToken: string,
  capture: boolean,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
  try {
    return await fetch(
      `${getPayPalApiUrl()}/v2/checkout/orders/${
        encodeURIComponent(orderId)
      }${capture ? "/capture" : ""}`,
      {
        method: capture ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(capture ? {
            "Content-Type": "application/json",
            Prefer: "return=representation",
            "PayPal-Request-Id": `marketmole-${orderId}`,
          } : {}),
        },
        ...(capture ? { body: "{}" } : {}),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
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
    const paypalOrderId = typeof body?.order_id === "string"
      ? body.order_id.trim()
      : "";
    if (!/^[A-Z0-9-]{1,64}$/i.test(paypalOrderId)) {
      return errorResponse(
        "INVALID_ORDER_ID",
        "A valid PayPal order ID is required.",
        400,
        request,
      );
    }

    const client = createBackendClient("service_role");
    const { data: order, error: orderLookupError } = await client
      .from("orders")
      .select("id, user_id, amount, status")
      .eq("paypal_order_id", paypalOrderId)
      .maybeSingle();
    if (orderLookupError) {
      console.error(JSON.stringify({
        event: "paypal_order_lookup_failed",
        code: orderLookupError.code ?? "ORDER_LOOKUP_FAILED",
      }));
      return errorResponse(
        "ORDER_LOOKUP_FAILED",
        "Unable to verify this checkout.",
        500,
        request,
      );
    }
    if (!order || order.user_id !== user.id) {
      return errorResponse(
        "ORDER_NOT_FOUND",
        "This checkout does not belong to the signed-in user.",
        404,
        request,
      );
    }
    if (order.status === "completed") return ok({ status: "completed" }, request);
    if (order.status !== "pending") {
      return errorResponse(
        "ORDER_NOT_PENDING",
        "This checkout cannot be captured.",
        409,
        request,
      );
    }

    const accessToken = await getPayPalAccessToken();
    let captureResponse = await paypalRequest(
      paypalOrderId,
      accessToken,
      true,
    );
    if (!captureResponse.ok) {
      const providerError = await captureResponse.text();
      console.warn(JSON.stringify({
        event: "paypal_capture_rejected_checking_order",
        status: captureResponse.status,
        provider_error: providerError,
      }));
      captureResponse = await paypalRequest(
        paypalOrderId,
        accessToken,
        false,
      );
    }
    if (!captureResponse.ok) {
      console.error(JSON.stringify({
        event: "paypal_capture_lookup_failed",
        status: captureResponse.status,
      }));
      return errorResponse(
        "PAYPAL_CAPTURE_FAILED",
        "PayPal could not confirm the payment capture.",
        502,
        request,
      );
    }

    const paypalOrder = await captureResponse.json() as PayPalOrder;
    const capture = getCompletedCapture(paypalOrder);
    const amount = capture?.amount;
    const amountValue = typeof amount?.value === "string"
      ? Number(amount.value)
      : NaN;
    if (
      typeof capture?.id !== "string" ||
      amount?.currency_code !== "USD" ||
      !Number.isFinite(amountValue) ||
      amountValue !== Number(order.amount)
    ) {
      console.error(JSON.stringify({
        event: "paypal_capture_not_eligible",
        order_id: paypalOrderId,
      }));
      return errorResponse(
        "PAYPAL_CAPTURE_NOT_COMPLETED",
        "PayPal has not confirmed the expected payment.",
        409,
        request,
      );
    }

    const { error: completionError } = await client.rpc(
      "complete_paypal_order",
      {
        p_order_id: order.id,
        p_capture_id: capture.id,
        p_amount: amountValue,
        p_currency_code: "USD",
      },
    );
    if (completionError) {
      console.error(JSON.stringify({
        event: "paypal_order_completion_failed",
        code: completionError.code ?? "ORDER_COMPLETION_FAILED",
      }));
      return errorResponse(
        "ORDER_COMPLETION_FAILED",
        "Payment was captured, but Pro access could not be activated yet.",
        500,
        request,
      );
    }

    return ok({ status: "completed" }, request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "CAPTURE_FAILED";
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
    if (code === "PAYPAL_CREDENTIALS_MISSING") {
      return errorResponse(
        "CHECKOUT_NOT_CONFIGURED",
        "Checkout is not configured.",
        500,
        request,
      );
    }
    console.error(JSON.stringify({ event: "paypal_capture_failed", code }));
    return errorResponse(
      "CAPTURE_FAILED",
      "Unable to confirm this payment. Please try again.",
      500,
      request,
    );
  }
});
