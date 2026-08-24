/*
 * BSE RSS Reader Worker - STEP 1
 *
 * Source:
 * https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml
 *
 * Endpoints:
 *   /              Health/status
 *   /bse-results   BSE Financial Results RSS
 */

const BSE_FEED =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    // Health check
    if (url.pathname === "/") {
      return json({
        ok: true,
        app: "BSE Financial Results Reader",
        source: "BSE Financial Results RSS",
        endpoint: "/bse-results"
      });
    }

    // BSE Financial Results RSS
    if (url.pathname === "/bse-results") {
      try {
        const response = await fetch(BSE_FEED, {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            "Accept":
              "application/rss+xml, application/xml, text/xml, */*",
            "Referer": "https://www.bseindia.com/"
          }
        });

        const body = await response.text();

        return new Response(body, {
          status: response.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type":
              response.headers.get("content-type") ||
              "application/xml; charset=utf-8"
          }
        });

      } catch (error) {
        return json(
          {
            ok: false,
            error: "Failed to fetch BSE Financial Results RSS",
            message: error.message
          },
          502
        );
      }
    }

    // Unknown endpoint
    return json(
      {
        ok: false,
        error: "Not found"
      },
      404
    );
  }
};


// JSON response helper
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}