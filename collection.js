// collection.js (cards-hub)
// - cards-manifest.json を読み込み
// - sources[] の cardsCsv を順に読み込み（失敗しても落ちない）
// - storageKey の所持数を参照して、統合図鑑を描画
// - 戻る導線は collection.html 側のリンクで hub/index.html に戻す想定

// ===== Manifest =====
const MANIFEST_URL = "./cards-manifest.json";

// ===== DOM =====
const gridEl = document.getElementById("cardGrid");

// ===== Storage =====
function storageAvailable() {
  try {
    const x = "__storage_test__";
    window.localStorage.setItem(x, x);
    window.localStorage.removeItem(x);
    return true;
  } catch {
    return false;
  }
}

const StorageAdapter = (() => {
  const mem = new Map();
  const ok = storageAvailable();
  return {
    isPersistent: ok,
    get(key) {
      if (ok) return window.localStorage.getItem(key);
      return mem.get(key) ?? null;
    },
    set(key, value) {
      try {
        if (ok) window.localStorage.setItem(key, value);
        else mem.set(key, value);
      } catch (e) {
        mem.set(key, value);
        console.warn("[StorageAdapter] localStorage write failed; fallback to memory.", e);
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

// ===== CSV normalize (cards.csv) =====
function normalizeCardRow(r) {
  return {
    id: String(r.id ?? "").trim(),
    rarity: Number(r.rarity) || 0,
    name: String(r.name ?? "").trim(),
    img: String(r.img ?? "").trim(),
    wiki: String(r.wiki ?? "").trim(),
    weight: Number(r.weight ?? 1) || 1,
  };
}

// ===== Utils =====
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function byRarityDescThenName(a, b) {
  const ra = Number(a.rarity) || 0;
  const rb = Number(b.rarity) || 0;
  if (rb !== ra) return rb - ra;
  return String(a.name || "").localeCompare(String(b.name || ""), "ja");
}

// ===== Render =====
function renderEmpty(message) {
  if (!gridEl) return;
  gridEl.innerHTML = `<div style="opacity:.8; padding: 10px; text-align:left;">${escapeHtml(message)}</div>`;
}

/**
 * 期待する styles.css に既にあるクラス:
 * - card-item, rarity-3/4/5, card-item-name, card-item-count, card-item-rarity, card-item-detail
 * 既存UIを壊さないため、構造はできるだけ「kobun-quizの図鑑」に寄せます。
 */
function renderCards({ manifest, allCards, counts }) {
  if (!gridEl) return;

  gridEl.innerHTML = "";

  if (!allCards.length) {
    renderEmpty("カードが見つかりませんでした。manifest / cards.csv を確認してください。");
    return;
  }

  // source見出し用
  const titleBySource = new Map((manifest.sources || []).map((s) => [String(s.id), String(s.title || s.id)]));

  // 並び：ソース→レア度→名前（安定）
  const sorted = [...allCards].sort((a, b) => {
    const sa = String(a._sourceId || "");
    const sb = String(b._sourceId || "");
    if (sa !== sb) return sa.localeCompare(sb);
    return byRarityDescThenName(a, b);
  });

  let currentSource = null;

  for (const card of sorted) {
    const sourceId = String(card._sourceId || "");
    const sourceTitle = titleBySource.get(sourceId) || sourceId || "unknown";

    // ソース見出し（UIを壊さない控えめ表示）
    if (currentSource !== sourceId) {
      currentSource = sourceId;

      const head = document.createElement("div");
      head.style.margin = "10px 0 6px";
      head.style.padding = "8px 10px";
      head.style.borderRadius = "12px";
      head.style.textAlign = "left";
      head.style.opacity = "0.92";
      head.style.fontWeight = "900";
      head.style.letterSpacing = ".04em";
      head.style.background = "rgba(255,255,255,0.04)";
      head.style.border = "1px solid rgba(255,255,255,0.08)";
      head.textContent = sourceTitle;

      gridEl.appendChild(head);
    }

    // counts は「獲得側アプリが保存した card.id」を参照する。
    // ここでは “id衝突が起きない前提” なので、素直に card.id を引く。
    const owned = counts[card.id] ?? 0;

    const item = document.createElement("div");
    item.className = `card-item rarity-${Number(card.rarity) || 0}`;

    // 画像クリックでwikiに飛べる（wikiがあれば）
    // wikiが空なら、ただの表示にする
    const hasWiki = !!card.wiki;
    const safeName = escapeHtml(card.name || "");
    const safeImg = escapeHtml(card.img || "");
    const safeWiki = escapeHtml(card.wiki || "");

    if (owned > 0) {
      // unlocked
      item.innerHTML = `
        ${hasWiki
          ? `<a class="card-link" href="${safeWiki}" target="_blank" rel="noopener noreferrer">`
          : `<div class="card-link">`}
            <img src="${safeImg}" alt="${safeName}" loading="lazy" />
            <div class="card-item-name">${safeName}</div>
            <div class="card-item-count">所持：${owned}</div>
            <div class="card-item-rarity">★${Number(card.rarity) || 0}</div>
            ${hasWiki ? `<div class="card-item-detail">詳細を見る</div>` : ``}
        ${hasWiki ? `</a>` : `</div>`}
      `;
    } else {
      // locked
      item.classList.add("card-locked");
      item.innerHTML = `
        <div class="locked-img"></div>
        <div class="card-item-name">？？？</div>
        <div class="card-item-count">未入手</div>
        <div class="card-item-rarity">★${Number(card.rarity) || 0}</div>
        <div class="card-hint">クイズで★3以上を取ると入手</div>
      `;
    }

    gridEl.appendChild(item);
  }
}

// ===== Boot =====
async function boot() {
  try {
    if (!gridEl) return;

    // CSVUtil チェック
    if (!window.CSVUtil || typeof window.CSVUtil.load !== "function") {
      renderEmpty("CSVUtil が見つかりません。csv.js の読み込み順/内容を確認してください。");
      return;
    }

    // manifest
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status} ${res.statusText}`);
    const manifest = await res.json();

    const storageKey = String(manifest.storageKey || "").trim();
    const sources = Array.isArray(manifest.sources) ? manifest.sources : [];

    if (!storageKey) {
      renderEmpty("cards-manifest.json の storageKey が空です。");
      return;
    }
    if (!sources.length) {
      renderEmpty("cards-manifest.json の sources が空です。");
      return;
    }

    const counts = loadCounts(storageKey);

    // sources から cards.csv を集める（片方失敗しても継続）
    const allCards = [];
    const errors = [];

    for (const s of sources) {
      const sourceId = String(s?.id ?? "").trim();
      const cardsCsv = String(s?.cardsCsv ?? "").trim();

      if (!sourceId || !cardsCsv) {
        errors.push(`[manifest] source entry missing id/cardsCsv: ${JSON.stringify(s)}`);
        continue;
      }

      try {
        const raw = await window.CSVUtil.load(cardsCsv);
        const normalized = (raw || [])
          .map((r) => {
            const c = normalizeCardRow(r);
            return { ...c, _sourceId: sourceId };
          })
          .filter((c) => c.id && (c.rarity === 3 || c.rarity === 4 || c.rarity === 5) && c.img);

        allCards.push(...normalized);
        console.log(`[cards-hub] loaded: ${sourceId} cards=${normalized.length}`);
      } catch (e) {
        errors.push(`[cardsCsv] load failed: ${sourceId} (${cardsCsv}) -> ${e?.message ?? e}`);
        console.warn("[cards-hub] cardsCsv load failed:", sourceId, cardsCsv, e);
      }
    }

    if (errors.length) {
      console.groupCollapsed("%c[cards-hub] WARN", "color:#ffd54a;font-weight:900;");
      errors.forEach((m) => console.warn(m));
      console.groupEnd();
    }

    renderCards({ manifest, allCards, counts });
  } catch (e) {
    console.error(e);
    renderEmpty(`読み込みに失敗しました: ${e?.message ?? e}`);
  }
}

boot();
