import { createBackendClient } from "../_shared/supabase.ts";
import { handleOptions, jsonResponse } from "../_shared/response.ts";
import { isValidMercadoPagoSignature } from "../_shared/mercado-pago-signature.ts";

const MERCADO_PAGO_TIMEOUT_MS = 12_000;
const MAX_WEBHOOK_BODY_BYTES = 64_000;

type PaymentNotification = {
  type?: unknown;
  action?: unknown;
  data?: { id?: unknown };
};

type MercadoPagoPayment = {
  id?: unknown;
  status?: unknown;
  external_reference?: unknown;
  transaction_amount?: unknown;
  currency_id?: unknown;
};

function accepted(request: Request): Response {
  return jsonResponse({ received: true }, 200, request);
}

async function readNotification(
  request: Request,
): Promise<{ notification: PaymentNotification; paymentId: string } | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES
  ) return null;
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return null;
  }

  let notification: PaymentNotification;
  try {
    notification = JSON.parse(body) as PaymentNotification;
  } catch {
    return null;
  }

  const requestUrl = new URL(request.url);
  const queryPaymentId = requestUrl.searchParams.get("data.id");
  const bodyPaymentId = notification.data?.id;
  const paymentId = String(queryPaymentId ?? bodyPaymentId ?? "").trim();
  if (!/^\d+$/.test(paymentId)) return null;
  return { notification, paymentId };
}

async function fetchPayment(
  paymentId: string,
  accessToken: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MERCADO_PAGO_TIMEOUT_MS);
  try {
    return await fetch(
      `https://api.mercadopago.com/v1/payments/${
        encodeURIComponent(paymentId)
      }`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
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

  try {
    if (request.method !== "POST") {
      console.info(
        JSON.stringify({
          event: "mercado_pago_webhook_ignored",
          reason: "method_not_allowed",
        }),
      );
      return accepted(request);
    }

    const parsed = await readNotification(request);
    if (!parsed) {
      console.warn(
        JSON.stringify({
          event: "mercado_pago_webhook_ignored",
          reason: "invalid_notification",
        }),
      );
      return accepted(request);
    }
    if (parsed.notification.type !== "payment") return accepted(request);

    const secret = Deno.env.get("MP_WEBHOOK_SECRET");
    if (!secret) {
      console.error(
        JSON.stringify({
          event: "mercado_pago_webhook_failed",
          reason: "signature_secret_missing",
        }),
      );
      return accepted(request);
    }
    const signatureIsValid = await isValidMercadoPagoSignature(
      secret,
      request.headers.get("x-signature"),
      request.headers.get("x-request-id"),
      parsed.paymentId,
    );
    if (!signatureIsValid) {
      console.warn(
        JSON.stringify({
          event: "mercado_pago_webhook_ignored",
          reason: "invalid_signature",
        }),
      );
      return accepted(request);
    }

    const accessToken = Deno.env.get("MP_ACCESS_TOKEN");
    if (!accessToken) {
      console.error(
        JSON.stringify({
          event: "mercado_pago_webhook_failed",
          reason: "access_token_missing",
        }),
      );
      return accepted(request);
    }

    const paymentResponse = await fetchPayment(parsed.paymentId, accessToken);
    if (!paymentResponse.ok) {
      console.error(JSON.stringify({
        event: "mercado_pago_payment_lookup_failed",
        status: paymentResponse.status,
      }));
      return accepted(request);
    }

    const payment = await paymentResponse.json() as MercadoPagoPayment;
    if (
      String(payment.id ?? "") !== parsed.paymentId ||
      payment.status !== "approved" ||
      typeof payment.external_reference !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(payment.external_reference) ||
      typeof payment.transaction_amount !== "number" ||
      typeof payment.currency_id !== "string"
    ) {
      console.info(
        JSON.stringify({ event: "mercado_pago_payment_not_eligible" }),
      );
      return accepted(request);
    }

    const client = createBackendClient("service_role");
    const { error } = await client.rpc("complete_pro_order", {
      p_order_id: payment.external_reference,
      p_payment_id: parsed.paymentId,
      p_amount: payment.transaction_amount,
      p_currency_id: payment.currency_id,
    });
    if (error) {
      console.error(JSON.stringify({
        event: "mercado_pago_order_completion_failed",
        code: error.code ?? "ORDER_COMPLETION_FAILED",
      }));
      return accepted(request);
    }

    console.info(JSON.stringify({ event: "mercado_pago_order_completed" }));
    return accepted(request);
  } catch (error) {
    console.error(JSON.stringify({
      event: "mercado_pago_webhook_failed",
      code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    }));
    return accepted(request);
  }
});
