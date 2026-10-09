import { isValidMercadoPagoSignature } from "./mercado-pago-signature.ts";

const TEST_SECRET = "test-webhook-secret";
const TEST_PAYMENT_ID = "123456789";
const TEST_REQUEST_ID = "request-id-123";
const TEST_TIMESTAMP = "1704908010";

async function makeSignature(
  secret: string,
  requestId: string,
  paymentId: string,
  timestamp: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const manifest =
    `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("verifies Mercado Pago HMAC signature", async () => {
  const hash = await makeSignature(
    TEST_SECRET,
    TEST_REQUEST_ID,
    TEST_PAYMENT_ID,
    TEST_TIMESTAMP,
  );
  const valid = await isValidMercadoPagoSignature(
    TEST_SECRET,
    `ts=${TEST_TIMESTAMP},v1=${hash}`,
    TEST_REQUEST_ID,
    TEST_PAYMENT_ID,
  );
  if (!valid) {
    throw new Error("Expected a valid Mercado Pago signature to pass");
  }
});

Deno.test("rejects altered Mercado Pago signature manifest", async () => {
  const hash = await makeSignature(
    TEST_SECRET,
    TEST_REQUEST_ID,
    TEST_PAYMENT_ID,
    TEST_TIMESTAMP,
  );
  const valid = await isValidMercadoPagoSignature(
    TEST_SECRET,
    `ts=${TEST_TIMESTAMP},v1=${hash}`,
    "different-request-id",
    TEST_PAYMENT_ID,
  );
  if (valid) {
    throw new Error(
      "Expected a modified request ID to fail signature verification",
    );
  }
});

Deno.test("rejects malformed Mercado Pago signature", async () => {
  const valid = await isValidMercadoPagoSignature(
    TEST_SECRET,
    `ts=${TEST_TIMESTAMP},v1=not-a-hex-signature`,
    TEST_REQUEST_ID,
    TEST_PAYMENT_ID,
  );
  if (valid) {
    throw new Error("Expected malformed signature to fail verification");
  }
});
