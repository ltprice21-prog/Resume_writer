/* Order status model: the five pipeline stages, where a status is stored,
 * what the tracker itself already implies, and the roll-ups the dashboard needs.
 *
 * A status is either SET by a person or DERIVED from dated columns already in the
 * tracker. Nothing is invented: an order with neither reads "not set".
 *
 * Extends the global `AMI` namespace.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});
  const DEC = new TextDecoder('utf-8');
  const ENC = new TextEncoder();

  const STATUS_PATH = 'order-status.json';

  /**
   * The pipeline, in order. `step` drives the ordinal colour ramp and the
   * kanban column order; `open` marks the stages that still need work.
   */
  const ORDER_STATUSES = [
    {
      id: 'placed', step: 1, open: true,
      label: 'Order placed – awaiting shipment', short: 'Awaiting shipment',
      hint: 'Sent to the winery; nothing has been collected yet.',
    },
    {
      id: 'transit', step: 2, open: true,
      label: 'In transit', short: 'In transit',
      hint: 'Collected from the cellars, not yet delivered.',
    },
    {
      id: 'delivered', step: 3, open: true,
      label: 'Delivered', short: 'Delivered',
      hint: 'Arrived at the delivery point; paperwork may still be open.',
    },
    {
      id: 'invoiced', step: 4, open: true,
      label: 'Invoiced', short: 'Invoiced',
      hint: 'Billed out. Still open until it is reconciled and closed.',
    },
    {
      id: 'closed', step: 5, open: false,
      label: 'Closed', short: 'Closed',
      hint: 'Received, invoiced and reconciled — the end of the line. '
        + 'Not derivable from the tracker, so it only ever comes from a person.',
    },
  ];

  const statusById = (id) => ORDER_STATUSES.find((s) => s.id === id) || null;
  const isOpenStatus = (id) => { const s = statusById(id); return !s || s.open; };

  /* ------------------------------------------------------------------ *
   * Store
   * ------------------------------------------------------------------ */

  const statusKey = (accountId, itemId, po) => accountId + '/' + itemId + '/' + String(po).trim();

  function emptyStatusDoc() {
    return { version: 1, updated: new Date().toISOString(), entries: {} };
  }

  async function loadStatuses(store) {
    const bytes = await store.read(STATUS_PATH);
    if (!bytes) return emptyStatusDoc();
    try {
      const parsed = JSON.parse(DEC.decode(bytes));
      return { version: 1, updated: parsed.updated || '', entries: parsed.entries || {} };
    } catch (e) {
      throw new Error('order-status.json could not be read: ' + e.message);
    }
  }

  /**
   * Merge two status documents entry by entry, newest wins.
   * Statuses change often and independently, so a whole-file conflict would be
   * the wrong unit — two people updating different orders must both survive.
   */
  function mergeStatusDocs(mine, theirs) {
    const out = { version: 1, updated: new Date().toISOString(), entries: {} };
    const keys = new Set([...Object.keys(mine.entries || {}), ...Object.keys(theirs.entries || {})]);
    for (const k of keys) {
      const a = (mine.entries || {})[k];
      const b = (theirs.entries || {})[k];
      if (!a) { out.entries[k] = b; continue; }
      if (!b) { out.entries[k] = a; continue; }
      out.entries[k] = (String(b.updated || '') > String(a.updated || '')) ? b : a;
    }
    return out;
  }

  async function saveStatuses(store, doc, opts) {
    const options = opts || {};
    let merged = doc;
    const existing = await store.read(STATUS_PATH);
    if (existing) {
      try {
        const onDisk = JSON.parse(DEC.decode(existing));
        merged = mergeStatusDocs(doc, { entries: onDisk.entries || {} });
      } catch (e) { /* unreadable on disk: our copy wins */ }
    }
    merged.updated = new Date().toISOString();
    merged.updatedBy = options.by || '';
    await store.write(STATUS_PATH, ENC.encode(JSON.stringify(merged, null, 2)));
    return merged;
  }

  function setStatus(doc, key, statusId, by, note) {
    if (!statusById(statusId)) throw new Error('Unknown status "' + statusId + '".');
    doc.entries[key] = {
      status: statusId,
      updated: new Date().toISOString(),
      updatedBy: by || '',
      note: note || '',
    };
    return doc;
  }

  function clearStatus(doc, key) {
    delete doc.entries[key];
    return doc;
  }

  /* ------------------------------------------------------------------ *
   * Reading orders out of a tracker
   * ------------------------------------------------------------------ */

  /* Tracker columns the status model reads, most advanced stage first. */
  const STAGE_COLUMNS = [
    { statusId: 'invoiced', re: /^NAV INV/i, reason: 'a NAV invoice number is recorded' },
    { statusId: 'delivered', re: /^(Delivery date to CDG|Actual delivery date)/i, reason: 'a delivery date is recorded' },
    { statusId: 'transit', re: /^Actual Collection Date/i, reason: 'a collection date is recorded' },
    { statusId: 'placed', re: /^PO date sent to winery/i, reason: 'the PO has been sent to the winery' },
  ];

  const DATE_COLUMNS = [
    { key: 'poReceived', re: /^PO Received Date/i, label: 'PO received' },
    { key: 'poSent', re: /^PO date sent to winery/i, label: 'PO sent to winery' },
    { key: 'requestedCollection', re: /^AMI Requested\s+Collection Date/i, label: 'requested collection' },
    { key: 'wineryConfirmed', re: /^Winery Confirmed Available Date/i, label: 'winery confirmed' },
    { key: 'actualCollection', re: /^Actual Collection Date/i, label: 'collected' },
    { key: 'delivered', re: /^(Delivery date to CDG|Actual delivery date)/i, label: 'delivered' },
    { key: 'requiredDelivery', re: /^Customer Required Delivery Date/i, label: 'customer required delivery' },
  ];

  const VALUE_COLUMNS = [
    { key: 'bottles', re: /^Quantity \(bt\)/i },
    { key: 'cases', re: /^Quantity \(cs\)/i },
    { key: 'pallets', re: /^Quantity \(pallets\)/i },
    { key: 'lot', re: /^Lot Number/i },
    { key: 'navInvoice', re: /^NAV INV/i },
    { key: 'balanceBt', re: /^Balance on Contract\s*\(bt\)/i },
    { key: 'notes', re: /^Notes/i },
  ];

  /* A date outside this window is a typo in the tracker, not history. */
  const MIN_PLAUSIBLE = new Date(2000, 0, 1);
  function plausibleWindow(today) {
    const t = today || new Date();
    return { min: MIN_PLAUSIBLE, max: new Date(t.getFullYear() + 3, t.getMonth(), t.getDate()) };
  }

  const colFor = (header, re) => {
    const c = header.columns.find((x) => re.test(x.header));
    return c ? c.col : null;
  };

  /** What the tracker's own dated columns already say about an order. */
  function deriveStatus(sheet, header, row) {
    for (const stage of STAGE_COLUMNS) {
      const col = colFor(header, stage.re);
      if (!col) continue;
      const cell = sheet.cell(row, col);
      if (!cell) continue;
      const text = String(cell.text || '').trim();
      if (!text || /^to fill$/i.test(text)) continue;
      return { statusId: stage.statusId, reason: stage.reason };
    }
    return null;
  }

  /** Every order on one item's tracker, with the values the dashboard needs. */
  function readOrders(sheet, header, context) {
    const ctx = context || {};
    const poCol = colFor(header, /^PO\s*#/i);
    if (!poCol) return [];

    const dateCols = DATE_COLUMNS.map((d) => ({ ...d, col: colFor(header, d.re) })).filter((d) => d.col);
    const valueCols = VALUE_COLUMNS.map((v) => ({ ...v, col: colFor(header, v.re) })).filter((v) => v.col);

    const win = plausibleWindow(ctx.today);
    const out = [];
    for (const row of AMI.dataRows(sheet, header)) {
      const po = String(sheet.cellText(row, poCol) || '').trim();
      if (!po) continue;

      const dates = {};
      const dateIssues = [];
      let lastEvent = null;
      let lastEventLabel = '';
      for (const d of dateCols) {
        const cell = sheet.cell(row, d.col);
        if (!cell || cell.num == null || !Number.isFinite(cell.num) || cell.num < 1) continue;
        const date = AMI.serialToDate(cell.num);
        // A mistyped serial would otherwise dominate every ranking it touches.
        if (date < win.min || date > win.max) {
          dateIssues.push({ key: d.key, label: d.label, date, serial: cell.num });
          continue;
        }
        dates[d.key] = date;
        // The most recent thing that actually happened, ignoring planned dates.
        if (d.key === 'requiredDelivery' || d.key === 'requestedCollection') continue;
        if (!lastEvent || date > lastEvent) { lastEvent = date; lastEventLabel = d.label; }
      }

      const values = {};
      for (const v of valueCols) {
        const cell = sheet.cell(row, v.col);
        if (!cell) continue;
        values[v.key] = cell.num != null && Number.isFinite(cell.num) ? cell.num : String(cell.text || '').trim();
      }

      out.push({
        key: statusKey(ctx.accountId || '', ctx.itemId || '', po),
        po, row,
        accountId: ctx.accountId || '', accountName: ctx.accountName || '',
        divisionId: ctx.divisionId || '',
        itemId: ctx.itemId || '', itemName: ctx.itemName || '',
        dates, values, dateIssues,
        lastEvent, lastEventLabel,
        derived: deriveStatus(sheet, header, row),
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Effective status
   * ------------------------------------------------------------------ */

  /**
   * What an order's status is right now.
   * A person's selection always beats the tracker's implication, and the source
   * is reported so the interface can show which of the two it is.
   */
  function effectiveStatus(order, statusDoc, options) {
    const opts = options || {};
    const entry = statusDoc && statusDoc.entries ? statusDoc.entries[order.key] : null;
    if (entry && statusById(entry.status)) {
      return {
        statusId: entry.status, source: 'set',
        updated: entry.updated || '', updatedBy: entry.updatedBy || '', note: entry.note || '',
        reason: 'set by ' + (entry.updatedBy || 'someone') + (entry.updated ? ' on ' + entry.updated.slice(0, 10) : ''),
      };
    }
    if (order.derived) {
      // A workspace rule may carry an invoiced order straight to closed. It only
      // ever applies to a stage the tracker implied — an explicit choice stands.
      if (opts.autoCloseInvoiced && order.derived.statusId === 'invoiced') {
        return {
          statusId: 'closed', source: 'auto',
          updated: '', updatedBy: '', note: '',
          reason: 'From the tracker: ' + order.derived.reason
            + '. Closed automatically, because this workspace treats invoiced orders as closed.',
        };
      }
      return {
        statusId: order.derived.statusId, source: 'derived',
        updated: '', updatedBy: '', note: '',
        reason: 'From the tracker: ' + order.derived.reason + '.',
      };
    }
    return { statusId: '', source: 'none', updated: '', updatedBy: '', note: '', reason: 'nothing in the tracker indicates a stage' };
  }

  function daysSince(date, today) {
    if (!date) return null;
    return AMI.daysBetween(date, today || new Date());
  }

  /* ------------------------------------------------------------------ *
   * Roll-ups
   * ------------------------------------------------------------------ */

  function emptyCounts() {
    const c = {};
    for (const s of ORDER_STATUSES) c[s.id] = 0;
    c.unset = 0;
    return c;
  }

  /** Attach the effective status and aging to each order. */
  function decorate(orders, statusDoc, today, options) {
    const now = today || new Date();
    return orders.map((o) => {
      const status = effectiveStatus(o, statusDoc, options);
      return Object.assign({}, o, {
        status,
        isOpen: status.statusId ? isOpenStatus(status.statusId) : true,
        ageDays: daysSince(o.lastEvent, now),
      });
    });
  }

  function countByStatus(orders) {
    const counts = emptyCounts();
    for (const o of orders) {
      if (!o.status.statusId) counts.unset++;
      else counts[o.status.statusId]++;
    }
    return counts;
  }

  /* Thresholds are stated in the interface, so "attention" is never a black box. */
  const HEALTH_THRESHOLDS = { warningDays: 21, criticalDays: 45, warningFollowUps: 1, criticalFollowUps: 5 };

  /**
   * A per-account roll-up. `health` is a plain reading of two explicit signals —
   * how long an open order has sat without a dated event, and how many follow-up
   * items are outstanding — never a score.
   */
  function summariseAccount(account, divisionName, orders, followUpCount, thresholds) {
    const t = Object.assign({}, HEALTH_THRESHOLDS, thresholds || {});
    const open = orders.filter((o) => o.isOpen);
    const counts = countByStatus(orders);
    const stalest = open.reduce((worst, o) => (
      o.ageDays != null && (!worst || o.ageDays > worst.ageDays) ? o : worst), null);

    const reasons = [];
    let level = 'good';
    const stalestDays = stalest && stalest.ageDays != null ? stalest.ageDays : 0;
    if (stalestDays >= t.criticalDays) {
      level = 'critical';
      reasons.push('PO ' + stalest.po + ' has had no dated activity for ' + stalestDays + ' days');
    } else if (stalestDays >= t.warningDays) {
      level = 'warning';
      reasons.push('PO ' + stalest.po + ' has had no dated activity for ' + stalestDays + ' days');
    }
    if ((followUpCount || 0) >= t.criticalFollowUps) {
      level = 'critical';
      reasons.push(followUpCount + ' outstanding follow-up items');
    } else if ((followUpCount || 0) >= t.warningFollowUps && level === 'good') {
      level = 'warning';
      reasons.push(followUpCount + ' outstanding follow-up item(s)');
    }
    const unset = counts.unset;
    if (unset && level === 'good') reasons.push(unset + ' order(s) with no status yet');

    return {
      accountId: account.id, accountName: account.name, divisionId: account.divisionId,
      divisionName: divisionName || '',
      total: orders.length, open: open.length, counts,
      followUps: followUpCount || 0,
      stalest, stalestDays,
      health: { level, reasons },
      thresholds: t,
    };
  }

  /* ------------------------------------------------------------------ *
   * Account summary document
   * ------------------------------------------------------------------ */

  const esc = (s) => AMI.escapeXml(s == null ? '' : String(s));

  const TD = 'border:1px solid #d8d8d8;padding:5px 9px;font-family:Calibri,Arial,sans-serif;font-size:10.5pt;';
  const TH = TD + 'background:#f3f3f3;text-align:left;font-weight:600;';

  /**
   * A plain-HTML summary of an account's open orders and where each stands.
   * Every column is read from the tracker or from the stored status; there is no
   * narrative text beyond the headings.
   */
  function buildAccountSummary(options) {
    const o = options || {};
    const orders = (o.orders || []).slice();
    const open = orders.filter((x) => x.isOpen);
    const counts = countByStatus(orders);
    const today = o.today || new Date();

    orders.sort((a, b) => (a.itemName || '').localeCompare(b.itemName || '') || a.po.localeCompare(b.po));
    const shown = o.openOnly === false ? orders : open.slice().sort(
      (a, b) => (a.itemName || '').localeCompare(b.itemName || '') || a.po.localeCompare(b.po));

    const countRows = ORDER_STATUSES.map((s) =>
      '<tr><td style="' + TD + '">' + esc(s.label) + '</td>'
      + '<td style="' + TD + 'text-align:right;">' + counts[s.id] + '</td></tr>').join('')
      + (counts.unset ? '<tr><td style="' + TD + '">No status set</td><td style="' + TD
        + 'text-align:right;">' + counts.unset + '</td></tr>' : '');

    const headers = ['PO #', 'Item', 'Cases', 'Status', 'Status source', 'Last dated activity', 'Days'];
    const rows = shown.map((x) => {
      const st = statusById(x.status.statusId);
      return '<tr>'
        + '<td style="' + TD + '">' + esc(x.po) + '</td>'
        + '<td style="' + TD + '">' + esc(x.itemName) + '</td>'
        + '<td style="' + TD + 'text-align:right;">' + esc(x.values.cases != null ? x.values.cases : '') + '</td>'
        + '<td style="' + TD + '">' + esc(st ? st.label : 'Not set') + '</td>'
        + '<td style="' + TD + '">' + esc(x.status.reason) + '</td>'
        + '<td style="' + TD + '">' + esc(x.lastEvent ? AMI.formatShort(x.lastEvent) + ' (' + x.lastEventLabel + ')' : '—') + '</td>'
        + '<td style="' + TD + 'text-align:right;">' + esc(x.ageDays == null ? '—' : x.ageDays) + '</td>'
        + '</tr>';
    }).join('');

    const html = [
      '<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#181818;">',
      '<h2 style="margin:0 0 2px;font-size:15pt;">' + esc(o.accountName) + ' — account summary</h2>',
      '<p style="margin:0 0 14px;color:#5c5c5c;font-size:10pt;">'
      + esc(o.divisionName ? o.divisionName + ' division · ' : '')
      + 'as at ' + esc(AMI.formatEmailDate(today))
      + (o.preparedBy ? ' · prepared by ' + esc(o.preparedBy) : '') + '</p>',
      '<p style="margin:0 0 10px;"><strong>' + open.length + '</strong> open order(s) of <strong>'
      + orders.length + '</strong> on the tracker'
      + (o.itemNames && o.itemNames.length ? ', across ' + esc(o.itemNames.join(', ')) : '') + '.</p>',
      '<h3 style="font-size:11.5pt;margin:16px 0 6px;">Orders by status</h3>',
      '<table style="border-collapse:collapse;"><tbody>' + countRows + '</tbody></table>',
      '<h3 style="font-size:11.5pt;margin:16px 0 6px;">'
      + (o.openOnly === false ? 'All orders' : 'Open orders') + '</h3>',
      shown.length
        ? '<table style="border-collapse:collapse;"><thead><tr>'
          + headers.map((h) => '<th style="' + TH + '">' + esc(h) + '</th>').join('')
          + '</tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p style="margin:0;">Nothing open.</p>',
      '<p style="margin:16px 0 0;color:#5c5c5c;font-size:9.5pt;">'
      + 'Status source shows whether a person set the stage or it was read from the tracker’s dated columns. '
      + 'Days counts from the last dated activity on the row.</p>',
      '</div>',
    ].join('\n');

    return { html, open: open.length, total: orders.length, counts };
  }

  Object.assign(AMI, {
    STATUS_PATH, ORDER_STATUSES, HEALTH_THRESHOLDS,
    statusById, isOpenStatus, statusKey,
    emptyStatusDoc, loadStatuses, saveStatuses, mergeStatusDocs, setStatus, clearStatus,
    deriveStatus, readOrders, effectiveStatus, decorate, countByStatus, emptyCounts, plausibleWindow,
    summariseAccount, buildAccountSummary, daysSince,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
