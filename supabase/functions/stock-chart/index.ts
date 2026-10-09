import { errorResponse, handleOptions, ok, readJson } from "../_shared/response.ts";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const REQUEST_TIMEOUT_MS = 12_000;

type YahooChartResponse = {
  chart?: {
    error?: { description?: string | null } | null;
    result?: Array<{
      timestamp?: number[];
      meta?: { currency?: string };
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }> | null;
  };
};

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405, request);
  }

  const body = await readJson(request);
  const ticker = typeof body?.ticker === "string"
    ? body.ticker.trim().toUpperCase()
    : "";
  if (!/^[A-Z0-9.^=-]{1,20}$/.test(ticker)) {
    return errorResponse("INVALID_TICKER", "A valid ticker is required.", 400, request);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?range=6mo&interval=1d`,
      {
        headers: { "User-Agent": "MarketMole/1.0 (market data chart)" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      console.error(JSON.stringify({
        event: "stock_chart_provider_error",
        ticker,
        status: response.status,
      }));
      return errorResponse(
        "CHART_PROVIDER_ERROR",
        "Yahoo Finance could not load price history for this ticker.",
        502,
        request,
      );
    }

    const payload = await response.json() as YahooChartResponse;
    const result = payload.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp ?? [];
    if (payload.chart?.error || !quote) {
      return errorResponse(
        "CHART_DATA_UNAVAILABLE",
        payload.chart?.error?.description ?? "No price history is available for this ticker.",
        404,
        request,
      );
    }

    const candles = timestamps.flatMap((time, index) => {
      const open = quote.open?.[index];
      const high = quote.high?.[index];
      const low = quote.low?.[index];
      const close = quote.close?.[index];
      if (
        !Number.isInteger(time) ||
        typeof open !== "number" ||
        typeof high !== "number" ||
        typeof low !== "number" ||
        typeof close !== "number" ||
        ![open, high, low, close].every(Number.isFinite) ||
        high < low
      ) return [];
      return [{ time, open, high, low, close }];
    });
    if (candles.length === 0) {
      return errorResponse(
        "CHART_DATA_UNAVAILABLE",
        "No price history is available for this ticker.",
        404,
        request,
      );
    }

    return ok({ ticker, currency: result.meta?.currency ?? "USD", candles }, request);
  } catch (error) {
    const code = error instanceof DOMException && error.name === "AbortError"
      ? "YAHOO_FINANCE_TIMEOUT"
      : error instanceof Error
      ? error.message
      : "YAHOO_FINANCE_UNAVAILABLE";
    console.error(JSON.stringify({ event: "stock_chart_fetch_failed", ticker, code }));
    return errorResponse(
      "CHART_PROVIDER_ERROR",
      "Unable to load price history right now.",
      502,
      request,
    );
  } finally {
    clearTimeout(timeout);
  }
});
