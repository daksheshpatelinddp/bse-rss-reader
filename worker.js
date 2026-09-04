/*
 * BSE RSS READER
 * V5.4 - Cross-Source Fingerprint Dedup
 *   - Monitor + frontend list both merge JSON API, RSS, and Financial
 *     Results, deduped by a cross-source fingerprint (attachment
 *     filename, or scrip+title+day as fallback) - not by each
 *     source own id, since JSON and RSS use different ids for the
 *     same announcement.
 *   - Whichever source fetches an announcement first is what shows in
 *     the app and triggers Telegram/ntfy; the slower source catching
 *     up later never fires a duplicate alert.
 *   - Fixed IST timezone
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

const MAX_SEEN = 10000;
const MAX_ALERTS = 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ============================================================
   HELPERS
   ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
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
  var targetLink = (pdfLink && pdfLink !== "https://www.bseindia.com")
    ? pdfLink
    : (scrip ? "https://www.bseindia.com/stock-share-price/" + scrip : "https://www.bseindia.com");

  const cleanTitle = escapeTelegramHtml(title);
  const cleanBody = escapeTelegramHtml(body);
  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";

  const messageText = ` <b>${cleanTitle}</b>\n\n${cleanBody}\n\n <b>Fetched:</b> ${formattedFetchTime}\n <a href="${targetLink}">View Attachment / Details</a>`;

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
  var targetLink = (pdfLink && pdfLink !== "https://www.bseindia.com")
    ? pdfLink
    : (scrip ? "https://www.bseindia.com/stock-share-price/" + scrip : "https://www.bseindia.com");

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
      "User-Agent": "Mozilla/5.0 (compatible; BSE-RSS-Reader/5.3)",
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

// BSE's JSON API is paginated - Table1[0].ROWCNT tells us the true total
// for the day, which can be 1000s of rows across 50+ pages. maxPages caps
// how deep we page in a single call, so a fast cron tick (cheap, few
// pages) and an on-demand full refresh (deeper) can ask for different
// amounts of coverage.
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
      "financial results", "financial result", "unaudited financial results",
      "audited financial results", "quarterly results", "quarterly result",
      "results for the quarter", "standalone financial results", "consolidated financial results",
    ],
  },
  { name: "Board Meeting", words: ["board meeting", "meeting of the board", "outcome of board meeting"] },
  { name: "Dividend", words: ["dividend", "interim dividend", "final dividend", "special dividend"] },
  { name: "Bonus", words: ["bonus issue", "bonus shares", "issue of bonus shares"] },
  { name: "Fund Raising", words: ["fund raising", "fundraising", "qip", "private placement", "preferential issue"] },
  { name: "Acquisition", words: ["acquisition", "acquire", "acquired", "takeover"] },
  { name: "Order / Contract", words: ["order received", "order win", "work order", "contract awarded", "award of order", "receipt of order"] },
  { name: "Credit Rating", words: ["credit rating", "rating reaffirmed", "rating upgrade", "rating downgrade"] },
  { name: "Appointment / Resignation", words: ["appointment", "resignation", "cessation", "change in management"] },
];

function classifyAnnouncement(title, description, categoryName) {
  const text = `${title || ""} ${description || ""} ${categoryName || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
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

    // Fixed IST
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
   KV
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

async function getSeen(env) {
  if (!env.BSE_DATA) return [];
  const data = await env.BSE_DATA.get("announcementSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveSeen(env, ids) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("announcementSeen", JSON.stringify(ids.slice(0, MAX_SEEN)));
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
  // First run after this update: seed from already-sent alerts so we
  // don't re-fire Telegram/ntfy for things already alerted under the
  // old id-only scheme.
  const alerts = await getAlerts(env);
  const seeded = alerts.map((a) => a.fingerprint || computeFingerprint(a)).filter(Boolean);
  await env.BSE_DATA.put("alertFingerprints", JSON.stringify(seeded));
  return seeded;
}

async function saveAlertFingerprints(env, list) {
  if (!env.BSE_DATA) return;
  await env.BSE_DATA.put("alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 3)));
}

async function getTimestampMap(env) {
  if (!env.BSE_DATA) return {};
  const data = await env.BSE_DATA.get("announcementTimestamps", "json");
  return data || {};
}

async function saveTimestampMap(env, map) {
  if (!env.BSE_DATA) return;
  const keys = Object.keys(map);
  if (keys.length > 5000) {
    const trimmedMap = {};
    keys.slice(keys.length - 5000).forEach((k) => {
      trimmedMap[k] = map[k];
    });
    await env.BSE_DATA.put("announcementTimestamps", JSON.stringify(trimmedMap));
  } else {
    await env.BSE_DATA.put("announcementTimestamps", JSON.stringify(map));
  }
}

async function attachPersistentTimestamps(items, env) {
  const map = await getTimestampMap(env);
  const now = new Date().toISOString();
  let updated = false;

  const results = items.map((item) => {
    if (map[item.id]) {
      return { ...item, fetchedAt: map[item.id] };
    } else {
      map[item.id] = now;
      updated = true;
      return { ...item, fetchedAt: now };
    }
  });

  if (updated) await saveTimestampMap(env, map);
  return results;
}

/* ============================================================
   CROSS-SOURCE FINGERPRINT
   The JSON API and the XML/RSS feeds assign different IDs to the
   SAME announcement, and publish/fetch it at slightly different
   times. This fingerprint lets us recognize "same announcement"
   across sources so we only ever alert on it once - whichever
   source fetches it first wins.
   ============================================================ */

function extractAttachmentName(link) {
  const s = String(link || "");
  const m = s.match(/Attach(?:Live|His)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function computeFingerprint(item) {
  // The BSE attachment PDF filename is the most reliable cross-source
  // key: both the JSON row (ATTACHMENTNAME) and the RSS <link> point
  // to the same file for the same announcement.
  const attachment =
    String(item.attachment || "").trim().toLowerCase() || extractAttachmentName(item.link);
  if (attachment) return `att:${attachment}`;

  // Fallback for items with no attachment: scrip + normalized title +
  // day. Day-level (not minute-level) so differing publish/fetch
  // clocks between sources don't split one announcement into two.
  const scrip = String(item.scrip || "").trim();
  const title = String(item.title || "").toLowerCase().replace(/\s+/g, " ").trim();
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
   FETCH + MERGE ALL SOURCES
   Used by both /monitor and /bse-announcements so the app's own
   list and the alerts are always built from the same "whichever
   source got it first" merged data.
   ============================================================ */

async function fetchAllSources(env, jsonMaxPages = 1) {
  const fetchedAt = new Date().toISOString();

  let jsonItems = [];
  let rssItems = [];
  let finItems = [];

  const [jsonResult, rssResult, finResult] = await Promise.allSettled([
    fetchBseAnnouncementsJson(jsonMaxPages).then(table => parseBseJsonAnnouncements(table, fetchedAt)),
    fetchXML(CORPORATE_ANNOUNCEMENTS_URL).then(xml => parseCorporateAnnouncements(xml, fetchedAt)),
    fetchXML(FINANCIAL_RESULTS_URL).then(xml => parseFinancialResults(xml, fetchedAt)),
  ]);

  if (jsonResult.status === "fulfilled") jsonItems = jsonResult.value;
  if (rssResult.status === "fulfilled") rssItems = rssResult.value;
  if (finResult.status === "fulfilled") finItems = finResult.value;

  // Merge across sources by fingerprint, NOT by raw id - the JSON and
  // RSS ids for the same announcement don't match. JSON is checked
  // first in this list, so when both sources already have an item in
  // the same tick, we keep the JSON copy (it tends to land first).
  const merged = new Map();
  [...jsonItems, ...rssItems, ...finItems].forEach((item) => {
    const fp = computeFingerprint(item);
    item.fingerprint = fp;
    if (fp && !merged.has(fp)) {
      merged.set(fp, item);
    }
  });

  const rawItems = Array.from(merged.values());
  // fetchedAt here is persisted per-item (first time OUR worker ever
  // saw it) - sort by that so "first fetched" also determines display
  // order, not just alert order.
  const items = await attachPersistentTimestamps(rawItems, env);
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
   MONITOR - CHECKS ALL SOURCES, ALERTS ONCE PER ANNOUNCEMENT
   ============================================================ */

async function monitorFeeds(env) {
  // Shallow on purpose: this runs every ~1 minute during market hours, so
  // it only needs the newest few pages to catch brand-new announcements
  // (fingerprint dedup means it's fine if a slower-changing page 1 misses
  // something - the deeper /bse-announcements fetch will pick it up).
  const { items, sources } = await fetchAllSources(env, 3);

  const watchlist = await getWatchlist(env);
  const settings = await getNotificationSettings(env);
  const seen = await getSeen(env);
  const alerts = await getAlerts(env);
  const alertFpSet = new Set(await getAlertFingerprints(env));

  if (seen.length === 0) {
    const fps = items.map((item) => item.fingerprint).filter(Boolean);
    await saveSeen(env, fps);
    return { status: "initialized baseline", count: items.length, items };
  }

  const seenSet = new Set(seen);
  const newItems = items.filter((item) => item.fingerprint && !seenSet.has(item.fingerprint));
  let newAlertCount = 0;

  for (const item of newItems) {
    if (matchesWatchlist(item, watchlist)) {
      // Fingerprint (not source-specific id) gates the alert, so if the
      // slower source catches up later with the same announcement under
      // a different id, it won't fire a duplicate Telegram/ntfy alert.
      if (!alertFpSet.has(item.fingerprint)) {
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
  }

  const updatedSeen = Array.from(new Set([...newItems.map((i) => i.fingerprint), ...seen])).slice(0, MAX_SEEN);
  await saveSeen(env, updatedSeen);
  await saveAlerts(env, alerts);
  await saveAlertFingerprints(env, Array.from(alertFpSet));

  return {
    ok: true,
    newAnnouncements: newItems.length,
    newAlerts: newAlertCount,
    sources,
    totalSeen: updatedSeen.length,
    items,
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
          version: "5.3",
          note: "Monitor checks both JSON + RSS. Frontend uses RSS list.",
        });
      }

      // Frontend list: merged JSON + RSS + Financial, deduped by
      // fingerprint, sorted by which source fetched it first. Pages
      // deeper into the JSON API (up to 40 pages, capped by BSE's own
      // ROWCNT) so "All Announcements" reflects the real day total.
      // The loop stops as soon as ROWCNT is reached, so a quiet day
      // costs no more requests than before - the cap only matters on
      // a genuinely heavy day.
      if (url.pathname === "/bse-announcements") {
        const { items, sources } = await fetchAllSources(env, 40);
        return json({ ok: true, count: items.length, items, sources });
      }

      if (url.pathname === "/categories") {
        const { items } = await fetchAllSources(env, 40);
        const map = new Map();
        items.forEach((i) => i.categories.forEach((c) => map.set(c, (map.get(c) || 0) + 1)));
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

      if (url.pathname === "/monitor") {
        const res = await monitorFeeds(env);
        return json(res);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(monitorFeeds(env));
  },
};
