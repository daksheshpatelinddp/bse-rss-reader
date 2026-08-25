/*
 * BSE RSS READER
 * V3 - Corporate Announcement Categories + Watchlist Alerts
 *
 * Keeps ALL BSE Corporate Announcements visible.
 * Adds virtual category feeds, persistent new-item detection,
 * whitelist alerts / Special Bundle, and one-minute monitoring.
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
        "Content-Type": "application/json; charset=utf-8",
        ...CORS_HEADERS,
      },
    }
  );
}


/* ============================================================
   HTML / XML
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
  return match ? stripHtml(match[1]) : "";
}


/* ============================================================
   FETCH BSE XML
   ============================================================ */

async function fetchXML(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; BSE-RSS-Reader/3.0)",
      "Accept":
        "application/rss+xml, application/xml, text/xml, */*",
      "Cache-Control": "no-cache",
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });

  if (!response.ok) {
    throw new Error(`BSE feed HTTP ${response.status}`);
  }

  return await response.text();
}


/* ============================================================
   CORPORATE ANNOUNCEMENT CATEGORIES
   ============================================================ */

const CATEGORY_RULES = [
  {
    name: "Financial Results",
    words: [
      "financial result",
      "financial results",
      "quarterly result",
      "quarterly results",
      "audited financial",
      "unaudited financial",
      "audited result",
      "unaudited result",
      "financial statement",
      "financial statements",
      "standalone result",
      "consolidated result",
      "results approved",
      "results declared",
    ],
  },

  {
    name: "Board Meeting",
    words: [
      "board meeting",
      "meeting of the board",
      "board of directors meeting",
      "board of director meeting",
    ],
  },

  {
    name: "Dividend",
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
    name: "Bonus",
    words: [
      "bonus issue",
      "bonus shares",
      "issue of bonus",
    ],
  },

  {
    name: "Rights Issue",
    words: [
      "rights issue",
      "rights shares",
      "rights entitlement",
    ],
  },

  {
    name: "Buyback",
    words: [
      "buyback",
      "buy back",
      "buy-back",
      "repurchase of shares",
    ],
  },

  {
    name: "Fund Raising",
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
    name: "Preferential Issue",
    words: [
      "preferential issue",
      "preferential allotment",
      "preferential basis",
    ],
  },

  {
    name: "Allotment",
    words: [
      "allotment",
      "allotment of shares",
      "allotment of securities",
      "allotted",
    ],
  },

  {
    name: "Acquisition",
    words: [
      "acquisition",
      "acquire",
      "acquired",
      "takeover",
      "business acquisition",
    ],
  },

  {
    name: "Merger / Amalgamation",
    words: [
      "merger",
      "amalgamation",
      "scheme of arrangement",
      "demerger",
      "slump sale",
    ],
  },

  {
    name: "Order / Contract",
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
    name: "Credit Rating",
    words: [
      "credit rating",
      "rating reaffirmed",
      "rating upgrade",
      "rating downgrade",
      "rating assigned",
    ],
  },

  {
    name: "Appointment / Resignation",
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
    name: "Shareholding",
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
    name: "Trading / Insider",
    words: [
      "trading window",
      "trading plan",
      "insider trading",
      "code of conduct",
      "designated persons",
    ],
  },

  {
    name: "Investor / Analyst Meet",
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
    name: "AGM / EGM",
    words: [
      "annual general meeting",
      "agm",
      "extraordinary general meeting",
      "egm",
      "postal ballot",
    ],
  },

  {
    name: "Corporate Action",
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
    name: "Press Release",
    words: [
      "press release",
      "media release",
      "press note",
    ],
  },

  {
    name: "Regulatory / Legal",
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

function classifyAnnouncement(title, description) {
  const text =
    `${title || ""} ${description || ""}`
      .toLowerCase()
      .replace(/\s+/g, " ");

  const categories = [];

  for (const rule of CATEGORY_RULES) {
    if (
      rule.words.some(word =>
        text.includes(word)
      )
    ) {
      categories.push(rule.name);
    }
  }

  if (categories.length === 0) {
    categories.push("Other");
  }

  return {
    category: categories[0],
    categories,
    isFinancialResult:
      categories.includes("Financial Results"),
  };
}


/* ============================================================
   FINANCIAL RESULTS PARSER
   ============================================================ */

function parseFinancialResults(xml) {
  const items = [];

  const matches =
    xml.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];

  for (const itemXML of matches) {
    const title = xmlTag(itemXML, "title");
    const link = xmlTag(itemXML, "link");
    const description =
      xmlTag(itemXML, "description");

    if (!title) continue;

    let company = title;
    let scrip = "";

    const titleMatch =
      title.match(
        /^(.*?)\s*\((\d+)\)\s*$/
      );

    if (titleMatch) {
      company = titleMatch[1].trim();
      scrip = titleMatch[2].trim();
    }

    const parts =
      description
        .split("|")
        .map(x => x.trim())
        .filter(Boolean);

    let resultType = "";
    let basis = "";
    let periodStart = "";
    let periodEnd = "";
    let indAs = "";

    for (const part of parts) {
      const lower = part.toLowerCase();

      if (
        lower === "audited" ||
        lower === "unaudited"
      ) {
        resultType = part;
      }

      if (
        lower === "standalone" ||
        lower === "consolidated"
      ) {
        basis = part;
      }

      if (
        lower.includes("period start date")
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
        lower.includes("period end date")
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
        lower.includes("ind as/non ind as")
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
      feed: "Financial Results",
      company,
      scrip,
      resultType,
      basis,
      periodStart,
      periodEnd,
      indAs,
      category: "Financial Results",
      categories: ["Financial Results"],
      isFinancialResult: true,
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
   CORPORATE ANNOUNMENTS PARSER
   ============================================================ */

function parseCorporateAnnouncements(xml) {
  const items = [];

  const matches =
    xml.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];

  for (const itemXML of matches) {
    const title = xmlTag(itemXML, "title");
    const link = xmlTag(itemXML, "link");
    const description =
      xmlTag(itemXML, "description");
    const pubDate = xmlTag(itemXML, "pubDate");
    const guid = xmlTag(itemXML, "guid");

    if (!title && !description) continue;

    let company = "";
    let scrip = "";

    /*
     * Common BSE format:
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
     * Try to find a six-digit BSE scrip
     * anywhere in the announcement.
     */
    if (!scrip) {
      const scripMatch =
        `${title} ${description}`
          .match(/\b(\d{6})\b/);

      if (scripMatch) {
        scrip =
          scripMatch[1];
      }
    }

    /*
     * Company-name fallback.
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

    /*
     * Classify the announcement.
     *
     * IMPORTANT:
     * This does NOT remove anything from the
     * main Corporate Announcements feed.
     */
    const classification =
      classifyAnnouncement(
        title,
        description
      );

    /*
     * Prefer BSE GUID.
     * If GUID is absent, use link.
     * Last fallback uses announcement content.
     */
    const stableId =
      guid ||
      link ||
      `${title}|${description}|${pubDate}`;

    items.push({
      feed:
        "Corporate Announcements",

      company,
      scrip,

      category:
        classification.category,

      categories:
        classification.categories,

      isFinancialResult:
        classification.isFinancialResult,

      resultType:
        classification.isFinancialResult
          ? "Financial Result"
          : "",

      basis: "",
      periodStart: "",
      periodEnd: "",
      indAs: "",

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
    parseFinancialResults(xml);

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
    parseCorporateAnnouncements(xml);

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
  if (!env.BSE_KV) {
    return [];
  }

  const data =
    await env.BSE_KV.get(
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
  if (!env.BSE_KV) {
    throw new Error(
      "BSE_KV KV namespace is not configured."
    );
  }

  await env.BSE_KV.put(
    "watchlist",
    JSON.stringify(watchlist)
  );
}


/*
 * A watchlist item can contain:
 *
 * {
 *   "scrip": "532540",
 *   "name": "TCS"
 * }
 *
 * Scrip matching is preferred.
 * Name matching remains supported.
 */

function matchesWatchlist(
  item,
  watchlist
) {
  if (
    !Array.isArray(watchlist) ||
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
        String(watch.scrip) ===
        String(item.scrip)
      ) {
        return true;
      }

      /*
       * Exact company-name fallback.
       */
      if (
        watch.name &&
        item.company
      ) {
        return (
          String(watch.name)
            .toLowerCase()
            ===
          String(item.company)
            .toLowerCase()
        );
      }

      return false;
    }
  );
}


/* ============================================================
   GET ALL BSE FEEDS
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
     * An item can appear in
     * multiple virtual categories.
     */
    const cats =
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
      const category of cats
    ) {

      map.set(
        category,
        (
          map.get(category) ||
          0
        ) + 1
      );
    }
  }

  return Array
    .from(map.entries())
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
  if (!env.BSE_KV) {
    return [];
  }

  const data =
    await env.BSE_KV.get(
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
  if (!env.BSE_KV) {
    return;
  }

  await env.BSE_KV.put(
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
  if (!env.BSE_KV) {
    return [];
  }

  const data =
    await env.BSE_KV.get(
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
  if (!env.BSE_KV) {
    return;
  }

  await env.BSE_KV.put(
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
   MONITORING
   ============================================================ */

async function monitorFeeds(env) {

  const result =
    await getAllFeeds();

  /*
   * Corporate Announcements is
   * the primary real-time monitoring feed.
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
    await getWatchlist(env);

  const seen =
    await getSeen(env);

  const alerts =
    await getAlerts(env);


  /*
   * FIRST RUN:
   *
   * Establish a baseline.
   *
   * Existing BSE announcements
   * are NOT turned into alerts.
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


  /*
   * NORMAL RUN:
   *
   * Compare current BSE announcements
   * against previously seen IDs.
   */
  const seenSet =
    new Set(seen);

  const newItems =
    items.filter(
      item => {

        const id =
          item.id ||
          item.guid;

        return (
          id &&
          !seenSet.has(id)
        );
      }
    );

  let newAlerts = 0;


  /*
   * Only NEW announcements from
   * whitelisted companies become
   * Special Bundle alerts.
   */
  for (
    const item of newItems
  ) {

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
     * Prevent duplicate alerts.
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


  /*
   * Save newly seen IDs.
   */
  const allSeen = [
    ...newItems.map(
      item =>
        item.id ||
        item.guid
    ),

    ...seen,
  ];

  const uniqueSeen = [];


  for (
    const id of allSeen
  ) {

    if (!id) {
      continue;
    }

    if (
      !uniqueSeen.includes(id)
    ) {
      uniqueSeen.push(id);
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
   /bse-results
   ============================================================ */

async function handleFinancialResults() {
  try {
    const result =
      await fetchFinancialResults();

    return json({
      ok: true,

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

  } catch (error) {

    return json({
      ok: false,

      source:
        "BSE Financial Results RSS",

      error:
        error.message,

    }, 502);
  }
}


/* ============================================================
   /bse-announcements
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
     * Without ?category=
     * ALL BSE announcements are returned.
     *
     * We never hide announcements
     * from the main feed.
     */

    let items =
      result.items;


    /*
     * Category filtering is optional.
     */
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
             * Match primary category.
             */
            if (
              item.category &&
              item.category
                .toLowerCase()
                === wanted
            ) {
              return true;
            }

            /*
             * Also match any
             * secondary category.
             */
            if (
              Array.isArray(
                item.categories
              )
            ) {

              return item.categories.some(
                category =>
                  category
                    .toLowerCase()
                    === wanted
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
       * Number before filtering.
       */
      allItemsCount:
        result.items.length,

      /*
       * Number returned after
       * optional category filtering.
       */
      count:
        items.length,

      category:
        requestedCategory ||
        "All",

      items,

    });

  } catch (error) {

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
   /categories
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

      /*
       * Total announcements currently
       * returned by BSE.
       */
      allCount:
        result.items.length,

      /*
       * Virtual category feeds.
       */
      categories,

    });

  } catch (error) {

    return json({

      ok:
        false,

      error:
        error.message,

    }, 502);
  }
}


/* ============================================================
   /feeds
   ============================================================ */

async function handleFeeds() {

  const result =
    await getAllFeeds();

  /*
   * Combine both BSE sources.
   */
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
     *
     * Frontend can use this to
     * automatically create category
     * cards/bundles.
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
     * ALL items remain available.
     */
    items:
      allItems,

  });
}


/* ============================================================
   /watchlist GET
   ============================================================ */

async function handleWatchlistGet(
  env
) {

  const watchlist =
    await getWatchlist(env);


  return json({

    ok:
      true,

    count:
      watchlist.length,

    watchlist,

  });
}


/* ============================================================
   /watchlist POST
   ============================================================ */

async function handleWatchlistPost(
  request,
  env
) {

  let body;


  /*
   * Read JSON request.
   */
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


  /*
   * Watchlist must be
   * an array.
   */
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
   * Save to KV.
   */
  await setWatchlist(
    env,
    watchlist
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
   /alerts
   ============================================================ */

async function handleAlerts(
  env
) {

  const alerts =
    await getAlerts(env);


  return json({

    ok:
      true,

    /*
     * This is the future
     * notification source too.
     */
    bundle:
      "Alerts / Special Bundle",

    count:
      alerts.length,

    items:
      alerts,

  });
}


/* ============================================================
   /alerts/clear
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
   ROOT / HEALTH CHECK
   ============================================================ */

async function handleRoot(
  env
) {

  const watchlist =
    await getWatchlist(env);


  return json({

    ok:
      true,

    app:
      "BSE RSS Reader",

    version:
      "V3-Categories-Alerts",

    status:
      "running",


    /*
     * Current physical feeds.
     */
    feeds: [
      "Financial Results",
      "Corporate Announcements",
    ],


    /*
     * Category feeds are generated
     * from Corporate Announcements.
     */
    virtualCategoryFeeds:
      true,


    endpoints: [

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


    monitoring:
      "Every minute",


    watchlistCount:
      watchlist.length,

  });
}

/* ============================================================
   FETCH HANDLER
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
       ALL CORPORATE ANNOUNCEMENTS
       OR CATEGORY FILTER
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
       CATEGORY LIST
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
       WATCHLIST - GET
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
       WATCHLIST - POST
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
       SPECIAL ALERTS
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
       MANUAL MONITOR TEST
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
     * This runs from the Cloudflare
     * Cron Trigger.
     *
     * Set Cron to:
     *
     *   * * * *
     *
     * for every minute.
     */

    ctx.waitUntil(
      monitorFeeds(
        env
      )
    );
  },
};