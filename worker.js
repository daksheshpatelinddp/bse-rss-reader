/*
 * BSE RSS READER
 *
 * Background monitoring foundation
 *
 * Feeds:
 *   Financial Results
 *
 * API:
 *   /
 *   /bse-results
 *   /watchlist
 *
 * Background:
 *   Cloudflare Cron - every minute
 *
 * KV:
 *   BSE_DATA
 */


const BSE_FINANCIAL_RESULTS =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";


const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store"
};


// ==================================================
// MAIN REQUEST HANDLER
// ==================================================

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);


    // ----------------------------------------------
    // CORS
    // ----------------------------------------------

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });

    }


    // ----------------------------------------------
    // HEALTH
    // ----------------------------------------------

    if (url.pathname === "/") {

      return json({

        ok: true,

        app:
          "BSE RSS Reader",

        status:
          "running",

        feeds: [
          "Financial Results"
        ],

        endpoints: [
          "/bse-results",
          "/watchlist"
        ],

        monitoring:
          "Every minute"

      });

    }


    // ----------------------------------------------
    // BSE RESULTS
    // ----------------------------------------------

    if (
      url.pathname === "/bse-results"
    ) {

      return await getBseResults();

    }


    // ----------------------------------------------
    // WATCHLIST
    // ----------------------------------------------

    if (
      url.pathname === "/watchlist"
    ) {

      return await handleWatchlist(
        request,
        env
      );

    }


    // ----------------------------------------------
    // NOT FOUND
    // ----------------------------------------------

    return json(
      {
        ok: false,
        error: "Not found"
      },
      404
    );

  },


  // =================================================
  // CLOUDFLARE CRON
  // =================================================

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      monitorBseFeeds(env)
    );

  }

};


// ==================================================
// FETCH BSE RESULTS
// ==================================================

async function getBseResults() {

  try {

    const response =
      await fetch(
        BSE_FINANCIAL_RESULTS,
        {
          method: "GET",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

            "Accept":
              "application/rss+xml, application/xml, text/xml, */*",

            "Referer":
              "https://www.bseindia.com/"
          }
        }
      );


    if (!response.ok) {

      return json(
        {
          ok: false,
          error:
            "BSE feed request failed",
          status:
            response.status
        },
        502
      );

    }


    const xml =
      await response.text();


    const items =
      parseItems(xml);


    return json({

      ok: true,

      source:
        "BSE Financial Results RSS",

      feedUrl:
        BSE_FINANCIAL_RESULTS,

      fetchedAt:
        new Date().toISOString(),

      count:
        items.length,

      items

    });


  } catch (error) {

    return json(
      {
        ok: false,

        error:
          "Failed to fetch BSE RSS",

        message:
          error.message
      },
      502
    );

  }

}


// ==================================================
// BACKGROUND MONITOR
// ==================================================

async function monitorBseFeeds(env) {

  try {

    console.log(
      "BSE background check started"
    );


    // ----------------------------------------------
    // Load whitelist
    // ----------------------------------------------

    const whitelist =
      await getWatchlist(env);


    if (
      whitelist.length === 0
    ) {

      console.log(
        "No companies in watchlist"
      );

      return;

    }


    // ----------------------------------------------
    // Fetch current BSE feed
    // ----------------------------------------------

    const response =
      await fetch(
        BSE_FINANCIAL_RESULTS,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 BSE RSS Reader"
          }
        }
      );


    if (!response.ok) {

      console.log(
        "BSE feed failed:",
        response.status
      );

      return;

    }


    const xml =
      await response.text();


    const items =
      parseItems(xml);


    console.log(
      "BSE items:",
      items.length
    );


    // ----------------------------------------------
    // Load previously seen items
    // ----------------------------------------------

    let seen =
      await env.BSE_DATA.get(
        "seen_results",
        "json"
      );


    if (!Array.isArray(seen)) {
      seen = [];
    }


    // ----------------------------------------------
    // Check each item
    // ----------------------------------------------

    const newWatchedItems = [];


    for (const item of items) {

      const itemId =
        makeItemId(item);


      // Already processed
      if (
        seen.includes(itemId)
      ) {

        continue;

      }


      // Mark as seen
      seen.push(itemId);


      // Is company watched?
      const watched =
        whitelist.some(
          watch =>
            String(watch.scrip) ===
            String(item.scrip)
        );


      if (watched) {

        newWatchedItems.push({
          ...item,

          detectedAt:
            new Date().toISOString()
        });

      }

    }


    // ----------------------------------------------
    // Keep only recent seen IDs
    // ----------------------------------------------

    if (seen.length > 1000) {

      seen =
        seen.slice(
          seen.length - 1000
        );

    }


    await env.BSE_DATA.put(
      "seen_results",
      JSON.stringify(seen)
    );


    // ----------------------------------------------
    // Store new watched items
    //
    // Notification system will use this
    // in the next step.
    // ----------------------------------------------

    if (
      newWatchedItems.length > 0
    ) {

      let alerts =
        await env.BSE_DATA.get(
          "pending_alerts",
          "json"
        );


      if (!Array.isArray(alerts)) {
        alerts = [];
      }


      alerts.push(
        ...newWatchedItems
      );


      // Keep last 200 alerts
      if (alerts.length > 200) {

        alerts =
          alerts.slice(
            alerts.length - 200
          );

      }


      await env.BSE_DATA.put(
        "pending_alerts",
        JSON.stringify(alerts)
      );


      console.log(
        "NEW WATCHED RESULTS:",
        newWatchedItems.length
      );

    }


    // ----------------------------------------------
    // Save last monitoring time
    // ----------------------------------------------

    await env.BSE_DATA.put(
      "last_check",
      JSON.stringify({
        checkedAt:
          new Date().toISOString(),

        feed:
          "Financial Results",

        itemCount:
          items.length,

        newWatchedItems:
          newWatchedItems.length
      })
    );


  } catch (error) {

    console.log(
      "Background monitor error:",
      error.message
    );

  }

}


// ==================================================
// WATCHLIST API
// ==================================================

async function handleWatchlist(
  request,
  env
) {

  // ----------------------------------------------
  // GET
  // ----------------------------------------------

  if (
    request.method === "GET"
  ) {

    const watchlist =
      await getWatchlist(env);


    return json({
      ok: true,
      count: watchlist.length,
      watchlist
    });

  }


  // ----------------------------------------------
  // POST
  // ----------------------------------------------

  if (
    request.method === "POST"
  ) {

    try {

      const body =
        await request.json();


      const name =
        String(
          body.name || ""
        ).trim();


      const scrip =
        String(
          body.scrip || ""
        ).trim();


      if (
        !name ||
        !scrip
      ) {

        return json(
          {
            ok: false,
            error:
              "name and scrip are required"
          },
          400
        );

      }


      let watchlist =
        await getWatchlist(env);


      const exists =
        watchlist.some(
          item =>
            String(item.scrip) ===
            scrip
        );


      if (!exists) {

        watchlist.push({

          name,

          scrip,

          addedAt:
            new Date().toISOString()

        });


        await saveWatchlist(
          env,
          watchlist
        );

      }


      return json({

        ok: true,

        watchlist,

        added:
          !exists

      });


    } catch (error) {

      return json(
        {
          ok: false,
          error:
            "Invalid request"
        },
        400
      );

    }

  }


  // ----------------------------------------------
  // DELETE
  // ----------------------------------------------

  if (
    request.method === "DELETE"
  ) {

    const scrip =
      new URL(request.url)
        .searchParams
        .get("scrip");


    if (!scrip) {

      return json(
        {
          ok: false,
          error:
            "scrip is required"
        },
        400
      );

    }


    let watchlist =
      await getWatchlist(env);


    watchlist =
      watchlist.filter(
        item =>
          String(item.scrip) !==
          String(scrip)
      );


    await saveWatchlist(
      env,
      watchlist
    );


    return json({

      ok: true,

      watchlist

    });

  }


  return json(
    {
      ok: false,
      error:
        "Method not allowed"
    },
    405
  );

}


// ==================================================
// GET WATCHLIST
// ==================================================

async function getWatchlist(env) {

  const watchlist =
    await env.BSE_DATA.get(
      "watchlist",
      "json"
    );


  if (
    !Array.isArray(watchlist)
  ) {

    return [];

  }


  return watchlist;

}


// ==================================================
// SAVE WATCHLIST
// ==================================================

async function saveWatchlist(
  env,
  watchlist
) {

  await env.BSE_DATA.put(
    "watchlist",
    JSON.stringify(watchlist)
  );

}


// ==================================================
// UNIQUE ITEM ID
// ==================================================

function makeItemId(item) {

  return [
    item.scrip,
    item.resultType,
    item.basis,
    item.periodStart,
    item.periodEnd,
    item.link
  ].join("|");

}


// ==================================================
// PARSE RSS ITEMS
// ==================================================

function parseItems(xml) {

  const items = [];


  const itemMatches =
    xml.match(
      /<item\b[\s\S]*?<\/item>/gi
    ) || [];


  for (
    const itemXml
    of itemMatches
  ) {

    const title =
      cleanXml(
        getTag(
          itemXml,
          "title"
        )
      );


    const link =
      cleanXml(
        getTag(
          itemXml,
          "link"
        )
      );


    const description =
      cleanXml(
        getTag(
          itemXml,
          "description"
        )
      );


    if (
      !title &&
      !link
    ) {

      continue;

    }


    const company =
      parseCompany(title);


    const scrip =
      parseScrip(title);


    const resultType =
      parseResultType(
        description
      );


    const basis =
      parseBasis(
        description
      );


    const periodStart =
      parseField(
        description,
        "PERIOD START DATE"
      );


    const periodEnd =
      parseField(
        description,
        "PERIOD END DATE"
      );


    const indAs =
      parseField(
        description,
        "IND AS/NON IND AS"
      );


    items.push({

      company,

      scrip,

      resultType,

      basis,

      periodStart,

      periodEnd,

      indAs,

      title,

      link

    });

  }


  return items;

}


// ==================================================
// COMPANY
// ==================================================

function parseCompany(title) {

  if (!title) {
    return "";
  }


  const match =
    title.match(
      /^(.+?)\s*\(\d+\)\s*$/
    );


  if (match) {

    return match[1].trim();

  }


  return title.trim();

}


// ==================================================
// SCRIP
// ==================================================

function parseScrip(title) {

  if (!title) {
    return "";
  }


  const match =
    title.match(
      /\((\d+)\)\s*$/
    );


  if (match) {

    return match[1];

  }


  return "";

}


// ==================================================
// RESULT TYPE
// ==================================================

function parseResultType(
  description
) {

  if (!description) {
    return "";
  }


  // IMPORTANT:
  // Check Unaudited FIRST.

  if (
    /\bunaudited\b/i.test(
      description
    )
  ) {

    return "Unaudited";

  }


  if (
    /\baudited\b/i.test(
      description
    )
  ) {

    return "Audited";

  }


  return "";

}


// ==================================================
// BASIS
// ==================================================

function parseBasis(
  description
) {

  if (!description) {
    return "";
  }


  if (
    /\bstandalone\b/i.test(
      description
    )
  ) {

    return "Standalone";

  }


  if (
    /\bconsolidated\b/i.test(
      description
    )
  ) {

    return "Consolidated";

  }


  return "";

}


// ==================================================
// DESCRIPTION FIELD
// ==================================================

function parseField(
  description,
  fieldName
) {

  if (!description) {
    return "";
  }


  const escapedField =
    fieldName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );


  const regex =
    new RegExp(
      escapedField +
      "\\s*:\\s*([^|<]+)",
      "i"
    );


  const match =
    description.match(
      regex
    );


  if (match) {

    return match[1].trim();

  }


  return "";

}


// ==================================================
// XML TAG
// ==================================================

function getTag(
  xml,
  tag
) {

  const regex =
    new RegExp(
      "<" +
      tag +
      "\\b[^>]*>([\\s\\S]*?)<\\/" +
      tag +
      ">",
      "i"
    );


  const match =
    xml.match(
      regex
    );


  if (match) {

    return match[1].trim();

  }


  return "";

}


// ==================================================
// CLEAN XML
// ==================================================

function cleanXml(
  value
) {

  if (!value) {
    return "";
  }


  return value

    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      "$1"
    )

    .replace(
      /<[^>]+>/g,
      ""
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
    )

    .trim();

}


// ==================================================
// JSON RESPONSE
// ==================================================

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