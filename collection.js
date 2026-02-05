/* cards-hub/collection.js
   - cards-manifest.json を読み込み
   - sources[].cardsCsv を順に読み込み
   - localStorage(共通キー)の所持数を反映
   - 検索 / 所持フィルタ / ソースフィルタ
   - 全展開 / 全折り畳み / 再読込

   ✅ B仕様（未所持ロック）
   - 所持(n>0): 画像/名前/▶詳細を見る を表示
   - 未所持(n==0): 画像はロック枠、名前は「？？？？？」、詳細リンク無し

   ✅ 重要修正（1）
   - 「カード全体リンク <a>」の内側に「▶詳細を見る <a>」を置くと a 入れ子になり、
     ブラウザの自動補正で “謎の空白クリック領域” が発生する。
   - 対策：外側がリンクの時、内側は <span class="miniLink"> にして a 入れ子を排除。
*/
(() => {
  "use strict";

  // ===== DOM =====
  const elSources = document.getElementById("sources");
  const elQ = document.getElementById("q");
  const elSrcFilter = document.getElementById("srcFilter");
  const elOwnFilter = document.getElementById("ownFilter");

  // ✅ 新設：ランク（暫定）
  const elStatusRank = document.getElementById("statusRank");

  // 既存
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
    const rarity = Number(r.rarity);
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
    // ⑥ 画面表示からは消すが、検索対象としては保持（実用性優先）
    // ※B仕様でも「未所持を名前で検索」できてしまうのが嫌なら、ここで owned を見て name を抜くのも可能
    const parts = [
      card?.name ?? "",
      card?.wiki ?? "",
      source?.id ?? "",
      source?.title ?? "",
      `★${card?.rarity ?? ""}`,
    ];
    return parts.join(" ").toLowerCase();
  }

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

  // ===== Card HTML (B仕様) =====
  function renderCardHtml(c, n) {
    const owned = Number(n ?? 0) > 0;

    const rarityNum = Number(c.rarity || 0);
    const rarityLabel = rarityNum ? `★${rarityNum}` : "";
    const rarityCls = rarityNum ? `r${rarityNum}` : "r0";

    const ownedCls = owned ? "owned" : "unowned";
    const lockedCls = owned ? "" : "locked";

    // ✅ 未所持は名前を伏せる
    const nameHtml = owned ? escapeHtml(c.name || "(no name)") : "？？？？？";

    // ✅ 未所持は画像を出さない（ロック枠）
    const img = owned
      ? c.img
        ? `<img src="${escapeHtml(c.img)}" alt="${escapeHtml(c.name)}" loading="lazy">`
        : `<div class="noimg">NO IMAGE</div>`
      : `<div class="lockbox"><span class="lock">🔒</span></div>`;

    const hasWiki = owned && !!c.wiki;

    // ✅ クリック導線：所持かつwikiがある時だけカード全体をリンク化
    const wrapStart = hasWiki
      ? `<a class="card ${ownedCls} ${rarityCls} ${lockedCls}" href="${escapeHtml(
          c.wiki
        )}" target="_blank" rel="noopener noreferrer">`
      : `<div class="card ${ownedCls} ${rarityCls} ${lockedCls}">`;
    const wrapEnd = hasWiki ? `</a>` : `</div>`;

    // ✅ 重要：a の入れ子禁止（＝空白クリック領域の原因を除去）
    // 外側がリンクの時は、内側は span で「見た目だけ」出す
    const wikiChip = hasWiki ? `<span class="miniLink">▶詳細を見る</span>` : "";

    return `
      ${wrapStart}
        <div class="thumb">${img}</div>
        <div class="meta">
          <div class="name">${nameHtml}</div>
          <div class="sub">
            <span class="rarity">${escapeHtml(rarityLabel)}</span>
            <span class="count">所持:${owned ? Number(n ?? 0) : 0}</span>
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

    // Status
    if (elStatusRank) elStatusRank.textContent = "E"; // ✅ 暫定固定
    if (elStatusOwned) elStatusOwned.textContent = String(getTotalOwned());
    if (elStatusTotal) elStatusTotal.textContent = String(getTotalCards());

    const blocks = sourcesData
      .filter((s) => (srcFilter === "all" ? true : s.id === srcFilter))
      .map((s) => {
        const isOpen = expanded.has(s.id);

        // cards filter
        const list = s.cards.filter((c) => {
          const n = Number(COUNTS[c.id] ?? 0);
          if (ownFilter === "owned" && !(n > 0)) return false;
          if (ownFilter === "unowned" && !(n <= 0)) return false;

          if (q) {
            const hay = buildSearchText(c, s);
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const ownedCount = getOwnedCountForSource(s);
        const total = s.cards.length;

        const items = list
          .map((c) => {
            const n = Number(COUNTS[c.id] ?? 0);
            return renderCardHtml(c, n);
          })
          .join("");

        const emptyText =
          q || ownFilter !== "all"
            ? `<div class="empty">条件に合うカードがありません。</div>`
            : `<div class="empty">このソースにはカードがありません。</div>`;

        return `
          <section class="source">
            <header class="sourceHead">
              <button class="toggle" type="button" data-toggle="${escapeHtml(
                s.id
              )}">
                <span class="title">${escapeHtml(s.title)}</span>
                <span class="count">${ownedCount} / ${total}</span>
                <span class="chev">${isOpen ? "▲" : "▼"}</span>
              </button>
            </header>
            <div class="sourceBody" style="display:${isOpen ? "block" : "none"}">
              <div class="grid">
                ${items || emptyText}
              </div>
            </div>
          </section>
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

    // なるべく値を維持
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

    // counts
    COUNTS = loadCounts(cfg.storageKey);

    // sources load
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
        // 1ソース落ちても全体は生かす
        raw = [];
      }

      const cards = [];
      for (const r of raw) {
        try {
          const c = normalizeCardRow(r);
          if (!c.id) continue;
          cards.push(c);
        } catch (_) {}
      }
      out.push({ id: sid, title, cardsCsv, cards });
    }

    sourcesData = out;

    // 初期：最初は閉じておく（必要なら expandAll() に変えてOK）
    expanded = new Set();

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
