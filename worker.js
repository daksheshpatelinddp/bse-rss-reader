/*
 * BSE RSS READER
 * V5.7 - Fast path (CPU-safe)
 *   Goal: detect new announcements as fast as possible on free plan.
 *   - 1-minute cron uses ONLY BSE JSON API page 1 (cheapest + newest).
 *   - XML/RSS + Financial Results are used only on deeper refresh
 *     (/bse-announcements seed or explicit full=1), not every tick.
 *   - No giant "seen" rewrite every minute. Recent fingerprints live
 *     in a small rolling set (MAX_RECENT_SEEN). Day-store buckets still
 *     accumulate the full day for the app UI.
 *   - Timestamp map only touched for genuinely new items.
 *   - Cross-source fingerprint still prevents duplicate Telegram/ntfy.
 *   - Auto-expires day buckets 48h after last write.
 *
 * KV binding: BSE_DATA
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC
 */

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const BSE_ANN_API =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

const CORPORATE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const MAX_RECENT_SEEN = 2500; // small enough to stay under 10ms CPU
const MAX_ALERTS = 1000;
const MAX_DAY_STORE_ITEMS = 25000;
const DAY_STORE_TTL_SECONDS = 172800; // 48 hours
const DAY_STORE_BUCKET_MINUTES = 15;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ============================================================
   HELPERS
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function normalizeBseLink(rawLink) {
  var clean = String(rawLink || "").trim();
  if (!clean) return "https://www.bseindia.com";

  if (clean.indexOf("AttachLive") !== -1 || clean.indexOf("AttachHis") !== -1) {
    var fileName = clean.split("/").pop();
    if (fileName) {
      return "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + fileName;
    }
  }

  if (clean.indexOf("http") !== 0) {
    if (clean.indexOf("/") === 0) {
      return "https://www.bseindia.com" + clean;
    }
    return "https://www.bseindia.com/" + clean;
  }

  return clean;
}

function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Telegram credentials missing.");
    return;
  }

  var pdfLink = normalizeBseLink(link);
  var targetLink =
    pdfLink && pdfLink !== "https://www.bseindia.com"
      ? pdfLink
      : scrip
        ? "https://www.bseindia.com/stock-share-price/" + scrip
        : "https://www.bseindia.com";

  const cleanTitle = escapeTelegramHtml(title);
  const cleanBody = escapeTelegramHtml(body);
  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";

  const messageText = `🔔 <b>${cleanTitle}</b>\n\n${cleanBody}\n\n⏱ <b>Fetched:</b> ${formattedFetchTime}\n📎 <a href="${targetLink}">View Attachment / Details</a>`;

  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

async function sendNtfyAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.NTFY_TOPIC) {
    console.error("NTFY_TOPIC missing.");
    return;
  }

  var pdfLink = normalizeBseLink(link);
  var targetLink =
    pdfLink && pdfLink !== "https://www.bseindia.com"
      ? pdfLink
      : scrip
        ? "https://www.bseindia.com/stock-share-price/" + scrip
        : "https://www.bseindia.com";

  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";
  const messageBody = `${body}\nFetched: ${formattedFetchTime}`;

  try {
    const url = `https://ntfy.sh/${env.NTFY_TOPIC}`;
    await fetch(url, {
      method: "POST",
      headers: {
        Title: title,
        Click: targetLink,
        Tags: "chart_with_upwards_trend,warning",
      },
      body: messageBody,
    });
  } catch (err) {
    console.error("ntfy error:", err);
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(value) {
  return decodeHtml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? stripHtml(match[1]) : "";
}

async function fetchXML(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; BSE-RSS-Reader/5.7)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) throw new Error(`BSE feed HTTP ${response.status}`);
  return await response.text();
}

async function fetchBseAnnouncementsJsonPage(pageNo, dateStr) {
  const url =
    `${BSE_ANN_API}?pageno=${pageNo}` +
    `&strCat=-1&subcategory=-1` +
    `&strPrevDate=${dateStr}&strToDate=${dateStr}` +
    `&strSearch=P&strscrip=&strType=C`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.bseindia.com/",
      Origin: "https://www.bseindia.com",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) throw new Error(`BSE JSON API HTTP ${response.status}`);

  const data = await response.json();
  const rows = data && Array.isArray(data.Table) ? data.Table : [];
  const totalCount =
    data && Array.isArray(data.Table1) && data.Table1[0] && data.Table1[0].ROWCNT != null
      ? Number(data.Table1[0].ROWCNT)
      : null;
  return { rows, totalCount };
}

async function fetchBseAnnouncementsJson(maxPages = 1) {
  const today = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(today.getTime() + istOffset);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;

  let page = 1;
  let rows = [];
  let totalCount = null;

  while (page <= maxPages) {
    const result = await fetchBseAnnouncementsJsonPage(page, dateStr);
    if (result.totalCount != null) totalCount = result.totalCount;
    if (!result.rows.length) break;
    rows = rows.concat(result.rows);
    if (totalCount != null && rows.length >= totalCount) break;
    page++;
  }

  return rows;
}

/* ============================================================
   CLASSIFICATION
   ============================================================ */

const CATEGORY_RULES = [
  {
    name: "Financial Results",
    words: [
      "financial results",
      "financial result",
      "unaudited financial results",
      "audited financial results",
      "quarterly results",
      "quarterly result",
      "results for the quarter",
      "standalone financial results",
      "consolidated financial results",
    ],
  },
  { name: "Board Meeting", words: ["board meeting", "meeting of the board", "outcome of board meeting"] },
  { name: "Dividend", words: ["dividend", "interim dividend", "final dividend", "special dividend"] },
  { name: "Bonus", words: ["bonus issue", "bonus shares", "issue of bonus shares"] },
  {
    name: "Fund Raising",
    words: ["fund raising", "fundraising", "qip", "private placement", "preferential issue"],
  },
  { name: "Acquisition", words: ["acquisition", "acquire", "acquired", "takeover"] },
  {
    name: "Order / Contract",
    words: ["order received", "order win", "work order", "contract awarded", "award of order", "receipt of order"],
  },
  {
    name: "Credit Rating",
    words: ["credit rating", "rating reaffirmed", "rating upgrade", "rating downgrade"],
  },
  {
    name: "Appointment / Resignation",
    words: ["appointment", "resignation", "cessation", "change in management"],
  },
];

function classifyAnnouncement(title, description, categoryName) {
  const text = `${title || ""} ${description || ""} ${categoryName || ""}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const categories = [];

  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((word) => text.includes(word))) {
      categories.push(rule.name);
    }
  }

  if (categoryName) {
    const cn = categoryName.toLowerCase();
    if (cn.includes("result") && !categories.includes("Financial Results")) {
      categories.unshift("Financial Results");
    } else if (cn.includes("dividend") && !categories.includes("Dividend")) {
      categories.unshift("Dividend");
    }
  }

  if (categories.length === 0) categories.push("Other");
  return {
    category: categories[0],
    categories,
    isFinancialResult: categories.includes("Financial Results"),
  };
}

/* ============================================================
   PARSERS
   ============================================================ */

function parseFinancialResults(xml, fetchedAt) {
  const items = [];
  const matches = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const itemXML of matches) {
    const title = xmlTag(itemXML, "title");
    const rawLink = xmlTag(itemXML, "link");
    const link = normalizeBseLink(rawLink);
    const description = xmlTag(itemXML, "description");
    const pubDate = xmlTag(itemXML, "pubDate") || new Date().toUTCString();

    if (!title) continue;

    let company = title;
    let scrip = "";

    const titleMatch = title.match(/^(.*?)\s*\((\d+)\)\s*$/);
    if (titleMatch) {
      company = titleMatch[1].trim();
      scrip = titleMatch[2].trim();
    }

    const stableId = link || `${title}|${description}`;

    items.push({
      feed: "Financial Results",
      company,
      scrip,
      category: "Financial Results",
      categories: ["Financial Results"],
      isFinancialResult: true,
      title,
      link,
      description,
      pubDate,
      fetchedAt,
      guid: stableId,
      id: stableId,
    });
  }
  return items;
}

function parseBseJsonAnnouncements(table, fetchedAt) {
  const items = [];

  for (const row of table) {
    const scrip = String(row.SCRIP_CD || "").trim();
    const company = String(row.SLONGNAME || "").trim() || "Unknown Company";
    const headline = String(row.HEADLINE || row.NEWSSUB || "").trim();
    const categoryName = String(row.CATEGORYNAME || "").trim();
    const subCat = String(row.SUBCATNAME || "").trim();
    const description = [headline, subCat, categoryName].filter(Boolean).join(" | ");

    let pubDate = row.DissemDT || row.News_submission_dt || row.NEWS_DT || row.DT_TM;
    if (pubDate) {
      if (!pubDate.includes("Z") && !pubDate.includes("+") && !pubDate.includes("-", 10)) {
        pubDate = pubDate.replace(" ", "T") + "+05:30";
      }
      pubDate = new Date(pubDate).toISOString();
    } else {
      pubDate = new Date().toISOString();
    }

    let link = "";
    if (row.ATTACHMENTNAME) {
      link = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`;
    } else if (row.NSURL) {
      link = row.NSURL;
    }

    const classification = classifyAnnouncement(headline, description, categoryName);

    const stableId =
      row.NEWSID ||
      row.BSENEWSID ||
      (scrip && row.ATTACHMENTNAME ? `${scrip}|${row.ATTACHMENTNAME}` : `${scrip}|${headline}|${pubDate}`);

    if (!headline && !description) continue;

    items.push({
      feed: "Corporate Announcements",
      company,
      scrip,
      category: classification.category,
      categories: classification.categories,
      isFinancialResult: classification.isFinancialResult,
      title: headline || `${company} (${scrip})`,
      link,
      description,
      pubDate,
      fetchedAt,
      guid: stableId,
      id: stableId,
      bseCategory: categoryName,
      attachment: row.ATTACHMENTNAME || null,
    });
  }
  return items;
}

function parseCorporateAnnouncements(xml, fetchedAt) {
  const items = [];
  const matches = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const itemXML of matches) {
    const title = xmlTag(itemXML, "title");
    const rawLink = xmlTag(itemXML, "link");
    const link = normalizeBseLink(rawLink);
    const description = xmlTag(itemXML, "description");
    const pubDate = xmlTag(itemXML, "pubDate") || new Date().toUTCString();
    const guid = xmlTag(itemXML, "guid");

    if (!title && !description) continue;

    let company = "";
    let scrip = "";

    const titleMatch = title.match(/^(.*?)\s*\((\d{6})\)/);
    if (titleMatch) {
      company = titleMatch[1].trim();
      scrip = titleMatch[2].trim();
    }

    if (!scrip) {
      const scripMatch = `${title} ${description}`.match(/\b(\d{6})\b/);
      if (scripMatch) scrip = scripMatch[1];
    }

    const classification = classifyAnnouncement(title, description, "");
    const stableId = guid || link || `${title}|${description}|${pubDate}`;

    items.push({
      feed: "Corporate Announcements",
      company: company || "Unknown Company",
      scrip,
      category: classification.category,
      categories: classification.categories,
      isFinancialResult: classification.isFinancialResult,
      title,
      link,
      description,
      pubDate,
      fetchedAt,
      guid: stableId,
      id: stableId,
    });
  }
  return items;
}

/* ============================================================
   KV - watchlist / settings / alerts
   ============================================================ */

async function getWatchlist(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  if (!env.BSE_DATA) throw new Error("BSE_DATA KV is not bound.");
  await env.BSE_DATA.put("watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  if (!env.BSE_DATA) return { telegram: true, ntfy: true };
  const data = await env.BSE_DATA.get("notificationSettings", "json");
  return data || { telegram: true, ntfy: true };
}

async function setNotificationSettings(env, settings) {
  if (!env.BSE_DATA) throw new Error("BSE_DATA KV is not bound.");
  await env.BSE_DATA.put("notificationSettings", JSON.stringify(settings));
}

async function getAlerts(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

async function getAlertFingerprints(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("alertFingerprints", "json");
  if (Array.isArray(data)) return data;
  const alerts = await getAlerts(env);
  const seeded = alerts.map((a) => a.fingerprint || computeFingerprint(a)).filter(Boolean);
  await env.BSE_DATA.put("alertFingerprints", JSON.stringify(seeded));
  return seeded;
}

async function saveAlertFingerprints(env, list) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 3)));
}

/* ============================================================
   RECENT SEEN - small rolling set (CPU-safe)
   ============================================================ */

async function getRecentSeen(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

/* ============================================================
   DAY STORE - 15-minute buckets
   ============================================================ */

function getIstDateStr(d = new Date()) {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(d.getTime() + istOffset);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getBucketKey(dayStr, d = new Date()) {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(d.getTime() + istOffset);
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const bucketMin = Math.floor(ist.getUTCMinutes() / DAY_STORE_BUCKET_MINUTES) * DAY_STORE_BUCKET_MINUTES;
  const mm = String(bucketMin).padStart(2, "0");
  return `ann:${dayStr}:${hh}${mm}`;
}

async function appendToDayStore(env, dayStr, newItems) {
  if (!env.BSE_DATA || !newItems || !newItems.length) return;
  const bucketKey = getBucketKey(dayStr);
  const existing = await env.BSE_DATA.get(bucketKey, "json");
  const bucket = Array.isArray(existing) ? existing : [];
  const existingFps = new Set(bucket.map((i) => i.fingerprint).filter(Boolean));
  const additions = newItems.filter((i) => i.fingerprint && !existingFps.has(i.fingerprint));
  if (!additions.length) return;
  const merged = additions.concat(bucket);
  await env.BSE_DATA.put(bucketKey, JSON.stringify(merged), {
    expirationTtl: DAY_STORE_TTL_SECONDS,
  });
}

async function getDayStore(env, dayStr) {
  if (!env.BSE_DATA) return [];
  const prefix = `ann:${dayStr}:`;
  const keys = [];
  let cursor;
  do {
    const listResult = await env.BSE_DATA.list({ prefix, cursor });
    keys.push(...listResult.keys.map((k) => k.name));
    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor);

  if (!keys.length) return [];

  const buckets = await Promise.all(keys.map((k) => env.BSE_DATA.get(k, "json")));

  const merged = [];
  const seenFps = new Set();
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (item.fingerprint && !seenFps.has(item.fingerprint)) {
        seenFps.add(item.fingerprint);
        merged.push(item);
      }
    }
  }

  merged.sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));
  return merged.slice(0, MAX_DAY_STORE_ITEMS);
}

/* ============================================================
   CROSS-SOURCE FINGERPRINT
   ============================================================ */

function extractAttachmentName(link) {
  const s = String(link || "");
  const m = s.match(/Attach(?:Live|His)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function computeFingerprint(item) {
  const attachment =
    String(item.attachment || "").trim().toLowerCase() || extractAttachmentName(item.link);
  if (attachment) return `att:${attachment}`;

  const scrip = String(item.scrip || "").trim();
  const title = String(item.title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const day = String(item.pubDate || "").slice(0, 10);
  return `st:${scrip}|${title}|${day}`;
}

/* ============================================================
   MATCHING
   ============================================================ */

function matchesWatchlist(item, watchlist) {
  if (!Array.isArray(watchlist) || watchlist.length === 0) return false;

  const itemScripRaw = String(item.scrip || "");
  const itemScripMatch = itemScripRaw.match(/\b(\d{6})\b/);
  const itemScrip = itemScripMatch ? itemScripMatch[1] : itemScripRaw.trim();
  const itemCompany = String(item.company || "").toLowerCase().trim();

  return watchlist.some((watch) => {
    const watchScripRaw = String(watch.scrip || "");
    const watchScripMatch = watchScripRaw.match(/\b(\d{6})\b/);
    const watchScrip = watchScripMatch ? watchScripMatch[1] : watchScripRaw.trim();

    if (watchScrip && itemScrip && watchScrip === itemScrip) return true;

    const watchNameRaw = String(watch.name || "");
    const watchNameScripMatch = watchNameRaw.match(/\b(\d{6})\b/);
    if (watchNameScripMatch && itemScrip && watchNameScripMatch[1] === itemScrip) return true;

    const watchName = watchNameRaw.toLowerCase().trim();
    if (watchName && watchName.length >= 3 && itemCompany && itemCompany.includes(watchName)) {
      return true;
    }
    return false;
  });
}

/* ============================================================
   FETCH SOURCES
   - fast path (default): JSON page 1 only  →  used by 1-min cron
   - full path: JSON + RSS + Financial Results  →  seed / deep refresh
   ============================================================ */

async function fetchFastSources(env) {
  const fetchedAt = new Date().toISOString();
  let jsonItems = [];

  try {
    const table = await fetchBseAnnouncementsJson(1);
    jsonItems = parseBseJsonAnnouncements(table, fetchedAt);
  } catch (err) {
    console.error("JSON fetch failed:", err);
  }

  const merged = new Map();
  for (const item of jsonItems) {
    const fp = computeFingerprint(item);
    item.fingerprint = fp;
    if (fp && !merged.has(fp)) merged.set(fp, item);
  }

  const items = Array.from(merged.values());
  // No persistent timestamp map on the hot path – use this tick's time.
  // First-seen order is preserved by the day-store + recentSeen.
  items.sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));

  return {
    items,
    sources: { json: jsonItems.length, rss: 0, financial: 0 },
  };
}

async function fetchAllSources(env, jsonMaxPages = 1) {
  const fetchedAt = new Date().toISOString();

  let jsonItems = [];
  let rssItems = [];
  let finItems = [];

  const [jsonResult, rssResult, finResult] = await Promise.allSettled([
    fetchBseAnnouncementsJson(jsonMaxPages).then((table) => parseBseJsonAnnouncements(table, fetchedAt)),
    fetchXML(CORPORATE_ANNOUNCEMENTS_URL).then((xml) => parseCorporateAnnouncements(xml, fetchedAt)),
    fetchXML(FINANCIAL_RESULTS_URL).then((xml) => parseFinancialResults(xml, fetchedAt)),
  ]);

  if (jsonResult.status === "fulfilled") jsonItems = jsonResult.value;
  if (rssResult.status === "fulfilled") rssItems = rssResult.value;
  if (finResult.status === "fulfilled") finItems = finResult.value;

  const merged = new Map();
  [...jsonItems, ...rssItems, ...finItems].forEach((item) => {
    const fp = computeFingerprint(item);
    item.fingerprint = fp;
    if (fp && !merged.has(fp)) merged.set(fp, item);
  });

  const items = Array.from(merged.values());
  items.sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));

  return {
    items,
    sources: {
      json: jsonItems.length,
      rss: rssItems.length,
      financial: finItems.length,
    },
  };
}

/* ============================================================
   MONITOR - FAST PATH (runs every ~1 min)
   ============================================================ */

async function monitorFeeds(env, options = {}) {
  const useFull = options.full === true;

  // Fast path = JSON page 1 only (stays under free-plan 10ms CPU).
  // Full path = JSON + both XML feeds (used by seed / rare deep refresh).
  const { items, sources } = useFull
    ? await fetchAllSources(env, options.jsonMaxPages || 1)
    : await fetchFastSources(env);

  const watchlist = await getWatchlist(env);
  const settings = await getNotificationSettings(env);
  const recentSeen = await getRecentSeen(env);
  const seenSet = new Set(recentSeen);

  // First run of the day / empty baseline
  if (recentSeen.length === 0) {
    const fps = items.map((item) => item.fingerprint).filter(Boolean);
    await saveRecentSeen(env, fps);
    await appendToDayStore(env, getIstDateStr(), items);
    return {
      ok: true,
      status: "initialized baseline",
      newAnnouncements: 0,
      newAlerts: 0,
      sources,
      totalSeen: fps.length,
    };
  }

  const newItems = items.filter((item) => item.fingerprint && !seenSet.has(item.fingerprint));

  // Nothing new → exit immediately (cheapest possible tick)
  if (newItems.length === 0) {
    return {
      ok: true,
      newAnnouncements: 0,
      newAlerts: 0,
      sources,
      totalSeen: recentSeen.length,
    };
  }

  await appendToDayStore(env, getIstDateStr(), newItems);

  let newAlertCount = 0;
  let alerts = null;
  let alertFpSet = null;

  // Only load alerts / fingerprints when we might actually fire one
  const maybeMatch = watchlist.length > 0;
  if (maybeMatch) {
    for (const item of newItems) {
      if (!matchesWatchlist(item, watchlist)) continue;

      if (!alertFpSet) {
        alertFpSet = new Set(await getAlertFingerprints(env));
        alerts = await getAlerts(env);
      }

      if (alertFpSet.has(item.fingerprint)) continue;

      if (settings.telegram !== false) {
        await sendTelegramAlert(
          `${item.company || "Whitelisted Scrip"} (${item.scrip || ""})`,
          item.title || "New Announcement",
          item.scrip,
          item.link,
          item.fetchedAt,
          env
        );
      }
      if (settings.ntfy !== false) {
        await sendNtfyAlert(
          `${item.company || "Whitelisted Scrip"} (${item.scrip || ""})`,
          item.title || "New Announcement",
          item.scrip,
          item.link,
          item.fetchedAt,
          env
        );
      }

      alerts.unshift({
        ...item,
        alert: true,
        alertCreatedAt: new Date().toISOString(),
      });
      alertFpSet.add(item.fingerprint);
      newAlertCount++;
    }
  }

  // Update recent-seen: newest first, capped
  const updatedSeen = [
    ...newItems.map((i) => i.fingerprint).filter(Boolean),
    ...recentSeen,
  ];
  const uniqueSeen = Array.from(new Set(updatedSeen)).slice(0, MAX_RECENT_SEEN);
  await saveRecentSeen(env, uniqueSeen);

  if (newAlertCount > 0 && alerts && alertFpSet) {
    await saveAlerts(env, alerts);
    await saveAlertFingerprints(env, Array.from(alertFpSet));
  }

  return {
    ok: true,
    newAnnouncements: newItems.length,
    newAlerts: newAlertCount,
    sources,
    totalSeen: uniqueSeen.length,
  };
}

/* ============================================================
   ROUTER
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/") {
        return json({
          status: "running",
          app: "BSE RSS Reader",
          version: "5.7",
          note: "Fast path: JSON page-1 every minute. XML only on deep seed.",
        });
      }

      // Frontend list: today's accumulated store.
      // If empty, seed once with a deeper multi-source fetch.
      if (url.pathname === "/bse-announcements") {
        const dayStr = getIstDateStr();
        let items = await getDayStore(env, dayStr);
        if (items.length === 0) {
          const seedResult = await fetchAllSources(env, 20);
          if (seedResult.items.length) {
            await appendToDayStore(env, dayStr, seedResult.items);
            // Also seed recentSeen so the next cron tick doesn't re-alert everything
            const fps = seedResult.items.map((i) => i.fingerprint).filter(Boolean);
            const existing = await getRecentSeen(env);
            const merged = Array.from(new Set([...fps, ...existing])).slice(0, MAX_RECENT_SEEN);
            await saveRecentSeen(env, merged);
            items = await getDayStore(env, dayStr);
          }
        }
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/categories") {
        const dayStr = getIstDateStr();
        const items = await getDayStore(env, dayStr);
        const map = new Map();
        items.forEach((i) => (i.categories || []).forEach((c) => map.set(c, (map.get(c) || 0) + 1)));
        const categories = Array.from(map.entries()).map(([name, count]) => ({ name, count }));
        return json({ ok: true, categories });
      }

      if (url.pathname === "/watchlist") {
        if (request.method === "GET") return json({ ok: true, watchlist: await getWatchlist(env) });
        if (request.method === "POST") {
          const body = await request.json();
          await setWatchlist(env, body.watchlist || []);
          return json({ ok: true, watchlist: body.watchlist });
        }
      }

      if (url.pathname === "/notification-settings") {
        if (request.method === "GET") {
          return json({ ok: true, settings: await getNotificationSettings(env) });
        }
        if (request.method === "POST") {
          const body = await request.json();
          await setNotificationSettings(env, body);
          return json({ ok: true, settings: body });
        }
      }

      if (url.pathname === "/alerts") {
        return json({ ok: true, items: await getAlerts(env) });
      }

      // /monitor  → fast path (JSON only)
      // /monitor?full=1  → includes XML feeds (heavier, use sparingly)
      if (url.pathname === "/monitor") {
        const full = url.searchParams.get("full") === "1";
        const res = await monitorFeeds(env, { full });
        return json(res);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Always use the cheap fast path on cron so we stay under 10ms CPU
    ctx.waitUntil(monitorFeeds(env, { full: false }));
  },
};
