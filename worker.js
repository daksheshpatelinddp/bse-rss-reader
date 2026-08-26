/*
 * BSE RSS READER
 * V3 - Corporate Announcements + Categories + Alerts
 *
 * Main feed:
 *   BSE Corporate Announcements RSS
 *
 * Secondary feed:
 *   BSE Financial Results RSS
 *
 * Features:
 *   - Shows ALL BSE announcements
 *   - Category classification
 *   - BSE scrip whitelist
 *   - Duplicate detection
 *   - New whitelist announcement alerts
 *   - Cloudflare KV alert storage
 *   - Automatic alert expiry
 *   - One-minute monitoring
 *
 * KV binding required:
 *
 *   BSE_KV
 *
 * Cron:
 *
 *   * * * * *
 *
 */


/* ============================================================
   CONFIG
   ============================================================ */

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const CORPORATE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";


/*
 * Alert retention.
 *
 * Current setting:
 * 5 days.
 *
 * Later we can make this configurable
 * from the frontend.
 */
const ALERT_TTL_SECONDS =
  5 * 24 * 60 * 60;


/*
 * Remember fingerprints for 10 days.
 *
 * This prevents the same BSE announcement
 * from repeatedly generating alerts.
 */
const DUPLICATE_TTL_SECONDS =
  10 * 24 * 60 * 60;


/*
 * Maximum number of alert IDs kept
 * in the alert index.
 */
const MAX_ALERTS =
  500;


/*
 * KV keys.
 */
const WATCHLIST_KEY =
  "watchlist";

const ALERT_INDEX_KEY =
  "alerts:index";

const MONITOR_STATE_KEY =
  "monitor:state";

const LATEST_WATCHED_KEY =
  "latestWatched";


/* ============================================================
   CORS
   ============================================================ */

const CORS_HEADERS = {

  "Access-Control-Allow-Origin":
    "*",

  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",

  "Access-Control-Allow-Headers":
    "Content-Type",

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
        "Content-Type":
          "application/json; charset=utf-8",

        ...CORS_HEADERS,
      },
    }
  );
}


/* ============================================================
   HTML CLEANING
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
      /[“”‘’]/g,
      "'"
    )

    .replace(
      /[–—]/g,
      "-"
    )

    .replace(
      /[^\w\s.-]/g,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();
}


/* ============================================================
   XML HELPERS
   ============================================================ */

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


  if (!match) {

    return "";
  }


  return stripHtml(
    match[1]
  );
}


function xmlTagRaw(
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
    ? match[1]
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
            "Mozilla/5.0 (compatible; BSE-RSS-Reader/3.0)",

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
        lower ===
          "audited" ||

        lower ===
          "unaudited"
      ) {

        resultType =
          part;
      }


      if (
        lower ===
          "standalone" ||

        lower ===
          "consolidated"
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

      title,

      link,

      description,

      pubDate:
        "",

      category:
        "Financial Results",

      categories: [
        "Financial Results"
      ],

      isFinancialResult:
        true,

      guid:
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


    let company =
      "";

    let scrip =
      "";


    /*
     * Common BSE format:
     *
     * Company Name (123456)
     */
    const titleMatch =
      title.match(
        /^(.*?)\s*\((\d{6})\)/
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


    /*
     * Search for six digit
     * BSE scrip anywhere.
     */
    if (!scrip) {

      const scripMatch =
        `${title} ${description}`
          .match(
            /\b(\d{6})\b/
          );


      if (
        scripMatch
      ) {

        scrip =
          scripMatch[1];
      }
    }


    /*
     * Try to identify company name
     * from description if title
     * did not contain it.
     */
    if (!company) {

      const companyMatch =
        description.match(
          /(?:company|security|scrip name)\s*[:\-]\s*([^|,<]+)/i
        );


      if (
        companyMatch
      ) {

        company =
          companyMatch[1]
            .trim();
      }
    }


    /*
     * Category will be assigned
     * below.
     */
    const category =
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

      link,

      description,

      pubDate,

      guid:
        guid ||
        link ||
        `${title}|${description}`,

      category,

      categories: [
        category
      ],

      isFinancialResult:
        category ===
        "Financial Results",

    });
  }


  return items;
}


/* ============================================================
   CATEGORY CLASSIFICATION
   ============================================================ */

function classifyAnnouncement(
  title,
  description
) {

  const text =
    normalizeText(
      `${title} ${description}`
    );


  /*
   * IMPORTANT:
   *
   * More specific categories must be
   * checked before broad categories.
   *
   * For example:
   * "Board Meeting to consider financial
   * results" should be Financial Results
   * rather than simply Board Meeting.
   */


  /* ----------------------------------------------------------
     FINANCIAL RESULTS
     ---------------------------------------------------------- */

  if (
    /\bfinancial results?\b/.test(text) ||

    /\bquarterly results?\b/.test(text) ||

    /\bhalf year results?\b/.test(text) ||

    /\bannual results?\b/.test(text) ||

    /\bunaudited financial results?\b/.test(text) ||

    /\baudited financial results?\b/.test(text) ||

    /\bfinancial statements?\b/.test(text) ||

    /\bresults? for the (quarter|period)\b/.test(text) ||

    /\bresults? for .* quarter\b/.test(text)
  ) {

    return "Financial Results";
  }


  /* ----------------------------------------------------------
     BOARD MEETING
     ---------------------------------------------------------- */

  if (
    /\bboard meeting\b/.test(text) ||

    /\bmeeting of the board\b/.test(text) ||

    /\bmeeting of board of directors\b/.test(text)
  ) {

    return "Board Meeting";
  }


  /* ----------------------------------------------------------
     DIVIDEND
     ---------------------------------------------------------- */

  if (
    /\bdividend\b/.test(text) ||

    /\binterim dividend\b/.test(text) ||

    /\bfinal dividend\b/.test(text) ||

    /\bdividend payment\b/.test(text)
  ) {

    return "Dividend";
  }


  /* ----------------------------------------------------------
     AGM / EGM
     ---------------------------------------------------------- */

  if (
    /\bagm\b/.test(text) ||

    /\begm\b/.test(text) ||

    /\bannual general meeting\b/.test(text) ||

    /\bextraordinary general meeting\b/.test(text) ||

    /\bgeneral meeting\b/.test(text)
  ) {

    return "AGM / EGM";
  }


  /* ----------------------------------------------------------
     REGULATORY / LEGAL
     ---------------------------------------------------------- */

  if (
    /\bsebi\b/.test(text) ||

    /\bregulatory\b/.test(text) ||

    /\blegal\b/.test(text) ||

    /\bpenalty\b/.test(text) ||

    /\border of sebi\b/.test(text) ||

    /\bshow cause notice\b/.test(text) ||

    /\bcourt\b/.test(text) ||

    /\blitigation\b/.test(text)
  ) {

    return "Regulatory / Legal";
  }


  /* ----------------------------------------------------------
     NEWSPAPER ADVERTISEMENT
     ---------------------------------------------------------- */

  if (
    /\bnewspaper advertisement\b/.test(text) ||

    /\bnewspaper publication\b/.test(text) ||

    /\bpublication of advertisement\b/.test(text)
  ) {

    return "Newspaper Advertisement";
  }


  /* ----------------------------------------------------------
     ANNUAL REPORT
     ---------------------------------------------------------- */

  if (
    /\bannual report\b/.test(text) ||

    /\bannual accounts\b/.test(text)
  ) {

    return "Annual Report";
  }


  /* ----------------------------------------------------------
     APPOINTMENT / RESIGNATION
     ---------------------------------------------------------- */

  if (
    /\bappointment\b/.test(text) ||

    /\bresignation\b/.test(text) ||

    /\bappointed as\b/.test(text) ||

    /\bresigned\b/.test(text) ||

    /\bcessation\b/.test(text)
  ) {

    return "Appointment / Resignation";
  }


  /* ----------------------------------------------------------
     ACQUISITION
     ---------------------------------------------------------- */

  if (
    /\bacquisition\b/.test(text) ||

    /\bacquire\b/.test(text) ||

    /\bacquired\b/.test(text)
  ) {

    return "Acquisition";
  }


  /* ----------------------------------------------------------
     MERGER / AMALGAMATION
     ---------------------------------------------------------- */

  if (
    /\bmerger\b/.test(text) ||

    /\bamalgamation\b/.test(text) ||

    /\bscheme of arrangement\b/.test(text)
  ) {

    return "Merger / Amalgamation";
  }


  /* ----------------------------------------------------------
     CREDIT RATING
     ---------------------------------------------------------- */

  if (
    /\bcredit rating\b/.test(text) ||

    /\brating reaffirmed\b/.test(text) ||

    /\brating upgraded\b/.test(text) ||

    /\brating downgraded\b/.test(text) ||

    /\bcredit opinion\b/.test(text)
  ) {

    return "Credit Rating";
  }


  /* ----------------------------------------------------------
     FUND RAISING
     ---------------------------------------------------------- */

  if (
    /\bfund raising\b/.test(text) ||

    /\bfundraising\b/.test(text) ||

    /\bissue of securities\b/.test(text) ||

    /\bprivate placement\b/.test(text) ||

    /\bdebt raising\b/.test(text)
  ) {

    return "Fund Raising";
  }


  /* ----------------------------------------------------------
     PREFERENTIAL ISSUE
     ---------------------------------------------------------- */

  if (
    /\bpreferential issue\b/.test(text) ||

    /\bpreferential allotment\b/.test(text)
  ) {

    return "Preferential Issue";
  }


  /* ----------------------------------------------------------
     RIGHTS ISSUE
     ---------------------------------------------------------- */

  if (
    /\bright issue\b/.test(text) ||

    /\brights issue\b/.test(text)
  ) {

    return "Rights Issue";
  }


  /* ----------------------------------------------------------
     BUYBACK
     ---------------------------------------------------------- */

  if (
    /\bbuyback\b/.test(text) ||

    /\bbuy back\b/.test(text)
  ) {

    return "Buyback";
  }


  /* ----------------------------------------------------------
     BONUS
     ---------------------------------------------------------- */

  if (
    /\bbonus issue\b/.test(text) ||

    /\bbonus shares\b/.test(text)
  ) {

    return "Bonus";
  }


  /* ----------------------------------------------------------
     ALLOTMENT
     ---------------------------------------------------------- */

  if (
    /\ballotment\b/.test(text) ||

    /\ballotment of shares\b/.test(text) ||

    /\ballotment of securities\b/.test(text)
  ) {

    return "Allotment";
  }


  /* ----------------------------------------------------------
     SHAREHOLDING
     ---------------------------------------------------------- */

  if (
    /\bshareholding\b/.test(text) ||

    /\bshareholding pattern\b/.test(text) ||

    /\bshare holders?\b/.test(text)
  ) {

    return "Shareholding";
  }


  /* ----------------------------------------------------------
     TRADING / INSIDER
     ---------------------------------------------------------- */

  if (
    /\btrading window\b/.test(text) ||

    /\btrading window closure\b/.test(text) ||

    /\binsider trading\b/.test(text) ||

    /\bcode of conduct\b/.test(text) ||

    /\bpromoter trading\b/.test(text) ||

    /\bdisclosure under sebi\b/.test(text)
  ) {

    return "Trading / Insider";
  }


  /* ----------------------------------------------------------
     CORPORATE ACTION
     ---------------------------------------------------------- */

  if (
    /\bcorporate action\b/.test(text) ||

    /\brecord date\b/.test(text) ||

    /\bbook closure\b/.test(text) ||

    /\bface value\b/.test(text) ||

    /\bsplit\b/.test(text)
  ) {

    return "Corporate Action";
  }


  /* ----------------------------------------------------------
     INVESTOR / ANALYST MEET
     ---------------------------------------------------------- */

  if (
    /\binvestor meet\b/.test(text) ||

    /\binvestor meeting\b/.test(text) ||

    /\banalyst meet\b/.test(text) ||

    /\banalyst meeting\b/.test(text) ||

    /\binvestor conference\b/.test(text)
  ) {

    return "Investor / Analyst Meet";
  }


  /* ----------------------------------------------------------
     ORDER / CONTRACT
     ---------------------------------------------------------- */

  if (
    /\border received\b/.test(text) ||

    /\bwork order\b/.test(text) ||

    /\bcontract received\b/.test(text) ||

    /\border worth\b/.test(text) ||

    /\bcontract worth\b/.test(text)
  ) {

    return "Order / Contract";
  }


  /* ----------------------------------------------------------
     PRESS RELEASE
     ---------------------------------------------------------- */

  if (
    /\bpress release\b/.test(text) ||

    /\bmedia release\b/.test(text) ||

    /\bpress statement\b/.test(text)
  ) {

    return "Press Release";
  }


  /*
   * Anything not confidently classified
   * remains visible as Other.
   */
  return "Other";
}


/* ============================================================
   FETCH + PARSE ALL BSE ANNOUNCEMENTS
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
   FETCH FINANCIAL RESULTS
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
      "Financial Results feed error:",
      error
    );


    return [];
  }
}


/* ============================================================
   FETCH MAIN BSE DATASET
   ============================================================ */

async function fetchBSEAnnouncements() {

  const corporate =
    await fetchCorporateAnnouncements();


  /*
   * We keep the separate Financial Results
   * feed as additional information.
   *
   * It is NOT treated as the authoritative
   * real-time results source.
   */
  const financial =
    await fetchFinancialResults();


  /*
   * Corporate Announcements is the primary
   * source. Financial Results feed is
   * supplementary.
   */
  const all = [
    ...corporate,
    ...financial
  ];


  return dedupeAnnouncements(
    all
  );
}


/* ============================================================
   BASIC ANNOUNCEMENT DEDUPLICATION
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

    /*
     * First preference:
     * BSE GUID.
     */
    let key =
      item.guid ||
      item.link;


    /*
     * If GUID/link isn't useful,
     * build a normalized fallback.
     */
    if (!key) {

      key =
        [
          item.scrip,
          normalizeText(
            item.title
          ),
          normalizeText(
            item.description
          )
        ]
          .join("|");
    }


    if (
      seen.has(key)
    ) {

      continue;
    }


    seen.add(
      key
    );


    result.push(
      item
    );
  }


  return result;
}


/* ============================================================
   DUPLICATE FINGERPRINT
   ============================================================ */

async function announcementFingerprint(
  item
) {

  /*
   * We intentionally do NOT include
   * publication time.
   *
   * BSE may publish the same announcement
   * more than once with different timestamps.
   */

  const source =
    [
      String(
        item.scrip || ""
      )
        .trim(),

      normalizeText(
        item.company || ""
      ),

      normalizeText(
        item.title || ""
      ),

      normalizeText(
        item.description || ""
      )
    ]
      .join("|");


  const bytes =
    new TextEncoder()
      .encode(
        source
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
      byte =>
        byte
          .toString(16)
          .padStart(
            2,
            "0"
          )
    )
    .join("");
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
              entry.trim(),

            name:
              "",
          };
        }


        return {

          scrip:
            String(
              entry.scrip ||
              ""
            )
              .trim(),

          name:
            String(
              entry.name ||
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
   LOAD WATCHLIST
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


  const normalized =
    normalizeWatchlist(
      list
    );


  await env.BSE_KV.put(
    WATCHLIST_KEY,
    JSON.stringify(
      normalized
    )
  );


  return normalized;
}


/* ============================================================
   WHITELIST MATCH
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


  const itemCompany =
    normalizeText(
      item.company
    );


  if (!itemScrip) {

    return false;
  }


  for (
    const watch of watchlist
  ) {

    /*
     * BSE SCRIP is the primary
     * matching method.
     */
    if (
      watch.scrip &&
      itemScrip ===
        String(
          watch.scrip
        )
          .trim()
    ) {

      return true;
    }


    /*
     * Name is only a fallback.
     */
    if (
      !watch.scrip &&
      watch.name &&
      itemCompany ===
        normalizeText(
          watch.name
        )
    ) {

      return true;
    }
  }


  return false;
}



/* ============================================================
   ALERT STORAGE
   ============================================================ */

async function getAlertIndex(
  env
) {

  if (
    !env.BSE_KV
  ) {

    return [];
  }


  const data =
    await env.BSE_KV.get(
      ALERT_INDEX_KEY,
      "json"
    );


  return Array.isArray(
    data
  )
    ? data
    : [];
}


/* ============================================================
   SAVE ALERT INDEX
   ============================================================ */

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
   GET STORED ALERTS
   ============================================================ */

async function getAlerts(
  env
) {

  const index =
    await getAlertIndex(
      env
    );


  const alerts =
    [];


  const validIds =
    [];


  /*
   * KV automatically removes expired
   * alert records.
   *
   * Therefore the index may contain
   * IDs whose records no longer exist.
   */
  for (
    const id of index
  ) {

    const alert =
      await env.BSE_KV.get(
        `alert:${id}`,
        "json"
      );


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
   * Clean expired IDs from the index.
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


  /*
   * Newest first.
   */
  alerts.sort(
    (
      a,
      b
    ) =>
      String(
        b.createdAt || ""
      )
        .localeCompare(
          String(
            a.createdAt || ""
          )
        )
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
        "BSE_KV binding missing.",

    };
  }


  const alertId =
    await announcementFingerprint(
      item
    );


  /*
   * Permanent-ish duplicate protection
   * for the alert retention period.
   *
   * This is separate from the RSS GUID.
   */
  const duplicateKey =
    `alert:${alertId}`;


  const existing =
    await env.BSE_KV.get(
      duplicateKey
    );


  if (
    existing
  ) {

    return {

      created:
        false,

      duplicate:
        true,

      alertId,

    };
  }


  const now =
    new Date()
      .toISOString();


  const alert = {

    alertId,

    createdAt:
      now,

    isNew:
      true,

    specialBundle:
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

    feed:
      item.feed ||
      "Corporate Announcements",

    isFinancialResult:
      !!item.isFinancialResult,

    guid:
      item.guid ||
      "",

  };


  /*
   * Store alert with automatic expiry.
   */
  await env.BSE_KV.put(

    duplicateKey,

    JSON.stringify(
      alert
    ),

    {
      expirationTtl:
        ALERT_TTL_SECONDS,
    }

  );


  /*
   * Add ID to alert index.
   */
  const index =
    await getAlertIndex(
      env
    );


  const newIndex = [

    alertId,

    ...index.filter(
      id =>
        id !==
        alertId
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

    alertId,

    alert,

  };
}


/* ============================================================
   DUPLICATE MEMORY
   ============================================================ */

async function rememberFingerprint(
  env,
  fingerprint
) {

  if (
    !env.BSE_KV
  ) {

    return;
  }


  await env.BSE_KV.put(

    `seen:${fingerprint}`,

    "1",

    {
      expirationTtl:
        DUPLICATE_TTL_SECONDS,
    }

  );
}


/* ============================================================
   CHECK DUPLICATE MEMORY
   ============================================================ */

async function hasFingerprint(
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
      `seen:${fingerprint}`
    );


  return !!value;
}


/* ============================================================
   PROCESS NEW ANNOUNCEMENT
   ============================================================ */

async function processAnnouncement(
  env,
  item,
  watchlist
) {

  /*
   * Only whitelisted companies
   * can create alerts.
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

      alert:
        false,

      duplicate:
        false,

    };
  }


  const fingerprint =
    await announcementFingerprint(
      item
    );


  /*
   * Already seen during the duplicate
   * retention period.
   */
  if (
    await hasFingerprint(
      env,
      fingerprint
    )
  ) {

    return {

      matched:
        true,

      alert:
        false,

      duplicate:
        true,

      fingerprint,

    };
  }


  /*
   * Mark it as seen BEFORE creating
   * the alert.
   *
   * This prevents duplicate processing
   * if the cron runs again immediately.
   */
  await rememberFingerprint(
    env,
    fingerprint
  );


  const result =
    await createAlert(
      env,
      item
    );


  return {

    matched:
      true,

    alert:
      !!result.created,

    duplicate:
      !!result.duplicate,

    fingerprint,

    result,

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


/* ============================================================
   SAVE MONITOR STATE
   ============================================================ */

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
   BUILD ITEM BASELINE
   ============================================================ */

async function buildBaseline(
  items
) {

  const fingerprints =
    [];


  for (
    const item of items
  ) {

    fingerprints.push(
      await announcementFingerprint(
        item
      )
    );
  }


  return fingerprints;
}


/* ============================================================
   INITIAL MONITOR BASELINE
   ============================================================ */

async function initializeMonitor(
  env,
  items
) {

  const fingerprints =
    await buildBaseline(
      items
    );


  const state = {

    initialized:
      true,

    initializedAt:
      new Date()
        .toISOString(),

    count:
      items.length,

    fingerprints,

  };


  await saveMonitorState(
    env,
    state
  );


  /*
   * Also mark the current items as seen.
   *
   * This is critical:
   * existing BSE announcements will NOT
   * generate alerts immediately after
   * the new Worker is deployed.
   */
  for (
    const fingerprint
      of fingerprints
  ) {

    await rememberFingerprint(
      env,
      fingerprint
    );
  }


  return state;
}


/* ============================================================
   MONITOR RESULT OBJECT
   ============================================================ */

function emptyMonitorResult() {

  return {

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

    errors:
      [],

    timestamp:
      new Date()
        .toISOString(),

  };
}


