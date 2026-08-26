/*
 * BSE RSS READER WORKER
 * Incremental current-day storage
 *
 * Storage:
 *   Cloudflare KV binding: BSC_DATA
 *
 * Cron:
 *   Every minute
 *
 * Main feed:
 *   BSE Corporate Announcements RSS
 */

const CORPORATE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";


/* ============================================================
   SETTINGS
   ============================================================ */

/*
 * Keep only today's announcements.
 *
 * We use IST for the day boundary because BSE is India-based.
 */

const INDIA_TIMEZONE =
  "Asia/Kolkata";


/*
 * KV chunks prevent one huge KV value.
 *
 * Each chunk contains a manageable number
 * of announcements.
 */

const CHUNK_SIZE =
  250;


/*
 * Maximum number of chunks we are willing
 * to keep for one day.
 *
 * This is NOT a limit on daily announcements.
 *
 * It only protects the Worker from an
 * accidental runaway storage situation.
 */

const MAX_CHUNKS_PER_DAY =
  500;


/*
 * Current-day announcement retention.
 *
 * One day plus a small safety margin.
 */

const DAY_TTL_SECONDS =
  36 * 60 * 60;


/*
 * Alert retention.
 *
 * Alerts can remain slightly longer than
 * the daily announcement dataset.
 */

const ALERT_TTL_SECONDS =
  5 * 24 * 60 * 60;


/*
 * Duplicate fingerprints.
 *
 * Kept only for the current day.
 */

const SEEN_TTL_SECONDS =
  36 * 60 * 60;


/*
 * Maximum alerts returned to frontend
 * in one request.
 */

const MAX_ALERTS_RETURNED =
  500;


/* ============================================================
   CORS
   ============================================================ */

const CORS_HEADERS = {

  "Access-Control-Allow-Origin":
    "*",

  "Access-Control-Allow-Methods":
    "GET,POST,DELETE,OPTIONS",

  "Access-Control-Allow-Headers":
    "Content-Type",

  "Content-Type":
    "application/json; charset=utf-8",

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

      headers:
        CORS_HEADERS,

    }

  );
}


/* ============================================================
   XML TAG READER
   ============================================================ */

function xmlTag(
  xml,
  tag
) {

  const pattern =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );


  const match =
    String(
      xml || ""
    )
      .match(
        pattern
      );


  if (
    !match
  ) {

    return "";
  }


  return decodeXML(
    match[1]
  )
    .trim();
}


/* ============================================================
   XML DECODE
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
      " "
    );
}


/* ============================================================
   FETCH XML
   ============================================================ */

async function fetchXML(
  url
) {

  const response =
    await fetch(
      url,
      {
        method:
          "GET",

        headers: {

          "Accept":
            "application/rss+xml, application/xml, text/xml, */*",

          "User-Agent":
            "BSE-RSS-Reader/1.0",

        },

        cf: {

          cacheTtl:
            0,

          cacheEverything:
            false,

        },

      }
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `BSE RSS HTTP ${response.status}`
    );
  }


  return await response.text();
}


/* ============================================================
   INDIA DATE
   ============================================================ */

function getIndiaDate(
  date = new Date()
) {

  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone:
        INDIA_TIMEZONE,

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit",

    }
  )
    .format(
      date
    );
}


/* ============================================================
   INDIA TIME
   ============================================================ */

function getIndiaTime(
  date = new Date()
) {

  return new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone:
        INDIA_TIMEZONE,

      hour:
        "2-digit",

      minute:
        "2-digit",

      second:
        "2-digit",

      hour12:
        false,

    }
  )
    .format(
      date
    );
}


/* ============================================================
   DAY PREFIX
   ============================================================ */

function dayPrefix(
  dateString
) {

  return `bse:day:${dateString}`;
}


/* ============================================================
   DAY INDEX KEY
   ============================================================ */

function dayIndexKey(
  dateString
) {

  return `${dayPrefix(dateString)}:index`;
}


/* ============================================================
   DAY CHUNK KEY
   ============================================================ */

function dayChunkKey(
  dateString,
  chunkNumber
) {

  return `${dayPrefix(dateString)}:chunk:${String(
    chunkNumber
  ).padStart(
    5,
    "0"
  )}`;
}


/* ============================================================
   SEEN KEY
   ============================================================ */

function seenKey(
  dateString,
  fingerprint
) {

  return `${dayPrefix(dateString)}:seen:${fingerprint}`;
}


/* ============================================================
   WATCHLIST KEY
   ============================================================ */

const WATCHLIST_KEY =
  "bse:watchlist:v3";


/* ============================================================
   ALERT INDEX KEY
   ============================================================ */

const ALERT_INDEX_KEY =
  "bse:alerts:index:v3";


/* ============================================================
   ALERT KEY
   ============================================================ */

function alertKey(
  fingerprint
) {

  return `bse:alert:v3:${fingerprint}`;
}
/* ============================================================
   PARSE RSS ITEMS
   ============================================================ */

function extractRSSItems(
  xml
) {

  const items =
    [];

  const matches =
    String(
      xml || ""
    )
      .match(
        /<item\b[\s\S]*?<\/item>/gi
      ) ||
    [];


  for (
    const itemXML of matches
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


    /*
     * BSE RSS can contain different
     * field names depending on feed/version.
     */
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


    /*
     * Some BSE feeds use enclosure
     * for the announcement document.
     */
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


    /*
     * Keep any useful BSE-specific fields
     * that may be present.
     */
    const attachment =
      xmlTag(
        itemXML,
        "attachment"
      ) ||
      xmlTag(
        itemXML,
        "pdf"
      ) ||
      xmlTag(
        itemXML,
        "document"
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
        cleanUrl(
          link ||
          enclosure ||
          attachment
        ),

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
        "Corporate Announcements",

    };


    /*
     * Don't keep completely empty RSS
     * entries.
     */
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
   TEXT CLEANING
   ============================================================ */

function cleanText(
  value
) {

  return String(
    value ||
    ""
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


/* ============================================================
   URL CLEANING
   ============================================================ */

function cleanUrl(
  value
) {

  const text =
    String(
      value ||
      ""
    )
      .trim();


  if (
    !text
  ) {

    return "";
  }


  return text
    .replace(
      /&amp;/gi,
      "&"
    );
}


/* ============================================================
   SCRIP CLEANING
   ============================================================ */

function cleanScrip(
  value
) {

  const text =
    String(
      value ||
      ""
    )
      .trim();


  if (
    !text
  ) {

    return "";
  }


  /*
   * BSE scrips are normally numeric.
   * Preserve leading zeroes.
   */
  const match =
    text.match(
      /\b\d{6}\b/
    );


  if (
    match
  ) {

    return match[0];
  }


  return text;
}


/* ============================================================
   FETCH CORPORATE ANNOUNCEMENTS
   ============================================================ */

async function fetchBSEAnnouncements() {

  const xml =
    await fetchXML(
      CORPORATE_ANNOUNCEMENTS_URL
    );


  const items =
    extractRSSItems(
      xml
    );


  /*
   * Normalize and classify every item.
   */
  const result =
    [];


  const fingerprints =
    new Set();


  for (
    const item of items
  ) {

    const normalized =
      normalizeAnnouncement(
        item
      );


    if (
      !normalized
    ) {

      continue;
    }


    /*
     * Remove duplicates already present
     * inside the RSS response itself.
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


  return result;
}


/* ============================================================
   NORMALIZE ANNOUNCEMENT
   ============================================================ */

async function normalizeAnnouncement(
  item
) {

  const text = [

    item.title,

    item.description,

    item.company,

    item.category,

  ]
    .join(
      " "
    )
    .toLowerCase();


  const categories =
    classifyAnnouncement(
      text,
      item.category
    );


  const primaryCategory =
    categories[0] ||
    "Other";


  const normalized = {

    ...item,

    category:
      primaryCategory,

    categories,

    isFinancialResult:
      categories.includes(
        "Financial Results"
      ),

    receivedAt:
      new Date()
        .toISOString(),

  };


  normalized.fingerprint =
    await createFingerprint(
      normalized
    );


  return normalized;
}


/* ============================================================
   CLASSIFICATION
   ============================================================ */

function classifyAnnouncement(
  text,
  suppliedCategory
) {

  const found =
    new Set();


  const category =
    String(
      suppliedCategory ||
      ""
    )
      .trim();


  /*
   * Preserve an explicit BSE category
   * when it is available.
   */
  if (
    category
  ) {

    const mapped =
      mapBSECategory(
        category
      );


    if (
      mapped
    ) {

      found.add(
        mapped
      );
    }
  }


  /*
   * Financial Results
   *
   * Important:
   * We deliberately include related
   * result announcements, not only the
   * exact phrase "financial results".
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

        "quarterly results",

        "quarterly result",

        "results for the quarter",

        "results for quarter",

        "results for the period",

        "financial statement",

        "financial statements",

        "earnings results",

        "results announcement",

      ]
    )
  ) {

    found.add(
      "Financial Results"
    );
  }


  /*
   * Board Meeting
   */
  if (
    matchesAny(
      text,
      [

        "board meeting",

        "meeting of board",

        "board of directors",

      ]
    )
  ) {

    found.add(
      "Board Meeting"
    );
  }


  /*
   * Trading / Insider
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

        "designated persons",

      ]
    )
  ) {

    found.add(
      "Trading / Insider"
    );
  }


  /*
   * Dividend
   */
  if (
    matchesAny(
      text,
      [

        "dividend",

        "interim dividend",

        "final dividend",

        "special dividend",

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

        "postal ballot",

      ]
    )
  ) {

    found.add(
      "AGM / EGM"
    );
  }


  /*
   * Credit Rating
   */
  if (
    matchesAny(
      text,
      [

        "credit rating",

        "rating reaffirmed",

        "rating upgraded",

        "rating downgraded",

        "rating assigned",

      ]
    )
  ) {

    found.add(
      "Credit Rating"
    );
  }


  /*
   * Acquisition
   */
  if (
    matchesAny(
      text,
      [

        "acquisition",

        "acquire",

        "acquired",

        "takeover",

      ]
    )
  ) {

    found.add(
      "Acquisition"
    );
  }


  /*
   * Corporate Action
   */
  if (
    matchesAny(
      text,
      [

        "corporate action",

        "record date",

        "ex-date",

        "split",

        "stock split",

      ]
    )
  ) {

    found.add(
      "Corporate Action"
    );
  }


  /*
   * Shareholding
   */
  if (
    matchesAny(
      text,
      [

        "shareholding",

        "shareholding pattern",

        "promoter holding",

        "promoter group",

      ]
    )
  ) {

    found.add(
      "Shareholding"
    );
  }


  /*
   * Allotment
   */
  if (
    matchesAny(
      text,
      [

        "allotment",

        "shares allotted",

        "allotted shares",

      ]
    )
  ) {

    found.add(
      "Allotment"
    );
  }


  /*
   * Appointment / Resignation
   */
  if (
    matchesAny(
      text,
      [

        "appointment",

        "appointed",

        "resignation",

        "resigned",

        "cessation",

      ]
    )
  ) {

    found.add(
      "Appointment / Resignation"
    );
  }


  /*
   * Press Release
   */
  if (
    matchesAny(
      text,
      [

        "press release",

        "media release",

      ]
    )
  ) {

    found.add(
      "Press Release"
    );
  }


  /*
   * Fund Raising
   */
  if (
    matchesAny(
      text,
      [

        "fund raising",

        "fundraising",

        "raise funds",

        "debt issue",

        "capital raising",

      ]
    )
  ) {

    found.add(
      "Fund Raising"
    );
  }


  /*
   * Merger
   */
  if (
    matchesAny(
      text,
      [

        "merger",

        "amalgamation",

        "scheme of amalgamation",

      ]
    )
  ) {

    found.add(
      "Merger / Amalgamation"
    );
  }


  /*
   * Order / Contract
   */
  if (
    matchesAny(
      text,
      [

        "order received",

        "work order",

        "contract awarded",

        "order worth",

        "letter of award",

      ]
    )
  ) {

    found.add(
      "Order / Contract"
    );
  }


  /*
   * Buyback
   */
  if (
    matchesAny(
      text,
      [

        "buyback",

        "buy-back",

      ]
    )
  ) {

    found.add(
      "Buyback"
    );
  }


  /*
   * Preferential Issue
   */
  if (
    matchesAny(
      text,
      [

        "preferential issue",

        "preferential allotment",

      ]
    )
  ) {

    found.add(
      "Preferential Issue"
    );
  }


  /*
   * Rights Issue
   */
  if (
    matchesAny(
      text,
      [

        "rights issue",

        "rights offer",

      ]
    )
  ) {

    found.add(
      "Rights Issue"
    );
  }


  /*
   * Bonus
   */
  if (
    matchesAny(
      text,
      [

        "bonus issue",

        "bonus shares",

      ]
    )
  ) {

    found.add(
      "Bonus"
    );
  }


  /*
   * Newspaper Advertisement
   */
  if (
    matchesAny(
      text,
      [

        "newspaper advertisement",

        "newspaper publication",

        "advertisement in newspaper",

      ]
    )
  ) {

    found.add(
      "Newspaper Advertisement"
    );
  }


  /*
   * Investor / Analyst Meet
   */
  if (
    matchesAny(
      text,
      [

        "investor meet",

        "investor meeting",

        "analyst meet",

        "analyst meeting",

        "investor presentation",

      ]
    )
  ) {

    found.add(
      "Investor / Analyst Meet"
    );
  }


  /*
   * Shareholder Communication
   */
  if (
    matchesAny(
      text,
      [

        "shareholder communication",

        "communication to shareholders",

        "letter to shareholders",

      ]
    )
  ) {

    found.add(
      "Shareholder Communication"
    );
  }


  /*
   * If nothing matched, retain the
   * announcement instead of hiding it.
   */
  if (
    found.size ===
    0
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
   CATEGORY HELPERS
   ============================================================ */

function matchesAny(
  text,
  words
) {

  const value =
    String(
      text ||
      ""
    )
      .toLowerCase();


  return words.some(
    word =>
      value.includes(
        String(
          word
        )
          .toLowerCase()
      )
  );
}


function mapBSECategory(
  category
) {

  const value =
    String(
      category ||
      ""
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
      "Shareholder Communication",

  };


  return map[
    value
  ] || null;
}


/* ============================================================
   FINGERPRINT
   ============================================================ */

async function createFingerprint(
  item
) {

  /*
   * Prefer BSE GUID when available.
   */
  const source =
    item.guid ||
    item.link ||
    [

      item.scrip,

      item.company,

      item.title,

      item.pubDate,

    ]
      .join(
        "|"
      );


  const data =
    new TextEncoder()
      .encode(
        String(
          source
        )
      );


  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );


  return Array.from(
    new Uint8Array(
      hash
    )
  )
    .map(
      byte =>
        byte
          .toString(
            16
          )
          .padStart(
            2,
            "0"
          )
    )
    .join(
      ""
    );
}

/* ============================================================
   PARSE RSS ITEMS
   ============================================================ */

function extractRSSItems(
  xml
) {

  const items =
    [];

  const matches =
    String(
      xml || ""
    )
      .match(
        /<item\b[\s\S]*?<\/item>/gi
      ) ||
    [];


  for (
    const itemXML of matches
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


    /*
     * BSE RSS can contain different
     * field names depending on feed/version.
     */
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


    /*
     * Some BSE feeds use enclosure
     * for the announcement document.
     */
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


    /*
     * Keep any useful BSE-specific fields
     * that may be present.
     */
    const attachment =
      xmlTag(
        itemXML,
        "attachment"
      ) ||
      xmlTag(
        itemXML,
        "pdf"
      ) ||
      xmlTag(
        itemXML,
        "document"
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
        cleanUrl(
          link ||
          enclosure ||
          attachment
        ),

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
        "Corporate Announcements",

    };


    /*
     * Don't keep completely empty RSS
     * entries.
     */
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
   TEXT CLEANING
   ============================================================ */

function cleanText(
  value
) {

  return String(
    value ||
    ""
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


/* ============================================================
   URL CLEANING
   ============================================================ */

function cleanUrl(
  value
) {

  const text =
    String(
      value ||
      ""
    )
      .trim();


  if (
    !text
  ) {

    return "";
  }


  return text
    .replace(
      /&amp;/gi,
      "&"
    );
}


/* ============================================================
   SCRIP CLEANING
   ============================================================ */

function cleanScrip(
  value
) {

  const text =
    String(
      value ||
      ""
    )
      .trim();


  if (
    !text
  ) {

    return "";
  }


  /*
   * BSE scrips are normally numeric.
   * Preserve leading zeroes.
   */
  const match =
    text.match(
      /\b\d{6}\b/
    );


  if (
    match
  ) {

    return match[0];
  }


  return text;
}


/* ============================================================
   FETCH CORPORATE ANNOUNCEMENTS
   ============================================================ */

async function fetchBSEAnnouncements() {

  const xml =
    await fetchXML(
      CORPORATE_ANNOUNCEMENTS_URL
    );


  const items =
    extractRSSItems(
      xml
    );


  /*
   * Normalize and classify every item.
   */
  const result =
    [];


  const fingerprints =
    new Set();


  for (
    const item of items
  ) {

    const normalized =
      normalizeAnnouncement(
        item
      );


    if (
      !normalized
    ) {

      continue;
    }


    /*
     * Remove duplicates already present
     * inside the RSS response itself.
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


  return result;
}


/* ============================================================
   NORMALIZE ANNOUNCEMENT
   ============================================================ */

async function normalizeAnnouncement(
  item
) {

  const text = [

    item.title,

    item.description,

    item.company,

    item.category,

  ]
    .join(
      " "
    )
    .toLowerCase();


  const categories =
    classifyAnnouncement(
      text,
      item.category
    );


  const primaryCategory =
    categories[0] ||
    "Other";


  const normalized = {

    ...item,

    category:
      primaryCategory,

    categories,

    isFinancialResult:
      categories.includes(
        "Financial Results"
      ),

    receivedAt:
      new Date()
        .toISOString(),

  };


  normalized.fingerprint =
    await createFingerprint(
      normalized
    );


  return normalized;
}


/* ============================================================
   CLASSIFICATION
   ============================================================ */

function classifyAnnouncement(
  text,
  suppliedCategory
) {

  const found =
    new Set();


  const category =
    String(
      suppliedCategory ||
      ""
    )
      .trim();


  /*
   * Preserve an explicit BSE category
   * when it is available.
   */
  if (
    category
  ) {

    const mapped =
      mapBSECategory(
        category
      );


    if (
      mapped
    ) {

      found.add(
        mapped
      );
    }
  }


  /*
   * Financial Results
   *
   * Important:
   * We deliberately include related
   * result announcements, not only the
   * exact phrase "financial results".
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

        "quarterly results",

        "quarterly result",

        "results for the quarter",

        "results for quarter",

        "results for the period",

        "financial statement",

        "financial statements",

        "earnings results",

        "results announcement",

      ]
    )
  ) {

    found.add(
      "Financial Results"
    );
  }


  /*
   * Board Meeting
   */
  if (
    matchesAny(
      text,
      [

        "board meeting",

        "meeting of board",

        "board of directors",

      ]
    )
  ) {

    found.add(
      "Board Meeting"
    );
  }


  /*
   * Trading / Insider
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

        "designated persons",

      ]
    )
  ) {

    found.add(
      "Trading / Insider"
    );
  }


  /*
   * Dividend
   */
  if (
    matchesAny(
      text,
      [

        "dividend",

        "interim dividend",

        "final dividend",

        "special dividend",

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

        "postal ballot",

      ]
    )
  ) {

    found.add(
      "AGM / EGM"
    );
  }


  /*
   * Credit Rating
   */
  if (
    matchesAny(
      text,
      [

        "credit rating",

        "rating reaffirmed",

        "rating upgraded",

        "rating downgraded",

        "rating assigned",

      ]
    )
  ) {

    found.add(
      "Credit Rating"
    );
  }


  /*
   * Acquisition
   */
  if (
    matchesAny(
      text,
      [

        "acquisition",

        "acquire",

        "acquired",

        "takeover",

      ]
    )
  ) {

    found.add(
      "Acquisition"
    );
  }


  /*
   * Corporate Action
   */
  if (
    matchesAny(
      text,
      [

        "corporate action",

        "record date",

        "ex-date",

        "split",

        "stock split",

      ]
    )
  ) {

    found.add(
      "Corporate Action"
    );
  }


  /*
   * Shareholding
   */
  if (
    matchesAny(
      text,
      [

        "shareholding",

        "shareholding pattern",

        "promoter holding",

        "promoter group",

      ]
    )
  ) {

    found.add(
      "Shareholding"
    );
  }


  /*
   * Allotment
   */
  if (
    matchesAny(
      text,
      [

        "allotment",

        "shares allotted",

        "allotted shares",

      ]
    )
  ) {

    found.add(
      "Allotment"
    );
  }


  /*
   * Appointment / Resignation
   */
  if (
    matchesAny(
      text,
      [

        "appointment",

        "appointed",

        "resignation",

        "resigned",

        "cessation",

      ]
    )
  ) {

    found.add(
      "Appointment / Resignation"
    );
  }


  /*
   * Press Release
   */
  if (
    matchesAny(
      text,
      [

        "press release",

        "media release",

      ]
    )
  ) {

    found.add(
      "Press Release"
    );
  }


  /*
   * Fund Raising
   */
  if (
    matchesAny(
      text,
      [

        "fund raising",

        "fundraising",

        "raise funds",

        "debt issue",

        "capital raising",

      ]
    )
  ) {

    found.add(
      "Fund Raising"
    );
  }


  /*
   * Merger
   */
  if (
    matchesAny(
      text,
      [

        "merger",

        "amalgamation",

        "scheme of amalgamation",

      ]
    )
  ) {

    found.add(
      "Merger / Amalgamation"
    );
  }


  /*
   * Order / Contract
   */
  if (
    matchesAny(
      text,
      [

        "order received",

        "work order",

        "contract awarded",

        "order worth",

        "letter of award",

      ]
    )
  ) {

    found.add(
      "Order / Contract"
    );
  }


  /*
   * Buyback
   */
  if (
    matchesAny(
      text,
      [

        "buyback",

        "buy-back",

      ]
    )
  ) {

    found.add(
      "Buyback"
    );
  }


  /*
   * Preferential Issue
   */
  if (
    matchesAny(
      text,
      [

        "preferential issue",

        "preferential allotment",

      ]
    )
  ) {

    found.add(
      "Preferential Issue"
    );
  }


  /*
   * Rights Issue
   */
  if (
    matchesAny(
      text,
      [

        "rights issue",

        "rights offer",

      ]
    )
  ) {

    found.add(
      "Rights Issue"
    );
  }


  /*
   * Bonus
   */
  if (
    matchesAny(
      text,
      [

        "bonus issue",

        "bonus shares",

      ]
    )
  ) {

    found.add(
      "Bonus"
    );
  }


  /*
   * Newspaper Advertisement
   */
  if (
    matchesAny(
      text,
      [

        "newspaper advertisement",

        "newspaper publication",

        "advertisement in newspaper",

      ]
    )
  ) {

    found.add(
      "Newspaper Advertisement"
    );
  }


  /*
   * Investor / Analyst Meet
   */
  if (
    matchesAny(
      text,
      [

        "investor meet",

        "investor meeting",

        "analyst meet",

        "analyst meeting",

        "investor presentation",

      ]
    )
  ) {

    found.add(
      "Investor / Analyst Meet"
    );
  }


  /*
   * Shareholder Communication
   */
  if (
    matchesAny(
      text,
      [

        "shareholder communication",

        "communication to shareholders",

        "letter to shareholders",

      ]
    )
  ) {

    found.add(
      "Shareholder Communication"
    );
  }


  /*
   * If nothing matched, retain the
   * announcement instead of hiding it.
   */
  if (
    found.size ===
    0
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
   CATEGORY HELPERS
   ============================================================ */

function matchesAny(
  text,
  words
) {

  const value =
    String(
      text ||
      ""
    )
      .toLowerCase();


  return words.some(
    word =>
      value.includes(
        String(
          word
        )
          .toLowerCase()
      )
  );
}


function mapBSECategory(
  category
) {

  const value =
    String(
      category ||
      ""
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
      "Shareholder Communication",

  };


  return map[
    value
  ] || null;
}


/* ============================================================
   FINGERPRINT
   ============================================================ */

async function createFingerprint(
  item
) {

  /*
   * Prefer BSE GUID when available.
   */
  const source =
    item.guid ||
    item.link ||
    [

      item.scrip,

      item.company,

      item.title,

      item.pubDate,

    ]
      .join(
        "|"
      );


  const data =
    new TextEncoder()
      .encode(
        String(
          source
        )
      );


  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );


  return Array.from(
    new Uint8Array(
      hash
    )
  )
    .map(
      byte =>
        byte
          .toString(
            16
          )
          .padStart(
            2,
            "0"
          )
    )
    .join(
      ""
    );
}
/* ============================================================
   MATCH WATCHLIST
   ============================================================ */

function matchesWatchlist(
  item,
  watchlist
) {

  const scrip =
    cleanScrip(
      item.scrip
    );

  if (!scrip) {
    return false;
  }

  return watchlist.some(
    entry =>
      cleanScrip(
        entry.scrip
      ) === scrip
  );
}


/* ============================================================
   ALERT INDEX
   ============================================================ */

async function getAlertIndex(
  env
) {

  const value =
    await env.BSC_DATA.get(
      ALERT_INDEX_KEY,
      "json"
    );

  return Array.isArray(
    value
  )
    ? value
    : [];
}


async function saveAlertIndex(
  env,
  ids
) {

  await env.BSC_DATA.put(

    ALERT_INDEX_KEY,

    JSON.stringify(
      ids
    )

  );
}


/* ============================================================
   CREATE ALERT
   ============================================================ */

async function createAlert(
  env,
  item
) {

  const fingerprint =
    item.fingerprint;

  const key =
    alertKey(
      fingerprint
    );

  const existing =
    await env.BSC_DATA.get(
      key
    );

  if (existing) {

    return {
      created: false,
      duplicate: true
    };

  }

  const alert = {

    id:
      fingerprint,

    createdAt:
      new Date()
        .toISOString(),

    alert:
      true,

    specialBundle:
      true,

    company:
      item.company,

    scrip:
      item.scrip,

    title:
      item.title,

    description:
      item.description,

    category:
      item.category,

    categories:
      item.categories,

    link:
      item.link,

    pubDate:
      item.pubDate,

    isFinancialResult:
      item.isFinancialResult,

    fingerprint

  };


  await env.BSC_DATA.put(

    key,

    JSON.stringify(
      alert
    ),

    {
      expirationTtl:
        ALERT_TTL_SECONDS
    }

  );


  const index =
    await getAlertIndex(
      env
    );


  index.unshift(
    fingerprint
  );


  await saveAlertIndex(
    env,
    index.slice(
      0,
      5000
    )
  );


  return {

    created:
      true,

    duplicate:
      false,

    alert

  };
}


/* ============================================================
   GET ALERTS
   ============================================================ */

async function getAlerts(
  env
) {

  const ids =
    await getAlertIndex(
      env
    );

  const alerts =
    [];

  for (
    const id of ids
  ) {

    const value =
      await env.BSC_DATA.get(
        alertKey(id),
        "json"
      );

    if (value) {
      alerts.push(
        value
      );
    }
  }

  return alerts.slice(
    0,
    MAX_ALERTS_RETURNED
  );
}


/* ============================================================
   CLEAR ALERTS
   ============================================================ */

async function clearAlerts(
  env
) {

  const ids =
    await getAlertIndex(
      env
    );

  for (
    const id of ids
  ) {

    try {

      await env.BSC_DATA.delete(
        alertKey(id)
      );

    } catch (
      error
    ) {

      console.log(
        error
      );
    }
  }

  await saveAlertIndex(
    env,
    []
  );

  return ids.length;
}


/* ============================================================
   PROCESS NEW ITEMS
   ============================================================ */

async function processNewItems(
  env,
  items
) {

  const watchlist =
    await getWatchlist(
      env
    );

  let matches = 0;
  let alertsCreated = 0;

  for (
    const item of items
  ) {

    if (
      !matchesWatchlist(
        item,
        watchlist
      )
    ) {
      continue;
    }

    matches++;

    const result =
      await createAlert(
        env,
        item
      );

    if (
      result.created
    ) {

      alertsCreated++;

    }
  }

  return {

    matches,

    alertsCreated

  };
}


/* ============================================================
   MONITOR RSS
   ============================================================ */

async function monitorFeeds(
  env
) {

  const rssItems =
    await fetchBSEAnnouncements();

  const storage =
    await storeTodayAnnouncements(
      env,
      rssItems
    );

  const alerts =
    await processNewItems(
      env,
      rssItems
    );

  return {

    ok: true,

    timestamp:
      new Date()
        .toISOString(),

    date:
      storage.date,

    newItems:
      storage.added,

    totalToday:
      storage.total,

    chunks:
      storage.chunks,

    watchlistMatches:
      alerts.matches,

    alertsCreated:
      alerts.alertsCreated

  };
}
/* ============================================================
   WATCHLIST API
   ============================================================ */

async function apiWatchlist(
  request,
  env
) {

  const method =
    request.method.toUpperCase();


  /* ---------------------------
     GET
     --------------------------- */

  if (
    method === "GET"
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
        watchlist.length,

    });
  }


  /* ---------------------------
     POST
     --------------------------- */

  if (
    method === "POST"
  ) {

    let body;

    try {

      body =
        await request.json();

    } catch {

      return json({

        ok:
          false,

        error:
          "Invalid JSON body",

      }, 400);
    }


    /*
     * Accept:
     *
     * { "scrip": "500325" }
     *
     * or
     *
     * {
     *   "scrip": "500325",
     *   "company": "Reliance Industries"
     * }
     *
     * or
     *
     * {
     *   "watchlist": [...]
     * }
     */


    let current =
      await getWatchlist(
        env
      );


    if (
      Array.isArray(
        body.watchlist
      )
    ) {

      current =
        normalizeWatchlist(
          body.watchlist
        );

    } else {

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


      if (
        !scrip
      ) {

        return json({

          ok:
            false,

          error:
            "Scrip is required",

        }, 400);
      }


      /*
       * Don't add duplicate scrip.
       */
      const existing =
        current.find(
          item =>
            cleanScrip(
              item.scrip
            ) ===
            scrip
        );


      if (
        existing
      ) {

        /*
         * Update company name if
         * the new request has one.
         */
        if (
          company
        ) {

          existing.company =
            company;
        }

      } else {

        current.push({

          scrip,

          company,

          addedAt:
            new Date()
              .toISOString(),

        });
      }
    }


    const saved =
      await saveWatchlist(
        env,
        current
      );


    return json({

      ok:
        true,

      watchlist:
        saved,

      count:
        saved.length,

    });
  }


  /* ---------------------------
     DELETE
     --------------------------- */

  if (
    method === "DELETE"
  ) {

    let body;

    try {

      body =
        await request.json();

    } catch {

      return json({

        ok:
          false,

        error:
          "Invalid JSON body",

      }, 400);
    }


    const scrip =
      cleanScrip(
        body.scrip ||
        body.scripCode ||
        body.code ||
        ""
      );


    if (
      !scrip
    ) {

      return json({

        ok:
          false,

        error:
          "Scrip is required",

      }, 400);
    }


    const current =
      await getWatchlist(
        env
      );


    const updated =
      current.filter(
        item =>
          cleanScrip(
            item.scrip
          ) !==
          scrip
      );


    const saved =
      await saveWatchlist(
        env,
        updated
      );


    return json({

      ok:
        true,

      removed:
        current.length !==
        saved.length,

      watchlist:
        saved,

      count:
        saved.length,

    });
  }


  return json({

    ok:
      false,

    error:
      "Method not allowed",

  }, 405);
}


/* ============================================================
   ALERT API
   ============================================================ */

async function apiAlerts(
  request,
  env
) {

  const alerts =
    await getAlerts(
      env
    );


  return json({

    ok:
      true,

    bundle:
      "Alerts / Special Bundle",

    count:
      alerts.length,

    alerts,

  });
}


/* ============================================================
   CLEAR ALERTS
   ============================================================ */

async function clearAlerts(
  env
) {

  const ids =
    (await env.BSC_DATA.get(
      ALERT_INDEX_KEY,
      "json"
    )) || [];


  for (
    const id of ids
  ) {

    await env.BSC_DATA.delete(
      alertKey(
        id
      )
    );
  }


  await env.BSC_DATA.delete(
    ALERT_INDEX_KEY
  );


  return json({

    ok:
      true,

    cleared:
      ids.length,

  });
}


/* ============================================================
   MONITOR API
   ============================================================ */

async function apiMonitor(
  env
) {

  const result =
    await monitorFeeds(
      env
    );


  return json(
    result
  );
}


/* ============================================================
   HEALTH / ROOT
   ============================================================ */

async function apiRoot(
  env
) {

  const date =
    getIndiaDate();


  const index =
    await getDayIndex(
      env,
      date
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

    ok:
      true,

    service:
      "BSE RSS Reader",

    source:
      "BSE Corporate Announcements RSS",

    storage:
      "Cloudflare KV",

    kvBinding:
      "BSC_DATA",

    storageDate:
      date,

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
        "/monitor",

    },

  });
}


/* ============================================================
   HTTP ROUTER
   ============================================================ */

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
        status:
          204,

        headers:
          CORS_HEADERS,

      }
    );
  }


  const url =
    new URL(
      request.url
    );


  const path =
    url.pathname
      .replace(
        /\/+$/,
        ""
      ) ||
    "/";


  try {

    /* -------------------------
       ROOT
       ------------------------- */

    if (
      path === "/"
    ) {

      return await apiRoot(
        env
      );
    }


    /* -------------------------
       ANNOUNCEMENTS
       ------------------------- */

    if (
      path ===
      "/bse-announcements"
    ) {

      return await apiAnnouncements(
        request,
        env
      );
    }


    /* -------------------------
       CATEGORIES
       ------------------------- */

    if (
      path ===
      "/categories"
    ) {

      return await apiCategories(
        env
      );
    }


    /* -------------------------
       WATCHLIST
       ------------------------- */

    if (
      path ===
      "/watchlist"
    ) {

      return await apiWatchlist(
        request,
        env
      );
    }


    /* -------------------------
       ALERTS
       ------------------------- */

    if (
      path ===
      "/alerts"
    ) {

      return await apiAlerts(
        request,
        env
      );
    }


    /* -------------------------
       CLEAR ALERTS
       ------------------------- */

    if (
      path ===
      "/alerts/clear"
    ) {

      if (
        request.method !==
        "POST"
      ) {

        return json({

          ok:
            false,

          error:
            "POST required",

        }, 405);
      }


      return await clearAlerts(
        env
      );
    }


    /* -------------------------
       MANUAL MONITOR
       ------------------------- */

    if (
      path ===
      "/monitor"
    ) {

      return await apiMonitor(
        env
      );
    }


    /* -------------------------
       UNKNOWN ROUTE
       ------------------------- */

    return json({

      ok:
        false,

      error:
        "Endpoint not found",

      path,

    }, 404);


  } catch (
    error
  ) {

    console.error(
      "Request error:",
      error
    );


    return json({

      ok:
        false,

      error:
        String(
          error?.message ||
          error
        ),

    }, 500);
  }
}


/* ============================================================
   CLOUDFLARE WORKER
   ============================================================ */

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

      monitorFeeds(
        env
      )
        .catch(
          error => {

            console.error(
              "Scheduled monitor error:",
              error
            );

          }
        )

    );

  },

};