/* AMI Order Desk — user interface.
 * Depends on engine.js (global `AMI`). No network access of any kind.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  let toastTimer = null;
  function toast(message, kind) {
    const existing = $('.toast');
    if (existing) existing.remove();
    const t = el('div', { class: 'toast ' + (kind || ''), text: message });
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 5200);
  }

  function download(bytes, name, mime) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + p(d.getMinutes());
  }

  const SOURCE_LABEL = {
    pdf: 'from PO',
    computed: 'computed',
    formula: 'formula',
    carried: 'carried',
    manual: 'blank',
    edited: 'edited',
  };

  function sourceChip(source) {
    return el('span', { class: 'chip ' + source, text: SOURCE_LABEL[source] || source });
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  const DEFAULT_BODY = [
    '<p>Dear {{vendorContact}},</p>',
    '<p>Please find attached {{poCount}} new purchase order(s) for the item {{product}}, {{size}} for the program with {{customer}}.</p>',
    '<p>I am detailing a breakdown of the orders below, for your reference:</p>',
    '{{table}}',
    '<p>Please note the following:</p>',
    '<ul>',
    '  <li>Please confirm the above orders with your proforma and fill out the expiration date on the above chart</li>',
    '  <li>Please note all the requirements outlined in the body of the order:',
    '    <ul>',
    '      <li>Please pack in cases with Standard case marking (name, content and size of product, country of origin) &ndash; please indicate EAN code on the cases as well</li>',
    '      <li>PLEASE PUT A PALLET TAG WITH PO NUMBER ON THE PALLETS</li>',
    '      <li>PALLETS NOT TO BE HIGHER THAN 160 CM FOR AIRFREIGHT</li>',
    '    </ul>',
    '  </li>',
    '  <li>Please note that we require the following documents to be sent to {{docsEmail}}, as we are a paperless company:',
    '    <ul>',
    '      <li>To be received prior to the departure of the load from your warehouse:',
    '        <ul>',
    '          <li>Your Proforma</li>',
    '          <li>HD pictures of the cases and pallets</li>',
    '          <li>Packing list, outlining the total number of pallets and full weight of the order and final delivery address</li>',
    '        </ul>',
    '      </li>',
    '      <li>To be received on the day of departure or a day after departure:',
    '        <ul><li>EAD/CMR</li><li>Your invoice</li></ul>',
    '      </li>',
    '    </ul>',
    '  </li>',
    '</ul>',
    '<p>FOR FINAL DELIVERY TO:<br>{{finalDelivery}}</p>',
    '<p>Please do not make any alterations to the order, prior to advising and receiving confirmation from AMI Wines LLC.</p>',
    '<p>Please DO NOT forward any invoice or documents containing price to our trucker. We will inform on the name of our assigned trucker for collection as soon as we have it.</p>',
    '<p>Thank you and kind regards,</p>',
    '{{signature}}',
  ].join('\n');

  const DEFAULT_CHASE_BODY = [
    '<p>Dear {{recipientName}},</p>',
    '<p>Following up on the order(s) below. Our tracker still shows the item outstanding &mdash; could you confirm at your earliest convenience?</p>',
    '{{table}}',
    '<p>Thank you and kind regards,</p>',
    '{{signature}}',
  ].join('\n');

  const DEFAULTS = {
    senderName: '',
    senderEmail: '',
    signature: '',
    defaultCc: '',
    forwarderName: '',
    forwarderEmail: '',
    subjectTemplate: 'AMI Wines for {{customer}} - {{poCount}} new Purchase Orders {{poGroups}} - {{product}}',
    bodyTemplate: DEFAULT_BODY,
    chaseSubjectTemplate: '{{customer}} / {{product}} - {{topic}} - PO {{poList}}',
    chaseBodyTemplate: DEFAULT_CHASE_BODY,
    attachPdfs: true,
  };

  const STORE_KEY = 'ami-order-desk.settings.v1';
  let memoryStore = null;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) { /* file:// or private mode — fall back to memory */ }
    return Object.assign({}, DEFAULTS, memoryStore || {});
  }

  function saveSettings(s) {
    memoryStore = s;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* memory only */ }
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const state = {
    dirHandle: null,
    fileHandle: null,
    trackerName: '',
    trackerBytes: null,
    sheetName: '',
    sheetNames: [],
    preview: null,          // { wb, sheet, header, config } including pending rows
    base: null,             // { wb, sheet, header, config } as loaded from disk
    pos: [],                // { id, fileName, bytes, po, include, overrides, plan, issues }
    emailRows: {},          // poNumber -> { bottling, bottlingDate, expiry }
    openItems: [],
    selectedItems: new Set(),
    settings: loadSettings(),
    posted: false,
  };

  let nextId = 1;

  function poColumn(header) {
    const c = header.columns.find((x) => /^PO\s*#/i.test(x.header));
    return c ? c.col : 'A';
  }

  /* ------------------------------------------------------------------ *
   * Tab navigation
   * ------------------------------------------------------------------ */

  function showTab(name) {
    $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('section.panel').forEach((s) => { s.hidden = s.dataset.panel !== name; });
    if (name === 'followups') renderFollowUps();
    if (name === 'email') renderEmail();
    window.scrollTo({ top: 0 });
  }

  function refreshTabAvailability() {
    const hasTracker = !!state.trackerBytes;
    const hasPos = state.pos.some((p) => p.include && p.po);
    $$('nav.tabs button').forEach((b) => {
      const t = b.dataset.tab;
      if (t === 'tracker' || t === 'settings') return;
      if (t === 'intake') b.disabled = !hasTracker;
      else if (t === 'followups') b.disabled = !hasTracker;
      else b.disabled = !hasTracker || !hasPos;
    });
  }

  /* ------------------------------------------------------------------ *
   * Tracker loading
   * ------------------------------------------------------------------ */

  const FS_AVAILABLE = typeof window.showOpenFilePicker === 'function';

  async function loadTrackerBytes(bytes, name) {
    state.trackerBytes = bytes;
    state.trackerName = name;
    state.posted = false;

    const wb = await AMI.Workbook.load(bytes);
    state.sheetNames = wb.sheets.map((s) => s.name);

    // Default to the last sheet that carries an order log.
    let chosen = '';
    for (const s of wb.sheets) if (AMI.findHeaderRow(s)) chosen = s.name;
    if (!chosen) throw new Error('No sheet in this workbook has a "PO#" header row.');
    state.sheetName = chosen;

    await rebuildPlans();
    renderTracker();
    refreshTabAvailability();
    toast('Loaded ' + name + ' — sheet "' + state.sheetName + '"', 'ok');
  }

  async function openViaFolder() {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const candidates = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && /\.xlsx?m?$/i.test(name) && !name.startsWith('~$')) {
          candidates.push({ name, handle });
        }
      }
      if (!candidates.length) { toast('No .xlsx files found in that folder.', 'error'); return; }
      const pick = candidates.length === 1 ? candidates[0] : await chooseFromList(candidates);
      if (!pick) return;
      state.dirHandle = dir;
      state.fileHandle = pick.handle;
      const file = await pick.handle.getFile();
      await loadTrackerBytes(new Uint8Array(await file.arrayBuffer()), pick.name);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Could not open that folder: ' + e.message, 'error');
    }
  }

  function chooseFromList(candidates) {
    return new Promise((resolve) => {
      const host = $('#trackerPicker');
      clear(host).appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'Which workbook is the tracker?' }),
        el('div', { class: 'body' }, [
          el('div', { class: 'btn-row' }, candidates.map((c) => el('button', {
            class: 'btn', text: c.name, onclick: () => { clear(host); resolve(c); },
          }))),
          el('div', { class: 'btn-row' }, [
            el('button', { class: 'btn small', text: 'Cancel', onclick: () => { clear(host); resolve(null); } }),
          ]),
        ]),
      ]));
    });
  }

  async function openViaFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'] } }],
      });
      state.fileHandle = handle;
      state.dirHandle = null;
      const file = await handle.getFile();
      await loadTrackerBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Could not open that file: ' + e.message, 'error');
    }
  }

  async function openViaInput(file) {
    state.fileHandle = null;
    state.dirHandle = null;
    try {
      await loadTrackerBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * Planning
   * ------------------------------------------------------------------ */

  function applyOverrides(plan, overrides) {
    if (!overrides) return plan;
    for (const f of plan.fields) {
      if (!(f.col in overrides)) continue;
      const raw = overrides[f.col];
      if (raw === '' || raw == null) { f.value = null; f.source = AMI.SOURCE.MANUAL; f.note = 'Cleared by you'; continue; }
      if (f.kind === 'date') {
        const d = AMI.parseDate(raw);
        f.value = d || null;
      } else if (f.kind === 'number') {
        const n = AMI.parseNumber(raw);
        f.value = n;
      } else {
        f.value = raw;
      }
      f.source = 'edited';
      f.note = 'Typed in by you';
    }
    return plan;
  }

  async function rebuildPlans() {
    if (!state.trackerBytes) return;

    const baseWb = await AMI.Workbook.load(state.trackerBytes);
    const baseSheet = baseWb.sheet(state.sheetName);
    const baseHeader = AMI.findHeaderRow(baseSheet);
    state.base = { wb: baseWb, sheet: baseSheet, header: baseHeader, config: AMI.readSheetConfig(baseSheet) };

    const wb = await AMI.Workbook.load(state.trackerBytes);
    const sheet = wb.sheet(state.sheetName);
    const header = AMI.findHeaderRow(sheet);
    const config = AMI.readSheetConfig(sheet);
    const poCol = poColumn(header);

    for (const item of state.pos) {
      item.plan = null;
      item.issues = [];
      if (!item.include || !item.po) continue;

      const existing = new Set(AMI.dataRows(sheet, header).map((r) => sheet.cellText(r, poCol).trim()));
      let plan = AMI.planRow(sheet, header, config, item.po);
      applyOverrides(plan, item.overrides);
      plan = AMI.computePlanFormulas(sheet, plan);
      const issues = AMI.validatePlan(sheet, header, config, plan, item.po, existing);
      item.plan = plan;
      item.issues = issues;

      // Stage the row so the next PO sees the updated balance and row number.
      if (!issues.some((i) => i.level === 'error')) {
        AMI.appendRow(sheet, AMI.renderRowXml(plan), plan.newRow);
        wb.commitSheet(sheet);
      }
    }

    state.preview = { wb, sheet, header, config };
  }

  /* ------------------------------------------------------------------ *
   * Rendering: tracker panel
   * ------------------------------------------------------------------ */

  function renderTracker() {
    const host = $('#trackerInfo');
    clear(host);
    if (!state.base) {
      host.appendChild(el('div', { class: 'empty', text: 'No tracker loaded yet.' }));
      return;
    }
    const { sheet, header, config } = state.base;
    const rows = AMI.dataRows(sheet, header);
    const poCol = poColumn(header);
    const lastRow = rows[rows.length - 1];
    const lastPo = lastRow ? sheet.cellText(lastRow, poCol) : '—';

    const balCol = header.columns.find((c) => /Balance on Contract\s*\(bt\)/i.test(c.header));
    const balCell = balCol && lastRow ? sheet.cell(lastRow, balCol.col) : null;
    const balance = balCell && balCell.num != null ? balCell.num : null;

    const writeMode = state.fileHandle
      ? 'Saves straight back into ' + state.trackerName
      : 'Downloads an updated copy for you to save over the original';

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode(state.trackerName),
        el('span', { class: 'spacer' }),
        el('span', { class: 'chip ' + (state.fileHandle ? 'ok' : 'carried'), text: state.fileHandle ? 'in-place save' : 'download mode' }),
      ]),
      el('div', { class: 'status-strip' }, [
        el('span', {}, [document.createTextNode('Sheet '), el('b', { text: state.sheetName })]),
        el('span', {}, [document.createTextNode('Orders logged '), el('b', { text: String(rows.length) })]),
        el('span', {}, [document.createTextNode('Last PO '), el('b', { text: lastPo })]),
        el('span', {}, [document.createTextNode('Next row '), el('b', { text: String((lastRow || header.row) + 1) })]),
        balance != null ? el('span', {}, [document.createTextNode('Contract balance '),
          el('b', { text: balance.toLocaleString() + ' bt' })]) : null,
      ]),
      el('div', { class: 'body' }, [
        el('p', { class: 'help', text: writeMode + '. A backup is always made first.' }),
        state.sheetNames.length > 1 ? el('label', { class: 'field' }, [
          el('span', { text: 'Sheet to post new orders into' }),
          el('select', {
            onchange: async (e) => {
              state.sheetName = e.target.value;
              await rebuildPlans();
              renderTracker();
              renderReview();
            },
          }, state.sheetNames.map((n) => el('option', { value: n, selected: n === state.sheetName, text: n }))),
        ]) : null,
        el('h3', { text: 'Product and logistics constants read from this sheet' }),
        el('p', { class: 'help', text: 'These drive the quantity and date maths. They come from the tracker, never from the PO.' }),
        el('dl', { class: 'kv' }, [
          ['Product', config.productName],
          ['Customer', config.customer],
          ['NAV code', config.navCode],
          ['Case size', config.caseSize],
          ['Bottles per case', config.bottlesPerCase],
          ['Cases per pallet', config.casesPerPallet],
          ['Production lead time', config.leadTimeDays != null ? config.leadTimeDays + ' days' : ''],
          ['Road/water transit', config.transitDays != null ? config.transitDays + ' days' : ''],
          ['Supplier', config.supplier],
          ['Winery closed', config.wineryClosedDates],
        ].filter((r) => r[1] !== '' && r[1] != null).flatMap((r) => [
          el('dt', { text: r[0] }), el('dd', { text: String(r[1]) }),
        ])),
      ]),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Rendering: intake panel
   * ------------------------------------------------------------------ */

  async function addPdfs(files) {
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { toast('Skipped ' + file.name + ' — not a PDF.', 'error'); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let po = null;
      let error = '';
      try {
        const pages = await AMI.extractPdfPages(bytes);
        po = AMI.parsePurchaseOrder(pages, file.name);
        if (!po.poNumber && !po.lineItem) { error = 'No purchase-order fields could be read from this PDF.'; po = null; }
      } catch (e) {
        error = 'Could not read this PDF: ' + e.message;
      }
      state.pos.push({
        id: nextId++, fileName: file.name, bytes, po, error,
        include: !!po, overrides: {}, plan: null, issues: [],
      });
    }
    await rebuildPlans();
    renderIntake();
    renderReview();
    refreshTabAvailability();
  }

  function renderIntake() {
    const host = $('#poList');
    clear(host);
    if (!state.pos.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No purchase orders loaded. Drop the PDFs above.' }));
      return;
    }

    for (const item of state.pos) {
      const po = item.po;
      const card = el('div', { class: 'po-card' + (item.include ? '' : ' excluded') });

      card.appendChild(el('header', {}, [
        el('input', {
          type: 'checkbox', checked: item.include, title: 'Include this order',
          onchange: async (e) => {
            item.include = e.target.checked;
            await rebuildPlans();
            renderIntake(); renderReview(); refreshTabAvailability();
          },
        }),
        el('span', { class: 'po-id', text: po ? (po.poNumber || '(no PO number)') : 'Unreadable' }),
        el('span', { class: 'file', text: item.fileName }),
        el('span', { class: 'spacer' }),
        po && po.warnings.length ? el('span', { class: 'chip carried', text: po.warnings.length + ' note' + (po.warnings.length > 1 ? 's' : '') }) : null,
        el('button', {
          class: 'btn small', text: 'Remove',
          onclick: async () => {
            state.pos = state.pos.filter((p) => p !== item);
            await rebuildPlans();
            renderIntake(); renderReview(); refreshTabAvailability();
          },
        }),
      ]));

      const body = el('div', { class: 'body' });
      if (item.error) {
        body.appendChild(el('div', { class: 'msg error' }, [
          el('span', { class: 'icon', text: '!' }), el('div', { text: item.error }),
        ]));
      }

      if (po) {
        const money = (n) => (n == null ? '' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        body.appendChild(el('dl', { class: 'kv' }, [
          ['Order no.', po.poNumber],
          ['Order date', AMI.formatShort(po.orderDate)],
          ['Pickup date', AMI.formatShort(po.pickupDate)],
          ['Delivery date', AMI.formatShort(po.deliveryDate) || '(blank on PO)'],
          ['Item', po.itemNo + (po.description ? ' — ' + po.description : '')],
          ['Size', po.size],
          ['Quantity', po.qty != null ? po.qty + ' ' + po.uom : ''],
          ['Unit price', money(po.unitPrice) + (po.currency ? ' ' + po.currency : '')],
          ['Extended', money(po.extAmount) + (po.currency ? ' ' + po.currency : '')],
          ['Vendor', po.vendorName],
          ['Vendor contact', po.vendorContact + (po.vendorEmail ? ' <' + po.vendorEmail + '>' : '')],
          ['Shipping agent', po.shippingAgent],
          ['Terms', po.terms],
          ['Entered by', po.enteredBy],
          ['Confirm to', po.confirmTo],
          ['Documents to', po.docsTo],
        ].filter((r) => r[1] !== '' && r[1] != null).flatMap((r) => [
          el('dt', { text: r[0] }), el('dd', { text: String(r[1]) }),
        ])));

        for (const w of po.warnings) {
          body.appendChild(el('div', { class: 'msg warn' }, [
            el('span', { class: 'icon', text: '!' }), el('div', { text: w }),
          ]));
        }

        body.appendChild(el('details', { class: 'raw' }, [
          el('summary', { text: 'Show the raw text this was read from' }),
          el('pre', { text: po.fullText }),
        ]));
      }

      card.appendChild(body);
      host.appendChild(card);
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering: review panel
   * ------------------------------------------------------------------ */

  function fieldValueText(f) {
    const v = f.source === AMI.SOURCE.FORMULA ? f.computedValue : f.value;
    if (v == null || v === '') return '';
    if (v instanceof Date) return AMI.formatShort(v);
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    return String(v);
  }

  function renderReview() {
    const host = $('#reviewList');
    clear(host);
    const included = state.pos.filter((p) => p.include && p.po);

    if (!included.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No orders selected. Load purchase orders first.' }));
      $('#postBar').hidden = true;
      return;
    }

    let errorCount = 0;
    for (const item of included) {
      const plan = item.plan;
      if (!plan) continue;
      errorCount += item.issues.filter((i) => i.level === 'error').length;

      const card = el('div', { class: 'po-card' });
      const effectivePo = AMI.planPoNumber(plan, item.po);
      card.appendChild(el('header', {}, [
        el('span', { class: 'po-id', text: effectivePo }),
        el('span', { class: 'file', text: 'row ' + plan.newRow }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'chip ' + (item.issues.some((i) => i.level === 'error') ? 'error' : 'ok'),
          text: item.issues.some((i) => i.level === 'error') ? 'blocked' : 'ready' }),
      ]));

      const body = el('div', { class: 'body' });

      for (const issue of item.issues) {
        body.appendChild(el('div', { class: 'msg ' + issue.level }, [
          el('span', { class: 'icon', text: issue.level === 'error' ? '!' : issue.level === 'warn' ? '!' : 'i' }),
          el('div', {}, [
            el('strong', { text: issue.message }),
            issue.detail ? el('span', { class: 'detail', text: issue.detail }) : null,
          ]),
        ]));
      }

      for (const f of plan.fields) {
        const isManual = f.source === AMI.SOURCE.MANUAL;
        const row = el('div', { class: 'fieldrow' + (isManual ? ' is-manual' : '') });
        row.appendChild(el('div', { class: 'hdr', text: f.header }));

        if (f.source === AMI.SOURCE.FORMULA) {
          row.appendChild(el('div', { class: 'val-static', text: fieldValueText(f) || '—' }));
        } else {
          const input = el('input', {
            type: f.kind === 'date' ? 'date' : 'text',
            value: f.kind === 'date'
              ? (f.value instanceof Date ? AMI.formatISO(f.value) : '')
              : (f.value == null ? '' : String(f.value)),
            placeholder: isManual ? 'blank' : '',
            onchange: async (e) => {
              item.overrides[f.col] = e.target.value;
              await rebuildPlans();
              renderReview();
            },
          });
          row.appendChild(input);
        }

        row.appendChild(sourceChip(f.source));
        row.appendChild(el('div', { class: 'note', text: f.note }));
        body.appendChild(row);
      }

      card.appendChild(body);
      host.appendChild(card);
    }

    const bar = $('#postBar');
    bar.hidden = false;
    clear(bar).appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'body' }, [
        errorCount
          ? el('div', { class: 'msg error' }, [el('span', { class: 'icon', text: '!' }),
            el('div', { text: errorCount + ' problem(s) must be resolved before anything is written.' })])
          : el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }),
            el('div', { text: included.length + ' row(s) ready to append to "' + state.sheetName + '". Formulas, styles, comments and every other sheet are preserved.' })]),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', disabled: errorCount > 0 || state.posted,
            text: state.posted ? 'Posted' : 'Post ' + included.length + ' order(s) to the tracker',
            onclick: postToTracker,
          }),
          el('button', { class: 'btn', text: 'Download a backup of the tracker first', onclick: downloadBackup }),
        ]),
      ]),
    ]));
  }

  function downloadBackup() {
    if (!state.trackerBytes) return;
    const base = state.trackerName.replace(/\.xlsx?m?$/i, '');
    download(state.trackerBytes, base + ' (backup ' + stamp() + ').xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast('Backup downloaded.', 'ok');
  }

  async function postToTracker() {
    if (!state.preview) return;
    const included = state.pos.filter((p) => p.include && p.po && p.plan);
    if (!included.length) return;

    try {
      const base = state.trackerName.replace(/\.xlsx?m?$/i, '');
      const backupName = base + ' (backup ' + stamp() + ').xlsx';

      // Always take a backup before touching anything.
      if (state.dirHandle) {
        const bh = await state.dirHandle.getFileHandle(backupName, { create: true });
        const bw = await bh.createWritable();
        await bw.write(state.trackerBytes);
        await bw.close();
      } else {
        download(state.trackerBytes, backupName,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }

      state.preview.wb.dropCalcChain();
      const out = await state.preview.wb.toBytes();

      if (state.fileHandle) {
        const perm = await state.fileHandle.requestPermission
          ? await state.fileHandle.requestPermission({ mode: 'readwrite' }) : 'granted';
        if (perm !== 'granted') throw new Error('Write permission was declined.');
        const w = await state.fileHandle.createWritable();
        await w.write(out);
        await w.close();
        toast('Wrote ' + included.length + ' row(s) into ' + state.trackerName + '. Backup saved alongside it.', 'ok');
      } else {
        download(out, state.trackerName,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        toast('Updated workbook downloaded — save it over the original.', 'ok');
      }

      state.trackerBytes = out;
      state.posted = true;
      await rebuildPlans();
      renderTracker();
      renderReview();
      showTab('email');
    } catch (e) {
      toast('Nothing was written: ' + e.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering: vendor email
   * ------------------------------------------------------------------ */

  function twoDp(n) {
    if (n == null || !Number.isFinite(n)) return '';
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function emailContext() {
    const included = state.pos.filter((p) => p.include && p.po);
    const first = included.length ? included[0].po : null;
    const config = state.preview ? state.preview.config : {};
    const s = state.settings;

    const rows = included.map((item) => {
      const po = item.po;
      const plan = item.plan;
      const poNo = plan ? AMI.planPoNumber(plan, po) : po.poNumber;
      const extra = state.emailRows[poNo] || {};
      const collection = plan
        ? (plan.fields.find((f) => /AMI Requested\s+Collection Date/i.test(f.header)) || {})
        : {};
      const collectionDate = collection.source === AMI.SOURCE.FORMULA ? collection.computedValue : collection.value;
      const bottles = plan ? plan.derived.bottles : null;
      const pallets = plan ? plan.derived.pallets : null;
      return {
        po: poNo,
        bt: twoDp(bottles),
        cs: twoDp(po.qty),
        pal: twoDp(pallets),
        bottling: extra.bottling || '',
        bottlingDate: extra.bottlingDate || '',
        expiry: extra.expiry || '',
        collection: AMI.formatEmailDate(collectionDate || po.pickupDate),
      };
    });

    const vars = {
      vendorContact: first ? (first.vendorContact || first.vendorName) : '',
      customer: config.customer || '',
      product: first ? first.description : (config.productName || ''),
      size: first ? first.size : (config.caseSize || ''),
      poCount: included.length,
      poGroups: AMI.poGroups(rows.map((r) => r.po)),
      poList: rows.map((r) => r.po).join(', '),
      docsEmail: first ? first.docsTo : '',
      finalDelivery: first ? first.finalDeliveryTo.join('<br>') : '',
      table: AMI.orderTableHtml(rows),
      signature: s.signature || '',
    };

    return { included, first, rows, vars };
  }

  function renderEmail() {
    const host = $('#emailPanelBody');
    clear(host);
    const { included, first, rows, vars } = emailContext();

    if (!included.length || !first) {
      host.appendChild(el('div', { class: 'empty', text: 'Load purchase orders first — the email is built from them.' }));
      return;
    }

    const s = state.settings;
    const to = first.vendorContact
      ? first.vendorContact + ' <' + first.vendorEmail + '>'
      : first.vendorEmail;
    const cc = [first.docsTo, s.defaultCc].filter(Boolean).join(', ');

    const toInput = el('input', { type: 'text', value: to });
    const ccInput = el('input', { type: 'text', value: cc });
    const subjInput = el('input', { type: 'text', value: AMI.fillTemplate(s.subjectTemplate, vars) });

    host.appendChild(el('div', { class: 'grid-2' }, [
      el('label', { class: 'field' }, [el('span', { text: 'To (read from the PO vendor block)' }), toInput]),
      el('label', { class: 'field' }, [el('span', { text: 'Cc' }), ccInput]),
    ]));
    host.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Subject' }), subjInput]));

    host.appendChild(el('h3', { text: 'Order breakdown table' }));
    host.appendChild(el('p', { class: 'help', text: 'Quantities and collection dates come from the POs and the tracker. Bottling and expiration are left blank because the winery supplies them — fill them in only if you already know.' }));

    const tbl = el('table', { class: 'data' });
    tbl.appendChild(el('thead', {}, [el('tr', {}, AMI.TABLE_COLUMNS.map((c) => el('th', { text: c.label })))]));
    const tbody = el('tbody');
    for (const r of rows) {
      const item = included.find((i) => i.po.poNumber === r.po);
      const editable = (key) => el('input', {
        type: 'text', value: r[key],
        onchange: (e) => {
          state.emailRows[r.po] = Object.assign({}, state.emailRows[r.po], { [key]: e.target.value });
          renderEmail();
        },
      });
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'mono', text: r.po }),
        el('td', { class: 'num', text: r.bt }),
        el('td', { class: 'num', text: r.cs }),
        el('td', { class: 'num', text: r.pal }),
        el('td', {}, [editable('bottling')]),
        el('td', {}, [editable('bottlingDate')]),
        el('td', {}, [editable('expiry')]),
        el('td', { text: r.collection }),
      ]));
    }
    tbl.appendChild(tbody);
    host.appendChild(el('div', { class: 'table-scroll' }, [tbl]));

    host.appendChild(el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn small', text: 'Set bottling & expiration to "Please advise"',
        onclick: () => {
          for (const r of rows) {
            state.emailRows[r.po] = Object.assign({}, state.emailRows[r.po],
              { bottlingDate: 'Please advise', expiry: 'Please advise' });
          }
          renderEmail();
        },
      }),
      el('button', {
        class: 'btn small', text: 'Clear those columns',
        onclick: () => {
          for (const r of rows) {
            state.emailRows[r.po] = Object.assign({}, state.emailRows[r.po],
              { bottling: '', bottlingDate: '', expiry: '' });
          }
          renderEmail();
        },
      }),
    ]));

    host.appendChild(el('h3', { text: 'Preview' }));
    const html = AMI.fillTemplate(s.bodyTemplate, vars);
    host.appendChild(el('div', { class: 'email-preview', html }));

    const attachBox = el('input', { type: 'checkbox', checked: s.attachPdfs });
    host.appendChild(el('div', { class: 'btn-row' }, [
      el('label', { style: 'display:flex;align-items:center;gap:7px;font-size:13px;' }, [
        attachBox, document.createTextNode('Attach the ' + included.length + ' PO PDF(s)'),
      ]),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn', text: 'Copy body to clipboard',
        onclick: async () => {
          try {
            const blob = new Blob([html], { type: 'text/html' });
            await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
            toast('Body copied — paste into a new Outlook message.', 'ok');
          } catch (e) {
            toast('Clipboard blocked here; use the .eml download instead.', 'error');
          }
        },
      }),
      el('button', {
        class: 'btn primary', text: 'Download Outlook draft (.eml)',
        onclick: () => {
          const eml = AMI.buildEml({
            from: s.senderEmail ? (s.senderName ? s.senderName + ' <' + s.senderEmail + '>' : s.senderEmail) : '',
            to: toInput.value,
            cc: ccInput.value,
            subject: subjInput.value,
            html: '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + html + '</body></html>',
            attachments: attachBox.checked ? included.map((i) => ({
              name: i.fileName, mime: 'application/pdf', bytes: i.bytes,
            })) : [],
          });
          const name = 'PO ' + vars.poGroups + ' — ' + (vars.customer || 'order') + '.eml';
          download(new Blob([eml], { type: 'message/rfc822' }), name.replace(/[\\/:*?"<>|]/g, '-'));
          toast('Draft saved. Double-click it to open in Outlook.', 'ok');
        },
      }),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Rendering: follow-ups
   * ------------------------------------------------------------------ */

  const PARTY_LABEL = { winery: 'Winery', forwarder: 'Forwarder', internal: 'Internal' };

  function renderFollowUps() {
    const host = $('#followBody');
    clear(host);
    if (!state.base) {
      host.appendChild(el('div', { class: 'empty', text: 'Load the tracker first.' }));
      return;
    }

    const { sheet, header } = state.base;
    state.openItems = AMI.findOpenItems(sheet, header, new Date());

    host.appendChild(el('p', { class: 'help', text: 'Every row below is an order where a tracker column is still empty past its normal turnaround. Nothing here is inferred — each line names the blank column and the dated column it is measured from.' }));

    if (!state.openItems.length) {
      host.appendChild(el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }),
        el('div', { text: 'Nothing outstanding.' })]));
      return;
    }

    const byParty = {};
    for (const item of state.openItems) (byParty[item.party] = byParty[item.party] || []).push(item);

    for (const party of Object.keys(byParty)) {
      const items = byParty[party];
      const tbl = el('table', { class: 'data' });
      tbl.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', {}), el('th', { text: 'PO' }), el('th', { text: 'Outstanding' }),
        el('th', { text: 'Measured from' }), el('th', { text: 'Age' }),
      ])]));
      const tbody = el('tbody');
      for (const item of items) {
        const key = item.row + ':' + item.ruleId;
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [el('input', {
            type: 'checkbox', checked: state.selectedItems.has(key),
            onchange: (e) => { if (e.target.checked) state.selectedItems.add(key); else state.selectedItems.delete(key); },
          })]),
          el('td', { class: 'mono', text: item.po }),
          el('td', { text: item.missingHeader + (item.placeholder ? ' (" ' + item.placeholder + '")' : '') }),
          el('td', { text: item.anchorHeader + ': ' + AMI.formatShort(item.anchorDate) }),
          el('td', { class: 'num', text: item.ageDays + ' d' }),
        ]));
      }
      tbl.appendChild(tbody);

      host.appendChild(el('div', { class: 'card' }, [
        el('h2', {}, [
          document.createTextNode(PARTY_LABEL[party] || party),
          el('span', { class: 'spacer' }),
          el('span', { class: 'chip manual', text: items.length + ' open' }),
        ]),
        el('div', { class: 'body' }, [
          el('div', { class: 'table-scroll' }, [tbl]),
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: 'btn small', text: 'Select all',
              onclick: () => { for (const i of items) state.selectedItems.add(i.row + ':' + i.ruleId); renderFollowUps(); },
            }),
            el('span', { class: 'spacer' }),
            el('button', {
              class: 'btn primary', text: 'Draft chase email for selected',
              onclick: () => buildChaseEmail(party, items),
            }),
          ]),
        ]),
      ]));
    }
  }

  function buildChaseEmail(party, items) {
    const chosen = items.filter((i) => state.selectedItems.has(i.row + ':' + i.ruleId));
    if (!chosen.length) { toast('Nothing selected in that group.', 'error'); return; }

    const s = state.settings;
    const config = state.base.config;
    const lastPo = state.pos.filter((p) => p.po).slice(-1)[0];
    const recipient = party === 'forwarder'
      ? (s.forwarderEmail || '')
      : (lastPo && lastPo.po ? lastPo.po.vendorEmail : '');
    const recipientName = party === 'forwarder'
      ? (s.forwarderName || '')
      : (lastPo && lastPo.po ? lastPo.po.vendorContact : '');

    const rowsHtml = ['<table style="border-collapse:collapse;margin:12px 0;">',
      '<thead><tr>',
      ['PO #', 'Outstanding', 'Reference'].map((h) =>
        '<th style="border:1px solid #999;padding:4px 8px;background:#f2f2f2;text-align:left;'
        + 'font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + h + '</th>').join(''),
      '</tr></thead><tbody>',
      chosen.map((i) => '<tr>' + [
        i.po, i.missingHeader, i.anchorHeader + ': ' + AMI.formatShort(i.anchorDate),
      ].map((v) => '<td style="border:1px solid #999;padding:4px 8px;'
        + 'font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + AMI.escapeXml(v) + '</td>').join('') + '</tr>').join(''),
      '</tbody></table>'].join('');

    const topics = [];
    for (const i of chosen) if (!topics.includes(i.subject)) topics.push(i.subject);

    const vars = {
      recipientName: recipientName || '',
      customer: config.customer || '',
      product: config.productName || '',
      topic: topics.join(' / '),
      poList: [...new Set(chosen.map((i) => i.po))].join(', '),
      table: rowsHtml,
      signature: s.signature || '',
    };

    const html = AMI.fillTemplate(s.chaseBodyTemplate, vars);
    const eml = AMI.buildEml({
      from: s.senderEmail ? (s.senderName ? s.senderName + ' <' + s.senderEmail + '>' : s.senderEmail) : '',
      to: recipientName && recipient ? recipientName + ' <' + recipient + '>' : recipient,
      cc: s.defaultCc || '',
      subject: AMI.fillTemplate(s.chaseSubjectTemplate, vars),
      html: '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + html + '</body></html>',
    });
    download(new Blob([eml], { type: 'message/rfc822' }),
      ('Follow-up ' + (PARTY_LABEL[party] || party) + ' ' + stamp() + '.eml').replace(/[\\/:*?"<>|]/g, '-'));
    toast('Chase draft saved for ' + chosen.length + ' item(s).', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Rendering: settings
   * ------------------------------------------------------------------ */

  function renderSettings() {
    const host = $('#settingsBody');
    clear(host);
    const s = state.settings;

    const bind = (key, label, type, help) => {
      const input = type === 'textarea'
        ? el('textarea', { rows: key === 'signature' ? 6 : 16 })
        : el('input', { type: 'text' });
      input.value = s[key] || '';
      input.addEventListener('change', () => {
        s[key] = input.value;
        saveSettings(s);
        toast('Saved.', 'ok');
      });
      return el('label', { class: 'field' }, [
        el('span', { text: label }),
        input,
        help ? el('div', { class: 'note', style: 'font-size:11.5px;color:var(--faint);margin-top:3px;', text: help }) : null,
      ]);
    };

    host.appendChild(el('h3', { text: 'You' }));
    host.appendChild(el('div', { class: 'grid-2' }, [
      bind('senderName', 'Your name', 'text'),
      bind('senderEmail', 'Your email address', 'text'),
    ]));
    host.appendChild(bind('signature', 'Email signature (HTML)', 'textarea',
      'Paste your Outlook signature here once. It is inserted wherever a template contains {{signature}}.'));

    host.appendChild(el('h3', { text: 'Standing recipients' }));
    host.appendChild(el('div', { class: 'grid-2' }, [
      bind('defaultCc', 'Always Cc', 'text', 'Added to every draft in addition to the address on the PO.'),
      bind('forwarderName', 'Forwarder contact name', 'text'),
      bind('forwarderEmail', 'Forwarder email', 'text', 'Used for forwarder chase emails.'),
    ]));

    host.appendChild(el('h3', { text: 'Templates' }));
    host.appendChild(el('p', { class: 'help', text: 'Placeholders in double braces are filled from the PO and the tracker. Available: {{vendorContact}} {{customer}} {{product}} {{size}} {{poCount}} {{poGroups}} {{poList}} {{docsEmail}} {{finalDelivery}} {{table}} {{signature}}' }));
    host.appendChild(bind('subjectTemplate', 'Order email — subject', 'text'));
    host.appendChild(bind('bodyTemplate', 'Order email — body (HTML)', 'textarea'));
    host.appendChild(bind('chaseSubjectTemplate', 'Follow-up email — subject', 'text'));
    host.appendChild(bind('chaseBodyTemplate', 'Follow-up email — body (HTML)', 'textarea'));

    host.appendChild(el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn', text: 'Export settings',
        onclick: () => download(new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }),
          'ami-order-desk-settings.json'),
      }),
      el('button', {
        class: 'btn', text: 'Import settings',
        onclick: () => {
          const inp = el('input', { type: 'file', accept: '.json' });
          inp.addEventListener('change', async () => {
            try {
              const parsed = JSON.parse(await inp.files[0].text());
              state.settings = Object.assign({}, DEFAULTS, parsed);
              saveSettings(state.settings);
              renderSettings();
              toast('Settings imported.', 'ok');
            } catch (e) { toast('That file could not be read.', 'error'); }
          });
          inp.click();
        },
      }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn danger', text: 'Reset templates to default',
        onclick: () => {
          state.settings = Object.assign({}, state.settings, {
            subjectTemplate: DEFAULTS.subjectTemplate,
            bodyTemplate: DEFAULTS.bodyTemplate,
            chaseSubjectTemplate: DEFAULTS.chaseSubjectTemplate,
            chaseBodyTemplate: DEFAULTS.chaseBodyTemplate,
          });
          saveSettings(state.settings);
          renderSettings();
        },
      }),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function init() {
    $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

    const openFolderBtn = $('#openFolder');
    const openFileBtn = $('#openFile');
    if (!FS_AVAILABLE) {
      openFolderBtn.hidden = true;
      openFileBtn.hidden = true;
      $('#fsNote').hidden = false;
    } else {
      openFolderBtn.addEventListener('click', openViaFolder);
      openFileBtn.addEventListener('click', openViaFile);
    }

    const trackerInput = $('#trackerInput');
    $('#openUpload').addEventListener('click', () => trackerInput.click());
    trackerInput.addEventListener('change', () => {
      if (trackerInput.files[0]) openViaInput(trackerInput.files[0]);
    });

    const drop = $('#pdfDrop');
    const pdfInput = $('#pdfInput');
    drop.addEventListener('click', () => pdfInput.click());
    pdfInput.addEventListener('change', () => { if (pdfInput.files.length) addPdfs(Array.from(pdfInput.files)); pdfInput.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) addPdfs(Array.from(e.dataTransfer.files));
    });

    renderTracker();
    renderIntake();
    renderReview();
    renderSettings();
    refreshTabAvailability();
    showTab('tracker');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
