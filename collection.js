/* cards-hub/collection.js
   - cards-manifest.json を読み込み
   - sources[].cardsCsv を順に読み込み
   - localStorage(共通キー)の所持数を反映
   - 検索 / 所持フィルタ / ソースフィルタ
   - 全展開 / 全折り畳み / 再読込

   ✅ 未所持ロック（通常）
   - 所持(n>0): 画像/名前/詳細 を表示
   - 未所持(n==0): 画像ロック/名前伏せ/詳細なし

   ✅ Preview（見た目だけ全表示）
   - URL末尾 ?preview=1 のとき
     ・ロック解除して全カードを所持風に表示
     ・ただし所持数（上部/各ソースの x/y/カード内所持表示）は現実のまま

   ✅ UI（案②）
   - カード内を「ヘッダ（名前＋★）」と「下段（所持数＋詳細）」に分離
   - ★5発光は style.css の .card.r5::before を活かすため、
     カード要素に必ず class="card r5" を付ける
*/
(() => {
  "use strict";

  // ===== URL params =====
  const params = new URLSearchParams(location.search);
  const previewAll = params.get("preview") === "1";

  // ===== DOM =====
  const elSources = document.getElementById("sources");
  const elQ = document.getElementById("q");
  const elSrcFilter = document.getElementById("srcFilter");
  const elOwnFilter = document.getElementById("ownFilter");

  const elStatusRank = document.getElementById("statusRank");
  const elStatusOwned = document.getElementById("statusOwned");
  const elStatusTotal = document.getElementById("statusTotal");
  const elErrorBox = document.getElementById("errorBox");

  const btnReload = document.getElementById("btnReload");
  const btnExpandAll = document.getElementById("btnExpandAll");
  const btnCollapseAll = document.getElementById("btnCollapseAll");

  // ===== State =====
  let manifest = null;
  /** @type {{storageKey:string, sources:Array<{id:string,title:string,cardsCsv:string}>}} */
  let cfg = { storageKey: "hklobby.v1.cardCounts", sources: [] };

  /** counts: { [cardId]: number } */
  let COUNTS = {};

  /** sourcesData: [{id,title,cardsCsv, cards:[Card]}] */
  let sourcesData = [];

  /** UI state */
  let expanded = new Set(); // sourceId set

  // ===== Utils =====
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showError(msg) {
    if (!elErrorBox) return;
    elErrorBox.style.display = "block";
    elErrorBox.textContent = String(msg ?? "エラーが発生しました");
  }

  function clearError() {
    if (!elErrorBox) return;
    elErrorBox.style.display = "none";
    elErrorBox.textContent = "";
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, val) {
    try {
      window.localStorage.setItem(key, val);
    } catch {
      // ignore
    }
  }

  function loadCounts(storageKey) {
    const raw = storageGet(storageKey);
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  function saveCounts(storageKey, counts) {
    storageSet(storageKey, JSON.stringify(counts ?? {}));
  }

  function normalizeCardRow(r) {
    // cards.csv: id, rarity, name, img, wiki, weight
    const id = String(r.id ?? "").trim();
    const rarity = Number(r.rarity) || 0;
    const name = String(r.name ?? "").trim();
    const img = String(r.img ?? "").trim();
    const wiki = String(r.wiki ?? "").trim();

    const weightRaw = r.weight ?? "";
    const weight = Number(weightRaw) || 1;

    return { id, rarity, name, img, wiki, weight };
  }

  function csvLoad(url) {
    // csv.js がある前提（既存流用）
    if (window.CSVUtil && typeof window.CSVUtil.load === "function") {
      return window.CSVUtil.load(url);
    }
    // フォールバック（最低限）
    return fetch(url, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`CSV fetch failed: ${r.status} ${url}`);
        return r.text();
      })
      .then((text) => parseCsvSimple(text));
  }

  // 超簡易CSV（カンマ区切り/ダブルクォート対応の軽量版）
  function parseCsvSimple(text) {
    const lines = String(text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    const rows = [];
    if (!lines.length) return rows;

    const header = splitCsvLine(lines[0]).map((h) => h.trim());
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const cols = splitCsvLine(line);
      const obj = {};
      for (let k = 0; k < header.length; k++) obj[header[k]] = cols[k] ?? "";
      rows.push(obj);
    }
    return rows;
  }

  function splitCsvLine(line) {
    const s = String(line ?? "");
    const out = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') {
          const next = s[i + 1];
          if (next === '"') {
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === ",") {
          out.push(cur);
          cur = "";
        } else if (ch === '"') {
          inQ = true;
        } else {
          cur += ch;
        }
      }
    }
    out.push(cur);
    return out;
  }

  function buildSearchText(card, source) {
    const parts = [
      card?.name ?? "",
      card?.wiki ?? "",
      source?.id ?? "",
      source?.title ?? "",
      `★${card?.rarity ?? ""}`,
    ];
    return parts.join(" ").toLowerCase();
  }

  // ===== Counts (現実のまま) =====
  function getOwnedCountForSource(source) {
    let owned = 0;
    for (const c of source.cards) {
      const n = Number(COUNTS[c.id] ?? 0);
      if (n > 0) owned++;
    }
    return owned;
  }

  function getTotalOwned() {
    let owned = 0;
    for (const s of sourcesData) owned += getOwnedCountForSource(s);
    return owned;
  }

  function getTotalCards() {
    let total = 0;
    for (const s of sourcesData) total += s.cards.length;
    return total;
  }

  // ===== Preview-aware owned判定（表示だけ） =====
  function isOwnedForDisplay(cardId) {
    if (previewAll) return true; // ✅ 見た目だけ全解放
    return Number(COUNTS[cardId] ?? 0) > 0;
  }

  function getRealCount(cardId) {
    return Number(COUNTS[cardId] ?? 0);
  }

  // ===== Card HTML（案②：ヘッダ分離） =====
  function renderCardHtml(c) {
    const realCount = getRealCount(c.id);
    const ownedForDisplay = isOwnedForDisplay(c.id);

    const rarityNum = Number(c.rarity || 0);
    const rarityCls = `r${rarityNum || 0}`;

    // ★5発光は style.css の .card.r5::before が担当
    // → ここで必ず class="card r5" を付ける
    const ownedCls = ownedForDisplay ? "owned" : "unowned";
    const lockedCls = ownedForDisplay ? "" : "locked";

    // 名前・画像（表示用）
    const nameText = ownedForDisplay ? (c.name || "(no name)") : "？？？？？";
    const nameHtml = escapeHtml(nameText);

    const img = ownedForDisplay
      ? c.img
        ? `<img src="${escapeHtml(c.img)}" alt="${escapeHtml(c.name)}" loading="lazy">`
        : `<div class="noimg">NO IMAGE</div>`
      : `<div class="lockbox"><span class="lock">🔒</span></div>`;

    // 詳細：通常は「所持しているときだけ」。
    // preview=1 の場合は “見た目確認”用途として開ける方が実務的なので許可。
    const hasWiki = !!c.wiki && (ownedForDisplay || previewAll);

    // 外側リンク（a入れ子禁止）
    const wrapStart = hasWiki
      ? `<a class="card ${ownedCls} ${rarityCls} ${lockedCls}" href="${escapeHtml(
          c.wiki
        )}" target="_blank" rel="noopener noreferrer">`
      : `<div class="card ${ownedCls} ${rarityCls} ${lockedCls}">`;
    const wrapEnd = hasWiki ? `</a>` : `</div>`;

    // 既存CSSは .mini-link を装飾対象（style.css）
    const wikiChip = hasWiki ? `<span class="mini-link">▶ 詳細</span>` : "";

    // ★表示（案②：ヘッダ右側）
    const starLabel = rarityNum ? `★${rarityNum}` : `★0`;

    return `
      ${wrapStart}
        <div class="thumb">${img}</div>

        <div class="meta">
          <div class="card-head">
            <div class="card-name">${nameHtml}</div>
            <div class="card-star">${escapeHtml(starLabel)}</div>
          </div>

          <div class="card-sub">
            <span class="tag">所持:${realCount}</span>
            ${wikiChip}
          </div>
        </div>
      ${wrapEnd}
    `;
  }

  // ===== Render =====
  function render() {
    if (!elSources) return;

    const q = String(elQ?.value ?? "").trim().toLowerCase();
    const srcFilter = String(elSrcFilter?.value ?? "all");
    const ownFilter = String(elOwnFilter?.value ?? "all");

    // Status（所持数は現実のまま）
    if (elStatusRank) elStatusRank.textContent = "E"; // 暫定固定
    if (elStatusOwned) elStatusOwned.textContent = String(getTotalOwned());
    if (elStatusTotal) elStatusTotal.textContent = String(getTotalCards());

    const blocks = sourcesData
      .filter((s) => (srcFilter === "all" ? true : s.id === srcFilter))
      .map((s) => {
        const isOpen = expanded.has(s.id);

        // cards filter（フィルタは現実の所持数で判断：previewでも変えない）
        const list = s.cards.filter((c) => {
          const realCount = getRealCount(c.id);

          if (ownFilter === "owned" && !(realCount > 0)) return false;
          if (ownFilter === "unowned" && !(realCount <= 0)) return false;

          if (q) {
            const hay = buildSearchText(c, s);
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const ownedCountReal = getOwnedCountForSource(s);
        const total = s.cards.length;

        const items = list.map((c) => renderCardHtml(c)).join("");

        const emptyText =
          q || ownFilter !== "all"
            ? `<div class="empty">条件に合うカードがありません。</div>`
            : `<div class="empty">このソースにはカードがありません。</div>`;

        return `
          <div class="src-block">
            <button class="src-toggle cyber" type="button" data-toggle="${escapeHtml(
              s.id
            )}">
              <span class="src-title">${escapeHtml(s.title)}</span>
              <span class="src-meta">${ownedCountReal} / ${total}</span>
            </button>

            <div class="src-body" style="display:${isOpen ? "block" : "none"}">
              <div class="card-grid">
                ${items || emptyText}
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    elSources.innerHTML =
      blocks || `<div class="empty">表示できるデータがありません。</div>`;

    // bind toggles
    Array.from(elSources.querySelectorAll("[data-toggle]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-toggle");
        if (!id) return;

        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);

        render();
      });
    });
  }

  function rebuildSourceFilter() {
    if (!elSrcFilter) return;

    const cur = elSrcFilter.value || "all";
    const opts = [
      `<option value="all">全ソース</option>`,
      ...sourcesData.map(
        (s) =>
          `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`
      ),
    ];
    elSrcFilter.innerHTML = opts.join("");

    const exists = Array.from(elSrcFilter.options).some((o) => o.value === cur);
    elSrcFilter.value = exists ? cur : "all";
  }

  function expandAll() {
    expanded = new Set(sourcesData.map((s) => s.id));
    render();
  }

  function collapseAll() {
    expanded = new Set();
    render();
  }

  // ===== Load =====
  async function loadManifest() {
    const url = new URL("./cards-manifest.json", location.href).toString();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`manifest load failed: ${res.status}`);
    return res.json();
  }

  async function loadAll() {
    clearError();

    manifest = await loadManifest();
    cfg.storageKey = String(manifest?.storageKey ?? "hklobby.v1.cardCounts");
    cfg.sources = Array.isArray(manifest?.sources) ? manifest.sources : [];

    COUNTS = loadCounts(cfg.storageKey);

    const out = [];
    for (const s of cfg.sources) {
      const sid = String(s?.id ?? "").trim();
      const title = String(s?.title ?? sid).trim();
      const cardsCsv = String(s?.cardsCsv ?? "").trim();
      if (!sid || !cardsCsv) continue;

      let raw = [];
      try {
        raw = await csvLoad(cardsCsv);
      } catch (e) {
        console.warn("[cards] load failed:", sid, cardsCsv, e);
        raw = [];
      }

      const cards = [];
      for (const r of raw) {
        try {
          const c = normalizeCardRow(r);
          if (!c.id) continue;
          cards.push(c);
        } catch {
          // ignore row
        }
      }

      out.push({ id: sid, title, cardsCsv, cards });
    }

    sourcesData = out;
    expanded = new Set(); // 初期：閉じる

    rebuildSourceFilter();
    render();
  }

  // ===== Events =====
  function bind() {
    if (elQ) elQ.addEventListener("input", () => render());
    if (elSrcFilter) elSrcFilter.addEventListener("change", () => render());
    if (elOwnFilter) elOwnFilter.addEventListener("change", () => render());

    if (btnReload) {
      btnReload.addEventListener("click", async () => {
        try {
          await loadAll();
        } catch (e) {
          showError(e?.message ?? e);
        }
      });
    }

    if (btnExpandAll) btnExpandAll.addEventListener("click", expandAll);
    if (btnCollapseAll) btnCollapseAll.addEventListener("click", collapseAll);
  }

  // ===== Boot =====
  (async function boot() {
    try {
      bind();
      await loadAll();
    } catch (e) {
      console.error(e);
      showError(e?.message ?? e);
    }
  })();

  // （将来用）counts をここからいじる場合のAPI：今は使わない
  window.__HK_CARDS_HUB__ = {
    getCounts: () => ({ ...(COUNTS || {}) }),
    setCounts: (next) => {
      COUNTS = next && typeof next === "object" ? next : {};
      saveCounts(cfg.storageKey, COUNTS);
      render();
    },
  };
})();
