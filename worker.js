/*
 * BSE RSS READER WORKER
 *
 * Main source:
 * BSE Corporate Announcements RSS
 *
 * Storage:
 * Cloudflare KV -> BSC_DATA
 *
 * Design:
 * - Monitor every minute
 * - Store today's announcements only
 * - No MAX_ITEMS=2000 limitation
 * - Store in KV chunks
 * - Remove duplicate announcements
 * - Multiple categories per announcement
 * - Whitelist by BSE scrip
 * - Alerts / Special Bundle
 *
 * Endpoints:
 * /
 * /bse-announcements
 * /categories
 * /watchlist
 * /alerts
 * /alerts/clear
 * /monitor
 */


/* =========================================================
   SETTINGS
   ========================================================= */

const BSE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const INDIA_TIME_ZONE =
  "Asia/Kolkata";

const BSC_DATA_BINDING =
  "BSE_DATA";

/*
 * Number of announcements per KV chunk.
 *
 * This is NOT a daily feed limit.
 */
const CHUNK_SIZE = 250;

/*
 * Keep today's announcement data for
 * 36 hours so midnight rollover is safe.
 */
const DAY_TTL =
  36 * 60 * 60;

/*
 * Alert retention.
 */
const ALERT_TTL =
  5 * 24 * 60 * 60;


/* =========================================================
   CORS
   ========================================================= */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};


/* =========================================================
   JSON RESPONSE
   ========================================================= */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: CORS_HEADERS
    }
  );
}


/* =========================================================
   TEXT HELPERS
   ========================================================= */

function cleanText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function decodeXML(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}


function cleanUrl(value) {
  return decodeXML(value)
    .trim();
}


function cleanScrip(value) {
  const text = String(value || "").trim();

  if (!text) return "";

  const match = text.match(/\b\d{6}\b/);

  return match ? match[0] : text;
}


/* =========================================================
   XML TAG READER
   ========================================================= */

function xmlTag(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );

  const match = String(xml || "").match(re);

  if (!match) return "";

  return decodeXML(match[1]).trim();
}


/* =========================================================
   BSE DATE / TIME
   ========================================================= */

function indiaDate(date = new Date()) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: INDIA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(date);
}


function indiaTime(date = new Date()) {
  return new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: INDIA_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).format(date);
}


/* =========================================================
   KV KEYS
   ========================================================= */

function dayPrefix(day) {
  return `bse:day:${day}`;
}


function dayIndexKey(day) {
  return `${dayPrefix(day)}:index`;
}


function dayChunkKey(day, number) {
  return `${dayPrefix(day)}:chunk:${String(number).padStart(5, "0")}`;
}


function seenKey(day, fingerprint) {
  return `${dayPrefix(day)}:seen:${fingerprint}`;
}


const WATCHLIST_KEY =
  "bse:watchlist";


const ALERT_INDEX_KEY =
  "bse:alerts:index";


function alertKey(fingerprint) {
  return `bse:alert:${fingerprint}`;
}


/* =========================================================
   KV CHECK
   ========================================================= */

function requireKV(env)
{
  if (!env.BSE_DATA) {
  throw new Error(
    "BSE_DATA KV binding is missing."
  );
}

return env.BSE_DATA;
}



/* =========================================================
   FETCH BSE RSS
   ========================================================= */

async function fetchBSEXML() {
  const response = await fetch(
    BSE_ANNOUNCEMENTS_URL,
    {
      method: "GET",
      headers: {
        "Accept":
          "application/rss+xml, application/xml, text/xml, */*",
        "User-Agent":
          "BSE-RSS-Reader/1.0"
      },
      cf: {
        cacheTtl: 0,
        cacheEverything: false
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `BSE RSS HTTP ${response.status}`
    );
  }

  return await response.text();
}


/* =========================================================
   RSS ITEM EXTRACTION
   ========================================================= */

function extractRSSItems(xml) {
  const matches =
    String(xml || "").match(
      /<item\b[\s\S]*?<\/item>/gi
    ) || [];

  const items = [];

  for (const itemXML of matches) {
    const title =
      xmlTag(itemXML, "title");

    const description =
      xmlTag(itemXML, "description");

    const link =
      xmlTag(itemXML, "link");

    const guid =
      xmlTag(itemXML, "guid");

    const pubDate =
      xmlTag(itemXML, "pubDate");

    const company =
      xmlTag(itemXML, "company") ||
      xmlTag(itemXML, "companyname") ||
      xmlTag(itemXML, "companyName") ||
      xmlTag(itemXML, "CompanyName");

    const scrip =
      xmlTag(itemXML, "scrip") ||
      xmlTag(itemXML, "scripcode") ||
      xmlTag(itemXML, "scripCode") ||
      xmlTag(itemXML, "ScripCode");

    const category =
      xmlTag(itemXML, "category") ||
      xmlTag(itemXML, "Category");

    let enclosure = "";

    const enclosureMatch =
      itemXML.match(
        /<enclosure\b[^>]*?(?:url|href)\s*=\s*["']([^"']+)["'][^>]*>/i
      );

    if (enclosureMatch) {
      enclosure =
        decodeXML(enclosureMatch[1]);
    }

    const document =
      xmlTag(itemXML, "document") ||
      xmlTag(itemXML, "attachment") ||
      xmlTag(itemXML, "pdf");

    const finalLink =
      cleanUrl(
        link ||
        enclosure ||
        document
      );

    const item = {
      title: cleanText(title),
      description: cleanText(description),
      link: finalLink,
      guid: cleanText(guid),
      pubDate: cleanText(pubDate),
      company: cleanText(company),
      scrip: cleanScrip(scrip),
      category: cleanText(category),
      feed: "Corporate Announcements"
    };

    if (
      item.title ||
      item.link ||
      item.guid
    ) {
      items.push(item);
    }
  }

  return items;
}


/* =========================================================
   EXTRACT SCRIP FROM TEXT
   ========================================================= */

function findScripInText(text) {
  const match =
    String(text || "").match(
      /\b(\d{6})\b/
    );

  return match
    ? match[1]
    : "";
}


/* =========================================================
   EXTRACT COMPANY FROM TEXT
   ========================================================= */

function findCompany(item) {
  if (item.company) {
    return item.company;
  }

  /*
   * BSE RSS sometimes puts company information
   * in the title/description instead of a separate tag.
   *
   * We do not aggressively guess company names.
   */
  return "";
}


/* =========================================================
   CATEGORY CLASSIFICATION
   ========================================================= */

function matchesAny(text, words) {
  const value =
    String(text || "").toLowerCase();

  return words.some(word =>
    value.includes(
      String(word).toLowerCase()
    )
  );
}


function mapBSECategory(category) {
  const value =
    String(category || "")
      .trim()
      .toLowerCase();

  const map = {
    "financial results":
      "Financial Results",

    "dividend":
      "Dividend",

    "board meeting":
      "Board Meeting",

    "agm / egm":
      "AGM / EGM",

    "credit rating":
      "Credit Rating",

    "acquisition":
      "Acquisition",

    "corporate action":
      "Corporate Action",

    "shareholding":
      "Shareholding",

    "allotment":
      "Allotment",

    "appointment / resignation":
      "Appointment / Resignation",

    "press release":
      "Press Release",

    "trading / insider":
      "Trading / Insider",

    "fund raising":
      "Fund Raising",

    "merger / amalgamation":
      "Merger / Amalgamation",

    "order / contract":
      "Order / Contract",

    "buyback":
      "Buyback",

    "preferential issue":
      "Preferential Issue",

    "rights issue":
      "Rights Issue",

    "bonus":
      "Bonus",

    "newspaper advertisement":
      "Newspaper Advertisement",

    "investor / analyst meet":
      "Investor / Analyst Meet",

    "shareholder communication":
      "Shareholder Communication"
  };

  return map[value] || null;
}


function classifyAnnouncement(
  title,
  description,
  suppliedCategory
) {
  const text = (
    `${title} ${description} ${suppliedCategory}`
  ).toLowerCase();

  const found = new Set();

  const explicit =
    mapBSECategory(
      suppliedCategory
    );

  if (explicit) {
    found.add(explicit);
  }

  /*
   * FINANCIAL RESULTS
   *
   * Deliberately broad.
   *
   * This allows related announcements such as
   * trading-window closure / board meeting
   * connected with results to also appear
   * in Financial Results.
   */

  if (
    matchesAny(text, [
      "financial result",
      "financial results",
      "unaudited financial",
      "audited financial",
      "standalone financial",
      "consolidated financial",
      "quarterly result",
      "quarterly results",
      "results for the quarter",
      "results for quarter",
      "results for the period",
      "financial statement",
      "financial statements",
      "earnings results"
    ])
  ) {
    found.add(
      "Financial Results"
    );
  }

  /*
   * BOARD MEETING
   */

  if (
    matchesAny(text, [
      "board meeting",
      "meeting of board",
      "board of directors"
    ])
  ) {
    found.add(
      "Board Meeting"
    );
  }

  /*
   * TRADING / INSIDER
   */

  if (
    matchesAny(text, [
      "trading window",
      "closure of trading window",
      "insider trading",
      "prohibition of trading",
      "trading in securities",
      "designated persons"
    ])
  ) {
    found.add(
      "Trading / Insider"
    );
  }

  /*
   * DIVIDEND
   */

  if (
    matchesAny(text, [
      "dividend",
      "interim dividend",
      "final dividend",
      "special dividend"
    ])
  ) {
    found.add(
      "Dividend"
    );
  }

  /*
   * AGM / EGM
   */

  if (
    matchesAny(text, [
      "annual general meeting",
      "agm",
      "extraordinary general meeting",
      "egm",
      "postal ballot"
    ])
  ) {
    found.add(
      "AGM / EGM"
    );
  }

  /*
   * CREDIT RATING
   */

  if (
    matchesAny(text, [
      "credit rating",
      "rating reaffirmed",
      "rating upgraded",
      "rating downgraded",
      "rating assigned"
    ])
  ) {
    found.add(
      "Credit Rating"
    );
  }

  /*
   * ACQUISITION
   */

  if (
    matchesAny(text, [
      "acquisition",
      "acquire",
      "acquired",
      "takeover"
    ])
  ) {
    found.add(
      "Acquisition"
    );
  }

  /*
   * CORPORATE ACTION
   */

  if (
    matchesAny(text, [
      "corporate action",
      "record date",
      "ex-date",
      "stock split"
    ])
  ) {
    found.add(
      "Corporate Action"
    );
  }

  /*
   * SHAREHOLDING
   */

  if (
    matchesAny(text, [
      "shareholding",
      "shareholding pattern",
      "promoter holding",
      "promoter group"
    ])
  ) {
    found.add(
      "Shareholding"
    );
  }

  /*
   * ALLOTMENT
   */

  if (
    matchesAny(text, [
      "allotment",
      "shares allotted",
      "allotted shares"
    ])
  ) {
    found.add(
      "Allotment"
    );
  }

  /*
   * APPOINTMENT / RESIGNATION
   */

  if (
    matchesAny(text, [
      "appointment",
      "appointed",
      "resignation",
      "resigned",
      "cessation"
    ])
  ) {
    found.add(
      "Appointment / Resignation"
    );
  }

  /*
   * PRESS RELEASE
   */

  if (
    matchesAny(text, [
      "press release",
      "media release"
    ])
  ) {
    found.add(
      "Press Release"
    );
  }

  /*
   * FUND RAISING
   */

  if (
    matchesAny(text, [
      "fund raising",
      "fundraising",
      "raise funds",
      "debt issue",
      "capital raising"
    ])
  ) {
    found.add(
      "Fund Raising"
    );
  }

  /*
   * MERGER
   */

  if (
    matchesAny(text, [
      "merger",
      "amalgamation",
      "scheme of amalgamation"
    ])
  ) {
    found.add(
      "Merger / Amalgamation"
    );
  }

  /*
   * ORDER / CONTRACT
   */

  if (
    matchesAny(text, [
      "order received",
      "work order",
      "contract awarded",
      "order worth",
      "letter of award"
    ])
  ) {
    found.add(
      "Order / Contract"
    );
  }

  /*
   * BUYBACK
   */

  if (
    matchesAny(text, [
      "buyback",
      "buy-back"
    ])
  ) {
    found.add(
      "Buyback"
    );
  }

  /*
   * PREFERENTIAL ISSUE
   */

  if (
    matchesAny(text, [
      "preferential issue",
      "preferential allotment"
    ])
  ) {
    found.add(
      "Preferential Issue"
    );
  }

  /*
   * RIGHTS ISSUE
   */

  if (
    matchesAny(text, [
      "rights issue",
      "rights offer"
    ])
  ) {
    found.add(
      "Rights Issue"
    );
  }

  /*
   * BONUS
   */

  if (
    matchesAny(text, [
      "bonus issue",
      "bonus shares"
    ])
  ) {
    found.add(
      "Bonus"
    );
  }

  /*
   * NEWSPAPER
   */

  if (
    matchesAny(text, [
      "newspaper advertisement",
      "newspaper publication",
      "advertisement in newspaper"
    ])
  ) {
    found.add(
      "Newspaper Advertisement"
    );
  }

  /*
   * INVESTOR / ANALYST
   */

  if (
    matchesAny(text, [
      "investor meet",
      "investor meeting",
      "analyst meet",
      "analyst meeting",
      "investor presentation"
    ])
  ) {
    found.add(
      "Investor / Analyst Meet"
    );
  }

  /*
   * SHAREHOLDER COMMUNICATION
   */

  if (
    matchesAny(text, [
      "shareholder communication",
      "communication to shareholders",
      "letter to shareholders"
    ])
  ) {
    found.add(
      "Shareholder Communication"
    );
  }

  /*
   * NEVER HIDE AN ANNOUNCEMENT.
   */

  if (found.size === 0) {
    found.add("Other");
  }

  return Array.from(found);
}


/* =========================================================
   FINGERPRINT
   ========================================================= */

async function fingerprintFor(item) {
  const source =
    item.guid ||
    item.link ||
    [
      item.scrip,
      item.company,
      item.title,
      item.pubDate
    ].join("|");

  const bytes =
    new TextEncoder().encode(
      source
    );

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return Array.from(
    new Uint8Array(hash)
  )
    .map(
      x =>
        x.toString(16).padStart(2, "0")
    )
    .join("");
}


/* =========================================================
   NORMALIZE ONE ITEM
   ========================================================= */

async function normalizeItem(item) {
  const scrip =
    cleanScrip(
      item.scrip ||
      findScripInText(
        `${item.title} ${item.description}`
      )
    );

  const company =
    findCompany(item);

  const categories =
    classifyAnnouncement(
      item.title,
      item.description,
      item.category
    );

  const normalized = {
    title: item.title,
    description: item.description,
    link: item.link,
    guid: item.guid,
    pubDate: item.pubDate,
    company,
    scrip,
    category: categories[0],
    categories,
    feed: "Corporate Announcements",
    isFinancialResult:
      categories.includes(
        "Financial Results"
      ),
    receivedAt:
      new Date().toISOString()
  };

  normalized.fingerprint =
    await fingerprintFor(
      normalized
    );

  return normalized;
}


/* =========================================================
   FETCH + NORMALIZE BSE ANNOUNCEMENTS
   ========================================================= */

async function fetchAnnouncements() {
  const xml =
    await fetchBSEXML();

  const raw =
    extractRSSItems(xml);

  const result = [];
  const fingerprints = new Set();

  for (const item of raw) {
    const normalized =
      await normalizeItem(item);

    if (
      !normalized.title &&
      !normalized.link
    ) {
      continue;
    }

    if (
      fingerprints.has(
        normalized.fingerprint
      )
    ) {
      continue;
    }

    fingerprints.add(
      normalized.fingerprint
    );

    result.push(
      normalized
    );
  }

  return result;
}


/* =========================================================
   DAY INDEX
   ========================================================= */

async function getDayIndex(
  env,
  day
) {
  const kv =
    requireKV(env);

  const value =
    await kv.get(
      dayIndexKey(day),
      "json"
    );

  if (!value) {
    return {
      chunks: [],
      count: 0,
      updatedAt: null
    };
  }

  return {
    chunks:
      Array.isArray(value.chunks)
        ? value.chunks
        : [],
    count:
      Number(value.count) || 0,
    updatedAt:
      value.updatedAt || null
  };
}


async function saveDayIndex(
  env,
  day,
  index
) {
  const kv =
    requireKV(env);

  await kv.put(
    dayIndexKey(day),
    JSON.stringify(index),
    {
      expirationTtl:
        DAY_TTL
    }
  );
}


/* =========================================================
   CHUNK
   ========================================================= */

async function getChunk(
  env,
  day,
  number
) {
  const kv =
    requireKV(env);

  const value =
    await kv.get(
      dayChunkKey(day, number),
      "json"
    );

  return Array.isArray(value)
    ? value
    : [];
}


async function saveChunk(
  env,
  day,
  number,
  items
) {
  const kv =
    requireKV(env);

  await kv.put(
    dayChunkKey(day, number),
    JSON.stringify(items),
    {
      expirationTtl:
        DAY_TTL
    }
  );
}


/* =========================================================
   STORE TODAY'S NEW ANNOUNCEMENTS
   ========================================================= */

async function storeToday(
  env,
  items
) {
  const kv =
    requireKV(env);

  const day =
    indiaDate();

  const index =
    await getDayIndex(
      env,
      day
    );

  const newItems = [];

  /*
   * Check fingerprint against today's
   * seen keys.
   */
  for (const item of items) {
    if (!item.fingerprint) {
      continue;
    }

    const key =
      seenKey(
        day,
        item.fingerprint
      );

    const exists =
      await kv.get(key);

    if (exists) {
      continue;
    }

    /*
     * Mark immediately.
     */
    await kv.put(
      key,
      "1",
      {
        expirationTtl:
          DAY_TTL
      }
    );

    newItems.push(item);
  }

  if (!newItems.length) {
    return {
      added: 0,
      total: index.count,
      chunks: index.chunks.length,
      day
    };
  }

  /*
   * Find current last chunk.
   */
  let chunkNumber =
    index.chunks.length
      ? Math.max(...index.chunks)
      : 1;

  let chunk =
    index.chunks.length
      ? await getChunk(
          env,
          day,
          chunkNumber
        )
      : [];

  /*
   * Add newest items.
   *
   * If current chunk becomes full,
   * save it and create another chunk.
   */
  for (const item of newItems) {
    chunk.unshift(item);

    if (
      chunk.length >=
      CHUNK_SIZE
    ) {
      await saveChunk(
        env,
        day,
        chunkNumber,
        chunk
      );

      if (
        !index.chunks.includes(
          chunkNumber
        )
      ) {
        index.chunks.push(
          chunkNumber
        );
      }

      chunkNumber++;
      chunk = [];
    }
  }

  /*
   * Save final partial chunk.
   */
  if (chunk.length) {
    await saveChunk(
      env,
      day,
      chunkNumber,
      chunk
    );

    if (
      !index.chunks.includes(
        chunkNumber
      )
    ) {
      index.chunks.push(
        chunkNumber
      );
    }
  }

  index.count +=
    newItems.length;

  index.updatedAt =
    new Date().toISOString();

  await saveDayIndex(
    env,
    day,
    index
  );

  return {
    added:
      newItems.length,
    total:
      index.count,
    chunks:
      index.chunks.length,
    day
  };
}


/* =========================================================
   READ TODAY
   ========================================================= */

async function getToday(
  env
) {
  const day =
    indiaDate();

  const index =
    await getDayIndex(
      env,
      day
    );

  if (!index.chunks.length) {
    return [];
  }

  const result = [];

  const numbers =
    [...index.chunks].sort(
      (a, b) => b - a
    );

  for (
    const number
      of numbers
  ) {
    const chunk =
      await getChunk(
        env,
        day,
        number
      );

    result.push(
      ...chunk
    );
  }

  /*
   * Final duplicate protection.
   */
  const seen =
    new Set();

  const unique = [];

  for (const item of result) {
    const id =
      item.fingerprint ||
      `${item.title}|${item.link}`;

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    unique.push(item);
  }

  /*
   * Newest first.
   */
  unique.sort(
    (a, b) => {
      const da =
        Date.parse(
          a.pubDate ||
          a.receivedAt ||
          ""
        );

      const db =
        Date.parse(
          b.pubDate ||
          b.receivedAt ||
          ""
        );

      return (
        (Number.isFinite(db) ? db : 0) -
        (Number.isFinite(da) ? da : 0)
      );
    }
  );

  return unique;
}


/* =========================================================
   PAGINATION
   ========================================================= */

function paginate(
  items,
  page,
  limit
) {
  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 100,
        1
      ),
      250
    );

  const safePage =
    Math.max(
      Number(page) || 1,
      1
    );

  const total =
    items.length;

  const totalPages =
    Math.max(
      Math.ceil(
        total / safeLimit
      ),
      1
    );

  const start =
    (safePage - 1) *
    safeLimit;

  return {
    items:
      items.slice(
        start,
        start + safeLimit
      ),
    page:
      safePage,
    limit:
      safeLimit,
    total,
    totalPages,
    hasNext:
      safePage < totalPages,
    hasPrevious:
      safePage > 1
  };
}


/* =========================================================
   CATEGORY FILTER
   ========================================================= */

function categoryFilter(
  items,
  category
) {
  if (!category) {
    return items;
  }

  const wanted =
    category.trim().toLowerCase();

  if (
    wanted === "all"
  ) {
    return items;
  }

  return items.filter(
    item => {
      const categories =
        Array.isArray(
          item.categories
        )
          ? item.categories
          : [
              item.category ||
              "Other"
            ];

      return categories.some(
        value =>
          String(value)
            .toLowerCase()
            .trim() === wanted
      );
    }
  );
}


/* =========================================================
   SCRIP FILTER
   ========================================================= */

function scripFilter(
  items,
  scrip
) {
  if (!scrip) {
    return items;
  }

  const wanted =
    cleanScrip(scrip);

  return items.filter(
    item =>
      cleanScrip(
        item.scrip
      ) === wanted
  );
}


/* =========================================================
   CATEGORY COUNTS
   ========================================================= */

function categoryCounts(
  items
) {
  const map =
    new Map();

  map.set(
    "All",
    items.length
  );

  for (const item of items) {
    const categories =
      Array.isArray(
        item.categories
      )
        ? item.categories
        : [
            item.category ||
            "Other"
          ];

    for (
      const category
        of categories
    ) {
      const name =
        String(
          category ||
          "Other"
        ).trim();

      map.set(
        name,
        (map.get(name) || 0) + 1
      );
    }
  }

  return Array.from(
    map.entries()
  )
    .map(
      ([name, count]) => ({
        name,
        count
      })
    )
    .sort(
      (a, b) =>
        b.count - a.count
    );
}


/* =========================================================
   WATCHLIST
   ========================================================= */

function normalizeWatchlist(
  value
) {
  if (
    !Array.isArray(value)
  ) {
    return [];
  }

  const result = [];
  const seen = new Set();

  for (
    const entry of value
  ) {
    let scrip = "";
    let company = "";

    if (
      typeof entry ===
      "string"
    ) {
      scrip =
        cleanScrip(entry);
    } else if (
      entry &&
      typeof entry ===
      "object"
    ) {
      scrip =
        cleanScrip(
          entry.scrip ||
          entry.scripCode ||
          entry.code ||
          ""
        );

      company =
        cleanText(
          entry.company ||
          entry.name ||
          ""
        );
    }

    if (!scrip) {
      continue;
    }

    if (seen.has(scrip)) {
      continue;
    }

    seen.add(scrip);

    result.push({
      scrip,
      company,
      addedAt:
        entry?.addedAt ||
        new Date().toISOString()
    });
  }

  return result;
}


async function getWatchlist(
  env
) {
  const kv =
    requireKV(env);

  const value =
    await kv.get(
      WATCHLIST_KEY,
      "json"
    );

  return normalizeWatchlist(
    value
  );
}


async function saveWatchlist(
  env,
  list
) {
  const kv =
    requireKV(env);

  const clean =
    normalizeWatchlist(
      list
    );

  await kv.put(
    WATCHLIST_KEY,
    JSON.stringify(clean)
  );

  return clean;
}


/* =========================================================
   ALERTS
   ========================================================= */

async function createAlert(
  env,
  item
) {
  const kv =
    requireKV(env);

  const key =
    alertKey(
      item.fingerprint
    );

  const exists =
    await kv.get(key);

  if (exists) {
    return false;
  }

  const alert = {
    ...item,
    isAlert: true,
    bundle:
      "Alerts / Special Bundle",
    createdAt:
      new Date().toISOString()
  };

  await kv.put(
    key,
    JSON.stringify(alert),
    {
      expirationTtl:
        ALERT_TTL
    }
  );

  const ids =
    (await kv.get(
      ALERT_INDEX_KEY,
      "json"
    )) || [];

  ids.unshift(
    item.fingerprint
  );

  const uniqueIds =
    [...new Set(ids)].slice(
      0,
      1000
    );

  await kv.put(
    ALERT_INDEX_KEY,
    JSON.stringify(uniqueIds),
    {
      expirationTtl:
        ALERT_TTL
    }
  );

  return true;
}


async function getAlerts(
  env
) {
  const kv =
    requireKV(env);

  const ids =
    (await kv.get(
      ALERT_INDEX_KEY,
      "json"
    )) || [];

  const alerts = [];
  const validIds = [];

  for (
    const id of ids
  ) {
    const alert =
      await kv.get(
        alertKey(id),
        "json"
      );

    if (alert) {
      alerts.push(alert);
      validIds.push(id);
    }
  }

  if (
    validIds.length !==
    ids.length
  ) {
    if (validIds.length) {
      await kv.put(
        ALERT_INDEX_KEY,
        JSON.stringify(validIds),
        {
          expirationTtl:
            ALERT_TTL
        }
      );
    } else {
      await kv.delete(
        ALERT_INDEX_KEY
      );
    }
  }

  alerts.sort(
    (a, b) =>
      Date.parse(
        b.createdAt || ""
      ) -
      Date.parse(
        a.createdAt || ""
      )
  );

  return alerts;
}


/* =========================================================
   PROCESS NEW ITEMS
   ========================================================= */

async function processItems(
  env,
  items
) {
  const watchlist =
    await getWatchlist(
      env
    );

  const store =
    await storeToday(
      env,
      items
    );

  let whitelistMatches = 0;
  let alertsCreated = 0;

  /*
   * Only items that came in this RSS
   * cycle are checked.
   *
   * Existing historical items do not
   * repeatedly generate alerts.
   */
  for (
    const item of items
  ) {
    const match =
      watchlist.some(
        entry =>
          cleanScrip(
            entry.scrip
          ) ===
          cleanScrip(
            item.scrip
          )
      );

    if (!match) {
      continue;
    }

    whitelistMatches++;

    const created =
      await createAlert(
        env,
        item
      );

    if (created) {
      alertsCreated++;
    }
  }

  return {
    ...store,
    whitelistMatches,
    alertsCreated
  };
}


/* =========================================================
   MONITOR
   ========================================================= */
async function monitor(env) {

  try {

    console.log("MONITOR: starting");

    /* ---------------------------------
       STEP 1 - FETCH BSE RSS
       --------------------------------- */

    let items;

    try {

      console.log(
        "MONITOR: fetching BSE RSS"
      );

      items =
        await fetchAnnouncements();

      console.log(
        "MONITOR: fetched",
        items.length
      );

    } catch (error) {

      return json({
        ok: false,
        stage: "FETCH_OR_PARSE",
        error: String(
          error?.message || error
        ),
        stack: String(
          error?.stack || ""
        )
      }, 500);
    }


    /* ---------------------------------
       STEP 2 - WATCHLIST
       --------------------------------- */

    let watchlist;

    try {

      watchlist =
        await getWatchlist(env);

    } catch (error) {

      return json({
        ok: false,
        stage: "WATCHLIST",
        error: String(
          error?.message || error
        ),
        stack: String(
          error?.stack || ""
        )
      }, 500);
    }


    /* ---------------------------------
       STEP 3 - STORE TODAY
       --------------------------------- */

    let store;

    try {

      store =
        await storeToday(
          env,
          items
        );

    } catch (error) {

      return json({
        ok: false,
        stage: "KV_STORAGE",
        fetched:
          items.length,
        error: String(
          error?.message || error
        ),
        stack: String(
          error?.stack || ""
        )
      }, 500);
    }


    /* ---------------------------------
       STEP 4 - ALERTS
       --------------------------------- */

    let whitelistMatches = 0;
    let alertsCreated = 0;

    try {

      for (
        const item of items
      ) {

        const match =
          watchlist.some(
            entry =>
              cleanScrip(
                entry.scrip
              ) ===
              cleanScrip(
                item.scrip
              )
          );

        if (!match) {
          continue;
        }

        whitelistMatches++;

        const created =
          await createAlert(
            env,
            item
          );

        if (created) {
          alertsCreated++;
        }
      }

    } catch (error) {

      return json({
        ok: false,
        stage: "ALERT_PROCESSING",
        fetched:
          items.length,
        stored:
          store.added,
        whitelistMatches,
        error: String(
          error?.message || error
        ),
        stack: String(
          error?.stack || ""
        )
      }, 500);
    }


    /* ---------------------------------
       SUCCESS
       --------------------------------- */

    return json({

      ok: true,

      source:
        "BSE Corporate Announcements RSS",

      checked:
        items.length,

      addedToday:
        store.added,

      totalToday:
        store.total,

      chunks:
        store.chunks,

      whitelistMatches,

      alertsCreated,

      date:
        store.day,

      time:
        indiaTime()

    });


  } catch (error) {

    return json({

      ok: false,

      stage:
        "MONITOR_UNKNOWN",

      error:
        String(
          error?.message ||
          error
        ),

      stack:
        String(
          error?.stack ||
          ""
        )

    }, 500);
  }
}


/* =========================================================
   /bse-announcements
   ========================================================= */

async function announcementsAPI(
  request,
  env
) {
  const url =
    new URL(request.url);

  const category =
    url.searchParams.get(
      "category"
    );

  const scrip =
    url.searchParams.get(
      "scrip"
    );

  const page =
    url.searchParams.get(
      "page"
    ) || "1";

  const limit =
    url.searchParams.get(
      "limit"
    ) || "100";

  let items =
    await getToday(
      env
    );

  items =
    categoryFilter(
      items,
      category
    );

  items =
    scripFilter(
      items,
      scrip
    );

  return json({
    ok: true,
    source:
      "Today's BSE Corporate Announcements",
    date:
      indiaDate(),
    category:
      category || "All",
    scrip:
      scrip || null,
    ...paginate(
      items,
      page,
      limit
    )
  });
}


/* =========================================================
   /categories
   ========================================================= */

async function categoriesAPI(
  env
) {
  const items =
    await getToday(
      env
    );

  return json({
    ok: true,
    source:
      "BSE Corporate Announcements RSS",
    date:
      indiaDate(),
    allCount:
      items.length,
    categories:
      categoryCounts(items)
  });
}


/* =========================================================
   /watchlist
   ========================================================= */

async function watchlistAPI(
  request,
  env
) {
  const method =
    request.method.toUpperCase();

  if (
    method ===
    "GET"
  ) {
    const list =
      await getWatchlist(
        env
      );

    return json({
      ok: true,
      watchlist:
        list,
      count:
        list.length
    });
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json({
      ok: false,
      error:
        "Invalid JSON"
    }, 400);
  }

  let list =
    await getWatchlist(
      env
    );

  /*
   * Replace entire list.
   */
  if (
    Array.isArray(
      body.watchlist
    )
  ) {
    list =
      normalizeWatchlist(
        body.watchlist
      );
  }

  /*
   * Add one company.
   */
  else if (
    method ===
    "POST"
  ) {
    const scrip =
      cleanScrip(
        body.scrip ||
        body.scripCode ||
        body.code ||
        ""
      );

    const company =
      cleanText(
        body.company ||
        body.name ||
        ""
      );

    if (!scrip) {
      return json({
        ok: false,
        error:
          "Scrip is required"
      }, 400);
    }

    const existing =
      list.find(
        x =>
          cleanScrip(
            x.scrip
          ) === scrip
      );

    if (existing) {
      if (company) {
        existing.company =
          company;
      }
    } else {
      list.push({
        scrip,
        company,
        addedAt:
          new Date().toISOString()
      });
    }
  }

  /*
   * Delete one company.
   */
  else if (
    method ===
    "DELETE"
  ) {
    const scrip =
      cleanScrip(
        body.scrip ||
        body.scripCode ||
        body.code ||
        ""
      );

    if (!scrip) {
      return json({
        ok: false,
        error:
          "Scrip is required"
      }, 400);
    }

    list =
      list.filter(
        x =>
          cleanScrip(
            x.scrip
          ) !== scrip
      );
  }

  else {
    return json({
      ok: false,
      error:
        "Method not allowed"
    }, 405);
  }

  const saved =
    await saveWatchlist(
      env,
      list
    );

  return json({
    ok: true,
    watchlist:
      saved,
    count:
      saved.length
  });
}


/* =========================================================
   /alerts
   ========================================================= */

async function alertsAPI(
  env
) {
  const alerts =
    await getAlerts(
      env
    );

  return json({
    ok: true,
    bundle:
      "Alerts / Special Bundle",
    count:
      alerts.length,
    alerts
  });
}


/* =========================================================
   /alerts/clear
   ========================================================= */

async function clearAlertsAPI(
  env
) {
  const kv =
    requireKV(env);

  const ids =
    (await kv.get(
      ALERT_INDEX_KEY,
      "json"
    )) || [];

  for (
    const id of ids
  ) {
    await kv.delete(
      alertKey(id)
    );
  }

  await kv.delete(
    ALERT_INDEX_KEY
  );

  return json({
    ok: true,
    cleared:
      ids.length
  });
}


/* =========================================================
   ROOT
   ========================================================= */

async function rootAPI(
  env
) {
  const day =
    indiaDate();

  const index =
    await getDayIndex(
      env,
      day
    );

  const watchlist =
    await getWatchlist(
      env
    );

  const alerts =
    await getAlerts(
      env
    );

  return json({
    ok: true,
    service:
      "BSE RSS Reader",
    source:
      "BSE Corporate Announcements RSS",
    storage:
      "Cloudflare KV",
    kvBinding:
      BSC_DATA_BINDING,
    storageDate:
      day,
    todayCount:
      index.count,
    chunks:
      index.chunks.length,
    watchlistCount:
      watchlist.length,
    alertCount:
      alerts.length,
    monitor:
      "every minute",
    endpoints: {
      announcements:
        "/bse-announcements",
      categories:
        "/categories",
      watchlist:
        "/watchlist",
      alerts:
        "/alerts",
      monitor:
        "/monitor"
    }
  });
}


/* =========================================================
   REQUEST ROUTER
   ========================================================= */

async function handleRequest(
  request,
  env
) {
  if (
    request.method ===
    "OPTIONS"
  ) {
    return new Response(
      null,
      {
        status: 204,
        headers:
          CORS_HEADERS
      }
    );
  }

  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname.replace(
      /\/+$/,
      ""
    ) || "/";

  try {

    if (
      path === "/"
    ) {
      return await rootAPI(
        env
      );
    }

    if (
      path ===
      "/bse-announcements"
    ) {
      return await announcementsAPI(
        request,
        env
      );
    }

    if (
      path ===
      "/categories"
    ) {
      return await categoriesAPI(
        env
      );
    }

    if (
      path ===
      "/watchlist"
    ) {
      return await watchlistAPI(
        request,
        env
      );
    }

    if (
      path ===
      "/alerts"
    ) {
      return await alertsAPI(
        env
      );
    }
    
    
    
    
    if (path === "/test-alert") {

  try {

    const watchlist =
      await getWatchlist(env);

    if (
      !Array.isArray(watchlist) ||
      watchlist.length === 0
    ) {

      return json({
        ok: false,
        error:
          "Watchlist is empty. Add a BSE scrip first."
      }, 400);

    }

    const watch =
      watchlist[0];

    const testItem = {

      id:
        "TEST-" +
        Date.now(),

      scrip:
        watch.scrip || "",

      company:
        watch.name ||
        "TEST COMPANY",

      title:
        "TEST ALERT - BSE Reader",

      description:
        "This is a test alert for the whitelisted scrip.",

      category:
        "Financial Results",

      categories: [
        "Financial Results"
      ],

      pubDate:
        new Date().toISOString(),

      link:
        "https://www.bseindia.com/"

    };

   testItem.guid =
  "TEST-" +
  Date.now();

testItem.fingerprint =
  await fingerprintFor(
    testItem
  );

    const created =
      await createAlert(
        env,
        testItem
      );


    return json({

      ok: true,

      test: true,

      created:

        created,

      scrip:
        testItem.scrip,

      company:
        testItem.company,

      message:
        created
          ? "Test alert created."
          : "Test alert already exists."

    });

  } catch (error) {

    return json({

      ok: false,

      error:
        String(
          error?.message ||
          error
        ),

      stack:
        String(
          error?.stack ||
          ""
        )

    }, 500);

  }

}





    
    
    
    

    if (
      path ===
      "/alerts/clear"
    ) {
      if (
        request.method !==
        "POST"
      ) {
        return json({
          ok: false,
          error:
            "POST required"
        }, 405);
      }

      return await clearAlertsAPI(
        env
      );
    }

    if (
      path ===
      "/monitor"
    ) {
      return await monitor(
        env
      );
    }

    return json({
      ok: false,
      error:
        "Endpoint not found",
      path
    }, 404);

} catch (error) {

  console.error(
    "Worker error:",
    error
  );

  return json({
    ok: false,
    error: String(
      error?.message ||
      error
    ),
    stack: String(
      error?.stack ||
      ""
    )
  }, 500);
}
  
}


/* =========================================================
   CLOUDFLARE WORKER EXPORT
   ========================================================= */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {
    return handleRequest(
      request,
      env
    );
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      monitor(env)
        .catch(error => {
          console.error(
            "Scheduled monitor error:",
            error
          );
        })
    );
  }

};