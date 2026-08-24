// ==========================================
// BSE FINANCIAL RESULTS READER
// ==========================================

// Your Cloudflare Worker API
const API_URL =
  "https://bse-rss-reader.daksheshpatelin.workers.dev/bse-results";


// ==========================================
// STATE
// ==========================================

let allResults = [];

let whitelist = JSON.parse(
  localStorage.getItem("bseWhitelist") || "[]"
);


// ==========================================
// ELEMENTS
// ==========================================

const companyInput =
  document.getElementById("companyInput");

const addBtn =
  document.getElementById("addBtn");

const whitelistEl =
  document.getElementById("whitelist");

const watchCount =
  document.getElementById("watchCount");

const resultsEl =
  document.getElementById("results");

const emptyEl =
  document.getElementById("empty");

const statusEl =
  document.getElementById("status");

const lastUpdatedEl =
  document.getElementById("lastUpdated");

const searchInput =
  document.getElementById("searchInput");

const resultTypeFilter =
  document.getElementById("resultTypeFilter");

const refreshBtn =
  document.getElementById("refreshBtn");


// ==========================================
// SAVE WHITELIST
// ==========================================

function saveWhitelist() {

  localStorage.setItem(
    "bseWhitelist",
    JSON.stringify(whitelist)
  );

}


// ==========================================
// DISPLAY WHITELIST
// ==========================================

function renderWhitelist() {

  whitelistEl.innerHTML = "";

  watchCount.textContent =
    whitelist.length;


  if (whitelist.length === 0) {

    whitelistEl.innerHTML =
      '<span style="color:#777;font-size:13px">' +
      'No companies whitelisted yet.' +
      '</span>';

    return;
  }


  whitelist.forEach(item => {

    const div =
      document.createElement("div");

    div.className =
      "watch-item";


    div.innerHTML =
      `
      <span>
        ${escapeHtml(item.name)}
        (${escapeHtml(item.scrip)})
      </span>

      <button
        class="remove-watch"
        data-scrip="${escapeHtml(item.scrip)}"
      >
        ×
      </button>
      `;


    whitelistEl.appendChild(div);

  });

}


// ==========================================
// ADD COMPANY
// ==========================================

addBtn.addEventListener(
  "click",
  addCompany
);


companyInput.addEventListener(
  "keydown",
  function(event) {

    if (event.key === "Enter") {
      addCompany();
    }

  }
);


function addCompany() {

  const value =
    companyInput.value.trim();


  if (!value) {
    return;
  }


  /*
   * Find company or scrip
   * in the BSE data already received.
   */

  const searchValue =
    value.toLowerCase();


  const matches =
    allResults.filter(item => {

      const company =
        String(item.company || "")
          .toLowerCase();

      const scrip =
        String(item.scrip || "");


      return (
        company.includes(searchValue) ||
        scrip === value
      );

    });


  if (matches.length === 0) {

    alert(
      "Company or BSE scrip was not found in the current BSE feed."
    );

    return;
  }


  const item =
    matches[0];


  /*
   * Scrip code is the primary
   * whitelist identifier.
   */

  const exists =
    whitelist.some(
      watch =>
        watch.scrip === item.scrip
    );


  if (exists) {

    alert(
      item.company +
      " is already whitelisted."
    );

    return;
  }


  whitelist.push({

    name: item.company,

    scrip: item.scrip

  });


  saveWhitelist();

  renderWhitelist();

  companyInput.value = "";

  renderResults();

}


// ==========================================
// REMOVE COMPANY
// ==========================================

whitelistEl.addEventListener(
  "click",
  function(event) {

    if (
      !event.target.classList.contains(
        "remove-watch"
      )
    ) {
      return;
    }


    const scrip =
      event.target.dataset.scrip;


    whitelist =
      whitelist.filter(
        item =>
          item.scrip !== scrip
      );


    saveWhitelist();

    renderWhitelist();

    renderResults();

  }
);


// ==========================================
// LOAD BSE RESULTS
// ==========================================

async function loadResults() {

  statusEl.textContent =
    "Loading BSE results...";


  refreshBtn.disabled = true;


  try {

    const response =
      await fetch(
        API_URL + "?t=" + Date.now(),
        {
          method: "GET",
          cache: "no-store"
        }
      );


    if (!response.ok) {

      throw new Error(
        "HTTP " + response.status
      );

    }


    const data =
      await response.json();


    if (!data.ok) {

      throw new Error(
        data.error ||
        "BSE Worker returned an error"
      );

    }


    allResults =
      Array.isArray(data.items)
        ? data.items
        : [];


    statusEl.textContent =
      allResults.length +
      " BSE results received";


    lastUpdatedEl.textContent =
      "Updated " +
      new Date().toLocaleTimeString();


    renderResults();


  } catch (error) {

    console.error(
      "BSE Reader error:",
      error
    );


    statusEl.textContent =
      "Unable to load BSE results";


    lastUpdatedEl.textContent =
      error.message;


    resultsEl.innerHTML = "";


    emptyEl.classList.remove(
      "hidden"
    );


    emptyEl.textContent =
      "Could not connect to BSE Worker.";


  } finally {

    refreshBtn.disabled = false;

  }

}


// ==========================================
// FILTER RESULTS
// ==========================================

function getFilteredResults() {

  const search =
    searchInput.value
      .trim()
      .toLowerCase();


  const resultType =
    resultTypeFilter.value;


  /*
   * ========================================
   * FIRST AND MOST IMPORTANT FILTER:
   *
   * ONLY WHITELISTED SCRIPS
   * ========================================
   */

  let results =
    allResults.filter(item => {

      return whitelist.some(
        watch =>
          String(watch.scrip) ===
          String(item.scrip)
      );

    });


  /*
   * Audited / Unaudited filter
   */

  if (resultType !== "all") {

    results =
      results.filter(
        item =>
          item.resultType ===
          resultType
      );

  }


  /*
   * Search filter
   */

  if (search) {

    results =
      results.filter(item => {

        const company =
          String(item.company || "")
            .toLowerCase();

        const scrip =
          String(item.scrip || "")
            .toLowerCase();

        const periodStart =
          String(item.periodStart || "")
            .toLowerCase();

        const periodEnd =
          String(item.periodEnd || "")
            .toLowerCase();


        return (
          company.includes(search) ||
          scrip.includes(search) ||
          periodStart.includes(search) ||
          periodEnd.includes(search)
        );

      });

  }


  return results;

}


// ==========================================
// DISPLAY RESULTS
// ==========================================

function renderResults() {

  resultsEl.innerHTML = "";


  const results =
    getFilteredResults();


  if (results.length === 0) {

    emptyEl.classList.remove(
      "hidden"
    );


    if (whitelist.length === 0) {

      emptyEl.textContent =
        "Add a company to your whitelist to see its BSE results.";

    } else {

      emptyEl.textContent =
        "No results found for your whitelisted companies.";

    }


    return;

  }


  emptyEl.classList.add(
    "hidden"
  );


  results.forEach(item => {

    const card =
      document.createElement("div");


    card.className =
      "result-card";


    card.innerHTML = `

      <div class="company">
        ${escapeHtml(item.company)}
      </div>

      <div class="scrip">
        BSE: ${escapeHtml(item.scrip)}
      </div>

      <div class="meta">

        <span class="badge">
          ${escapeHtml(item.resultType)}
        </span>

        <span class="badge">
          ${escapeHtml(item.basis)}
        </span>

        <span class="badge">
          ${escapeHtml(item.indAs)}
        </span>

      </div>

      <div class="period">
        ${escapeHtml(item.periodStart)}
        →
        ${escapeHtml(item.periodEnd)}
      </div>

      <a
        class="open-btn"
        href="${escapeAttribute(item.link)}"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open BSE Result
      </a>

    `;


    resultsEl.appendChild(card);

  });

}


// ==========================================
// FILTER EVENTS
// ==========================================

searchInput.addEventListener(
  "input",
  renderResults
);


resultTypeFilter.addEventListener(
  "change",
  renderResults
);


// ==========================================
// REFRESH BUTTON
// ==========================================

refreshBtn.addEventListener(
  "click",
  loadResults
);


// ==========================================
// AUTOMATIC REFRESH
//
// 5 minutes
// ==========================================

setInterval(
  loadResults,
  5 * 60 * 1000
);


// ==========================================
// HTML SECURITY
// ==========================================

function escapeHtml(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

}


function escapeAttribute(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

}


// ==========================================
// START APPLICATION
// ==========================================

renderWhitelist();

loadResults();