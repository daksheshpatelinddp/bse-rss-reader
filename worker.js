/*
 * BSE RSS READER
 * V2 - Financial Results + Corporate Announcements
 *
 * Endpoints:
 *
 *   /
 *   /bse-results
 *   /bse-announcements
 *   /feeds
 *   /watchlist
 *
 * Worker monitoring:
 *   Every minute through Cloudflare Cron
 *
 * Feeds:
 *   1. Financial Results
 *   2. Corporate Announcements
 *
 * IMPORTANT:
 * The reader shows ALL feed items.
 * Watchlist is used for priority/alerts only.
 */

// ============================================================
// CONFIG
// ============================================================

const FINANCIAL_RESULTS_URL =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const CORPORATE_ANNOUNCEMENTS_URL =
  "https://beta.bseindia.com/data/xml/announcements.xml";


// ============================================================
// CORS
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};


// ============================================================
// RESPONSE HELPERS
// ============================================================

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


// ============================================================
// HTML CLEANING
// ============================================================

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


// ============================================================
// XML HELPERS
// ============================================================

function xmlTag(xml, tag) {

  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match = xml.match(regex);

  if (!match) {
    return "";
  }

  return stripHtml(match[1]);

}


function xmlTagRaw(xml, tag) {

  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match = xml.match(regex);

  return match ? match[1] : "";
}


// ============================================================
// FETCH XML
// ============================================================

async function fetchXML(url) {

  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; BSE-RSS-Reader/2.0)",
          "Accept":
            "application/rss+xml, application/xml, text/xml, */*",
          "Cache-Control":
            "no-cache",
        },
        cf: {
          cacheTtl: 0,
          cacheEverything: false,
        },
      }
    );


  if (!response.ok) {

    throw new Error(
      `BSE feed HTTP ${response.status}`
    );

  }


  return await response.text();

}


// ============================================================
// FINANCIAL RESULTS PARSER
// ============================================================

function parseFinancialResults(xml) {

  const items = [];

  const matches =
    xml.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];


  for (const itemXML of matches) {

    const title =
      xmlTag(itemXML, "title");

    const link =
      xmlTag(itemXML, "link");

    const description =
      xmlTag(itemXML, "description");


    if (!title) {
      continue;
    }


    /*
     * Example:
     *
     * Newever Trade Wings Ltd (536644)
     */

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
        .map(x => x.trim())
        .filter(Boolean);


    let resultType = "";
    let basis = "";
    let periodStart = "";
    let periodEnd = "";
    let indAs = "";


    for (const part of parts) {

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

      title,

      link,

      description,

      guid:
        link ||
        `${title}|${description}`,

    });

  }


  return items;

}


// ============================================================
// CORPORATE ANNOUNCEMENTS PARSER
// ============================================================

function parseCorporateAnnouncements(xml) {

  const items = [];

  const matches =
    xml.match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];


  for (const itemXML of matches) {

    const title =
      xmlTag(itemXML, "title");

    const link =
      xmlTag(itemXML, "link");

    const description =
      xmlTag(itemXML, "description");

    const pubDate =
      xmlTag(itemXML, "pubDate");

    const guid =
      xmlTag(itemXML, "guid");


    if (
      !title &&
      !description
    ) {
      continue;
    }


    /*
     * BSE announcement titles can contain
     * company name and scrip code in different
     * formats.
     *
     * We therefore try several patterns.
     */

    let company = "";
    let scrip = "";


    const titleMatch =
      title.match(
        /^(.*?)\s*\((\d{6})\)/
      );


    if (titleMatch) {

      company =
        titleMatch[1]
          .trim();

      scrip =
        titleMatch[2]
          .trim();

    }


    /*
     * Look for a 6 digit BSE scrip anywhere
     * in title or description.
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
     * If company was not found from the title,
     * try common labels.
     */

    if (!company) {

      const companyMatch =
        description.match(
          /(?:company|security|scrip name)\s*[:\-]\s*([^|,<]+)/i
        );


      if (companyMatch) {

        company =
          companyMatch[1]
            .trim();

      }

    }


    /*
     * Keep the complete announcement.
     */

    items.push({

      feed:
        "Corporate Announcements",

      company,

      scrip,

      resultType:
        "",

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
        guid ||
        link ||
        `${title}|${description}`,

    });

  }


  return items;

}


// ============================================================
// FEED FETCHERS
// ============================================================

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


// ------------------------------------------------------------

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


// ============================================================
// WATCHLIST
// ============================================================

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


// ============================================================
// SET WATCHLIST
// ============================================================

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
    JSON.stringify(
      watchlist
    )
  );

}


// ============================================================
// WATCHLIST MATCH
// ============================================================

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

      if (
        watch.scrip &&
        item.scrip &&
        String(watch.scrip) ===
        String(item.scrip)
      ) {

        return true;

      }


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


// ============================================================
// COMBINE FEEDS
// ============================================================

async function getAllFeeds() {

  const results =
    await Promise.allSettled([
      fetchFinancialResults(),
      fetchCorporateAnnouncements(),
    ]);


  const feeds = [];

  const errors = [];


  for (const result of results) {

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


// ============================================================
// /bse-results
// ============================================================

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


// ============================================================
// /bse-announcements
// ============================================================

async function handleAnnouncements() {

  try {

    const result =
      await fetchCorporateAnnouncements();


    return json({

      ok: true,

      source:
        "BSE Corporate Announcements RSS",

      feedUrl:
        CORPORATE_ANNOUNCEMENTS_URL,

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
        "BSE Corporate Announcements RSS",

      error:
        error.message,

    }, 502);

  }

}


// ============================================================
// /feeds
// ============================================================

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

    errors:
      result.errors,

    count:
      allItems.length,

    items:
      allItems,

  });

}


// ============================================================
// /watchlist GET
// ============================================================

async function handleWatchlistGet(env) {

  const watchlist =
    await getWatchlist(env);


  return json({

    ok: true,

    count:
      watchlist.length,

    watchlist,

  });

}


// ============================================================
// /watchlist POST
// ============================================================

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

      ok: false,

      error:
        "Invalid JSON body.",

    }, 400);

  }


  const watchlist =
    Array.isArray(body.watchlist)
      ? body.watchlist
      : null;


  if (!watchlist) {

    return json({

      ok: false,

      error:
        "watchlist must be an array.",

    }, 400);

  }


  await setWatchlist(
    env,
    watchlist
  );


  return json({

    ok: true,

    count:
      watchlist.length,

    watchlist,

  });

}


// ============================================================
// ROOT
// ============================================================

async function handleRoot(env) {

  const watchlist =
    await getWatchlist(env);


  return json({

    ok: true,

    app:
      "BSE RSS Reader",

    status:
      "running",

    feeds: [

      "Financial Results",

      "Corporate Announcements",

    ],

    endpoints: [

      "/bse-results",

      "/bse-announcements",

      "/feeds",

      "/watchlist",

    ],

    monitoring:
      "Every minute",

    watchlistCount:
      watchlist.length,

  });

}


// ============================================================
// MONITORING
// ============================================================

async function monitorFeeds(env) {

  const result =
    await getAllFeeds();


  const watchlist =
    await getWatchlist(env);


  const watchedItems = [];


  for (
    const feed of result.feeds
  ) {

    for (
      const item of feed.items
    ) {

      if (
        matchesWatchlist(
          item,
          watchlist
        )
      ) {

        watchedItems.push(
          item
        );

      }

    }

  }


  /*
   * Store latest watched items.
   *
   * This is deliberately separate from
   * the normal feed data.
   */

  if (env.BSE_KV) {

    await env.BSE_KV.put(

      "latestWatched",

      JSON.stringify({

        checkedAt:
          new Date().toISOString(),

        count:
          watchedItems.length,

        items:
          watchedItems,

      })

    );

  }


  return {

    feeds:
      result.feeds.length,

    items:
      result.feeds.reduce(
        (total, feed) =>
          total + feed.items.length,
        0
      ),

    watched:
      watchedItems.length,

    errors:
      result.errors,

  };

}


// ============================================================
// FETCH HANDLER
// ============================================================

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


    if (
      url.pathname ===
      "/"
    ) {

      return handleRoot(
        env
      );

    }


    if (
      url.pathname ===
      "/bse-results"
    ) {

      return handleFinancialResults();

    }


    if (
      url.pathname ===
      "/bse-announcements"
    ) {

      return handleAnnouncements();

    }


    if (
      url.pathname ===
      "/feeds"
    ) {

      return handleFeeds();

    }


    if (
      url.pathname ===
      "/watchlist" &&
      request.method === "GET"
    ) {

      return handleWatchlistGet(
        env
      );

    }


    if (
      url.pathname ===
      "/watchlist" &&
      request.method === "POST"
    ) {

      return handleWatchlistPost(
        request,
        env
      );

    }


    return json({

      ok: false,

      error:
        "Endpoint not found.",

    }, 404);

  },


  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(

      monitorFeeds(env)

    );

  },

};