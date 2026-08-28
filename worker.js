/*
 * BSE RSS READER
 * V4 - Improved BSE Corporate Announcement Categories
 *       + Watchlist Alerts / Special Bundle
 *
 * Main source:
 *   BSE Corporate Announcements RSS
 *
 * Important:
 *   ALL announcements remain available.
 *   Categories are derived from BSE title/description.
 *
 * KV binding:
 *   BSE_DATA
 */

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

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
   RESPONSE
   ============================================================ */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
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
   XML / HTML HELPERS
   ============================================================ */

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
  const regex = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );

  const match = xml.match(regex);

  return match
    ? stripHtml(match[1])
    : "";
}


/* ============================================================
   FETCH BSE XML
   ============================================================ */

async function fetchXML(url) {
  const response = await fetch(url, {
    method: "GET",

    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; BSE-RSS-Reader/4.0)",

      "Accept":
        "application/rss+xml, application/xml, text/xml, */*",

      "Cache-Control":
        "no-cache",
    },

    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });


  if (!response.ok) {
    throw new Error(
      `BSE feed HTTP ${response.status}`
    );
  }


  return await response.text();
}


/* ============================================================
   CATEGORY DEFINITIONS
   ============================================================ */

/*
 * IMPORTANT:
 *
 * Financial Results is intentionally STRICT.
 *
 * We do NOT use generic phrases such as:
 *
 *   financial statement
 *   annual report
 *   audited financial
 *
 * because those create false Financial Result matches.
 */

const CATEGORY_RULES = [

  /* ----------------------------------------------------------
     FINANCIAL RESULTS
     ---------------------------------------------------------- */

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
      "result for the quarter",
      "results for the period",
      "result for the period",
      "standalone financial results",
      "consolidated financial results",
      "standalone results",
      "consolidated results",
      "results approved",
      "results declared",
      "financial results for the quarter",
      "financial results for the period",
    ],
  },


  /* ----------------------------------------------------------
     BOARD MEETING
     ---------------------------------------------------------- */

  {
    name: "Board Meeting",

    words: [
      "board meeting",
      "meeting of the board",
      "meeting of board of directors",
      "board of directors meeting",
      "board of director meeting",
      "meeting of the board of directors",
      "outcome of board meeting",
      "outcome of the board meeting",
      "scheduled meeting of board",
    ],
  },


  /* ----------------------------------------------------------
     DIVIDEND
     ---------------------------------------------------------- */

  {
    name: "Dividend",

    words: [
      "dividend",
      "interim dividend",
      "final dividend",
      "special dividend",
      "dividend declared",
      "dividend recommended",
      "recommendation of dividend",
      "declaration of dividend",
      "payment of dividend",
    ],
  },


  /* ----------------------------------------------------------
     BONUS
     ---------------------------------------------------------- */

  {
    name: "Bonus",

    words: [
      "bonus issue",
      "bonus shares",
      "issue of bonus shares",
      "bonus equity shares",
      "bonus issue of shares",
    ],
  },


  /* ----------------------------------------------------------
     RIGHTS ISSUE
     ---------------------------------------------------------- */

  {
    name: "Rights Issue",

    words: [
      "rights issue",
      "rights shares",
      "rights entitlement",
      "issue of equity shares on rights basis",
      "rights basis",
    ],
  },


  /* ----------------------------------------------------------
     BUYBACK
     ---------------------------------------------------------- */

  {
    name: "Buyback",

    words: [
      "buyback",
      "buy back",
      "buy-back",
      "buyback of shares",
      "buy-back of shares",
      "repurchase of shares",
      "repurchase of equity shares",
    ],
  },


  /* ----------------------------------------------------------
     FUND RAISING
     ---------------------------------------------------------- */

  {
    name: "Fund Raising",

    words: [
      "fund raising",
      "fundraising",
      "fund raise",
      "funds raised",
      "fund raising programme",
      "qualified institutional placement",
      "qip",
      "private placement",
      "issue of securities",
      "issue of equity shares",
      "issue of debt securities",
      "debt issue",
      "raising of funds",
      "raising funds",
    ],
  },


  /* ----------------------------------------------------------
     PREFERENTIAL ISSUE
     ---------------------------------------------------------- */

  {
    name: "Preferential Issue",

    words: [
      "preferential issue",
      "preferential allotment",
      "preferential basis",
      "issue on preferential basis",
      "allotment on preferential basis",
    ],
  },


  /* ----------------------------------------------------------
     ALLOTMENT
     ---------------------------------------------------------- */

  {
    name: "Allotment",

    words: [
      "allotment",
      "allotment of shares",
      "allotment of equity shares",
      "allotment of securities",
      "shares allotted",
      "securities allotted",
    ],
  },


  /* ----------------------------------------------------------
     ACQUISITION
     ---------------------------------------------------------- */

  {
    name: "Acquisition",

    words: [
      "acquisition",
      "acquire",
      "acquired",
      "acquiring",
      "takeover",
      "take over",
      "business acquisition",
      "acquisition of shares",
      "acquisition of stake",
    ],
  },


  /* ----------------------------------------------------------
     MERGER / AMALGAMATION
     ---------------------------------------------------------- */

  {
    name: "Merger / Amalgamation",

    words: [
      "merger",
      "amalgamation",
      "scheme of arrangement",
      "scheme of amalgamation",
      "demerger",
      "slump sale",
      "scheme of merger",
    ],
  },


  /* ----------------------------------------------------------
     ORDER / CONTRACT
     ---------------------------------------------------------- */

  {
    name: "Order / Contract",

    words: [
      "order received",
      "order win",
      "order won",
      "order book",
      "work order",
      "contract received",
      "contract awarded",
      "letter of award",
      "purchase order",
      "received an order",
      "received order",
    ],
  },


  /* ----------------------------------------------------------
     CREDIT RATING
     ---------------------------------------------------------- */

  {
    name: "Credit Rating",

    words: [
      "credit rating",
      "rating reaffirmed",
      "rating reaffirmation",
      "rating upgrade",
      "rating downgrade",
      "rating assigned",
      "rating upgraded",
      "rating downgraded",
      "credit ratings",
    ],
  },


  /* ----------------------------------------------------------
     APPOINTMENT / RESIGNATION
     ---------------------------------------------------------- */

  {
    name: "Appointment / Resignation",

    words: [
      "appointment",
      "appointed as",
      "appointment of",
      "resignation",
      "resigned",
      "cessation",
      "retirement of",
      "director appointed",
      "director resigned",
      "change in director",
      "change in management",
      "key managerial personnel",
    ],
  },


  /* ----------------------------------------------------------
     SHAREHOLDING
     ---------------------------------------------------------- */

  {
    name: "Shareholding",

    words: [
      "shareholding",
      "shareholding pattern",
      "shareholding disclosure",
      "promoter holding",
      "promoter group",
      "substantial acquisition",
      "substantial shareholding",
      "shareholding of promoter",
    ],
  },


  /* ----------------------------------------------------------
     TRADING / INSIDER
     ---------------------------------------------------------- */

  {
    name: "Trading / Insider",

    words: [
      "trading window",
      "trading plan",
      "insider trading",
      "code of conduct",
      "designated persons",
      "closure of trading window",
      "reopening of trading window",
    ],
  },


  /* ----------------------------------------------------------
     INVESTOR / ANALYST MEET
     ---------------------------------------------------------- */

  {
    name: "Investor / Analyst Meet",

    words: [
      "investor meet",
      "investors meet",
      "analyst meet",
      "analysts meet",
      "investor call",
      "investor conference",
      "earnings call",
      "conference call",
      "investor presentation",
      "analyst presentation",
      "investor interaction",
    ],
  },


  /* ----------------------------------------------------------
     AGM / EGM
     ---------------------------------------------------------- */

  {
    name: "AGM / EGM",

    words: [
      "annual general meeting",
      "agm",
      "extraordinary general meeting",
      "egm",
      "postal ballot",
      "notice of agm",
      "notice of the agm",
      "notice of egm",
      "convening of agm",
      "convening of egm",
    ],
  },


  /* ----------------------------------------------------------
     ANNUAL REPORT
     ---------------------------------------------------------- */

  {
    name: "Annual Report",

    words: [
      "annual report",
      "annual reports",
      "annual report for the financial year",
      "annual report for fy",
      "web-link for accessing the annual report",
      "web link for accessing the annual report",
      "dispatch of annual report",
    ],
  },


  /* ----------------------------------------------------------
     NEWSPAPER ADVERTISEMENT
     ---------------------------------------------------------- */

  {
    name: "Newspaper Advertisement",

    words: [
      "newspaper advertisement",
      "newspaper publication",
      "advertisement published",
      "publication of advertisement",
      "publication in newspapers",
      "newspaper notice",
      "special window for relodgement",
    ],
  },


  /* ----------------------------------------------------------
     SHAREHOLDER COMMUNICATION
     ---------------------------------------------------------- */

  {
    name: "Shareholder Communication",

    words: [
      "letter to shareholders",
      "communication to shareholders",
      "shareholders",
      "shareholder communication",
      "dispatch to shareholders",
      "notice to shareholders",
      "intimation to shareholders",
    ],
  },


  /* ----------------------------------------------------------
     CORPORATE ACTION
     ---------------------------------------------------------- */

  {
    name: "Corporate Action",

    words: [
      "corporate action",
      "record date",
      "book closure",
      "stock split",
      "split of shares",
      "sub-division",
      "sub division",
      "consolidation of shares",
      "face value",
      "change in face value",
      "rights entitlement",
    ],
  },


  /* ----------------------------------------------------------
     REGULATION 30 / REGULATORY
     ---------------------------------------------------------- */

  {
    name: "Regulatory / Legal",

    words: [
      "regulation 30",
      "regulation 30 of sebi",
      "regulation 30 of the sebi",
      "sebi lodr",
      "sebi (lodr)",
      "securities and exchange board",
      "regulatory disclosure",
      "regulatory requirement",
      "legal proceedings",
      "court order",
      "nclt",
      "penalty",
      "fine imposed",
      "sebi",
    ],
  },


  /* ----------------------------------------------------------
     PRESS RELEASE
     ---------------------------------------------------------- */

  {
    name: "Press Release",

    words: [
      "press release",
      "media release",
      "press note",
      "press announcement",
    ],
  },
];


/* ============================================================
   CLASSIFICATION
   ============================================================ */

function classifyAnnouncement(
  title,
  description
) {

  const text =
    `${title || ""} ${description || ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();


  const categories = [];


  for (
    const rule of CATEGORY_RULES
  ) {

    const matched =
      rule.words.some(
        word =>
          text.includes(
            word
          )
      );


    if (matched) {
      categories.push(
        rule.name
      );
    }
  }


  /*
   * Anything not matched gets
   * Other.
   *
   * It is NEVER removed.
   */
  if (
    categories.length === 0
  ) {
    categories.push(
      "Other"
    );
  }


  /*
   * Financial Results is now
   * deliberately strict.
   */
  const isFinancialResult =
    categories.includes(
      "Financial Results"
    );


  return {

    /*
     * Primary category.
     */
    category:
      categories[0],

    /*
     * Announcement can belong
     * to multiple virtual feeds.
     */
    categories,

    isFinancialResult,
  };
}


/* ============================================================
   FINANCIAL RESULTS RSS PARSER
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


    if (!title) {
      continue;
    }


    let company =
      title;

    let scrip =
      "";


    const titleMatch =
      title.match(
        /^(.*?)\s*\((\d+)\)\s*$/
      );


    if (titleMatch) {

      company =
        titleMatch[1].trim();

      scrip =
        titleMatch[2].trim();
    }


    const parts =
      description
        .split("|")
        .map(
          x => x.trim()
        )
        .filter(Boolean);


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

function parseCorporateAnnouncements(xml) {

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


    /*
     * Ignore completely empty RSS items.
     */
    if (
      !title &&
      !description
    ) {
      continue;
    }


    /* --------------------------------------------------------
       COMPANY + SCRIP
       -------------------------------------------------------- */

    let company =
      "";

    let scrip =
      "";


    /*
     * Normal BSE RSS title:
     *
     * Company Name (500000)
     */
    const titleMatch =
      title.match(
        /^(.*?)\s*\((\d{6})\)/
      );


    if (titleMatch) {

      company =
        titleMatch[1].trim();

      scrip =
        titleMatch[2].trim();
    }


    /*
     * Fallback:
     * search title + description
     * for a six-digit BSE scrip.
     */
    if (!scrip) {

      const scripMatch =
        `${title} ${description}`
          .match(
            /\b(\d{6})\b/
          );


      if (scripMatch) {

        scrip =
          scripMatch[1];
      }
    }


    /*
     * Fallback company extraction.
     */
    if (!company) {

      const companyMatch =
        description.match(
          /(?:company|security|scrip name)\s*[:\-]\s*([^|,<]+)/i
        );


      if (companyMatch) {

        company =
          companyMatch[1].trim();
      }
    }


    /* --------------------------------------------------------
       CLASSIFY
       -------------------------------------------------------- */

    const classification =
      classifyAnnouncement(
        title,
        description
      );


    /* --------------------------------------------------------
       STABLE ID
       -------------------------------------------------------- */

    const stableId =
      guid ||
      link ||
      `${title}|${description}|${pubDate}`;


    /* --------------------------------------------------------
       ITEM
       -------------------------------------------------------- */

    items.push({

      feed:
        "Corporate Announcements",


      company,

      scrip,


      /*
       * Primary category.
       */
      category:
        classification.category,


      /*
       * All matching categories.
       */
      categories:
        classification.categories,


      /*
       * Strict Financial Results flag.
       */
      isFinancialResult:
        classification.isFinancialResult,


      resultType:
        classification.isFinancialResult
          ? "Financial Result"
          : "",


      /*
       * Kept for compatibility with
       * the existing reader.
       */
      basis:
        "",

      periodStart:
        "",

      periodEnd:
        "",

      indAs:
        "",


      title,

      link,

      description,

      pubDate,


      guid:
        stableId,

      id:
        stableId,
    });
  }


  return items;
}


/* ============================================================
   BSE FEED FETCHERS
   ============================================================ */

async function fetchFinancialResults() {

  const xml =
    await fetchXML(
      FINANCIAL_RESULTS_URL
    );


  const items =
    parseFinancialResults(
      xml
    );


  return {

    feed:
      "Financial Results",

    feedUrl:
      FINANCIAL_RESULTS_URL,

    count:
      items.length,

    items,
  };
}


async function fetchCorporateAnnouncements() {

  const xml =
    await fetchXML(
      CORPORATE_ANNOUNCEMENTS_URL
    );


  const items =
    parseCorporateAnnouncements(
      xml
    );


  return {

    feed:
      "Corporate Announcements",

    feedUrl:
      CORPORATE_ANNOUNCEMENTS_URL,

    count:
      items.length,

    items,
  };
}


/* ============================================================
   WATCHLIST
   ============================================================ */

async function getWatchlist(env) {

  if (!env.BSE_DATA) {
    return [];
  }


  const data =
    await env.BSE_DATA.get(
      "watchlist",
      "json"
    );


  return Array.isArray(data)
    ? data
    : [];
}


async function setWatchlist(
  env,
  watchlist
) {

  if (!env.BSE_DATA) {

    throw new Error(
      "BSE_DATA KV namespace is not configured."
    );
  }


  await env.BSE_DATA.put(
    "watchlist",
    JSON.stringify(
      watchlist
    )
  );
}


/*
 * Watchlist format:
 *
 * [
 *   {
 *     "scrip": "532540",
 *     "name": "TCS"
 *   }
 * ]
 *
 * Scrip matching is preferred.
 */

function matchesWatchlist(
  item,
  watchlist
) {

  if (
    !Array.isArray(
      watchlist
    ) ||
    watchlist.length === 0
  ) {

    return false;
  }


  return watchlist.some(
    watch => {

      /*
       * Exact BSE scrip match.
       */
      if (
        watch.scrip &&
        item.scrip &&
        String(
          watch.scrip
        ) ===
        String(
          item.scrip
        )
      ) {

        return true;
      }


      /*
       * Exact company-name
       * fallback.
       */
      if (
        watch.name &&
        item.company
      ) {

        return (
          String(
            watch.name
          )
            .trim()
            .toLowerCase()
          ===
          String(
            item.company
          )
            .trim()
            .toLowerCase()
        );
      }


      return false;
    }
  );
}


/* ============================================================
   GET ALL PHYSICAL BSE FEEDS
   ============================================================ */

async function getAllFeeds() {

  const results =
    await Promise.allSettled([
      fetchFinancialResults(),
      fetchCorporateAnnouncements(),
    ]);


  const feeds = [];

  const errors = [];


  for (
    const result of results
  ) {

    if (
      result.status ===
      "fulfilled"
    ) {

      feeds.push(
        result.value
      );

    } else {

      errors.push(
        String(
          result.reason?.message ||
          result.reason
        )
      );
    }
  }


  return {

    feeds,

    errors,
  };
}


/* ============================================================
   CATEGORY SUMMARY
   ============================================================ */

function buildCategorySummary(
  items
) {

  const map =
    new Map();


  for (
    const item of items
  ) {

    /*
     * An announcement may belong
     * to multiple virtual categories.
     */
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


    for (
      const category of categories
    ) {

      map.set(
        category,

        (
          map.get(
            category
          ) || 0
        ) + 1
      );
    }
  }


  return Array
    .from(
      map.entries()
    )
    .map(
      ([name, count]) => ({
        name,
        count,
      })
    )
    .sort(
      (a, b) =>
        b.count - a.count
    );
}


/* ============================================================
   PERSISTENT SEEN ITEMS
   ============================================================ */

async function getSeen(env) {

  if (!env.BSE_DATA) {
    return [];
  }


  const data =
    await env.BSE_DATA.get(
      "announcementSeen",
      "json"
    );


  return Array.isArray(data)
    ? data
    : [];
}


async function saveSeen(
  env,
  ids
) {

  if (!env.BSE_DATA) {
    return;
  }


  await env.BSE_DATA.put(
    "announcementSeen",

    JSON.stringify(
      ids.slice(
        0,
        MAX_SEEN
      )
    )
  );
}


/* ============================================================
   PERSISTENT ALERTS
   ============================================================ */

async function getAlerts(env) {

  if (!env.BSE_DATA) {
    return [];
  }


  const data =
    await env.BSE_DATA.get(
      "specialAlerts",
      "json"
    );


  return Array.isArray(data)
    ? data
    : [];
}


async function saveAlerts(
  env,
  alerts
) {

  if (!env.BSE_DATA) {
    return;
  }


  await env.BSE_DATA.put(
    "specialAlerts",

    JSON.stringify(
      alerts.slice(
        0,
        MAX_ALERTS
      )
    )
  );
}

/* ============================================================
   MONITOR BSE CORPORATE ANNOUNCEMENTS
   ============================================================ */

async function monitorFeeds(env) {

  const result =
    await getAllFeeds();


  /*
   * Corporate Announcements is the
   * primary real-time monitoring feed.
   */
  const corporateFeed =
    result.feeds.find(
      feed =>
        feed.feed ===
        "Corporate Announcements"
    );


  const items =
    corporateFeed?.items ||
    [];


  const watchlist =
    await getWatchlist(
      env
    );


  const seen =
    await getSeen(
      env
    );


  const alerts =
    await getAlerts(
      env
    );


  /* ----------------------------------------------------------
     FIRST RUN / BASELINE
     ---------------------------------------------------------- */

  /*
   * On the first monitoring run we establish
   * the current BSE feed as the baseline.
   *
   * Existing announcements therefore do NOT
   * generate alerts.
   */
  if (
    seen.length === 0
  ) {

    const ids =
      items
        .map(
          item =>
            item.id ||
            item.guid
        )
        .filter(Boolean);


    await saveSeen(
      env,
      ids
    );


    return {

      monitored:
        true,

      baseline:
        true,

      announcements:
        items.length,

      watchlist:
        watchlist.length,

      newAnnouncements:
        0,

      newAlerts:
        0,

      errors:
        result.errors,
    };
  }


  /* ----------------------------------------------------------
     FIND NEW ANNOUNCEMENTS
     ---------------------------------------------------------- */

  const seenSet =
    new Set(
      seen
    );


  const newItems =
    items.filter(
      item => {

        const id =
          item.id ||
          item.guid;


        return (
          id &&
          !seenSet.has(
            id
          )
        );
      }
    );


  let newAlerts =
    0;


  /* ----------------------------------------------------------
     CREATE ALERTS FOR WHITELISTED SCRIPS
     ---------------------------------------------------------- */

  for (
    const item of newItems
  ) {

    /*
     * ALL new announcements are still
     * retained in the normal BSE feed.
     *
     * Only announcements belonging to
     * a whitelisted company become alerts.
     */
    if (
      !matchesWatchlist(
        item,
        watchlist
      )
    ) {

      continue;
    }


    const id =
      item.id ||
      item.guid;


    /*
     * Never create the same alert twice.
     */
    if (
      alerts.some(
        alert =>
          alert.id === id
      )
    ) {

      continue;
    }


    alerts.unshift({

      ...item,


      alert:
        true,


      alertType:
        item.isFinancialResult
          ? "Financial Result"
          : "BSE Announcement",


      specialBundle:
        "Alerts / Special Bundle",


      alertCreatedAt:
        new Date().toISOString(),
    });


    newAlerts++;
  }


  /* ----------------------------------------------------------
     SAVE SEEN IDS
     ---------------------------------------------------------- */

  const allSeen = [

    ...newItems.map(
      item =>
        item.id ||
        item.guid
    ),

    ...seen,
  ];


  const uniqueSeen =
    [];


  for (
    const id of allSeen
  ) {

    if (!id) {
      continue;
    }


    if (
      !uniqueSeen.includes(
        id
      )
    ) {

      uniqueSeen.push(
        id
      );
    }


    if (
      uniqueSeen.length >=
      MAX_SEEN
    ) {

      break;
    }
  }


  await saveSeen(
    env,
    uniqueSeen
  );


  await saveAlerts(
    env,
    alerts
  );


  return {

    monitored:
      true,

    baseline:
      false,

    announcements:
      items.length,

    newAnnouncements:
      newItems.length,

    watchlist:
      watchlist.length,

    newAlerts,

    totalAlerts:
      alerts.length,

    errors:
      result.errors,
  };
}


/* ============================================================
   FINANCIAL RESULTS ENDPOINT
   ============================================================ */

async function handleFinancialResults() {

  try {

    const result =
      await fetchFinancialResults();


    return json({

      ok:
        true,

      source:
        "BSE Financial Results RSS",

      feedUrl:
        FINANCIAL_RESULTS_URL,

      fetchedAt:
        new Date().toISOString(),

      count:
        result.items.length,

      items:
        result.items,

    });

  } catch (
    error
  ) {

    return json({

      ok:
        false,

      source:
        "BSE Financial Results RSS",

      error:
        error.message,

    }, 502);
  }
}


/* ============================================================
   CORPORATE ANNOUNCEMENTS ENDPOINT
   ============================================================ */

async function handleAnnouncements(
  request
) {

  try {

    const result =
      await fetchCorporateAnnouncements();


    const url =
      new URL(
        request.url
      );


    const requestedCategory =
      url.searchParams.get(
        "category"
      );


    /*
     * IMPORTANT:
     *
     * No category =
     * ALL BSE announcements.
     *
     * Nothing is hidden.
     */
    let items =
      result.items;


    /* --------------------------------------------------------
       OPTIONAL CATEGORY FILTER
       -------------------------------------------------------- */

    if (
      requestedCategory
    ) {

      const wanted =
        requestedCategory
          .trim()
          .toLowerCase();


      items =
        items.filter(
          item => {

            /*
             * Primary category.
             */
            if (
              item.category &&
              item.category
                .toLowerCase() ===
                wanted
            ) {

              return true;
            }


            /*
             * Secondary category.
             */
            if (
              Array.isArray(
                item.categories
              )
            ) {

              return item.categories.some(
                category =>
                  category
                    .toLowerCase() ===
                  wanted
              );
            }


            return false;
          }
        );
    }


    return json({

      ok:
        true,

      source:
        "BSE Corporate Announcements RSS",

      feedUrl:
        CORPORATE_ANNOUNCEMENTS_URL,

      fetchedAt:
        new Date().toISOString(),


      /*
       * Count before category filtering.
       */
      allItemsCount:
        result.items.length,


      /*
       * Count actually returned.
       */
      count:
        items.length,


      category:
        requestedCategory ||
        "All",


      items,

    });

  } catch (
    error
  ) {

    return json({

      ok:
        false,

      source:
        "BSE Corporate Announcements RSS",

      error:
        error.message,

    }, 502);
  }
}


/* ============================================================
   CATEGORY ENDPOINT
   ============================================================ */

async function handleCategories() {

  try {

    const result =
      await fetchCorporateAnnouncements();


    const categories =
      buildCategorySummary(
        result.items
      );


    return json({

      ok:
        true,

      source:
        "BSE Corporate Announcements RSS",

      allCount:
        result.items.length,

      categories,

    });

  } catch (
    error
  ) {

    return json({

      ok:
        false,

      error:
        error.message,

    }, 502);
  }
}


/* ============================================================
   FEEDS ENDPOINT
   ============================================================ */

async function handleFeeds() {

  const result =
    await getAllFeeds();


  const allItems =
    result.feeds.flatMap(
      feed =>
        feed.items
    );


  return json({

    ok:
      result.errors.length === 0,

    fetchedAt:
      new Date().toISOString(),


    /*
     * Physical BSE feeds.
     */
    feeds:
      result.feeds.map(
        feed => ({

          feed:
            feed.feed,

          feedUrl:
            feed.feedUrl,

          count:
            feed.count,
        })
      ),


    /*
     * Virtual category feeds.
     */
    categories:
      buildCategorySummary(
        allItems
      ),


    errors:
      result.errors,


    count:
      allItems.length,


    /*
     * ALL announcements remain
     * available here.
     */
    items:
      allItems,
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

    count:
      watchlist.length,

    watchlist,
  });
}


/* ============================================================
   WATCHLIST POST
   ============================================================ */

async function handleWatchlistPost(
  request,
  env
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
        "Invalid JSON body.",

    }, 400);
  }


  const watchlist =
    Array.isArray(
      body.watchlist
    )
      ? body.watchlist
      : null;


  if (!watchlist) {

    return json({

      ok:
        false,

      error:
        "watchlist must be an array.",

    }, 400);
  }


  /*
   * Clean the watchlist slightly
   * before saving.
   */
  const cleaned =
    watchlist
      .map(
        item => {

          if (
            typeof item ===
            "string"
          ) {

            return {
              scrip:
                item.trim(),
            };
          }


          return {

            scrip:
              String(
                item?.scrip ||
                ""
              ).trim(),

            name:
              String(
                item?.name ||
                ""
              ).trim(),
          };
        }
      )
      .filter(
        item =>
          item.scrip ||
          item.name
      );


  await setWatchlist(
    env,
    cleaned
  );


  return json({

    ok:
      true,

    count:
      cleaned.length,

    watchlist:
      cleaned,
  });
}


/* ============================================================
   ALERTS / SPECIAL BUNDLE
   ============================================================ */

async function handleAlerts(
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

    items:
      alerts,
  });
}


/* ============================================================
   CLEAR ALERTS
   ============================================================ */

async function handleAlertsClear(
  request,
  env
) {

  if (
    request.method !==
    "POST"
  ) {

    return json({

      ok:
        false,

      error:
        "POST required.",

    }, 405);
  }


  await saveAlerts(
    env,
    []
  );


  return json({

    ok:
      true,

    message:
      "Alerts / Special Bundle cleared.",
  });
}


/* ============================================================
   ROOT / HEALTH
   ============================================================ */

async function handleRoot(
  env
) {

  const watchlist =
    await getWatchlist(
      env
    );


  return json({

    ok:
      true,

    app:
      "BSE RSS Reader",

    version:
      "V4-Improved-Categories-Alerts",

    status:
      "running",


    feeds: [
      "Financial Results",
      "Corporate Announcements",
    ],


    virtualCategoryFeeds:
      true,


    monitoring:
      "Every minute",


    watchlistCount:
      watchlist.length,


    endpoints: [

      "/",

      "/bse-results",

      "/bse-announcements",

      "/bse-announcements?category=Financial%20Results",

      "/categories",

      "/feeds",

      "/watchlist",

      "/alerts",

      "/alerts/clear",

      "/monitor",
    ],
  });
}


/* ============================================================
   MAIN FETCH HANDLER
   ============================================================ */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(
        request.url
      );


    /* --------------------------------------------------------
       CORS PREFLIGHT
       -------------------------------------------------------- */

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          headers:
            CORS_HEADERS,
        }
      );
    }


    /* --------------------------------------------------------
       ROOT
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/"
    ) {

      return handleRoot(
        env
      );
    }


    /* --------------------------------------------------------
       FINANCIAL RESULTS
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/bse-results"
    ) {

      return handleFinancialResults();
    }


    /* --------------------------------------------------------
       CORPORATE ANNOUNCEMENTS
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/bse-announcements"
    ) {

      return handleAnnouncements(
        request
      );
    }


    /* --------------------------------------------------------
       CATEGORIES
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/categories"
    ) {

      return handleCategories();
    }


    /* --------------------------------------------------------
       COMBINED FEEDS
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/feeds"
    ) {

      return handleFeeds();
    }


    /* --------------------------------------------------------
       WATCHLIST GET
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/watchlist" &&
      request.method ===
      "GET"
    ) {

      return handleWatchlistGet(
        env
      );
    }


    /* --------------------------------------------------------
       WATCHLIST POST
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/watchlist" &&
      request.method ===
      "POST"
    ) {

      return handleWatchlistPost(
        request,
        env
      );
    }


    /* --------------------------------------------------------
       ALERTS
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/alerts" &&
      request.method ===
      "GET"
    ) {

      return handleAlerts(
        env
      );
    }


    /* --------------------------------------------------------
       CLEAR ALERTS
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/alerts/clear" &&
      request.method ===
      "POST"
    ) {

      return handleAlertsClear(
        request,
        env
      );
    }


    /* --------------------------------------------------------
       MANUAL MONITOR
       -------------------------------------------------------- */

    if (
      url.pathname ===
      "/monitor"
    ) {

      const result =
        await monitorFeeds(
          env
        );


      return json({

        ok:
          true,

        ...result,
      });
    }


    /* --------------------------------------------------------
       UNKNOWN ENDPOINT
       -------------------------------------------------------- */

    return json({

      ok:
        false,

      error:
        "Endpoint not found.",

    }, 404);
  },


  /* ==========================================================
     CLOUDFLARE CRON
     ========================================================== */

  async scheduled(
    event,
    env,
    ctx
  ) {

    /*
     * Cloudflare Cron should be configured
     * to run every minute:
     *
     *   * * * * *
     */

    ctx.waitUntil(
      monitorFeeds(
        env
      )
    );
  },
};