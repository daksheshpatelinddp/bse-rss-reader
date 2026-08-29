/**
 * BSE Announcement & Result Reader Worker
 * Complete implementation supporting bulk stock additions, file uploads, 
 * flexible watchlist matching, and real-time ntfy.sh alerts.
 */

const FEED_URLS = {
  announcements: "https://www.bseindia.com/data/xml/notices.xml",
  results: "https://www.bseindia.com/data/xml/results.xml",
};

const NTFY_TOPIC = "bse_alerts_dakshesh_532";

const CATEGORY_RULES = {
  "Financial Results": ["result", "financial", "quarterly", "audited", "unaudited", "statement of profit"],
  "Dividend": ["dividend", "interim dividend", "final dividend", "special dividend"],
  "AGM / EGM": ["agm", "egm", "annual general meeting", "extraordinary general meeting"],
  "Appointment / Resignation": ["appointment", "resignation", "director", "kmp", "ceo", "cfo"],
  "Regulatory / Legal": ["sebi", "legal", "court", "nclt", "show cause", "penalty"],
  "Acquisition": ["acquisition", "takeover", "merger", "amalgamation", "stake"],
  "Annual Report": ["annual report"],
  "Shareholder Communication": ["newspaper publication", "investor presentation", "transcript"],
  "Preferential Issue": ["preferential", "private placement", "rights issue"],
  "Fund Raising": ["fund raise", "qip", "bonds", "debentures"],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/watchlist") {
        if (request.method === "GET") {
          const watchlist = await getWatchlist(env);
          return jsonResponse(watchlist);
        }

        if (request.method === "POST") {
          let newEntries = [];
          const contentType = request.headers.get("content-type") || "";

          // 1. Handle plain text / CSV file upload or multiline/comma raw string
          if (contentType.includes("text/plain") || contentType.includes("text/csv")) {
            const text = await request.text();
            newEntries = text.split(/[\n,\r]+/).map((s) => s.trim()).filter(Boolean);
          } else {
            // 2. Handle JSON array or comma-separated payload
            const body = await request.json();
            if (Array.isArray(body)) {
              newEntries = body;
            } else if (typeof body === "string") {
              newEntries = body.split(",").map((s) => s.trim()).filter(Boolean);
            } else if (body.watchlist) {
              newEntries = Array.isArray(body.watchlist)
                ? body.watchlist
                : String(body.watchlist).split(",").map((s) => s.trim()).filter(Boolean);
            }
          }

          // Clean, merge, and deduplicate entries
          const existing = await getWatchlist(env);
          const combined = Array.from(new Set([...existing, ...newEntries]));

          await saveWatchlist(env, combined);
          return jsonResponse({ ok: true, watchlist: combined });
        }
      }

      if (path === "/feeds" || path === "/bse-announcements") {
        const data = await fetchFeeds();
        const watchlist = await getWatchlist(env);
        const annotated = annotateWatchlist(data, watchlist);
        return jsonResponse(annotated);
      }

      if (path === "/alerts") {
        const alerts = await getAlerts(env);
        return jsonResponse(alerts);
      }

      if (path === "/monitor") {
        const result = await monitorFeeds(env);
        return jsonResponse(result);
      }

      if (path === "/alerts/clear") {
        await saveAlerts(env, []);
        return jsonResponse({ ok: true, cleared: true });
      }

      return jsonResponse({ ok: false, error: "Endpoint not found." }, 404);
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(monitorFeeds(env));
  },
};

// ==========================================
// CORE MONITORING & MATCHING LOGIC
// ==========================================

async function monitorFeeds(env) {
  const items = await fetchFeeds();
  const watchlist = await getWatchlist(env);
  const seen = await getSeen(env);

  if (seen.length === 0) {
    const ids = items.map((item) => item.id).filter(Boolean);
    await saveSeen(env, ids);
    return { ok: true, monitored: true, baseline: true, announcements: items.length };
  }

  const seenSet = new Set(seen);
  const newItems = items.filter((item) => !seenSet.has(item.id));
  const matchedAlerts = [];

  for (const item of newItems) {
    if (matchesWatchlist(item, watchlist)) {
      item.matchedAt = new Date().toISOString();
      matchedAlerts.push(item);
      await sendWebPush(item);
    }
  }

  if (newItems.length > 0) {
    const updatedSeen = Array.from(new Set([...seen, ...newItems.map((i) => i.id)])).slice(-2000);
    await saveSeen(env, updatedSeen);
  }

  if (matchedAlerts.length > 0) {
    const existingAlerts = await getAlerts(env);
    const updatedAlerts = [...matchedAlerts, ...existingAlerts].slice(0, 100);
    await saveAlerts(env, updatedAlerts);
  }

  return {
    ok: true,
    monitored: true,
    baseline: false,
    announcements: items.length,
    newAnnouncements: newItems.length,
    watchlist: watchlist.length,
    newAlerts: matchedAlerts.length,
  };
}

/**
 * Enhanced Multi-Format Matcher
 * Handles: "501111", "BSE 501111", "Infosys (500209)", "500209 (Infosys)", or plain names.
 */
function matchesWatchlist(item, watchlist) {
  if (!watchlist || !Array.isArray(watchlist) || watchlist.length === 0) return false;

  const itemTitle = (item.title || "").toLowerCase();
  const itemCompany = (item.company || "").toLowerCase();
  const itemScrip = (item.scrip || "").trim();

  return watchlist.some((watch) => {
    if (!watch) return false;

    const rawVal = typeof watch === "string" ? watch : watch.scrip || watch.name || "";
    const cleanVal = rawVal.trim().toLowerCase();

    if (!cleanVal) return false;

    // 1. Extract and match 6-digit scrip code regardless of prefixes like "BSE "
    const scripMatch = cleanVal.match(/\b\d{6}\b/);
    if (scripMatch) {
      const extractedScrip = scripMatch[0];
      if (itemScrip === extractedScrip || itemTitle.includes(extractedScrip)) {
        return true;
      }
    }

    // 2. Clean text entries: strip scrip numbers, parentheses, and prefixes like "bse"
    const nameOnly = cleanVal
      .replace(/\(\d{6}\)/g, "")
      .replace(/\b\d{6}\b/g, "")
      .replace(/\bbse\b/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();

    // 3. Perform string match on cleaned company name
    if (nameOnly.length >= 3) {
      if (itemTitle.includes(nameOnly) || itemCompany.includes(nameOnly)) {
        return true;
      }
    }

    return false;
  });
}

// ==========================================
// PUSH NOTIFICATION (NTFY.SH)
// ==========================================

async function sendWebPush(item) {
  const targetUrl = item.pdfUrl || item.link || `https://www.bseindia.com/stock-share-price/-/${item.scrip}/`;
  const payload = {
    topic: NTFY_TOPIC,
    title: ` ${item.company || "BSE Alert"} (${item.scrip || "N/A"})`,
    message: item.title,
    click: targetUrl,
    priority: 4,
    tags: ["chart_with_upwards_trend", "stock_market"],
  };

  await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ==========================================
// RSS FETCHING & PARSING
// ==========================================

async function fetchFeeds() {
  const items = [];
  for (const [type, url] of Object.entries(FEED_URLS)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) {
        const xml = await res.text();
        const parsed = parseBSEXml(xml, type);
        items.push(...parsed);
      }
    } catch (e) {
      // Continue if one feed fails
    }
  }
  return items;
}

function parseBSEXml(xml, defaultType) {
  const items = [];
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  for (const itemXml of itemMatches) {
    const title = extractTag(itemXml, "title");
    const link = extractTag(itemXml, "link");
    const description = extractTag(itemXml, "description");
    const pubDate = extractTag(itemXml, "pubDate");
    const guid = extractTag(itemXml, "guid") || link;

    const scripMatch = title.match(/\b\d{6}\b/) || description.match(/\b\d{6}\b/);
    const scrip = scripMatch ? scripMatch[0] : "";

    const companyMatch = title.match(/^([^(]+)/);
    const company = companyMatch ? companyMatch[1].trim() : title;

    const category = categorizeAnnouncement(title + " " + description);

    items.push({
      id: guid,
      scrip,
      company,
      title,
      description,
      link,
      pubDate,
      category,
      feedType: defaultType,
    });
  }
  return items;
}

function categorizeAnnouncement(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_RULES)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return "Other";
}

function annotateWatchlist(items, watchlist) {
  return items.map((item) => ({
    ...item,
    isWatchlisted: matchesWatchlist(item, watchlist),
  }));
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "is"));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}

// ==========================================
// KV STORAGE HELPERS
// ==========================================

async function getWatchlist(env) {
  const data = await env.BSE_DATA.get("watchlist", "json");
  return data || [];
}

async function saveWatchlist(env, watchlist) {
  await env.BSE_DATA.put("watchlist", JSON.stringify(watchlist));
}

async function getSeen(env) {
  const data = await env.BSE_DATA.get("announcementSeen", "json");
  return data || [];
}

async function saveSeen(env, seen) {
  await env.BSE_DATA.put("announcementSeen", JSON.stringify(seen));
}

async function getAlerts(env) {
  const data = await env.BSE_DATA.get("alerts", "json");
  return data || [];
}

async function saveAlerts(env, alerts) {
  await env.BSE_DATA.put("alerts", JSON.stringify(alerts));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}