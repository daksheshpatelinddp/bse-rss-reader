/*
 * BSE RSS READER
 * V4 - Corporate Announcement Categories + Watchlist Alerts
 *
 * Keeps ALL BSE Corporate Announcements visible.
 * Adds virtual category feeds, duplicate detection,
 * whitelist alerts / Special Bundle, cloud KV storage,
 * automatic alert expiry, and one-minute monitoring.
 *
 * KV binding required:
 *   BSE_KV
 */

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const CORPORATE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";

const MAX_ITEMS = 2000;
const MAX_SEEN = 10000;
const MAX_ALERTS = 1000;

/*
 * Alerts remain in Cloudflare KV for 5 days.
 */
const ALERT_TTL_SECONDS =
  5 * 24 * 60 * 60;

/*
 * Duplicate fingerprints are remembered
 * for 10 days.
 */
const DUPLICATE_TTL_SECONDS =
  10 * 24 * 60 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type",
};


/* ============================================================
   RESPONSE
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
        "Content-Type":
          "application/json; charset=utf-8",
        ...CORS_HEADERS,
      },
    }
  );
}


/* ============================================================
   HTML / XML
   ============================================================ */

function decodeHtml(
  value
) {

  return String(
    value || ""
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
      /&#039;/gi,
      "'"
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&nbsp;/gi,
      " "
    );
}


function stripHtml(
  value
) {

  return decodeHtml(
    value
  )
    .replace(
      /<[^>]*>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function xmlTag(
  xml,
  tag
) {

  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(
      regex
    );

  return match
    ? stripHtml(
        match[1]
      )
    : "";
}


/* ============================================================
   FETCH BSE XML
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
          "User-Agent":
            "Mozilla/5.0 (compatible; BSE-RSS-Reader/4.0)",

          "Accept":
            "application/rss+xml, application/xml, text/xml, */*",

          "Cache-Control":
            "no-cache",
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
      `BSE feed HTTP ${response.status}`
    );
  }


  return await response.text();
}


/* ============================================================
   CORPORATE ANNOUNCEMENT CATEGORIES
   ============================================================ */

const CATEGORY_RULES = [

  {
    name:
      "Financial Results",

    words: [
      "financial result",
      "financial results",
      "quarterly result",
      "quarterly results",
      "audited result",
      "unaudited result",
      "Result",
      "result",
      "q1 result",
      "q2 result",
      "q3 result",
      "q4 result",
      "standalone result",
      "consolidated result",
      "results approved",
      "results declared",
    ],
  },


  {
    name:
      "Board Meeting",

    words: [
      "board meeting",
      "meeting of the board",
      "board of directors meeting",
      "board of director meeting",
    ],
  },


  {
    name:
      "Dividend",

    words: [
      "dividend",
      "interim dividend",
      "final dividend",
      "special dividend",
      "dividend declared",
      "dividend recommended",
    ],
  },


  {
    name:
      "Bonus",

    words: [
      "bonus issue",
      "bonus shares",
      "issue of bonus",
    ],
  },


  {
    name:
      "Rights Issue",

    words: [
      "rights issue",
      "rights shares",
      "rights entitlement",
    ],
  },


  {
    name:
      "Buyback",

    words: [
      "buyback",
      "buy back",
      "buy-back",
      "repurchase of shares",
    ],
  },


  {
    name:
      "Fund Raising",

    words: [
      "fund raising",
      "fundraising",
      "fund raise",
      "funds raised",
      "qualified institutional placement",
      "qip",
      "private placement",
      "debt issue",
      "issue of securities",
    ],
  },


  {
    name:
      "Preferential Issue",

    words: [
      "preferential issue",
      "preferential allotment",
      "preferential basis",
    ],
  },


  {
    name:
      "Allotment",

    words: [
      "allotment",
      "allotment of shares",
      "allotment of securities",
      "allotted",
    ],
  },


  {
    name:
      "Acquisition",

    words: [
      "acquisition",
      "acquire",
      "acquired",
      "takeover",
      "business acquisition",
    ],
  },


  {
    name:
      "Merger / Amalgamation",

    words: [
      "merger",
      "amalgamation",
      "scheme of arrangement",
      "demerger",
      "slump sale",
    ],
  },


  {
    name:
      "Order / Contract",

    words: [
      "order received",
      "order win",
      "order book",
      "work order",
      "contract received",
      "contract awarded",
      "letter of award",
      "purchase order",
    ],
  },


  {
    name:
      "Credit Rating",

    words: [
      "credit rating",
      "rating reaffirmed",
      "rating upgrade",
      "rating downgrade",
      "rating assigned",
    ],
  },


  {
    name:
      "Appointment / Resignation",

    words: [
      "appointment",
      "appointed as",
      "resignation",
      "resigned",
      "cessation",
      "retirement of",
      "director appointed",
      "director resigned",
    ],
  },


  {
    name:
      "Shareholding",

    words: [
      "shareholding",
      "shareholding pattern",
      "shareholding disclosure",
      "promoter holding",
      "promoter group",
      "substantial acquisition",
    ],
  },


  {
    name:
      "Trading / Insider",

    words: [
      "trading window",
      "trading plan",
      "insider trading",
      "code of conduct",
      "designated persons",
    ],
  },


  {
    name:
      "Investor / Analyst Meet",

    words: [
      "investor meet",
      "investors meet",
      "analyst meet",
      "analysts meet",
      "investor call",
      "earnings call",
      "conference call",
      "investor presentation",
    ],
  },


  {
    name:
      "AGM / EGM",

    words: [
      "annual general meeting",
      "agm",
      "extraordinary general meeting",
      "egm",
      "postal ballot",
    ],
  },


  {
    name:
      "Corporate Action",

    words: [
      "corporate action",
      "record date",
      "book closure",
      "stock split",
      "face value",
      "sub-division",
      "consolidation of shares",
    ],
  },


  {
    name:
      "Press Release",

    words: [
      "press release",
      "media release",
      "press note",
    ],
  },


  {
    name:
      "Regulatory / Legal",

    words: [
      "sebi",
      "regulatory",
      "regulation 30",
      "regulation 44",
      "legal proceedings",
      "court order",
      "nclt",
      "penalty",
      "fine imposed",
    ],
  },

];


function classifyAnnouncement(
  title,
  description
) {

  const text =
    `${title || ""} ${description || ""}`
      .toLowerCase()
      .replace(
        /\s+/g,
        " "
      );

  const categories = [];


  for (
    const rule of CATEGORY_RULES
  ) {

    if (
      rule.words.some(
        word =>
          text.includes(
            word
          )
      )
    ) {

      categories.push(
        rule.name
      );
    }
  }


  if (
    categories.length === 0
  ) {

    categories.push(
      "Other"
    );
  }


  return {

    category:
      categories[0],

    categories,

    isFinancialResult:
      categories.includes(
        "Financial Results"
      ),

  };
}


/* ============================================================
   FINANCIAL RESULTS PARSER
   ============================================================ */

function parseFinancialResults(
  xml
) {

  const items = [];


  const matches =
    xml.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];


  for (
    const itemXML of matches
  ) {

    const title =
      xmlTag(
        itemXML,
        "title"
      );

    const link =
      xmlTag(
        itemXML,
        "link"
      );

    const description =
      xmlTag(
        itemXML,
        "description"
      );


    if (!title) continue;


    let company =
      title;

    let scrip =
      "";


    const titleMatch =
      title.match(
        /^(.*?)\s*\((\d+)\)\s*$/
      );


    if (
      titleMatch
    ) {

      company =
        titleMatch[1]
          .trim();

      scrip =
        titleMatch[2]
          .trim();
    }


    const parts =
      description
        .split("|")
        .map(
          x =>
            x.trim()
        )
        .filter(
          Boolean
        );


    let resultType =
      "";

    let basis =
      "";

    let periodStart =
      "";

    let periodEnd =
      "";

    let indAs =
      "";


    for (
      const part of parts
    ) {

      const lower =
        part.toLowerCase();


      if (
        lower === "audited" ||
        lower === "unaudited"
      ) {

        resultType =
          part;
      }


      if (
        lower === "standalone" ||
        lower === "consolidated"
      ) {

        basis =
          part;
      }


      if (
        lower.includes(
          "period start date"
        )
      ) {

        periodStart =
          part
            .replace(
              /period start date\s*:/i,
              ""
            )
            .trim();
      }


      if (
        lower.includes(
          "period end date"
        )
      ) {

        periodEnd =
          part
            .replace(
              /period end date\s*:/i,
              ""
            )
            .trim();
      }


      if (
        lower.includes(
          "ind as/non ind as"
        )
      ) {

        indAs =
          part
            .replace(
              /ind as\/non ind as\s*:/i,
              ""
            )
            .trim();
      }
    }


    items.push({

      feed:
        "Financial Results",

      company,

      scrip,

      resultType,

      basis,

      periodStart,

      periodEnd,

      indAs,

      category:
        "Financial Results",

      categories: [
        "Financial Results"
      ],

      isFinancialResult:
        true,

      title,

      link,

      description,

      guid:
        link ||
        `${title}|${description}`,

      id:
        link ||
        `${title}|${description}`,

    });
  }


  return items;
}
/* ============================================================
   CORPORATE ANNOUNCEMENTS PARSER
   ============================================================ */

function parseCorporateAnnouncements(
  xml
) {

  const items = [];


  const matches =
    xml.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];


  for (
    const itemXML of matches
  ) {

    const title =
      xmlTag(
        itemXML,
        "title"
      );


    const link =
      xmlTag(
        itemXML,
        "link"
      );


    const description =
      xmlTag(
        itemXML,
        "description"
      );


    const pubDate =
      xmlTag(
        itemXML,
        "pubDate"
      );


    const guid =
      xmlTag(
        itemXML,
        "guid"
      );


    if (
      !title &&
      !description
    ) {

      continue;
    }


    /*
     * Try to extract BSE scrip.
     *
     * BSE announcement titles commonly
     * contain the security name / scrip.
     */
    let scrip =
      "";


    const scripPatterns = [

      /\bScrip\s*(?:Code|No\.?)?\s*[:\-]?\s*(\d{6})\b/i,

      /\bSecurity\s*(?:Code|No\.?)?\s*[:\-]?\s*(\d{6})\b/i,

      /\bCode\s*[:\-]?\s*(\d{6})\b/i,

      /\((\d{6})\)/,

      /\b(\d{6})\b/,
    ];


    for (
      const pattern of scripPatterns
    ) {

      const match =
        title.match(
          pattern
        ) ||
        description.match(
          pattern
        );


      if (
        match &&
        match[1]
      ) {

        scrip =
          match[1];

        break;
      }
    }


    /*
     * Try to identify company name.
     */
    let company =
      title
        .replace(
          /\bScrip\s*(?:Code|No\.?)?\s*[:\-]?\s*\d{6}\b/gi,
          ""
        )
        .replace(
          /\bSecurity\s*(?:Code|No\.?)?\s*[:\-]?\s*\d{6}\b/gi,
          ""
        )
        .replace(
          /\(\d{6}\)/g,
          ""
        )
        .trim();


    /*
     * If BSE provides a company field,
     * prefer it.
     */
    const companyFromXML =
      xmlTag(
        itemXML,
        "company"
      );


    if (
      companyFromXML
    ) {

      company =
        companyFromXML
          .trim();
    }


    /*
     * Category classification.
     */
    const classification =
      classifyAnnouncement(
        title,
        description
      );


    items.push({

      feed:
        "Corporate Announcements",

      company,

      scrip,

      title,

      description,

      link,

      guid:
        guid ||
        link ||
        "",

      pubDate,

      category:
        classification.category,

      categories:
        classification.categories,

      isFinancialResult:
        classification.isFinancialResult,

      id:
        guid ||
        link ||
        `${scrip}|${title}|${pubDate}`,

    });
  }


  return items;
}


/* ============================================================
   NORMALIZE TEXT
   ============================================================ */

function normalizeText(
  value
) {

  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /<[^>]*>/g,
      " "
    )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&nbsp;/g,
      " "
    )
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


/* ============================================================
   NORMALIZE DATE
   ============================================================ */

function normalizedDate(
  value
) {

  const timestamp =
    Date.parse(
      String(
        value || ""
      )
    );


  if (
    Number.isNaN(
      timestamp
    )
  ) {

    return "";
  }


  return new Date(
    timestamp
  )
    .toISOString();
}


/* ============================================================
   DUPLICATE KEY
   ============================================================ */

async function createFingerprint(
  item
) {

  /*
   * We deliberately use:
   *
   *   Scrip
   *   Company
   *   Title
   *
   * but NOT publication time.
   *
   * This catches cases where BSE sends
   * the same announcement multiple times
   * with different timestamps.
   */
  const source =
    [
      normalizeText(
        item.scrip
      ),

      normalizeText(
        item.company
      ),

      normalizeText(
        item.title
      ),

    ].join(
      "|"
    );


  const data =
    new TextEncoder()
      .encode(
        source
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
   DEDUPLICATE ANNOUNCEMENTS
   ============================================================ */

async function dedupeAnnouncements(
  items
) {

  const seen =
    new Set();


  const result =
    [];


  for (
    const item of items
  ) {

    const fingerprint =
      await createFingerprint(
        item
      );


    if (
      seen.has(
        fingerprint
      )
    ) {

      continue;
    }


    seen.add(
      fingerprint
    );


    result.push({

      ...item,

      fingerprint,

    });
  }


  return result;
}


/* ============================================================
   FETCH ALL BSE ANNOUNCEMENTS
   ============================================================ */

async function fetchCorporateAnnouncements() {

  const xml =
    await fetchXML(
      CORPORATE_ANNOUNCEMENTS_URL
    );


  return parseCorporateAnnouncements(
    xml
  );
}


/* ============================================================
   FETCH FINANCIAL RESULTS FEED
   ============================================================ */

async function fetchFinancialResults() {

  try {

    const xml =
      await fetchXML(
        FINANCIAL_RESULTS_URL
      );


    return parseFinancialResults(
      xml
    );

  } catch (
    error
  ) {

    console.error(
      "Financial Results RSS error:",
      error
    );


    return [];
  }
}


/* ============================================================
   FETCH + MERGE BSE DATA
   ============================================================ */

async function fetchBSEAnnouncements() {

  /*
   * Corporate Announcements is the
   * primary source.
   */
  const corporate =
    await fetchCorporateAnnouncements();


  /*
   * Financial Results feed is supplementary.
   *
   * It may be empty or delayed, so the
   * reader does NOT depend on it.
   */
  const financial =
    await fetchFinancialResults();


  const combined = [

    ...corporate,

    ...financial,

  ];


  /*
   * Remove duplicate announcements.
   */
  const deduped =
    await dedupeAnnouncements(
      combined
    );


  /*
   * Newest first.
   */
  deduped.sort(
    (
      a,
      b
    ) => {

      const da =
        Date.parse(
          a.pubDate ||
          ""
        );


      const db =
        Date.parse(
          b.pubDate ||
          ""
        );


      if (
        Number.isNaN(
          da
        )
      ) {

        return 1;
      }


      if (
        Number.isNaN(
          db
        )
      ) {

        return -1;
      }


      return db - da;
    }
  );


  return deduped
    .slice(
      0,
      MAX_ITEMS
    );
}


/* ============================================================
   CATEGORY COUNTS
   ============================================================ */

function getCategoryCounts(
  items
) {

  const counts =
    new Map();


  for (
    const item of items
  ) {

    const categories =
      Array.isArray(
        item.categories
      )
        ? item.categories
        : [
            item.category ||
            "Other"
          ];


    /*
     * Count an announcement in every
     * applicable category.
     *
     * This allows one announcement to be
     * both Financial Results and Board
     * Meeting when appropriate.
     */
    for (
      const category
        of categories
    ) {

      counts.set(

        category,

        (
          counts.get(
            category
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
        [
          name,
          count
        ]
      ) => ({

        name,

        count,

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
   CATEGORY FILTER
   ============================================================ */

function filterByCategory(
  items,
  category
) {

  if (
    !category ||
    category ===
      "all" ||
    category ===
      "All"
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


      return categories.includes(
        category
      );
    }
  );
}


/* ============================================================
   WATCHLIST NORMALIZATION
   ============================================================ */

function normalizeWatchlist(
  list
) {

  if (
    !Array.isArray(
      list
    )
  ) {

    return [];
  }


  return list
    .map(
      entry => {

        if (
          typeof entry ===
          "string"
        ) {

          return {

            scrip:
              entry
                .trim(),

            name:
              "",

          };
        }


        return {

          scrip:
            String(
              entry?.scrip ||
              entry?.code ||
              ""
            )
              .trim(),

          name:
            String(
              entry?.name ||
              entry?.company ||
              ""
            )
              .trim(),

        };
      }
    )
    .filter(
      entry =>
        entry.scrip ||
        entry.name
    );
}


/* ============================================================
   WATCHLIST MATCH
   ============================================================ */

function matchesWatchlist(
  item,
  watchlist
) {

  const itemScrip =
    String(
      item.scrip ||
      ""
    )
      .trim();


  const itemName =
    normalizeText(
      item.company
    );


  return watchlist.some(
    entry => {

      if (
        entry.scrip &&
        itemScrip &&
        entry.scrip ===
          itemScrip
      ) {

        return true;
      }


      /*
       * Company-name matching is allowed
       * only when a scrip was not supplied
       * in the whitelist entry.
       *
       * Scrip remains the preferred method.
       */
      if (
        !entry.scrip &&
        entry.name &&
        itemName ===
          normalizeText(
            entry.name
          )
      ) {

        return true;
      }


      return false;
    }
  );
}
/* ============================================================
   CLOUDFLARE KV KEYS
   ============================================================ */

const WATCHLIST_KEY =
  "bse:watchlist:v2";

const MONITOR_STATE_KEY =
  "bse:monitor:v2";

const ALERT_INDEX_KEY =
  "bse:alerts:index:v2";

const LATEST_KEY =
  "bse:latest:v2";


/* ============================================================
   GET WATCHLIST
   ============================================================ */

async function getWatchlist(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return [];
  }


  const value =
    await env.BSE_KV.get(
      WATCHLIST_KEY,
      "json"
    );


  return normalizeWatchlist(
    value
  );
}


/* ============================================================
   SAVE WATCHLIST
   ============================================================ */

async function saveWatchlist(
  env,
  list
) {

  if (
    !env.BSE_KV
  ) {

    throw new Error(
      "BSE_KV binding is missing."
    );
  }


  const watchlist =
    normalizeWatchlist(
      list
    );


  await env.BSE_KV.put(

    WATCHLIST_KEY,

    JSON.stringify(
      watchlist
    )

  );


  return watchlist;
}


/* ============================================================
   ALERT INDEX
   ============================================================ */

async function getAlertIndex(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return [];
  }


  const value =
    await env.BSE_KV.get(
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

  if (
    !env.BSE_KV
  ) {

    return;
  }


  await env.BSE_KV.put(

    ALERT_INDEX_KEY,

    JSON.stringify(
      ids.slice(
        0,
        MAX_ALERTS
      )
    )

  );
}


/* ============================================================
   ALERT RETRIEVAL
   ============================================================ */

async function getAlerts(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return [];
  }


  const index =
    await getAlertIndex(
      env
    );


  const alerts =
    [];


  const validIds =
    [];


  for (
    const id of index
  ) {

    const alert =
      await env.BSE_KV.get(
        `bse:alert:v2:${id}`,
        "json"
      );


    /*
     * KV returns null after the TTL
     * expires.
     */
    if (
      alert
    ) {

      alerts.push(
        alert
      );

      validIds.push(
        id
      );
    }
  }


  /*
   * Remove expired alert IDs from
   * the index.
   */
  if (
    validIds.length !==
    index.length
  ) {

    await saveAlertIndex(
      env,
      validIds
    );
  }


  alerts.sort(
    (
      a,
      b
    ) => {

      const da =
        Date.parse(
          a.createdAt ||
          ""
        );


      const db =
        Date.parse(
          b.createdAt ||
          ""
        );


      return db - da;
    }
  );


  return alerts;
}


/* ============================================================
   CREATE ALERT
   ============================================================ */

async function createAlert(
  env,
  item
) {

  if (
    !env.BSE_KV
  ) {

    return {

      created:
        false,

      reason:
        "BSE_KV binding is missing.",

    };
  }


  const fingerprint =
    item.fingerprint ||
    await createFingerprint(
      item
    );


  const alertKey =
    `bse:alert:v2:${fingerprint}`;


  /*
   * This is the second duplicate safety
   * layer.
   *
   * Even if the same item is seen in
   * two consecutive monitor runs,
   * only one alert is created.
   */
  const existing =
    await env.BSE_KV.get(
      alertKey
    );


  if (
    existing
  ) {

    return {

      created:
        false,

      duplicate:
        true,

      fingerprint,

    };
  }


  const createdAt =
    new Date()
      .toISOString();


  const alert = {

    id:
      fingerprint,

    fingerprint,

    createdAt,

    isNew:
      true,

    specialBundle:
      true,

    alert:
      true,

    company:
      item.company ||
      "",

    scrip:
      item.scrip ||
      "",

    title:
      item.title ||
      "",

    description:
      item.description ||
      "",

    link:
      item.link ||
      "",

    guid:
      item.guid ||
      "",

    pubDate:
      item.pubDate ||
      "",

    category:
      item.category ||
      "Other",

    categories:
      Array.isArray(
        item.categories
      )
        ? item.categories
        : [
            item.category ||
            "Other"
          ],

    isFinancialResult:
      !!item.isFinancialResult,

    feed:
      item.feed ||
      "Corporate Announcements",

  };


  /*
   * Store the actual alert with
   * automatic deletion after 5 days.
   */
  await env.BSE_KV.put(

    alertKey,

    JSON.stringify(
      alert
    ),

    {
      expirationTtl:
        ALERT_TTL_SECONDS,
    }

  );


  /*
   * Put newest alert first in the
   * index.
   */
  const oldIndex =
    await getAlertIndex(
      env
    );


  const newIndex = [

    fingerprint,

    ...oldIndex.filter(
      id =>
        id !==
        fingerprint
    ),

  ]
    .slice(
      0,
      MAX_ALERTS
    );


  await saveAlertIndex(
    env,
    newIndex
  );


  return {

    created:
      true,

    duplicate:
      false,

    fingerprint,

    alert,

  };
}


/* ============================================================
   MONITOR STATE
   ============================================================ */

async function getMonitorState(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return null;
  }


  return await env.BSE_KV.get(
    MONITOR_STATE_KEY,
    "json"
  );
}


async function saveMonitorState(
  env,
  state
) {

  if (
    !env.BSE_KV
  ) {

    return;
  }


  await env.BSE_KV.put(

    MONITOR_STATE_KEY,

    JSON.stringify(
      state
    )

  );
}


/* ============================================================
   SEEN FINGERPRINT
   ============================================================ */

async function markSeen(
  env,
  fingerprint
) {

  if (
    !env.BSE_KV
  ) {

    return;
  }


  await env.BSE_KV.put(

    `bse:seen:v2:${fingerprint}`,

    "1",

    {
      expirationTtl:
        DUPLICATE_TTL_SECONDS,
    }

  );
}


async function wasSeen(
  env,
  fingerprint
) {

  if (
    !env.BSE_KV
  ) {

    return false;
  }


  const value =
    await env.BSE_KV.get(

      `bse:seen:v2:${fingerprint}`

    );


  return !!value;
}


/* ============================================================
   INITIAL BASELINE
   ============================================================ */

async function initializeBaseline(
  env,
  items
) {

  const fingerprints =
    [];


  for (
    const item of items
  ) {

    const fingerprint =
      item.fingerprint ||
      await createFingerprint(
        item
      );


    fingerprints.push(
      fingerprint
    );


    /*
     * Existing announcements are marked
     * as seen.
     *
     * Therefore deployment will NOT
     * create thousands of alerts.
     */
    await markSeen(
      env,
      fingerprint
    );
  }


  const state = {

    initialized:
      true,

    initializedAt:
      new Date()
        .toISOString(),

    lastRun:
      new Date()
        .toISOString(),

    count:
      items.length,

    fingerprints:
      fingerprints.slice(
        0,
        MAX_SEEN
      ),

  };


  await saveMonitorState(
    env,
    state
  );


  return state;
}


/* ============================================================
   PROCESS WHITELISTED ANNOUNCEMENT
   ============================================================ */

async function processWatchedItem(
  env,
  item,
  watchlist
) {

  /*
   * Non-whitelisted announcements remain
   * visible in the Reader but do not
   * generate alerts.
   */
  if (
    !matchesWatchlist(
      item,
      watchlist
    )
  ) {

    return {

      matched:
        false,

      alertCreated:
        false,

      duplicate:
        false,

    };
  }


  const fingerprint =
    item.fingerprint ||
    await createFingerprint(
      item
    );


  /*
   * Duplicate protection.
   */
  if (
    await wasSeen(
      env,
      fingerprint
    )
  ) {

    return {

      matched:
        true,

      alertCreated:
        false,

      duplicate:
        true,

      fingerprint,

    };
  }


  /*
   * Mark as seen BEFORE creating
   * the alert.
   */
  await markSeen(
    env,
    fingerprint
  );


  const alertResult =
    await createAlert(
      env,
      {
        ...item,

        fingerprint,

      }
    );


  return {

    matched:
      true,

    alertCreated:
      !!alertResult.created,

    duplicate:
      !!alertResult.duplicate,

    fingerprint,

    alert:
      alertResult.alert ||
      null,

  };
}


/* ============================================================
   SAVE LATEST DATA
   ============================================================ */

async function saveLatest(
  env,
  items
) {

  if (
    !env.BSE_KV
  ) {

    return;
  }


  await env.BSE_KV.put(

    LATEST_KEY,

    JSON.stringify(
      items.slice(
        0,
        500
      )
    ),

    {
      expirationTtl:
        24 * 60 * 60,
    }

  );
}


/* ============================================================
   GET LATEST DATA
   ============================================================ */

async function getLatest(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return [];
  }


  const value =
    await env.BSE_KV.get(
      LATEST_KEY,
      "json"
    );


  return Array.isArray(
    value
  )
    ? value
    : [];
}


/* ============================================================
   MONITOR FEEDS
   ============================================================ */

async function monitorFeeds(
  env
) {

  const result = {

    ok:
      true,

    initialized:
      false,

    checked:
      0,

    newItems:
      0,

    whitelistMatches:
      0,

    alertsCreated:
      0,

    duplicates:
      0,

    timestamp:
      new Date()
        .toISOString(),

    errors:
      [],

  };


  try {

    /*
     * Fetch fresh BSE data.
     */
    const items =
      await fetchBSEAnnouncements();


    result.checked =
      items.length;


    /*
     * Keep latest data available to
     * the frontend.
     */
    await saveLatest(
      env,
      items
    );


    /*
     * Load whitelist.
     */
    const watchlist =
      await getWatchlist(
        env
      );


    /*
     * Check whether this Worker has
     * already established a baseline.
     */
    const state =
      await getMonitorState(
        env
      );


    /*
     * FIRST MONITOR RUN
     *
     * Existing announcements are simply
     * marked as seen.
     *
     * No alerts are generated.
     */
    if (
      !state ||
      !state.initialized
    ) {

      await initializeBaseline(
        env,
        items
      );


      result.initialized =
        true;


      result.timestamp =
        new Date()
          .toISOString();


      return result;
    }


    /*
     * Previous fingerprints.
     */
    const previous =
      new Set(
        Array.isArray(
          state.fingerprints
        )
          ? state.fingerprints
          : []
      );


    const current =
      [];


    /*
     * Examine current announcements.
     */
    for (
      const item of items
    ) {

      const fingerprint =
        item.fingerprint ||
        await createFingerprint(
          item
        );


      current.push(
        fingerprint
      );


      /*
       * Existing announcement from the
       * previous monitoring cycle.
       */
      if (
        previous.has(
          fingerprint
        )
      ) {

        continue;
      }


      result.newItems++;


      /*
       * Only whitelist matches create
       * alerts.
       */
      const processed =
        await processWatchedItem(
          env,
          {
            ...item,

            fingerprint,

          },
          watchlist
        );


      if (
        processed.matched
      ) {

        result.whitelistMatches++;
      }


      if (
        processed.alertCreated
      ) {

        result.alertsCreated++;
      }


      if (
        processed.duplicate
      ) {

        result.duplicates++;
      }
    }


    /*
     * Store current snapshot.
     */
    await saveMonitorState(
      env,
      {

        initialized:
          true,

        initializedAt:
          state.initializedAt ||
          new Date()
            .toISOString(),

        lastRun:
          new Date()
            .toISOString(),

        count:
          items.length,

        fingerprints:
          current.slice(
            0,
            MAX_SEEN
          ),

      }
    );


    result.timestamp =
      new Date()
        .toISOString();


    return result;

  } catch (
    error
  ) {

    console.error(
      "BSE monitor error:",
      error
    );


    result.ok =
      false;


    result.errors.push(
      String(
        error?.message ||
        error
      )
    );


    return result;
  }
}
/* ============================================================
   API: ALL BSE ANNOUNCEMENTS
   ============================================================ */

async function apiAnnouncements(
  request,
  env
) {

  const url =
    new URL(
      request.url
    );


  const category =
    url.searchParams.get(
      "category"
    );


  const scrip =
    url.searchParams.get(
      "scrip"
    );


  const limitValue =
    parseInt(
      url.searchParams.get(
        "limit"
      ) ||
      "200",
      10
    );


  const limit =
    Math.min(
      Math.max(
        Number.isFinite(
          limitValue
        )
          ? limitValue
          : 200,
        1
      ),
      500
    );


  try {

    const items =
      await fetchBSEAnnouncements();


    let filtered =
      filterByCategory(
        items,
        category
      );


    /*
     * Optional scrip filter.
     */
    if (
      scrip
    ) {

      const wanted =
        String(
          scrip
        )
          .trim();


      filtered =
        filtered.filter(
          item =>
            String(
              item.scrip ||
              ""
            )
              .trim() ===
            wanted
        );
    }


    /*
     * Keep the complete feed available
     * without hiding non-whitelisted
     * announcements.
     */
    return json({

      ok:
        true,

      source:
        "BSE Corporate Announcements RSS",

      allCount:
        items.length,

      count:
        filtered.length,

      category:
        category ||
        "All",

      scrip:
        scrip ||
        "",

      items:
        filtered.slice(
          0,
          limit
        ),

    });

  } catch (
    error
  ) {

    console.error(
      "Announcements API error:",
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
   API: CATEGORIES
   ============================================================ */

async function apiCategories(
  env
) {

  try {

    const items =
      await fetchBSEAnnouncements();


    const categories =
      getCategoryCounts(
        items
      );


    return json({

      ok:
        true,

      source:
        "BSE Corporate Announcements RSS",

      allCount:
        items.length,

      categories,

    });

  } catch (
    error
  ) {

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
   API: WATCHLIST GET
   ============================================================ */

async function apiWatchlistGet(
  env
) {

  try {

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

  } catch (
    error
  ) {

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
   API: WATCHLIST SAVE
   ============================================================ */

async function apiWatchlistSave(
  request,
  env
) {

  try {

    const body =
      await request.json();


    let watchlist =
      body?.watchlist;


    /*
     * Also accept a direct array.
     */
    if (
      !Array.isArray(
        watchlist
      ) &&
      Array.isArray(
        body
      )
    ) {

      watchlist =
        body;
    }


    if (
      !Array.isArray(
        watchlist
      )
    ) {

      return json({

        ok:
          false,

        error:
          "watchlist must be an array.",

      }, 400);
    }


    const saved =
      await saveWatchlist(
        env,
        watchlist
      );


    return json({

      ok:
        true,

      watchlist:
        saved,

      count:
        saved.length,

    });

  } catch (
    error
  ) {

    return json({

      ok:
        false,

      error:
        String(
          error?.message ||
          error
        ),

    }, 400);
  }
}


/* ============================================================
   API: ALERTS
   ============================================================ */

async function apiAlerts(
  env
) {

  try {

    const alerts =
      await getAlerts(
        env
      );


    return json({

      ok:
        true,

      source:
        "BSE Corporate Announcements",

      specialBundle:
        "Alerts / Special Bundle",

      count:
        alerts.length,

      retentionDays:
        ALERT_TTL_SECONDS /
        86400,

      items:
        alerts,

    });

  } catch (
    error
  ) {

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
   API: CLEAR ALERTS
   ============================================================ */

async function apiAlertsClear(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return json({

      ok:
        false,

      error:
        "BSE_KV binding is missing.",

    }, 500);
  }


  const index =
    await getAlertIndex(
      env
    );


  /*
   * Delete the actual alert records.
   */
  for (
    const id of index
  ) {

    try {

      await env.BSE_KV.delete(
        `bse:alert:v2:${id}`
      );

    } catch (
      error
    ) {

      console.error(
        "Alert delete error:",
        error
      );
    }
  }


  /*
   * Empty the index.
   */
  await saveAlertIndex(
    env,
    []
  );


  return json({

    ok:
      true,

    cleared:
      index.length,

  });
}


/* ============================================================
   API: MONITOR
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
   API: LATEST
   ============================================================ */

async function apiLatest(
  env
) {

  const items =
    await getLatest(
      env
    );


  return json({

    ok:
      true,

    count:
      items.length,

    items,

  });
}


/* ============================================================
   HEALTH / ROOT
   ============================================================ */

async function apiRoot(
  env
) {

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

    version:
      "V4-alerts",

    source:
      "BSE Corporate Announcements RSS",

    corporateAnnouncements:
      CORPORATE_ANNOUNCEMENTS_URL,

    financialResults:
      FINANCIAL_RESULTS_URL,

    features: [

      "All BSE announcements",

      "Category feeds",

      "Financial Results detection",

      "Scrip whitelist",

      "Duplicate detection",

      "Alerts / Special Bundle",

      "Cloudflare KV storage",

      "Automatic alert expiry",

      "One-minute monitoring",

    ],

    watchlistCount:
      watchlist.length,

    alertCount:
      alerts.length,

    alertRetentionDays:
      ALERT_TTL_SECONDS /
      86400,

    endpoints: [

      "/",

      "/bse-announcements",

      "/categories",

      "/watchlist",

      "/alerts",

      "/alerts/clear",

      "/monitor",

      "/latest",

    ],

  });
}


/* ============================================================
   CORS PREFLIGHT
   ============================================================ */

function handleOptions(
  request
) {

  if (
    request.method !==
    "OPTIONS"
  ) {

    return null;
  }


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


/* ============================================================
   REQUEST ROUTER
   ============================================================ */

async function handleRequest(
  request,
  env
) {

  const options =
    handleOptions(
      request
    );


  if (
    options
  ) {

    return options;
  }


  const url =
    new URL(
      request.url
    );


  let path =
    url.pathname;


  /*
   * Remove trailing slash except
   * for the root path.
   */
  if (
    path.length > 1
  ) {

    path =
      path.replace(
        /\/+$/,
        ""
      );
  }


  /* ----------------------------------------------------------
     ROOT
     ---------------------------------------------------------- */

  if (
    path ===
    "/"
  ) {

    return apiRoot(
      env
    );
  }


  /* ----------------------------------------------------------
     BSE ANNOUNCEMENTS
     ---------------------------------------------------------- */

  if (
    path ===
    "/bse-announcements" ||
    path ===
    "/announcements"
  ) {

    return apiAnnouncements(
      request,
      env
    );
  }


  /* ----------------------------------------------------------
     CATEGORIES
     ---------------------------------------------------------- */

  if (
    path ===
    "/categories"
  ) {

    return apiCategories(
      env
    );
  }


  /* ----------------------------------------------------------
     WATCHLIST
     ---------------------------------------------------------- */

  if (
    path ===
    "/watchlist"
  ) {

    if (
      request.method ===
      "GET"
    ) {

      return apiWatchlistGet(
        env
      );
    }


    if (
      request.method ===
      "POST"
    ) {

      return apiWatchlistSave(
        request,
        env
      );
    }


    return json({

      ok:
        false,

      error:
        "Use GET or POST for /watchlist.",

    }, 405);
  }


  /* ----------------------------------------------------------
     ALERTS
     ---------------------------------------------------------- */

  if (
    path ===
    "/alerts"
  ) {

    return apiAlerts(
      env
    );
  }


  /* ----------------------------------------------------------
     CLEAR ALERTS
     ---------------------------------------------------------- */

  if (
    path ===
    "/alerts/clear"
  ) {

    if (
      request.method !==
      "POST" &&
      request.method !==
      "DELETE"
    ) {

      return json({

        ok:
          false,

        error:
          "Use POST or DELETE for /alerts/clear.",

      }, 405);
    }


    return apiAlertsClear(
      env
    );
  }


  /* ----------------------------------------------------------
     MANUAL MONITOR
     ---------------------------------------------------------- */

  if (
    path ===
    "/monitor"
  ) {

    return apiMonitor(
      env
    );
  }


  /* ----------------------------------------------------------
     LATEST
     ---------------------------------------------------------- */

  if (
    path ===
    "/latest"
  ) {

    return apiLatest(
      env
    );
  }


  /* ----------------------------------------------------------
     NOT FOUND
     ---------------------------------------------------------- */

  return json({

    ok:
      false,

    error:
      "Endpoint not found.",

    path,

  }, 404);
}
/* ============================================================
   CLOUDFLARE WORKER
   ============================================================ */

export default {

  /* ==========================================================
     HTTP REQUEST
     ========================================================== */

  async fetch(
    request,
    env,
    ctx
  ) {

    try {

      return await handleRequest(
        request,
        env
      );

    } catch (
      error
    ) {

      console.error(
        "Unhandled Worker error:",
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
  },


  /* ==========================================================
     CRON
     ========================================================== */

  async scheduled(
    event,
    env,
    ctx
  ) {

    /*
     * Monitor BSE every minute.
     *
     * Cloudflare Cron:
     *
     *   * * * * *
     */

    ctx.waitUntil(

      monitorFeeds(
        env
      )
        .catch(
          error => {

            console.error(
              "Scheduled BSE monitor error:",
              error
            );

          }
        )

    );
  },

};
