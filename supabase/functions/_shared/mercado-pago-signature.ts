function hexToBytes(value: string): Uint8Array | null {
  if (!/^[\da-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function isValidMercadoPagoSignature(
  secret: string,
  signatureHeader: string | null,
  requestId: string | null,
  paymentId: string,
): Promise<boolean> {
  if (!signatureHeader || !requestId) return false;
  const values = new Map(
    signatureHeader.split(",").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? ["", ""]
        : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }),
  );
  const timestamp = values.get("ts");
  const providedHash = values.get("v1");
  if (!timestamp || !/^\d+$/.test(timestamp) || !providedHash) return false;
  const expectedBytes = hexToBytes(providedHash);
  if (!expectedBytes) return false;

  const manifest =
    `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)),
  );
  return equalBytes(signature, expectedBytes);
}
