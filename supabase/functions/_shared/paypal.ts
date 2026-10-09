const DEFAULT_PAYPAL_API_URL = "https://api-m.sandbox.paypal.com";
const PAYPAL_TIMEOUT_MS = 15_000;

export function getPayPalApiUrl(): string {
  const configuredUrl = Deno.env.get("PAYPAL_API_URL") || DEFAULT_PAYPAL_API_URL;
  const apiUrl = new URL(configuredUrl);
  if (
    apiUrl.protocol !== "https:" ||
    !["api-m.paypal.com", "api-m.sandbox.paypal.com"].includes(
      apiUrl.hostname.toLowerCase(),
    ) ||
    apiUrl.pathname !== "/" ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error("PAYPAL_API_URL_INVALID");
  }
  return apiUrl.origin;
}

export async function getPayPalAccessToken(): Promise<string> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CREDENTIALS_MISSING");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${getPayPalApiUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(JSON.stringify({
        event: "paypal_oauth_rejected",
        status: response.status,
        provider_error: await response.text(),
      }));
      throw new Error("PAYPAL_AUTHENTICATION_FAILED");
    }

    const payload: unknown = await response.json();
    if (
      !payload || typeof payload !== "object" ||
      !("access_token" in payload) ||
      typeof payload.access_token !== "string" ||
      payload.access_token.length === 0
    ) {
      throw new Error("PAYPAL_OAUTH_INVALID_RESPONSE");
    }
    return payload.access_token;
  } finally {
    clearTimeout(timeout);
  }
}
