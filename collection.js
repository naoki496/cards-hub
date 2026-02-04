/* collection.js
   - cards-manifest.json を読み、sources配下のCSVを複数読み込み
   - localStorage（共通キー）の counts を参照して統合図鑑表示
   - 将来増える: manifestに追記するだけ
*/

const elSources = document.getElementById("sources");
const elQ = document.getElementById("q");
const elSrcFilter = document.getElementById("srcFilter");
const elOwnFilter = document.getElementById("ownFilter");
const elError = document.getElementById("errorBox");

const elStatusData = document.getElementById("statusData");
const elStatusOwned = document.getElementById("statusOwned");
const elStatusTotal = document.getElementById("statusTotal");

const btnReload = document.getElementById("btnReload");
const btnExpandAll = document.getElementById("btnExpandAll");
const btnCollapseAll = document.getElementById("btnCollapseAll");

let MANIFEST = null;
let ALL_CARDS = []; // [{id,rarity,name,img,wiki,weight,sourceNamespace,sourceTitle}]
let COUNTS = {};    // { [id]: number }
let SOURCES = [];   // manifest sources
let UI_STATE = { expanded: new Set() }; // expanded source namespace

function showError(msg) {
  if (!elError) return;
  elError.style.display = "block";
  elError.textContent = String(msg || "");
}
function clearError() {
  if (!elError) return;
  elError.style.display = "none";
  elError.textContent = "";
}

function safeJsonParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

function migrateCountsOnce(storageKey, legacyKeys) {
  try {
    const hasNew = !!localStorage.getItem(storageKey);
    if (hasNew) return;

    for (const k of legacyKeys || []) {
      const v = localStorage.getItem(k);
      if (v && v.trim()) {
        localStorage.setItem(storageKey, v);
        console.log(`[cards-hub] migrate ${k} -> ${storageKey}`);
        return;
      }
    }
  } catch (e) {
    console.warn("[cards-hub] migrate failed", e);
  }
}

function loadCounts(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? safeJsonParse(raw, {}) : {};
  } catch {
    return {};
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- Minimal CSV loader (no dependency) ----
// Handles: comma-separated, quotes, CRLF
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }

    if (ch === "\r" && next === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i++;
      continue;
    }

    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }

    cur += ch;
  }

  // last
  row.push(cur);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);

  // header -> objects
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if (!cols || !cols.length) continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = (cols[c] ?? "").trim();
    }
    // skip empty line
    const any = Object.values(obj).some((v) => String(v).trim().length > 0);
    if (any) out.push(obj);
  }
  return out;
}

function normalizeCardRow(r, source) {
  const id = String(r.id ?? "").trim();
  const rarity = Number(r.rarity);
  const name = String(r.name ?? "").trim();
  const img = String(r.img ?? "").trim();
  const wiki = String(r.wiki ?? "").trim();
  const weight = Number(r.weight ?? 1) || 1;

  return {
    id,
    rarity: Number.isFinite(rarity) ? rarity : 0,
    name,
    img,
    wiki,
    weight,
    sourceNamespace: source.namespace,
    sourceTitle: source.title,
    sourceHome: source.home || ""
  };
}

function isValidGlobalId(id) {
  const s = String(id || "");
  return s.includes(":") && !s.startsWith(":") && !s.endsWith(":");
}

function buildSourceOptions() {
  if (!elSrcFilter) return;
  const current = elSrcFilter.value || "all";
  elSrcFilter.innerHTML = `<option value="all">全ソース</option>` +
    SOURCES.map((s) => `<option value="${escapeHtml(s.namespace)}">${escapeHtml(s.title)}</option>`).join("");
  elSrcFilter.value = current;
}

function calcStats() {
  const total = ALL_CARDS.length;
  let ownedKinds = 0;
  for (const c of ALL_CARDS) {
    const n = Number(COUNTS[c.id] ?? 0);
    if (n > 0) ownedKinds++;
  }
  return { total, ownedKinds };
}

function updateStatus() {
  const { total, ownedKinds } = calcStats();
  if (elStatusOwned) elStatusOwned.textContent = String(ownedKinds);
  if (elStatusTotal) elStatusTotal.textContent = String(total);
}

function applyFilters(cards) {
  const q = (elQ?.value || "").trim().toLowerCase();
  const src = elSrcFilter?.value || "all";
  const own = elOwnFilter?.value || "all";

  return cards.filter((c) => {
    if (src !== "all" && c.sourceNamespace !== src) return false;

    const n = Number(COUNTS[c.id] ?? 0);
    if (own === "owned" && !(n > 0)) return false;
    if (own === "unowned" && !(n === 0)) return false;

    if (!q) return true;
    const hay = [
      c.id, c.name, c.wiki, c.sourceNamespace, c.sourceTitle
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function groupBySource(cards) {
  const map = new Map();
  for (const s of SOURCES) map.set(s.namespace, []);
  for (const c of cards) {
    if (!map.has(c.sourceNamespace)) map.set(c.sourceNamespace, []);
    map.get(c.sourceNamespace).push(c);
  }
  return map;
}

function render() {
  if (!elSources) return;

  const filtered = applyFilters(ALL_CARDS);
  const bySource = groupBySource(filtered);

  elSources.innerHTML = "";

  for (const s of SOURCES) {
    const list = bySource.get(s.namespace) || [];
    const totalInSrc = ALL_CARDS.filter((c) => c.sourceNamespace === s.namespace).length;

    // owned kinds in src
    let ownedInSrc = 0;
    for (const c of ALL_CARDS) {
      if (c.sourceNamespace !== s.namespace) continue;
      const n = Number(COUNTS[c.id] ?? 0);
      if (n > 0) ownedInSrc++;
    }

    const isExpanded = UI_STATE.expanded.has(s.namespace);

    const srcBox = document.createElement("section");
    srcBox.className = "source";
    srcBox.innerHTML = `
      <div class="source-inner">
        <div class="source-head">
          <h2 class="source-title">${escapeHtml(s.title)}</h2>
          <div class="badges">
            <span class="badge">${escapeHtml(s.namespace)}</span>
            <span class="badge ok">所持 ${ownedInSrc}/${totalInSrc}</span>
          </div>
        </div>

        <div class="source-actions">
          ${s.home ? `<a class="btn secondary" href="${escapeHtml(s.home)}" target="_blank" rel="noopener noreferrer">APPへ</a>` : ""}
          <button class="btn" data-act="toggle" data-ns="${escapeHtml(s.namespace)}">${isExpanded ? "折畳" : "展開"}</button>
        </div>

        <div class="cards ${isExpanded ? "show" : ""}" data-cards-ns="${escapeHtml(s.namespace)}"></div>
      </div>
    `;

    const cardsEl = srcBox.querySelector(`[data-cards-ns="${CSS.escape(s.namespace)}"]`);
    if (cardsEl) {
      // 表示順：所持→未所持、rarity降順、name
      const sorted = [...list].sort((a, b) => {
        const ao = Number(COUNTS[a.id] ?? 0) > 0 ? 1 : 0;
        const bo = Number(COUNTS[b.id] ?? 0) > 0 ? 1 : 0;
        if (ao !== bo) return bo - ao;
        if (a.rarity !== b.rarity) return (b.rarity || 0) - (a.rarity || 0);
        return String(a.name).localeCompare(String(b.name), "ja");
      });

      cardsEl.innerHTML = sorted.map((c) => {
        const n = Number(COUNTS[c.id] ?? 0);
        const countCls = n > 0 ? "count-on" : "count-off";
        const wikiLink = c.wiki
          ? `<a class="btn secondary" href="${escapeHtml(c.wiki)}" target="_blank" rel="noopener noreferrer">WIKI</a>`
          : "";

        // 未所持は画像をぼかし + ロック表示（軽量）
        const locked = n <= 0;
        const imgStyle = locked ? 'style="filter: blur(1px); opacity:.65;"' : "";
        const lockBadge = locked ? ` <span class="badge ng">未所持</span>` : ` <span class="badge ok">所持</span>`;

        return `
          <div class="card">
            <img src="${escapeHtml(c.img)}" alt="${escapeHtml(c.name)}" ${imgStyle} loading="lazy" />
            <div class="card-main">
              <div class="card-name">${escapeHtml(c.name)}${lockBadge}</div>
              <div class="card-meta">ID: ${escapeHtml(c.id)} / ★${escapeHtml(c.rarity)}</div>
              <div class="card-count ${countCls}">所持回数：${n}</div>
              <div class="source-actions">
                ${wikiLink}
              </div>
            </div>
          </div>
        `;
      }).join("") || `<div style="opacity:.7;">（該当カードなし）</div>`;
    }

    elSources.appendChild(srcBox);
  }

  updateStatus();
}

function setExpandedAll(on) {
  UI_STATE.expanded.clear();
  if (on) {
    for (const s of SOURCES) UI_STATE.expanded.add(s.namespace);
  }
  render();
}

function hookEvents() {
  btnReload?.addEventListener("click", () => boot());
  btnExpandAll?.addEventListener("click", () => setExpandedAll(true));
  btnCollapseAll?.addEventListener("click", () => setExpandedAll(false));

  elQ?.addEventListener("input", () => render());
  elSrcFilter?.addEventListener("change", () => render());
  elOwnFilter?.addEventListener("change", () => render());

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.getAttribute("data-act");
    if (act !== "toggle") return;
    const ns = t.getAttribute("data-ns") || "";
    if (!ns) return;
    if (UI_STATE.expanded.has(ns)) UI_STATE.expanded.delete(ns);
    else UI_STATE.expanded.add(ns);
    render();
  });
}

async function loadManifest() {
  const res = await fetch(`./cards-manifest.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest 読み込み失敗: HTTP ${res.status}`);
  const json = await res.json();
  return json;
}

async function loadCardsFromSource(source) {
  const res = await fetch(`${source.csv}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`[${source.namespace}] cards.csv 読み込み失敗: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);

  const cards = [];
  for (const r of rows) {
    const c = normalizeCardRow(r, source);
    if (!c.id) continue;
    cards.push(c);
  }
  return cards;
}

function validateGlobalIds(cards) {
  const errs = [];
  const dup = new Map();

  for (const c of cards) {
    if (!isValidGlobalId(c.id)) {
      errs.push(`invalid id (namespace missing): "${c.id}"  ※例: kobun:001`);
    }
    dup.set(c.id, (dup.get(c.id) || 0) + 1);
  }
  for (const [id, n] of dup.entries()) {
    if (n >= 2) errs.push(`id duplicate: "${id}" x${n}`);
  }
  return errs;
}

async function boot() {
  clearError();
  if (elStatusData) elStatusData.textContent = "読み込み中…";
  if (elStatusOwned) elStatusOwned.textContent = "--";
  if (elStatusTotal) elStatusTotal.textContent = "--";

  try {
    MANIFEST = await loadManifest();
    const storageKey = String(MANIFEST.storageKey || "hklobby.v1.cardCounts");
    const legacyKeys = Array.isArray(MANIFEST.legacyKeys) ? MANIFEST.legacyKeys : [];

    migrateCountsOnce(storageKey, legacyKeys);
    COUNTS = loadCounts(storageKey);

    SOURCES = Array.isArray(MANIFEST.sources) ? MANIFEST.sources : [];
    if (!SOURCES.length) throw new Error("manifest: sources が空です");

    buildSourceOptions();

    // load all sources
    const all = [];
    for (const s of SOURCES) {
      try {
        const got = await loadCardsFromSource(s);
        all.push(...got);
      } catch (e) {
        // source単位で失敗しても、全体は動かす
        console.warn(e);
        showError((elError.textContent ? elError.textContent + "\n" : "") + String(e.message || e));
      }
    }

    ALL_CARDS = all;

    const errs = validateGlobalIds(ALL_CARDS);
    if (errs.length) {
      showError((elError.textContent ? elError.textContent + "\n" : "") + errs.join("\n"));
    }

    // default expand: first source only
    if (!UI_STATE.expanded.size && SOURCES[0]?.namespace) UI_STATE.expanded.add(SOURCES[0].namespace);

    const { total, ownedKinds } = calcStats();
    if (elStatusData) elStatusData.textContent = "OK";
    if (elStatusOwned) elStatusOwned.textContent = String(ownedKinds);
    if (elStatusTotal) elStatusTotal.textContent = String(total);

    render();
  } catch (e) {
    console.error(e);
    if (elStatusData) elStatusData.textContent = "ERROR";
    showError(e?.message ?? String(e));
  }
}

hookEvents();
boot();
