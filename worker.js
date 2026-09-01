// Base Configuration
const WORKER_URL = window.location.origin.includes("workers.dev") 
  ? window.location.origin 
  : "https://daksheshpatelin.workers.dev";

let announcements = [];
let filteredAnnouncements = [];
let currentPage = 1;
const itemsPerPage = 10;
let whitelistedScrips = JSON.parse(localStorage.getItem("whitelistedScrips")) || [];

document.addEventListener("DOMContentLoaded", () => {
  initUI();
  fetchAnnouncements();
});

function initUI() {
  renderWhitelistedTags();

  const addBtn = document.getElementById("add-scrip-btn") || document.querySelector(".whitelisted-box button");
  const scripInput = document.getElementById("scrip-input") || document.querySelector(".whitelisted-box input");
  const clearBtn = document.querySelector(".whitelisted-box .clear-btn") || document.getElementById("clear-all");
  const refreshBtn = document.querySelector(".header button") || document.getElementById("refresh-btn");
  const searchInput = document.querySelector(".announcements-section input");
  const categorySelect = document.querySelector(".announcements-section select");

  if (addBtn && scripInput) {
    addBtn.addEventListener("click", () => {
      const val = scripInput.value.trim();
      if (val && !whitelistedScrips.includes(val)) {
        whitelistedScrips.push(val);
        localStorage.setItem("whitelistedScrips", JSON.stringify(whitelistedScrips));
        scripInput.value = "";
        renderWhitelistedTags();
        applyFilters();
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      whitelistedScrips = [];
      localStorage.removeItem("whitelistedScrips");
      renderWhitelistedTags();
      applyFilters();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", fetchAnnouncements);
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => applyFilters());
  }

  if (categorySelect) {
    categorySelect.addEventListener("change", () => applyFilters());
  }
}

function renderWhitelistedTags() {
  const container = document.getElementById("whitelisted-tags") || document.querySelector(".whitelisted-box");
  let tagsContainer = document.getElementById("tags-wrapper");
  
  if (!tagsContainer && container) {
    tagsContainer = document.createElement("div");
    tagsContainer.id = "tags-wrapper";
    tagsContainer.style.marginTop = "10px";
    container.appendChild(tagsContainer);
  }

  if (tagsContainer) {
    tagsContainer.innerHTML = whitelistedScrips.map(scrip => `
      <span class="tag" style="background:#f0f0f0; padding:4px 8px; border-radius:4px; margin-right:5px; display:inline-block; font-size:12px;">
        ${escapeHtml(scrip)} 
        <span onclick="removeScrip('${escapeHtml(scrip)}')" style="cursor:pointer; margin-left:5px; color:red;">&times;</span>
      </span>
    `).join("");
  }
}

window.removeScrip = function(scrip) {
  whitelistedScrips = whitelistedScrips.filter(s => s !== scrip);
  localStorage.setItem("whitelistedScrips", JSON.stringify(whitelistedScrips));
  renderWhitelistedTags();
  applyFilters();
};

/**
 * Correctly builds BSE Attachment URLs to avoid 404 errors
 */
function getAttachmentUrl(attachmentName) {
  if (!attachmentName) return null;
  
  let cleanPath = attachmentName.trim();
  let finalBseUrl = "";

  if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://")) {
    finalBseUrl = cleanPath;
  } else {
    // Strip leading path slashes or folder descriptors
    cleanPath = cleanPath.replace(/^(xml-data\/corpfiling\/AttachLive\/|AttachLive\/|\/)/i, "");
    // BSE Attachments live under AttachLive directory
    finalBseUrl = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${cleanPath}`;
  }

  // Open through worker proxy to ensure headers are correctly passed
  return `${WORKER_URL}/?url=${encodeURIComponent(finalBseUrl)}`;
}

async function fetchAnnouncements() {
  const statusEl = document.querySelector(".announcements-section p") || document.getElementById("status-msg");
  if (statusEl) statusEl.textContent = "Loading announcements...";

  const targetBseApi = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=";
  const requestUrl = `${WORKER_URL}/?url=${encodeURIComponent(targetBseApi)}`;

  try {
    const res = await fetch(requestUrl);
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
    
    const data = await res.json();
    announcements = data.Table || data.Table1 || data || [];

    updateCategoriesUI();
    applyFilters();

    const lastUpdatedEl = document.querySelector(".announcements-section small") || document.getElementById("last-updated");
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    }
  } catch (err) {
    console.error("Failed to load BSE announcements:", err);
    if (statusEl) statusEl.textContent = `Error loading data: ${err.message}`;
  }
}

function updateCategoriesUI() {
  const categoriesContainer = document.querySelector(".categories-box") || document.getElementById("categories-container");
  const categorySelect = document.querySelector(".announcements-section select");

  const categoryCounts = {};
  announcements.forEach(item => {
    const cat = item.CATEGORYNAME || "Others";
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  if (categoriesContainer) {
    categoriesContainer.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
        ${Object.entries(categoryCounts).map(([cat, count]) => `
          <span style="background:#e9ecef; padding:5px 10px; border-radius:15px; font-size:12px;">
            ${escapeHtml(cat)} (${count})
          </span>
        `).join("")}
      </div>
    `;
  }

  if (categorySelect) {
    const currentVal = categorySelect.value;
    categorySelect.innerHTML = `<option value="ALL">All Categories</option>` + 
      Object.keys(categoryCounts).map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join("");
    categorySelect.value = currentVal || "ALL";
  }
}

function applyFilters() {
  const searchInput = document.querySelector(".announcements-section input");
  const categorySelect = document.querySelector(".announcements-section select");
  
  const query = searchInput ? searchInput.value.toLowerCase().trim() : "";
  const selectedCat = categorySelect ? categorySelect.value : "ALL";

  filteredAnnouncements = announcements.filter(item => {
    const title = (item.NEWSSUB || item.SLONGNAME || "").toLowerCase();
    const headline = (item.HEADLINE || item.MORE || "").toLowerCase();
    const scripCode = String(item.SCRIP_CD || "").toLowerCase();
    const category = item.CATEGORYNAME || "";

    const matchesQuery = !query || title.includes(query) || headline.includes(query) || scripCode.includes(query);
    const matchesCategory = (selectedCat === "ALL") || (category === selectedCat);
    
    const matchesWhitelist = whitelistedScrips.length === 0 || whitelistedScrips.some(scrip => {
      const s = scrip.toLowerCase();
      return title.includes(s) || scripCode.includes(s);
    });

    return matchesQuery && matchesCategory && matchesWhitelist;
  });

  currentPage = 1;
  renderAnnouncementsPage();
}

function renderAnnouncementsPage() {
  const container = document.getElementById("announcements-list") || document.querySelector(".announcements-section");
  const statusEl = document.querySelector(".announcements-section p");

  if (statusEl && filteredAnnouncements.length > 0) {
    statusEl.textContent = "";
  }

  let listWrapper = document.getElementById("items-wrapper");
  if (!listWrapper) {
    listWrapper = document.createElement("div");
    listWrapper.id = "items-wrapper";
    if (container) container.appendChild(listWrapper);
  }

  if (filteredAnnouncements.length === 0) {
    listWrapper.innerHTML = `<p style="padding:15px; text-align:center;">No announcements match your filter.</p>`;
    renderPagination(0);
    return;
  }

  const startIdx = (currentPage - 1) * itemsPerPage;
  const pageItems = filteredAnnouncements.slice(startIdx, startIdx + itemsPerPage);

  listWrapper.innerHTML = pageItems.map(item => {
    const title = escapeHtml(item.NEWSSUB || item.SLONGNAME || "Corporate Announcement");
    const category = escapeHtml(item.CATEGORYNAME || "General");
    const date = escapeHtml(item.NEWS_DT || item.Dis承d || "");
    const bodyText = escapeHtml(item.HEADLINE || item.MORE || "");
    const attachmentRaw = item.ATTACHMENTNAME || item.FILENAME || "";
    
    const pdfUrl = getAttachmentUrl(attachmentRaw);
    const pdfButtonHtml = pdfUrl 
      ? `<a href="${pdfUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block; margin-top:8px; padding:6px 12px; background:#007bff; color:#fff; text-decoration:none; border-radius:4px; font-size:12px;">View Attachment (PDF)</a>`
      : "";

    return `
      <div style="border:1px solid #ddd; border-radius:6px; padding:15px; margin-bottom:12px; background:#fff;">
        <div style="display:flex; justify-space-between; font-size:12px; color:#666; margin-bottom:5px;">
          <span style="font-weight:bold; color:#333;">${category}</span>
          <span>${date}</span>
        </div>
        <h4 style="margin:0 0 8px 0; font-size:15px;">${title}</h4>
        <p style="margin:0; font-size:13px; color:#444;">${bodyText}</p>
        ${pdfButtonHtml}
      </div>
    `;
  }).join("");

  renderPagination(filteredAnnouncements.length);
}

function renderPagination(totalItems) {
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const prevBtns = document.querySelectorAll(".announcements-section button:first-of-type, #prev-page");
  const nextBtns = document.querySelectorAll(".announcements-section button:last-of-type, #next-page");
  
  document.querySelectorAll(".announcements-section").forEach(sec => {
    const pageSpans = sec.querySelectorAll("span");
    pageSpans.forEach(span => {
      if (span.textContent.includes("Page")) {
        span.textContent = `Page ${currentPage} of ${totalPages}`;
      }
    });
  });

  prevBtns.forEach(btn => {
    if (btn && btn.textContent.includes("Previous")) {
      btn.disabled = currentPage === 1;
      btn.onclick = () => {
        if (currentPage > 1) {
          currentPage--;
          renderAnnouncementsPage();
        }
      };
    }
  });

  nextBtns.forEach(btn => {
    if (btn && btn.textContent.includes("Next")) {
      btn.disabled = currentPage === totalPages;
      btn.onclick = () => {
        if (currentPage < totalPages) {
          currentPage++;
          renderAnnouncementsPage();
        }
      };
    }
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}