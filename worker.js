export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Health check
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          ok: true,
          app: "BSE Financial Results Reader",
          feed: "BSE Financial Results RSS",
          endpoint: "/bse-results"
        }),
        {
          headers: {
            ...cors,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // BSE Financial Results RSS
    if (url.pathname === "/bse-results") {
      const bseUrl =
        "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

      try {
        const response = await fetch(bseUrl, {
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
            ...cors,
            "Content-Type":
              response.headers.get("content-type") ||
              "application/xml; charset=utf-8"
          }
        });

      } catch (error) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Failed to fetch BSE Financial Results RSS",
            message: error.message
          }),
          {
            status: 502,
            headers: {
              ...cors,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: "Not found"
      }),
      {
        status: 404,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      }
    );
  }
};