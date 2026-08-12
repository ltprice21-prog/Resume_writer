/* AMI Order Desk (Teams) — multi-account interface.
 * Depends on engine.js, templates.js and workspace.js (global `AMI`).
 * No network access of any kind.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ENC = new TextEncoder();
  const DEC = new TextDecoder('utf-8');

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

  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

  let toastTimer = null;
  function toast(message, kind) {
    const existing = $('.toast');
    if (existing) existing.remove();
    const t = el('div', { class: 'toast ' + (kind || ''), text: message });
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 5600);
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
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + p(d.getMinutes());
  }

  const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-');

  const SOURCE_LABEL = {
    pdf: 'from PO', computed: 'computed', formula: 'formula',
    carried: 'carried', manual: 'blank', edited: 'edited',
  };
  const sourceChip = (s) => el('span', { class: 'chip ' + s, text: SOURCE_LABEL[s] || s });

  /* ------------------------------------------------------------------ *
   * Stores
   * ------------------------------------------------------------------ */

  /** A store backed by a real folder the user picked (OneDrive / SharePoint sync). */
  function handleStore(root) {
    async function dirFor(parts, create) {
      let h = root;
      for (const p of parts) h = await h.getDirectoryHandle(p, { create: !!create });
      return h;
    }
    return {
      kind: 'folder',
      root,
      async read(path) {
        const parts = AMI.splitPath(path);
        const name = parts.pop();
        try {
          const d = await dirFor(parts, false);
          const fh = await d.getFileHandle(name);
          return new Uint8Array(await (await fh.getFile()).arrayBuffer());
        } catch (e) { return null; }
      },
      async write(path, bytes) {
        const parts = AMI.splitPath(path);
        const name = parts.pop();
        const d = await dirFor(parts, true);
        const fh = await d.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
      },
      async list(dir) {
        try {
          const d = await dirFor(AMI.splitPath(dir), false);
          const out = [];
          for await (const [name, h] of d.entries()) out.push({ name, kind: h.kind });
          return out;
        } catch (e) { return []; }
      },
      async remove(path) {
        const parts = AMI.splitPath(path);
        const name = parts.pop();
        const d = await dirFor(parts, false);
        await d.removeEntry(name);
      },
    };
  }

  /** Fallback store held in memory, seeded from an uploaded workspace bundle. */
  function memoryStore(seed) {
    const files = new Map(seed || []);
    return {
      kind: 'memory',
      files,
      async read(path) { return files.has(path) ? files.get(path) : null; },
      async write(path, bytes) { files.set(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); },
      async list(dir) {
        const prefix = dir ? dir.replace(/\/$/, '') + '/' : '';
        const seen = new Map();
        for (const key of files.keys()) {
          if (prefix && !key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          if (slash < 0) seen.set(rest, 'file');
          else seen.set(rest.slice(0, slash), 'directory');
        }
        return [...seen].map(([name, kind]) => ({ name, kind }));
      },
      async remove(path) { files.delete(path); },
    };
  }

  async function exportWorkspaceZip(store) {
    const entries = [];
    async function walk(dir) {
      for (const e of await store.list(dir)) {
        const path = dir ? dir + '/' + e.name : e.name;
        if (e.kind === 'directory') await walk(path);
        else {
          const bytes = await store.read(path);
          if (bytes) entries.push({ name: path, bytes });
        }
      }
    }
    await walk('');
    return AMI.zip(entries.filter((e) => /\.(json|html)$/i.test(e.name)));
  }

  async function importWorkspaceZip(bytes) {
    const entries = await AMI.unzip(bytes);
    return memoryStore(entries.map((e) => [e.name, e.bytes]));
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const LOCAL_KEY = 'ami-order-desk.teams.v1';

  const state = {
    store: null,
    workspace: null,
    loadedAt: '',
    userId: '',
    accountId: '',
    templates: [],
    // per-account order session
    trackerBytes: null,
    trackerPath: '',
    sheetName: '',
    base: null,
    preview: null,
    pos: [],
    emailRows: {},
    posted: false,
    selectedTemplateId: '',
    selectedRole: 'vendor',
    emailOverrides: {},
    openItems: [],
    selectedItems: new Set(),
  };

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveLocal(patch) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(Object.assign(loadLocal(), patch)));
    } catch (e) { /* memory only */ }
  }

  const currentUser = () => (state.workspace ? state.workspace.users.find((u) => u.id === state.userId) : null);
  const currentAccount = () => (state.workspace ? state.workspace.accounts.find((a) => a.id === state.accountId) : null);
  const visibleAccounts = () => (state.workspace && state.userId ? AMI.accountsForUser(state.workspace, state.userId) : []);

  function poColumn(header) {
    const c = header.columns.find((x) => /^PO\s*#/i.test(x.header));
    return c ? c.col : 'A';
  }

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  const RENDERERS = {
    workspace: () => renderWorkspace(),
    orders: () => renderIntake(),
    review: () => renderReview(),
    email: () => renderEmail(),
    followups: () => renderFollowUps(),
    templates: () => renderTemplates(),
    accounts: () => renderAccounts(),
  };

  function showTab(name) {
    $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('section.panel').forEach((s) => { s.hidden = s.dataset.panel !== name; });
    if (RENDERERS[name]) RENDERERS[name]();
    window.scrollTo({ top: 0 });
  }

  function refreshTabs() {
    const hasUser = !!currentUser();
    const hasAccount = !!currentAccount();
    const hasTracker = !!state.trackerBytes;
    const hasPos = state.pos.some((p) => p.include && p.po);
    $$('nav.tabs button').forEach((b) => {
      const t = b.dataset.tab;
      if (t === 'workspace') return;
      if (t === 'accounts') b.disabled = !hasUser;
      else if (t === 'templates') b.disabled = !hasAccount;
      else if (t === 'orders') b.disabled = !hasTracker;
      else if (t === 'followups') b.disabled = !hasTracker;
      else b.disabled = !hasTracker || !hasPos;
    });
  }

  /* ------------------------------------------------------------------ *
   * Header: identity and account switcher
   * ------------------------------------------------------------------ */

  function renderHeaderBar() {
    const host = $('#contextBar');
    clear(host);
    if (!state.workspace) { host.hidden = true; return; }
    host.hidden = false;

    const user = currentUser();
    const accounts = visibleAccounts();
    const groups = AMI.accountsByDivision(state.workspace, accounts);

    const userSelect = el('select', {
      onchange: async (e) => {
        state.userId = e.target.value;
        saveLocal({ userId: state.userId });
        const list = visibleAccounts();
        state.accountId = list.length ? list[0].id : '';
        await selectAccount(state.accountId);
      },
    }, [
      el('option', { value: '', text: 'Choose your name…', selected: !state.userId }),
      ...state.workspace.users.map((u) => el('option', {
        value: u.id, selected: u.id === state.userId,
        text: u.name + (u.divisionId ? ' — ' + AMI.divisionName(state.workspace, u.divisionId) : ''),
      })),
    ]);

    const accountSelect = el('select', {
      disabled: !accounts.length,
      onchange: async (e) => { await selectAccount(e.target.value); },
    }, groups.length ? groups.map((g) => el('optgroup', { label: g.division.name },
      g.accounts.map((a) => el('option', { value: a.id, selected: a.id === state.accountId, text: a.name })),
    )) : [el('option', { value: '', text: 'No accounts assigned' })]);

    host.appendChild(el('div', { class: 'context-row' }, [
      el('span', { class: 'context-label', text: 'You' }),
      userSelect,
      el('span', { class: 'context-label', text: 'Account' }),
      accountSelect,
      user && user.divisionId
        ? el('span', { class: 'chip manual', text: AMI.divisionName(state.workspace, user.divisionId) })
        : null,
      el('span', { class: 'spacer' }),
      state.trackerPath
        ? el('span', { class: 'context-note', text: 'Tracker: ' + state.trackerPath })
        : el('span', { class: 'context-note', text: 'No tracker loaded' }),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Workspace loading
   * ------------------------------------------------------------------ */

  async function openWorkspaceFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      toast('This browser cannot open folders. Use the workspace bundle instead.', 'error');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      await adoptStore(handleStore(dir));
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Could not open that folder: ' + e.message, 'error');
    }
  }

  async function adoptStore(store) {
    state.store = store;
    const { workspace, created } = await AMI.loadWorkspace(store);
    state.workspace = workspace;
    state.loadedAt = workspace.updated;

    const saved = loadLocal();
    if (saved.userId && workspace.users.some((u) => u.id === saved.userId)) state.userId = saved.userId;
    else if (workspace.users.length === 1) state.userId = workspace.users[0].id;

    const accounts = visibleAccounts();
    const preferred = saved.accountId && accounts.some((a) => a.id === saved.accountId) ? saved.accountId
      : (accounts.length ? accounts[0].id : '');

    renderHeaderBar();
    if (preferred) await selectAccount(preferred);
    else { renderWorkspace(); refreshTabs(); }

    if (created) {
      toast('New workspace created. Add divisions, accounts and users under Accounts.', 'ok');
      showTab('accounts');
    } else {
      toast('Workspace loaded — ' + workspace.accounts.length + ' account(s), '
        + workspace.users.length + ' user(s).', 'ok');
    }
  }

  async function persistWorkspace() {
    if (!state.store) return false;
    const user = currentUser();
    try {
      const saved = await AMI.saveWorkspace(state.store, state.workspace, {
        loadedAt: state.loadedAt, by: user ? user.name : '',
      });
      state.workspace = AMI.normaliseWorkspace(saved);
      state.loadedAt = saved.updated;
      return true;
    } catch (e) {
      if (e.code === 'STALE') {
        const proceed = window.confirm(e.message
          + '\n\nOverwrite their version with yours? Cancel to reload theirs and lose your unsaved edits.');
        if (proceed) {
          const saved = await AMI.saveWorkspace(state.store, state.workspace, { force: true, by: user ? user.name : '' });
          state.workspace = AMI.normaliseWorkspace(saved);
          state.loadedAt = saved.updated;
          return true;
        }
        state.workspace = e.onDisk;
        state.loadedAt = e.onDisk.updated;
        renderHeaderBar();
        renderAccounts();
        toast('Reloaded the shared workspace.', 'ok');
        return false;
      }
      toast('Could not save the workspace: ' + e.message, 'error');
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Account selection
   * ------------------------------------------------------------------ */

  async function selectAccount(accountId) {
    state.accountId = accountId || '';
    saveLocal({ accountId: state.accountId });

    state.trackerBytes = null;
    state.trackerPath = '';
    state.sheetName = '';
    state.base = null;
    state.preview = null;
    state.pos = [];
    state.emailRows = {};
    state.emailOverrides = {};
    state.posted = false;
    state.templates = [];
    state.selectedTemplateId = '';
    state.openItems = [];
    state.selectedItems = new Set();

    const account = currentAccount();
    if (account && state.store) {
      state.templates = await AMI.listTemplates(state.store, account.id);
      if (account.trackerPath) {
        const bytes = await state.store.read(account.trackerPath);
        if (bytes) {
          try {
            await loadTracker(bytes, account.trackerPath, account.sheet);
          } catch (e) {
            toast('Tracker for ' + account.name + ' could not be read: ' + e.message, 'error');
          }
        } else {
          toast('Tracker file not found at ' + account.trackerPath, 'error');
        }
      }
    }

    renderHeaderBar();
    renderWorkspace();
    renderIntake();
    renderReview();
    renderTemplates();
    refreshTabs();
  }

  async function loadTracker(bytes, path, preferredSheet) {
    state.trackerBytes = bytes;
    state.trackerPath = path;
    const wb = await AMI.Workbook.load(bytes);
    let chosen = '';
    if (preferredSheet && wb.sheet(preferredSheet) && AMI.findHeaderRow(wb.sheet(preferredSheet))) {
      chosen = preferredSheet;
    } else {
      for (const s of wb.sheets) if (AMI.findHeaderRow(s)) chosen = s.name;
    }
    if (!chosen) throw new Error('No sheet in this workbook has a "PO#" header row.');
    state.sheetName = chosen;
    await rebuildPlans();
  }

  /* ------------------------------------------------------------------ *
   * Order planning (shared with the single-account app)
   * ------------------------------------------------------------------ */

  function applyOverrides(plan, overrides) {
    if (!overrides) return plan;
    for (const f of plan.fields) {
      if (!(f.col in overrides)) continue;
      const raw = overrides[f.col];
      if (raw === '' || raw == null) { f.value = null; f.source = AMI.SOURCE.MANUAL; f.note = 'Cleared by you'; continue; }
      if (f.kind === 'date') f.value = AMI.parseDate(raw) || null;
      else if (f.kind === 'number') f.value = AMI.parseNumber(raw);
      else f.value = raw;
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
      if (!issues.some((i) => i.level === 'error')) {
        AMI.appendRow(sheet, AMI.renderRowXml(plan), plan.newRow);
        wb.commitSheet(sheet);
      }
    }
    state.preview = { wb, sheet, header, config };
  }

  /* ------------------------------------------------------------------ *
   * Panel: workspace
   * ------------------------------------------------------------------ */

  function renderWorkspace() {
    const host = $('#workspaceBody');
    clear(host);

    if (!state.store) {
      host.appendChild(el('p', { class: 'help', text: 'Open the shared folder that holds this file. It should be the SharePoint library synced through OneDrive, so everything you save reaches the rest of the team automatically.' }));
      host.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn primary', text: 'Open the workspace folder', onclick: openWorkspaceFolder }),
        el('button', {
          class: 'btn', text: 'Load a workspace bundle instead',
          onclick: () => {
            const inp = el('input', { type: 'file', accept: '.zip' });
            inp.addEventListener('change', async () => {
              try {
                await adoptStore(await importWorkspaceZip(new Uint8Array(await inp.files[0].arrayBuffer())));
                toast('Bundle loaded. Changes stay in this browser until you export a new bundle.', 'ok');
              } catch (e) { toast('That bundle could not be read: ' + e.message, 'error'); }
            });
            inp.click();
          },
        }),
      ]));
      host.appendChild(el('div', { class: 'msg info' }, [
        el('span', { class: 'icon', text: 'i' }),
        el('div', {}, [
          el('strong', { text: 'Why a folder and not a SharePoint sign-in?' }),
          el('span', { class: 'detail', text: 'A file opened straight from disk cannot sign in to SharePoint Online — that needs an Azure AD app registration and admin consent. Syncing the library through OneDrive gives the same shared result with no install and no IT ticket.' }),
        ]),
      ]));
      return;
    }

    const ws = state.workspace;
    const user = currentUser();
    const accounts = visibleAccounts();

    host.appendChild(el('div', { class: 'status-strip' }, [
      el('span', {}, [document.createTextNode('Source '), el('b', { text: state.store.kind === 'folder' ? 'synced folder' : 'uploaded bundle' })]),
      el('span', {}, [document.createTextNode('Divisions '), el('b', { text: String(ws.divisions.length) })]),
      el('span', {}, [document.createTextNode('Accounts '), el('b', { text: String(ws.accounts.length) })]),
      el('span', {}, [document.createTextNode('Users '), el('b', { text: String(ws.users.length) })]),
      el('span', {}, [document.createTextNode('Last saved '), el('b', { text: ws.updated ? new Date(ws.updated).toLocaleString() : '—' })]),
    ]));

    if (!ws.users.length) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [el('strong', { text: 'No users yet.' }),
          el('span', { class: 'detail', text: 'Add yourself under Accounts to get started. The first person added is made an administrator.' })]),
      ]));
    } else if (!user) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', { text: 'Choose your name in the bar above to see your accounts.' }),
      ]));
    }

    if (user) {
      host.appendChild(el('h3', { text: 'Your accounts' }));
      if (!accounts.length) {
        host.appendChild(el('p', { class: 'help', text: 'No accounts are assigned to you yet.' }));
      } else {
        for (const group of AMI.accountsByDivision(ws, accounts)) {
          const tbl = el('table', { class: 'data' });
          tbl.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Account' }), el('th', { text: 'Product' }),
            el('th', { text: 'Tracker' }), el('th', { text: 'Templates' }), el('th', {}),
          ])]));
          const tbody = el('tbody');
          for (const a of group.accounts) {
            tbody.appendChild(el('tr', {}, [
              el('td', {}, [el('b', { text: a.name })]),
              el('td', { text: a.product || '—' }),
              el('td', { class: 'mono', text: a.trackerPath || 'not set' }),
              el('td', { text: a.id === state.accountId ? String(state.templates.length) : '—' }),
              el('td', {}, [el('button', {
                class: 'btn small', text: a.id === state.accountId ? 'Selected' : 'Open',
                disabled: a.id === state.accountId,
                onclick: () => selectAccount(a.id),
              })]),
            ]));
          }
          tbl.appendChild(tbody);
          host.appendChild(el('h3', { text: group.division.name }));
          host.appendChild(el('div', { class: 'table-scroll' }, [tbl]));
        }
      }
    }

    const account = currentAccount();
    if (account && state.base) {
      const rows = AMI.dataRows(state.base.sheet, state.base.header);
      const last = rows[rows.length - 1];
      host.appendChild(el('h3', { text: account.name + ' — tracker' }));
      host.appendChild(el('div', { class: 'status-strip' }, [
        el('span', {}, [document.createTextNode('Sheet '), el('b', { text: state.sheetName })]),
        el('span', {}, [document.createTextNode('Orders logged '), el('b', { text: String(rows.length) })]),
        el('span', {}, [document.createTextNode('Last PO '), el('b', { text: last ? state.base.sheet.cellText(last, poColumn(state.base.header)) : '—' })]),
        el('span', {}, [document.createTextNode('Next row '), el('b', { text: String((last || state.base.header.row) + 1) })]),
      ]));
      const c = state.base.config;
      host.appendChild(el('dl', { class: 'kv' }, [
        ['Product', c.productName], ['Customer', c.customer], ['Bottles per case', c.bottlesPerCase],
        ['Cases per pallet', c.casesPerPallet],
        ['Production lead time', c.leadTimeDays != null ? c.leadTimeDays + ' days' : ''],
        ['Road/water transit', c.transitDays != null ? c.transitDays + ' days' : ''],
      ].filter((r) => r[1] !== '' && r[1] != null)
        .flatMap((r) => [el('dt', { text: r[0] }), el('dd', { text: String(r[1]) })])));
    }

    host.appendChild(el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn', text: 'Export workspace bundle',
        onclick: async () => {
          const bytes = await exportWorkspaceZip(state.store);
          download(bytes, 'AMI-workspace ' + stamp() + '.zip', 'application/zip');
          toast('Bundle exported — config and templates only, no trackers.', 'ok');
        },
      }),
      state.store.kind === 'memory'
        ? el('span', { class: 'context-note', text: 'Bundle mode: changes live in this browser until exported.' })
        : null,
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Panel: orders
   * ------------------------------------------------------------------ */

  let nextId = 1;

  async function addPdfs(files) {
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { toast('Skipped ' + file.name + ' — not a PDF.', 'error'); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let po = null;
      let error = '';
      try {
        po = AMI.parsePurchaseOrder(await AMI.extractPdfPages(bytes), file.name);
        if (!po.poNumber && !po.lineItem) { error = 'No purchase-order fields could be read from this PDF.'; po = null; }
      } catch (e) { error = 'Could not read this PDF: ' + e.message; }
      state.pos.push({ id: nextId++, fileName: file.name, bytes, po, error, include: !!po, overrides: {}, plan: null, issues: [] });
    }
    await rebuildPlans();
    renderIntake(); renderReview(); refreshTabs();
  }

  function renderIntake() {
    const host = $('#ordersBody');
    clear(host);
    const account = currentAccount();

    if (!account) { host.appendChild(el('div', { class: 'empty', text: 'Choose an account first.' })); return; }
    if (!state.trackerBytes) {
      host.appendChild(el('div', { class: 'msg warn' }, [el('span', { class: 'icon', text: '!' }),
        el('div', {}, [el('strong', { text: 'No tracker loaded for ' + account.name + '.' }),
          el('span', { class: 'detail', text: 'Assign one under Accounts before posting orders.' })])]));
      return;
    }

    host.appendChild(el('p', { class: 'help', text: 'Drop in the POs you are placing for ' + account.name + '. Each is read straight out of the PDF text — nothing is uploaded and no AI service is involved.' }));
    const drop = el('div', { class: 'dropzone', id: 'pdfDrop' }, [
      el('strong', { text: 'Drop purchase order PDFs here' }), document.createTextNode('or click to browse'),
    ]);
    const input = el('input', { type: 'file', accept: '.pdf', multiple: true, hidden: true });
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) addPdfs(Array.from(input.files)); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addPdfs(Array.from(e.dataTransfer.files)); });
    host.appendChild(drop);
    host.appendChild(input);

    const list = el('div');
    host.appendChild(list);
    if (!state.pos.length) { list.appendChild(el('div', { class: 'empty', text: 'No purchase orders loaded yet.' })); return; }

    for (const item of state.pos) {
      const po = item.po;
      const card = el('div', { class: 'po-card' + (item.include ? '' : ' excluded') });
      card.appendChild(el('header', {}, [
        el('input', {
          type: 'checkbox', checked: item.include,
          onchange: async (e) => { item.include = e.target.checked; await rebuildPlans(); renderIntake(); renderReview(); refreshTabs(); },
        }),
        el('span', { class: 'po-id', text: po ? (po.poNumber || '(no PO number)') : 'Unreadable' }),
        el('span', { class: 'file', text: item.fileName }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn small', text: 'Remove',
          onclick: async () => { state.pos = state.pos.filter((p) => p !== item); await rebuildPlans(); renderIntake(); renderReview(); refreshTabs(); },
        }),
      ]));
      const body = el('div', { class: 'body' });
      if (item.error) body.appendChild(el('div', { class: 'msg error' }, [el('span', { class: 'icon', text: '!' }), el('div', { text: item.error })]));
      if (po) {
        const money = (n) => (n == null ? '' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        body.appendChild(el('dl', { class: 'kv' }, [
          ['Order no.', po.poNumber], ['Order date', AMI.formatShort(po.orderDate)],
          ['Pickup date', AMI.formatShort(po.pickupDate)],
          ['Delivery date', AMI.formatShort(po.deliveryDate) || '(blank on PO)'],
          ['Item', po.itemNo + (po.description ? ' — ' + po.description : '')],
          ['Quantity', po.qty != null ? po.qty + ' ' + po.uom : ''],
          ['Unit price', money(po.unitPrice) + (po.currency ? ' ' + po.currency : '')],
          ['Vendor', po.vendorName],
          ['Vendor contact', po.vendorContact + (po.vendorEmail ? ' <' + po.vendorEmail + '>' : '')],
          ['Shipping agent', po.shippingAgent],
        ].filter((r) => r[1] !== '' && r[1] != null).flatMap((r) => [el('dt', { text: r[0] }), el('dd', { text: String(r[1]) })])));
        for (const w of po.warnings) body.appendChild(el('div', { class: 'msg warn' }, [el('span', { class: 'icon', text: '!' }), el('div', { text: w })]));
        body.appendChild(el('details', { class: 'raw' }, [
          el('summary', { text: 'Show the raw text this was read from' }), el('pre', { text: po.fullText }),
        ]));
      }
      card.appendChild(body);
      list.appendChild(card);
    }
  }

  /* ------------------------------------------------------------------ *
   * Panel: review
   * ------------------------------------------------------------------ */

  function fieldValueText(f) {
    const v = f.source === AMI.SOURCE.FORMULA ? f.computedValue : f.value;
    if (v == null || v === '') return '';
    if (v instanceof Date) return AMI.formatShort(v);
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    return String(v);
  }

  function renderReview() {
    const host = $('#reviewBody');
    clear(host);
    const included = state.pos.filter((p) => p.include && p.po);
    if (!included.length) { host.appendChild(el('div', { class: 'empty', text: 'No orders selected.' })); return; }

    let errors = 0;
    for (const item of included) {
      const plan = item.plan;
      if (!plan) continue;
      errors += item.issues.filter((i) => i.level === 'error').length;
      const card = el('div', { class: 'po-card' });
      card.appendChild(el('header', {}, [
        el('span', { class: 'po-id', text: AMI.planPoNumber(plan, item.po) }),
        el('span', { class: 'file', text: 'row ' + plan.newRow }),
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'chip ' + (item.issues.some((i) => i.level === 'error') ? 'error' : 'ok'),
          text: item.issues.some((i) => i.level === 'error') ? 'blocked' : 'ready',
        }),
      ]));
      const body = el('div', { class: 'body' });
      for (const issue of item.issues) {
        body.appendChild(el('div', { class: 'msg ' + issue.level }, [
          el('span', { class: 'icon', text: issue.level === 'info' ? 'i' : '!' }),
          el('div', {}, [el('strong', { text: issue.message }), issue.detail ? el('span', { class: 'detail', text: issue.detail }) : null]),
        ]));
      }
      for (const f of plan.fields) {
        const row = el('div', { class: 'fieldrow' + (f.source === AMI.SOURCE.MANUAL ? ' is-manual' : '') });
        row.appendChild(el('div', { class: 'hdr', text: f.header }));
        if (f.source === AMI.SOURCE.FORMULA) {
          row.appendChild(el('div', { class: 'val-static', text: fieldValueText(f) || '—' }));
        } else {
          row.appendChild(el('input', {
            type: f.kind === 'date' ? 'date' : 'text',
            value: f.kind === 'date' ? (f.value instanceof Date ? AMI.formatISO(f.value) : '') : (f.value == null ? '' : String(f.value)),
            placeholder: f.source === AMI.SOURCE.MANUAL ? 'blank' : '',
            onchange: async (e) => { item.overrides[f.col] = e.target.value; await rebuildPlans(); renderReview(); },
          }));
        }
        row.appendChild(sourceChip(f.source));
        row.appendChild(el('div', { class: 'note', text: f.note }));
        body.appendChild(row);
      }
      card.appendChild(body);
      host.appendChild(card);
    }

    host.appendChild(el('div', { class: 'card' }, [el('div', { class: 'body' }, [
      errors
        ? el('div', { class: 'msg error' }, [el('span', { class: 'icon', text: '!' }), el('div', { text: errors + ' problem(s) must be resolved before anything is written.' })])
        : el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }),
          el('div', { text: included.length + ' row(s) ready for "' + state.sheetName + '". Formulas, styles, comments and every other sheet are preserved.' })]),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn primary', disabled: errors > 0 || state.posted,
          text: state.posted ? 'Posted' : 'Post ' + included.length + ' order(s) to the tracker',
          onclick: postToTracker,
        }),
        el('button', {
          class: 'btn', text: 'Download a backup first',
          onclick: () => download(state.trackerBytes,
            safeName(state.trackerPath.split('/').pop().replace(/\.xlsx?m?$/i, '')) + ' (backup ' + stamp() + ').xlsx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        }),
      ]),
    ])]));
  }

  async function postToTracker() {
    if (!state.preview || !state.store) return;
    const included = state.pos.filter((p) => p.include && p.po && p.plan);
    if (!included.length) return;
    try {
      const parts = AMI.splitPath(state.trackerPath);
      const fileName = parts.pop();
      const dir = parts.join('/');
      const backupPath = (dir ? dir + '/' : '') + fileName.replace(/\.xlsx?m?$/i, '') + ' (backup ' + stamp() + ').xlsx';

      await state.store.write(backupPath, state.trackerBytes);
      state.preview.wb.dropCalcChain();
      const out = await state.preview.wb.toBytes();
      await state.store.write(state.trackerPath, out);

      state.trackerBytes = out;
      state.posted = true;
      await rebuildPlans();
      renderWorkspace();
      renderReview();
      toast('Wrote ' + included.length + ' row(s) into ' + fileName + '. Backup saved alongside it.', 'ok');
      showTab('email');
    } catch (e) {
      toast('Nothing was written: ' + e.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * Panel: email
   * ------------------------------------------------------------------ */

  const twoDp = (n) => (n == null || !Number.isFinite(n) ? ''
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /**
   * Values offered to templates. Every one is read from a PO, computed from a
   * PO plus a tracker constant, or taken from the account record.
   */
  function emailVars(role) {
    const included = state.pos.filter((p) => p.include && p.po);
    const first = included.length ? included[0].po : null;
    const config = state.base ? state.base.config : {};
    const account = currentAccount() || {};
    const user = currentUser() || {};

    const rows = included.map((item) => {
      const po = item.po;
      const plan = item.plan;
      const poNo = plan ? AMI.planPoNumber(plan, po) : po.poNumber;
      const extra = state.emailRows[poNo] || {};
      const collectionField = plan ? plan.fields.find((f) => /AMI Requested\s+Collection Date/i.test(f.header)) : null;
      const collectionDate = collectionField
        ? (collectionField.source === AMI.SOURCE.FORMULA ? collectionField.computedValue : collectionField.value)
        : po.pickupDate;
      return {
        po: poNo,
        bt: twoDp(plan ? plan.derived.bottles : null),
        cs: twoDp(po.qty),
        pal: twoDp(plan ? plan.derived.pallets : null),
        bottling: extra.bottling || '',
        bottlingDate: extra.bottlingDate || '',
        expiry: extra.expiry || '',
        collection: AMI.formatEmailDate(collectionDate || po.pickupDate),
        _pallets: plan ? plan.derived.pallets : null,
        _cases: po.qty,
      };
    });

    const totalPallets = rows.reduce((a, r) => a + (r._pallets || 0), 0);
    const totalCases = rows.reduce((a, r) => a + (r._cases || 0), 0);
    const totalWeight = config.palletWeight != null && totalPallets
      ? Math.round(totalPallets * config.palletWeight) : null;

    const recipients = AMI.resolveRecipients(account, role, first, user);

    return {
      rows, included, first, recipients,
      vars: {
        account: account.name || '',
        division: AMI.divisionName(state.workspace, account.divisionId) || '',
        customer: config.customer || account.name || '',
        product: first ? first.description : (config.productName || account.product || ''),
        size: first ? first.size : (config.caseSize || ''),
        vendorContact: first ? (first.vendorContact || first.vendorName) : '',
        recipientName: ((account.contacts && account.contacts[role] && account.contacts[role].name) || '')
          || (role === 'vendor' && first ? first.vendorContact : ''),
        senderName: user.name || '',
        poCount: included.length,
        poGroups: AMI.poGroups(rows.map((r) => r.po)),
        poList: rows.map((r) => r.po).join(', '),
        docsEmail: first ? first.docsTo : '',
        finalDelivery: first ? first.finalDeliveryTo.join('<br>') : '',
        collectionAddress: first ? [first.vendorName, first.vendorAddress].filter(Boolean).join(', ') : '',
        deliveryAddress: first ? first.shipToBlock.join('<br>') : '',
        collectionDate: rows.length ? rows[0].collection : '',
        totalPallets: totalPallets || '',
        totalCases: totalCases || '',
        totalWeight: totalWeight != null ? totalWeight + ' kg' : '',
        forwarder: first ? first.shippingAgent : '',
        today: AMI.formatEmailDate(new Date()),
        table: AMI.orderTableHtml(rows),
        signature: user.signature || '',
      },
    };
  }

  const BUILTIN_VENDOR_TEMPLATE = {
    id: '', label: 'Built-in vendor order email', role: 'vendor', builtin: true,
    subject: 'AMI Wines for {{customer}} - {{poCount}} new Purchase Orders {{poGroups}} - {{product}}',
    html: [
      '<p>Dear {{vendorContact}},</p>',
      '<p>Please find attached {{poCount}} new purchase order(s) for the item {{product}}, {{size}} for the program with {{customer}}.</p>',
      '<p>I am detailing a breakdown of the orders below, for your reference:</p>',
      '{{table}}',
      '<p>Please confirm the above orders with your proforma and fill out the expiration date on the above chart.</p>',
      '<p>FOR FINAL DELIVERY TO:<br>{{finalDelivery}}</p>',
      '<p>Thank you and kind regards,</p>',
      '{{signature}}',
    ].join('\n'),
  };

  function availableTemplates(role) {
    const list = state.templates.filter((t) => !t.error && (!role || t.role === role));
    if (role === 'vendor') list.push(BUILTIN_VENDOR_TEMPLATE);
    return list;
  }

  function renderEmail() {
    const host = $('#emailBody');
    clear(host);
    const account = currentAccount();
    const included = state.pos.filter((p) => p.include && p.po);
    if (!account || !included.length) {
      host.appendChild(el('div', { class: 'empty', text: 'Load purchase orders first — drafts are built from them.' }));
      return;
    }

    const roleRow = el('div', { class: 'btn-row' }, AMI.ROLES.map((r) => el('button', {
      class: 'btn small' + (state.selectedRole === r.id ? ' primary' : ''),
      text: r.name,
      onclick: () => { state.selectedRole = r.id; state.selectedTemplateId = ''; state.emailOverrides = {}; renderEmail(); },
    })));
    host.appendChild(el('h3', { text: 'Who is this going to?' }));
    host.appendChild(roleRow);

    const templates = availableTemplates(state.selectedRole);
    if (!templates.length) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: 'No ' + state.selectedRole + ' template for ' + account.name + ' yet.' }),
          el('span', { class: 'detail', text: 'Upload one under Templates and it will appear here for everyone on this account.' }),
        ]),
      ]));
      host.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', text: 'Go to Templates', onclick: () => showTab('templates') }),
      ]));
      return;
    }

    if (!state.selectedTemplateId || !templates.some((t) => (t.id || '_builtin') === state.selectedTemplateId)) {
      state.selectedTemplateId = templates[0].id || '_builtin';
    }
    const template = templates.find((t) => (t.id || '_builtin') === state.selectedTemplateId);

    host.appendChild(el('label', { class: 'field' }, [
      el('span', { text: 'Template' }),
      el('select', {
        onchange: (e) => { state.selectedTemplateId = e.target.value; state.emailOverrides = {}; renderEmail(); },
      }, templates.map((t) => el('option', {
        value: t.id || '_builtin', selected: (t.id || '_builtin') === state.selectedTemplateId,
        text: (t.label || t.id) + (t.builtin ? ' (built in)' : ''),
      }))),
    ]));

    const ctx = emailVars(state.selectedRole);
    const ov = state.emailOverrides;

    const toInput = el('input', { type: 'text', value: ov.to != null ? ov.to : (template.to || ctx.recipients.to) });
    const ccInput = el('input', { type: 'text', value: ov.cc != null ? ov.cc : (template.cc || ctx.recipients.cc) });
    const subjInput = el('input', { type: 'text', value: ov.subject != null ? ov.subject : AMI.fillTemplate(template.subject || '', ctx.vars) });
    toInput.addEventListener('change', () => { ov.to = toInput.value; });
    ccInput.addEventListener('change', () => { ov.cc = ccInput.value; });
    subjInput.addEventListener('change', () => { ov.subject = subjInput.value; });

    host.appendChild(el('div', { class: 'grid-2' }, [
      el('label', { class: 'field' }, [
        el('span', { text: 'To' + (ctx.recipients.toSource ? ' — from the ' + ctx.recipients.toSource : '') }), toInput,
      ]),
      el('label', { class: 'field' }, [el('span', { text: 'Cc' }), ccInput]),
    ]));
    host.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Subject' }), subjInput]));

    if (/\{\{table\}\}/.test(template.html || '')) {
      host.appendChild(el('h3', { text: 'Order breakdown table' }));
      const tbl = el('table', { class: 'data' });
      tbl.appendChild(el('thead', {}, [el('tr', {}, AMI.TABLE_COLUMNS.map((c) => el('th', { text: c.label })))]));
      const tbody = el('tbody');
      for (const r of ctx.rows) {
        const editable = (key) => el('input', {
          type: 'text', value: r[key],
          onchange: (e) => {
            state.emailRows[r.po] = Object.assign({}, state.emailRows[r.po], { [key]: e.target.value });
            renderEmail();
          },
        });
        tbody.appendChild(el('tr', {}, [
          el('td', { class: 'mono', text: r.po }), el('td', { class: 'num', text: r.bt }),
          el('td', { class: 'num', text: r.cs }), el('td', { class: 'num', text: r.pal }),
          el('td', {}, [editable('bottling')]), el('td', {}, [editable('bottlingDate')]),
          el('td', {}, [editable('expiry')]), el('td', { text: r.collection }),
        ]));
      }
      tbl.appendChild(tbody);
      host.appendChild(el('div', { class: 'table-scroll' }, [tbl]));
      host.appendChild(el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn small', text: 'Set bottling & expiration to "Please advise"',
          onclick: () => {
            for (const r of ctx.rows) state.emailRows[r.po] = Object.assign({}, state.emailRows[r.po], { bottlingDate: 'Please advise', expiry: 'Please advise' });
            renderEmail();
          },
        }),
        el('button', {
          class: 'btn small', text: 'Clear those columns',
          onclick: () => {
            for (const r of ctx.rows) state.emailRows[r.po] = Object.assign({}, state.emailRows[r.po], { bottling: '', bottlingDate: '', expiry: '' });
            renderEmail();
          },
        }),
      ]));
    }

    const bodyHtml = ov.html != null ? ov.html : AMI.fillTemplate(template.html || '', ctx.vars);

    const unresolved = AMI.templatePlaceholders(bodyHtml);
    if (unresolved.length) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: 'Unfilled placeholder(s): ' + unresolved.map((p) => '{{' + p + '}}').join(', ') }),
          el('span', { class: 'detail', text: 'No value was available for these. Edit the draft below or correct the template.' }),
        ]),
      ]));
    }

    host.appendChild(el('h3', { text: 'Preview' }));
    host.appendChild(el('div', { class: 'email-preview', html: bodyHtml }));

    const editArea = el('textarea', { rows: 12 });
    editArea.value = bodyHtml;
    editArea.addEventListener('change', () => { ov.html = editArea.value; renderEmail(); });
    host.appendChild(el('details', { class: 'raw' }, [
      el('summary', { text: 'Edit this draft before sending' }),
      el('p', { class: 'help', text: 'Changes here affect this draft only. To change it for everyone, edit the template.' }),
      editArea,
    ]));

    const attachBox = el('input', { type: 'checkbox', checked: state.selectedRole === 'vendor' });
    host.appendChild(el('div', { class: 'btn-row' }, [
      el('label', { style: 'display:flex;align-items:center;gap:7px;font-size:13px;' }, [
        attachBox, document.createTextNode('Attach the ' + included.length + ' PO PDF(s)'),
      ]),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn', text: 'Copy body',
        onclick: async () => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([bodyHtml], { type: 'text/html' }) })]);
            toast('Body copied — paste into Outlook.', 'ok');
          } catch (e) { toast('Clipboard blocked here; use the .eml download.', 'error'); }
        },
      }),
      el('button', {
        class: 'btn primary', text: 'Download Outlook draft (.eml)',
        onclick: () => {
          const user = currentUser() || {};
          const eml = AMI.buildEml({
            from: user.email ? (user.name ? user.name + ' <' + user.email + '>' : user.email) : '',
            to: toInput.value, cc: ccInput.value, subject: subjInput.value,
            html: '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + bodyHtml + '</body></html>',
            attachments: attachBox.checked
              ? included.map((i) => ({ name: i.fileName, mime: 'application/pdf', bytes: i.bytes })) : [],
          });
          download(new Blob([eml], { type: 'message/rfc822' }),
            safeName((account.name || 'order') + ' ' + state.selectedRole + ' ' + (ctx.vars.poGroups || stamp())) + '.eml');
          toast('Draft saved. Double-click it to open in Outlook.', 'ok');
        },
      }),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Panel: templates
   * ------------------------------------------------------------------ */

  function renderTemplates() {
    const host = $('#templatesBody');
    clear(host);
    const account = currentAccount();
    if (!account) { host.appendChild(el('div', { class: 'empty', text: 'Choose an account first.' })); return; }

    host.appendChild(el('p', { class: 'help', text: 'Templates for ' + account.name + '. They live in the shared folder, so anyone working this account gets the same wording. Uploading an Outlook message, Word file or saved email keeps its formatting.' }));

    const fileInput = el('input', { type: 'file', accept: '.msg,.oft,.eml,.docx,.html,.htm,.txt', multiple: true, hidden: true });
    fileInput.addEventListener('change', async () => {
      for (const f of Array.from(fileInput.files)) await importTemplate(f);
      fileInput.value = '';
      renderTemplates();
    });
    host.appendChild(fileInput);
    host.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn primary', text: 'Upload template files', onclick: () => fileInput.click() }),
      el('button', {
        class: 'btn', text: 'New blank template',
        onclick: async () => {
          const saved = await AMI.saveTemplate(state.store, account.id, {
            label: 'Untitled template', role: state.selectedRole, subject: '', html: '<p></p>', source: 'created here',
          });
          state.templates = await AMI.listTemplates(state.store, account.id);
          openTemplateEditor(saved.id);
        },
      }),
      el('span', { class: 'context-note', text: '.msg  .oft  .eml  .docx  .html  .txt' }),
    ]));

    if (!state.templates.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No templates yet for this account.' }));
      return;
    }

    for (const role of AMI.ROLES) {
      const inRole = state.templates.filter((t) => t.role === role.id);
      if (!inRole.length) continue;
      const tbl = el('table', { class: 'data' });
      tbl.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Template' }), el('th', { text: 'Subject' }),
        el('th', { text: 'Placeholders' }), el('th', { text: 'Source' }), el('th', {}),
      ])]));
      const tbody = el('tbody');
      for (const t of inRole) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [el('b', { text: t.label || t.id }), t.error ? el('div', { class: 'note', text: t.error }) : null]),
          el('td', { text: t.subject || '—' }),
          el('td', { class: 'mono', text: AMI.templatePlaceholders(t.html + ' ' + (t.subject || '')).join(' ') || '—' }),
          el('td', { text: t.source || '—' }),
          el('td', {}, [el('div', { class: 'btn-row', style: 'margin:0' }, [
            el('button', { class: 'btn small', text: 'Edit', onclick: () => openTemplateEditor(t.id) }),
            el('button', {
              class: 'btn small danger', text: 'Delete',
              onclick: async () => {
                if (!window.confirm('Delete "' + (t.label || t.id) + '" for everyone on this account?')) return;
                await AMI.deleteTemplate(state.store, account.id, t.id);
                state.templates = await AMI.listTemplates(state.store, account.id);
                renderTemplates();
                toast('Template deleted.', 'ok');
              },
            }),
          ])]),
        ]));
      }
      tbl.appendChild(tbody);
      host.appendChild(el('h3', { text: role.name }));
      host.appendChild(el('div', { class: 'table-scroll' }, [tbl]));
    }

    host.appendChild(el('div', { id: 'templateEditor' }));
  }

  async function importTemplate(file) {
    const account = currentAccount();
    try {
      const parsed = await AMI.parseTemplateFile(new Uint8Array(await file.arrayBuffer()), file.name);
      const saved = await AMI.saveTemplate(state.store, account.id, {
        label: parsed.subject ? parsed.subject.slice(0, 60) : file.name.replace(/\.[a-z0-9]+$/i, ''),
        role: state.selectedRole,
        subject: parsed.subject, to: parsed.to, cc: parsed.cc,
        html: parsed.html, source: file.name + ' — ' + parsed.bodySource,
      });
      state.templates = await AMI.listTemplates(state.store, account.id);
      toast('Imported ' + file.name + ' (' + parsed.bodySource + '). Set its role and placeholders.', 'ok');
      openTemplateEditor(saved.id);
    } catch (e) {
      toast(file.name + ': ' + e.message, 'error');
    }
  }

  function openTemplateEditor(templateId) {
    const account = currentAccount();
    const host = $('#templateEditor');
    if (!host) return;
    clear(host);
    const t = state.templates.find((x) => x.id === templateId);
    if (!t) return;

    const label = el('input', { type: 'text', value: t.label || '' });
    const subject = el('input', { type: 'text', value: t.subject || '' });
    const roleSel = el('select', {}, AMI.ROLES.map((r) => el('option', { value: r.id, selected: r.id === t.role, text: r.name })));
    const body = el('textarea', { rows: 16 });
    body.value = t.html || '';

    const preview = el('div', { class: 'email-preview' });
    const placeholderNote = el('div', { class: 'note' });

    const refresh = () => {
      const ctx = state.pos.some((p) => p.include && p.po) ? emailVars(roleSel.value) : null;
      preview.innerHTML = ctx ? AMI.fillTemplate(body.value, ctx.vars) : body.value;
      const used = AMI.templatePlaceholders(body.value + ' ' + subject.value);
      placeholderNote.textContent = used.length
        ? 'Placeholders in use: ' + used.map((p) => '{{' + p + '}}').join(', ')
        : 'No placeholders yet — this template will send exactly as written.';
    };
    [label, subject, roleSel, body].forEach((n) => n.addEventListener('input', refresh));
    refresh();

    // Offer to swap literal values in an imported template for placeholders.
    const ctxForSuggest = state.pos.some((p) => p.include && p.po) ? emailVars(t.role || 'vendor') : null;
    const suggestions = ctxForSuggest
      ? AMI.suggestPlaceholders(body.value, {
        customer: ctxForSuggest.vars.customer,
        product: ctxForSuggest.vars.product,
        vendorContact: ctxForSuggest.vars.vendorContact,
        docsEmail: ctxForSuggest.vars.docsEmail,
        poList: ctxForSuggest.vars.poList,
      })
      : [];

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode('Editing: ' + (t.label || t.id)),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Close', onclick: () => clear(host) }),
      ]),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid-2' }, [
          el('label', { class: 'field' }, [el('span', { text: 'Name' }), label]),
          el('label', { class: 'field' }, [el('span', { text: 'Goes to' }), roleSel]),
        ]),
        el('label', { class: 'field' }, [el('span', { text: 'Subject line' }), subject]),
        suggestions.length ? el('div', { class: 'msg info' }, [
          el('span', { class: 'icon', text: 'i' }),
          el('div', {}, [
            el('strong', { text: 'This template contains values that could become placeholders.' }),
            el('span', { class: 'detail', text: suggestions.map((s) => '"' + s.literal + '" → ' + s.placeholder).join('  ·  ') }),
            el('div', { class: 'btn-row' }, [el('button', {
              class: 'btn small', text: 'Replace them with placeholders',
              onclick: () => { body.value = AMI.applyPlaceholderSuggestions(body.value, suggestions); refresh(); },
            })]),
          ]),
        ]) : null,
        el('label', { class: 'field' }, [el('span', { text: 'Body (HTML)' }), body]),
        placeholderNote,
        el('h3', { text: 'Preview' }),
        el('p', { class: 'help', text: state.pos.length ? 'Filled with the orders currently loaded.' : 'Load purchase orders to see this filled with real values.' }),
        preview,
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', text: 'Save for everyone on this account',
            onclick: async () => {
              await AMI.saveTemplate(state.store, account.id, {
                id: t.id, label: label.value, role: roleSel.value, subject: subject.value,
                to: t.to, cc: t.cc, html: body.value, source: t.source,
              });
              state.templates = await AMI.listTemplates(state.store, account.id);
              renderTemplates();
              toast('Template saved to the shared folder.', 'ok');
            },
          }),
          el('button', { class: 'btn', text: 'Cancel', onclick: () => clear(host) }),
        ]),
      ]),
    ]));
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------------ *
   * Panel: accounts
   * ------------------------------------------------------------------ */

  function renderAccounts() {
    const host = $('#accountsBody');
    clear(host);
    if (!state.workspace) { host.appendChild(el('div', { class: 'empty', text: 'Open the workspace folder first.' })); return; }

    const ws = state.workspace;
    const user = currentUser();
    const canEdit = !user || user.isAdmin || !ws.users.length;

    const issues = AMI.validateWorkspace(ws);
    for (const i of issues.slice(0, 8)) {
      host.appendChild(el('div', { class: 'msg ' + i.level }, [el('span', { class: 'icon', text: '!' }), el('div', { text: i.message })]));
    }
    if (!canEdit) {
      host.appendChild(el('div', { class: 'msg info' }, [el('span', { class: 'icon', text: 'i' }),
        el('div', { text: 'You can view this, but only administrators change the shared setup.' })]));
    }

    /* Divisions */
    host.appendChild(el('h3', { text: 'Divisions' }));
    const divRow = el('div', { class: 'btn-row' }, [
      ...ws.divisions.map((d) => el('span', { class: 'chip manual', text: d.name })),
      canEdit ? el('button', {
        class: 'btn small', text: 'Add division',
        onclick: async () => {
          const name = window.prompt('Division name');
          if (!name) return;
          ws.divisions.push({ id: AMI.uniqueId(name, ws.divisions.map((d) => d.id)), name });
          if (await persistWorkspace()) { renderAccounts(); renderHeaderBar(); }
        },
      }) : null,
    ]);
    host.appendChild(divRow);

    /* Accounts */
    host.appendChild(el('h3', { text: 'Accounts' }));
    const accTable = el('table', { class: 'data' });
    accTable.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Account' }), el('th', { text: 'Division' }), el('th', { text: 'Tracker' }),
      el('th', { text: 'Sheet' }), el('th', {}),
    ])]));
    const accBody = el('tbody');
    for (const a of ws.accounts) {
      accBody.appendChild(el('tr', {}, [
        el('td', {}, [el('b', { text: a.name }), a.product ? el('div', { class: 'note', text: a.product }) : null]),
        el('td', { text: AMI.divisionName(ws, a.divisionId) || '—' }),
        el('td', { class: 'mono', text: a.trackerPath || 'not set' }),
        el('td', { text: a.sheet || 'auto' }),
        el('td', {}, [canEdit ? el('button', { class: 'btn small', text: 'Edit', onclick: () => openAccountEditor(a.id) }) : null]),
      ]));
    }
    accTable.appendChild(accBody);
    host.appendChild(el('div', { class: 'table-scroll' }, [accTable]));
    if (canEdit) {
      host.appendChild(el('div', { class: 'btn-row' }, [el('button', {
        class: 'btn', text: 'Add account',
        onclick: async () => {
          const name = window.prompt('Account name (for example: Delta, British Airways)');
          if (!name) return;
          ws.accounts.push(AMI.normaliseWorkspace({
            accounts: [{ id: AMI.uniqueId(name, ws.accounts.map((x) => x.id)), name, divisionId: ws.divisions[0] ? ws.divisions[0].id : '' }],
          }).accounts[0]);
          if (await persistWorkspace()) { renderAccounts(); renderHeaderBar(); }
        },
      })]));
    }

    /* Users */
    host.appendChild(el('h3', { text: 'People' }));
    const userTable = el('table', { class: 'data' });
    userTable.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Name' }), el('th', { text: 'Division' }), el('th', { text: 'Accounts' }),
      el('th', { text: 'Role' }), el('th', {}),
    ])]));
    const userBody = el('tbody');
    for (const u of ws.users) {
      const assigned = u.accountIds.length
        ? u.accountIds.map((id) => (ws.accounts.find((a) => a.id === id) || {}).name || id).join(', ')
        : 'all in division';
      userBody.appendChild(el('tr', {}, [
        el('td', {}, [el('b', { text: u.name }), u.email ? el('div', { class: 'note', text: u.email }) : null]),
        el('td', { text: AMI.divisionName(ws, u.divisionId) || '—' }),
        el('td', { text: assigned }),
        el('td', {}, [u.isAdmin ? el('span', { class: 'chip ok', text: 'admin' }) : el('span', { class: 'chip manual', text: 'member' })]),
        el('td', {}, [canEdit ? el('button', { class: 'btn small', text: 'Edit', onclick: () => openUserEditor(u.id) }) : null]),
      ]));
    }
    userTable.appendChild(userBody);
    host.appendChild(el('div', { class: 'table-scroll' }, [userTable]));
    host.appendChild(el('div', { class: 'btn-row' }, [el('button', {
      class: 'btn', text: ws.users.length ? 'Add person' : 'Add yourself',
      onclick: async () => {
        const name = window.prompt('Full name');
        if (!name) return;
        const id = AMI.uniqueId(name, ws.users.map((x) => x.id));
        ws.users.push({
          id, name, email: '', divisionId: ws.divisions[0] ? ws.divisions[0].id : '',
          accountIds: [], signature: '', defaultCc: '', isAdmin: ws.users.length === 0,
        });
        if (await persistWorkspace()) {
          if (!state.userId) { state.userId = id; saveLocal({ userId: id }); }
          renderAccounts(); renderHeaderBar();
          openUserEditor(id);
        }
      },
    })]));

    host.appendChild(el('div', { class: 'msg info' }, [
      el('span', { class: 'icon', text: 'i' }),
      el('div', {}, [
        el('strong', { text: 'This organises the view; it does not lock anything.' }),
        el('span', { class: 'detail', text: 'Anyone who can open the shared folder can open any tracker in it. If some accounts must be genuinely restricted, set those permissions on the SharePoint folders — that is the only place they can be enforced.' }),
      ]),
    ]));

    host.appendChild(el('div', { id: 'entityEditor' }));
  }

  function editorField(labelText, input, help) {
    return el('label', { class: 'field' }, [
      el('span', { text: labelText }), input,
      help ? el('div', { class: 'note', text: help }) : null,
    ]);
  }

  async function openAccountEditor(accountId) {
    const ws = state.workspace;
    const a = ws.accounts.find((x) => x.id === accountId);
    const host = $('#entityEditor');
    clear(host);
    if (!a) return;

    const name = el('input', { type: 'text', value: a.name });
    const product = el('input', { type: 'text', value: a.product });
    const division = el('select', {}, ws.divisions.map((d) => el('option', { value: d.id, selected: d.id === a.divisionId, text: d.name })));
    const sheet = el('input', { type: 'text', value: a.sheet, placeholder: 'auto — last sheet with a PO# header' });
    const cc = el('input', { type: 'text', value: a.defaultCc });
    const notes = el('input', { type: 'text', value: a.notes });

    const trackerPath = el('input', { type: 'text', value: a.trackerPath, placeholder: 'trackers/Account Tracking Chart.xlsx' });
    const trackerPick = el('select', {}, [el('option', { value: '', text: 'Scanning folder…' })]);
    AMI.findWorkbooks(state.store, '', 3).then((paths) => {
      clear(trackerPick);
      trackerPick.appendChild(el('option', { value: '', text: paths.length ? 'Pick a workbook…' : 'No workbooks found in this folder' }));
      for (const p of paths) trackerPick.appendChild(el('option', { value: p, selected: p === a.trackerPath, text: p }));
    });
    trackerPick.addEventListener('change', () => { if (trackerPick.value) trackerPath.value = trackerPick.value; });

    const contactInputs = {};
    const contactFields = AMI.ROLES.map((r) => {
      const c = a.contacts[r.id] || {};
      const n = el('input', { type: 'text', value: c.name || '', placeholder: 'name' });
      const e = el('input', { type: 'text', value: c.email || '', placeholder: 'email' });
      const cx = el('input', { type: 'text', value: c.cc || '', placeholder: 'always cc' });
      contactInputs[r.id] = { n, e, cx };
      return el('div', { class: 'contact-row' }, [
        el('div', { class: 'contact-role' }, [el('b', { text: r.name }), el('div', { class: 'note', text: r.hint })]),
        n, e, cx,
      ]);
    });

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Account: ' + a.name), el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Close', onclick: () => clear(host) })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid-2' }, [
          editorField('Account name', name), editorField('Division', division),
          editorField('Product', product, 'Shown in drafts when the tracker does not name one.'),
          editorField('Sheet to post into', sheet),
        ]),
        el('h3', { text: 'Tracker' }),
        editorField('Workbook in this folder', trackerPick),
        editorField('Path', trackerPath, 'Relative to the workspace folder.'),
        el('h3', { text: 'Standing contacts' }),
        el('p', { class: 'help', text: 'Used when a draft has no address from the PO. For vendor emails the PO always wins.' }),
        ...contactFields,
        el('h3', { text: 'Other' }),
        el('div', { class: 'grid-2' }, [
          editorField('Always Cc', cc), editorField('Notes', notes),
        ]),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', text: 'Save account',
            onclick: async () => {
              a.name = name.value.trim() || a.name;
              a.product = product.value.trim();
              a.divisionId = division.value;
              a.sheet = sheet.value.trim();
              a.trackerPath = trackerPath.value.trim();
              a.defaultCc = cc.value.trim();
              a.notes = notes.value.trim();
              for (const r of AMI.ROLES) {
                const i = contactInputs[r.id];
                a.contacts[r.id] = { name: i.n.value.trim(), email: i.e.value.trim(), cc: i.cx.value.trim() };
              }
              if (await persistWorkspace()) {
                clear(host);
                renderAccounts();
                renderHeaderBar();
                if (a.id === state.accountId) await selectAccount(a.id);
                toast('Account saved for the whole team.', 'ok');
              }
            },
          }),
          el('button', {
            class: 'btn danger', text: 'Delete account',
            onclick: async () => {
              if (!window.confirm('Remove "' + a.name + '" from the workspace? Templates and trackers stay on disk.')) return;
              ws.accounts = ws.accounts.filter((x) => x !== a);
              for (const u of ws.users) u.accountIds = u.accountIds.filter((id) => id !== a.id);
              if (await persistWorkspace()) {
                clear(host); renderAccounts(); renderHeaderBar();
                if (state.accountId === a.id) await selectAccount(visibleAccounts()[0] ? visibleAccounts()[0].id : '');
              }
            },
          }),
        ]),
      ]),
    ]));
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openUserEditor(userId) {
    const ws = state.workspace;
    const u = ws.users.find((x) => x.id === userId);
    const host = $('#entityEditor');
    clear(host);
    if (!u) return;

    const name = el('input', { type: 'text', value: u.name });
    const email = el('input', { type: 'text', value: u.email });
    const division = el('select', {}, [
      el('option', { value: '', text: '— none —', selected: !u.divisionId }),
      ...ws.divisions.map((d) => el('option', { value: d.id, selected: d.id === u.divisionId, text: d.name })),
    ]);
    const admin = el('input', { type: 'checkbox', checked: u.isAdmin });
    const signature = el('textarea', { rows: 6 });
    signature.value = u.signature || '';
    const defaultCc = el('input', { type: 'text', value: u.defaultCc });

    const accountBoxes = ws.accounts.map((a) => {
      const box = el('input', { type: 'checkbox', checked: u.accountIds.includes(a.id) });
      box.dataset.accountId = a.id;
      return el('label', { class: 'check-inline' }, [
        box, document.createTextNode(a.name + ' (' + (AMI.divisionName(ws, a.divisionId) || 'no division') + ')'),
      ]);
    });

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Person: ' + u.name), el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Close', onclick: () => clear(host) })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid-2' }, [
          editorField('Name', name), editorField('Email', email),
          editorField('Division', division), editorField('Always Cc', defaultCc),
        ]),
        el('label', { class: 'check-inline' }, [admin, document.createTextNode('Administrator — can change accounts and people')]),
        editorField('Email signature (HTML)', signature, 'Paste your Outlook signature once. Templates insert it at {{signature}}.'),
        el('h3', { text: 'Accounts this person works' }),
        el('p', { class: 'help', text: 'Leave all unticked to give them every account in their division.' }),
        el('div', { class: 'check-grid' }, accountBoxes),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', text: 'Save person',
            onclick: async () => {
              u.name = name.value.trim() || u.name;
              u.email = email.value.trim();
              u.divisionId = division.value;
              u.isAdmin = admin.checked;
              u.signature = signature.value;
              u.defaultCc = defaultCc.value.trim();
              u.accountIds = accountBoxes
                .map((lbl) => lbl.querySelector('input'))
                .filter((b) => b.checked)
                .map((b) => b.dataset.accountId);
              if (await persistWorkspace()) {
                clear(host); renderAccounts(); renderHeaderBar();
                if (u.id === state.userId) await selectAccount(state.accountId);
                toast('Saved.', 'ok');
              }
            },
          }),
          el('button', {
            class: 'btn danger', text: 'Remove person',
            onclick: async () => {
              if (!window.confirm('Remove ' + u.name + ' from the workspace?')) return;
              ws.users = ws.users.filter((x) => x !== u);
              if (await persistWorkspace()) {
                if (state.userId === u.id) { state.userId = ''; saveLocal({ userId: '' }); }
                clear(host); renderAccounts(); renderHeaderBar();
              }
            },
          }),
        ]),
      ]),
    ]));
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------------ *
   * Panel: follow-ups
   * ------------------------------------------------------------------ */

  const PARTY_LABEL = { winery: 'Winery', forwarder: 'Forwarder', internal: 'Internal' };
  const PARTY_TO_ROLE = { winery: 'vendor', forwarder: 'trucker', internal: 'internal' };

  function renderFollowUps() {
    const host = $('#followBody');
    clear(host);
    if (!state.base) { host.appendChild(el('div', { class: 'empty', text: 'Load an account with a tracker first.' })); return; }

    state.openItems = AMI.findOpenItems(state.base.sheet, state.base.header, new Date());
    host.appendChild(el('p', { class: 'help', text: 'Orders on ' + (currentAccount() || {}).name + ' where a tracker column is still empty past its normal turnaround. Each line names the blank column and the dated column it is measured from.' }));

    if (!state.openItems.length) {
      host.appendChild(el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }), el('div', { text: 'Nothing outstanding.' })]));
      return;
    }

    const byParty = {};
    for (const i of state.openItems) (byParty[i.party] = byParty[i.party] || []).push(i);

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
          el('td', { text: item.missingHeader + (item.placeholder ? ' ("' + item.placeholder + '")' : '') }),
          el('td', { text: item.anchorHeader + ': ' + AMI.formatShort(item.anchorDate) }),
          el('td', { class: 'num', text: item.ageDays + ' d' }),
        ]));
      }
      tbl.appendChild(tbody);
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', {}, [document.createTextNode(PARTY_LABEL[party] || party), el('span', { class: 'spacer' }),
          el('span', { class: 'chip manual', text: items.length + ' open' })]),
        el('div', { class: 'body' }, [
          el('div', { class: 'table-scroll' }, [tbl]),
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: 'btn small', text: 'Select all',
              onclick: () => { for (const i of items) state.selectedItems.add(i.row + ':' + i.ruleId); renderFollowUps(); },
            }),
            el('span', { class: 'spacer' }),
            el('button', { class: 'btn primary', text: 'Draft chase email', onclick: () => buildChaseEmail(party, items) }),
          ]),
        ]),
      ]));
    }
  }

  function buildChaseEmail(party, items) {
    const chosen = items.filter((i) => state.selectedItems.has(i.row + ':' + i.ruleId));
    if (!chosen.length) { toast('Nothing selected in that group.', 'error'); return; }

    const account = currentAccount() || {};
    const user = currentUser() || {};
    const role = PARTY_TO_ROLE[party] || 'internal';
    const recipients = AMI.resolveRecipients(account, role, state.pos.filter((p) => p.po).slice(-1)[0] || null, user);

    const rowsHtml = '<table style="border-collapse:collapse;margin:12px 0;"><thead><tr>'
      + ['PO #', 'Outstanding', 'Reference'].map((h) => '<th style="border:1px solid #999;padding:4px 8px;'
        + 'background:#f2f2f2;text-align:left;font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + h + '</th>').join('')
      + '</tr></thead><tbody>'
      + chosen.map((i) => '<tr>' + [i.po, i.missingHeader, i.anchorHeader + ': ' + AMI.formatShort(i.anchorDate)]
        .map((v) => '<td style="border:1px solid #999;padding:4px 8px;font-family:Calibri,Arial,sans-serif;'
          + 'font-size:11pt;">' + AMI.escapeXml(v) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table>';

    const topics = [];
    for (const i of chosen) if (!topics.includes(i.subject)) topics.push(i.subject);

    const vars = {
      recipientName: ((account.contacts && account.contacts[role] && account.contacts[role].name) || ''),
      account: account.name || '',
      customer: (state.base ? state.base.config.customer : '') || account.name || '',
      product: (state.base ? state.base.config.productName : '') || account.product || '',
      topic: topics.join(' / '),
      poList: [...new Set(chosen.map((i) => i.po))].join(', '),
      table: rowsHtml,
      signature: user.signature || '',
      senderName: user.name || '',
      today: AMI.formatEmailDate(new Date()),
    };

    const templates = state.templates.filter((t) => !t.error && t.role === role && /follow|chase|remind/i.test(t.label || ''));
    const template = templates[0];
    const subject = AMI.fillTemplate(template ? template.subject : '{{customer}} / {{product}} - {{topic}} - PO {{poList}}', vars);
    const html = AMI.fillTemplate(template ? template.html : [
      '<p>Dear {{recipientName}},</p>',
      '<p>Following up on the order(s) below. Our tracker still shows the item outstanding &mdash; could you confirm at your earliest convenience?</p>',
      '{{table}}',
      '<p>Thank you and kind regards,</p>',
      '{{signature}}',
    ].join('\n'), vars);

    const eml = AMI.buildEml({
      from: user.email ? (user.name ? user.name + ' <' + user.email + '>' : user.email) : '',
      to: recipients.to, cc: recipients.cc, subject,
      html: '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + html + '</body></html>',
    });
    download(new Blob([eml], { type: 'message/rfc822' }),
      safeName('Follow-up ' + (account.name || '') + ' ' + (PARTY_LABEL[party] || party) + ' ' + stamp()) + '.eml');
    toast('Chase draft saved for ' + chosen.length + ' item(s)'
      + (template ? ' using "' + template.label + '".' : ' using the built-in wording.'), 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */

  function init() {
    $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    if (typeof window.showDirectoryPicker !== 'function') {
      const note = $('#noFolderNote');
      if (note) note.hidden = false;
    }
    renderWorkspace();
    refreshTabs();
    showTab('workspace');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
