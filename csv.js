// csv.js (global)
(function () {
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let i = 0;
    let inQuotes = false;

    while (i < text.length) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          const next = text[i + 1];
          if (next === '"') {
            field += '"';
            i += 2;
            continue;
          } else {
            inQuotes = false;
            i++;
            continue;
          }
        } else {
          field += c;
          i++;
          continue;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
          i++;
          continue;
        }
        if (c === ",") {
          row.push(field);
          field = "";
          i++;
          continue;
        }
        if (c === "\r") {
          i++;
          continue;
        }
        if (c === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
          i++;
          continue;
        }
        field += c;
        i++;
      }
    }

    // last field
    row.push(field);
    rows.push(row);

    // trim: remove empty trailing rows
    while (rows.length && rows[rows.length - 1].every(v => String(v).trim() === "")) {
      rows.pop();
    }
    return rows;
  }

  function rowsToObjects(rows) {
    if (!rows.length) return [];

    const header = rows[0].map(h => String(h).trim());
    // ✅UTF-8 BOM対策（Excel等で先頭列名が "\ufeffid" になることがある）
    if (header.length && header[0].charCodeAt(0) === 0xFEFF) {
      header[0] = header[0].slice(1);
    }

    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const obj = {};
      const line = rows[r];
      for (let c = 0; c < header.length; c++) {
        // ✅trim?.() を廃止して互換性を確保
        obj[header[c]] = String(line[c] ?? "").trim();
      }
      out.push(obj);
    }
    return out;
  }

  async function load(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`CSVの取得に失敗: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const rows = parseCSV(text);
    return rowsToObjects(rows);
  }

  window.CSVUtil = { load };
})();
