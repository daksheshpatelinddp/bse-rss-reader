/* ============================================================
   BSE ANNOUNCEMENT READER - WORKER.JS (BACKEND)
   ============================================================ */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // ------------------------------------------------------------
      // 1. WATCHLIST ENDPOINT (/watchlist)
      // ------------------------------------------------------------
      if (url.pathname === "/watchlist") {
        if (request.method === "POST") {
          const body = await request.json();
          const watchlist = Array.isArray(body.watchlist) ? body.watchlist : [];
          const jsonString = JSON.stringify(watchlist);

          // Save to KV or R2 depending on your binding setup
          if (env.WATCHLIST_KV) {
            await env.WATCHLIST_KV.put("watchlist", jsonString);
          } else if (env.BUCKET) {
            await env.BUCKET.put("watchlist.json", jsonString);
          }

          return new Response(JSON.stringify({ watchlist }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // GET Request: Retrieve saved watchlist
        let rawData = null;
        if (env.WATCHLIST_KV) {
          rawData = await env.WATCHLIST_KV.get("watchlist");
        } else if (env.BUCKET) {
          const object = await env.BUCKET.get("watchlist.json");
          if (object) rawData = await object.text();
        }

        const watchlist = rawData ? JSON.parse(rawData) : [];
        return new Response(JSON.stringify({ watchlist }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // ------------------------------------------------------------
      // 2. BSE RSS FEED ENDPOINT (/rss)
      // ------------------------------------------------------------
      if (url.pathname === "/rss") {
        const bseRssUrl = "https://www.bseindia.com/data/xml/CorporateAnnouncement.xml";
        
        const bseResponse = await fetch(bseRssUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });

        if (!bseResponse.ok) {
          return new Response(JSON.stringify({ items: [], error: "Failed to fetch BSE feed" }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const xmlText = await bseResponse.text();
        const items = parseBseXml(xmlText);

        return new Response(JSON.stringify({ items }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 404 Fallback
      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};

/* ============================================================
   XML PARSER HELPER FOR BSE ANNOUNCEMENTS
   ============================================================ */
function parseBseXml(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

  itemMatches.forEach((itemXml) => {
    const getTag = (tag) => {
      const match = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };

    const title = getTag("title");
    const description = getTag("description");
    const link = getTag("link");
    const pubDate = getTag("pubDate");
    const category = getTag("category") || "General";

    // Extract Scrip Code (6 digits) and Company Name from title/description
    const scripMatch = (title + " " + description).match(/\b(\d{6})\b/);
    const scrip = scripMatch ? scripMatch[1] : "";

    // Extract company name prior to scrip or brackets
    let company = title.split("-")[0] || title.split("(")[0] || "BSE Listed Company";
    company = company.trim();

    items.push({
      title,
      description,
      link,
      pubDate,
      category,
      scrip,
      company
    });
  });

  return items;
}