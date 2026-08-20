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
   * The pipeline, in order. `step` drives the ordinal ramp and the kanban column
   * order; `open` marks the stages that still need work; `pattern` is the fill
   * that carries the stage without relying on hue.
   *
   * Invoicing ends the order. This workspace draws no line between billed and
   * reconciled, so the two are one terminal stage rather than a rule that moves
   * orders from one to the other.
   */
  const ORDER_STATUSES = [
    {
      id: 'placed', step: 1, open: true, pattern: 'solid',
      label: 'Order placed – awaiting shipment', short: 'Awaiting shipment',
      hint: 'Sent to the winery; nothing has been collected yet.',
    },
    {
      id: 'transit', step: 2, open: true, pattern: 'diagonal',
      label: 'In transit', short: 'In transit',
      hint: 'Collected from the cellars, not yet delivered.',
    },
    {
      id: 'delivered', step: 3, open: true, pattern: 'horizontal',
      label: 'Delivered', short: 'Delivered',
      hint: 'Arrived at the delivery point, not yet invoiced.',
    },
    {
      id: 'invoiced', step: 4, open: false, pattern: 'vertical', terminal: true,
      label: 'Invoiced and Closed', short: 'Invoiced and Closed',
      hint: 'Billed out, and closed by that fact — an invoiced order is finished here.',
    },
  ];

  /* Statuses stored before the two terminal stages became one. */
  const LEGACY_STATUS_IDS = { closed: 'invoiced' };

  const canonicalStatusId = (id) => {
    const s = String(id == null ? '' : id);
    return Object.prototype.hasOwnProperty.call(LEGACY_STATUS_IDS, s) ? LEGACY_STATUS_IDS[s] : s;
  };

  const statusById = (id) => ORDER_STATUSES.find((s) => s.id === canonicalStatusId(id)) || null;
  const isOpenStatus = (id) => { const s = statusById(id); return !s || s.open; };
  const TERMINAL_STATUS = ORDER_STATUSES.find((s) => s.terminal);

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
      status: canonicalStatusId(statusId),
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
    { statusId: 'invoiced', re: /^NAV INV/i, reason: 'a NAV invoice number is recorded, which closes the order' },
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
    { key: 'balanceCs', re: /^Balance on Contract\s*\(cs\)/i },
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
  function effectiveStatus(order, statusDoc) {
    const entry = statusDoc && statusDoc.entries ? statusDoc.entries[order.key] : null;
    if (entry && statusById(entry.status)) {
      // A status recorded as "closed" before the terminal stages merged reads as
      // the merged stage now, so old records keep meaning what they meant.
      const canonical = canonicalStatusId(entry.status);
      const renamed = canonical !== entry.status;
      return {
        statusId: canonical, source: 'set',
        updated: entry.updated || '', updatedBy: entry.updatedBy || '', note: entry.note || '',
        reason: 'set by ' + (entry.updatedBy || 'someone')
          + (entry.updated ? ' on ' + entry.updated.slice(0, 10) : '')
          + (renamed ? ' (recorded as “closed”, before invoiced and closed became one stage)' : ''),
      };
    }
    if (order.derived) {
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
   * Contract standing
   * ------------------------------------------------------------------ */

  /**
   * Where an item's contract stands.
   *
   * The tracker carries a running balance that steps down with each order, so
   * the last row's balance is what is left. Nothing is recalculated here — the
   * sheet's own arithmetic is read, which means a balance that has gone negative
   * shows as negative rather than being quietly clamped.
   */
  const CONTRACT_STATES = {
    open: { id: 'open', label: 'Open', tone: 'good' },
    closed: { id: 'closed', label: 'Closed', tone: 'neutral' },
    over: { id: 'over', label: 'Over contract', tone: 'critical' },
    unknown: { id: 'unknown', label: 'No balance column', tone: 'neutral' },
  };

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  function contractStanding(orders, context) {
    const ctx = context || {};
    const rows = orders.slice().sort((a, b) => a.row - b.row);
    const last = rows.length ? rows[rows.length - 1] : null;

    const bt = last ? num(last.values.balanceBt) : null;
    const cs = last ? num(last.values.balanceCs) : null;

    let state = 'unknown';
    let reason = 'this tracker has no balance column';
    if (bt != null) {
      if (bt < 0) {
        state = 'over';
        reason = 'the contract balance has gone below zero — more has been ordered than the contract covers';
      } else if (bt === 0) {
        state = 'closed';
        reason = 'the contract balance is zero — everything contracted has been ordered';
      } else {
        state = 'open';
        reason = 'the contract still has quantity left to order';
      }
    }

    // The most recent delivery that actually happened, and the furthest-out
    // delivery anyone has asked for. Implausible serials are already excluded
    // upstream, so a mistyped year cannot become "the furthest date".
    let lastDelivery = null;
    let lastDeliveryPo = '';
    let furthestRequested = null;
    let furthestRequestedPo = '';
    for (const o of rows) {
      const d = o.dates.delivered;
      if (d && (!lastDelivery || d > lastDelivery)) { lastDelivery = d; lastDeliveryPo = o.po; }
      const r = o.dates.requiredDelivery;
      if (r && (!furthestRequested || r > furthestRequested)) { furthestRequested = r; furthestRequestedPo = o.po; }
    }

    return {
      accountId: ctx.accountId || '', accountName: ctx.accountName || '',
      itemId: ctx.itemId || '', itemName: ctx.itemName || '',
      cycle: ctx.cycle || '',
      balanceBt: bt, balanceCs: cs,
      balanceFrom: last ? last.po : '',
      state, stateLabel: CONTRACT_STATES[state].label, tone: CONTRACT_STATES[state].tone, reason,
      isClosed: state === 'closed',
      isOver: state === 'over',
      lastDelivery, lastDeliveryPo,
      furthestRequested, furthestRequestedPo,
      orders: rows.length,
      open: rows.filter((o) => o.isOpen).length,
    };
  }

  /* ------------------------------------------------------------------ *
   * Schedule and lateness
   * ------------------------------------------------------------------ */

  /**
   * How an order stands against the dates it was promised.
   *
   * Two different things, kept apart because they call for different action:
   *   - `overdue`: the date has passed and the tracker still records nothing.
   *     Someone has to chase it today.
   *   - `late`: it happened, but after the date asked for. Nothing to chase; it
   *     is a record of how the account has actually run.
   */
  function scheduleFlags(order, today) {
    const now = today || new Date();
    const out = {
      collectionOverdue: null, deliveryOverdue: null,
      collectedLate: null, deliveredLate: null,
    };

    const reqCollection = order.dates.requestedCollection;
    const collected = order.dates.actualCollection;
    if (reqCollection) {
      if (!collected) {
        const days = AMI.daysBetween(reqCollection, now);
        if (days > 0) out.collectionOverdue = { due: reqCollection, days };
      } else if (AMI.daysBetween(reqCollection, collected) > 0) {
        out.collectedLate = { due: reqCollection, on: collected, days: AMI.daysBetween(reqCollection, collected) };
      }
    }

    const reqDelivery = order.dates.requiredDelivery;
    const delivered = order.dates.delivered;
    if (reqDelivery) {
      if (!delivered) {
        const days = AMI.daysBetween(reqDelivery, now);
        if (days > 0) out.deliveryOverdue = { due: reqDelivery, days };
      } else if (AMI.daysBetween(reqDelivery, delivered) > 0) {
        out.deliveredLate = { due: reqDelivery, on: delivered, days: AMI.daysBetween(reqDelivery, delivered) };
      }
    }
    return out;
  }

  /** Attach the schedule flags to every order. */
  function withSchedule(orders, today) {
    const now = today || new Date();
    return orders.map((o) => Object.assign({}, o, { schedule: scheduleFlags(o, now) }));
  }

  /**
   * Every collection and delivery still ahead of us or already missed.
   *
   * A date that has been met drops out — it needs nothing. A date that has
   * passed with nothing recorded stays, marked overdue, because that is the
   * most important thing a schedule can tell you.
   */
  function scheduleEntries(orders, today) {
    const now = today || new Date();
    const out = [];
    for (const o of orders) {
      const flags = o.schedule || scheduleFlags(o, now);

      if (o.dates.requestedCollection && !o.dates.actualCollection) {
        const days = AMI.daysBetween(o.dates.requestedCollection, now);
        out.push({
          order: o, kind: 'collection', label: 'Collection',
          date: o.dates.requestedCollection,
          overdue: !!flags.collectionOverdue,
          days: -days,
        });
      }
      if (o.dates.requiredDelivery && !o.dates.delivered) {
        const days = AMI.daysBetween(o.dates.requiredDelivery, now);
        out.push({
          order: o, kind: 'delivery', label: 'Delivery',
          date: o.dates.requiredDelivery,
          overdue: !!flags.deliveryOverdue,
          days: -days,
        });
      }
    }
    out.sort((a, b) => a.date - b.date);
    return out;
  }

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  /** The Monday of a date's week. Weeks run Monday to Sunday. */
  function startOfWeek(d) {
    const s = startOfDay(d);
    const shift = (s.getDay() + 6) % 7;
    return new Date(s.getFullYear(), s.getMonth(), s.getDate() - shift);
  }

  const shortDate = (d) => DAY_SHORT[d.getDay()] + ' ' + d.getDate() + ' '
    + MONTH_NAMES[d.getMonth()].slice(0, 3);

  /**
   * Group schedule entries into weeks or months, overdue first.
   *
   * Overdue is its own group rather than being filed under the week it was due —
   * it is a different kind of fact, and burying it in a past week would hide it.
   */
  function groupSchedule(entries, by, today) {
    const now = today || new Date();
    const groups = [];
    const index = new Map();

    const overdue = entries.filter((e) => e.overdue);
    if (overdue.length) {
      groups.push({
        key: 'overdue', label: 'Overdue', sub: 'the date has passed with nothing recorded',
        overdue: true, entries: overdue,
      });
    }

    for (const e of entries) {
      if (e.overdue) continue;
      let key;
      let label;
      let sub;
      if (by === 'month') {
        const m = new Date(e.date.getFullYear(), e.date.getMonth(), 1);
        key = 'm' + m.getFullYear() + '-' + m.getMonth();
        label = MONTH_NAMES[m.getMonth()] + ' ' + m.getFullYear();
        sub = '';
      } else {
        const w = startOfWeek(e.date);
        const end = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 6);
        key = 'w' + w.getFullYear() + '-' + w.getMonth() + '-' + w.getDate();
        label = shortDate(w) + ' – ' + shortDate(end);
        const offset = AMI.daysBetween(startOfWeek(now), w) / 7;
        sub = offset === 0 ? 'this week' : (offset === 1 ? 'next week' : 'in ' + offset + ' weeks');
      }
      if (!index.has(key)) {
        const group = { key, label, sub, overdue: false, entries: [] };
        index.set(key, group);
        groups.push(group);
      }
      index.get(key).entries.push(e);
    }
    return groups;
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
  function decorate(orders, statusDoc, today) {
    const now = today || new Date();
    return orders.map((o) => {
      const status = effectiveStatus(o, statusDoc);
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
      const id = canonicalStatusId(o.status.statusId);
      if (!id || !(id in counts)) counts.unset++;
      else counts[id]++;
    }
    return counts;
  }

  /**
   * Split orders by whether they are finished, so a view can leave the finished
   * ones out. Kept here rather than in the interface, because "finished" is a
   * property of the pipeline, not of any one page.
   */
  function partitionClosed(orders) {
    const closed = [];
    const rest = [];
    for (const o of orders) (o.isOpen === false ? closed : rest).push(o);
    return { closed, open: rest };
  }

  /* Thresholds are stated in the interface, so "attention" is never a black box. */
  const HEALTH_THRESHOLDS = {
    // How far past a missed collection date before it stops being a slip and
    // starts being a problem.
    lateCollectionDays: 14,
    // Ages, kept for the stalest-order column. They no longer set health.
    warningDays: 21, criticalDays: 45,
  };

  /**
   * A per-account roll-up.
   *
   * Health reads two things and nothing else: orders whose requested collection
   * date has passed with no collection recorded, and orders whose required
   * delivery date has passed with no delivery recorded. Both are about what is
   * true today and needs chasing today.
   *
   * An order that was collected or delivered late is counted separately, as a
   * record of how the account has run — it is not chaseable and so does not move
   * the health mark. Without that split every account would sit permanently at
   * risk over a delivery that slipped two days last February.
   */
  function summariseAccount(account, divisionName, orders, followUpCount, thresholds, today) {
    const t = Object.assign({}, HEALTH_THRESHOLDS, thresholds || {});
    const now = today || new Date();
    const flagged = orders.map((o) => (o.schedule ? o : Object.assign({}, o, { schedule: scheduleFlags(o, now) })));

    const open = flagged.filter((o) => o.isOpen);
    const counts = countByStatus(flagged);
    const stalest = open.reduce((worst, o) => (
      o.ageDays != null && (!worst || o.ageDays > worst.ageDays) ? o : worst), null);

    const collectionsOverdue = flagged.filter((o) => o.schedule.collectionOverdue);
    const deliveriesOverdue = flagged.filter((o) => o.schedule.deliveryOverdue);
    const collectedLate = flagged.filter((o) => o.schedule.collectedLate);
    const deliveredLate = flagged.filter((o) => o.schedule.deliveredLate);

    const worstCollection = collectionsOverdue.reduce((w, o) => (
      !w || o.schedule.collectionOverdue.days > w.schedule.collectionOverdue.days ? o : w), null);
    const worstDelivery = deliveriesOverdue.reduce((w, o) => (
      !w || o.schedule.deliveryOverdue.days > w.schedule.deliveryOverdue.days ? o : w), null);

    const reasons = [];
    let level = 'good';

    // A missed delivery is the customer's problem, so it outranks everything.
    if (deliveriesOverdue.length) {
      level = 'critical';
      reasons.push(deliveriesOverdue.length + ' order(s) past their required delivery date with no delivery recorded'
        + (worstDelivery ? ' — worst is PO ' + worstDelivery.po + ' by '
          + worstDelivery.schedule.deliveryOverdue.days + ' days' : ''));
    }
    if (collectionsOverdue.length) {
      const worstDays = worstCollection ? worstCollection.schedule.collectionOverdue.days : 0;
      if (worstDays >= t.lateCollectionDays) level = 'critical';
      else if (level === 'good') level = 'warning';
      reasons.push(collectionsOverdue.length + ' order(s) past their requested collection date with nothing collected'
        + (worstCollection ? ' — worst is PO ' + worstCollection.po + ' by ' + worstDays + ' days' : ''));
    }
    if (level === 'good') {
      reasons.push('every requested collection and required delivery date so far has been met or is still ahead');
    }

    return {
      accountId: account.id, accountName: account.name, divisionId: account.divisionId,
      divisionName: divisionName || '',
      total: flagged.length, open: open.length, counts,
      followUps: followUpCount || 0,
      stalest, stalestDays: stalest && stalest.ageDays != null ? stalest.ageDays : 0,
      collectionsOverdue: collectionsOverdue.length,
      deliveriesOverdue: deliveriesOverdue.length,
      collectedLate: collectedLate.length,
      deliveredLate: deliveredLate.length,
      worstCollection, worstDelivery,
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
    STATUS_PATH, ORDER_STATUSES, HEALTH_THRESHOLDS, LEGACY_STATUS_IDS, TERMINAL_STATUS,
    statusById, isOpenStatus, statusKey, canonicalStatusId,
    emptyStatusDoc, loadStatuses, saveStatuses, mergeStatusDocs, setStatus, clearStatus,
    deriveStatus, readOrders, effectiveStatus, decorate, countByStatus, emptyCounts, plausibleWindow,
    partitionClosed, summariseAccount, buildAccountSummary, daysSince,
    CONTRACT_STATES, contractStanding,
    scheduleFlags, withSchedule, scheduleEntries, groupSchedule, startOfWeek, MONTH_NAMES,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
