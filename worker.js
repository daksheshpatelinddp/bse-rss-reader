/*
 * ============================================================
 * BSE RSS READER WORKER
 * ============================================================
 *
 * Source:
 *   BSE Corporate Announcements RSS
 *
 * KV:
 *   BSE_DATA
 *
 * Main design:
 *
 *   - Monitor every minute
 *   - Keep today's announcements only
 *   - NO MAX_ITEMS daily limit
 *   - Store announcements in chunks
 *   - One compact fingerprint index per day
 *   - Do NOT create one KV "seen" key per announcement
 *   - Exact duplicate announcements are removed
 *   - Multiple categories are supported
 *   - Whitelist by BSE scrip
 *   - Alerts / Special Bundle
 *   - Alert retention = 5 days
 *   - Announcement retention = 36 hours
 *
 * ============================================================
 *
 * ENDPOINTS
 *
 *   /
 *   /bse-announcements
 *   /categories
 *   /watchlist
 *   /alerts
 *   /alerts/clear
 *   /monitor
 *   /test-alert
 *
 * ============================================================
 */


/* ============================================================
   SETTINGS
   ============================================================ */

const BSE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const INDIA_TIME_ZONE =
  "Asia/Kolkata";

const BSC_DATA_BINDING =
  "BSE_DATA";


/*
 * Announcement chunk size.
 *
 * This is NOT a limit on the daily feed.
 *
 * If BSE sends 20,000 announcements,
 * they can occupy many chunks.
 */

const CHUNK_SIZE =
  250;


/*
 * Today's data remains available for
 * 36 hours.
 */

const DAY_TTL =
  36 * 60 * 60;


/*
 * Alerts remain for 5 days.
 */

const ALERT_TTL =
  5 * 24 * 60 * 60;


/*
 * Maximum alerts returned by /alerts.
 */

const MAX_ALERTS =
  500;


/*
 * Maximum fingerprints kept in the
 * daily fingerprint index.
 *
 * This is deliberately much higher
 * than a normal BSE day.
 */

const MAX_FINGERPRINTS =
  100000;


/* ============================================================
   CORS
   ============================================================ */

const CORS_HEADERS = {

  "Access-Control-Allow-Origin":
    "*",

  "Access-Control-Allow-Methods":
    "GET, POST, DELETE, OPTIONS",

  "Access-Control-Allow-Headers":
    "Content-Type"

};


/* ============================================================
   JSON RESPONSE
   ============================================================ */

function json(
  data,
  status = 200
) {

  return new Response(

    JSON.stringify(
      data,
      null,
      2
    ),

    {
      status,

      headers: {
        ...CORS_HEADERS,

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }

  );

}


/* ============================================================
   TEXT CLEANING
   ============================================================ */

function decodeXML(
  value
) {

  return String(
    value || ""
  )

    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/gi,
      "$1"
    )

    .replace(
      /&amp;/gi,
      "&"
    )

    .replace(
      /&lt;/gi,
      "<"
    )

    .replace(
      /&gt;/gi,
      ">"
    )

    .replace(
      /&quot;/gi,
      '"'
    )

    .replace(
      /&#39;/gi,
      "'"
    )

    .replace(
      /&#x27;/gi,
      "'"
    )

    .replace(
      /&nbsp;/gi,
      " ");

}


function cleanText(
  value
) {

  return decodeXML(
    value
  )

    .replace(
      /<[^>]+>/g,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();

}


function cleanUrl(
  value
) {

  return decodeXML(
    value
  ).trim();

}


/* ============================================================
   SCRIP CLEANING
   ============================================================ */

function cleanScrip(
  value
) {

  const text =
    String(
      value || ""
    ).trim();


  if (!text) {

    return "";

  }


  const match =
    text.match(
      /\b\d{6}\b/
    );


  return match
    ? match[0]
    : "";

}


/* ============================================================
   FIND SCRIP IN TEXT
   ============================================================ */

function findScripInText(
  text
) {

  const match =
    String(
      text || ""
    ).match(
      /\b(\d{6})\b/
    );


  return match
    ? match[1]
    : "";

}


/* ============================================================
   XML TAG
   ============================================================ */

function xmlTag(
  xml,
  tag
) {

  const re =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );


  const match =
    String(
      xml || ""
    ).match(
      re
    );


  if (!match) {

    return "";

  }


  return decodeXML(
    match[1]
  ).trim();

}


/* ============================================================
   INDIA DATE
   ============================================================ */

function indiaDate(
  date = new Date()
) {

  return new Intl.DateTimeFormat(
    "en-CA",
    {

      timeZone:
        INDIA_TIME_ZONE,

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit"

    }
  ).format(
    date
  );

}


/* ============================================================
   INDIA TIME
   ============================================================ */

function indiaTime(
  date = new Date()
) {

  return new Intl.DateTimeFormat(
    "en-GB",
    {

      timeZone:
        INDIA_TIME_ZONE,

      hour:
        "2-digit",

      minute:
        "2-digit",

      second:
        "2-digit",

      hour12:
        false

    }
  ).format(
    date
  );

}


/* ============================================================
   KV
   ============================================================ */

function requireKV(
  env
) {

  if (
    !env ||
    !env.BSE_DATA
  ) {

    throw new Error(
      "BSE_DATA KV binding is missing."
    );

  }


  return env.BSE_DATA;

}


/* ============================================================
   KV KEY HELPERS
   ============================================================ */

function dayPrefix(
  day
) {

  return (
    "bse:day:" +
    day
  );

}


function dayIndexKey(
  day
) {

  return (
    dayPrefix(day) +
    ":index"
  );

}


function dayChunkKey(
  day,
  number
) {

  return (
    dayPrefix(day) +
    ":chunk:" +
    String(
      number
    ).padStart(
      5,
      "0"
    )
  );

}


/*
 * IMPORTANT:
 *
 * There is now ONE fingerprint index
 * for the whole day.
 *
 * We do NOT create:
 *
 *   bse:day:DATE:seen:FINGERPRINT
 *
 * for every announcement.
 */

function dayFingerprintsKey(
  day
) {

  return (
    dayPrefix(day) +
    ":fingerprints"
  );

}


/* ============================================================
   WATCHLIST KEY
   ============================================================ */

const WATCHLIST_KEY =
  "bse:watchlist";


/* ============================================================
   ALERT KEYS
   ============================================================ */

const ALERT_INDEX_KEY =
  "bse:alerts:index";


function alertKey(
  fingerprint
) {

  return (
    "bse:alert:" +
    fingerprint
  );

}


/* ============================================================
   BSE RSS FETCH
   ============================================================ */

async function fetchBSEXML() {

  const response =
    await fetch(
      BSE_ANNOUNCEMENTS_URL,
      {

        method:
          "GET",

        headers: {

          "Accept":
            "application/rss+xml, application/xml, text/xml, */*",

          "User-Agent":
            "BSE-RSS-Reader/2.0"

        },

        cf: {

          cacheTtl:
            0,

          cacheEverything:
            false

        }

      }
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `BSE RSS HTTP ${response.status}`
    );

  }


  return response.text();

}


/* ============================================================
   RSS ITEM EXTRACTION
   ============================================================ */

function extractRSSItems(
  xml
) {

  const matches =
    String(
      xml || ""
    ).match(
      /<item\b[\s\S]*?<\/item>/gi
    ) || [];


  const items = [];


  for (
    const itemXML
    of matches
  ) {

    const title =
      xmlTag(
        itemXML,
        "title"
      );


    const description =
      xmlTag(
        itemXML,
        "description"
      );


    const link =
      xmlTag(
        itemXML,
        "link"
      );


    const guid =
      xmlTag(
        itemXML,
        "guid"
      );


    const pubDate =
      xmlTag(
        itemXML,
        "pubDate"
      );


    const company =
      xmlTag(
        itemXML,
        "company"
      ) ||

      xmlTag(
        itemXML,
        "companyname"
      ) ||

      xmlTag(
        itemXML,
        "companyName"
      ) ||

      xmlTag(
        itemXML,
        "CompanyName"
      );


    const scrip =
      xmlTag(
        itemXML,
        "scrip"
      ) ||

      xmlTag(
        itemXML,
        "scripcode"
      ) ||

      xmlTag(
        itemXML,
        "scripCode"
      ) ||

      xmlTag(
        itemXML,
        "ScripCode"
      );


    const category =
      xmlTag(
        itemXML,
        "category"
      ) ||

      xmlTag(
        itemXML,
        "Category"
      );


    let enclosure =
      "";


    const enclosureMatch =
      itemXML.match(
        /<enclosure\b[^>]*?(?:url|href)\s*=\s*["']([^"']+)["'][^>]*>/i
      );


    if (
      enclosureMatch
    ) {

      enclosure =
        decodeXML(
          enclosureMatch[1]
        );

    }


    const document =
      xmlTag(
        itemXML,
        "document"
      ) ||

      xmlTag(
        itemXML,
        "attachment"
      ) ||

      xmlTag(
        itemXML,
        "pdf"
      );


    const finalLink =
      cleanUrl(
        link ||
        enclosure ||
        document
      );


    const item = {

      title:
        cleanText(
          title
        ),

      description:
        cleanText(
          description
        ),

      link:
        finalLink,

      guid:
        cleanText(
          guid
        ),

      pubDate:
        cleanText(
          pubDate
        ),

      company:
        cleanText(
          company
        ),

      scrip:
        cleanScrip(
          scrip
        ),

      category:
        cleanText(
          category
        ),

      feed:
        "Corporate Announcements"

    };


    if (
      item.title ||
      item.link ||
      item.guid
    ) {

      items.push(
        item
      );

    }

  }


  return items;

}


/* ============================================================
   CATEGORY HELPERS
   ============================================================ */

function matchesAny(
  text,
  words
) {

  const value =
    String(
      text || ""
    ).toLowerCase();


  return words.some(
    word =>
      value.includes(
        String(
          word
        ).toLowerCase()
      )
  );

}


/* ============================================================
   CATEGORY MAP
   ============================================================ */

function mapBSECategory(
  category
) {

  const value =
    String(
      category || ""
    )
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


  return (
    map[value] ||
    null
  );

}


/* ============================================================
   CLASSIFY ANNOUNCEMENT
   ============================================================ */

function classifyAnnouncement(
  title,
  description,
  suppliedCategory
) {

  const text =
    (
      `${title} ${description} ${suppliedCategory}`
    ).toLowerCase();


  const found =
    new Set();


  const explicit =
    mapBSECategory(
      suppliedCategory
    );


  if (
    explicit
  ) {

    found.add(
      explicit
    );

  }


  /*
   * FINANCIAL RESULTS
   *
   * Broad classification is intentional.
   *
   * A result-related announcement may
   * also belong to Board Meeting or
   * Trading / Insider.
   */

  if (
    matchesAny(
      text,
      [

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

      ]
    )
  ) {

    found.add(
      "Financial Results"
    );

  }


  /*
   * BOARD MEETING
   */

  if (
    matchesAny(
      text,
      [

        "board meeting",
        "meeting of board",
        "board of directors"

      ]
    )
  ) {

    found.add(
      "Board Meeting"
    );

  }


  /*
   * TRADING / INSIDER
   */

  if (
    matchesAny(
      text,
      [

        "trading window",
        "closure of trading window",
        "insider trading",
        "prohibition of trading",
        "trading in securities",
        "designated persons"

      ]
    )
  ) {

    found.add(
      "Trading / Insider"
    );

  }


  /*
   * DIVIDEND
   */

  if (
    matchesAny(
      text,
      [

        "dividend",
        "interim dividend",
        "final dividend",
        "special dividend"

      ]
    )
  ) {

    found.add(
      "Dividend"
    );

  }


  /*
   * AGM / EGM
   */

  if (
    matchesAny(
      text,
      [

        "annual general meeting",
        "agm",
        "extraordinary general meeting",
        "egm",
        "postal ballot"

      ]
    )
  ) {

    found.add(
      "AGM / EGM"
    );

  }


  /*
   * CREDIT RATING
   */

  if (
    matchesAny(
      text,
      [

        "credit rating",
        "rating reaffirmed",
        "rating upgraded",
        "rating downgraded",
        "rating assigned"

      ]
    )
  ) {

    found.add(
      "Credit Rating"
    );

  }


  /*
   * ACQUISITION
   */

  if (
    matchesAny(
      text,
      [

        "acquisition",
        "acquire",
        "acquired",
        "takeover"

      ]
    )
  ) {

    found.add(
      "Acquisition"
    );

  }


  /*
   * CORPORATE ACTION
   */

  if (
    matchesAny(
      text,
      [

        "corporate action",
        "record date",
        "ex-date",
        "stock split"

      ]
    )
  ) {

    found.add(
      "Corporate Action"
    );

  }


  /*
   * SHAREHOLDING
   */

  if (
    matchesAny(
      text,
      [

        "shareholding",
        "shareholding pattern",
        "promoter holding",
        "promoter group"

      ]
    )
  ) {

    found.add(
      "Shareholding"
    );

  }


  /*
   * ALLOTMENT
   */

  if (
    matchesAny(
      text,
      [

        "allotment",
        "shares allotted",
        "allotted shares"

      ]
    )
  ) {

    found.add(
      "Allotment"
    );

  }


  /*
   * APPOINTMENT / RESIGNATION
   */

  if (
    matchesAny(
      text,
      [

        "appointment",
        "appointed",
        "resignation",
        "resigned",
        "cessation"

      ]
    )
  ) {

    found.add(
      "Appointment / Resignation"
    );

  }


  /*
   * PRESS RELEASE
   */

  if (
    matchesAny(
      text,
      [

        "press release",
        "media release"

      ]
    )
  ) {

    found.add(
      "Press Release"
    );

  }


  /*
   * FUND RAISING
   */

  if (
    matchesAny(
      text,
      [

        "fund raising",
        "fundraising",
        "raise funds",
        "debt issue",
        "capital raising"

      ]
    )
  ) {

    found.add(
      "Fund Raising"
    );

  }


  /*
   * MERGER / AMALGAMATION
   */

  if (
    matchesAny(
      text,
      [

        "merger",
        "amalgamation",
        "scheme of amalgamation"

      ]
    )
  ) {

    found.add(
      "Merger / Amalgamation"
    );

  }


  /*
   * ORDER / CONTRACT
   */

  if (
    matchesAny(
      text,
      [

        "order received",
        "work order",
        "contract awarded",
        "order worth",
        "letter of award"

      ]
    )
  ) {

    found.add(
      "Order / Contract"
    );

  }


  /*
   * BUYBACK
   */

  if (
    matchesAny(
      text,
      [

        "buyback",
        "buy-back"

      ]
    )
  ) {

    found.add(
      "Buyback"
    );

  }


  /*
   * PREFERENTIAL ISSUE
   */

  if (
    matchesAny(
      text,
      [

        "preferential issue",
        "preferential allotment"

      ]
    )
  ) {

    found.add(
      "Preferential Issue"
    );

  }


  /*
   * RIGHTS ISSUE
   */

  if (
    matchesAny(
      text,
      [

        "rights issue",
        "rights offer"

      ]
    )
  ) {

    found.add(
      "Rights Issue"
    );

  }


  /*
   * BONUS
   */

  if (
    matchesAny(
      text,
      [

        "bonus issue",
        "bonus shares"

      ]
    )
  ) {

    found.add(
      "Bonus"
    );

  }


  /*
   * NEWSPAPER
   */

  if (
    matchesAny(
      text,
      [

        "newspaper advertisement",
        "newspaper publication",
        "advertisement in newspaper"

      ]
    )
  ) {

    found.add(
      "Newspaper Advertisement"
    );

  }


  /*
   * INVESTOR / ANALYST
   */

  if (
    matchesAny(
      text,
      [

        "investor meet",
        "investor meeting",
        "analyst meet",
        "analyst meeting",
        "investor presentation"

      ]
    )
  ) {

    found.add(
      "Investor / Analyst Meet"
    );

  }


  /*
   * SHAREHOLDER COMMUNICATION
   */

  if (
    matchesAny(
      text,
      [

        "shareholder communication",
        "communication to shareholders",
        "letter to shareholders"

      ]
    )
  ) {

    found.add(
      "Shareholder Communication"
    );

  }


  /*
   * Never hide an announcement.
   */

  if (
    found.size === 0
  ) {

    found.add(
      "Other"
    );

  }


  return Array.from(
    found
  );

}


/* ============================================================
   CONTENT FINGERPRINT
   ============================================================ */

/*
 * IMPORTANT CHANGE
 *
 * The fingerprint is based primarily on the
 * actual announcement content.
 *
 * We deliberately do NOT use GUID as the
 * primary duplicate identity.
 *
 * This allows multiple BSE RSS entries with
 * the same company + scrip + title +
 * description to collapse into ONE item.
 */

async function fingerprintFor(
  item
) {

  const company =
    cleanText(
      item.company
    )
      .toLowerCase();


  const scrip =
    cleanScrip(
      item.scrip
    );


  const title =
    cleanText(
      item.title
    )
      .toLowerCase();


  const description =
    cleanText(
      item.description
    )
      .toLowerCase();


  const content =
    [
      scrip,
      company,
      title,
      description
    ]
      .join("|");


  const bytes =
    new TextEncoder()
      .encode(
        content
      );


  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );


  return Array.from(
    new Uint8Array(
      hash
    )
  )
    .map(
      value =>
        value
          .toString(16)
          .padStart(
            2,
            "0"
          )
    )
    .join("");

}


/* ============================================================
   NORMALIZE ITEM
   ============================================================ */

async function normalizeItem(
  item
) {

  let scrip =
    cleanScrip(
      item.scrip
    );


  if (!scrip) {

    scrip =
      findScripInText(
        [
          item.title,
          item.description,
          item.company
        ]
          .filter(Boolean)
          .join(" ")
      );

  }


  const company =
    cleanText(
      item.company
    );


  const categories =
    classifyAnnouncement(
      item.title,
      item.description,
      item.category
    );


  const normalized = {

    title:
      cleanText(
        item.title
      ),

    description:
      cleanText(
        item.description
      ),

    link:
      cleanUrl(
        item.link
      ),

    guid:
      cleanText(
        item.guid
      ),

    pubDate:
      cleanText(
        item.pubDate
      ),

    company,

    scrip,

    category:
      categories[0] ||
      "Other",

    categories,

    feed:
      "Corporate Announcements",

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


/* ============================================================
   FETCH + NORMALIZE
   ============================================================ */

async function fetchAnnouncements() {

  const xml =
    await fetchBSEXML();


  const raw =
    extractRSSItems(
      xml
    );


  const result =
    [];


  const fingerprints =
    new Set();


  for (
    const item
    of raw
  ) {

    const normalized =
      await normalizeItem(
        item
      );


    if (
      !normalized.title &&
      !normalized.link
    ) {

      continue;

    }


    /*
     * Remove duplicates already present
     * inside the current RSS response.
     */

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


  /*
   * Newest first.
   */

  result.sort(
    (
      a,
      b
    ) => {

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
        (Number.isFinite(db)
          ? db
          : 0) -

        (Number.isFinite(da)
          ? da
          : 0)
      );

    }
  );


  return result;

}


/* ============================================================
   DAILY STORAGE
   ============================================================ */

async function getDayIndex(
  env,
  day
) {

  const kv =
    requireKV(env);

  const data =
    await kv.get(
      dayIndexKey(day),
      "json"
    );

  if (
    !data ||
    typeof data !== "object"
  ) {

    return {
      count: 0,
      chunks: 0,
      updatedAt: null
    };

  }


  return {

    count:
      Number(
        data.count || 0
      ),

    chunks:
      Number(
        data.chunks || 0
      ),

    updatedAt:
      data.updatedAt ||
      null

  };

}


/* ============================================================
   SAVE DAY INDEX
   ============================================================ */

async function saveDayIndex(
  env,
  day,
  index
) {

  const kv =
    requireKV(env);


  await kv.put(

    dayIndexKey(day),

    JSON.stringify({

      count:
        Number(
          index.count || 0
        ),

      chunks:
        Number(
          index.chunks || 0
        ),

      updatedAt:
        new Date().toISOString()

    }),

    {
      expirationTtl:
        DAY_TTL
    }

  );

}


/* ============================================================
   GET DAY FINGERPRINTS
   ============================================================ */

async function getDayFingerprints(
  env,
  day
) {

  const kv =
    requireKV(env);


  const data =
    await kv.get(
      dayFingerprintsKey(day),
      "json"
    );


  if (
    !Array.isArray(data)
  ) {

    return new Set();

  }


  return new Set(
    data
      .filter(Boolean)
      .slice(
        -MAX_FINGERPRINTS
      )
  );

}


/* ============================================================
   SAVE DAY FINGERPRINTS
   ============================================================ */

async function saveDayFingerprints(
  env,
  day,
  fingerprints
) {

  const kv =
    requireKV(env);


  const array =
    Array.from(
      fingerprints
    )
      .slice(
        -MAX_FINGERPRINTS
      );


  await kv.put(

    dayFingerprintsKey(day),

    JSON.stringify(
      array
    ),

    {
      expirationTtl:
        DAY_TTL
    }

  );

}


/* ============================================================
   READ CHUNK
   ============================================================ */

async function getDayChunk(
  env,
  day,
  number
) {

  const kv =
    requireKV(env);


  const data =
    await kv.get(
      dayChunkKey(
        day,
        number
      ),
      "json"
    );


  if (
    !Array.isArray(data)
  ) {

    return [];

  }


  return data;

}


/* ============================================================
   SAVE CHUNK
   ============================================================ */

async function saveDayChunk(
  env,
  day,
  number,
  items
) {

  const kv =
    requireKV(env);


  await kv.put(

    dayChunkKey(
      day,
      number
    ),

    JSON.stringify(
      items
    ),

    {
      expirationTtl:
        DAY_TTL
    }

  );

}


/* ============================================================
   LOAD TODAY'S ANNOUNCEMENTS
   ============================================================ */

async function loadTodayAnnouncements(
  env,
  day
) {

  const index =
    await getDayIndex(
      env,
      day
    );


  if (
    index.chunks <= 0
  ) {

    return [];

  }


  const all =
    [];


  for (
    let i = 0;
    i < index.chunks;
    i++
  ) {

    const chunk =
      await getDayChunk(
        env,
        day,
        i
      );


    if (
      chunk.length
    ) {

      all.push(
        ...chunk
      );

    }

  }


  return all;

}


/* ============================================================
   MERGE TODAY'S DATA
   ============================================================ */

async function mergeTodayAnnouncements(
  env,
  day,
  incoming
) {

  if (
    !Array.isArray(
      incoming
    ) ||
    incoming.length === 0
  ) {

    return {

      added:
        0,

      total:
        (
          await getDayIndex(
            env,
            day
          )
        ).count,

      chunks:
        (
          await getDayIndex(
            env,
            day
          )
        ).chunks

    };

  }


  const existing =
    await loadTodayAnnouncements(
      env,
      day
    );


  const existingMap =
    new Map();


  /*
   * Existing items first.
   */

  for (
    const item
    of existing
  ) {

    if (
      item &&
      item.fingerprint
    ) {

      existingMap.set(
        item.fingerprint,
        item
      );

    }

  }


  let added =
    0;


  /*
   * Incoming items replace nothing.
   *
   * They are only added if their
   * fingerprint does not already exist.
   */

  for (
    const item
    of incoming
  ) {

    if (
      !item ||
      !item.fingerprint
    ) {

      continue;

    }


    if (
      existingMap.has(
        item.fingerprint
      )
    ) {

      continue;

    }


    existingMap.set(
      item.fingerprint,
      item
    );


    added++;

  }


  /*
   * Newest first.
   */

  const merged =
    Array.from(
      existingMap.values()
    );


  merged.sort(
    (
      a,
      b
    ) => {

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
        (Number.isFinite(db)
          ? db
          : 0) -

        (Number.isFinite(da)
          ? da
          : 0)
      );

    }
  );


  /*
   * Write chunks.
   *
   * We rewrite only when new
   * announcements were added.
   */

  if (
    added > 0 ||
    existing.length === 0
  ) {

    const oldIndex =
      await getDayIndex(
        env,
        day
      );


    const newChunks =
      Math.ceil(
        merged.length /
        CHUNK_SIZE
      );


    /*
     * Save only chunks whose
     * contents have changed.
     *
     * For simplicity and reliability,
     * chunks are written when data
     * changed.
     */

    for (
      let i = 0;
      i < newChunks;
      i++
    ) {

      const start =
        i *
        CHUNK_SIZE;


      const chunk =
        merged.slice(
          start,
          start +
          CHUNK_SIZE
        );


      await saveDayChunk(
        env,
        day,
        i,
        chunk
      );

    }


    await saveDayIndex(
      env,
      day,
      {

        count:
          merged.length,

        chunks:
          newChunks

      }
    );

  }


  return {

    added,

    total:
      merged.length,

    chunks:
      Math.ceil(
        merged.length /
        CHUNK_SIZE
      )

  };

}


/* ============================================================
   WATCHLIST
   ============================================================ */

async function getWatchlist(
  env
) {

  const kv =
    requireKV(env);


  const data =
    await kv.get(
      WATCHLIST_KEY,
      "json"
    );


  if (
    !Array.isArray(data)
  ) {

    return [];

  }


  return data;

}


/* ============================================================
   SAVE WATCHLIST
   ============================================================ */

async function saveWatchlist(
  env,
  watchlist
) {

  const kv =
    requireKV(env);


  await kv.put(

    WATCHLIST_KEY,

    JSON.stringify(
      watchlist
    ),

    {
      expirationTtl:
        365 * 24 * 60 * 60
    }

  );


  return watchlist;

}


/* ============================================================
   NORMALIZE WATCHLIST ITEM
   ============================================================ */

function normalizeWatchItem(
  value
) {

  if (
    typeof value ===
    "string"
  ) {

    const scrip =
      cleanScrip(
        value
      );


    if (!scrip) {

      return null;

    }


    return {

      scrip,

      name:
        ""

    };

  }


  if (
    !value ||
    typeof value !==
    "object"
  ) {

    return null;

  }


  const scrip =
    cleanScrip(
      value.scrip ||
      value.scripCode ||
      value.code
    );


  if (!scrip) {

    return null;

  }


  return {

    scrip,

    name:
      cleanText(
        value.name ||
        value.company ||
        ""
      )

  };

}


/* ============================================================
   ADD WATCHLIST ITEM
   ============================================================ */

async function addWatchlist(
  env,
  input
) {

  const item =
    normalizeWatchItem(
      input
    );


  if (!item) {

    throw new Error(
      "Invalid BSE scrip."
    );

  }


  const current =
    await getWatchlist(
      env
    );


  const exists =
    current.some(
      x =>
        cleanScrip(
          x.scrip
        ) ===
        item.scrip
    );


  if (
    !exists
  ) {

    current.push(
      item
    );


    await saveWatchlist(
      env,
      current
    );

  }


  return {

    watchlist:
      current,

    added:
      !exists,

    item

  };

}


/* ============================================================
   REMOVE WATCHLIST ITEM
   ============================================================ */

async function removeWatchlist(
  env,
  scrip
) {

  const code =
    cleanScrip(
      scrip
    );


  if (!code) {

    throw new Error(
      "Invalid BSE scrip."
    );

  }


  const current =
    await getWatchlist(
      env
    );


  const filtered =
    current.filter(
      item =>
        cleanScrip(
          item.scrip
        ) !==
        code
    );


  const removed =
    filtered.length !==
    current.length;


  if (
    removed
  ) {

    await saveWatchlist(
      env,
      filtered
    );

  }


  return {

    watchlist:
      filtered,

    removed

  };

}


/* ============================================================
   WATCHLIST MATCH
   ============================================================ */

function announcementMatchesWatchlist(
  item,
  watchlist
) {

  if (
    !item ||
    !Array.isArray(
      watchlist
    )
  ) {

    return false;

  }


  const announcementScrip =
    cleanScrip(
      item.scrip
    );


  if (
    announcementScrip
  ) {

    return watchlist.some(
      watch =>
        cleanScrip(
          watch.scrip
        ) ===
        announcementScrip
    );

  }


  /*
   * Fallback:
   * search the announcement text
   * for a six-digit BSE code.
   */

  const text =
    [
      item.title,
      item.description,
      item.company
    ]
      .filter(Boolean)
      .join(" ");


  const found =
    findScripInText(
      text
    );


  if (!found) {

    return false;

  }


  return watchlist.some(
    watch =>
      cleanScrip(
        watch.scrip
      ) ===
      found
  );

}


/* ============================================================
   GET WATCHLIST NAME
   ============================================================ */

function watchName(
  item,
  watchlist
) {

  const code =
    cleanScrip(
      item.scrip
    );


  const match =
    watchlist.find(
      watch =>
        cleanScrip(
          watch.scrip
        ) ===
        code
    );


  return (
    match?.name ||
    item.company ||
    ""
  );

}


/* ============================================================
   ALERT STORAGE
   ============================================================ */

async function getAlertIndex(
  env
) {

  const kv =
    requireKV(env);


  const data =
    await kv.get(
      ALERT_INDEX_KEY,
      "json"
    );


  if (
    !Array.isArray(data)
  ) {

    return [];

  }


  return data;

}


/* ============================================================
   SAVE ALERT INDEX
   ============================================================ */

async function saveAlertIndex(
  env,
  alerts
) {

  const kv =
    requireKV(env);


  /*
   * Keep only recent alerts.
   */

  const now =
    Date.now();


  const cutoff =
    now -
    ALERT_TTL *
    1000;


  const clean =
    alerts
      .filter(
        alert => {

          const time =
            Date.parse(
              alert.createdAt ||
              alert.pubDate ||
              ""
            );


          /*
           * Keep an alert if its date
           * cannot be parsed. This prevents
           * accidental deletion.
           */

          if (
            !Number.isFinite(
              time
            )
          ) {

            return true;

          }


          return (
            time >=
            cutoff
          );

        }
      )
      .slice(
        0,
        MAX_ALERTS
      );


  await kv.put(

    ALERT_INDEX_KEY,

    JSON.stringify(
      clean
    ),

    {
      expirationTtl:
        ALERT_TTL
    }

  );


  return clean;

}


/* ============================================================
   NOTIFICATION DISPATCH (TELEGRAM & NTFY)
   ============================================================ */

async function sendNotification(
  env,
  alert
) {

  const message =
    `⭐ *BSE ALERT*\n` +
    `*Company:* ${alert.company || "Unknown"} (${alert.scrip || "N/A"})\n` +
    `*Category:* ${alert.category || "Other"}\n` +
    `*Title:* ${alert.title || "No Title"}\n` +
    (alert.link ? `\n[View Announcement](${alert.link})` : "");


  /*
   * TELEGRAM DISPATCH
   */

  if (
    env.TELEGRAM_BOT_TOKEN &&
    env.TELEGRAM_CHAT_ID
  ) {

    try {

      await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown",
            disable_web_page_preview: false
          })
        }
      );

    } catch (e) {

      console.error(
        "Telegram notification error:",
        e
      );

    }

  }


  /*
   * NTFY DISPATCH
   */

  if (
    env.NTFY_TOPIC
  ) {

    try {

      await fetch(
        `https://ntfy.sh/${env.NTFY_TOPIC}`,
        {
          method: "POST",

          headers: {
            "Title": `${alert.company || "BSE"} (${alert.scrip || "Alert"})`,
            "Priority": "high",
            "Tags": "star,chart_with_upwards_trend"
          },

          body: `${alert.title}\n${alert.link || ""}`
        }
      );

    } catch (e) {

      console.error(
        "ntfy notification error:",
        e
      );

    }

  }

}


/* ============================================================
   CREATE ALERT
   ============================================================ */

async function createAlert(
  env,
  item,
  watchlist
) {

  const kv =
    requireKV(env);


  if (
    !item ||
    !item.fingerprint
  ) {

    return false;

  }


  /*
   * Only whitelisted companies
   * can create alerts.
   */

  if (
    !announcementMatchesWatchlist(
      item,
      watchlist
    )
  ) {

    return false;

  }


  const key =
    alertKey(
      item.fingerprint
    );


  /*
   * Check whether this exact alert
   * already exists.
   *
   * This is one KV read and avoids
   * duplicate alert writes.
   */

  const already =
    await kv.get(
      key
    );


  if (
    already
  ) {

    return false;

  }


  const alert = {

    id:
      item.fingerprint,

    fingerprint:
      item.fingerprint,

    scrip:
      cleanScrip(
        item.scrip
      ),

    company:
      watchName(
        item,
        watchlist
      ),

    title:
      item.title,

    description:
      item.description,

    link:
      item.link,

    pubDate:
      item.pubDate,

    category:
      item.category,

    categories:
      Array.isArray(
        item.categories
      )
        ? item.categories
        : [],

    createdAt:
      new Date().toISOString()

  };


  /*
   * Write the actual alert.
   */

  await kv.put(

    key,

    JSON.stringify(
      alert
    ),

    {
      expirationTtl:
        ALERT_TTL
    }

  );


  /*
   * Send external notifications.
   */

  await sendNotification(
    env,
    alert
  );


  /*
   * Update the alert index.
   */

  const current =
    await getAlertIndex(
      env
    );


  /*
   * Remove an old copy if present.
   */

  const filtered =
    current.filter(
      existing =>
        existing &&
        existing.id !==
        alert.id
    );


  filtered.unshift(
    alert
  );


  /*
   * Save the compact index.
   */

  await saveAlertIndex(
    env,
    filtered
  );


  return true;

}


/* ============================================================
   GET ALERTS
   ============================================================ */

async function getAlerts(
  env
) {

  const alerts =
    await getAlertIndex(
      env
    );


  /*
   * Clean expired alerts when they
   * are read.
   */

  const clean =
    await saveAlertIndex(
      env,
      alerts
    );


  return clean;

}


/* ============================================================
   CLEAR ALERTS
   ============================================================ */

async function clearAlerts(
  env
) {

  const kv =
    requireKV(env);


  const alerts =
    await getAlertIndex(
      env
    );


  /*
   * Delete individual alert objects.
   *
   * This is normally a small number because
   * alerts are only generated for whitelist
   * companies.
   */

  for (
    const alert
    of alerts
  ) {

    if (
      alert &&
      alert.fingerprint
    ) {

      await kv.delete(
        alertKey(
          alert.fingerprint
        )
      );

    }

  }


  /*
   * Delete the index.
   */

  await kv.delete(
    ALERT_INDEX_KEY
  );


  return true;

}


/* ============================================================
   MONITOR STATE
   ============================================================ */

const MONITOR_STATE_KEY =
  "bse:monitor:state";


async function getMonitorState(
  env
) {

  const kv =
    requireKV(env);


  const state =
    await kv.get(
      MONITOR_STATE_KEY,
      "json"
    );


  if (
    !state ||
    typeof state !==
    "object"
  ) {

    return {

      initialized:
        false,

      lastRun:
        null,

      lastSuccess:
        null,

      lastError:
        null,

      totalRuns:
        0,

      totalAdded:
        0,

      totalAlerts:
        0

    };

  }


  return state;

}


/* ============================================================
   SAVE MONITOR STATE
   ============================================================ */

async function saveMonitorState(
  env,
  state
) {

  const kv =
    requireKV(env);


  /*
   * Monitor state has a long TTL.
   *
   * This is one small KV write per
   * successful monitor cycle.
   *
   * If we later want to reduce writes
   * even further, this can be changed
   * to only write when data changes.
   */

  await kv.put(

    MONITOR_STATE_KEY,

    JSON.stringify(
      state
    ),

    {
      expirationTtl:
        7 * 24 * 60 * 60
    }

  );

}


/* ============================================================
   MONITOR
   ============================================================ */

async function runMonitor(
  env
) {

  const startedAt =
    new Date();


  const day =
    indiaDate(
      startedAt
    );


  const state =
    await getMonitorState(
      env
    );


  const errors =
    [];


  let announcements =
    [];


  let fetchedCount =
    0;


  let addedToday =
    0;


  let alertsCreated =
    0;


  let whitelistMatches =
    0;


  try {

    /*
     * Fetch current BSE RSS.
     */

    announcements =
      await fetchAnnouncements();


    fetchedCount =
      announcements.length;


  } catch (
    error
  ) {

    const message =
      String(
        error?.message ||
        error
      );


    errors.push(
      message
    );


    state.lastRun =
      new Date().toISOString();

    state.lastError =
      message;

    state.totalRuns =
      Number(
        state.totalRuns || 0
      ) + 1;


    /*
     * One state write on failure.
     */

    try {

      await saveMonitorState(
        env,
        state
      );

    } catch (_) {}


    return {

      ok:
        false,

      monitored:
        false,

      baseline:
        Boolean(
          state.initialized
        ),

      announcements:
        0,

      watchlist:
        (
          await getWatchlist(
            env
          )
        ).length,

      newAnnouncements:
        0,

      newAlerts:
        0,

      errors

    };

  }


  /*
   * Load today's fingerprint index.
   */

  const fingerprints =
    await getDayFingerprints(
      env,
      day
    );


  /*
   * First run:
   *
   * Existing RSS is treated as baseline.
   *
   * We still store today's announcements,
   * but DO NOT create alerts for the
   * baseline.
   */

  const baseline =
    !state.initialized;


  /*
   * Determine which items are genuinely
   * new since the previous monitor cycle.
   */

  const newItems =
    [];


  for (
    const item
    of announcements
  ) {

    if (
      !item ||
      !item.fingerprint
    ) {

      continue;

    }


    if (
      fingerprints.has(
        item.fingerprint
      )
    ) {

      continue;

    }


    fingerprints.add(
      item.fingerprint
    );


    newItems.push(
      item
    );

  }


  /*
   * Store today's fingerprint index
   * only when new fingerprints were
   * found.
   */

  if (
    newItems.length > 0
  ) {

    await saveDayFingerprints(
      env,
      day,
      fingerprints
    );

  }


  /*
   * Merge today's announcements.
   *
   * This removes duplicates automatically.
   */

  if (
    newItems.length > 0
  ) {

    const merged =
      await mergeTodayAnnouncements(
        env,
        day,
        newItems
      );


    addedToday =
      merged.added;

  }


  /*
   * Watchlist.
   */

  const watchlist =
    await getWatchlist(
      env
    );


  /*
   * Never create alerts during the
   * initial baseline.
   */

  if (
    !baseline &&
    watchlist.length > 0 &&
    newItems.length > 0
  ) {

    for (
      const item
      of newItems
    ) {

      if (
        !announcementMatchesWatchlist(
          item,
          watchlist
        )
      ) {

        continue;

      }


      whitelistMatches++;


      try {

        const created =
          await createAlert(
            env,
            item,
            watchlist
          );


        if (
          created
        ) {

          alertsCreated++;

        }

      } catch (
        error
      ) {

        errors.push(
          String(
            error?.message ||
            error
          )
        );

      }

    }

  }


  /*
   * Mark monitor initialized.
   */

  state.initialized =
    true;

  state.lastRun =
    new Date().toISOString();

  state.lastSuccess =
    new Date().toISOString();

  state.lastError =
    errors.length
      ? errors.join(
          "; "
        )
      : null;

  state.totalRuns =
    Number(
      state.totalRuns || 0
    ) + 1;

  state.totalAdded =
    Number(
      state.totalAdded || 0
    ) +
    addedToday;

  state.totalAlerts =
    Number(
      state.totalAlerts || 0
    ) +
    alertsCreated;


  /*
   * Save monitor state once.
   */

  await saveMonitorState(
    env,
    state
  );


  /*
   * Read total current-day count.
   */

  const dayIndex =
    await getDayIndex(
      env,
      day
    );


  return {

    ok:
      errors.length === 0,

    monitored:
      true,

    baseline,

    announcements:
      fetchedCount,

    watchlist:
      watchlist.length,

    newAnnouncements:
      newItems.length,

    addedToday,

    totalToday:
      dayIndex.count,

    chunks:
      dayIndex.chunks,

    whitelistMatches,

    alertsCreated,

    newAlerts:
      alertsCreated,

    errors,

    date:
      day,

    time:
      indiaTime(
        startedAt
      )

  };

}


/* ============================================================
   GET REQUEST HELPERS
   ============================================================ */

function getQuery(
  request,
  name
) {

  const url =
    new URL(
      request.url
    );

  return (
    url.searchParams.get(
      name
    ) || ""
  ).trim();

}


/* ============================================================
   REQUEST BODY
   ============================================================ */

async function readJSON(
  request
) {

  try {

    return await request.json();

  } catch (_) {

    return {};

  }

}


/* ============================================================
   CATEGORY SUMMARY
   ============================================================ */

function buildCategorySummary(
  announcements
) {

  const counts =
    new Map();


  for (
    const item
    of announcements
  ) {

    const categories =
      Array.isArray(
        item.categories
      ) &&
      item.categories.length

        ? item.categories

        : [
            item.category ||
            "Other"
          ];


    /*
     * An announcement can belong
     * to more than one category.
     */

    for (
      const category
      of categories
    ) {

      const name =
        String(
          category ||
          "Other"
        ).trim();


      counts.set(
        name,
        (
          counts.get(
            name
          ) || 0
        ) + 1
      );

    }

  }


  return Array.from(
    counts.entries()
  )
    .map(
      (
        [name, count]
      ) => ({
        name,
        count
      })
    )
    .sort(
      (
        a,
        b
      ) =>
        b.count -
        a.count
    );

}


/* ============================================================
   FILTER ANNOUNCEMENTS
   ============================================================ */

function filterAnnouncements(
  announcements,
  request
) {

  const category =
    getQuery(
      request,
      "category"
    );


  const scrip =
    cleanScrip(
      getQuery(
        request,
        "scrip"
      )
    );


  const limitRaw =
    Number(
      getQuery(
        request,
        "limit"
      ) || 0
    );


  const limit =
    Number.isFinite(
      limitRaw
    ) &&
    limitRaw > 0

      ? Math.min(
          limitRaw,
          5000
        )

      : 5000;


  let result =
    announcements;


  /*
   * Category filtering.
   */

  if (
    category &&
    category.toLowerCase() !==
      "all"
  ) {

    const wanted =
      category.toLowerCase();


    result =
      result.filter(
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
              String(
                value
              )
                .toLowerCase() ===
              wanted
          );

        }
      );

  }


  /*
   * Scrip filtering.
   */

  if (
    scrip
  ) {

    result =
      result.filter(
        item =>
          cleanScrip(
            item.scrip
          ) ===
          scrip
      );

  }


  return result.slice(
    0,
    limit
  );

}


/* ============================================================
   BSE ANNOUNCEMENTS ENDPOINT
   ============================================================ */

async function handleBSEAnnouncements(
  env,
  request
) {

  const day =
    indiaDate();


  const announcements =
    await loadTodayAnnouncements(
      env,
      day
    );


  const filtered =
    filterAnnouncements(
      announcements,
      request
    );


  const categories =
    buildCategorySummary(
      announcements
    );


  return json({

    ok:
      true,

    source:
      "BSE Corporate Announcements RSS",

    date:
      day,

    allCount:
      announcements.length,

    count:
      filtered.length,

    categories,

    announcements:
      filtered

  });

}


/* ============================================================
   CATEGORIES ENDPOINT
   ============================================================ */

async function handleCategories(
  env
) {

  const day =
    indiaDate();


  const announcements =
    await loadTodayAnnouncements(
      env,
      day
    );


  const categories =
    buildCategorySummary(
      announcements
    );


  return json({

    ok:
      true,

    source:
      "BSE Corporate Announcements RSS",

    date:
      day,

    allCount:
      announcements.length,

    categories

  });

}


/* ============================================================
   WATCHLIST GET
   ============================================================ */

async function handleWatchlistGet(
  env
) {

  const watchlist =
    await getWatchlist(
      env
    );


  return json({

    ok:
      true,

    watchlist,

    count:
      watchlist.length

  });

}


/* ============================================================
   WATCHLIST POST
   ============================================================ */

async function handleWatchlistPost(
  env,
  request
) {

  const body =
    await readJSON(
      request
    );


  /*
   * Accept several frontend formats.
   */

  const input =
    body.item ||
    body.company ||
    body.scrip ||
    body;


  const result =
    await addWatchlist(
      env,
      input
    );


  return json({

    ok:
      true,

    added:
      result.added,

    item:
      result.item,

    watchlist:
      result.watchlist,

    count:
      result.watchlist.length

  });

}


/* ============================================================
   WATCHLIST DELETE
   ============================================================ */

async function handleWatchlistDelete(
  env,
  request
) {

  const scrip =
    getQuery(
      request,
      "scrip"
    );


  let code =
    scrip;


  /*
   * Also accept JSON body.
   */

  if (!code) {

    const body =
      await readJSON(
        request
      );


    code =
      body.scrip ||
      body.scripCode ||
      "";

  }


  const result =
    await removeWatchlist(
      env,
      code
    );


  return json({

    ok:
      true,

    removed:
      result.removed,

    watchlist:
      result.watchlist,

    count:
      result.watchlist.length

  });

}


/* ============================================================
   ALERTS ENDPOINT
   ============================================================ */

async function handleAlerts(
  env,
  request
) {

  let alerts =
    await getAlerts(
      env
    );


  const scrip =
    cleanScrip(
      getQuery(
        request,
        "scrip"
      )
    );


  const category =
    getQuery(
      request,
      "category"
    );


  if (
    scrip
  ) {

    alerts =
      alerts.filter(
        alert =>
          cleanScrip(
            alert.scrip
          ) ===
          scrip
      );

  }


  if (
    category &&
    category.toLowerCase() !==
      "all"
  ) {

    const wanted =
      category.toLowerCase();


    alerts =
      alerts.filter(
        alert => {

          const categories =
            Array.isArray(
              alert.categories
            )
              ? alert.categories
              : [
                  alert.category ||
                  "Other"
                ];


          return categories.some(
            value =>
              String(
                value
              )
                .toLowerCase() ===
              wanted
          );

        }
      );

  }


  return json({

    ok:
      true,

    bundle:
      "Alerts / Special Bundle",

    count:
      alerts.length,

    alerts

  });

}


/* ============================================================
   CLEAR ALERTS ENDPOINT
   ============================================================ */

async function handleClearAlerts(
  env,
  request
) {

  /*
   * Require explicit confirmation.
   *
   * This prevents accidental deletion
   * from a simple GET request.
   */

  const confirm =
    getQuery(
      request,
      "confirm"
    );


  if (
    confirm !==
    "yes"
  ) {

    return json({

      ok:
        false,

      error:
        "Use ?confirm=yes to clear alerts."

    }, 400);

  }


  await clearAlerts(
    env
  );


  return json({

    ok:
      true,

    message:
      "Alerts cleared."

  });

}


/* ============================================================
   TEST ALERT ENDPOINT
   ============================================================ */

async function handleTestAlert(
  env
) {

  const mockAlert = {
    company: "Test Company",
    scrip: "000000",
    category: "Test Category",
    title: "This is a test notification from BSE RSS Reader",
    link: "https://www.bseindia.com"
  };

  await sendNotification(
    env,
    mockAlert
  );

  return json({
    ok: true,
    message: "Test notification dispatched to configured channels."
  });

}


/* ============================================================
   FETCH ROUTER
   ============================================================ */

export default {

  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {

      return new Response(null, {
        headers: CORS_HEADERS
      });

    }


    const url =
      new URL(request.url);

    const path =
      url.pathname;


    try {

      if (path === "/" || path === "/bse-announcements") {
        return await handleBSEAnnouncements(env, request);
      }

      if (path === "/categories") {
        return await handleCategories(env);
      }

      if (path === "/watchlist") {

        if (request.method === "POST") {
          return await handleWatchlistPost(env, request);
        }

        if (request.method === "DELETE") {
          return await handleWatchlistDelete(env, request);
        }

        return await handleWatchlistGet(env);
      }

      if (path === "/alerts") {
        return await handleAlerts(env, request);
      }

      if (path === "/alerts/clear") {
        return await handleClearAlerts(env, request);
      }

      if (path === "/monitor") {
        const result = await runMonitor(env);
        return json(result);
      }

      if (path === "/test-alert") {
        return await handleTestAlert(env);
      }

      return json({
        ok: false,
        error: "Route not found"
      }, 404);

    } catch (error) {

      return json({
        ok: false,
        error: String(error?.message || error)
      }, 500);

    }

  },


  /* ============================================================
     CRON TRIGGER HANDLER
     ============================================================ */

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runMonitor(env)
    );

  }

};