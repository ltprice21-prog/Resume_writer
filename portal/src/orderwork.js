/* Order work: the stage checklists, exceptions and activity that sit on top of
 * the tracker — pure logic, no DOM.
 *
 * What is and is not stored here
 * ------------------------------
 * The tracker and the purchase orders remain the only source of facts about an
 * order. This module never writes a date, a quantity or a status of its own.
 * What it keeps is the *work around* an order: which standard checklist steps a
 * person has ticked, tasks a person added, exceptions a person raised or
 * answered, and a short activity log. Each is stamped with who and when.
 *
 * Checklist wording is the division's own standard process, held in this file.
 * It is a prompt for the person doing the work, never a statement about the
 * order, and a step is only ever "done" because a person ticked it.
 *
 * Exceptions that are flagged automatically are worked out from tracker dates
 * and the follow-up rules alone, each saying exactly which dates produced it.
 *
 * Saved in `order-work.json` in the shared folder, merged entry by entry so two
 * people working different orders — or different parts of one — both survive.
 *
 * Extends the global `AMI` namespace. Needs status.js.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});
  const DEC = new TextDecoder('utf-8');
  const ENC = new TextEncoder();

  const WORK_PATH = 'order-work.json';
  const ACTIVITY_CAP = 150;

  const nowIso = () => new Date().toISOString();
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  /* ------------------------------------------------------------------ *
   * Standard checklist, by stage
   * ------------------------------------------------------------------ *
   *
   * `due` ties a step to a tracker date where one exists: the requested
   * collection date minus `days`, or the customer's required delivery date.
   * No date is invented — a step with no anchor has no due date unless a person
   * sets one.
   */

  const COLLECTION = 'requestedCollection';
  const DELIVERY = 'requiredDelivery';

  const STAGE_TASKS = {
    received: [
      { title: 'Confirm PO details (customer, destination, dates)' },
      { title: 'Review pricing against the price list' },
      { title: 'Review quantities and product availability' },
      { title: 'Review the delivery request against lead time' },
      { title: 'File the customer PO in the order folder' },
    ],
    validated: [
      { title: 'Validate commercial terms (Incoterm, currency, payment)' },
      { title: 'Review account requirements' },
      { title: 'Review compliance and destination requirements' },
      { title: 'Approve the order' },
    ],
    'supplier-po': [
      { title: 'Create the supplier PO' },
      { title: 'Send supplier instructions and account requirements' },
      { title: 'Confirm supplier acceptance' },
    ],
    'supply-confirmed': [
      { title: 'Confirm inventory and allocation' },
      { title: 'Confirm the ready date with the supplier' },
      { title: 'Resolve shortages or substitutions' },
    ],
    logistics: [
      { title: 'Assign forwarder and transport mode', due: { from: COLLECTION, days: 3 } },
      { title: 'Confirm warehouse requirements', due: { from: COLLECTION, days: 3 } },
      { title: 'Schedule collection', due: { from: COLLECTION, days: 3 } },
      { title: 'Confirm booking and ETA', due: { from: COLLECTION, days: 3 } },
    ],
    documents: [
      { title: 'Collect required documents', due: { from: COLLECTION, days: 2 } },
      { title: 'Review documents against account rules', due: { from: COLLECTION, days: 2 } },
      { title: 'Validate compliance', due: { from: COLLECTION, days: 2 } },
    ],
    'pre-shipment': [
      { title: 'Verify readiness: supply, booking, documents', due: { from: COLLECTION, days: 1 } },
      { title: 'Reconfirm booking with the forwarder', due: { from: COLLECTION, days: 1 } },
      { title: 'Approve the shipment', due: { from: COLLECTION, days: 1 } },
    ],
    shipped: [
      { title: 'Confirm collection', due: { from: COLLECTION, days: 0 } },
      { title: 'Send the shipping notice to the customer', due: { from: COLLECTION, days: 0 } },
      { title: 'Monitor transit and manage delays' },
    ],
    delivered: [
      { title: 'Confirm delivery', due: { from: DELIVERY, days: 0 } },
      { title: 'Support customs clearance' },
      { title: 'Obtain proof of delivery (POD)' },
    ],
    'customer-invoiced': [
      { title: 'Create the customer invoice' },
      { title: 'Validate pricing and invoice rules' },
      { title: 'Issue billing documents' },
    ],
    settled: [
      { title: 'Receive the supplier invoice' },
      { title: 'Match the supplier invoice to the supplier PO' },
      { title: 'Submit for payment' },
    ],
    closed: [
      { title: 'Close outstanding actions' },
      { title: 'Archive documentation' },
      { title: 'Capture lessons learned' },
    ],
  };

  const taskId = (stageId, title) => stageId + ':' + slug(title);

  /* ------------------------------------------------------------------ *
   * Document
   * ------------------------------------------------------------------ */

  function emptyWorkDoc() {
    return { version: 1, updated: nowIso(), updatedBy: '', orders: {} };
  }

  function emptyEntry() {
    return { tasks: {}, custom: [], exceptions: {}, raised: [], activity: [], updated: '' };
  }

  function entryFor(doc, key) {
    if (!doc.orders[key]) doc.orders[key] = emptyEntry();
    const e = doc.orders[key];
    for (const k of Object.keys(emptyEntry())) if (e[k] === undefined) e[k] = emptyEntry()[k];
    return e;
  }

  const stamp = (e) => { e.updated = nowIso(); };

  async function loadWork(store) {
    const bytes = await store.read(WORK_PATH);
    if (!bytes) return emptyWorkDoc();
    try {
      const parsed = JSON.parse(DEC.decode(bytes));
      return { version: 1, updated: parsed.updated || '', updatedBy: parsed.updatedBy || '', orders: parsed.orders || {} };
    } catch (e) {
      throw new Error(WORK_PATH + ' could not be read: ' + e.message);
    }
  }

  const newer = (a, b, field) => (String((b || {})[field] || '') > String((a || {})[field] || '') ? b : a);

  /** Merge two keyed maps of records, the record with the later `field` winning. */
  function mergeMap(a, b, field) {
    const out = {};
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      out[k] = !a || !a[k] ? b[k] : (!b || !b[k] ? a[k] : newer(a[k], b[k], field));
    }
    return out;
  }

  /** Merge two lists of records that carry an `id`, the later `field` winning. */
  function mergeList(a, b, field) {
    const byId = new Map();
    for (const r of [...(b || []), ...(a || [])]) {
      const have = byId.get(r.id);
      byId.set(r.id, have ? newer(have, r, field) : r);
    }
    return [...byId.values()];
  }

  function mergeEntries(mine, theirs) {
    const m = Object.assign(emptyEntry(), mine || {});
    const t = Object.assign(emptyEntry(), theirs || {});
    const seen = new Set();
    const activity = [];
    for (const a of [...m.activity, ...t.activity]) {
      const k = a.at + '|' + a.who + '|' + a.text;
      if (seen.has(k)) continue;
      seen.add(k);
      activity.push(a);
    }
    activity.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return {
      tasks: mergeMap(m.tasks, t.tasks, 'at'),
      custom: mergeList(m.custom, t.custom, 'updated'),
      exceptions: mergeMap(m.exceptions, t.exceptions, 'at'),
      raised: mergeList(m.raised, t.raised, 'raisedAt'),
      activity: activity.slice(0, ACTIVITY_CAP),
      updated: String(m.updated) > String(t.updated) ? m.updated : t.updated,
    };
  }

  function mergeWorkDocs(mine, theirs) {
    const out = { version: 1, updated: nowIso(), orders: {} };
    const keys = new Set([...Object.keys(mine.orders || {}), ...Object.keys(theirs.orders || {})]);
    for (const k of keys) {
      const a = (mine.orders || {})[k];
      const b = (theirs.orders || {})[k];
      out.orders[k] = !a ? b : (!b ? a : mergeEntries(a, b));
    }
    return out;
  }

  async function saveWork(store, doc, opts) {
    const options = opts || {};
    let merged = doc;
    const existing = await store.read(WORK_PATH);
    if (existing) {
      try {
        const onDisk = JSON.parse(DEC.decode(existing));
        merged = mergeWorkDocs(doc, { orders: onDisk.orders || {} });
      } catch (e) { /* unreadable on disk: our copy wins */ }
    }
    merged.updated = nowIso();
    merged.updatedBy = options.by || '';
    await store.write(WORK_PATH, ENC.encode(JSON.stringify(merged, null, 2)));
    return merged;
  }

  /* ------------------------------------------------------------------ *
   * Activity
   * ------------------------------------------------------------------ */

  function logActivity(doc, key, who, text) {
    const e = entryFor(doc, key);
    e.activity.unshift({ at: nowIso(), who: who || 'Someone', text });
    if (e.activity.length > ACTIVITY_CAP) e.activity.length = ACTIVITY_CAP;
    stamp(e);
  }

  const activityFor = (doc, key) => ((doc && doc.orders && doc.orders[key]) || emptyEntry()).activity || [];

  /* ------------------------------------------------------------------ *
   * Tasks
   * ------------------------------------------------------------------ */

  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const parseIso = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  /**
   * The stage an order's work is at: the one it is waiting on, which is the next
   * after the furthest stage reached. Null once the order has closed.
   */
  function workStage(order) {
    return AMI.nextForOrder(order) || null;
  }

  /** The due date a template step carries for this order, and where it came from. */
  function templateDue(def, order) {
    if (!def.due) return { date: null, source: '' };
    const base = order.dates && order.dates[def.due.from];
    if (!base) return { date: null, source: '' };
    const label = def.due.from === COLLECTION ? 'requested collection date' : 'customer required delivery date';
    const src = def.due.days
      ? def.due.days + ' day' + (def.due.days > 1 ? 's' : '') + ' before the ' + label
      : 'the ' + label;
    return { date: addDays(startOfDay(base), -def.due.days), source: src };
  }

  /**
   * Every checklist line for one order.
   *
   *   current   steps for the stage the order is working on, standard and added
   *   done      steps a person has ticked on any stage
   *
   * A step is done only because a person ticked it; the tracker moving on does
   * not tick anything.
   */
  function tasksFor(order, doc, now) {
    const today = startOfDay(now || new Date());
    const entry = (doc && doc.orders && doc.orders[order.key]) || emptyEntry();
    const stage = workStage(order);
    const lines = [];

    for (const stageDef of AMI.ORDER_STATUSES) {
      for (const def of STAGE_TASKS[stageDef.id] || []) {
        const id = taskId(stageDef.id, def.title);
        const st = entry.tasks[id] || {};
        const due = st.due ? { date: parseIso(st.due), source: 'set by ' + (st.by || 'a person') } : templateDue(def, order);
        lines.push({
          id, stageId: stageDef.id, stage: stageDef, title: def.title, custom: false,
          done: !!st.done, doneBy: st.done ? st.by || '' : '', doneAt: st.done ? st.at || '' : '',
          owner: st.owner || '', due: due.date, dueSource: due.source,
        });
      }
    }
    for (const c of entry.custom) {
      if (c.removed) continue;
      const stageDef = AMI.statusById(c.stageId) || stage || AMI.ORDER_STATUSES[0];
      lines.push({
        id: c.id, stageId: stageDef.id, stage: stageDef, title: c.title, custom: true,
        done: !!c.done, doneBy: c.done ? c.doneBy || '' : '', doneAt: c.done ? c.doneAt || '' : '',
        owner: c.owner || '', due: parseIso(c.due), dueSource: c.due ? 'set by ' + (c.createdBy || 'a person') : '',
        createdBy: c.createdBy || '',
      });
    }

    for (const l of lines) l.overdue = !l.done && !!l.due && l.due < today;
    const here = (l) => !!stage && l.stageId === stage.id;
    return {
      stage,
      // Every step for the stage being worked, ticked or not.
      current: lines.filter(here),
      // Added tasks still open on some other stage.
      elsewhere: lines.filter((l) => l.custom && !l.done && !here(l)),
      // Ticked steps on any other stage.
      done: lines.filter((l) => l.done && !here(l)),
      all: lines,
    };
  }

  /** Tick or untick a standard or added step. */
  function setTaskDone(doc, order, taskIdValue, done, by) {
    const e = entryFor(doc, order.key);
    const custom = e.custom.find((c) => c.id === taskIdValue);
    const at = nowIso();
    let title = '';
    if (custom) {
      custom.done = !!done; custom.doneBy = done ? by || '' : ''; custom.doneAt = done ? at : ''; custom.updated = at;
      title = custom.title;
    } else {
      const prev = e.tasks[taskIdValue] || {};
      e.tasks[taskIdValue] = Object.assign({}, prev, { done: !!done, by: by || '', at });
      title = taskTitle(e, taskIdValue);
    }
    logActivity(doc, order.key, by, (done ? 'Ticked: ' : 'Reopened: ') + title);
    stamp(e);
    return doc;
  }

  /** Give a step a due date or an owner. Blank clears it. */
  function setTaskField(doc, order, taskIdValue, field, value, by) {
    if (field !== 'due' && field !== 'owner') throw new Error('Only due and owner can be set on a task.');
    const e = entryFor(doc, order.key);
    const at = nowIso();
    const custom = e.custom.find((c) => c.id === taskIdValue);
    if (custom) { custom[field] = value || ''; custom.updated = at; }
    else e.tasks[taskIdValue] = Object.assign({}, e.tasks[taskIdValue] || {}, { [field]: value || '', by: by || '', at });
    logActivity(doc, order.key, by, (field === 'due' ? 'Changed the due date on: ' : 'Reassigned: ') + taskTitle(e, taskIdValue));
    stamp(e);
    return doc;
  }

  function taskTitle(entry, id) {
    const custom = entry.custom.find((c) => c.id === id);
    if (custom) return custom.title;
    for (const s of AMI.ORDER_STATUSES) {
      const def = (STAGE_TASKS[s.id] || []).find((d) => taskId(s.id, d.title) === id);
      if (def) return def.title;
    }
    return id;
  }

  function addCustomTask(doc, order, fields, by) {
    const title = String((fields && fields.title) || '').trim();
    if (!title) throw new Error('A task needs a title.');
    const e = entryFor(doc, order.key);
    const stage = AMI.statusById(fields.stageId) || workStage(order) || AMI.ORDER_STATUSES[0];
    const at = nowIso();
    const task = {
      id: 'c-' + uid(), stageId: stage.id, title, owner: fields.owner || '', due: fields.due || '',
      done: false, createdBy: by || '', createdAt: at, updated: at,
    };
    e.custom.push(task);
    logActivity(doc, order.key, by, 'Added task: ' + title);
    return task;
  }

  function removeCustomTask(doc, order, taskIdValue, by) {
    const e = entryFor(doc, order.key);
    const c = e.custom.find((x) => x.id === taskIdValue);
    if (!c) return doc;
    c.removed = true; c.updated = nowIso();
    logActivity(doc, order.key, by, 'Removed task: ' + c.title);
    return doc;
  }

  /* ------------------------------------------------------------------ *
   * Exceptions
   * ------------------------------------------------------------------ */

  const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
  const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };
  const OPEN_EXCEPTION = ['Open', 'Acknowledged', 'Escalated'];

  const RESOLUTIONS = [
    'Fixed by supplier', 'Fixed by forwarder', 'Customer agreed a change', 'Internal correction',
    'Document reissued', 'Waived or accepted risk', 'Tracker corrected', 'Not an issue',
  ];
  const ROOT_CAUSES = [
    'Supplier process', 'Customer change', 'Forwarder or carrier', 'Customs or regulatory',
    'Internal error', 'Requirement unclear', 'Data quality',
  ];

  const MANUAL_TYPES = [
    'Pricing discrepancy', 'Product shortage', 'Unrealistic delivery request', 'Supplier non-response',
    'Production or ready-date slip', 'Missing documentation', 'Document error', 'Account requirement not met',
    'Compliance issue', 'Delayed shipment', 'Customs hold', 'Damage or temperature excursion',
    'Missing POD', 'Invoice mismatch', 'Other',
  ];

  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const fmt = (d) => (AMI.formatShort ? AMI.formatShort(d) : isoDay(d));

  /**
   * Exceptions the tracker's own dates and follow-up rules raise. Each says
   * which dates produced it; none is a guess about what is happening outside
   * the sheet.
   */
  function detectExceptions(order, opts) {
    const o = opts || {};
    const now = startOfDay(o.now || new Date());
    const out = [];
    if (order.isOpen === false) return out;
    const dates = order.dates || {};
    const flags = order.schedule || {};

    if (flags.collectionOverdue) {
      const d = flags.collectionOverdue.days;
      out.push({
        code: 'COLLECTION_OVERDUE', stageId: 'shipped', severity: d >= 7 ? 'Critical' : 'High',
        title: 'Collection overdue: requested for ' + fmt(flags.collectionOverdue.due) + ', nothing recorded ' + plural(d, 'day') + ' later',
        due: flags.collectionOverdue.due,
      });
    }
    if (flags.deliveryOverdue) {
      const d = flags.deliveryOverdue.days;
      out.push({
        code: 'DELIVERY_OVERDUE', stageId: 'delivered', severity: d >= 7 ? 'Critical' : 'High',
        title: 'Delivery overdue: customer required ' + fmt(flags.deliveryOverdue.due) + ', nothing recorded ' + plural(d, 'day') + ' later',
        due: flags.deliveryOverdue.due,
      });
    }

    // Documents the follow-up rules say are still missing, close to collection.
    const docChases = (o.followUps || []).filter((f) => f.stage === 'documents' && !f.superseded);
    if (docChases.length && dates.requestedCollection && !dates.actualCollection) {
      const toGo = AMI.daysBetween(now, dates.requestedCollection);
      if (toGo <= 3) {
        out.push({
          code: 'DOCS_MISSING', stageId: 'documents', severity: toGo <= 1 ? 'Critical' : 'High',
          title: 'Still blank before collection: ' + docChases.map((f) => f.missingHeader).join(', '),
          due: toGo > 1 ? addDays(dates.requestedCollection, -1) : now,
        });
      }
    }

    const delivered = dates.delivered;
    const invoiced = order.evidence && order.evidence['customer-invoiced'];
    if (delivered && !invoiced) {
      const age = AMI.daysBetween(delivered, now);
      if (age >= 3) {
        out.push({
          code: 'INVOICE_OVERDUE', stageId: 'customer-invoiced', severity: 'Medium',
          title: 'Delivered ' + plural(age, 'day') + ' ago (' + fmt(delivered) + ') and no NAV invoice number recorded',
          due: addDays(delivered, 3),
        });
      }
    }

    for (const issue of order.dateIssues || []) {
      out.push({
        code: 'DATE_IMPLAUSIBLE:' + issue.key, stageId: '', severity: 'Medium',
        title: 'The tracker’s ' + issue.label + ' date (' + fmt(issue.date) + ') looks mistyped and is being ignored',
        due: null,
      });
    }

    if (order.status && order.status.behindTracker) {
      const t = AMI.statusById(order.status.trackerStatusId);
      out.push({
        code: 'STATUS_BEHIND', stageId: '', severity: 'Low',
        title: 'Stage set to ' + AMI.statusById(order.status.statusId).label + ' but the tracker already shows ' + (t ? t.label : 'a later stage'),
        due: null,
      });
    }
    return out;
  }

  /**
   * One order's exceptions: those detected now, those a person raised, and the
   * answer a person has given to either. An automatic one whose cause has since
   * gone reads `Cleared` rather than vanishing, so the record of it survives.
   */
  function exceptionsFor(order, doc, opts) {
    const entry = (doc && doc.orders && doc.orders[order.key]) || emptyEntry();
    const detected = detectExceptions(order, opts);
    const out = [];
    const live = new Set();

    for (const d of detected) {
      const id = 'auto-' + d.code;
      live.add(id);
      const st = entry.exceptions[id] || {};
      out.push({
        id, orderKey: order.key, code: d.code, title: d.title, severity: d.severity, stageId: d.stageId,
        due: d.due, auto: true, status: st.status || 'Open', note: st.note || '',
        resolution: st.resolution || '', rootCause: st.rootCause || '',
        by: st.by || '', at: st.at || '', raisedBy: 'Tracker dates', raisedAt: '',
      });
    }
    for (const id of Object.keys(entry.exceptions)) {
      if (!id.startsWith('auto-') || live.has(id)) continue;
      const st = entry.exceptions[id];
      if (!OPEN_EXCEPTION.includes(st.status)) continue;
      out.push({
        id, orderKey: order.key, code: id.slice(5), title: st.title || 'Flag from tracker dates', severity: st.severity || 'Low',
        stageId: '', due: null, auto: true, status: 'Cleared', note: st.note || '', resolution: '', rootCause: '',
        by: st.by || '', at: st.at || '', raisedBy: 'Tracker dates', raisedAt: '',
      });
    }
    for (const r of entry.raised) {
      const st = entry.exceptions[r.id] || {};
      out.push({
        id: r.id, orderKey: order.key, code: 'MANUAL', title: r.title, severity: st.severity || r.severity,
        stageId: r.stageId || '', due: parseIso(r.due), auto: false, detail: r.detail || '',
        status: st.status || 'Open', note: st.note || '', resolution: st.resolution || '', rootCause: st.rootCause || '',
        by: st.by || '', at: st.at || '', raisedBy: r.raisedBy || '', raisedAt: r.raisedAt || '',
      });
    }
    out.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || a.title.localeCompare(b.title));
    return out;
  }

  const isOpenException = (x) => OPEN_EXCEPTION.includes(x.status);

  /** Remember an automatic exception's wording so it can be shown after it clears. */
  function setExceptionState(doc, order, exception, status, fields, by) {
    if (![...OPEN_EXCEPTION, 'Resolved'].includes(status)) throw new Error('Unknown exception status "' + status + '".');
    const f = fields || {};
    if (status === 'Resolved' && !f.resolution) throw new Error('Say how it was resolved.');
    const e = entryFor(doc, order.key);
    const prev = e.exceptions[exception.id] || {};
    e.exceptions[exception.id] = {
      status, by: by || '', at: nowIso(),
      note: f.note !== undefined ? f.note : (prev.note || ''),
      resolution: status === 'Resolved' ? f.resolution : '',
      rootCause: status === 'Resolved' ? (f.rootCause || '') : '',
      severity: exception.severity,
      title: exception.auto ? exception.title : undefined,
    };
    logActivity(doc, order.key, by, {
      Open: 'Reopened exception: ', Acknowledged: 'Acknowledged exception: ',
      Escalated: 'Escalated exception: ', Resolved: 'Resolved exception: ',
    }[status] + exception.title + (status === 'Resolved' ? ' (' + f.resolution + ')' : ''));
    return doc;
  }

  function raiseException(doc, order, fields, by) {
    const title = String((fields && fields.title) || '').trim();
    if (!title) throw new Error('An exception needs a title.');
    const severity = SEVERITIES.includes(fields.severity) ? fields.severity : 'Medium';
    const e = entryFor(doc, order.key);
    const r = {
      id: 'x-' + uid(), title, severity, detail: fields.detail || '', due: fields.due || '',
      stageId: fields.stageId || '', raisedBy: by || '', raisedAt: nowIso(),
    };
    e.raised.push(r);
    logActivity(doc, order.key, by, 'Raised exception (' + severity + '): ' + title);
    return r;
  }

  /* ------------------------------------------------------------------ *
   * Shipments
   * ------------------------------------------------------------------ */

  /**
   * One line per order for the shipments page. Everything is a tracker column:
   * the dates, the truck type, the quantities. Where the tracker is blank the
   * line says so instead of supplying a value.
   */
  function shipmentLine(order) {
    const d = order.dates || {};
    const flags = order.schedule || {};
    let status;
    if (d.delivered) status = { id: 'delivered', label: 'Delivered' };
    else if (d.actualCollection) status = { id: 'collected', label: 'Collected, not yet delivered' };
    else if (d.requestedCollection) status = { id: 'awaiting', label: 'Awaiting collection' };
    else status = { id: 'unscheduled', label: 'No collection date in the tracker' };

    const logistics = order.evidence && order.evidence.logistics;
    const truck = logistics ? logistics.cells.map((c) => c.text).filter(Boolean).join(', ') : '';

    return {
      key: order.key, po: order.po, accountName: order.accountName, itemName: order.itemName,
      status, requestedCollection: d.requestedCollection || null, collected: d.actualCollection || null,
      requiredDelivery: d.requiredDelivery || null, delivered: d.delivered || null,
      truck, cases: order.values ? order.values.cases : null, pallets: order.values ? order.values.pallets : null,
      lot: order.values ? order.values.lot : '',
      collectionOverdue: flags.collectionOverdue || null, deliveryOverdue: flags.deliveryOverdue || null,
      collectedLate: flags.collectedLate || null, deliveredLate: flags.deliveredLate || null,
      isOpen: order.isOpen !== false,
    };
  }

  Object.assign(AMI, {
    WORK_PATH, STAGE_TASKS, SEVERITIES, SEVERITY_RANK, OPEN_EXCEPTION, RESOLUTIONS, ROOT_CAUSES, MANUAL_TYPES,
    emptyWorkDoc, loadWork, saveWork, mergeWorkDocs, logActivity, activityFor,
    workStage, tasksFor, setTaskDone, setTaskField, addCustomTask, removeCustomTask,
    detectExceptions, exceptionsFor, isOpenException, setExceptionState, raiseException,
    shipmentLine, isoDay, parseIso,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
