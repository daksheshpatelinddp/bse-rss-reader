export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight request
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

      // Default endpoint if no query parameter provided
      let targetUrl = targetUrlParam;
      if (!targetUrl) {
        targetUrl = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=";
      }

      // 2. Normalize and resolve attachment URLs
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        if (targetUrl.includes("AttachLive") || targetUrl.endsWith(".pdf")) {
          const cleanPath = targetUrl.replace(/^(xml-data\/corpfiling\/AttachLive\/|AttachLive\/|\/)/, "");
          targetUrl = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${cleanPath}`;
        } else {
          targetUrl = `https://www.bseindia.com/${targetUrl.replace(/^\//, "")}`;
        }
      }

      // 3. Fetch from BSE with required browser headers
      const bseResponse = await fetch(targetUrl, {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bseindia.com/",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!bseResponse.ok) {
        return new Response(JSON.stringify({ error: `BSE returned status ${bseResponse.status}` }), {
          status: bseResponse.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const contentType = bseResponse.headers.get("content-type") || "application/octet-stream";

      return new Response(bseResponse.body, {
        status: bseResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=1800",
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