/* Template ingestion: Outlook .msg/.oft, .eml, .docx, .html and .txt into
 * { subject, html, to, cc } — no network, no dependencies.
 *
 * Extends the global `AMI` namespace defined by engine.js.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});
  const DEC = new TextDecoder('utf-8');
  const UTF16 = new TextDecoder('utf-16le');
  const LATIN1 = new TextDecoder('latin1');

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function textToHtml(text) {
    return String(text)
      .split(/\r?\n\s*\r?\n/)
      .map((p) => '<p>' + escapeHtml(p.trim()).replace(/\r?\n/g, '<br>') + '</p>')
      .filter((p) => p !== '<p></p>')
      .join('\n');
  }

  /** Keep only the body of a full HTML document, so templates nest cleanly. */
  function innerBody(html) {
    const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    let out = m ? m[1] : html;
    out = out.replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<\/?html\b[^>]*>/gi, '')
      .replace(/<head\b[\s\S]*?<\/head>/gi, '')
      .replace(/<meta\b[^>]*>/gi, '')
      .replace(/<o:p\b[^>]*>[\s\S]*?<\/o:p>/gi, '')
      .replace(/<\/?o:p\b[^>]*>/gi, '');
    return out.trim();
  }

  /* ------------------------------------------------------------------ *
   * Compound File Binary (.msg and .oft)
   * ------------------------------------------------------------------ */

  const CFB_SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

  function isCfb(bytes) {
    return CFB_SIGNATURE.every((b, i) => bytes[i] === b);
  }

  /** Parse a CFB container into a map of stream name -> Uint8Array. */
  function readCfb(bytes) {
    const b = new Uint8Array(bytes);
    if (!isCfb(b)) throw new Error('Not an Outlook message file.');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    const sectorSize = 1 << dv.getUint16(30, true);
    const miniSize = 1 << dv.getUint16(32, true);
    const dirFirst = dv.getUint32(48, true);
    const miniCutoff = dv.getUint32(56, true);
    const miniFirst = dv.getUint32(60, true);
    const difatFirst = dv.getUint32(68, true);
    const difatCount = dv.getUint32(72, true);

    const sector = (n) => {
      const off = (n + 1) * sectorSize;
      return b.subarray(off, off + sectorSize);
    };

    const difat = [];
    for (let i = 0; i < 109; i++) difat.push(dv.getUint32(76 + i * 4, true));
    let next = difatFirst;
    for (let i = 0; i < difatCount && next < 0xFFFFFFF0; i++) {
      const s = sector(next);
      const sdv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      const perSector = sectorSize / 4 - 1;
      for (let k = 0; k < perSector; k++) difat.push(sdv.getUint32(k * 4, true));
      next = sdv.getUint32(sectorSize - 4, true);
    }

    const fat = [];
    for (const fs of difat) {
      if (fs >= 0xFFFFFFF0) continue;
      const s = sector(fs);
      const sdv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      for (let k = 0; k < sectorSize / 4; k++) fat.push(sdv.getUint32(k * 4, true));
    }

    const chainBytes = (start, limit) => {
      const parts = [];
      let c = start;
      let guard = 0;
      while (c < 0xFFFFFFF0 && guard++ < 1e6) {
        parts.push(sector(c));
        c = fat[c];
        if (c == null) break;
      }
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return limit != null ? out.subarray(0, limit) : out;
    };

    const dirBytes = chainBytes(dirFirst);
    const entries = [];
    for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
      const e = dirBytes.subarray(off, off + 128);
      const edv = new DataView(e.buffer, e.byteOffset, e.byteLength);
      const nameLen = edv.getUint16(64, true);
      if (nameLen < 2) continue;
      const name = UTF16.decode(e.subarray(0, nameLen - 2));
      entries.push({
        name,
        type: e[66],
        start: edv.getUint32(116, true),
        size: Number(edv.getBigUint64(120, true)),
      });
    }

    const root = entries.find((e) => e.type === 5);
    const miniStream = root ? chainBytes(root.start) : new Uint8Array(0);
    const miniFatRaw = miniFirst < 0xFFFFFFF0 ? chainBytes(miniFirst) : new Uint8Array(0);
    const miniFat = [];
    {
      const mdv = new DataView(miniFatRaw.buffer, miniFatRaw.byteOffset, miniFatRaw.byteLength);
      for (let k = 0; k + 4 <= miniFatRaw.length; k += 4) miniFat.push(mdv.getUint32(k, true));
    }

    const readMini = (start, size) => {
      const parts = [];
      let c = start;
      let guard = 0;
      while (c < 0xFFFFFFF0 && guard++ < 1e6) {
        parts.push(miniStream.subarray(c * miniSize, (c + 1) * miniSize));
        c = miniFat[c];
        if (c == null) break;
      }
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out.subarray(0, size);
    };

    const streams = new Map();
    for (const e of entries) {
      if (e.type !== 2) continue;
      streams.set(e.name, e.size < miniCutoff ? readMini(e.start, e.size) : chainBytes(e.start, e.size));
    }
    return streams;
  }

  /* ------------------------------------------------------------------ *
   * Compressed RTF (MS-OXRTFCPR) and HTML de-encapsulation (MS-OXRTFEX)
   * ------------------------------------------------------------------ */

  const RTF_DICT_INIT = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}'
    + '{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbol'
    + 'ArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n'
    + '\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

  function decompressRtf(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 16) return null;
    const rawSize = dv.getUint32(4, true);
    const compType = dv.getUint32(8, true);

    if (compType === 0x414C454D) return LATIN1.decode(bytes.subarray(16, 16 + rawSize)); // 'MELA', stored
    if (compType !== 0x75465A4C) return null;                                            // not 'LZFu'

    const dict = new Uint8Array(4096);
    for (let i = 0; i < RTF_DICT_INIT.length; i++) dict[i] = RTF_DICT_INIT.charCodeAt(i) & 0xFF;
    let writeAt = RTF_DICT_INIT.length;

    const out = [];
    let pos = 16;
    outer:
    while (pos < bytes.length && out.length < rawSize) {
      const control = bytes[pos++];
      for (let bit = 0; bit < 8; bit++) {
        if (pos >= bytes.length) break outer;
        if (control & (1 << bit)) {
          const b1 = bytes[pos++];
          const b2 = bytes[pos++];
          if (b2 === undefined) break outer;
          const offset = (b1 << 4) | (b2 >> 4);
          const length = (b2 & 0x0F) + 2;
          if (offset === writeAt % 4096) break outer;   // end-of-stream marker
          for (let k = 0; k < length; k++) {
            const byte = dict[(offset + k) % 4096];
            out.push(byte);
            dict[writeAt % 4096] = byte;
            writeAt++;
          }
        } else {
          const byte = bytes[pos++];
          out.push(byte);
          dict[writeAt % 4096] = byte;
          writeAt++;
        }
      }
    }
    return LATIN1.decode(Uint8Array.from(out));
  }

  /**
   * Recover the original HTML from HTML-encapsulated RTF.
   * Markup lives inside `\*\htmltag` groups; `\htmlrtf` regions are RTF-only
   * decoration and must be dropped; everything else is body text.
   */
  function deEncapsulateHtml(rtf) {
    if (!/\\fromhtml1/i.test(rtf)) return null;
    let out = '';
    let i = 0;
    let htmlrtf = 0;              // suppression depth flag
    const stack = [];             // { htmltag: bool }
    let inHtmlTag = false;

    const emit = (s) => { if (!htmlrtf || inHtmlTag) out += s; };

    while (i < rtf.length) {
      const ch = rtf[i];

      if (ch === '{') {
        stack.push({ inHtmlTag, htmlrtf });
        i++;
        // Detect `{\*\htmltag<n> ...}` and `{\*\<other>}` destinations.
        const ahead = rtf.slice(i, i + 24);
        const tag = /^\\\*\\htmltag(\d+)\s?/.exec(ahead);
        if (tag) { inHtmlTag = true; i += tag[0].length; continue; }
        // `\listtext` and `\pntext` hold the RTF-only bullet glyph and its tab,
        // which the HTML list markup already provides.
        const other = /^\\\*\\[a-zA-Z]+/.exec(ahead) || /^\\(?:listtext|pntext)\b/.exec(ahead);
        if (other) {
          // Skip the whole ignorable destination.
          let depth = 1;
          while (i < rtf.length && depth > 0) {
            if (rtf[i] === '{') depth++;
            else if (rtf[i] === '}') depth--;
            else if (rtf[i] === '\\') i++;
            i++;
          }
          const prev = stack.pop();
          if (prev) { inHtmlTag = prev.inHtmlTag; htmlrtf = prev.htmlrtf; }
          continue;
        }
        continue;
      }

      if (ch === '}') {
        const prev = stack.pop();
        if (prev) { inHtmlTag = prev.inHtmlTag; htmlrtf = prev.htmlrtf; }
        i++;
        continue;
      }

      if (ch === '\\') {
        const rest = rtf.slice(i);
        let m = /^\\'([0-9a-fA-F]{2})/.exec(rest);
        if (m) { emit(String.fromCharCode(parseInt(m[1], 16))); i += 4; continue; }
        m = /^\\u(-?\d+)\s?\??/.exec(rest);
        if (m) {
          let code = parseInt(m[1], 10);
          if (code < 0) code += 65536;
          emit(String.fromCharCode(code));
          i += m[0].length;
          continue;
        }
        m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rest);
        if (m) {
          const word = m[1];
          const param = m[2];
          if (word === 'htmlrtf') htmlrtf = param === '0' ? 0 : 1;
          else if (word === 'par' || word === 'line') emit('\n');
          else if (word === 'tab') emit('\t');
          else if (word === 'lquote') emit('‘');
          else if (word === 'rquote') emit('’');
          else if (word === 'ldblquote') emit('“');
          else if (word === 'rdblquote') emit('”');
          else if (word === 'endash') emit('–');
          else if (word === 'emdash') emit('—');
          i += m[0].length;
          continue;
        }
        m = /^\\([^a-zA-Z])/.exec(rest);
        if (m) { emit(m[1]); i += 2; continue; }
        i++;
        continue;
      }

      if (ch === '\r' || ch === '\n') { i++; continue; }
      emit(ch);
      i++;
    }
    return out.trim();
  }

  /** Strip RTF control words down to readable text, as a last resort. */
  function rtfToText(rtf) {
    return rtf
      .replace(/\{\\\*[\s\S]*?\}/g, ' ')
      .replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\par\b/g, '\n')
      .replace(/\\tab\b/g, '\t')
      .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
      .replace(/[{}]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ------------------------------------------------------------------ *
   * Outlook message parsing
   * ------------------------------------------------------------------ */

  const PROP = {
    subject: ['__substg1.0_0037001F', '__substg1.0_0037001E'],
    bodyText: ['__substg1.0_1000001F', '__substg1.0_1000001E'],
    bodyHtml: ['__substg1.0_10130102'],
    rtfCompressed: ['__substg1.0_10090102'],
    displayTo: ['__substg1.0_0E04001F', '__substg1.0_0E04001E'],
    displayCc: ['__substg1.0_0E03001F', '__substg1.0_0E03001E'],
  };

  function readProp(streams, names, unicode) {
    for (const n of names) {
      const s = streams.get(n);
      if (!s || !s.length) continue;
      if (n.endsWith('001F')) return UTF16.decode(s);
      if (n.endsWith('001E')) return LATIN1.decode(s);
      return s;
    }
    return null;
  }

  function parseOutlookMessage(bytes) {
    const streams = readCfb(bytes);
    const subject = (readProp(streams, PROP.subject) || '').trim();
    const to = (readProp(streams, PROP.displayTo) || '').trim();
    const cc = (readProp(streams, PROP.displayCc) || '').trim();

    let html = null;
    let bodySource = '';

    const rawHtml = streams.get(PROP.bodyHtml[0]);
    if (rawHtml && rawHtml.length > 64) {
      const text = DEC.decode(rawHtml);
      if (/<\s*(html|body|div|p|table|span)\b/i.test(text)) { html = innerBody(text); bodySource = 'HTML body'; }
    }

    if (!html) {
      const rtfRaw = streams.get(PROP.rtfCompressed[0]);
      if (rtfRaw && rtfRaw.length > 16) {
        const rtf = decompressRtf(rtfRaw);
        if (rtf) {
          const encapsulated = deEncapsulateHtml(rtf);
          if (encapsulated && /<\s*(html|body|div|p|table|span)\b/i.test(encapsulated)) {
            html = innerBody(encapsulated);
            bodySource = 'HTML recovered from RTF';
          } else if (encapsulated) {
            html = textToHtml(encapsulated);
            bodySource = 'text recovered from RTF';
          } else {
            html = textToHtml(rtfToText(rtf));
            bodySource = 'plain text from RTF';
          }
        }
      }
    }

    if (!html) {
      const text = readProp(streams, PROP.bodyText);
      if (text) { html = textToHtml(text); bodySource = 'plain text body'; }
    }

    if (!html) throw new Error('This Outlook file has no readable message body.');
    return { subject, html, to, cc, bodySource };
  }

  /* ------------------------------------------------------------------ *
   * .eml
   * ------------------------------------------------------------------ */

  function decodeQuotedPrintable(s) {
    return s.replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function decodeBase64Text(s) {
    const clean = s.replace(/\s+/g, '');
    const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('latin1');
    const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return DEC.decode(arr);
  }

  function decodeRfc2047(value) {
    return String(value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
      try {
        if (enc.toUpperCase() === 'B') return decodeBase64Text(data);
        return decodeQuotedPrintable(data.replace(/_/g, ' '));
      } catch (e) { return m; }
    });
  }

  function parseEml(bytes) {
    const raw = LATIN1.decode(bytes);
    const splitAt = raw.search(/\r?\n\r?\n/);
    const headerBlock = splitAt < 0 ? raw : raw.slice(0, splitAt);
    const body = splitAt < 0 ? '' : raw.slice(splitAt).replace(/^\r?\n\r?\n/, '');

    const headers = {};
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
    for (const line of unfolded.split(/\r?\n/)) {
      const m = /^([A-Za-z-]+):\s*([\s\S]*)$/.exec(line);
      if (m) headers[m[1].toLowerCase()] = m[2].trim();
    }

    const contentType = headers['content-type'] || 'text/plain';
    const boundary = (/boundary="?([^";]+)"?/i.exec(contentType) || [])[1];

    const decodePart = (partHeaders, partBody) => {
      const enc = (partHeaders['content-transfer-encoding'] || '').toLowerCase();
      if (enc === 'base64') return decodeBase64Text(partBody);
      if (enc === 'quoted-printable') return decodeQuotedPrintable(partBody);
      return partBody;
    };

    let html = null;
    let text = null;

    if (boundary) {
      const parts = body.split(new RegExp('--' + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      for (const part of parts) {
        const at = part.search(/\r?\n\r?\n/);
        if (at < 0) continue;
        const ph = {};
        for (const line of part.slice(0, at).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
          const m = /^([A-Za-z-]+):\s*([\s\S]*)$/.exec(line.trim());
          if (m) ph[m[1].toLowerCase()] = m[2].trim();
        }
        const ct = ph['content-type'] || '';
        const content = decodePart(ph, part.slice(at).replace(/^\r?\n\r?\n/, ''));
        if (/text\/html/i.test(ct) && !html) html = content;
        else if (/text\/plain/i.test(ct) && !text) text = content;
      }
    } else if (/text\/html/i.test(contentType)) {
      html = decodePart(headers, body);
    } else {
      text = decodePart(headers, body);
    }

    const finalHtml = html ? innerBody(html) : textToHtml(text || '');
    if (!finalHtml) throw new Error('This .eml has no readable body.');
    return {
      subject: decodeRfc2047(headers.subject || ''),
      html: finalHtml,
      to: decodeRfc2047(headers.to || ''),
      cc: decodeRfc2047(headers.cc || ''),
      bodySource: html ? 'HTML part' : 'plain text part',
    };
  }

  /* ------------------------------------------------------------------ *
   * .docx
   * ------------------------------------------------------------------ */

  async function parseDocx(bytes) {
    const entries = await AMI.unzip(bytes);
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('This .docx has no document body.');
    const xml = DEC.decode(doc.bytes);

    const textOf = (runXml) => {
      let out = '';
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
      let m;
      while ((m = re.exec(runXml)) !== null) {
        if (m[1] != null) out += AMI.unescapeXml(m[1]);
        else if (/w:tab/.test(m[0])) out += ' ';
        else out += '\n';
      }
      return out;
    };

    const renderRuns = (paraXml) => {
      let out = '';
      const runRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
      let m;
      while ((m = runRe.exec(paraXml)) !== null) {
        const body = m[1];
        let t = escapeHtml(textOf(body)).replace(/\n/g, '<br>');
        if (!t) continue;
        if (/<w:b\b[^>]*\/>|<w:b>/.test(body)) t = '<strong>' + t + '</strong>';
        if (/<w:i\b[^>]*\/>|<w:i>/.test(body)) t = '<em>' + t + '</em>';
        if (/<w:u\b[^>]*w:val="(?!none)/.test(body)) t = '<u>' + t + '</u>';
        out += t;
      }
      return out;
    };

    const renderParagraph = (paraXml) => {
      const content = renderRuns(paraXml);
      if (!content.trim()) return '';
      const style = (/<w:pStyle[^>]*w:val="([^"]*)"/.exec(paraXml) || [])[1] || '';
      if (/^Heading([1-6])$/i.test(style)) {
        const lvl = /^Heading([1-6])$/i.exec(style)[1];
        return '<h' + lvl + '>' + content + '</h' + lvl + '>';
      }
      const isList = /<w:numPr>/.test(paraXml);
      return isList ? '<li>' + content + '</li>' : '<p>' + content + '</p>';
    };

    const bodyXml = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [, xml])[1];
    const blocks = [];
    const blockRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>|<w:tbl>[\s\S]*?<\/w:tbl>/g;
    let m;
    while ((m = blockRe.exec(bodyXml)) !== null) {
      const chunk = m[0];
      if (chunk.startsWith('<w:tbl')) {
        const rows = [];
        const rowRe = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
        let r;
        while ((r = rowRe.exec(chunk)) !== null) {
          const cells = [];
          const cellRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
          let c;
          while ((c = cellRe.exec(r[0])) !== null) {
            const inner = [];
            const pRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
            let p;
            while ((p = pRe.exec(c[1])) !== null) inner.push(renderRuns(p[0]));
            cells.push('<td style="border:1px solid #999;padding:4px 8px;">'
              + (inner.join('<br>') || '&nbsp;') + '</td>');
          }
          if (cells.length) rows.push('<tr>' + cells.join('') + '</tr>');
        }
        if (rows.length) blocks.push('<table style="border-collapse:collapse;margin:12px 0;">' + rows.join('') + '</table>');
      } else {
        const rendered = renderParagraph(chunk);
        if (rendered) blocks.push(rendered);
      }
    }

    // Wrap consecutive list items so bullets render.
    const html = blocks.join('\n')
      .replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (run) => '<ul>\n' + run.trim() + '\n</ul>');
    if (!html.trim()) throw new Error('This .docx appears to be empty.');

    // A leading "Subject:" line is a common convention in Word templates.
    let subject = '';
    let body = html;
    const subjMatch = /^<p>\s*Subject:\s*([\s\S]*?)<\/p>\s*/i.exec(html);
    if (subjMatch) {
      subject = subjMatch[1].replace(/<[^>]+>/g, '').trim();
      body = html.slice(subjMatch[0].length);
    }
    return { subject, html: body, to: '', cc: '', bodySource: 'Word document' };
  }

  /* ------------------------------------------------------------------ *
   * Dispatch
   * ------------------------------------------------------------------ */

  /**
   * Read a template file of any supported type.
   * Returns { subject, html, to, cc, bodySource, format }.
   */
  async function parseTemplateFile(bytes, fileName) {
    const b = new Uint8Array(bytes);
    const name = String(fileName || '');
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();

    if (isCfb(b)) {
      const parsed = parseOutlookMessage(b);
      return Object.assign(parsed, { format: ext === 'oft' ? 'Outlook template (.oft)' : 'Outlook message (.msg)' });
    }
    if (ext === 'docx' || (b[0] === 0x50 && b[1] === 0x4B && /\.docx$/i.test(name))) {
      const parsed = await parseDocx(b);
      return Object.assign(parsed, { format: 'Word (.docx)' });
    }
    if (ext === 'eml' || ext === 'mht' || ext === 'mhtml') {
      return Object.assign(parseEml(b), { format: 'Email (.eml)' });
    }
    if (ext === 'html' || ext === 'htm') {
      const text = DEC.decode(b);
      const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [, ''])[1].trim();
      return { subject: title, html: innerBody(text), to: '', cc: '', bodySource: 'HTML file', format: 'HTML' };
    }
    if (ext === 'txt' || ext === 'text') {
      const text = DEC.decode(b);
      const first = text.split(/\r?\n/)[0] || '';
      const hasSubject = /^Subject:\s*/i.test(first);
      return {
        subject: hasSubject ? first.replace(/^Subject:\s*/i, '').trim() : '',
        html: textToHtml(hasSubject ? text.split(/\r?\n/).slice(1).join('\n') : text),
        to: '', cc: '', bodySource: 'plain text', format: 'Text',
      };
    }
    throw new Error('Unsupported template format "' + (ext || 'unknown')
      + '". Save it as .msg, .oft, .eml, .docx, .html or .txt.');
  }

  /* ------------------------------------------------------------------ *
   * Internal notes
   * ------------------------------------------------------------------ */

  /* A note to whoever files the template — "Use: Aeromexico" — not part of the
   * message. It sits at the end, and everything after it is the same kind of
   * annotation. */
  const USE_NOTE = /(?:^|\n)\s*(?:<[^>]*>\s*)*use\s*[:\-–]/i;

  /**
   * Strip the trailing internal note from an imported template.
   *
   * Only the imported copy is changed; the file on disk is never written to, so
   * the original .msg or .docx keeps its note. What was removed is returned, so
   * the interface can show it and put it back if the guess was wrong.
   */
  function stripInternalNote(html) {
    const text = String(html || '');

    // Work on the text with tags flattened, so a note wrapped in <p> or <span>
    // is found at the same place as a bare one.
    const plain = text.replace(/<[^>]*>/g, '\n');
    const at = plain.search(USE_NOTE);
    if (at < 0) return { html: text, removed: '', found: false };

    // Map the position in the flattened text back to the source by counting the
    // visible characters, since flattening only ever replaces tags with "\n".
    let seen = 0;
    let cut = -1;
    let inTag = false;
    let tagStart = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '<') { inTag = true; tagStart = i; continue; }
      if (inTag) {
        if (ch === '>') { inTag = false; seen++; if (seen > at && cut < 0) cut = tagStart; }
        continue;
      }
      if (seen >= at && cut < 0) cut = i;
      seen++;
    }
    if (cut < 0) return { html: text, removed: '', found: false };

    const removed = text.slice(cut).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!removed) return { html: text, removed: '', found: false };

    // Close anything the cut left open, so the kept part is still valid markup.
    const kept = text.slice(0, cut);
    return { html: balanceTags(kept).trim(), removed, found: true };
  }

  const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base']);

  /** Close any tags left open by a cut, innermost first. */
  function balanceTags(html) {
    const open = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[2].toLowerCase();
      if (VOID_TAGS.has(name) || m[3] === '/') continue;
      if (m[1]) {
        const at = open.lastIndexOf(name);
        if (at >= 0) open.splice(at, 1);
      } else {
        open.push(name);
      }
    }
    return html + open.reverse().map((t) => '</' + t + '>').join('');
  }

  /* ------------------------------------------------------------------ *
   * Placeholder discovery
   * ------------------------------------------------------------------ */

  /** List the {{placeholders}} a template uses, in order of first appearance. */
  function templatePlaceholders(html) {
    const out = [];
    const re = /\{\{(\w+)\}\}/g;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) if (!out.includes(m[1])) out.push(m[1]);
    return out;
  }

  /**
   * Suggest placeholder substitutions for literal values that appear in an
   * uploaded template. Nothing is applied automatically — the user confirms each.
   */
  function suggestPlaceholders(html, values) {
    const suggestions = [];
    for (const key of Object.keys(values || {})) {
      const literal = values[key];
      if (!literal || String(literal).length < 3) continue;
      const needle = String(literal);
      if (String(html).includes(needle)) {
        suggestions.push({ key, literal: needle, placeholder: '{{' + key + '}}' });
      }
    }
    return suggestions;
  }

  function applyPlaceholderSuggestions(html, suggestions) {
    let out = String(html);
    for (const s of suggestions) out = out.split(s.literal).join(s.placeholder);
    return out;
  }

  Object.assign(AMI, {
    parseTemplateFile, parseOutlookMessage, parseEml, parseDocx,
    readCfb, isCfb, decompressRtf, deEncapsulateHtml, rtfToText,
    textToHtml, innerBody, decodeRfc2047,
    templatePlaceholders, suggestPlaceholders, applyPlaceholderSuggestions,
    stripInternalNote, balanceTags,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
