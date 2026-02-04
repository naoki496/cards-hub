/* collection.js (cards-hub) */
(() => {
  "use strict";

  // ===== DOM =====
  const $ = (sel) => document.querySelector(sel);
  const statusDataEl  = $("#statusData");
  const statusOwnedEl = $("#statusOwned");
  const statusTotalEl = $("#statusTotal");
  const sourcesEl     = $("#sources");
  const qEl           = $("#q");
  const srcFilterEl   = $("#srcFilter");
  const ownFilterEl   = $("#ownFilter");
  const errorBoxEl    = $("#errorBox");

  const btnReload     = $("#btnReload");
  const btnExpandAll  = $("#btnExpandAll");
  const btnCollapseAll= $("#btnCollapseAll");

  // ===== Helpers =====
  function showError(msg, err) {
    console.error(msg, err || "");
    if (errorBoxEl) {
      errorBoxEl.style.display = "";
      errorBoxEl.textContent = `${msg}${err ? "\n" + (err?.message ?? String(err)) : ""}`;
    }
    if (statusDataEl) statusDataEl.textContent = "エラー";
  }

  function setStatusData(text) {
    if (statusDataEl) statusDataEl.textContent = text;
  }
  function setStatusOwned(n) {
    if (statusOwnedEl) statusOwnedEl.textContent = String(n);
  }
  function setStatusTotal(n) {
    if (statusTotalEl) statusTotalEl.textContent = String(n);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ===== localStorage (safe) =====
  function storageAvailable() {
    try {
      const x = "__storage_test__";
      localStorage.setItem(x, x);
      localStorage.removeItem(x);
      return true;
    } catch {
      return false;
    }
  }
  const StorageAdapter = (() => {
    const mem = new Map();
    const ok = storageAvailable();
    return {
      get(key) {
        if (ok) return localStorage.getItem(key);
        return mem.get(key) ?? null;
      },
      set(key, value) {
        try {
          if (ok) localStorage.setItem(key, value);
          else mem.set(key, value);
        } catch {
          mem.set(key, value);
        }
      },
    };
  })();

  function loadCounts(storageKey) {
    const raw = StorageAdapter.get(storageKey);
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  // ===== CSV load (CSVUtil if available, else fallback parser) =====
  async function loadCsv(url) {
    // cache bust (軽い保険)
    const u = new URL(url, location.href);
    if (!u.searchParams.has("v")) u.searchParams.set("v", String(Date.now()));

    // Prefer CSVUtil (your csv.js)
    if (window.CSVUtil && typeof window.CSVUtil.load === "function") {
      return await window.CSVUtil.load(u.toString());
    }

    // Fallback: minimal CSV parser (commas + quotes)
    const res = await fetch(u.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`CSV fetch failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    return parseCsvToObjects(text);
  }

  function parseCsvToObjects(csvText) {
    // Simple RFC4180-ish parser
    const rows = [];
    let row = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < csvText.length; i++) {
      const ch = csvText[i];
      const next = csvText[i + 1];

      if (inQ) {
        if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { inQ = false; continue; }
        cur += ch;
        continue;
      }

      if (ch === '"') { inQ = true; continue; }
      if (ch === ",") { row.push(cur); cur = ""; continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
      cur += ch;
    }
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);

    if (!rows.length) return [];
    const headers = rows[0].map((h) => String(h).trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const o = {};
      for (let c = 0; c < headers.length; c++) {
        o[headers[c]] = rows[r][c] ?? "";
      }
      out.push(o);
    }
    return out;
  }

  // ===== Manifest =====
  async function loadManifest() {
    const url = new URL("./cards-manifest.json", location.href);
    // キャッシュ回避
    url.searchParams.set("v", String(Date.now()));
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status} ${res.statusText}`);
    return await res.json();
  }

  // ===== State =====
  let MANIFEST = null;
  let COUNTS = {};
  let ALL = []; // merged cards
  // card shape: { id, rarity, name, img, wiki, weight, sourceId, sourceTitle }

  function normalizeCardRow(r, source) {
    const id = String(r.id ?? "").trim();
    const rarity = Number(r.rarity) || 0;
    const name = String(r.name ?? "").trim();
    const img = String(r.img ?? "").trim();
    const wiki = String(r.wiki ?? "").trim();
    const weight = Number(r.weight ?? 1) || 1;
    return {
      id,
      rarity,
      name,
      img,
      wiki,
      weight,
      sourceId: source.id,
      sourceTitle: source.title,
    };
  }

  // ===== Render =====
  function buildSourceFilterOptions(sources) {
    if (!srcFilterEl) return;
    // keep "all" first
    const current = srcFilterEl.value || "all";
    srcFilterEl.innerHTML = `<option value="all">全ソース</option>` +
      sources.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`).join("");
    srcFilterEl.value = current;
  }

  function passesFilters(card) {
    const q = (qEl?.value ?? "").trim().toLowerCase();
    const src = srcFilterEl?.value ?? "all";
    const own = ownFilterEl?.value ?? "all";

    if (src !== "all" && card.sourceId !== src) return false;

    const ownedN = Number(COUNTS[card.id] ?? 0);
    if (own === "owned" && ownedN <= 0) return false;
    if (own === "unowned" && ownedN > 0) return false;

    if (q) {
      const hay = `${card.name} ${card.sourceId} ${card.sourceTitle} ${card.wiki}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function render() {
    if (!sourcesEl) return;

    const sources = MANIFEST?.sources || [];
    const filtered = ALL.filter(passesFilters);

    // Status counts
    const total = ALL.length;
    const owned = ALL.reduce((acc, c) => acc + (Number(COUNTS[c.id] ?? 0) > 0 ? 1 : 0), 0);
    setStatusTotal(total);
    setStatusOwned(owned);

    // group by source
    const bySrc = new Map();
    for (const s of sources) bySrc.set(s.id, []);
    for (const c of filtered) {
      if (!bySrc.has(c.sourceId)) bySrc.set(c.sourceId, []);
      bySrc.get(c.sourceId).push(c);
    }

    sourcesEl.innerHTML = sources.map((s) => {
      const list = bySrc.get(s.id) || [];
      const ownedIn = list.reduce((acc, c) => acc + (Number(COUNTS[c.id] ?? 0) > 0 ? 1 : 0), 0);

      const items = list.map((c) => {
        const n = Number(COUNTS[c.id] ?? 0);
        const ownedCls = n > 0 ? "owned" : "unowned";
        const rarity = c.rarity ? `★${c.rarity}` : "";

        const wikiLink = c.wiki
          ? `<a class="mini-link" href="${escapeHtml(c.wiki)}" target="_blank" rel="noopener">wiki</a>`
          : "";

        const img = c.img
          ? `<img loading="lazy" src="${escapeHtml(c.img)}" alt="${escapeHtml(c.name)}" />`
          : `<div class="noimg">NO IMAGE</div>`;

        return `
          <div class="card ${ownedCls}">
            <div class="thumb">${img}</div>
            <div class="meta">
              <div class="name">${escapeHtml(c.name || "(no name)")}</div>
              <div class="sub">
                <span class="tag">${escapeHtml(s.id)}</span>
                <span class="tag">${escapeHtml(rarity)}</span>
                <span class="tag">所持:${n}</span>
                ${wikiLink}
              </div>
            </div>
          </div>
        `;
      }).join("");

      // data-open for expand/collapse
      return `
        <section class="src" data-src="${escapeHtml(s.id)}" data-open="1">
          <header class="src-head">
            <button class="src-toggle" type="button" data-toggle="${escapeHtml(s.id)}">
              ${escapeHtml(s.title)} <span class="src-count">(${ownedIn}/${list.length})</span>
            </button>
          </header>
          <div class="src-body">
            ${items || `<div class="empty">該当カードがありません</div>`}
          </div>
        </section>
      `;
    }).join("");

    // bind toggles
    sourcesEl.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-toggle");
        const sec = sourcesEl.querySelector(`.src[data-src="${CSS.escape(id)}"]`);
        if (!sec) return;
        const open = sec.getAttribute("data-open") === "1";
        sec.setAttribute("data-open", open ? "0" : "1");
        const body = sec.querySelector(".src-body");
        if (body) body.style.display = open ? "none" : "";
      });
    });
  }

  function expandAll(open) {
    if (!sourcesEl) return;
    sourcesEl.querySelectorAll(".src").forEach((sec) => {
      sec.setAttribute("data-open", open ? "1" : "0");
      const body = sec.querySelector(".src-body");
      if (body) body.style.display = open ? "" : "none";
    });
  }

  // ===== Load pipeline =====
  async function reloadAll() {
    if (errorBoxEl) { errorBoxEl.style.display = "none"; errorBoxEl.textContent = ""; }
    setStatusData("manifest 読み込み中…");
    setStatusOwned("--");
    setStatusTotal("--");
    if (sourcesEl) sourcesEl.innerHTML = "";

    MANIFEST = await loadManifest();

    if (!MANIFEST?.storageKey) throw new Error("manifest: storageKey がありません");
    if (!Array.isArray(MANIFEST.sources) || MANIFEST.sources.length === 0) {
      throw new Error("manifest: sources がありません");
    }

    COUNTS = loadCounts(MANIFEST.storageKey);
    buildSourceFilterOptions(MANIFEST.sources);

    setStatusData("cards.csv 読み込み中…");

    const merged = [];
    for (const src of MANIFEST.sources) {
      if (!src.id || !src.cardsCsv) continue;
      const rows = await loadCsv(src.cardsCsv);
      for (const r of rows) {
        const c = normalizeCardRow(r, src);
        if (!c.id) continue;
        merged.push(c);
      }
    }

    ALL = merged;
    setStatusData("OK");
    render();
  }

  // ===== Events =====
  function bindEvents() {
    btnReload?.addEventListener("click", () => reloadAll().catch((e) => showError("再読込に失敗しました", e)));
    btnExpandAll?.addEventListener("click", () => expandAll(true));
    btnCollapseAll?.addEventListener("click", () => expandAll(false));

    qEl?.addEventListener("input", () => render());
    srcFilterEl?.addEventListener("change", () => render());
    ownFilterEl?.addEventListener("change", () => render());
  }

  // ===== Boot =====
  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    reloadAll().catch((e) => showError("初期ロードに失敗しました", e));
  });
})();
