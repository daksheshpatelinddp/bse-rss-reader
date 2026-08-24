/*
 * BSE RSS Reader Worker - STEP 3
 *
 * Source:
 * https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml
 *
 * Endpoints:
 *   /              Health/status
 *   /bse-results   Parsed BSE Financial Results JSON
 */

const BSE_FEED =
  "https://beta.bseindia.com/Data/XML/FinancialResultsFeed.xml";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    // Health check
    if (url.pathname === "/") {
      return json({
        ok: true,
        app: "BSE Financial Results Reader",
        source: "BSE Financial Results RSS",
        endpoint: "/bse-results"
      });
    }

    // BSE Financial Results
    if (url.pathname === "/bse-results") {
      return await getBseResults();
    }

    // Unknown endpoint
    return json(
      {
        ok: false,
        error: "Not found"
      },
      404
    );
  }
};


// --------------------------------------------------
// FETCH BSE RSS + RETURN PARSED JSON
// --------------------------------------------------

async function getBseResults() {
  try {
    const response = await fetch(BSE_FEED, {
      method: "GET",

      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

        "Accept":
          "application/rss+xml, application/xml, text/xml, */*",

        "Referer":
          "https://www.bseindia.com/"
      }
    });

    if (!response.ok) {
      return json(
        {
          ok: false,
          error: "BSE feed request failed",
          status: response.status
        },
        502
      );
    }

    const xml = await response.text();

    const items = parseItems(xml);

    return json({
      ok: true,
      source: "BSE Financial Results RSS",
      feedUrl: BSE_FEED,
      fetchedAt: new Date().toISOString(),
      count: items.length,
      items: items
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Failed to fetch or parse BSE RSS",
        message: error.message
      },
      502
    );
  }
}


// --------------------------------------------------
// PARSE RSS ITEMS
// --------------------------------------------------

function parseItems(xml) {
  const items = [];

  const itemMatches =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const itemXml of itemMatches) {

    const title = cleanXml(
      getTag(itemXml, "title")
    );

    const link = cleanXml(
      getTag(itemXml, "link")
    );

    const description = cleanXml(
      getTag(itemXml, "description")
    );

    // Skip invalid entries
    if (!title && !link) {
      continue;
    }

    const company = parseCompany(title);

    const scrip = parseScrip(title);

    const resultType =
      parseResultType(description);

    const basis =
      parseBasis(description);

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
      company: company,
      scrip: scrip,
      resultType: resultType,
      basis: basis,
      periodStart: periodStart,
      periodEnd: periodEnd,
      indAs: indAs,
      title: title,
      link: link
    });
  }

  return items;
}


// --------------------------------------------------
// COMPANY NAME
// --------------------------------------------------

function parseCompany(title) {

  if (!title) {
    return "";
  }

  const match =
    title.match(/^(.+?)\s*\(\d+\)\s*$/);

  if (match) {
    return match[1].trim();
  }

  return title.trim();
}


// --------------------------------------------------
// BSE SCRIP CODE
// --------------------------------------------------

function parseScrip(title) {

  if (!title) {
    return "";
  }

  const match =
    title.match(/\((\d+)\)\s*$/);

  if (match) {
    return match[1];
  }

  return "";
}


// --------------------------------------------------
// RESULT TYPE
// --------------------------------------------------

function parseResultType(description) {

  if (!description) {
    return "";
  }

  /*
   * IMPORTANT:
   *
   * "audited" is contained inside
   * "unaudited".
   *
   * Therefore Unaudited MUST be
   * checked first.
   */

  if (/\bunaudited\b/i.test(description)) {
    return "Unaudited";
  }

  if (/\baudited\b/i.test(description)) {
    return "Audited";
  }

  return "";
}


// --------------------------------------------------
// BASIS
// --------------------------------------------------

function parseBasis(description) {

  if (!description) {
    return "";
  }

  if (/\bstandalone\b/i.test(description)) {
    return "Standalone";
  }

  if (/\bconsolidated\b/i.test(description)) {
    return "Consolidated";
  }

  return "";
}


// --------------------------------------------------
// DESCRIPTION FIELD PARSER
// --------------------------------------------------

function parseField(description, fieldName) {

  if (!description) {
    return "";
  }

  const escapedField =
    fieldName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const regex = new RegExp(
    escapedField +
      "\\s*:\\s*([^|<]+)",
    "i"
  );

  const match =
    description.match(regex);

  if (match) {
    return match[1].trim();
  }

  return "";
}


// --------------------------------------------------
// XML TAG READER
// --------------------------------------------------

function getTag(xml, tag) {

  const regex = new RegExp(
    "<" +
      tag +
      "\\b[^>]*>([\\s\\S]*?)<\\/" +
      tag +
      ">",
    "i"
  );

  const match =
    xml.match(regex);

  if (match) {
    return match[1].trim();
  }

  return "";
}


// --------------------------------------------------
// CLEAN XML / HTML ENTITIES
// --------------------------------------------------

function cleanXml(value) {

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


// --------------------------------------------------
// JSON RESPONSE
// --------------------------------------------------

function json(data, status = 200) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status: status,

      headers: {
        ...CORS_HEADERS,

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}