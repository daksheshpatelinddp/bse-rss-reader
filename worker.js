/*
 * BSE RSS READER - STAGE 1
 *
 * Main feed:
 *   BSE Corporate Announcements RSS
 *
 * Features:
 *   - ALL BSE announcements remain visible
 *   - Watchlist by BSE scrip
 *   - New announcement detection
 *   - Persistent alerts / Special Bundle
 *   - Financial-result identification
 *   - Cron monitoring every minute
 *
 * KV binding required:
 *   BSE_KV
 */

const BSE_ANNOUNCEMENTS =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const MAX_ITEMS = 2000;
const MAX_SEEN = 5000;
const MAX_ALERTS = 1000;

const WATCHLIST_KEY = "watchlist";
const SEEN_KEY = "seen_ids";
const ALERTS_KEY = "alerts";

const RESULT_WORDS = [
  "financial result",
  "financial results",
  "quarterly result",
  "quarterly results",
  "audited financial",
  "unaudited financial",
  "audited result",
  "unaudited result",
  "results approved",
  "results declared",
  "financial statements",
  "standalone financial",
  "consolidated financial",
  "board approved results",
  "board meeting - results"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      if (path === "/" || path === "") {
        return json({
          ok: true,
          app: "BSE RSS Reader",
          status: "running",
          feeds: [
            "Financial Results",
            "Corporate Announcements"
          ],
          endpoints: [
            "/bse-results",
            "/bse-announcements",
            "/feeds",
            "/watchlist",
            "/alerts"
          ],
          monitoring: "Every minute"
        });
      }

      if (path === "/feeds") {
        return json({
          ok: true,
          feeds: [
            {
              id: "corporate-announcements",
              name: "Corporate Announcements",
              url: BSE_ANNOUNCEMENTS,
              enabled: true
            },
            {
              id: "financial-results",
              name: "Financial Results",
              url:
                "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml",
              enabled: true,
              note:
                "Kept for compatibility; Corporate Announcements is the primary live source."
            }
          ]
        });
      }

      if (path === "/bse-announcements") {
        const items = await fetchAnnouncements();

        return json({
          ok: true,
          source: "BSE Corporate Announcements",
          feed: BSE_ANNOUNCEMENTS,
          count: items.length,
          items
        });
      }

      if (path === "/bse-results") {
        const items = await fetchAnnouncements();

        const results = items.filter(item => item.isFinancialResult);

        return json({
          ok: true,
          source: "BSE Corporate Announcements",
          type: "Financial Results",
          count: results.length,
          items: results
        });
      }

      if (path === "/watchlist") {
        if (request.method === "GET") {
          return json({
            ok: true,
            watchlist: await getWatchlist()
          });
        }

        if (request.method === "POST") {
          const body = await request.json();

          const action = String(body.action || "").toLowerCase();
          const scrip = normalizeScrip(body.scrip);

          if (!scrip) {
            return json(
              {
                ok: false,
                error: "BSE scrip is required"
              },
              400
            );
          }

          let watchlist = await getWatchlist();

          if (action === "remove") {
            watchlist = watchlist.filter(x => x !== scrip);
          } else {
            if (!watchlist.includes(scrip)) {
              watchlist.push(scrip);
            }
          }

          watchlist.sort();

          await env.BSE_KV.put(
            WATCHLIST_KEY,
            JSON.stringify(watchlist)
          );

          return json({
            ok: true,
            action: action === "remove" ? "removed" : "added",
            scrip,
            watchlist
          });
        }

        return json(
          {
            ok: false,
            error: "Method not allowed"
          },
          405
        );
      }

      if (path === "/alerts") {
        return json({
          ok: true,
          bundle: "Special Bundle",
          count: (await getAlerts()).length,
          items: await getAlerts()
        });
      }

      if (path === "/alerts/clear") {
        if (request.method !== "POST") {
          return json(
            {
              ok: false,
              error: "POST required"
            },
            405
          );
        }

        await env.BSE_KV.put(ALERTS_KEY, "[]");

        return json({
          ok: true,
          message: "Special Bundle / Alerts cleared"
        });
      }

      if (path === "/monitor") {
        const result = await monitorAnnouncements(env);

        return json({
          ok: true,
          ...result
        });
      }

      return json(
        {
          ok: false,
          error: "Not found"
        },
        404
      );
    } catch (error) {
      return json(
        {
          ok: false,
          error: String(error?.message || error)
        },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(monitorAnnouncements(env));
  }
};


/* =========================================================
   MONITOR
   ========================================================= */

async function monitorAnnouncements(env) {
  const items = await fetchAnnouncements();
  const watchlist = await getWatchlist();

  const seen = await getSeen();
  const alerts = await getAlerts();

  /*
   * First execution:
   * establish the current feed as baseline.
   * Do NOT generate alerts for old announcements.
   */
  if (seen.length === 0) {
    const ids = items
      .map(x => x.id)
      .filter(Boolean)
      .slice(0, MAX_SEEN);

    await env.BSE_KV.put(
      SEEN_KEY,
      JSON.stringify(ids)
    );

    return {
      monitored: true,
      baseline: true,
      announcements: items.length,
      watchlistCount: watchlist.length,
      newAlerts: 0
    };
  }

  const seenSet = new Set(seen);
  const newItems = [];

  for (const item of items) {
    if (!item.id) continue;

    if (!seenSet.has(item.id)) {
      newItems.push(item);
    }
  }

  let newAlerts = 0;

  for (const item of newItems) {
    if (!item.scrip) continue;

    if (!watchlist.includes(item.scrip)) {
      continue;
    }

    const alert = {
      ...item,
      alertId: makeId(
        "alert",
        item.id
      ),
      alertCreatedAt: new Date().toISOString(),
      alertType: item.isFinancialResult
        ? "Financial Result"
        : "BSE Announcement",
      specialBundle: true
    };

    if (!alerts.some(x => x.id === item.id)) {
      alerts.unshift(alert);
      newAlerts++;
    }
  }

  const allSeen = [
    ...newItems.map(x => x.id),
    ...seen
  ];

  const uniqueSeen = [];

  for (const id of allSeen) {
    if (!id) continue;
    if (!uniqueSeen.includes(id)) {
      uniqueSeen.push(id);
    }

    if (uniqueSeen.length >= MAX_SEEN) {
      break;
    }
  }

  await env.BSE_KV.put(
    SEEN_KEY,
    JSON.stringify(uniqueSeen)
  );

  await env.BSE_KV.put(
    ALERTS_KEY,
    JSON.stringify(alerts.slice(0, MAX_ALERTS))
  );

  return {
    monitored: true,
    baseline: false,
    announcements: items.length,
    newAnnouncements: newItems.length,
    watchlistCount: watchlist.length,
    newAlerts,
    alertCount: Math.min(alerts.length, MAX_ALERTS)
  };
}


/* =========================================================
   BSE RSS FETCH
   ========================================================= */

async function fetchAnnouncements() {
  const response = await fetch(BSE_ANNOUNCEMENTS, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; BSE-RSS-Reader/1.0)",
      "Accept":
        "application/rss+xml, application/xml, text/xml, */*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `BSE RSS returned HTTP ${response.status}`
    );
  }

  const xml = await response.text();

  return parseRSS(xml);
}


/* =========================================================
   RSS PARSER
   ========================================================= */

function parseRSS(xml) {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const block of matches) {
    const title =
      clean(getTag(block, "title"));

    const description =
      clean(getTag(block, "description"));

    const link =
      clean(getTag(block, "link"));

    const guid =
      clean(getTag(block, "guid"));

    const pubDate =
      clean(
        getTag(block, "pubDate") ||
        getTag(block, "dc:date") ||
        getTag(block, "date")
      );

    const raw = [
      title,
      description
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const scrip = extractScrip(
      block,
      title,
      description
    );

    const company = extractCompany(
      block,
      title,
      description
    );

    const isFinancialResult =
      isResultAnnouncement(raw);

    const id =
      guid ||
      link ||
      makeId(
        "item",
        `${title}|${pubDate}|${scrip}`
      );

    items.push({
      id,
      title,
      description,
      link,
      pubDate,
      company,
      scrip,
      isFinancialResult,
      resultType: isFinancialResult
        ? "Financial Result"
        : null,
      source: "BSE Corporate Announcements"
    });
  }

  return items.slice(0, MAX_ITEMS);
}


function getTag(xml, tag) {
  const escaped = tag.replace(":", "\\:");

  const re = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
    "i"
  );

  const match = xml.match(re);

  return match ? match[1] : "";
}


/* =========================================================
   FIELD EXTRACTION
   ========================================================= */

function extractScrip(block, title, description) {
  const text = `${block} ${title} ${description}`;

  const patterns = [
    /Scrip\s*(?:Code|ID)?\s*[:\-]\s*([0-9]{5,7})/i,
    /Security\s*Code\s*[:\-]\s*([0-9]{5,7})/i,
    /Scrip\s*[:\-]\s*([0-9]{5,7})/i,
    /\b([0-9]{6})\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return "";
}


function extractCompany(block, title, description) {
  const text =
    `${title} ${description}`;

  const patterns = [
    /Company\s*(?:Name)?\s*[:\-]\s*([^<|]+)/i,
    /Issuer\s*(?:Name)?\s*[:\-]\s*([^<|]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return clean(match[1]);
    }
  }

  return "";
}


function isResultAnnouncement(text) {
  const lower = text.toLowerCase();

  return RESULT_WORDS.some(
    word => lower.includes(word)
  );
}


/* =========================================================
   WATCHLIST
   ========================================================= */

async function getWatchlist() {
  const value =
    await BSE_KV_GET(WATCHLIST_KEY);

  if (!value) return [];

  try {
    const list = JSON.parse(value);

    if (!Array.isArray(list)) {
      return [];
    }

    return list
      .map(normalizeScrip)
      .filter(Boolean);
  } catch {
    return [];
  }
}


function normalizeScrip(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}


/* =========================================================
   SEEN ITEMS
   ========================================================= */

async function getSeen() {
  const value =
    await BSE_KV_GET(SEEN_KEY);

  if (!value) return [];

  try {
    const list = JSON.parse(value);

    return Array.isArray(list)
      ? list
      : [];
  } catch {
    return [];
  }
}


/* =========================================================
   ALERTS / SPECIAL BUNDLE
   ========================================================= */

async function getAlerts() {
  const value =
    await BSE_KV_GET(ALERTS_KEY);

  if (!value) return [];

  try {
    const list = JSON.parse(value);

    return Array.isArray(list)
      ? list
      : [];
  } catch {
    return [];
  }
}


/*
 * Helper so this code can later be moved to
 * Durable Objects/D1 without changing API logic.
 */
async function BSE_KV_GET(key) {
  /*
   * BSE_KV is intentionally accessed through
   * globalThis.envHolder after the worker request.
   */
  return await globalThis.__BSE_KV.get(key);
}


/* =========================================================
   UTILITY
   ========================================================= */

function clean(value) {
  if (!value) return "";

  return decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}


function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    );
}


function makeId(prefix, value) {
  let hash = 0;

  const str = String(value);

  for (let i = 0; i < str.length; i++) {
    hash =
      ((hash << 5) - hash) +
      str.charCodeAt(i);

    hash |= 0;
  }

  return `${prefix}_${Math.abs(hash)}`;
}


function json(data, status = 200) {
  return cors(
    new Response(
      JSON.stringify(data),
      {
        status,
        headers: {
          "content-type":
            "application/json;charset=UTF-8"
        }
      }
    )
  );
}


function cors(response) {
  const headers =
    new Headers(response.headers);

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      headers
    }
  );
}