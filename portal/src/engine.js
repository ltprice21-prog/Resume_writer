/* AMI Order Desk — core engine.
 *
 * Pure logic: ZIP, XLSX read/write, PDF text extraction, PO field parsing,
 * tracker row construction, EML generation. No DOM, no network, no API calls.
 * Runs identically in the browser and in Node (for the test suite).
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Bytes & compression
   * ------------------------------------------------------------------ */

  const DEC = new TextDecoder('utf-8');
  const ENC = new TextEncoder();
  const LATIN1 = new TextDecoder('latin1');

  function concatBytes(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  async function streamThrough(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return concatBytes(chunks);
  }

  const inflateRaw = (b) => streamThrough(b, new DecompressionStream('deflate-raw'));
  const inflateZlib = (b) => streamThrough(b, new DecompressionStream('deflate'));

  let deflateSupported = null;
  async function deflateRaw(bytes) {
    if (deflateSupported === false) return null;
    try {
      const out = await streamThrough(bytes, new CompressionStream('deflate-raw'));
      deflateSupported = true;
      return out;
    } catch (e) {
      deflateSupported = false;
      return null;
    }
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ------------------------------------------------------------------ *
   * ZIP
   * ------------------------------------------------------------------ */

  function findEOCD(b) {
    const min = 22;
    const start = Math.max(0, b.length - 66000);
    for (let i = b.length - min; i >= start; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4B && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
    }
    return -1;
  }

  /** Read a zip into an ordered array of { name, bytes }. */
  async function unzip(bytes) {
    const b = new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const eocd = findEOCD(b);
    if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-directory record found).');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = DEC.decode(b.subarray(off + 46, off + 46 + nameLen));

      const lhNameLen = dv.getUint16(localOff + 26, true);
      const lhExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const raw = b.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('Unsupported compression in .xlsx entry: ' + name);
      entries.push({ name, bytes: data });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  /** Write an ordered array of { name, bytes } back into a zip. */
  async function zip(entries) {
    const { time, date } = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = ENC.encode(e.name);
      const data = e.bytes;
      const crc = crc32(data);
      let method = 0;
      let payload = data;
      const packed = await deflateRaw(data);
      if (packed && packed.length < data.length) { method = 8; payload = packed; }

      const lh = new Uint8Array(30 + nameBytes.length);
      const ldv = new DataView(lh.buffer);
      ldv.setUint32(0, 0x04034b50, true);
      ldv.setUint16(4, 20, true);
      ldv.setUint16(6, 0, true);
      ldv.setUint16(8, method, true);
      ldv.setUint16(10, time, true);
      ldv.setUint16(12, date, true);
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, payload.length, true);
      ldv.setUint32(22, data.length, true);
      ldv.setUint16(26, nameBytes.length, true);
      ldv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      locals.push(lh, payload);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(ch.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0, true);
      cdv.setUint16(10, method, true);
      cdv.setUint16(12, time, true);
      cdv.setUint16(14, date, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, payload.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      centrals.push(ch);

      offset += lh.length + payload.length;
    }

    const cdBytes = concatBytes(centrals);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, cdBytes.length, true);
    edv.setUint32(16, offset, true);
    return concatBytes([...locals, cdBytes, eocd]);
  }

  /* ------------------------------------------------------------------ *
   * XML helpers
   * ------------------------------------------------------------------ */

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unescapeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
  }

  function colToIndex(col) {
    let n = 0;
    for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
    return n;
  }

  function indexToCol(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * Dates
   * ------------------------------------------------------------------ */

  const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01

  function dateToSerial(d) {
    const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round(utc / 86400000) + EXCEL_EPOCH_OFFSET;
  }

  function serialToDate(serial) {
    const ms = (Math.round(serial) - EXCEL_EPOCH_OFFSET) * 86400000;
    const d = new Date(ms);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /** Parse the date formats that appear on the PO ("Jan 9, 2026", "9 Jan 2026", "01/09/2026"). */
  function parseDate(text) {
    if (!text) return null;
    const s = String(text).trim();
    let m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) {
      const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mi >= 0) return new Date(parseInt(m[3], 10), mi, parseInt(m[2], 10));
    }
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
    if (m) {
      const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      if (mi >= 0) return new Date(parseInt(m[3], 10), mi, parseInt(m[1], 10));
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return null;
  }

  const MONTHS_TITLE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "Apr 8 2026" — the format used in the vendor email table. */
  function formatEmailDate(d) {
    if (!d) return '';
    return MONTHS_TITLE[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
  }

  function formatISO(d) {
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function formatShort(d) {
    if (!d) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  function daysBetween(a, b) {
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
      - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }

  /* ------------------------------------------------------------------ *
   * PDF text extraction (positional)
   * ------------------------------------------------------------------ */

  function indexOfSeq(hay, needle, from) {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  const SEQ = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  /**
   * Pull every `stream ... endstream` payload out of a PDF, along with the
   * /Length the object declares (when it is a literal rather than a reference).
   */
  function rawStreams(bytes) {
    const b = new Uint8Array(bytes);
    const kw = SEQ('stream');
    const endKw = SEQ('endstream');
    const out = [];
    let i = 0;
    while (i < b.length - 6) {
      const at = indexOfSeq(b, kw, i);
      if (at < 0) break;
      // Skip the "stream" inside "endstream".
      if (at >= 3 && b[at - 3] === 0x65 && b[at - 2] === 0x6E && b[at - 1] === 0x64) { i = at + 6; continue; }
      let j = at + 6;
      if (b[j] === 0x0D) j++;
      if (b[j] === 0x0A) j++;
      const end = indexOfSeq(b, endKw, j);
      if (end < 0) break;

      const dict = LATIN1.decode(b.subarray(Math.max(0, at - 400), at));
      const lenMatch = /\/Length\s+(\d+)\s*(?:\/|>>)/.exec(dict);
      out.push({
        data: b.subarray(j, end),
        declared: lenMatch ? parseInt(lenMatch[1], 10) : null,
      });
      i = end + 9;
    }
    return out;
  }

  /**
   * DecompressionStream rejects trailing bytes, but PDF streams are routinely
   * padded with an EOL before `endstream`. Try the declared length first, then a
   * trimmed slice, then the raw bytes, under both zlib and raw deflate.
   */
  async function inflateTolerant(raw, declared) {
    const attempts = [];
    if (declared != null && declared > 0 && declared <= raw.length) attempts.push(raw.subarray(0, declared));
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 0x0A || raw[end - 1] === 0x0D
      || raw[end - 1] === 0x20 || raw[end - 1] === 0x09)) end--;
    if (end !== raw.length) attempts.push(raw.subarray(0, end));
    attempts.push(raw);

    for (const decoder of [inflateZlib, inflateRaw]) {
      for (const a of attempts) {
        if (!a.length) continue;
        try {
          const out = await decoder(a);
          if (out && out.length) return out;
        } catch (e) { /* try the next candidate */ }
      }
    }
    return null;
  }

  /** Decode a PDF literal string, honouring escapes and line continuations. */
  function decodePdfString(raw) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== '\\') { out += ch; continue; }
      const next = raw[++i];
      if (next === undefined) break;
      if (next === '\n') continue;                       // line continuation
      if (next === '\r') { if (raw[i + 1] === '\n') i++; continue; }
      if (next === 'n') { out += '\n'; continue; }
      if (next === 'r') { out += '\r'; continue; }
      if (next === 't') { out += '\t'; continue; }
      if (next === 'b') { out += '\b'; continue; }
      if (next === 'f') { out += '\f'; continue; }
      if (next >= '0' && next <= '7') {
        let oct = next;
        while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
        continue;
      }
      out += next;                                        // \( \) \\ and anything else
    }
    return out;
  }

  /** Tokenise a content stream into text-showing operations with device coordinates. */
  function textItemsFromContent(content) {
    const items = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = tm.slice();
    let leading = 0;
    const stack = [];

    const mul = (m, n) => [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];

    const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s\/\[\]<>()]+|-?\d*\.?\d+|[A-Za-z'"*]+/g;
    let m;
    const tokens = [];
    while ((m = re.exec(content)) !== null) tokens.push(m[0]);

    const emit = (text) => {
      if (text && text.trim()) items.push({ x: tm[4], y: tm[5], text });
    };

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const num = (k) => parseFloat(tokens[i - k]);
      switch (t) {
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
        case 'TL': leading = num(1); break;
        case 'Td': tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm.slice(); break;
        case 'TD': leading = -num(1); tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm.slice(); break;
        case 'Tm': tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tm = tlm.slice(); break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
        case 'q': stack.push({ tm: tm.slice(), tlm: tlm.slice(), leading }); break;
        case 'Q': { const s = stack.pop(); if (s) { tm = s.tm; tlm = s.tlm; leading = s.leading; } break; }
        case 'Tj': case 'TJ': {
          let text = '';
          if (t === 'Tj') {
            const raw = tokens[i - 1];
            if (raw && raw[0] === '(') text = decodePdfString(raw.slice(1, -1));
          } else {
            // Walk back to the opening bracket, collecting the string pieces.
            let depth = 0, parts = [];
            for (let k = i - 1; k >= 0; k--) {
              if (tokens[k] === ']') depth++;
              else if (tokens[k] === '[') { if (depth === 0) break; depth--; }
              else if (depth === 0 && tokens[k][0] === '(') parts.unshift(decodePdfString(tokens[k].slice(1, -1)));
            }
            text = parts.join('');
          }
          emit(text);
          break;
        }
        case "'": {
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice();
          const raw = tokens[i - 1];
          if (raw && raw[0] === '(') emit(decodePdfString(raw.slice(1, -1)));
          break;
        }
        default: break;
      }
    }
    return items;
  }

  /** Group text items into visual lines, left-to-right, top-to-bottom. */
  function itemsToLines(items, tol) {
    const t = tol || 3;
    const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines = [];
    let cur = null;
    for (const it of sorted) {
      if (cur && Math.abs(it.y - cur.y) <= t) {
        cur.items.push(it);
      } else {
        cur = { y: it.y, items: [it] };
        lines.push(cur);
      }
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.text = l.items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
    }
    return lines;
  }

  /**
   * Extract pages of positioned text from a PDF.
   * Duplicate renderings of the same page (identified by the "PAGE: n/m" footer)
   * are dropped so a line item is never counted twice.
   */
  async function extractPdfPages(bytes) {
    const streams = rawStreams(bytes);
    const pages = [];
    const seenLabels = new Set();
    for (const s of streams) {
      const inflated = await inflateTolerant(s.data, s.declared);
      // An uncompressed content stream is legal; fall back to the raw bytes.
      const text = LATIN1.decode(inflated || s.data);
      if (!/\bTj\b|\bTJ\b/.test(text)) continue;
      const items = textItemsFromContent(text);
      if (!items.length) continue;
      const lines = itemsToLines(items);
      const joined = lines.map((l) => l.text).join('\n');
      const label = (joined.match(/PAGE:\s*(\d+)\s*\/\s*(\d+)/i) || [])[0];
      if (label) {
        if (seenLabels.has(label)) continue;
        seenLabels.add(label);
      }
      pages.push({ items, lines, text: joined });
    }
    return pages;
  }

  /* ------------------------------------------------------------------ *
   * Purchase-order field extraction
   * ------------------------------------------------------------------ */

  /**
   * Text to the right of a label on the same visual line, stopping at the next
   * label. PO layouts put two label/value pairs on one line, so "Entered By: Bo
   * Price   Delivery Date:" must yield "Bo Price" and nothing more.
   */
  function valueRightOf(lines, labelRe) {
    const isLabel = (s) => /:\s*$/.test(s);
    for (const line of lines) {
      for (const it of line.items) {
        if (!labelRe.test(it.text)) continue;
        const right = [];
        for (const o of line.items) {
          if (o.x <= it.x + 1) continue;
          if (isLabel(o.text)) break;
          right.push(o.text.trim());
        }
        if (right.length) return { value: right.join(' ').trim(), x: it.x, y: line.y };
      }
    }
    return null;
  }

  /** Lines whose left-most item sits in a column, between two anchor labels. */
  function blockUnder(lines, startRe, stopRe, xMin, xMax) {
    let started = false;
    const out = [];
    for (const line of lines) {
      const hit = line.items.find((it) => startRe.test(it.text) && it.x >= xMin && it.x <= xMax);
      if (hit) { started = true; continue; }
      if (!started) continue;
      if (line.items.some((it) => stopRe.test(it.text) && it.x >= xMin && it.x <= xMax)) break;
      const inCol = line.items.filter((it) => it.x >= xMin && it.x <= xMax);
      if (inCol.length) out.push(inCol.map((i) => i.text).join(' ').trim());
    }
    return out;
  }

  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  const COLUMN_KEYS = [
    { re: /^Item No/i, key: 'itemNo' },
    { re: /^Description/i, key: 'description' },
    { re: /^Size/i, key: 'size' },
    { re: /^Qty/i, key: 'qty' },
    { re: /^UOM/i, key: 'uom' },
    { re: /^Unit Price/i, key: 'unitPrice' },
    { re: /^Ext\.?\s*Amount/i, key: 'extAmount' },
  ];

  function parseNumber(s) {
    if (s == null) return null;
    const cleaned = String(s).replace(/[^0-9.\-]/g, '');
    if (!cleaned || !/\d/.test(cleaned)) return null;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /** Locate the line-item table and read its rows by nearest-header-column matching. */
  function extractLineItems(pages) {
    const rows = [];
    for (const page of pages) {
      let header = null;
      for (const line of page.lines) {
        const cols = [];
        for (const it of line.items) {
          const hit = COLUMN_KEYS.find((c) => c.re.test(it.text));
          if (hit) cols.push({ key: hit.key, x: it.x });
        }
        if (cols.length >= 5) { header = cols; continue; }
        if (!header) continue;

        const itemCol = header.find((c) => c.key === 'itemNo');
        const qtyCol = header.find((c) => c.key === 'qty');
        if (!itemCol || !qtyCol) continue;

        const hasItem = line.items.some((it) => Math.abs(it.x - itemCol.x) < 12);
        if (!hasItem) continue;

        const row = {};
        for (const it of line.items) {
          let best = null, bestD = Infinity;
          for (const c of header) {
            const d = Math.abs(it.x - c.x);
            if (d < bestD) { bestD = d; best = c; }
          }
          if (!best) continue;
          row[best.key] = (row[best.key] ? row[best.key] + ' ' : '') + it.text.trim();
        }
        if (row.qty == null || parseNumber(row.qty) == null) continue;
        rows.push({
          itemNo: (row.itemNo || '').trim(),
          description: (row.description || '').trim(),
          size: (row.size || '').trim(),
          qty: parseNumber(row.qty),
          uom: (row.uom || '').trim(),
          unitPrice: parseNumber(row.unitPrice),
          extAmount: parseNumber(row.extAmount),
        });
      }
    }
    // Drop identical repeats produced by duplicate page renderings.
    const seen = new Set();
    const unique = [];
    let duplicates = 0;
    for (const r of rows) {
      const k = [r.itemNo, r.description, r.size, r.qty, r.uom, r.unitPrice, r.extAmount].join('|');
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k);
      unique.push(r);
    }
    return { items: unique, duplicatesDropped: duplicates };
  }

  /** Bottles per case implied by a size string such as "1 X 12 L" or "12x1L". */
  function bottlesPerCaseFromSize(size) {
    if (!size) return null;
    const s = size.replace(/\s+/g, '').toUpperCase();
    let m = s.match(/^(\d+)X(\d+)([A-Z]*)$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      // "1 X 12 L" means one case of twelve; "12x1L" means twelve of one litre.
      return Math.max(a, b) === b && a === 1 ? b : (a > 1 && b === 1 ? a : Math.max(a, b));
    }
    return null;
  }

  /**
   * Extract every field the tracker and the vendor email need from a PO PDF.
   * Every returned field carries the label it was read from; nothing is inferred.
   */
  function parsePurchaseOrder(pages, fileName) {
    const allLines = [];
    for (const p of pages) allLines.push(...p.lines);
    const fullText = pages.map((p) => p.text).join('\n');

    const get = (re) => { const r = valueRightOf(allLines, re); return r ? r.value : ''; };

    const poNumber = get(/^Order No/i);
    const orderDateRaw = get(/^Order Date/i);
    const pickupDateRaw = get(/^Pickup Date/i);
    const deliveryDateRaw = get(/^Delivery Date/i);
    const enteredBy = get(/^Entered By/i);
    const shipmentMethod = get(/^Shipment Method/i);
    const shippingAgent = get(/^Shipping Agent/i);
    const terms = get(/^Terms$/i);
    const currency = get(/^Currency:/i) || (fullText.match(/Currency\s*:\s*([A-Z]{3})/) || [])[1] || '';
    const refNo = get(/^Ref No/i);

    const vendorBlock = blockUnder(allLines, /^Vendor:/i, /^Ship From:/i, 0, 200);
    const shipToBlock = blockUnder(allLines, /^Ship To:/i, /^Terms$/i, 300, 620);

    const hasEmail = (s) => { EMAIL_RE.lastIndex = 0; return EMAIL_RE.test(s); };
    const vendorEmails = (vendorBlock.join(' ').match(EMAIL_RE) || []);
    const vendorName = vendorBlock[0] || '';

    // The contact sits on the line directly above the vendor's email address,
    // as "Name  <phone>". Registration numbers (FDA…) are not contacts.
    const emailIdx = vendorBlock.findIndex(hasEmail);
    const vendorContactLine = emailIdx > 0 ? vendorBlock[emailIdx - 1] : '';
    const vendorPhone = (vendorContactLine.match(/[\d][\d()+\s-]{6,}$/) || [''])[0].trim();
    const vendorContact = vendorContactLine.replace(/[\d][\d()+\s-]{6,}$/, '').trim();
    const vendorRegistration = vendorBlock.find((l) => /^[A-Z]{2,4}\d{6,}$/.test(l.trim())) || '';
    const vendorAddress = vendorBlock
      .filter((l, i) => i > 0 && !hasEmail(l) && l !== vendorContactLine && l !== vendorRegistration)
      .join(', ');

    const shipToEmails = (shipToBlock.join(' ').match(EMAIL_RE) || []);
    const shipToName = shipToBlock[0] || '';

    const confirmTo = (fullText.match(/confirm order to\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i) || [])[1] || '';
    const docsTo = (fullText.match(/e-?mailed to\s*\n?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i) || [])[1] || '';

    const { items, duplicatesDropped } = extractLineItems(pages);
    const primary = items[0] || null;

    const totalMatch = fullText.match(/Total\s*:\s*([\d,]+\.\d{2})/);
    const total = totalMatch ? parseNumber(totalMatch[1]) : null;

    // The "FOR FINAL DELIVERY TO:" block is quoted verbatim in the vendor email.
    const finalDeliveryLines = [];
    {
      let capturing = false;
      for (const line of allLines) {
        const t = line.text.trim();
        if (/^FOR FINAL DELIVERY TO:/i.test(t)) { capturing = true; continue; }
        if (!capturing) continue;
        if (/^(o\s*Country of Origin|Document Requirements|o\s*Bottled in)/i.test(t)) break;
        if (t) finalDeliveryLines.push(t);
      }
    }

    const countryOfOrigin = (fullText.match(/Country of Origin:\s*([A-Za-z ]+)/i) || [])[1] || '';
    const bottledIn = (fullText.match(/Bottled in:\s*([A-Za-z ]+)/i) || [])[1] || '';
    const itemReference = (fullText.match(/Item Reference No\.?:\s*(.+)/i) || [])[1] || '';

    const warnings = [];
    if (!poNumber) warnings.push('No "Order No." found on this PDF.');
    if (!primary) warnings.push('No line item could be read from this PDF.');
    if (duplicatesDropped) warnings.push(duplicatesDropped + ' duplicate line-item rendering(s) ignored.');
    if (items.length > 1) warnings.push('This PO has ' + items.length + ' line items; the tracker row uses the first. Review the others manually.');

    const orderDate = parseDate(orderDateRaw);
    const pickupDate = parseDate(pickupDateRaw);
    const deliveryDate = parseDate(deliveryDateRaw);
    if (orderDateRaw && !orderDate) warnings.push('Order Date "' + orderDateRaw + '" was not recognised as a date.');
    if (pickupDateRaw && !pickupDate) warnings.push('Pickup Date "' + pickupDateRaw + '" was not recognised as a date.');

    return {
      fileName: fileName || '',
      poNumber, refNo, enteredBy, shipmentMethod, shippingAgent, terms, currency,
      orderDateRaw, pickupDateRaw, deliveryDateRaw,
      orderDate, pickupDate, deliveryDate,
      vendorName, vendorAddress, vendorContact, vendorPhone, vendorRegistration,
      vendorEmail: vendorEmails[0] || '',
      vendorEmails,
      shipToName, shipToBlock, shipToEmails,
      confirmTo, docsTo,
      finalDeliveryTo: finalDeliveryLines,
      countryOfOrigin, bottledIn, itemReference,
      items, lineItem: primary, total,
      itemNo: primary ? primary.itemNo : '',
      description: primary ? primary.description : '',
      size: primary ? primary.size : '',
      qty: primary ? primary.qty : null,
      uom: primary ? primary.uom : '',
      unitPrice: primary ? primary.unitPrice : null,
      extAmount: primary ? primary.extAmount : null,
      bottlesPerCaseFromSize: primary ? bottlesPerCaseFromSize(primary.size) : null,
      warnings,
      fullText,
    };
  }

  /* ------------------------------------------------------------------ *
   * Workbook
   * ------------------------------------------------------------------ */

  const CELL_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
  const ROW_RE = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;

  function getAttr(attrs, name) {
    const m = new RegExp(name + '="([^"]*)"').exec(attrs || '');
    return m ? m[1] : null;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const parts = [];
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tRe.exec(m[1])) !== null) parts.push(unescapeXml(t[1]));
      out.push(parts.join(''));
    }
    return out;
  }

  class Sheet {
    constructor(name, path, xml, shared) {
      this.name = name;
      this.path = path;
      this.xml = xml;
      this.shared = shared;
      this.rows = new Map();
      this.parse();
    }

    parse() {
      this.rows.clear();
      ROW_RE.lastIndex = 0;
      let m;
      while ((m = ROW_RE.exec(this.xml)) !== null) {
        const attrs = m[1] || m[2] || '';
        const body = m[3] || '';
        const r = parseInt(getAttr(attrs, 'r') || '0', 10);
        if (!r) continue;
        const cells = new Map();
        CELL_RE.lastIndex = 0;
        let c;
        while ((c = CELL_RE.exec(body)) !== null) {
          const cAttrs = c[1] || c[2] || '';
          const cBody = c[3] || '';
          const ref = getAttr(cAttrs, 'r');
          if (!ref) continue;
          const col = ref.replace(/\d+/g, '');
          const type = getAttr(cAttrs, 't');
          const style = getAttr(cAttrs, 's');
          const fm = /<f\b([^>]*?)\/>|<f\b([^>]*?)>([\s\S]*?)<\/f>/.exec(cBody);
          const vm = /<v>([\s\S]*?)<\/v>/.exec(cBody);
          const ism = /<is>([\s\S]*?)<\/is>/.exec(cBody);
          let text = '';
          let num = null;
          const rawV = vm ? unescapeXml(vm[1]) : null;
          if (type === 's' && rawV != null) text = this.shared[parseInt(rawV, 10)] || '';
          else if (type === 'inlineStr' && ism) {
            const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
            let t; const parts = [];
            while ((t = tRe.exec(ism[1])) !== null) parts.push(unescapeXml(t[1]));
            text = parts.join('');
          } else if (type === 'str' && rawV != null) text = rawV;
          else if (rawV != null) { num = parseFloat(rawV); text = rawV; }

          cells.set(col, {
            ref, col, row: r, style, type,
            formula: fm ? { attrs: (fm[1] || fm[2] || '').trim(), text: fm[3] || null } : null,
            value: rawV, text, num,
          });
        }
        this.rows.set(r, { r, attrs, body, cells });
      }
    }

    cell(row, col) {
      const rw = this.rows.get(row);
      return rw ? rw.cells.get(col) || null : null;
    }

    cellText(row, col) {
      const c = this.cell(row, col);
      return c ? c.text : '';
    }

    maxRow() {
      let max = 0;
      for (const r of this.rows.keys()) if (r > max) max = r;
      return max;
    }

    /** Find the shared-formula master (the cell carrying the actual formula text) for an si index. */
    sharedMaster(si) {
      for (const rw of this.rows.values()) {
        for (const c of rw.cells.values()) {
          if (c.formula && c.formula.text && getAttr(c.formula.attrs, 'si') === String(si)
            && /t="shared"/.test(c.formula.attrs) && /ref="/.test(c.formula.attrs)) {
            return c;
          }
        }
      }
      return null;
    }

    /** Resolve the effective formula text for a cell, following shared references. */
    formulaTextFor(cell) {
      if (!cell || !cell.formula) return null;
      if (cell.formula.text) return { text: cell.formula.text, baseRow: cell.row };
      const si = getAttr(cell.formula.attrs, 'si');
      if (si == null) return null;
      const master = this.sharedMaster(si);
      if (!master || !master.formula.text) return null;
      return { text: master.formula.text, baseRow: master.row };
    }

    /** Scan for a label anywhere in the sheet and return the first useful cell to its right. */
    lookupLabel(labelRe, opts) {
      const wantNumber = opts && opts.number;
      const span = (opts && opts.span) || 3;
      for (const rw of this.rows.values()) {
        for (const c of rw.cells.values()) {
          if (!c.text || !labelRe.test(c.text)) continue;
          const startIdx = colToIndex(c.col);
          for (let k = 1; k <= span; k++) {
            const nc = rw.cells.get(indexToCol(startIdx + k));
            if (!nc) continue;
            if (wantNumber) { if (nc.num != null && Number.isFinite(nc.num)) return nc; }
            else if (nc.text !== '') return nc;
          }
        }
      }
      return null;
    }
  }

  class Workbook {
    constructor(entries) {
      this.entries = entries;
      this.map = new Map(entries.map((e) => [e.name, e]));
      const wbXml = DEC.decode(this.map.get('xl/workbook.xml').bytes);
      const relsXml = DEC.decode(this.map.get('xl/_rels/workbook.xml.rels').bytes);

      const rels = new Map();
      const relRe = /<Relationship\b([^>]*)\/>/g;
      let m;
      while ((m = relRe.exec(relsXml)) !== null) {
        const id = getAttr(m[1], 'Id');
        let target = getAttr(m[1], 'Target') || '';
        if (!target.startsWith('/')) target = 'xl/' + target.replace(/^\.\//, '');
        rels.set(id, target.replace(/^xl\/\.\.\//, ''));
      }

      const ssEntry = this.map.get('xl/sharedStrings.xml');
      this.shared = ssEntry ? parseSharedStrings(DEC.decode(ssEntry.bytes)) : [];

      this.sheets = [];
      const sheetRe = /<sheet\b([^>]*)\/>/g;
      while ((m = sheetRe.exec(wbXml)) !== null) {
        const name = unescapeXml(getAttr(m[1], 'name') || '');
        const rid = getAttr(m[1], 'r:id') || getAttr(m[1], 'id');
        const path = rels.get(rid);
        if (!path || !this.map.has(path)) continue;
        this.sheets.push(new Sheet(name, path, DEC.decode(this.map.get(path).bytes), this.shared));
      }
    }

    static async load(bytes) {
      return new Workbook(await unzip(bytes));
    }

    sheet(name) {
      return this.sheets.find((s) => s.name === name) || null;
    }

    /** Persist a sheet's modified XML back into the zip entry list. */
    commitSheet(sheet) {
      const entry = this.map.get(sheet.path);
      entry.bytes = ENC.encode(sheet.xml);
      sheet.parse();
    }

    /** Drop the calculation chain so Excel rebuilds it after structural edits. */
    dropCalcChain() {
      const name = 'xl/calcChain.xml';
      if (!this.map.has(name)) return;
      this.entries = this.entries.filter((e) => e.name !== name);
      this.map.delete(name);
      const ct = this.map.get('[Content_Types].xml');
      if (ct) {
        const xml = DEC.decode(ct.bytes).replace(/<Override[^>]*calcChain\.xml[^>]*\/>/g, '');
        ct.bytes = ENC.encode(xml);
      }
      const relsName = 'xl/_rels/workbook.xml.rels';
      const rels = this.map.get(relsName);
      if (rels) {
        const xml = DEC.decode(rels.bytes).replace(/<Relationship[^>]*calcChain\.xml[^>]*\/>/g, '');
        rels.bytes = ENC.encode(xml);
      }
    }

    async toBytes() {
      return zip(this.entries);
    }
  }

  /* ------------------------------------------------------------------ *
   * Tracker model
   * ------------------------------------------------------------------ */

  /** Locate the order-log header row (the one containing "PO#") and map headers to columns. */
  function findHeaderRow(sheet) {
    for (const r of [...sheet.rows.keys()].sort((a, b) => a - b)) {
      const rw = sheet.rows.get(r);
      let hasPo = false, filled = 0;
      for (const c of rw.cells.values()) {
        if (!c.text) continue;
        filled++;
        if (/^PO\s*#/i.test(c.text.trim())) hasPo = true;
      }
      if (hasPo && filled >= 5) {
        const columns = [];
        for (const c of rw.cells.values()) {
          if (c.text && c.text.trim()) columns.push({ col: c.col, header: c.text.trim() });
        }
        columns.sort((a, b) => colToIndex(a.col) - colToIndex(b.col));
        return { row: r, columns };
      }
    }
    return null;
  }

  function dataRows(sheet, header) {
    const poCol = header.columns.find((c) => /^PO\s*#/i.test(c.header));
    if (!poCol) return [];
    const out = [];
    for (const r of [...sheet.rows.keys()].sort((a, b) => a - b)) {
      if (r <= header.row) continue;
      const c = sheet.cell(r, poCol.col);
      if (c && c.text && c.text.trim()) out.push(r);
    }
    return out;
  }

  /** Read the product/logistics constants from the top block of the sheet. */
  function readSheetConfig(sheet) {
    const num = (re) => { const c = sheet.lookupLabel(re, { number: true }); return c ? c.num : null; };
    const txt = (re) => { const c = sheet.lookupLabel(re, {}); return c ? c.text : ''; };
    return {
      productName: txt(/^Product Name:?$/i),
      caseSize: txt(/^Case Size:?$/i),
      customer: txt(/^Customer:?$/i),
      airlinePart: txt(/^Airline part\/item ?#:?$/i),
      navCode: txt(/^NAV Code:?$/i),
      supplier: txt(/^Supplier\s*:?$/i),
      collectionLocation: txt(/^Collection Location:?$/i),
      countryOfOrigin: txt(/^Country of Origin:?$/i),
      hsCode: txt(/^HS\/HTS Code:?$/i),
      wineryClosedDates: txt(/^Winery closed dates:?$/i),
      minimumOrder: txt(/^Minimum order quantity\s*$/i),
      bottlesPerCase: num(/^Bottles\/case$/i),
      casesPerPallet: num(/^cs\/pallet$/i),
      caseWeight: num(/^Case weight$/i),
      palletWeight: num(/^Full Pallet Weight \(inc pallet\)\s*$/i),
      leadTimeDays: num(/^Production Lead Time \(days\)( Ongoing Order)?:?$/i),
      transitDays: num(/^Lead Time on Water\/Road \(days\):?$/i),
    };
  }

  /* Header patterns mapped to values read straight off the PO PDF. */
  const PDF_COLUMN_MAP = [
    { re: /^PO\s*#/i, field: 'poNumber', label: 'Order No.' },
    { re: /^Quantity \(bt\)/i, field: 'bottles', label: 'Qty x bottles per case' },
    { re: /^Quantity \(cs\)/i, field: 'cases', label: 'Qty' },
    { re: /^Quantity \(pallets\)/i, field: 'pallets', label: 'Qty / cases per pallet' },
    { re: /^PO date sent to winery/i, field: 'orderDate', label: 'Order Date' },
    { re: /^AMI Requested\s+Collection Date/i, field: 'pickupDate', label: 'Pickup Date' },
    { re: /^Customer Required Delivery Date/i, field: 'requiredDelivery', label: 'Delivery Date' },
    { re: /^Forwarder$/i, field: 'shippingAgent', label: 'Shipping Agent' },
  ];

  const SOURCE = {
    PDF: 'pdf',
    FORMULA: 'formula',
    COMPUTED: 'computed',
    CARRIED: 'carried',
    MANUAL: 'manual',
  };

  /**
   * Decide, for each tracker column, what the new row should contain and where it came from.
   * Priority: continue an existing formula > read from the PDF > carry a value that is
   * identical across recent rows > leave blank for a human.
   */
  function planRow(sheet, header, config, po, options) {
    const opts = options || {};
    const rows = dataRows(sheet, header);
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    const newRow = (lastRow || header.row) + 1;

    const bottlesPerCase = config.bottlesPerCase || po.bottlesPerCaseFromSize || null;
    const casesPerPallet = config.casesPerPallet || null;
    const cases = po.qty;
    const bottles = (cases != null && bottlesPerCase) ? cases * bottlesPerCase : null;
    const pallets = (cases != null && casesPerPallet) ? cases / casesPerPallet : null;

    // The tracker derives the collection date from the customer's required delivery date.
    // If the PO carries no delivery date, recover it from the pickup date and transit time.
    let requiredDelivery = po.deliveryDate;
    let requiredDeliverySource = SOURCE.PDF;
    let requiredDeliveryNote = 'Delivery Date on the PO';
    if (!requiredDelivery && po.pickupDate && config.transitDays != null) {
      requiredDelivery = new Date(po.pickupDate.getTime());
      requiredDelivery.setDate(requiredDelivery.getDate() + config.transitDays);
      requiredDeliverySource = SOURCE.COMPUTED;
      requiredDeliveryNote = 'Pickup Date + ' + config.transitDays + ' transit day(s); the PO carried no Delivery Date';
    } else if (!requiredDelivery) {
      requiredDeliverySource = SOURCE.MANUAL;
      requiredDeliveryNote = 'Not on the PO and not derivable — enter manually';
    }

    const pdfValues = {
      poNumber: { value: po.poNumber, kind: 'text' },
      bottles: { value: bottles, kind: 'number' },
      cases: { value: cases, kind: 'number' },
      pallets: { value: pallets, kind: 'number' },
      orderDate: { value: po.orderDate, kind: 'date' },
      pickupDate: { value: po.pickupDate, kind: 'date' },
      requiredDelivery: { value: requiredDelivery, kind: 'date' },
      shippingAgent: { value: po.shippingAgent, kind: 'text' },
    };

    const carriedCandidates = rows.slice(-4);
    const fields = [];

    for (const colDef of header.columns) {
      const prev = lastRow ? sheet.cell(lastRow, colDef.col) : null;
      const map = PDF_COLUMN_MAP.find((p) => p.re.test(colDef.header));

      // 1. The sheet already computes this column — keep it computing.
      const prevFormula = prev ? sheet.formulaTextFor(prev) : null;
      if (prevFormula) {
        fields.push({
          col: colDef.col,
          header: colDef.header,
          kind: 'formula',
          source: SOURCE.FORMULA,
          formulaBase: prevFormula,
          note: 'Formula continued from row ' + lastRow + ': ' + prevFormula.text,
          style: prev ? prev.style : null,
          editable: false,
          crossCheck: map ? map.field : null,
        });
        continue;
      }

      // 2. Straight from the PDF.
      if (map && pdfValues[map.field] && pdfValues[map.field].value != null && pdfValues[map.field].value !== '') {
        const pv = pdfValues[map.field];
        const isDerived = map.field === 'requiredDelivery' ? requiredDeliverySource : null;
        const isComputed = map.field === 'bottles' || map.field === 'pallets';
        fields.push({
          col: colDef.col,
          header: colDef.header,
          kind: pv.kind,
          source: isDerived || (isComputed ? SOURCE.COMPUTED : SOURCE.PDF),
          value: pv.value,
          note: map.field === 'requiredDelivery' ? requiredDeliveryNote
            : map.field === 'bottles' ? 'Qty ' + cases + ' cs x ' + bottlesPerCase + ' bottles/case (tracker config)'
              : map.field === 'pallets' ? 'Qty ' + cases + ' cs / ' + casesPerPallet + ' cs per pallet (tracker config)'
                : 'PO field "' + map.label + '"',
          style: prev ? prev.style : null,
          editable: true,
        });
        continue;
      }

      // 3. Identical across recent rows — offer it, clearly flagged.
      const vals = carriedCandidates.map((r) => sheet.cell(r, colDef.col)).map((c) => (c ? c.text : ''));
      const nonEmpty = vals.filter((v) => v !== '');
      const allSame = nonEmpty.length >= 2 && nonEmpty.every((v) => v === nonEmpty[0]);
      if (allSame && !/date|lot|invoice|notes|balance/i.test(colDef.header)) {
        fields.push({
          col: colDef.col,
          header: colDef.header,
          kind: 'text',
          source: SOURCE.CARRIED,
          value: nonEmpty[0],
          note: 'Identical on the last ' + nonEmpty.length + ' orders — not read from this PO',
          style: prev ? prev.style : null,
          editable: true,
        });
        continue;
      }

      // 4. Nothing to say — leave it for a human.
      fields.push({
        col: colDef.col,
        header: colDef.header,
        kind: /date/i.test(colDef.header) ? 'date' : 'text',
        source: SOURCE.MANUAL,
        value: null,
        note: 'Not present on the PO — fill in when known',
        style: prev ? prev.style : null,
        editable: true,
      });
    }

    return {
      newRow, lastRow, fields,
      derived: { bottles, cases, pallets, bottlesPerCase, casesPerPallet, requiredDelivery },
      po,
    };
  }

  /* ------------------------------------------------------------------ *
   * Validation
   * ------------------------------------------------------------------ */

  /** The PO number this row will actually carry, which an edit may have changed. */
  function planPoNumber(plan, po) {
    const f = plan.fields.find((x) => /^PO\s*#/i.test(x.header));
    if (f && f.value != null && String(f.value).trim() !== '') return String(f.value).trim();
    return po && po.poNumber ? String(po.poNumber).trim() : '';
  }

  function validatePlan(sheet, header, config, plan, po, existingPoNumbers) {
    const issues = [];
    const add = (level, message, detail) => issues.push({ level, message, detail: detail || '' });

    const effectivePo = planPoNumber(plan, po);
    if (!effectivePo) add('error', 'No PO number was read from this PDF.');
    else if (existingPoNumbers.has(effectivePo)) {
      add('error', 'PO ' + effectivePo + ' is already in this sheet.', 'Adding it again would double-count the volume against the contract.');
    }

    if (po.qty == null) add('error', 'No quantity was read from this PDF.');
    if (!config.bottlesPerCase) add('warn', 'The tracker has no "Bottles/case" value, so bottles could not be computed.');
    if (!config.casesPerPallet) add('warn', 'The tracker has no "cs/pallet" value, so pallets could not be computed.');

    const { cases, casesPerPallet, pallets, bottlesPerCase } = plan.derived;
    if (pallets != null && Math.abs(pallets - Math.round(pallets)) > 1e-9) {
      add('warn', 'This order is ' + pallets.toFixed(2) + ' pallets, not a whole number.',
        cases + ' cases / ' + casesPerPallet + ' cases per pallet leaves a partial pallet.');
    }

    // The PO states cases; the sheet derives cases from bottles. Confirm the round trip.
    if (bottlesPerCase && po.bottlesPerCaseFromSize && bottlesPerCase !== po.bottlesPerCaseFromSize) {
      add('warn', 'Case size mismatch.',
        'The PO size field reads "' + po.size + '" (' + po.bottlesPerCaseFromSize
        + ' bottles/case) but the tracker is configured for ' + bottlesPerCase + '.');
    }

    // The sheet computes the collection date; confirm it lands on the PO's pickup date.
    const collectionField = plan.fields.find((f) => /^AMI Requested\s+Collection Date/i.test(f.header));
    if (collectionField && collectionField.source === SOURCE.FORMULA && po.pickupDate && collectionField.computedValue instanceof Date) {
      const delta = daysBetween(collectionField.computedValue, po.pickupDate);
      if (delta !== 0) {
        add('error', 'The collection date the tracker computes does not match the PO.',
          'Tracker formula gives ' + formatShort(collectionField.computedValue)
          + ' but the PO Pickup Date is ' + formatShort(po.pickupDate) + ' (' + delta + ' day difference).');
      }
    }

    // Production lead time.
    if (po.orderDate && po.pickupDate && config.leadTimeDays != null) {
      const available = daysBetween(po.orderDate, po.pickupDate);
      if (available < config.leadTimeDays) {
        add('warn', 'Collection is inside the production lead time.',
          available + ' days between the order date and pickup, against a stated lead time of '
          + config.leadTimeDays + ' days.');
      }
    }

    if (config.wineryClosedDates) {
      add('info', 'Check the winery closure window before confirming.', config.wineryClosedDates);
    }

    for (const w of po.warnings) add('warn', w);
    return issues;
  }

  /* ------------------------------------------------------------------ *
   * Row rendering
   * ------------------------------------------------------------------ */

  /** Shift relative row references in a formula by `delta` rows. */
  function shiftFormula(text, delta) {
    return text.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, d1, col, d2, row) => {
      if (d2) return m;
      return d1 + col + d2 + (parseInt(row, 10) + delta);
    });
  }

  function cellXml(ref, style, kind, value, formula) {
    const s = style != null ? ' s="' + style + '"' : '';
    if (formula) {
      const v = value != null && value !== '' ? '<v>' + escapeXml(value) + '</v>' : '';
      return '<c r="' + ref + '"' + s + '><f>' + escapeXml(formula) + '</f>' + v + '</c>';
    }
    if (value == null || value === '') return '<c r="' + ref + '"' + s + '/>';
    if (kind === 'number' || kind === 'date') {
      return '<c r="' + ref + '"' + s + '><v>' + value + '</v></c>';
    }
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">'
      + escapeXml(value) + '</t></is></c>';
  }

  /** Turn a plan into the XML for one worksheet row. */
  function renderRowXml(plan) {
    const parts = [];
    const cols = plan.fields.slice().sort((a, b) => colToIndex(a.col) - colToIndex(b.col));
    for (const f of cols) {
      const ref = f.col + plan.newRow;
      if (f.source === SOURCE.FORMULA && f.formulaBase) {
        const formula = shiftFormula(f.formulaBase.text, plan.newRow - f.formulaBase.baseRow);
        const cached = f.computedValue instanceof Date ? dateToSerial(f.computedValue)
          : (typeof f.computedValue === 'number' ? f.computedValue : '');
        parts.push(cellXml(ref, f.style, 'number', cached, formula));
        continue;
      }
      let v = f.value;
      if (f.kind === 'date') v = v instanceof Date ? dateToSerial(v) : (v == null || v === '' ? '' : v);
      parts.push(cellXml(ref, f.style, f.kind, v, null));
    }
    const first = cols.length ? cols[0].col : 'A';
    const last = cols.length ? cols[cols.length - 1].col : 'A';
    return '<row r="' + plan.newRow + '" spans="' + colToIndex(first) + ':' + colToIndex(last) + '">'
      + parts.join('') + '</row>';
  }

  /** Insert the rendered row into the sheet XML and widen the stored dimension. */
  function appendRow(sheet, rowXml, newRow) {
    let xml = sheet.xml;
    if (!/<\/sheetData>/.test(xml)) {
      if (/<sheetData\s*\/>/.test(xml)) xml = xml.replace(/<sheetData\s*\/>/, '<sheetData>' + rowXml + '</sheetData>');
      else throw new Error('Worksheet has no <sheetData> section.');
    } else {
      xml = xml.replace('</sheetData>', rowXml + '</sheetData>');
    }
    xml = xml.replace(/<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/, (m, c1, r1, c2, r2) => {
      const end = Math.max(parseInt(r2, 10), newRow);
      return '<dimension ref="' + c1 + r1 + ':' + c2 + end + '"/>';
    });
    sheet.xml = xml;
    return xml;
  }

  /**
   * Evaluate the small subset of formulas the tracker uses, so the written row
   * carries a correct cached value and the UI can show what Excel will display.
   */
  function evaluateFormula(sheet, formulaText, rowNum, pendingByRef) {
    const expr = formulaText.replace(/\$/g, '');
    const refRe = /^[A-Z]{1,3}\d+$/;
    const tokens = expr.split(/([+\-*/()])/).map((t) => t.trim()).filter((t) => t !== '');
    const resolved = [];
    for (const t of tokens) {
      if (/^[+\-*/()]$/.test(t)) { resolved.push(t); continue; }
      if (/^-?\d*\.?\d+$/.test(t)) { resolved.push(t); continue; }
      if (!refRe.test(t)) return null;
      const col = t.replace(/\d+/g, '');
      const r = parseInt(t.replace(/[A-Z]/g, ''), 10);
      let val = null;
      if (pendingByRef && pendingByRef.has(col + r)) val = pendingByRef.get(col + r);
      else {
        const c = sheet.cell(r, col);
        val = c && c.num != null && Number.isFinite(c.num) ? c.num : null;
      }
      if (val == null) return null;
      resolved.push(String(val));
    }
    const safe = resolved.join(' ');
    if (!/^[\d\s.+\-*/()]+$/.test(safe)) return null;
    try {
      // eslint-disable-next-line no-new-func
      const out = Function('"use strict";return (' + safe + ')')();
      return Number.isFinite(out) ? out : null;
    } catch (e) {
      return null;
    }
  }

  /** Fill in cached formula results for a plan, resolving in column order. */
  function computePlanFormulas(sheet, plan) {
    const pending = new Map();
    const cols = plan.fields.slice().sort((a, b) => colToIndex(a.col) - colToIndex(b.col));
    for (const f of cols) {
      if (f.source === SOURCE.FORMULA) continue;
      if (f.kind === 'date' && f.value instanceof Date) pending.set(f.col + plan.newRow, dateToSerial(f.value));
      else if (f.kind === 'number' && typeof f.value === 'number') pending.set(f.col + plan.newRow, f.value);
    }
    for (const f of cols) {
      if (f.source !== SOURCE.FORMULA || !f.formulaBase) continue;
      const shifted = shiftFormula(f.formulaBase.text, plan.newRow - f.formulaBase.baseRow);
      const val = evaluateFormula(sheet, shifted, plan.newRow, pending);
      if (val != null) {
        pending.set(f.col + plan.newRow, val);
        f.computedValue = /date/i.test(f.header) ? serialToDate(val) : val;
        f.computedRaw = val;
      }
      f.formulaText = shifted;
    }
    return plan;
  }

  /* ------------------------------------------------------------------ *
   * Follow-up rules
   * ------------------------------------------------------------------ */

  const FOLLOW_UP_RULES = [
    {
      id: 'winery-confirm',
      party: 'winery',
      missing: /^Winery Confirmed Available Date/i,
      after: /^PO date sent to winery/i,
      graceDays: 5,
      subject: 'Order confirmation outstanding',
      ask: 'confirm the order and the exact available collection date',
    },
    {
      id: 'bottling-date',
      party: 'winery',
      missing: /^Bottling Date Confirmed/i,
      after: /^PO date sent to winery/i,
      graceDays: 10,
      subject: 'Bottling date outstanding',
      ask: 'confirm the bottling date',
    },
    {
      id: 'lot-number',
      party: 'winery',
      missing: /^Lot Number/i,
      after: /^Actual Collection Date/i,
      graceDays: 2,
      subject: 'Lot number outstanding',
      ask: 'provide the lot number for the collected goods',
    },
    {
      id: 'collection',
      party: 'forwarder',
      missing: /^Actual Collection Date/i,
      after: /^AMI Requested\s+Collection Date/i,
      graceDays: 1,
      subject: 'Collection confirmation outstanding',
      ask: 'confirm the actual collection date from the cellars',
    },
    {
      id: 'delivery',
      party: 'forwarder',
      missing: /^(Delivery date to CDG|Actual delivery date)/i,
      after: /^Actual Collection Date/i,
      graceDays: 4,
      subject: 'Delivery confirmation outstanding',
      ask: 'confirm the delivery date',
    },
    {
      id: 'winery-invoice',
      party: 'winery',
      missing: /^Winery invoice received/i,
      after: /^Actual Collection Date/i,
      graceDays: 7,
      subject: 'Winery invoice outstanding',
      ask: 'send the final invoice for this collection',
    },
    {
      id: 'proof-of-export',
      party: 'internal',
      missing: /^Proof of [Ee]xport/i,
      after: /^(Delivery date to CDG|Actual delivery date)/i,
      graceDays: 7,
      blankValues: ['to fill'],
      subject: 'Proof of export outstanding',
      ask: 'send the proof of export (EMCS) to the winery',
    },
    {
      id: 'forwarder-invoice',
      party: 'forwarder',
      missing: /^Forwarder's invoice$/i,
      after: /^(Delivery date to CDG|Actual delivery date)/i,
      graceDays: 14,
      subject: 'Forwarder invoice outstanding',
      ask: 'send the freight invoice for this delivery',
    },
  ];

  function findCol(header, re) {
    const c = header.columns.find((x) => re.test(x.header));
    return c ? c.col : null;
  }

  /** Walk the tracker and list every open item that is past its grace period. */
  function findOpenItems(sheet, header, today, rules) {
    const active = rules || FOLLOW_UP_RULES;
    const rows = dataRows(sheet, header);
    const poCol = findCol(header, /^PO\s*#/i);
    const out = [];
    const now = today || new Date();

    for (const r of rows) {
      const po = sheet.cellText(r, poCol).trim();
      for (const rule of active) {
        const missingCol = findCol(header, rule.missing);
        const afterCol = findCol(header, rule.after);
        if (!missingCol || !afterCol) continue;

        const missingCell = sheet.cell(r, missingCol);
        let text = missingCell ? String(missingCell.text || '').trim() : '';
        const treatBlank = (rule.blankValues || []).some((b) => text.toLowerCase() === b.toLowerCase());
        if (text !== '' && !treatBlank) continue;

        const afterCell = sheet.cell(r, afterCol);
        if (!afterCell || afterCell.num == null || !Number.isFinite(afterCell.num)) continue;
        const anchor = serialToDate(afterCell.num);
        const age = daysBetween(anchor, now);
        if (age < rule.graceDays) continue;

        out.push({
          row: r, po, ruleId: rule.id, party: rule.party,
          missingHeader: header.columns.find((c) => c.col === missingCol).header,
          anchorHeader: header.columns.find((c) => c.col === afterCol).header,
          anchorDate: anchor, ageDays: age,
          subject: rule.subject, ask: rule.ask,
          placeholder: treatBlank ? text : '',
        });
      }
    }
    out.sort((a, b) => b.ageDays - a.ageDays);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Email generation
   * ------------------------------------------------------------------ */

  function b64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(bytes).toString('base64');
  }

  function wrap76(s) {
    return s.replace(/(.{76})/g, '$1\r\n');
  }

  function encodeHeader(value) {
    if (/^[\x20-\x7E]*$/.test(value)) return value;
    return '=?UTF-8?B?' + b64(ENC.encode(value)) + '?=';
  }

  function rfc2822Date(d) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const oh = p(Math.floor(Math.abs(off) / 60));
    const om = p(Math.abs(off) % 60);
    return days[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_TITLE[d.getMonth()] + ' ' + d.getFullYear()
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + sign + oh + om;
  }

  /**
   * Build an RFC-822 .eml. X-Unsent tells Outlook to open it as an editable draft
   * rather than a received message.
   */
  function buildEml(opts) {
    const boundary = '----=_AMI_' + Math.random().toString(36).slice(2, 10);
    const lines = [];
    lines.push('MIME-Version: 1.0');
    lines.push('X-Unsent: 1');
    lines.push('Date: ' + rfc2822Date(opts.date || new Date()));
    if (opts.from) lines.push('From: ' + opts.from);
    if (opts.to) lines.push('To: ' + opts.to);
    if (opts.cc) lines.push('Cc: ' + opts.cc);
    lines.push('Subject: ' + encodeHeader(opts.subject || ''));

    const attachments = opts.attachments || [];
    if (!attachments.length) {
      lines.push('Content-Type: text/html; charset="utf-8"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('');
      lines.push(wrap76(b64(ENC.encode(opts.html || ''))));
      return lines.join('\r\n');
    }

    lines.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    lines.push('');
    lines.push('--' + boundary);
    lines.push('Content-Type: text/html; charset="utf-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(wrap76(b64(ENC.encode(opts.html || ''))));
    for (const a of attachments) {
      lines.push('--' + boundary);
      lines.push('Content-Type: ' + (a.mime || 'application/octet-stream') + '; name="' + a.name + '"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('Content-Disposition: attachment; filename="' + a.name + '"');
      lines.push('');
      lines.push(wrap76(b64(a.bytes)));
    }
    lines.push('--' + boundary + '--');
    lines.push('');
    return lines.join('\r\n');
  }

  const TABLE_COLUMNS = [
    { key: 'po', label: 'PO #' },
    { key: 'bt', label: 'PO Quantity (bt)' },
    { key: 'cs', label: 'PO Quantity (cs)' },
    { key: 'pal', label: 'PO Quantity (Pallets)' },
    { key: 'bottling', label: 'Bottling' },
    { key: 'bottlingDate', label: 'Bottling Date' },
    { key: 'expiry', label: 'Expiration Date' },
    { key: 'collection', label: 'AMI Requested Collection Date' },
  ];

  function orderTableHtml(rows) {
    const th = TABLE_COLUMNS.map((c) =>
      '<th style="border:1px solid #999;padding:4px 8px;background:#f2f2f2;text-align:left;'
      + 'font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + escapeXml(c.label) + '</th>').join('');
    const trs = rows.map((r) => '<tr>' + TABLE_COLUMNS.map((c) =>
      '<td style="border:1px solid #999;padding:4px 8px;font-family:Calibri,Arial,sans-serif;font-size:11pt;">'
      + escapeXml(r[c.key] == null ? '' : String(r[c.key])) + '</td>').join('') + '</tr>').join('');
    return '<table style="border-collapse:collapse;margin:12px 0;"><thead><tr>' + th
      + '</tr></thead><tbody>' + trs + '</tbody></table>';
  }

  function fillTemplate(template, vars) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
  }

  /** Distinct PO stems, e.g. 350632-1..4 and 350633-1..2 become "350632 - 350633". */
  function poGroups(poNumbers) {
    const stems = [];
    for (const p of poNumbers) {
      const stem = String(p).split('-')[0];
      if (!stems.includes(stem)) stems.push(stem);
    }
    return stems.join(' - ');
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */

  const AMI = {
    // bytes / zip
    unzip, zip, crc32, concatBytes,
    // xlsx
    Workbook, Sheet, findHeaderRow, dataRows, readSheetConfig,
    colToIndex, indexToCol, escapeXml, unescapeXml,
    // dates
    dateToSerial, serialToDate, parseDate, formatEmailDate, formatISO, formatShort, daysBetween,
    // pdf
    extractPdfPages, parsePurchaseOrder, textItemsFromContent, itemsToLines, decodePdfString,
    bottlesPerCaseFromSize, parseNumber,
    // planning
    planRow, computePlanFormulas, renderRowXml, appendRow, validatePlan, shiftFormula, planPoNumber,
    evaluateFormula, SOURCE, PDF_COLUMN_MAP,
    // follow-ups
    FOLLOW_UP_RULES, findOpenItems,
    // email
    buildEml, orderTableHtml, fillTemplate, poGroups, TABLE_COLUMNS, b64,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
  global.AMI = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
