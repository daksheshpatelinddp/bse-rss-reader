export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight options request
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": "true",
    };

    try {
      const url = new URL(request.url);
      const targetUrlParam = url.searchParams.get("url");

      if (!targetUrlParam) {
        return new Response(JSON.stringify({ error: "Missing 'url' query parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Format target URL
      let targetUrl = targetUrlParam;
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = `https://www.bseindia.com/${targetUrl.replace(/^\//, "")}`;
      }

      // Fetch target with standard browser headers to avoid BSE 404/blocking
      const bseResponse = await fetch(targetUrl, {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bseindia.com/",
          "Accept": "*/*",
        },
      });

      if (!bseResponse.ok) {
        return new Response(JSON.stringify({ error: `BSE returned status ${bseResponse.status}` }), {
          status: bseResponse.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Construct return response passing back binary or JSON payload
      const contentType = bseResponse.headers.get("content-type") || "application/octet-stream";
      
      return new Response(bseResponse.body, {
        status: bseResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
        },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
};