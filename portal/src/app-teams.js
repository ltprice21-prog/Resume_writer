/* AMI Order Desk (Teams) — multi-account, multi-item interface.
 * Depends on engine.js, templates.js and workspace.js (global `AMI`).
 * No network access of any kind.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const ENC = new TextEncoder();

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

  /* ------------------------------------------------------------------ *
   * Overlay
   * ------------------------------------------------------------------ *
   *
   * One modal, used for enlarging a chart and for listing the orders behind a
   * mark. Closing is deliberately easy — Escape, the backdrop, or the button —
   * because it only ever shows a bigger view of what is already on the page.
   */

  let closeOverlay = null;

  function openOverlay(title, sub, buildBody, opts) {
    const o = opts || {};
    if (closeOverlay) closeOverlay();

    const body = el('div', { class: 'overlay-body' });
    const shell = el('div', { class: 'overlay-panel' + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div', { class: 'overlay-head' }, [
        el('div', {}, [
          el('h2', { text: title }),
          sub ? el('p', { class: 'overlay-sub', text: sub }) : null,
        ].filter(Boolean)),
        el('span', { class: 'spacer' }),
        ...(o.actions || []),
        el('button', { class: 'btn small', text: 'Close', onclick: () => closeOverlay && closeOverlay() }),
      ]),
      body,
    ]);
    const back = el('div', { class: 'overlay' }, [shell]);

    buildBody(body);

    const onKey = (e) => { if (e.key === 'Escape') closeOverlay && closeOverlay(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeOverlay && closeOverlay(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    document.body.classList.add('overlay-open');

    closeOverlay = () => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      document.body.classList.remove('overlay-open');
      closeOverlay = null;
    };
    return closeOverlay;
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
  const fileOf = (p) => String(p || '').split('/').pop();

  const SOURCE_LABEL = {
    pdf: 'from PO', computed: 'computed', formula: 'formula',
    carried: 'carried', manual: 'blank', edited: 'edited',
  };

  /* How an order's stage was arrived at. */
  const SOURCE_CHIP = { set: 'ok', derived: 'computed', none: 'manual' };
  const SOURCE_SHORT = { set: 'set', derived: 'from tracker', none: 'none' };
  const SOURCE_LONG = {
    set: 'set by a person', derived: 'from tracker', none: 'not set',
  };
  const sourceChip = (s) => el('span', { class: 'chip ' + s, text: SOURCE_LABEL[s] || s });

  /* ------------------------------------------------------------------ *
   * Stores
   * ------------------------------------------------------------------ */

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
    return AMI.zip(entries.filter((e) => /\.(json|html)$/i.test(e.name)
      && !e.name.startsWith(SESSION_DIR + '/')));
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
    itemId: '',
    templates: [],
    itemStates: new Map(),   // itemId -> { item, trackerBytes, sheetName, base, preview, posted, error }
    pos: [],                 // { id, fileName, bytes, po, error, include, itemId, match, overrides, plan, issues }
    emailRows: {},
    emailOverrides: {},
    selectedRole: 'vendor',
    selectedTemplateId: '',
    openItems: [],
    selectedItems: new Set(),
    loading: false,
    // Account Health
    statusDoc: null,
    portfolio: null,          // [{ account, item, sheet, header, config, orders, followUps }]
    portfolioLoading: false,
    filters: { divisionId: '', accountId: '', itemId: '', statusId: '', query: '' },
    excludeClosed: false,
    scheduleBy: 'week',       // 'week' | 'month' on the upcoming-dates card
    lastStrippedNote: null,   // { templateId, text, html } after an import trimmed a note
    draftAttachments: [],     // files added to the current draft only, never saved
    drill: null,              // { title, sub, orders } while a chart detail is open
    summaryHtml: '',
    // Memory across closing the app
    rememberedFolder: null,
    pendingSession: null,
    canRemember: false,
  };

  let nextId = 1;

  const loadLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch (e) { return {}; } };
  const saveLocal = (patch) => {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(Object.assign(loadLocal(), patch))); } catch (e) { /* memory only */ }
  };

  const currentUser = () => (state.workspace ? state.workspace.users.find((u) => u.id === state.userId) : null);
  const currentAccount = () => (state.workspace ? state.workspace.accounts.find((a) => a.id === state.accountId) : null);
  const currentItem = () => AMI.findItem(currentAccount(), state.itemId);
  const visibleAccounts = () => (state.workspace && state.userId ? AMI.accountsForUser(state.workspace, state.userId) : []);
  const itemState = (id) => state.itemStates.get(id) || null;

  /**
   * Whether finished orders are being left out of the view. A per-person choice,
   * not a workspace rule — hiding them changes what you look at, not what is true.
   */
  const excludingClosed = () => !!state.excludeClosed;

  /** Drop the terminal stage when the view is set to hide it. */
  const applyClosedFilter = (orders) => (excludingClosed() ? orders.filter((o) => o.isOpen) : orders);

  function setExcludeClosed(on) {
    state.excludeClosed = !!on;
    saveLocal({ excludeClosed: state.excludeClosed });
  }

  /** The switch that hides finished orders, wired to re-render its own page. */
  function closedToggle(rerender) {
    const box = el('input', {
      type: 'checkbox', checked: excludingClosed(),
      onchange: (e) => { setExcludeClosed(e.target.checked); rerender(); },
    });
    return el('label', {
      class: 'check-inline',
      'data-tip': 'Leaves out orders at the Invoiced and Closed stage. Nothing is deleted — '
        + 'the counts and totals on this page follow the switch.',
    }, [box, document.createTextNode('Hide invoiced and closed')]);
  }

  function poColumn(header) {
    const c = header.columns.find((x) => /^PO\s*#/i.test(x.header));
    return c ? c.col : 'A';
  }

  /** Item constants keyed by item id, for PO routing. */
  function itemConfigs() {
    const out = {};
    for (const [id, st] of state.itemStates) if (st.base) out[id] = st.base.config;
    return out;
  }

  const posForItem = (itemId) => state.pos.filter((p) => p.include && p.po && p.itemId === itemId);
  const unpostedCount = () =>
    state.pos.filter((p) => p.include && p.po && !(itemState(p.itemId) || {}).posted).length;
  const unroutedPos = () => state.pos.filter((p) => p.include && p.po && !p.itemId);

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  const RENDERERS = {
    dashboard: renderDashboard,
    orderstatus: renderOrderStatus,
    workspace: renderWorkspace,
    orders: renderIntake,
    review: renderReview,
    email: renderEmail,
    followups: renderFollowUps,
    templates: renderTemplates,
    accounts: renderAccounts,
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
    const anyTracker = [...state.itemStates.values()].some((s) => s.trackerBytes);
    const hasPos = state.pos.some((p) => p.include && p.po);
    $$('nav.tabs button').forEach((b) => {
      const t = b.dataset.tab;
      if (t === 'workspace') return;
      if (t === 'accounts') b.disabled = !hasUser;
      else if (t === 'dashboard' || t === 'orderstatus') b.disabled = !hasUser;
      else if (t === 'templates') b.disabled = !hasAccount;
      else if (t === 'orders' || t === 'followups') b.disabled = !anyTracker;
      else b.disabled = !anyTracker || !hasPos;
    });
  }

  /* ------------------------------------------------------------------ *
   * Header
   * ------------------------------------------------------------------ */

  function renderHeaderBar() {
    const host = $('#contextBar');
    clear(host);
    if (!state.workspace) { host.hidden = true; return; }
    host.hidden = false;

    const user = currentUser();
    const account = currentAccount();
    const accounts = visibleAccounts();
    const groups = AMI.accountsByDivision(state.workspace, accounts);
    const items = AMI.accountItems(account);

    const userSelect = el('select', {
      onchange: async (e) => {
        state.userId = e.target.value;
        saveLocal({ userId: state.userId });
        const list = visibleAccounts();
        await selectAccount(list.length ? list[0].id : '');
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

    const itemSelect = el('select', {
      disabled: !items.length,
      onchange: (e) => {
        state.itemId = e.target.value;
        saveLocal({ itemId: state.itemId });
        state.selectedTemplateId = '';
        state.emailOverrides = {};
        renderHeaderBar();
        renderWorkspace(); renderEmail(); renderTemplates(); renderFollowUps();
      },
    }, items.length
      ? items.map((i) => {
        const st = itemState(i.id);
        const suffix = st && st.error ? ' — tracker not loaded' : '';
        return el('option', { value: i.id, selected: i.id === state.itemId, text: i.name + suffix });
      })
      : [el('option', { value: '', text: 'No items yet' })]);

    const st = itemState(state.itemId);
    host.appendChild(el('div', { class: 'context-row' }, [
      el('span', { class: 'context-label', text: 'You' }), userSelect,
      el('span', { class: 'context-label', text: 'Account' }), accountSelect,
      el('span', { class: 'context-label', text: 'Item' }), itemSelect,
      user && user.divisionId
        ? el('span', { class: 'chip manual', text: AMI.divisionName(state.workspace, user.divisionId) })
        : null,
      el('span', { class: 'spacer' }),
      state.loading
        ? el('span', { class: 'context-note', text: 'Loading trackers…' })
        : el('span', {
          class: 'context-note',
          text: st && st.trackerBytes ? 'Tracker: ' + fileOf(st.item.trackerPath)
            : (items.length ? 'No tracker loaded for this item' : ''),
        }),
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
    if (store.kind === 'folder' && store.root) {
      await AMI.rememberFolder(store.root, store.root.name);
      state.rememberedFolder = { handle: store.root, name: store.root.name };
    }
    const { workspace, created } = await AMI.loadWorkspace(store);
    state.workspace = workspace;
    state.loadedAt = workspace.updated;
    state.portfolio = null;
    try {
      state.statusDoc = await AMI.loadStatuses(store);
    } catch (e) {
      state.statusDoc = AMI.emptyStatusDoc();
      toast(e.message, 'error');
    }

    const saved = loadLocal();
    state.excludeClosed = !!saved.excludeClosed;
    if (saved.scheduleBy === 'month' || saved.scheduleBy === 'week') state.scheduleBy = saved.scheduleBy;
    if (saved.userId && workspace.users.some((u) => u.id === saved.userId)) state.userId = saved.userId;
    else if (workspace.users.length === 1) state.userId = workspace.users[0].id;

    const accounts = visibleAccounts();
    const preferred = saved.accountId && accounts.some((a) => a.id === saved.accountId)
      ? saved.accountId : (accounts.length ? accounts[0].id : '');

    state.pendingSession = (await readFolderSession()) || (await AMI.loadSession());

    renderHeaderBar();
    if (preferred) await selectAccount(preferred, saved.itemId);
    else { renderWorkspace(); refreshTabs(); }
    if (!created && currentUser()) showTab(state.pendingSession ? 'orders' : 'dashboard');
    if (state.pendingSession) renderIntake();

    if (created) {
      toast('New workspace created. Add divisions, accounts and items under Accounts.', 'ok');
      showTab('accounts');
    } else {
      const itemCount = workspace.accounts.reduce((n, a) => n + AMI.accountItems(a).length, 0);
      toast('Workspace loaded — ' + workspace.accounts.length + ' account(s), '
        + itemCount + ' item(s), ' + workspace.users.length + ' user(s).', 'ok');
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
        renderHeaderBar(); renderAccounts();
        toast('Reloaded the shared workspace.', 'ok');
        return false;
      }
      toast('Could not save the workspace: ' + e.message, 'error');
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Account and item loading
   * ------------------------------------------------------------------ */

  async function selectAccount(accountId, preferredItemId) {
    state.accountId = accountId || '';
    saveLocal({ accountId: state.accountId });
    saveSessionSoon.cancel();

    state.itemStates = new Map();
    state.pos = [];
    state.emailRows = {};
    state.emailOverrides = {};
    state.templates = [];
    state.selectedTemplateId = '';
    state.openItems = [];
    state.selectedItems = new Set();
    state.itemId = '';

    const account = currentAccount();
    if (!account || !state.store) {
      renderHeaderBar(); renderWorkspace(); renderIntake(); renderReview(); renderTemplates(); refreshTabs();
      return;
    }

    state.templates = await AMI.listTemplates(state.store, account.id);
    const items = AMI.accountItems(account);
    state.itemId = items.some((i) => i.id === preferredItemId) ? preferredItemId
      : (items.length ? items[0].id : '');

    state.loading = true;
    renderHeaderBar();
    renderWorkspace();

    for (const item of items) {
      const st = { item, trackerBytes: null, sheetName: '', base: null, preview: null, posted: false, error: '' };
      state.itemStates.set(item.id, st);
      if (!item.trackerPath) { st.error = 'No tracker file assigned.'; continue; }
      const bytes = await state.store.read(item.trackerPath);
      if (!bytes) { st.error = 'Tracker not found at ' + item.trackerPath; continue; }
      try {
        const wb = await AMI.Workbook.load(bytes);
        let chosen = '';
        if (item.sheet && wb.sheet(item.sheet) && AMI.findHeaderRow(wb.sheet(item.sheet))) chosen = item.sheet;
        else for (const s of wb.sheets) if (AMI.findHeaderRow(s)) chosen = s.name;
        if (!chosen) throw new Error('no sheet has a "PO#" header row');
        st.trackerBytes = bytes;
        st.sheetName = chosen;
      } catch (e) {
        st.error = 'Could not read ' + fileOf(item.trackerPath) + ': ' + e.message;
      }
    }

    state.loading = false;
    await rebuildPlans();

    const failed = [...state.itemStates.values()].filter((s) => s.error && s.item.trackerPath);
    if (failed.length) toast(failed.length + ' item tracker(s) could not be loaded. See Workspace.', 'error');

    renderHeaderBar();
    renderWorkspace(); renderIntake(); renderReview(); renderTemplates(); refreshTabs();
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
      if (f.kind === 'date') f.value = AMI.parseDate(raw) || null;
      else if (f.kind === 'number') f.value = AMI.parseNumber(raw);
      else f.value = raw;
      f.source = 'edited';
      f.note = 'Typed in by you';
    }
    return plan;
  }

  /** Re-plan every routed PO against its own item's tracker. */
  async function rebuildPlans() {
    for (const item of state.pos) { item.plan = null; item.issues = []; }

    for (const [itemId, st] of state.itemStates) {
      st.base = null;
      st.preview = null;
      if (!st.trackerBytes) continue;

      const baseWb = await AMI.Workbook.load(st.trackerBytes);
      const baseSheet = baseWb.sheet(st.sheetName);
      const baseHeader = AMI.findHeaderRow(baseSheet);
      st.base = { wb: baseWb, sheet: baseSheet, header: baseHeader, config: AMI.readSheetConfig(baseSheet) };

      const wb = await AMI.Workbook.load(st.trackerBytes);
      const sheet = wb.sheet(st.sheetName);
      const header = AMI.findHeaderRow(sheet);
      const config = AMI.readSheetConfig(sheet);
      const poCol = poColumn(header);

      for (const entry of posForItem(itemId)) {
        const existing = new Set(AMI.dataRows(sheet, header).map((r) => sheet.cellText(r, poCol).trim()));
        let plan = AMI.planRow(sheet, header, config, entry.po);
        applyOverrides(plan, entry.overrides);
        plan = AMI.computePlanFormulas(sheet, plan);
        const issues = AMI.validatePlan(sheet, header, config, plan, entry.po, existing);
        entry.plan = plan;
        entry.issues = issues;
        if (!issues.some((i) => i.level === 'error')) {
          AMI.appendRow(sheet, AMI.renderRowXml(plan), plan.newRow);
          wb.commitSheet(sheet);
        }
      }
      st.preview = { wb, sheet, header, config };
    }

    for (const entry of unroutedPos()) {
      entry.issues = [{
        level: 'error',
        message: 'This PO is not assigned to an item.',
        detail: (entry.match ? entry.match.reason + '. ' : '')
          + 'Pick the item it belongs to on the Orders tab — it cannot be posted until then.',
      }];
    }
  }

  /* ------------------------------------------------------------------ *
   * Workspace panel
   * ------------------------------------------------------------------ */

  function renderWorkspace() {
    const host = $('#workspaceBody');
    clear(host);

    if (!state.store) {
      if (state.rememberedFolder) {
        host.appendChild(el('div', { class: 'msg ok' }, [
          el('span', { class: 'icon', text: '✓' }),
          el('div', {}, [
            el('strong', { text: 'You last used the folder "' + state.rememberedFolder.name + '".' }),
            el('span', { class: 'detail', text: 'Reconnect and the browser will ask once for permission — you will not have to find the folder again.' }),
            el('div', { class: 'btn-row' }, [
              el('button', {
                class: 'btn primary', text: 'Reconnect to ' + state.rememberedFolder.name,
                onclick: reconnectFolder,
              }),
              el('button', {
                class: 'btn small', text: 'Forget it',
                onclick: async () => {
                  await AMI.forgetFolder();
                  state.rememberedFolder = null;
                  renderWorkspace();
                },
              }),
            ]),
          ]),
        ]));
      }
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
    const account = currentAccount();
    const accounts = visibleAccounts();
    const itemCount = ws.accounts.reduce((n, a) => n + AMI.accountItems(a).length, 0);

    host.appendChild(el('div', { class: 'status-strip' }, [
      el('span', {}, [document.createTextNode('Source '), el('b', { text: state.store.kind === 'folder' ? 'synced folder' : 'uploaded bundle' })]),
      el('span', {}, [document.createTextNode('Divisions '), el('b', { text: String(ws.divisions.length) })]),
      el('span', {}, [document.createTextNode('Accounts '), el('b', { text: String(ws.accounts.length) })]),
      el('span', {}, [document.createTextNode('Items '), el('b', { text: String(itemCount) })]),
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

    if (state.loading) {
      host.appendChild(el('div', { class: 'msg info' }, [
        el('span', { class: 'icon', text: 'i' }),
        el('div', { text: 'Reading the item trackers for ' + (account ? account.name : 'this account') + '…' }),
      ]));
      return;
    }

    if (account) {
      host.appendChild(el('h3', { text: account.name + ' — item trackers' }));
      const items = AMI.accountItems(account);
      if (!items.length) {
        host.appendChild(el('div', { class: 'msg warn' }, [
          el('span', { class: 'icon', text: '!' }),
          el('div', {}, [el('strong', { text: 'This account has no items yet.' }),
            el('span', { class: 'detail', text: 'Add one per product tracking chart under Accounts.' })]),
        ]));
      } else {
        const tbl = el('table', { class: 'data' });
        tbl.appendChild(el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Item' }), el('th', { text: 'Item no.' }), el('th', { text: 'Tracker' }),
          el('th', { text: 'Sheet' }), el('th', { text: 'Orders' }), el('th', { text: 'Balance' }), el('th', {}),
        ])]));
        const tbody = el('tbody');
        for (const item of items) {
          const st = itemState(item.id);
          let orders = '—';
          let balance = '—';
          if (st && st.base) {
            const rows = AMI.dataRows(st.base.sheet, st.base.header);
            orders = String(rows.length);
            const balCol = st.base.header.columns.find((c) => /Balance on Contract\s*\(bt\)/i.test(c.header));
            const last = rows[rows.length - 1];
            const cell = balCol && last ? st.base.sheet.cell(last, balCol.col) : null;
            if (cell && cell.num != null) balance = cell.num.toLocaleString() + ' bt';
          }
          tbody.appendChild(el('tr', {}, [
            el('td', {}, [
              el('b', { text: item.name || item.id }),
              st && st.base && st.base.config.productName
                ? el('div', { class: 'note', text: st.base.config.productName }) : null,
            ]),
            el('td', { class: 'mono', text: (st && st.base && st.base.config.navCode) || item.navCode || '—' }),
            el('td', { class: 'mono', text: fileOf(item.trackerPath) || 'not set' }),
            el('td', { text: (st && st.sheetName) || item.sheet || '—' }),
            el('td', { class: 'num', text: orders }),
            el('td', { class: 'num', text: balance }),
            el('td', {}, [
              st && st.error
                ? el('span', { class: 'chip error', text: 'not loaded' })
                : el('button', {
                  class: 'btn small', text: item.id === state.itemId ? 'Selected' : 'Select',
                  disabled: item.id === state.itemId,
                  onclick: () => {
                    state.itemId = item.id;
                    saveLocal({ itemId: item.id });
                    renderHeaderBar(); renderWorkspace(); renderEmail(); renderTemplates();
                  },
                }),
              // A wrong workbook or sheet shows up here first, so the fix lives
              // here too rather than three tabs away.
              el('button', {
                class: 'btn small', text: 'Tracker',
                'data-tip': 'Change which workbook and sheet this item posts into.',
                onclick: () => editItemTracker(account.id, item.id),
              }),
            ]),
          ]));
        }
        tbl.appendChild(tbody);
        host.appendChild(el('div', { class: 'table-scroll' }, [tbl]));

        for (const item of items) {
          const st = itemState(item.id);
          if (st && st.error) {
            host.appendChild(el('div', { class: 'msg warn' }, [
              el('span', { class: 'icon', text: '!' }),
              el('div', {}, [
                el('strong', { text: (item.name || item.id) + ': ' + st.error }),
                el('span', {
                  class: 'detail',
                  text: 'If the workbook moved or the wrong one was linked, point this item at the right one.',
                }),
                el('div', { class: 'btn-row' }, [
                  el('button', {
                    class: 'btn small', text: 'Change tracker',
                    onclick: () => editItemTracker(account.id, item.id),
                  }),
                ]),
              ]),
            ]));
          }
        }
      }
    }

    if (user && accounts.length) {
      host.appendChild(el('h3', { text: 'Your other accounts' }));
      const others = accounts.filter((a) => a.id !== state.accountId);
      if (!others.length) host.appendChild(el('p', { class: 'help', text: 'This is your only account.' }));
      else {
        host.appendChild(el('div', { class: 'btn-row' }, others.map((a) => el('button', {
          class: 'btn small',
          text: a.name + ' (' + AMI.accountItems(a).length + ' item' + (AMI.accountItems(a).length === 1 ? '' : 's') + ')',
          onclick: () => selectAccount(a.id),
        }))));
      }
    }

    host.appendChild(el('h3', { text: 'What survives closing the app' }));
    const diag = el('table', { class: 'data' });
    diag.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Thing' }), el('th', { text: 'Where it lives' }), el('th', { text: 'Now' }),
    ])]));
    const diagBody = el('tbody');
    const row = (thing, where, state_, tone) => diagBody.appendChild(el('tr', {}, [
      el('td', {}, [el('b', { text: thing })]),
      el('td', { text: where }),
      el('td', {}, [el('span', { class: 'chip ' + (tone || 'manual'), text: state_ })]),
    ]));

    row('Statuses, templates, accounts, tracker rows', 'The shared folder, written as you change them',
      'always saved', 'ok');
    row('Unposted purchase orders',
      state.store.kind === 'folder' ? SESSION_DIR + '/ in the shared folder' : 'this browser only (no folder open)',
      state.store.kind === 'folder' ? 'saved to the folder' : 'this browser only',
      state.store.kind === 'folder' ? 'ok' : 'carried');
    row('The folder itself, so you need not find it again', 'This browser, on this machine',
      state.canRemember ? 'remembered' : 'not available here',
      state.canRemember ? 'ok' : 'error');
    row('Your name and current account', 'This browser, on this machine',
      state.canRemember ? 'remembered' : 'not available here',
      state.canRemember ? 'ok' : 'carried');
    diag.appendChild(diagBody);
    host.appendChild(el('div', { class: 'table-scroll' }, [diag]));

    if (!state.canRemember) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: 'This browser will not let the app store anything locally.' }),
          el('span', {
            class: 'detail',
            text: 'It reported: ' + (AMI.lastPersistError() || 'no reason given')
              + '. You will be asked for the folder each time you open the app. Everything else is '
              + 'unaffected — unposted work is saved into the shared folder, so it still comes back.',
          }),
        ]),
      ]));
    }

    host.appendChild(el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn', text: state.store.kind === 'folder' ? 'Change source folder' : 'Load a different bundle',
        onclick: () => {
          if (state.store.kind === 'folder') { changeWorkspaceFolder(); return; }
          const inp = el('input', { type: 'file', accept: '.zip' });
          inp.addEventListener('change', async () => {
            try {
              resetWorkspaceState();
              await adoptStore(await importWorkspaceZip(new Uint8Array(await inp.files[0].arrayBuffer())));
              toast('Loaded a different bundle.', 'ok');
            } catch (e) { toast('That bundle could not be read: ' + e.message, 'error'); }
          });
          inp.click();
        },
      }),
      el('button', {
        class: 'btn', text: 'Export workspace bundle',
        onclick: async () => {
          download(await exportWorkspaceZip(state.store), 'AMI-workspace ' + stamp() + '.zip', 'application/zip');
          toast('Bundle exported — config and templates only, no trackers.', 'ok');
        },
      }),
      state.store.kind === 'memory'
        ? el('span', { class: 'context-note', text: 'Bundle mode: changes live in this browser until exported.' })
        : null,
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Orders panel
   * ------------------------------------------------------------------ */

  async function addPdfs(files) {
    const account = currentAccount();
    const items = AMI.accountItems(account);
    const configs = itemConfigs();

    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { toast('Skipped ' + file.name + ' — not a PDF.', 'error'); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let po = null;
      let error = '';
      try {
        po = AMI.parsePurchaseOrder(await AMI.extractPdfPages(bytes), file.name);
        if (!po.poNumber && !po.lineItem) { error = 'No purchase-order fields could be read from this PDF.'; po = null; }
      } catch (e) { error = 'Could not read this PDF: ' + e.message; }

      const match = po ? AMI.matchItemForPo(items, configs, po) : { item: null, reason: '', confident: false };
      state.pos.push({
        id: nextId++, fileName: file.name, bytes, po, error,
        include: !!po,
        itemId: match.item ? match.item.id : '',
        match,
        overrides: {}, plan: null, issues: [],
      });
    }
    await rebuildPlans();
    saveSessionSoon();
    renderIntake(); renderReview(); refreshTabs();

    const unrouted = unroutedPos().length;
    if (unrouted) toast(unrouted + ' PO(s) could not be matched to an item — choose one on each card.', 'error');
  }

  function renderIntake() {
    const host = $('#ordersBody');
    clear(host);
    const account = currentAccount();
    const offer = sessionOfferCard();
    if (offer) host.appendChild(offer);
    if (!account) { host.appendChild(el('div', { class: 'empty', text: 'Choose an account first.' })); return; }

    const items = AMI.accountItems(account);
    const loadable = items.filter((i) => { const st = itemState(i.id); return st && st.trackerBytes; });
    if (!loadable.length) {
      host.appendChild(el('div', { class: 'msg warn' }, [el('span', { class: 'icon', text: '!' }),
        el('div', {}, [el('strong', { text: 'No item on ' + account.name + ' has a working tracker.' }),
          el('span', { class: 'detail', text: 'Assign tracker files to this account\'s items under Accounts.' })])]));
      return;
    }

    host.appendChild(el('p', { class: 'help', text: 'Drop in the POs you are placing for ' + account.name + '. They can span several items — each PO is matched to its item by the item number printed on it, and you can correct the match before anything is written.' }));

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

    for (const entry of state.pos) {
      const po = entry.po;
      const card = el('div', { class: 'po-card' + (entry.include ? '' : ' excluded') });
      const matchedItem = AMI.findItem(account, entry.itemId);

      card.appendChild(el('header', {}, [
        el('input', {
          type: 'checkbox', checked: entry.include,
          onchange: async (e) => {
            entry.include = e.target.checked;
            await rebuildPlans(); saveSessionSoon();
            renderIntake(); renderReview(); refreshTabs();
          },
        }),
        el('span', { class: 'po-id', text: po ? (po.poNumber || '(no PO number)') : 'Unreadable' }),
        el('span', { class: 'file', text: entry.fileName }),
        el('span', { class: 'spacer' }),
        matchedItem
          ? el('span', { class: 'chip ' + (entry.match && entry.match.confident ? 'ok' : 'carried'), text: matchedItem.name })
          : el('span', { class: 'chip error', text: 'no item' }),
        el('button', {
          class: 'btn small', text: 'Remove',
          onclick: async () => {
            state.pos = state.pos.filter((p) => p !== entry);
            await rebuildPlans(); saveSessionSoon();
            renderIntake(); renderReview(); refreshTabs();
          },
        }),
      ]));

      const body = el('div', { class: 'body' });
      if (entry.error) body.appendChild(el('div', { class: 'msg error' }, [el('span', { class: 'icon', text: '!' }), el('div', { text: entry.error })]));

      if (po) {
        // Item routing sits at the top: it decides which workbook this PO reaches.
        const itemSelect = el('select', {
          onchange: async (e) => {
            entry.itemId = e.target.value;
            entry.match = e.target.value
              ? { item: AMI.findItem(account, e.target.value), reason: 'chosen by you', confident: true }
              : { item: null, reason: 'not assigned', confident: false };
            await rebuildPlans(); saveSessionSoon();
            renderIntake(); renderReview(); refreshTabs();
          },
        }, [
          el('option', { value: '', text: '— choose an item —', selected: !entry.itemId }),
          ...items.map((i) => {
            const st = itemState(i.id);
            return el('option', {
              value: i.id, selected: i.id === entry.itemId,
              disabled: !(st && st.trackerBytes),
              text: i.name + (st && st.trackerBytes ? ' → ' + fileOf(i.trackerPath) : ' (no tracker)'),
            });
          }),
        ]);

        body.appendChild(el('label', { class: 'field' }, [
          el('span', { text: 'Posts to which item tracker' }),
          itemSelect,
          el('div', {
            class: 'note',
            text: entry.match && entry.match.reason
              ? (entry.match.confident ? 'Matched automatically: ' + entry.match.reason
                : 'Not matched automatically: ' + entry.match.reason)
              : '',
          }),
        ]));

        const money = (n) => (n == null ? '' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        body.appendChild(el('dl', { class: 'kv' }, [
          ['Order no.', po.poNumber], ['Item no. on PO', po.itemNo],
          ['Description', po.description],
          ['Order date', AMI.formatShort(po.orderDate)], ['Pickup date', AMI.formatShort(po.pickupDate)],
          ['Delivery date', AMI.formatShort(po.deliveryDate) || '(blank on PO)'],
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
   * Review panel
   * ------------------------------------------------------------------ */

  function fieldValueText(f) {
    const v = f.source === AMI.SOURCE.FORMULA ? f.computedValue : f.value;
    if (v == null || v === '') return '';
    if (v instanceof Date) return AMI.formatShort(v);
    if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
    return String(v);
  }

  function poCardForReview(entry) {
    const plan = entry.plan;
    const card = el('div', { class: 'po-card' });
    const blocked = entry.issues.some((i) => i.level === 'error');

    card.appendChild(el('header', {}, [
      el('span', { class: 'po-id', text: plan ? AMI.planPoNumber(plan, entry.po) : entry.po.poNumber }),
      el('span', { class: 'file', text: plan ? 'row ' + plan.newRow : entry.fileName }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'chip ' + (blocked ? 'error' : 'ok'), text: blocked ? 'blocked' : 'ready' }),
    ]));

    const body = el('div', { class: 'body' });
    for (const issue of entry.issues) {
      body.appendChild(el('div', { class: 'msg ' + issue.level }, [
        el('span', { class: 'icon', text: issue.level === 'info' ? 'i' : '!' }),
        el('div', {}, [el('strong', { text: issue.message }), issue.detail ? el('span', { class: 'detail', text: issue.detail }) : null]),
      ]));
    }
    if (plan) {
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
            onchange: async (e) => {
              entry.overrides[f.col] = e.target.value;
              await rebuildPlans(); saveSessionSoon(); renderReview();
            },
          }));
        }
        row.appendChild(sourceChip(f.source));
        row.appendChild(el('div', { class: 'note', text: f.note }));
        body.appendChild(row);
      }
    }
    card.appendChild(body);
    return card;
  }

  function renderReview() {
    const host = $('#reviewBody');
    clear(host);
    const account = currentAccount();
    const included = state.pos.filter((p) => p.include && p.po);
    if (!account || !included.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No orders selected.' }));
      return;
    }

    const unrouted = unroutedPos();
    if (unrouted.length) {
      host.appendChild(el('div', { class: 'msg error' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: unrouted.length + ' PO(s) are not assigned to an item.' }),
          el('span', { class: 'detail', text: 'They will not be posted anywhere until you choose an item for them on the Orders tab.' }),
        ]),
      ]));
      for (const entry of unrouted) host.appendChild(poCardForReview(entry));
    }

    let readyTotal = 0;
    for (const item of AMI.accountItems(account)) {
      const entries = posForItem(item.id);
      if (!entries.length) continue;
      const st = itemState(item.id);
      const errors = entries.reduce((n, e) => n + e.issues.filter((i) => i.level === 'error').length, 0);
      const ready = entries.filter((e) => !e.issues.some((i) => i.level === 'error')).length;
      readyTotal += errors ? 0 : ready;

      host.appendChild(el('div', { class: 'card' }, [
        el('h2', {}, [
          document.createTextNode(item.name),
          el('span', { class: 'context-note', text: '→ ' + fileOf(item.trackerPath) + (st ? ' · ' + st.sheetName : '') }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'chip ' + (errors ? 'error' : 'ok'), text: entries.length + ' order(s)' }),
        ]),
        el('div', { class: 'body' }, [
          ...entries.map(poCardForReview),
          errors
            ? el('div', { class: 'msg error' }, [el('span', { class: 'icon', text: '!' }),
              el('div', { text: errors + ' problem(s) on this item must be resolved before it can be posted.' })])
            : el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }),
              el('div', { text: ready + ' row(s) ready for ' + fileOf(item.trackerPath) + '. Formulas, styles, comments and every other sheet are preserved.' })]),
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: 'btn primary', disabled: errors > 0 || (st && st.posted),
              text: st && st.posted ? 'Posted' : 'Post ' + ready + ' order(s) to ' + item.name,
              onclick: () => postItem(item.id),
            }),
            el('button', {
              class: 'btn', text: 'Download a backup of this tracker',
              onclick: () => download(st.trackerBytes,
                safeName(fileOf(item.trackerPath).replace(/\.xlsx?m?$/i, '')) + ' (backup ' + stamp() + ').xlsx',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
            }),
          ]),
        ]),
      ]));
    }

    const itemsWithOrders = AMI.accountItems(account).filter((i) => posForItem(i.id).length);
    if (itemsWithOrders.length > 1) {
      const anyBlocked = itemsWithOrders.some((i) => posForItem(i.id).some((e) => e.issues.some((x) => x.level === 'error')));
      host.appendChild(el('div', { class: 'card' }, [el('div', { class: 'body' }, [
        el('div', { class: 'msg info' }, [el('span', { class: 'icon', text: 'i' }),
          el('div', { text: 'These orders span ' + itemsWithOrders.length + ' item trackers. Each is written to its own workbook, with its own backup.' })]),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', disabled: anyBlocked || unrouted.length > 0 || readyTotal === 0,
            text: 'Post all ' + itemsWithOrders.length + ' item trackers',
            onclick: async () => { for (const i of itemsWithOrders) await postItem(i.id, true); renderReview(); },
          }),
        ]),
      ])]));
    }
  }

  async function postItem(itemId, quiet) {
    const st = itemState(itemId);
    if (!st || !st.preview || st.posted) return;
    const entries = posForItem(itemId);
    if (!entries.length) return;
    if (entries.some((e) => e.issues.some((i) => i.level === 'error'))) return;

    try {
      const parts = AMI.splitPath(st.item.trackerPath);
      const name = parts.pop();
      const dir = parts.join('/');
      const backupPath = (dir ? dir + '/' : '') + name.replace(/\.xlsx?m?$/i, '') + ' (backup ' + stamp() + ').xlsx';

      await state.store.write(backupPath, st.trackerBytes);
      st.preview.wb.dropCalcChain();
      const out = await st.preview.wb.toBytes();
      await state.store.write(st.item.trackerPath, out);

      st.trackerBytes = out;
      st.posted = true;
      state.portfolio = null;
      await rebuildPlans();
      await persistSession();
      renderWorkspace();
      if (!quiet) { renderReview(); showTab('email'); }
      toast('Wrote ' + entries.length + ' row(s) into ' + name + '. Backup saved alongside it.', 'ok');
    } catch (e) {
      toast('Nothing was written to ' + st.item.name + ': ' + e.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * Email panel
   * ------------------------------------------------------------------ */

  const twoDp = (n) => (n == null || !Number.isFinite(n) ? ''
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  function emailVars(role) {
    const account = currentAccount() || {};
    const item = currentItem();
    const st = item ? itemState(item.id) : null;
    const config = st && st.base ? st.base.config : {};
    const user = currentUser() || {};
    const included = item ? posForItem(item.id) : [];
    const first = included.length ? included[0].po : null;

    const rows = included.map((entry) => {
      const po = entry.po;
      const plan = entry.plan;
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

    const recipients = AMI.resolveRecipients(account, item, role, first, user);

    // A template that quotes an airport code wants the delivery airport. The PO
    // names it in words, so the code is looked up from the address — reported as
    // derived, and refused outright where the city has more than one airport.
    const deliveryLines = first ? (first.finalDeliveryTo.length ? first.finalDeliveryTo : first.shipToBlock) : [];
    const airport = AMI.airportForAddress(deliveryLines);

    return {
      rows, included, first, recipients, item, airport,
      vars: {
        account: account.name || '',
        item: item ? item.name : '',
        division: AMI.divisionName(state.workspace, account.divisionId) || '',
        customer: config.customer || account.name || '',
        product: first ? first.description : (config.productName || (item && item.product) || ''),
        size: first ? first.size : (config.caseSize || ''),
        vendorContact: first ? (first.vendorContact || first.vendorName) : '',
        recipientName: ((item && item.contacts && item.contacts[role] && item.contacts[role].name) || '')
          || ((account.contacts && account.contacts[role] && account.contacts[role].name) || '')
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
        airport: airport.code,
        airportCode: airport.code,
        airportName: airport.airport ? airport.airport.names[0] || airport.airport.city : '',
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Placeholder audit
   * ------------------------------------------------------------------ */

  /**
   * Where each placeholder's value comes from. Stated per field rather than as
   * one blanket claim, because a draft mixes values read off the PO with values
   * computed from the tracker and values a person typed — and the difference
   * matters when someone is checking a draft before it goes out.
   */
  const VAR_SOURCE = {
    account: 'the account', item: 'the item', division: 'the account',
    customer: 'the tracker', product: 'the PO', size: 'the PO',
    vendorContact: 'the PO', recipientName: 'the saved contact', senderName: 'your profile',
    poCount: 'the loaded POs', poGroups: 'the loaded POs', poList: 'the loaded POs',
    docsEmail: 'the PO', finalDelivery: 'the PO', collectionAddress: 'the PO',
    deliveryAddress: 'the PO', collectionDate: 'the tracker', totalPallets: 'computed',
    totalCases: 'computed', totalWeight: 'computed', forwarder: 'the PO',
    today: "today's date", table: 'the POs and the tracker', signature: 'your profile',
    airport: 'the delivery address', airportCode: 'the delivery address',
    airportName: 'the delivery address',
  };

  const isAirportField = (name) => /airport/i.test(name);

  /**
   * One row per placeholder the template uses: its value, where that came from,
   * and whether anything is missing. Nothing is invented to fill a gap — a blank
   * stays blank and is reported.
   */
  function auditPlaceholders(template, ctx) {
    const used = AMI.templatePlaceholders((template.html || '') + ' ' + (template.subject || ''));
    const manual = (state.emailOverrides.vars) || {};

    return used.map((name) => {
      const typed = manual[name];
      if (typed != null && String(typed).trim() !== '') {
        return { name, value: String(typed), source: 'you typed it', filled: true, manual: true };
      }

      const value = ctx.vars[name];
      const filled = value != null && String(value).trim() !== '';

      if (isAirportField(name) && !filled) {
        return {
          name, value: '', filled: false, airport: true,
          source: 'the delivery address',
          why: ctx.airport.reason,
          choices: ctx.airport.choices || [],
        };
      }

      return {
        name,
        value: filled ? String(value) : '',
        filled,
        source: VAR_SOURCE[name] || 'not a field this portal fills',
        why: filled ? '' : (VAR_SOURCE[name]
          ? 'nothing in ' + VAR_SOURCE[name] + ' supplies it'
          : 'the template asks for a field the portal does not know'),
        derived: isAirportField(name) && ctx.airport.source !== 'printed',
        airport: isAirportField(name),
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * Attachments
   * ------------------------------------------------------------------ *
   *
   * Three sources, and the draft says which is which:
   *   - the PO PDFs for this item, already in hand
   *   - standing files kept on the item in the shared folder, so every message
   *     for that item carries them and every colleague sends the same ones
   *   - files added to this one draft, held in memory and never written anywhere
   */

  const MIME_BY_EXT = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', doc: 'application/msword', xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv', txt: 'text/plain', zip: 'application/zip', xml: 'application/xml',
  };

  const mimeFor = (name) => MIME_BY_EXT[String(name).split('.').pop().toLowerCase()]
    || 'application/octet-stream';

  /** Everything that goes on this draft, read fresh so a replaced file is current. */
  async function collectAttachments(item, role, poEntries) {
    const out = (poEntries || []).map((i) => ({
      name: i.fileName, mime: 'application/pdf', bytes: i.bytes,
    }));

    for (const f of AMI.attachmentsForRole(item, role)) {
      const bytes = await state.store.read(f.path);
      if (!bytes) {
        throw new Error('"' + f.name + '" is set to go on every ' + role
          + ' message but is missing from the shared folder. Remove it from the item, or put the file back.');
      }
      out.push({ name: f.name, mime: mimeFor(f.name), bytes });
    }

    for (const f of state.draftAttachments) out.push(f);
    return out;
  }

  /** The attachment controls on a draft. */
  function attachmentsPanel(account, item, standing, attachBox, included) {
    const list = el('div', { class: 'attach-list' });

    const redraw = () => {
      clear(list);
      for (const f of standing) {
        list.appendChild(el('div', { class: 'attach-row' }, [
          el('span', { class: 'chip ok', text: 'every message' }),
          el('span', { class: 'mono', text: f.name }),
          el('span', {
            class: 'note',
            text: f.roles.length ? 'on ' + f.roles.join(', ') + ' messages' : 'on every kind of message',
          }),
        ]));
      }
      for (const f of state.draftAttachments) {
        list.appendChild(el('div', { class: 'attach-row' }, [
          el('span', { class: 'chip edited', text: 'this draft' }),
          el('span', { class: 'mono', text: f.name }),
          el('span', { class: 'note', text: (f.bytes.length / 1024).toFixed(0) + ' KB' }),
          el('button', {
            class: 'btn small danger', text: 'Remove',
            onclick: () => {
              state.draftAttachments = state.draftAttachments.filter((x) => x !== f);
              redraw();
            },
          }),
        ]));
      }
      if (!standing.length && !state.draftAttachments.length) {
        list.appendChild(el('p', { class: 'note', text: 'No extra files on this draft.' }));
      }
    };
    redraw();

    const picker = el('input', { type: 'file', multiple: true, hidden: true });
    picker.addEventListener('change', async () => {
      for (const file of Array.from(picker.files)) {
        state.draftAttachments.push({
          name: file.name, mime: file.type || mimeFor(file.name),
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
      picker.value = '';
      redraw();
    });

    return el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode('Attachments'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: 'PDFs, standing files, and anything added here' }),
      ]),
      el('div', { class: 'body' }, [
        el('label', { class: 'check-inline' }, [
          attachBox,
          document.createTextNode('Attach the ' + included.length + ' PO PDF(s) for ' + item.name),
        ]),
        list,
        picker,
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn small', text: 'Add a file to this draft', onclick: () => picker.click() }),
          el('button', {
            class: 'btn small', text: 'Manage files sent with every message',
            onclick: () => editItemAttachments(account.id, item.id),
          }),
        ]),
        el('p', {
          class: 'help',
          text: 'A file added to this draft is used once and never saved. A standing file lives in '
            + 'the shared folder, so everyone working this item sends the same one.',
        }),
      ]),
    ]);
  }

  /**
   * Standing attachments for an item. Adding one copies it into the shared
   * folder, because a link to somebody's desktop would break for everyone else.
   */
  function editItemAttachments(accountId, itemId) {
    const account = state.workspace.accounts.find((a) => a.id === accountId);
    const item = AMI.findItem(account, itemId);
    if (!item) return;

    openOverlay('Files sent with every message', account.name + ' → ' + (item.name || item.id), (host) => {
      const body = el('div');

      const draw = () => {
        clear(body);
        if (!item.attachments.length) {
          body.appendChild(el('div', { class: 'empty', text: 'Nothing is sent automatically for this item.' }));
        } else {
          const table = el('table', { class: 'data' });
          table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { text: 'File' }), el('th', { text: 'Goes on' }),
            el('th', { text: 'Added' }), el('th', {}),
          ])]));
          const rows = el('tbody');
          for (const f of item.attachments) {
            const roleSel = el('select', { multiple: true, size: 4 },
              AMI.ROLES.map((r) => el('option', {
                value: r.id, selected: f.roles.includes(r.id), text: r.name,
              })));
            roleSel.addEventListener('change', async () => {
              f.roles = Array.from(roleSel.selectedOptions).map((o) => o.value);
              await persistWorkspace();
            });
            rows.appendChild(el('tr', {}, [
              el('td', { class: 'mono', text: f.name }),
              el('td', {}, [
                roleSel,
                el('div', { class: 'note', text: f.roles.length ? '' : 'none selected — goes on every kind' }),
              ]),
              el('td', { class: 'note', text: (f.addedBy || 'someone') + (f.addedAt ? ' · ' + f.addedAt.slice(0, 10) : '') }),
              el('td', {}, [el('button', {
                class: 'btn small danger', text: 'Remove',
                onclick: async () => {
                  if (!window.confirm('Stop sending "' + f.name + '" with every message for this item?\n\n'
                    + 'The file stays in the shared folder; it just will not be attached any more.')) return;
                  item.attachments = item.attachments.filter((x) => x !== f);
                  if (await persistWorkspace()) { draw(); toast('Removed from this item.', 'ok'); }
                },
              })]),
            ]));
          }
          table.appendChild(rows);
          body.appendChild(el('div', { class: 'table-scroll' }, [table]));
        }
      };
      draw();

      const picker = el('input', { type: 'file', multiple: true, hidden: true });
      picker.addEventListener('change', async () => {
        const user = currentUser() || {};
        for (const file of Array.from(picker.files)) {
          const path = AMI.attachDirFor(account.id, item.id) + '/' + file.name;
          try {
            await state.store.write(path, new Uint8Array(await file.arrayBuffer()));
          } catch (e) {
            toast('Could not copy ' + file.name + ' into the shared folder: ' + e.message, 'error');
            continue;
          }
          item.attachments = item.attachments.filter((x) => x.path !== path);
          item.attachments.push({
            path, name: file.name, roles: [],
            addedBy: user.name || '', addedAt: new Date().toISOString(),
          });
        }
        picker.value = '';
        if (await persistWorkspace()) {
          draw();
          renderEmail();
          toast('Copied into the shared folder and set to go with every message.', 'ok');
        }
      });

      host.appendChild(el('p', {
        class: 'help',
        text: 'These go on every message drafted for this item. Choose which kinds of message a '
          + 'file belongs on, or leave every kind unselected for all of them.',
      }));
      host.appendChild(body);
      host.appendChild(picker);
      host.appendChild(el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn primary', text: 'Add a file', onclick: () => picker.click() }),
      ]));
      host.appendChild(el('div', { class: 'msg info' }, [
        el('span', { class: 'icon', text: 'i' }),
        el('div', {}, [
          el('strong', { text: 'The file is copied into the shared folder.' }),
          el('span', {
            class: 'detail',
            text: 'It goes under ' + AMI.attachDirFor(account.id, item.id) + ', so a colleague opening '
              + 'this workspace attaches the same file. Replacing it there replaces it for everyone.',
          }),
        ]),
      ]));
    }, { wide: true });
  }

  /** Values merged in the order: portal-derived, then whatever a person typed. */
  function mergedVars(ctx) {
    return Object.assign({}, ctx.vars, state.emailOverrides.vars || {});
  }

  function setManualVar(name, value) {
    if (!state.emailOverrides.vars) state.emailOverrides.vars = {};
    if (value == null || String(value).trim() === '') delete state.emailOverrides.vars[name];
    else state.emailOverrides.vars[name] = String(value).trim();
    // The body may already have been edited by hand; leave that alone, but a
    // body still generated from the template must pick the new value up.
    renderEmail();
  }

  /**
   * The fields this template pulls in, and where each one came from.
   *
   * A missing field is the thing most likely to send a wrong email, so it is
   * raised before the preview rather than left to be noticed in the text. Every
   * gap gets a box to type the value in, and typing one never edits the
   * template — it applies to this draft only.
   */
  function fieldsPanel(audit, ctx) {
    const missing = audit.filter((f) => !f.filled);

    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Field' }), el('th', { text: 'Value' }),
      el('th', { text: 'Where it comes from' }), el('th', { text: 'Fill it in' }),
    ])]));
    const body = el('tbody');

    for (const f of audit) {
      let fill = null;
      if (!f.filled && f.airport && f.choices && f.choices.length) {
        // Several airports serve this city. Offering the list is the only honest
        // move — picking one would be a guess dressed up as a lookup.
        const pick = el('select', {}, [
          el('option', { value: '', text: 'Which airport?' }),
          ...f.choices.map((a) => el('option', { value: a.code, text: AMI.airportLabel(a) })),
        ]);
        pick.addEventListener('change', () => setManualVar(f.name, pick.value));
        fill = pick;
      } else if (!f.filled) {
        const input = el('input', { type: 'text', placeholder: 'type a value for this draft' });
        input.addEventListener('change', () => setManualVar(f.name, input.value));
        fill = input;
      } else if (f.manual) {
        fill = el('button', {
          class: 'btn small', text: 'Clear',
          onclick: () => setManualVar(f.name, ''),
        });
      }

      const chip = f.manual ? el('span', { class: 'chip edited', text: 'typed in' })
        : (f.filled
          ? (f.derived ? el('span', { class: 'chip computed', text: 'derived' })
            : el('span', { class: 'chip pdf', text: 'filled' }))
          : el('span', { class: 'chip error', text: 'missing' }));

      body.appendChild(el('tr', {}, [
        el('td', { class: 'mono', text: '{{' + f.name + '}}' }),
        el('td', {}, [
          f.filled
            ? el('span', { text: f.value.length > 90 ? f.value.slice(0, 90) + '…' : f.value.replace(/<[^>]*>/g, ' ') })
            : el('span', { class: 'faint', text: '—' }),
        ]),
        el('td', {}, [chip, document.createTextNode(' '),
          el('span', { class: 'note', text: f.why || f.source })]),
        el('td', {}, [fill]),
      ]));
    }
    table.appendChild(body);

    const head = missing.length
      ? el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', {
            text: missing.length + ' field(s) this template needs have no value: '
              + missing.map((f) => '{{' + f.name + '}}').join(', '),
          }),
          el('span', {
            class: 'detail',
            text: 'They will go out as empty braces unless you fill them in below. '
              + 'Nothing is invented to cover a gap.',
          }),
        ]),
      ])
      : el('div', { class: 'msg ok' }, [
        el('span', { class: 'icon', text: '✓' }),
        el('div', {}, [el('strong', { text: 'Every field this template needs has a value.' })]),
      ]);

    const airportNote = audit.some((f) => f.airport) && ctx.airport.code
      ? el('p', {
        class: 'help',
        text: ctx.airport.source === 'printed'
          ? 'The airport code is printed on the purchase order.'
          : 'The airport code was read from the delivery address — ' + ctx.airport.reason
            + '. Check it before sending.',
      })
      : null;

    return el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode('Fields in this template'),
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'chip ' + (missing.length ? 'error' : 'ok'),
          text: (audit.length - missing.length) + ' of ' + audit.length + ' filled',
        }),
      ]),
      el('div', { class: 'body' }, [
        head,
        airportNote,
        el('div', { class: 'table-scroll' }, [table]),
        el('p', {
          class: 'help',
          text: 'Anything typed here applies to this draft only — the template and the '
            + 'tracker are untouched.',
        }),
      ]),
    ]);
  }

  const BUILTIN_VENDOR_TEMPLATE = {
    id: '', label: 'Built-in vendor order email', role: 'vendor', builtin: true, itemId: '',
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

  /** Templates for a role: those scoped to this item first, then account-wide. */
  function availableTemplates(role) {
    const scoped = state.templates.filter((t) => !t.error && t.role === role && t.itemId === state.itemId);
    const shared = state.templates.filter((t) => !t.error && t.role === role && !t.itemId);
    const list = scoped.concat(shared);
    if (role === 'vendor') list.push(BUILTIN_VENDOR_TEMPLATE);
    return list;
  }

  function renderEmail() {
    const host = $('#emailBody');
    clear(host);
    const account = currentAccount();
    const item = currentItem();
    if (!account || !item) {
      host.appendChild(el('div', { class: 'empty', text: 'Choose an account and item first.' }));
      return;
    }

    const included = posForItem(item.id);
    if (!included.length) {
      const others = AMI.accountItems(account).filter((i) => posForItem(i.id).length);
      host.appendChild(el('div', { class: 'msg info' }, [
        el('span', { class: 'icon', text: 'i' }),
        el('div', {}, [
          el('strong', { text: 'No orders loaded for ' + item.name + '.' }),
          el('span', { class: 'detail', text: 'Drafts are built per item, because the breakdown table is per product.' }),
        ]),
      ]));
      if (others.length) {
        host.appendChild(el('div', { class: 'btn-row' }, others.map((i) => el('button', {
          class: 'btn small',
          text: 'Draft for ' + i.name + ' (' + posForItem(i.id).length + ')',
          onclick: () => {
            state.itemId = i.id;
            state.selectedTemplateId = '';
            state.emailOverrides = {};
            saveLocal({ itemId: i.id });
            renderHeaderBar(); renderEmail();
          },
        }))));
      }
      return;
    }

    host.appendChild(el('h3', { text: 'Who is this going to?' }));
    host.appendChild(el('div', { class: 'btn-row' }, AMI.ROLES.map((r) => el('button', {
      class: 'btn small' + (state.selectedRole === r.id ? ' primary' : ''),
      text: r.name,
      onclick: () => { state.selectedRole = r.id; state.selectedTemplateId = ''; state.emailOverrides = {}; state.draftAttachments = []; renderEmail(); },
    }))));

    const templates = availableTemplates(state.selectedRole);
    if (!templates.length) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: 'No ' + state.selectedRole + ' template for ' + account.name + ' / ' + item.name + ' yet.' }),
          el('span', { class: 'detail', text: 'Upload one under Templates. You can make it apply to every item on this account or just this one.' }),
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
        text: (t.label || t.id) + (t.builtin ? ' (built in)' : (t.itemId ? ' — ' + item.name + ' only' : ' — all items')),
      }))),
    ]));

    const ctx = emailVars(state.selectedRole);
    const ov = state.emailOverrides;

    const toInput = el('input', { type: 'text', value: ov.to != null ? ov.to : (template.to || ctx.recipients.to) });
    const ccInput = el('input', { type: 'text', value: ov.cc != null ? ov.cc : (template.cc || ctx.recipients.cc) });
    const subjInput = el('input', { type: 'text', value: ov.subject != null ? ov.subject : AMI.fillTemplate(template.subject || '', mergedVars(ctx)) });
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
      host.appendChild(el('h3', { text: 'Order breakdown table — ' + item.name }));
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

    const audit = auditPlaceholders(template, ctx);
    if (audit.length) host.appendChild(fieldsPanel(audit, ctx));

    const vars = mergedVars(ctx);
    const bodyHtml = ov.html != null ? ov.html : AMI.fillTemplate(template.html || '', vars);

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
    const standing = AMI.attachmentsForRole(item, state.selectedRole);
    host.appendChild(attachmentsPanel(account, item, standing, attachBox, included));

    host.appendChild(el('div', { class: 'btn-row' }, [
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
        onclick: async () => {
          const user = currentUser() || {};
          let files;
          try {
            files = await collectAttachments(item, state.selectedRole, attachBox.checked ? included : []);
          } catch (e) {
            toast(e.message, 'error');
            return;
          }
          const eml = AMI.buildEml({
            from: user.email ? (user.name ? user.name + ' <' + user.email + '>' : user.email) : '',
            to: toInput.value, cc: ccInput.value, subject: subjInput.value,
            html: '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + bodyHtml + '</body></html>',
            attachments: files,
          });
          download(new Blob([eml], { type: 'message/rfc822' }),
            safeName(account.name + ' ' + item.name + ' ' + state.selectedRole + ' ' + (ctx.vars.poGroups || stamp())) + '.eml');
          toast('Draft saved. Double-click it to open in Outlook.', 'ok');
        },
      }),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Templates panel
   * ------------------------------------------------------------------ */

  function renderTemplates() {
    const host = $('#templatesBody');
    clear(host);
    const account = currentAccount();
    if (!account) { host.appendChild(el('div', { class: 'empty', text: 'Choose an account first.' })); return; }
    const item = currentItem();

    host.appendChild(el('p', { class: 'help', text: 'Templates for ' + account.name + '. They live in the shared folder, so anyone working this account gets the same wording. A template can apply to every item on the account, or to one item only.' }));

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
            label: 'Untitled template', role: state.selectedRole, itemId: '', subject: '',
            html: '<p></p>', source: 'created here',
          });
          state.templates = await AMI.listTemplates(state.store, account.id);
          renderTemplates();
          openTemplateEditor(saved.id);
        },
      }),
      el('span', { class: 'context-note', text: '.msg  .oft  .eml  .docx  .html  .txt' }),
    ]));

    if (!state.templates.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No templates yet for this account.' }));
      host.appendChild(el('div', { id: 'templateEditor' }));
      return;
    }

    for (const role of AMI.ROLES) {
      const inRole = state.templates.filter((t) => t.role === role.id);
      if (!inRole.length) continue;
      const tbl = el('table', { class: 'data' });
      tbl.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Template' }), el('th', { text: 'Applies to' }), el('th', { text: 'Subject' }),
        el('th', { text: 'Placeholders' }), el('th', { text: 'Source' }), el('th', {}),
      ])]));
      const tbody = el('tbody');
      for (const t of inRole) {
        const scoped = t.itemId ? AMI.findItem(account, t.itemId) : null;
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [el('b', { text: t.label || t.id }), t.error ? el('div', { class: 'note', text: t.error }) : null]),
          el('td', {}, [t.itemId
            ? el('span', { class: 'chip carried', text: scoped ? scoped.name : 'missing item' })
            : el('span', { class: 'chip manual', text: 'all items' })]),
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

    if (item) {
      host.appendChild(el('p', { class: 'help', text: 'The Emails tab is currently showing templates for "' + item.name + '": item-specific ones first, then account-wide.' }));
    }
    host.appendChild(el('div', { id: 'templateEditor' }));
  }

  async function importTemplate(file) {
    const account = currentAccount();
    try {
      const parsed = await AMI.parseTemplateFile(new Uint8Array(await file.arrayBuffer()), file.name);

      // "Use: Aeromexico" and anything after it is a note to whoever files the
      // template, not part of the message. It comes out of the imported copy;
      // the source file is only ever read, so its note stays where it is.
      const trimmed = AMI.stripInternalNote(parsed.html);

      const saved = await AMI.saveTemplate(state.store, account.id, {
        label: parsed.subject ? parsed.subject.slice(0, 60) : file.name.replace(/\.[a-z0-9]+$/i, ''),
        role: state.selectedRole, itemId: '',
        subject: parsed.subject, to: parsed.to, cc: parsed.cc,
        html: trimmed.html, source: file.name + ' — ' + parsed.bodySource,
      });
      state.templates = await AMI.listTemplates(state.store, account.id);
      if (trimmed.found) state.lastStrippedNote = { templateId: saved.id, text: trimmed.removed, html: parsed.html };
      toast('Imported ' + file.name + ' (' + parsed.bodySource + ').'
        + (trimmed.found ? ' The internal note was removed.' : ''), 'ok');
      renderTemplates();
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
    const scopeSel = el('select', {}, [
      el('option', { value: '', selected: !t.itemId, text: 'Every item on ' + account.name }),
      ...AMI.accountItems(account).map((i) => el('option', { value: i.id, selected: i.id === t.itemId, text: i.name + ' only' })),
    ]);
    const body = el('textarea', { rows: 16 });
    body.value = t.html || '';

    const preview = el('div', { class: 'email-preview' });
    const placeholderNote = el('div', { class: 'note' });

    const refresh = () => {
      const item = currentItem();
      const hasPos = item && posForItem(item.id).length;
      const ctx = hasPos ? emailVars(roleSel.value) : null;
      preview.innerHTML = ctx ? AMI.fillTemplate(body.value, ctx.vars) : body.value;
      const used = AMI.templatePlaceholders(body.value + ' ' + subject.value);
      placeholderNote.textContent = used.length
        ? 'Placeholders in use: ' + used.map((p) => '{{' + p + '}}').join(', ')
        : 'No placeholders yet — this template will send exactly as written.';
    };
    [label, subject, roleSel, scopeSel, body].forEach((n) => n.addEventListener('input', refresh));
    refresh();

    const strippedNote = state.lastStrippedNote && state.lastStrippedNote.templateId === t.id
      ? state.lastStrippedNote : null;

    const item = currentItem();
    const ctxForSuggest = item && posForItem(item.id).length ? emailVars(t.role || 'vendor') : null;
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
          el('label', { class: 'field' }, [el('span', { text: 'Applies to' }), scopeSel]),
        ]),
        el('label', { class: 'field' }, [el('span', { text: 'Subject line' }), subject]),
        strippedNote ? el('div', { class: 'msg info' }, [
          el('span', { class: 'icon', text: 'i' }),
          el('div', {}, [
            el('strong', { text: 'An internal note was removed from the end of this template.' }),
            el('span', { class: 'detail', text: '“' + strippedNote.text + '” — this and everything after it was '
              + 'taken out of the imported copy. The file you uploaded is untouched.' }),
            el('div', { class: 'btn-row' }, [el('button', {
              class: 'btn small', text: 'Put it back',
              onclick: () => {
                body.value = strippedNote.html;
                state.lastStrippedNote = null;
                refresh();
                toast('The note is back in the template body. Save to keep it.', 'ok');
              },
            })]),
          ]),
        ]) : null,
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
        el('p', { class: 'help', text: item && posForItem(item.id).length ? 'Filled with the orders currently loaded for ' + item.name + '.' : 'Load purchase orders to see this filled with real values.' }),
        preview,
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', text: 'Save for everyone on this account',
            onclick: async () => {
              await AMI.saveTemplate(state.store, account.id, {
                id: t.id, label: label.value, role: roleSel.value, itemId: scopeSel.value,
                subject: subject.value, to: t.to, cc: t.cc, html: body.value, source: t.source,
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
   * Accounts panel
   * ------------------------------------------------------------------ */

  function renderAccounts() {
    const host = $('#accountsBody');
    clear(host);
    if (!state.workspace) { host.appendChild(el('div', { class: 'empty', text: 'Open the workspace folder first.' })); return; }

    const ws = state.workspace;
    const user = currentUser();
    const canEdit = !user || user.isAdmin || !ws.users.length;

    for (const i of AMI.validateWorkspace(ws).slice(0, 8)) {
      host.appendChild(el('div', { class: 'msg ' + i.level }, [el('span', { class: 'icon', text: '!' }), el('div', { text: i.message })]));
    }
    if (!canEdit) {
      host.appendChild(el('div', { class: 'msg info' }, [el('span', { class: 'icon', text: 'i' }),
        el('div', { text: 'You can view this, but only administrators change the shared setup.' })]));
    }

    host.appendChild(el('h3', { text: 'Divisions' }));
    host.appendChild(el('div', { class: 'btn-row' }, [
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
    ]));

    host.appendChild(el('h3', { text: 'Accounts and their item trackers' }));
    const tbl = el('table', { class: 'data' });
    tbl.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Account' }), el('th', { text: 'Division' }),
      el('th', { text: 'Items' }), el('th', { text: 'Trackers' }), el('th', {}),
    ])]));
    const tbody = el('tbody');
    for (const a of ws.accounts) {
      const items = AMI.accountItems(a);
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [el('b', { text: a.name })]),
        el('td', { text: AMI.divisionName(ws, a.divisionId) || '—' }),
        el('td', { text: items.length ? items.map((i) => i.name).join(', ') : 'none yet' }),
        el('td', { class: 'num', text: String(items.filter((i) => i.trackerPath).length) + ' / ' + items.length }),
        el('td', {}, [canEdit ? el('button', { class: 'btn small', text: 'Edit', onclick: () => openAccountEditor(a.id) }) : null]),
      ]));
    }
    tbl.appendChild(tbody);
    host.appendChild(el('div', { class: 'table-scroll' }, [tbl]));
    if (canEdit) {
      host.appendChild(el('div', { class: 'btn-row' }, [el('button', {
        class: 'btn', text: 'Add account',
        onclick: async () => {
          const name = window.prompt('Account name (for example: Delta, British Airways)');
          if (!name) return;
          ws.accounts.push({
            id: AMI.uniqueId(name, ws.accounts.map((x) => x.id)), name,
            divisionId: ws.divisions[0] ? ws.divisions[0].id : '',
            defaultCc: '', notes: '',
            contacts: { vendor: {}, trucker: {}, customer: {}, internal: {} },
            items: [],
          });
          if (await persistWorkspace()) { renderAccounts(); renderHeaderBar(); }
        },
      })]));
    }

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

  const editorField = (labelText, input, help) => el('label', { class: 'field' }, [
    el('span', { text: labelText }), input,
    help ? el('div', { class: 'note', text: help }) : null,
  ]);

  function contactRows(target, store) {
    return AMI.ROLES.map((r) => {
      const c = (target.contacts && target.contacts[r.id]) || {};
      const n = el('input', { type: 'text', value: c.name || '', placeholder: 'name' });
      const e = el('input', { type: 'text', value: c.email || '', placeholder: 'email' });
      const cx = el('input', { type: 'text', value: c.cc || '', placeholder: 'always cc' });
      store[r.id] = { n, e, cx };
      return el('div', { class: 'contact-row' }, [
        el('div', { class: 'contact-role' }, [el('b', { text: r.name }), el('div', { class: 'note', text: r.hint })]),
        n, e, cx,
      ]);
    });
  }

  function collectContacts(store) {
    const out = {};
    for (const r of AMI.ROLES) {
      const i = store[r.id];
      out[r.id] = { name: i.n.value.trim(), email: i.e.value.trim(), cc: i.cx.value.trim() };
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Tracker assignment
   * ------------------------------------------------------------------ */

  /**
   * Which sheets of a workbook can actually take orders.
   *
   * A tracking workbook usually holds several years or cycles, so the choice is
   * real: reported per sheet, with the row count, rather than left to the
   * automatic pick.
   */
  async function readSheetChoices(path) {
    const bytes = await state.store.read(path);
    if (!bytes) throw new Error('Not found at ' + path);
    const wb = await AMI.Workbook.load(bytes);
    const out = wb.sheets.map((sh) => {
      let header = null;
      try { header = AMI.findHeaderRow(sh); } catch (e) { header = null; }
      const rows = header ? AMI.dataRows(sh, header).length : 0;
      return { name: sh.name, usable: !!header, rows };
    });
    // The automatic pick is the last usable sheet, so name it the same way here.
    const usable = out.filter((s) => s.usable);
    return { sheets: out, autoName: usable.length ? usable[usable.length - 1].name : '' };
  }

  /**
   * Point an item at a workbook and a sheet, or correct a wrong one.
   *
   * Reassignment never rewrites anything: rows already posted stay in the
   * workbook they were written to, which the dialog says plainly, because the
   * alternative — quietly moving them — would be a much worse surprise.
   */
  function editItemTracker(accountId, itemId) {
    const account = state.workspace.accounts.find((a) => a.id === accountId);
    const item = AMI.findItem(account, itemId);
    if (!item) return;

    const originalPath = item.trackerPath;
    const originalSheet = item.sheet;

    const pathField = el('input', { type: 'text', value: item.trackerPath, placeholder: 'trackers/Item Tracking Chart.xlsx' });
    const workbookPick = el('select', {}, [el('option', { value: '', text: 'Scanning the folder…' })]);
    const sheetPick = el('select', {}, [el('option', { value: '', text: 'Choose a workbook first' })]);
    const sheetNote = el('div', { class: 'note' });
    const status = el('div');

    const usedBy = (path) => state.workspace.accounts.flatMap((acc) => AMI.accountItems(acc)
      .filter((x) => x !== item && x.trackerPath === path)
      .map((x) => acc.name + ' → ' + (x.name || x.id)));

    async function loadSheets(path) {
      clear(sheetPick);
      clear(status);
      sheetNote.textContent = '';
      if (!path) {
        sheetPick.appendChild(el('option', { value: '', text: 'Choose a workbook first' }));
        return;
      }
      sheetPick.appendChild(el('option', { value: '', text: 'Reading the workbook…' }));
      let info;
      try {
        info = await readSheetChoices(path);
      } catch (e) {
        clear(sheetPick);
        sheetPick.appendChild(el('option', { value: '', text: 'Could not read this workbook' }));
        status.appendChild(el('div', { class: 'msg error' }, [
          el('span', { class: 'icon', text: '!' }),
          el('div', {}, [el('strong', { text: 'Could not read ' + fileOf(path) }),
            el('span', { class: 'detail', text: e.message })]),
        ]));
        return;
      }

      clear(sheetPick);
      sheetPick.appendChild(el('option', {
        value: '',
        selected: !item.sheet,
        text: 'Automatic' + (info.autoName ? ' — currently "' + info.autoName + '"' : ''),
      }));
      for (const sh of info.sheets) {
        sheetPick.appendChild(el('option', {
          value: sh.name,
          selected: sh.name === item.sheet,
          disabled: !sh.usable,
          text: sh.name + (sh.usable ? '  (' + sh.rows + ' order row(s))' : '  — no PO# header, cannot post here'),
        }));
      }

      const usable = info.sheets.filter((sh) => sh.usable).length;
      sheetNote.textContent = usable
        ? usable + ' of ' + info.sheets.length + ' sheet(s) carry a PO# header. Automatic takes the last of them, '
          + 'which is the current cycle in a workbook laid out by year.'
        : 'No sheet in this workbook has a PO# header row, so nothing can be posted into it.';

      if (item.sheet && !info.sheets.some((sh) => sh.name === item.sheet)) {
        status.appendChild(el('div', { class: 'msg warn' }, [
          el('span', { class: 'icon', text: '!' }),
          el('div', {}, [
            el('strong', { text: 'This item names a sheet that is not in this workbook.' }),
            el('span', { class: 'detail', text: '"' + item.sheet + '" is not here, so the automatic pick is being used instead.' }),
          ]),
        ]));
      }
    }

    AMI.findWorkbooks(state.store, '', 4).then((paths) => {
      clear(workbookPick);
      workbookPick.appendChild(el('option', {
        value: '', text: paths.length ? 'Pick a workbook…' : 'No workbooks found in this folder',
      }));
      for (const path of paths) {
        const others = usedBy(path);
        workbookPick.appendChild(el('option', {
          value: path, selected: path === item.trackerPath,
          text: path + (others.length ? '  (also used by ' + others.join(', ') + ')' : ''),
        }));
      }
      if (item.trackerPath && !paths.includes(item.trackerPath)) {
        workbookPick.appendChild(el('option', {
          value: item.trackerPath, selected: true,
          text: item.trackerPath + '  (linked, but not found in the folder now)',
        }));
      }
      if (item.trackerPath) loadSheets(item.trackerPath);
    });

    workbookPick.addEventListener('change', () => {
      pathField.value = workbookPick.value;
      item.sheet = '';
      loadSheets(workbookPick.value);
    });
    pathField.addEventListener('change', () => { loadSheets(pathField.value.trim()); });

    openOverlay('Tracker for ' + (item.name || item.id), account.name, (host) => {
      host.appendChild(el('p', { class: 'help', text: 'Which workbook this item posts into, and which sheet of it.' }));
      host.appendChild(editorField('Workbook in this folder', workbookPick));
      host.appendChild(editorField('Path', pathField, 'Relative to the workspace folder. Editable if the workbook is somewhere the scan does not reach.'));
      host.appendChild(editorField('Sheet', sheetPick, 'Automatic is right for most workbooks. Choose a sheet to post into a particular year or cycle.'));
      host.appendChild(sheetNote);
      host.appendChild(status);

      host.appendChild(el('div', { class: 'msg info' }, [
        el('span', { class: 'icon', text: 'i' }),
        el('div', {}, [
          el('strong', { text: 'Changing this moves nothing that is already written.' }),
          el('span', {
            class: 'detail',
            text: 'Rows posted earlier stay in the workbook and sheet they went into. This only '
              + 'changes where the next post goes, and which sheet the dashboard reads for this item.',
          }),
        ]),
      ]));

      host.appendChild(el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn primary', text: 'Save tracker',
          onclick: async () => {
            const path = pathField.value.trim();
            const sheet = sheetPick.value;
            if (!path) { toast('Pick a workbook first.', 'error'); return; }

            const clash = state.workspace.accounts.flatMap((acc) => AMI.accountItems(acc)
              .filter((x) => x !== item && x.trackerPath === path && (x.sheet || '') === sheet)
              .map((x) => acc.name + ' → ' + (x.name || x.id)));
            if (clash.length && !window.confirm(
              'This is the same workbook and sheet as ' + clash.join(', ') + '.\n\n'
              + 'Two items posting into one sheet will interleave their orders. Save anyway?')) return;

            item.trackerPath = path;
            item.sheet = sheet;
            if (await persistWorkspace()) {
              if (closeOverlay) closeOverlay();
              state.portfolio = null;
              await selectAccount(account.id, state.itemId);
              renderAccounts();
              toast('Tracker set to ' + fileOf(path) + (sheet ? ' · ' + sheet : ' · automatic sheet') + '.', 'ok');
            } else {
              item.trackerPath = originalPath;
              item.sheet = originalSheet;
            }
          },
        }),
        el('button', {
          class: 'btn', text: 'Cancel',
          onclick: () => {
            item.sheet = originalSheet;
            if (closeOverlay) closeOverlay();
          },
        }),
      ]));
    });
  }

  async function openAccountEditor(accountId) {
    const ws = state.workspace;
    const a = ws.accounts.find((x) => x.id === accountId);
    const host = $('#entityEditor');
    clear(host);
    if (!a) return;

    const name = el('input', { type: 'text', value: a.name });
    const division = el('select', {}, ws.divisions.map((d) => el('option', { value: d.id, selected: d.id === a.divisionId, text: d.name })));
    const cc = el('input', { type: 'text', value: a.defaultCc });
    const notes = el('input', { type: 'text', value: a.notes });
    const contactInputs = {};

    const itemsTable = el('div');
    const renderItems = () => {
      clear(itemsTable);
      const items = AMI.accountItems(a);
      if (!items.length) {
        itemsTable.appendChild(el('div', { class: 'empty', text: 'No items yet. Add one per tracking chart.' }));
      } else {
        const t = el('table', { class: 'data' });
        t.appendChild(el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Item' }), el('th', { text: 'Item no.' }), el('th', { text: 'Tracker' }),
          el('th', { text: 'Sheet' }), el('th', {}),
        ])]));
        const tb = el('tbody');
        for (const it of items) {
          tb.appendChild(el('tr', {}, [
            el('td', {}, [el('b', { text: it.name || it.id })]),
            el('td', { class: 'mono', text: it.navCode || 'from tracker' }),
            el('td', { class: 'mono', text: it.trackerPath || 'not set' }),
            el('td', { text: it.sheet || 'auto' }),
            el('td', {}, [el('div', { class: 'btn-row', style: 'margin:0' }, [
              el('button', { class: 'btn small', text: 'Edit', onclick: () => openItemEditor(a.id, it.id) }),
              el('button', {
                class: 'btn small danger', text: 'Remove',
                onclick: async () => {
                  if (!window.confirm('Remove item "' + it.name + '" from ' + a.name + '? The tracker file itself stays on disk.')) return;
                  a.items = a.items.filter((x) => x !== it);
                  if (await persistWorkspace()) {
                    renderItems(); renderAccounts();
                    if (a.id === state.accountId) await selectAccount(a.id);
                  }
                },
              }),
            ])]),
          ]));
        }
        t.appendChild(tb);
        itemsTable.appendChild(el('div', { class: 'table-scroll' }, [t]));
      }
      itemsTable.appendChild(el('div', { class: 'btn-row' }, [el('button', {
        class: 'btn', text: 'Add item tracker',
        onclick: async () => {
          const itemName = window.prompt('Item name (for example: Evidencia Tempranillo, Montenero)');
          if (!itemName) return;
          const created = AMI.addItem(a, itemName);
          if (await persistWorkspace()) {
            renderItems(); renderAccounts();
            openItemEditor(a.id, created.id);
          }
        },
      })]));
    };
    renderItems();

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Account: ' + a.name), el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Close', onclick: () => clear(host) })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid-2' }, [
          editorField('Account name', name), editorField('Division', division),
          editorField('Always Cc', cc), editorField('Notes', notes),
        ]),
        el('h3', { text: 'Item trackers' }),
        el('p', { class: 'help', text: 'One item per tracking chart. Purchase orders are routed to the right one by the item number printed on them.' }),
        itemsTable,
        el('h3', { text: 'Account-wide contacts' }),
        el('p', { class: 'help', text: 'Used when an item has no contact of its own and the PO carries no address.' }),
        ...contactRows(a, contactInputs),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', text: 'Save account',
            onclick: async () => {
              a.name = name.value.trim() || a.name;
              a.divisionId = division.value;
              a.defaultCc = cc.value.trim();
              a.notes = notes.value.trim();
              a.contacts = collectContacts(contactInputs);
              if (await persistWorkspace()) {
                clear(host); renderAccounts(); renderHeaderBar();
                if (a.id === state.accountId) await selectAccount(a.id, state.itemId);
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

  function openItemEditor(accountId, itemId) {
    const ws = state.workspace;
    const a = ws.accounts.find((x) => x.id === accountId);
    const it = AMI.findItem(a, itemId);
    const host = $('#entityEditor');
    clear(host);
    if (!it) return;

    const name = el('input', { type: 'text', value: it.name });
    const product = el('input', { type: 'text', value: it.product, placeholder: 'read from the tracker when blank' });
    const navCode = el('input', { type: 'text', value: it.navCode, placeholder: 'read from the tracker when blank' });
    const notes = el('input', { type: 'text', value: it.notes });
    const contactInputs = {};

    // The workbook and sheet are set in their own dialog, which reads the file
    // to offer the real sheet names rather than asking anyone to type one.
    const trackerLine = el('div', { class: 'note' });
    const describeTracker = () => {
      const st = itemState(it.id);
      trackerLine.textContent = it.trackerPath
        ? fileOf(it.trackerPath) + ' · sheet: ' + (it.sheet || ((st && st.sheetName) ? st.sheetName + ' (automatic)' : 'automatic'))
        : 'No tracker assigned yet.';
    };
    describeTracker();

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode(a.name + ' → item: ' + (it.name || it.id)),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Back to account', onclick: () => openAccountEditor(a.id) }),
      ]),
      el('div', { class: 'body' }, [
        editorField('Item name', name, 'How it appears in the item switcher.'),
        el('h3', { text: 'Tracker' }),
        trackerLine,
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn', text: it.trackerPath ? 'Change workbook or sheet' : 'Assign a tracker',
            onclick: () => editItemTracker(a.id, it.id),
          }),
        ]),
        el('h3', { text: 'Matching' }),
        el('p', { class: 'help', text: 'Purchase orders are routed here when their item number matches. Leave both blank and the values are read from the tracker itself — which is usually what you want.' }),
        el('div', { class: 'grid-2' }, [
          editorField('Item number override', navCode, 'Only needed if the PO uses a different code from the tracker.'),
          editorField('Product name override', product),
        ]),
        el('h3', { text: 'Item contacts' }),
        el('p', { class: 'help', text: 'Override the account contacts for this item — a different winery or trucker, for instance. Blank falls back to the account.' }),
        ...contactRows(it, contactInputs),
        editorField('Notes', notes),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary', text: 'Save item',
            onclick: async () => {
              it.name = name.value.trim() || it.name;
              it.product = product.value.trim();
              it.navCode = navCode.value.trim();
              it.notes = notes.value.trim();
              it.contacts = collectContacts(contactInputs);
              if (await persistWorkspace()) {
                clear(host); renderAccounts(); renderHeaderBar();
                if (a.id === state.accountId) await selectAccount(a.id, it.id);
                toast('Item saved for the whole team.', 'ok');
              }
            },
          }),
          el('button', { class: 'btn', text: 'Cancel', onclick: () => openAccountEditor(a.id) }),
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
        el('label', { class: 'check-inline' }, [admin, document.createTextNode('Administrator — can change accounts, items and people')]),
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
              u.accountIds = accountBoxes.map((l) => l.querySelector('input')).filter((b) => b.checked)
                .map((b) => b.dataset.accountId);
              if (await persistWorkspace()) {
                clear(host); renderAccounts(); renderHeaderBar();
                if (u.id === state.userId) await selectAccount(state.accountId, state.itemId);
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
   * Follow-ups
   * ------------------------------------------------------------------ */

  const PARTY_LABEL = { winery: 'Winery', forwarder: 'Forwarder', internal: 'Internal' };
  const PARTY_TO_ROLE = { winery: 'vendor', forwarder: 'trucker', internal: 'internal' };

  function renderFollowUps() {
    const host = $('#followBody');
    clear(host);
    const account = currentAccount();
    if (!account) { host.appendChild(el('div', { class: 'empty', text: 'Choose an account first.' })); return; }

    // Every item on the account is scanned, so nothing hides behind the switcher.
    state.openItems = [];
    for (const item of AMI.accountItems(account)) {
      const st = itemState(item.id);
      if (!st || !st.base) continue;
      for (const oi of AMI.findOpenItems(st.base.sheet, st.base.header, new Date())) {
        state.openItems.push(Object.assign(oi, { itemId: item.id, itemName: item.name }));
      }
    }
    state.openItems.sort((a, b) => b.ageDays - a.ageDays);

    // A chase the workflow has overtaken is not worth sending, but the gap it
    // marks is still worth seeing — so it moves aside rather than disappearing.
    const live = state.openItems.filter((i) => !i.superseded);
    const overtaken = state.openItems.filter((i) => i.superseded);

    host.appendChild(el('p', { class: 'help', text: 'Every item tracker on ' + account.name + ' is scanned. Each line names the blank column and the dated column it is measured from — nothing here is inferred.' }));

    if (!state.openItems.length) {
      host.appendChild(el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }), el('div', { text: 'Nothing outstanding across any item.' })]));
      return;
    }

    if (!live.length) {
      host.appendChild(el('div', { class: 'msg ok' }, [
        el('span', { class: 'icon', text: '✓' }),
        el('div', {}, [
          el('strong', { text: 'Nothing left worth chasing.' }),
          el('span', {
            class: 'detail',
            text: overtaken.length + ' item(s) are still blank on the trackers, but each order has '
              + 'moved past the point where the answer would change anything. They are listed below.',
          }),
        ]),
      ]));
    }

    const byParty = {};
    for (const i of live) (byParty[i.party] = byParty[i.party] || []).push(i);

    for (const party of Object.keys(byParty)) {
      const items = byParty[party];
      const tbl = el('table', { class: 'data' });
      tbl.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', {}), el('th', { text: 'Item' }), el('th', { text: 'PO' }), el('th', { text: 'Outstanding' }),
        el('th', { text: 'Measured from' }), el('th', { text: 'Age' }),
      ])]));
      const tbody = el('tbody');
      for (const entry of items) {
        const key = entry.itemId + ':' + entry.row + ':' + entry.ruleId;
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [el('input', {
            type: 'checkbox', checked: state.selectedItems.has(key),
            onchange: (e) => { if (e.target.checked) state.selectedItems.add(key); else state.selectedItems.delete(key); },
          })]),
          el('td', { text: entry.itemName }),
          el('td', { class: 'mono', text: entry.po }),
          el('td', { text: entry.missingHeader + (entry.placeholder ? ' ("' + entry.placeholder + '")' : '') }),
          el('td', { text: entry.anchorHeader + ': ' + AMI.formatShort(entry.anchorDate) }),
          el('td', { class: 'num', text: entry.ageDays + ' d' }),
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
              onclick: () => {
                for (const i of items) state.selectedItems.add(i.itemId + ':' + i.row + ':' + i.ruleId);
                renderFollowUps();
              },
            }),
            el('span', { class: 'spacer' }),
            el('button', { class: 'btn primary', text: 'Draft chase email per item', onclick: () => buildChaseEmails(party, items) }),
          ]),
        ]),
      ]));
    }

    if (overtaken.length) host.appendChild(supersededCard(overtaken));
  }

  /**
   * Follow-ups the workflow overtook. Collapsed, because they need no action —
   * but present, because a blank column on a shipped order is still a gap in the
   * record, and hiding it would make the tracker look tidier than it is.
   */
  function supersededCard(items) {
    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Item' }), el('th', { text: 'PO' }), el('th', { text: 'Still blank' }),
      el('th', { text: 'Why it no longer needs chasing' }), el('th', { text: 'Age' }),
    ])]));
    const body = el('tbody');
    for (const entry of items) {
      body.appendChild(el('tr', {}, [
        el('td', { text: entry.itemName }),
        el('td', { class: 'mono', text: entry.po }),
        el('td', { text: entry.missingHeader }),
        el('td', { text: entry.supersededReason }),
        el('td', { class: 'num', text: entry.ageDays + ' d' }),
      ]));
    }
    table.appendChild(body);

    const details = el('details', { class: 'fold' }, [
      el('summary', { text: 'Show the ' + items.length + ' item(s)' }),
      el('div', { class: 'table-scroll' }, [table]),
    ]);

    return el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode('No longer needed'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'chip ok', text: items.length + ' resolved by the workflow' }),
      ]),
      el('div', { class: 'body' }, [
        el('p', {
          class: 'help',
          text: 'These columns are still blank, but the order has since been collected, delivered '
            + 'or invoiced — so the answer would no longer change what happens next. Nothing was '
            + 'deleted, and no email is drafted for them.',
        }),
        details,
      ]),
    ]);
  }

  function buildChaseEmails(party, items) {
    const chosen = items.filter((i) => state.selectedItems.has(i.itemId + ':' + i.row + ':' + i.ruleId));
    if (!chosen.length) { toast('Nothing selected in that group.', 'error'); return; }

    const account = currentAccount() || {};
    const user = currentUser() || {};
    const role = PARTY_TO_ROLE[party] || 'internal';

    // Chases are per item, because the counterparty and product differ per item.
    const byItem = {};
    for (const c of chosen) (byItem[c.itemId] = byItem[c.itemId] || []).push(c);

    let written = 0;
    for (const itemId of Object.keys(byItem)) {
      const group = byItem[itemId];
      const item = AMI.findItem(account, itemId);
      const st = itemState(itemId);
      const config = st && st.base ? st.base.config : {};
      const lastPo = posForItem(itemId).slice(-1)[0];
      const recipients = AMI.resolveRecipients(account, item, role, lastPo ? lastPo.po : null, user);

      const rowsHtml = '<table style="border-collapse:collapse;margin:12px 0;"><thead><tr>'
        + ['PO #', 'Outstanding', 'Reference'].map((h) => '<th style="border:1px solid #999;padding:4px 8px;'
          + 'background:#f2f2f2;text-align:left;font-family:Calibri,Arial,sans-serif;font-size:11pt;">' + h + '</th>').join('')
        + '</tr></thead><tbody>'
        + group.map((i) => '<tr>' + [i.po, i.missingHeader, i.anchorHeader + ': ' + AMI.formatShort(i.anchorDate)]
          .map((v) => '<td style="border:1px solid #999;padding:4px 8px;font-family:Calibri,Arial,sans-serif;'
            + 'font-size:11pt;">' + AMI.escapeXml(v) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';

      const topics = [];
      for (const i of group) if (!topics.includes(i.subject)) topics.push(i.subject);

      const vars = {
        recipientName: ((item && item.contacts && item.contacts[role] && item.contacts[role].name) || '')
          || ((account.contacts && account.contacts[role] && account.contacts[role].name) || ''),
        account: account.name || '',
        item: item ? item.name : '',
        customer: config.customer || account.name || '',
        product: config.productName || (item && item.product) || (item && item.name) || '',
        topic: topics.join(' / '),
        poList: [...new Set(group.map((i) => i.po))].join(', '),
        table: rowsHtml,
        signature: user.signature || '',
        senderName: user.name || '',
        today: AMI.formatEmailDate(new Date()),
      };

      const candidates = state.templates.filter((t) => !t.error && t.role === role
        && (!t.itemId || t.itemId === itemId) && /follow|chase|remind/i.test(t.label || ''));
      const template = candidates.find((t) => t.itemId === itemId) || candidates[0];

      const subject = AMI.fillTemplate(
        template ? template.subject : '{{customer}} / {{product}} - {{topic}} - PO {{poList}}', vars);
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
        safeName('Follow-up ' + (account.name || '') + ' ' + (item ? item.name : '') + ' '
          + (PARTY_LABEL[party] || party) + ' ' + stamp()) + '.eml');
      written++;
    }
    toast(written + ' chase draft(s) saved, one per item.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Memory across closing the app
   * ------------------------------------------------------------------ */

  const SESSION_DIR = 'order-desk-sessions';
  const sessionPathFor = (userId) => SESSION_DIR + '/' + (userId || 'default') + '.json';
  /* Well under any sync limit; past this the PDFs are left out rather than
     writing a huge file into a shared library on every edit. */
  const SESSION_MAX_BYTES = 12 * 1024 * 1024;

  function bytesToBase64(bytes) { return AMI.b64(bytes); }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * The folder copy is the one that survives anything: it needs no browser
   * storage, only the folder you already opened, and it follows the workspace.
   */
  async function writeFolderSession(payload) {
    if (!state.store) return false;
    const path = sessionPathFor(state.userId);
    try {
      const withPdfs = Object.assign({}, payload, {
        pos: payload.pos.map((p) => Object.assign({}, p, { pdf: bytesToBase64(new Uint8Array(p.bytes)) })),
      });
      for (const p of withPdfs.pos) delete p.bytes;
      let text = JSON.stringify(withPdfs);
      if (text.length > SESSION_MAX_BYTES) {
        for (const p of withPdfs.pos) { delete p.pdf; p.pdfOmitted = true; }
        text = JSON.stringify(withPdfs);
      }
      await state.store.write(path, ENC.encode(text));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function readFolderSession() {
    if (!state.store) return null;
    try {
      const bytes = await state.store.read(sessionPathFor(state.userId));
      if (!bytes) return null;
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (!parsed || !Array.isArray(parsed.pos) || !parsed.pos.length) return null;
      parsed.pos = parsed.pos
        .filter((p) => p.pdf)
        .map((p) => ({
          fileName: p.fileName, itemId: p.itemId, include: p.include,
          overrides: p.overrides, bytes: base64ToBytes(p.pdf).buffer,
        }));
      parsed.origin = 'the shared folder';
      return parsed.pos.length ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  async function clearFolderSession() {
    if (!state.store) return;
    try { await state.store.remove(sessionPathFor(state.userId)); } catch (e) { /* already gone */ }
  }

  /** Save unposted work. Posted items drop out, so finishing a batch clears it. */
  async function persistSession() {
    if (!state.store) return;
    const pending = state.pos.filter((p) => p.po && p.include && !(itemState(p.itemId) || {}).posted);
    if (!pending.length) { await AMI.forgetSession(); await clearFolderSession(); return; }
    const payload = {
      userId: state.userId,
      accountId: state.accountId,
      accountName: (currentAccount() || {}).name || '',
      itemId: state.itemId,
      emailRows: state.emailRows,
      pos: pending.map((p) => ({
        fileName: p.fileName,
        // Copy out of the view so IndexedDB stores exactly these bytes.
        bytes: p.bytes.buffer.slice(p.bytes.byteOffset, p.bytes.byteOffset + p.bytes.byteLength),
        itemId: p.itemId,
        include: p.include,
        overrides: p.overrides,
      })),
    };
    // Both copies: the folder one survives a browser that forgets everything,
    // the local one is instant and works before a folder is reconnected.
    await AMI.saveSession(payload);
    await writeFolderSession(payload);
  }

  const saveSessionSoon = AMI.debounce(() => { persistSession(); }, 400);

  /**
   * Put a saved batch back. The PDFs are re-read rather than trusting stored
   * derivatives, so a restored order goes through exactly the same extraction
   * and validation as one dropped in fresh.
   */
  async function restoreSession() {
    const saved = state.pendingSession;
    if (!saved) return;
    state.pendingSession = null;

    if (saved.accountId && saved.accountId !== state.accountId
      && visibleAccounts().some((a) => a.id === saved.accountId)) {
      await selectAccount(saved.accountId, saved.itemId);
    }

    state.pos = saved.pos.map((p) => ({
      id: nextId++, fileName: p.fileName, bytes: new Uint8Array(p.bytes),
      po: null, error: '', include: p.include !== false,
      itemId: p.itemId || '',
      match: { item: null, reason: 'restored from your last session', confident: true },
      overrides: p.overrides || {}, plan: null, issues: [],
    }));

    for (const entry of state.pos) {
      try {
        entry.po = AMI.parsePurchaseOrder(await AMI.extractPdfPages(entry.bytes), entry.fileName);
      } catch (e) {
        entry.error = 'Could not re-read this PDF: ' + e.message;
        entry.include = false;
      }
    }
    state.emailRows = saved.emailRows || {};

    await rebuildPlans();
    renderIntake(); renderReview(); refreshTabs();
    showTab('orders');
    toast('Restored ' + state.pos.length + ' purchase order(s) from your last session.', 'ok');
  }

  async function discardSession() {
    state.pendingSession = null;
    await AMI.forgetSession();
    await clearFolderSession();
    renderIntake(); renderWorkspace();
    toast('Saved work discarded.', 'ok');
  }

  /** Reconnect to the folder picked last time, silently if the browser allows. */
  async function tryReconnect() {
    const record = await AMI.recallFolder();
    if (!record) return false;
    state.rememberedFolder = record;
    const permission = await AMI.handlePermission(record.handle, false);
    if (permission !== 'granted') return false;
    try {
      await adoptStore(handleStore(record.handle));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Point the app at a different folder. Anything unposted belongs to the old
   * workspace, so it is saved there and cleared here rather than carried across.
   */
  async function changeWorkspaceFolder() {
    if (unpostedCount() && !window.confirm(
      unpostedCount() + ' purchase order(s) are loaded but not posted.\n\n'
      + 'They stay saved in the current folder and will be offered back if you return to it. '
      + 'Switch folders anyway?')) return;

    saveSessionSoon.flush();
    await AMI.forgetFolder();
    state.rememberedFolder = null;
    if (typeof window.showDirectoryPicker !== 'function') {
      toast('This browser cannot open folders. Load a different bundle instead.', 'error');
      renderWorkspace();
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      resetWorkspaceState();
      await adoptStore(handleStore(dir));
      toast('Now working in ' + (dir.name || 'the chosen folder') + '.', 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') { renderWorkspace(); return; }
      toast('Could not open that folder: ' + e.message, 'error');
      renderWorkspace();
    }
  }

  /** Forget everything tied to the workspace we are leaving. */
  function resetWorkspaceState() {
    state.workspace = null;
    state.store = null;
    state.userId = '';
    state.accountId = '';
    state.itemId = '';
    state.templates = [];
    state.itemStates = new Map();
    state.pos = [];
    state.emailRows = {};
    state.emailOverrides = {};
    state.portfolio = null;
    state.statusDoc = null;
    state.pendingSession = null;
    state.summaryHtml = '';
    state.filters = { divisionId: '', accountId: '', itemId: '', statusId: '', query: '' };
    saveLocal({ userId: '', accountId: '', itemId: '' });
  }

  async function reconnectFolder() {
    const record = state.rememberedFolder;
    if (!record) return;
    const permission = await AMI.handlePermission(record.handle, true);
    if (permission !== 'granted') {
      toast('Permission declined. Open the folder again to continue.', 'error');
      return;
    }
    try {
      await adoptStore(handleStore(record.handle));
    } catch (e) {
      toast('That folder could not be reopened: ' + e.message, 'error');
      await AMI.forgetFolder();
      state.rememberedFolder = null;
      renderWorkspace();
    }
  }

  /** A card offering to put back what was open when the app was last closed. */
  function sessionOfferCard() {
    const saved = state.pendingSession;
    if (!saved) return null;
    return el('div', { class: 'msg info', id: 'sessionOffer' }, [
      el('span', { class: 'icon', text: 'i' }),
      el('div', {}, [
        el('strong', {
          text: saved.pos.length + ' purchase order(s) were still open when you last closed the app'
            + (saved.accountName ? ' on ' + saved.accountName : '') + '.',
        }),
        el('span', {
          class: 'detail',
          text: 'Saved ' + AMI.describeAge(saved.savedAt) + ', on this computer only. Nothing was posted.',
        }),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn primary small', text: 'Restore them', onclick: restoreSession }),
          el('button', { class: 'btn small', text: 'Discard', onclick: discardSession }),
        ]),
      ]),
    ]);
  }

  /* ------------------------------------------------------------------ *
   * Tooltip
   * ------------------------------------------------------------------ */

  function initTooltip() {
    const tip = $('#tooltip');
    if (!tip) return;
    let current = null;

    document.addEventListener('mouseover', (e) => {
      const host = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!host || host === current) return;
      current = host;
      tip.textContent = host.getAttribute('data-tip');
      tip.hidden = false;
      position(e);
    });
    document.addEventListener('mousemove', (e) => { if (current) position(e); });
    document.addEventListener('mouseout', (e) => {
      if (!current) return;
      const to = e.relatedTarget;
      if (to && current.contains(to)) return;
      current = null;
      tip.hidden = true;
    });

    function position(e) {
      const pad = 12;
      const r = tip.getBoundingClientRect();
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
      tip.style.left = Math.max(6, x) + 'px';
      tip.style.top = Math.max(6, y) + 'px';
    }
  }

  /* ------------------------------------------------------------------ *
   * Portfolio: every tracker the signed-in person can see
   * ------------------------------------------------------------------ */

  /**
   * Read every item tracker across the user's accounts once, so the dashboard
   * can span accounts and divisions. Cached until something is posted.
   */
  async function ensurePortfolio(force) {
    if (state.portfolio && !force) return state.portfolio;
    if (!state.store || !state.workspace) return [];

    state.portfolioLoading = true;
    const out = [];
    const problems = [];

    for (const account of visibleAccounts()) {
      const divisionName = AMI.divisionName(state.workspace, account.divisionId);
      for (const item of AMI.accountItems(account)) {
        if (!item.trackerPath) continue;
        try {
          const bytes = await state.store.read(item.trackerPath);
          if (!bytes) { problems.push(item.name + ': tracker not found'); continue; }
          const wb = await AMI.Workbook.load(bytes);
          let sheetName = '';
          if (item.sheet && wb.sheet(item.sheet) && AMI.findHeaderRow(wb.sheet(item.sheet))) sheetName = item.sheet;
          else for (const sh of wb.sheets) if (AMI.findHeaderRow(sh)) sheetName = sh.name;
          if (!sheetName) { problems.push(item.name + ': no sheet with a PO# header'); continue; }

          const sheet = wb.sheet(sheetName);
          const header = AMI.findHeaderRow(sheet);
          out.push({
            account, item, sheet, header,
            // The sheet is the contract cycle — a workbook laid out by year has
            // one sheet per cycle, so its name is what "this cycle" means.
            cycle: sheetName,
            config: AMI.readSheetConfig(sheet),
            orders: AMI.readOrders(sheet, header, {
              accountId: account.id, accountName: account.name, divisionId: account.divisionId,
              divisionName, itemId: item.id, itemName: item.name,
            }),
            followUps: AMI.findOpenItems(sheet, header, new Date()),
          });
        } catch (e) {
          problems.push(item.name + ': ' + e.message);
        }
      }
    }

    state.portfolio = out;
    state.portfolioProblems = problems;
    state.portfolioLoading = false;
    return out;
  }

  /** Apply the division/account/item filters to the portfolio. */
  function filteredPortfolio() {
    const f = state.filters;
    return (state.portfolio || []).filter((p) => {
      if (f.divisionId && p.account.divisionId !== f.divisionId) return false;
      if (f.accountId && p.account.id !== f.accountId) return false;
      if (f.itemId && p.item.id !== f.itemId) return false;
      return true;
    });
  }

  /** Decorated orders for the current filters. */
  /**
   * Orders in scope, after the account and item filters and after the
   * hide-finished switch. Counts and totals downstream follow the switch, which
   * is the point of it — it changes what you are looking at, not what is true.
   */
  function filteredOrders() {
    const all = [];
    for (const p of filteredPortfolio()) all.push(...p.orders);
    const decorated = AMI.withSchedule(
      AMI.decorate(all, state.statusDoc || AMI.emptyStatusDoc(), new Date()), new Date());
    return applyClosedFilter(decorated);
  }

  /**
   * Contract standing per item, in filter scope.
   *
   * Read from the whole tracker rather than the filtered orders — a contract
   * balance is a fact about the item, and hiding finished orders must not make
   * it look like less has been ordered than has.
   */
  function contractsInScope() {
    const doc = state.statusDoc || AMI.emptyStatusDoc();
    const now = new Date();
    return filteredPortfolio().map((p) => {
      const orders = AMI.withSchedule(AMI.decorate(p.orders, doc, now), now);
      return AMI.contractStanding(orders, {
        accountId: p.account.id, accountName: p.account.name,
        itemId: p.item.id, itemName: p.item.name, cycle: p.cycle,
      });
    }).sort((a, b) => a.accountName.localeCompare(b.accountName)
      || a.itemName.localeCompare(b.itemName));
  }

  async function applyStatus(key, statusId, note) {
    const user = currentUser();
    const by = user ? user.name : '';
    if (!state.statusDoc) state.statusDoc = AMI.emptyStatusDoc();
    if (statusId) AMI.setStatus(state.statusDoc, key, statusId, by, note);
    else AMI.clearStatus(state.statusDoc, key);
    try {
      state.statusDoc = await AMI.saveStatuses(state.store, state.statusDoc, { by });
      return true;
    } catch (e) {
      toast('Status not saved: ' + e.message, 'error');
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Shared filter bar
   * ------------------------------------------------------------------ */

  function filterBar(onChange, opts) {
    const o = opts || {};
    const ws = state.workspace;
    const accounts = visibleAccounts();
    const f = state.filters;

    const divisions = ws.divisions.filter((d) => accounts.some((a) => a.divisionId === d.id));
    const divisionSel = el('select', {
      onchange: (e) => {
        f.divisionId = e.target.value;
        const stillVisible = accounts.some((a) => a.id === f.accountId && (!f.divisionId || a.divisionId === f.divisionId));
        if (!stillVisible) { f.accountId = ''; f.itemId = ''; }
        onChange();
      },
    }, [
      el('option', { value: '', text: 'All divisions', selected: !f.divisionId }),
      ...divisions.map((d) => el('option', { value: d.id, selected: d.id === f.divisionId, text: d.name })),
    ]);

    const inDivision = accounts.filter((a) => !f.divisionId || a.divisionId === f.divisionId);
    const accountSel = el('select', {
      onchange: (e) => { f.accountId = e.target.value; f.itemId = ''; onChange(); },
    }, [
      el('option', { value: '', text: 'All my accounts', selected: !f.accountId }),
      ...inDivision.map((a) => el('option', { value: a.id, selected: a.id === f.accountId, text: a.name })),
    ]);

    const controls = [
      el('label', { class: 'field' }, [el('span', { text: 'Division' }), divisionSel]),
      el('label', { class: 'field' }, [el('span', { text: 'Account' }), accountSel]),
    ];

    if (o.withItem) {
      const chosenAccount = accounts.find((a) => a.id === f.accountId);
      const items = chosenAccount ? AMI.accountItems(chosenAccount)
        : inDivision.flatMap((a) => AMI.accountItems(a));
      controls.push(el('label', { class: 'field' }, [
        el('span', { text: 'Item' }),
        el('select', {
          onchange: (e) => { f.itemId = e.target.value; onChange(); },
        }, [
          el('option', { value: '', text: 'All items', selected: !f.itemId }),
          ...items.map((i) => el('option', { value: i.id, selected: i.id === f.itemId, text: i.name })),
        ]),
      ]));
    }

    if (o.withStatus) {
      controls.push(el('label', { class: 'field' }, [
        el('span', { text: 'Status' }),
        el('select', {
          onchange: (e) => { f.statusId = e.target.value; onChange(); },
        }, [
          el('option', { value: '', text: 'Any status', selected: !f.statusId }),
          el('option', { value: '__open', text: 'Open only', selected: f.statusId === '__open' }),
          el('option', { value: '__unset', text: 'No status set', selected: f.statusId === '__unset' }),
          ...AMI.ORDER_STATUSES.map((s) => el('option', { value: s.id, selected: s.id === f.statusId, text: s.label })),
        ]),
      ]));
    }

    if (o.withSearch) {
      const search = el('input', { type: 'text', value: f.query, placeholder: 'PO number…' });
      search.addEventListener('input', () => { f.query = search.value; onChange(); });
      controls.push(el('label', { class: 'field' }, [el('span', { text: 'Find' }), search]));
    }

    controls.push(el('span', { class: 'spacer' }));
    controls.push(el('button', {
      class: 'btn small ghost', text: 'Reset filters',
      onclick: () => {
        state.filters = { divisionId: '', accountId: '', itemId: '', statusId: '', query: '' };
        onChange();
      },
    }));
    if (o.extra) controls.push(...[].concat(o.extra));

    return el('div', { class: 'filter-bar' }, controls);
  }

  function pageHeader(eyebrow, title, description, actions) {
    return el('div', { class: 'page-header' }, [
      el('div', { class: 'titles' }, [
        el('div', { class: 'eyebrow', text: eyebrow }),
        el('h1', { text: title }),
        description ? el('p', { text: description }) : null,
      ]),
      actions && actions.length ? el('div', { class: 'actions' }, actions) : null,
    ]);
  }

  /* ------------------------------------------------------------------ *
   * Account Health dashboard
   * ------------------------------------------------------------------ */

  async function renderDashboard() {
    const host = $('#dashboardBody');
    clear(host);
    if (!state.workspace || !currentUser()) {
      host.appendChild(el('div', { class: 'empty', text: 'Open the workspace and choose your name to see your accounts.' }));
      return;
    }

    if (!state.portfolio) {
      host.appendChild(el('div', { class: 'empty', text: 'Reading the trackers for your accounts…' }));
      await ensurePortfolio();
      renderDashboard();
      return;
    }

    state.drillIndex = new Map();
    const orders = filteredOrders();
    const scope = filteredPortfolio();
    const counts = AMI.countByStatus(orders);
    const open = orders.filter((o) => o.isOpen);
    const unset = orders.filter((o) => !o.status.statusId);
    // Only chases that still matter — the ones the workflow overtook are shown
    // on the Follow-ups page but never counted as outstanding work.
    const followUps = scope.reduce((n, p) => n + p.followUps.filter((f) => !f.superseded).length, 0);
    const settledFollowUps = scope.reduce((n, p) => n + p.followUps.filter((f) => f.superseded).length, 0);
    const stalest = open.reduce((w, o) => (o.ageDays != null && (!w || o.ageDays > w.ageDays) ? o : w), null);

    host.appendChild(pageHeader(
      'Account Health',
      state.filters.accountId
        ? (visibleAccounts().find((a) => a.id === state.filters.accountId) || {}).name || 'Account'
        : 'All my accounts',
      'Where every order stands right now, read from the item trackers and the statuses your team has set.',
      [
        closedToggle(() => renderDashboard()),
        el('button', {
          class: 'btn', text: 'Refresh',
          onclick: async () => { await ensurePortfolio(true); renderDashboard(); toast('Trackers re-read.', 'ok'); },
        }),
        el('button', {
          class: 'btn primary', text: 'Generate account summary',
          onclick: () => { showTab('orderstatus'); setTimeout(() => generateSummary(), 0); },
        }),
      ],
    ));

    host.appendChild(filterBar(() => renderDashboard(), { withItem: true }));

    if (state.portfolioProblems && state.portfolioProblems.length) {
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: state.portfolioProblems.length + ' tracker(s) could not be read.' }),
          el('span', { class: 'detail', text: state.portfolioProblems.join(' · ') }),
        ]),
      ]));
    }

    if (!orders.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No orders on the trackers in scope.' }));
      return;
    }

    // A mistyped date serial reads as a year in the far future. Surface it: it
    // would otherwise skew every age on the board, and it is a real error to fix.
    const dateIssues = orders.filter((o) => o.dateIssues && o.dateIssues.length);
    if (dateIssues.length) {
      const lines = [];
      for (const o of dateIssues) {
        for (const issue of o.dateIssues) {
          lines.push('PO ' + o.po + ' (' + o.itemName + ') — ' + issue.label + ' reads '
            + AMI.formatShort(issue.date) + ', from the value ' + issue.serial + '.');
        }
      }
      const list = el('ul', { class: 'tight' });
      for (const line of lines.slice(0, 6)) list.appendChild(el('li', { text: line }));
      if (lines.length > 6) {
        list.appendChild(el('li', { text: 'and ' + (lines.length - 6) + ' more.' }));
      }
      host.appendChild(el('div', { class: 'msg warn' }, [
        el('span', { class: 'icon', text: '!' }),
        el('div', {}, [
          el('strong', { text: dateIssues.length + ' order(s) have a date the tracker cannot mean.' }),
          el('span', { class: 'detail', text: 'These are excluded from the ages and rankings below so they do not skew anything. Correct them in the workbook.' }),
          list,
        ]),
      ]));
    }

    /* Contract standing, read per item from each tracker's running balance. */
    const contracts = contractsInScope();
    const closedItems = contracts.filter((c) => c.isClosed);
    const overContract = contracts.filter((c) => c.isOver);
    const cycles = [...new Set(contracts.map((c) => c.cycle).filter(Boolean))];

    /* What has been missed, and what is coming. */
    const collectionsOverdue = orders.filter((o) => o.schedule.collectionOverdue);
    const deliveriesOverdue = orders.filter((o) => o.schedule.deliveryOverdue);
    const schedule = AMI.scheduleEntries(orders, new Date());
    const nextUp = schedule.find((e) => !e.overdue) || null;

    /* Headline figures */
    const tilesHtml = AMI.statTiles([
      { label: 'Open orders', value: open.length, sub: 'of ' + orders.length + ' on the trackers', tone: 'neutral' },
      {
        label: 'Collections overdue', value: collectionsOverdue.length,
        sub: collectionsOverdue.length ? 'past the date AMI asked for' : 'none past their date',
        tone: collectionsOverdue.length ? 'critical' : 'good',
        tip: 'Orders whose requested collection date has passed with no collection recorded on the tracker.',
      },
      {
        label: 'Deliveries overdue', value: deliveriesOverdue.length,
        sub: deliveriesOverdue.length ? 'past the customer’s required date' : 'none past their date',
        tone: deliveriesOverdue.length ? 'critical' : 'good',
        tip: 'Orders whose customer required delivery date has passed with no delivery recorded on the tracker.',
      },
      {
        label: 'Items closed', value: closedItems.length,
        sub: 'of ' + contracts.length + (cycles.length === 1 ? ' on ' + cycles[0] : ' item tracker(s)'),
        tone: 'neutral',
        tip: 'An item is closed when its contract balance reaches zero — everything contracted has been ordered.',
      },
      {
        label: 'Over contract', value: overContract.length,
        sub: overContract.length ? 'balance below zero' : 'none over-drawn',
        tone: overContract.length ? 'critical' : 'good',
        tip: 'More has been ordered than the contract covers. Read straight from the tracker’s own balance column.',
      },
      {
        label: 'Follow-ups outstanding', value: followUps,
        sub: followUps ? 'across ' + scope.length + ' tracker(s)'
          : (settledFollowUps ? settledFollowUps + ' overtaken by the workflow' : 'nothing outstanding'),
        tone: followUps ? (followUps >= 5 ? 'critical' : 'warning') : 'good',
      },
      {
        label: 'Next date due',
        value: nextUp ? AMI.formatShort(nextUp.date) : '—',
        sub: nextUp ? nextUp.label.toLowerCase() + ' · PO ' + nextUp.order.po : 'nothing scheduled ahead',
        tone: 'neutral',
      },
    ]);
    host.appendChild(el('div', { html: tilesHtml }).firstChild);

    if (unset.length) {
      host.appendChild(el('div', { class: 'msg info' }, [
        el('span', { class: 'icon', text: 'i' }),
        el('div', {}, [
          el('strong', { text: unset.length + ' order(s) have no status set.' }),
          el('span', { class: 'detail', text: 'Where the tracker has a dated collection, delivery or invoice, the stage shown is read from it. Set them explicitly on the Order status page.' }),
        ]),
      ]));
    }

    const grid = el('div', { class: 'dash-grid' });

    /* ---------------- Contracts ---------------- */

    grid.appendChild(sectionHead('Contracts',
      'What each item has left to order, and the delivery dates its tracker already carries.'));
    grid.appendChild(contractsCard(contracts));

    /* ---------------- Schedule ---------------- */

    grid.appendChild(sectionHead('What is coming',
      'Requested collection and required delivery dates still outstanding, nearest first.'));
    grid.appendChild(scheduleCard(schedule));

    /* ---------------- Pipeline ---------------- */

    grid.appendChild(sectionHead('Pipeline',
      'Where the orders themselves stand.'));

    const stageSegments = (list, prefix, keyPrefix) => {
      const c = AMI.countByStatus(list);
      return AMI.ORDER_STATUSES.map((s) => {
        const key = keyPrefix + s.id;
        drill(key, (prefix ? prefix + ' — ' : '') + s.label,
          s.hint, list.filter((o) => o.status.statusId === s.id));
        return {
          label: (prefix ? prefix + ' — ' : '') + s.label,
          value: c[s.id], step: s.step, key,
          patternWord: AMI.patternWord(s),
        };
      });
    };

    grid.appendChild(chartCard({
      title: 'Order pipeline',
      note: orders.length + ' order(s) in scope',
      span: 2,
      build: () => [
        el('div', { html: AMI.stackedBar(stageSegments(orders, '', 'stage:'), { emptyText: 'No orders' }) }).firstChild,
        el('div', { html: AMI.statusLegend(AMI.ORDER_STATUSES, counts) }).firstChild,
        el('p', { class: 'help', style: 'margin:10px 0 0', text: 'Each stage has its own weave as well as its own shade — solid, diagonal, horizontal, vertical, in pipeline order. Click a band to list the orders in it.' }),
      ],
    }));

    const accountRows = [];
    const byAccount = new Map();
    for (const o of orders) {
      if (!byAccount.has(o.accountId)) byAccount.set(o.accountId, []);
      byAccount.get(o.accountId).push(o);
    }
    for (const [accountId, list] of byAccount) {
      const account = state.workspace.accounts.find((a) => a.id === accountId);
      if (!account) continue;
      accountRows.push({
        label: account.name,
        sub: AMI.divisionName(state.workspace, account.divisionId),
        segments: stageSegments(list, account.name, 'acct:' + accountId + ':'),
        meta: list.filter((x) => x.isOpen).length + ' open',
      });
    }
    accountRows.sort((a, b) => a.label.localeCompare(b.label));

    grid.appendChild(chartCard({
      title: 'Orders by account',
      build: () => [
        el('div', { html: AMI.barList(accountRows, { emptyText: 'No accounts in scope' }) }).firstChild,
        el('div', { html: AMI.statusLegend(AMI.ORDER_STATUSES) }).firstChild,
      ],
    }));

    /* Throughput */
    const collected = orders
      .filter((o) => o.dates.actualCollection)
      .map((o) => ({ date: o.dates.actualCollection, value: Number(o.values.cases) || 0, order: o }));
    const series = AMI.monthlySeries(collected, 12, new Date());
    for (const b of series) {
      b.key = 'month:' + b.year + '-' + b.month;
      drill(b.key, 'Collected in ' + b.label,
        'Orders whose actual collection date falls in this month.',
        collected.filter((e) => e.date.getFullYear() === b.year && e.date.getMonth() === b.month)
          .map((e) => e.order));
    }
    grid.appendChild(chartCard({
      title: 'Cases collected per month',
      note: 'last 12 months',
      build: (big) => [
        el('div', {
          html: AMI.columnChart(series, {
            unit: 'cases', ariaLabel: 'Cases collected per month',
            width: big ? 1000 : 640, height: big ? 340 : 168,
          }),
        }).firstChild,
        el('p', { class: 'help', style: 'margin:10px 0 0', text: 'Click a column to list the orders collected that month.' }),
      ],
    }));

    grid.appendChild(el('div', { class: 'card span-2' }, [
      el('h2', {}, [document.createTextNode('Pipeline board'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: 'drag a card to change its status' })]),
      el('div', { class: 'body' }, [buildKanban(orders)]),
    ]));

    /* ---------------- Attention ---------------- */

    grid.appendChild(sectionHead('Needs attention',
      'Dates that have passed, and orders nothing has happened to.'));

    grid.appendChild(missedCard(collectionsOverdue, deliveriesOverdue));

    /* Attention list */
    const stale = open.filter((o) => o.ageDays != null).sort((a, b) => b.ageDays - a.ageDays);
    const staleRow = (o) => {
      const key = 'order:' + o.key;
      drill(key, 'PO ' + o.po, o.accountName + ' · ' + o.itemName, [o]);
      return {
        label: 'PO ' + o.po,
        sub: o.accountName + ' · ' + o.itemName,
        value: o.ageDays,
        // Age is not a pipeline stage, so it borrows the reserved status palette
        // rather than the stage ramp — a stage weave here would mean nothing.
        tone: o.ageDays >= AMI.HEALTH_THRESHOLDS.criticalDays ? 'critical'
          : (o.ageDays >= AMI.HEALTH_THRESHOLDS.warningDays ? 'warning' : 'neutral'),
        key,
        meta: o.ageDays + ' d',
        tip: 'PO ' + o.po + ' — last dated activity '
          + (o.lastEvent ? AMI.formatShort(o.lastEvent) + ' (' + o.lastEventLabel + ')' : 'none') + '.',
      };
    };
    grid.appendChild(chartCard({
      title: 'Longest without movement',
      note: 'open orders, days since the last dated activity',
      build: (big) => [
        el('div', {
          html: AMI.barList((big ? stale : stale.slice(0, 8)).map(staleRow), { emptyText: 'No open orders' }),
        }).firstChild,
        el('p', { class: 'help', style: 'margin:12px 0 0', text: 'Amber past ' + AMI.HEALTH_THRESHOLDS.warningDays + ' days, red past ' + AMI.HEALTH_THRESHOLDS.criticalDays + '.' + (big || stale.length <= 8 ? '' : ' Showing the 8 oldest — expand for all ' + stale.length + '.') }),
      ],
    }));

    /* Account health table */
    const healthTable = el('table', { class: 'data' });
    healthTable.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Account' }), el('th', { text: 'Division' }), el('th', { text: 'Health' }),
      el('th', { text: 'Collections overdue' }), el('th', { text: 'Deliveries overdue' }),
      el('th', { text: 'Met late' }), el('th', { text: 'Open' }), el('th', { text: 'Follow-ups' }), el('th', {}),
    ])]));
    const healthBody = el('tbody');
    const accountsInScope = [...new Set(scope.map((p) => p.account.id))];
    for (const accountId of accountsInScope) {
      const account = state.workspace.accounts.find((a) => a.id === accountId);
      const list = orders.filter((o) => o.accountId === accountId);
      const fu = scope.filter((p) => p.account.id === accountId)
        .reduce((n, p) => n + p.followUps.filter((f) => !f.superseded).length, 0);
      const s = AMI.summariseAccount(account, AMI.divisionName(state.workspace, account.divisionId),
        list, fu, null, new Date());
      healthBody.appendChild(el('tr', {}, [
        el('td', {}, [el('b', { text: account.name })]),
        el('td', { text: s.divisionName || '—' }),
        el('td', { html: AMI.healthPill(s.health.level, s.health.reasons.join(' · ')) }),
        el('td', { class: 'num' }, [numberCell(s.collectionsOverdue)]),
        el('td', { class: 'num' }, [numberCell(s.deliveriesOverdue)]),
        el('td', {
          class: 'num',
          'data-tip': 'Collected or delivered, but after the date asked for. Nothing to chase — '
            + 'this is the record, not the workload, so it does not set the health mark.',
          text: (s.collectedLate + s.deliveredLate) || '—',
        }),
        el('td', { class: 'num', text: String(s.open) }),
        el('td', { class: 'num', text: String(s.followUps) }),
        el('td', {}, [
          el('button', {
            class: 'btn small', text: 'Orders',
            onclick: () => showDrill('Orders on ' + account.name,
              (s.divisionName ? s.divisionName + ' division · ' : '') + s.total + ' order(s)', list),
          }),
          el('button', {
            class: 'btn small', text: 'Summary',
            onclick: () => {
              state.filters.accountId = accountId;
              showTab('orderstatus');
              setTimeout(() => generateSummary(), 0);
            },
          }),
        ]),
      ]));
    }
    healthTable.appendChild(healthBody);
    grid.appendChild(el('div', { class: 'card span-2' }, [
      el('h2', {}, [document.createTextNode('Account health'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: 'set by collection and delivery dates that have passed unmet' })]),
      el('div', { class: 'body' }, [
        el('p', {
          class: 'help',
          text: 'At risk when a required delivery date has passed with no delivery recorded, or a '
            + 'requested collection is more than ' + AMI.HEALTH_THRESHOLDS.lateCollectionDays
            + ' days past. Needs attention when any collection date has passed unmet. '
            + '“Met late” counts orders that did happen, just after the date — a record of how the '
            + 'account has run, not work outstanding.',
        }),
        el('div', { class: 'table-scroll' }, [healthTable]),
      ]),
    ]));

    host.appendChild(grid);
    wireDrill(host);
  }

  /**
   * One delegated handler per host covers every mark inside it, now and after
   * any redraw. Wired once, because the host outlives the charts it holds.
   */
  function wireDrill(host) {
    if (host.dataset.drillWired) return;
    host.dataset.drillWired = '1';
    host.addEventListener('click', onDrillClick);
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onDrillClick(e);
    });
  }

  /* ------------------------------------------------------------------ *
   * Chart cards, zoom and drill-down
   * ------------------------------------------------------------------ */

  /** A full-width heading that breaks the dashboard into its four questions. */
  function sectionHead(title, sub) {
    return el('div', { class: 'dash-section' }, [
      el('h2', { text: title }),
      sub ? el('p', { text: sub }) : null,
    ]);
  }

  /** A count that stays quiet at zero and goes loud when it is not. */
  function numberCell(n) {
    if (!n) return el('span', { class: 'faint', text: '—' });
    return el('span', { class: 'chip error', text: String(n) });
  }

  const dateCell = (d, po) => (d
    ? el('span', {}, [
      document.createTextNode(AMI.formatShort(d)),
      po ? el('span', { class: 'note', text: ' PO ' + po }) : null,
    ])
    : el('span', { class: 'faint', text: 'none recorded' }));

  /**
   * Contract standing for every item in scope.
   *
   * The balance is the tracker's own running total, taken from the last order
   * row — not recomputed here. A negative balance is shown as negative and
   * flagged, because that is a real state their sheets get into and rounding it
   * up to zero would hide it.
   */
  function contractsCard(contracts) {
    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Item' }), el('th', { text: 'Cycle' }), el('th', { text: 'Contract' }),
      el('th', { text: 'Balance (bt)' }), el('th', { text: 'Balance (cs)' }),
      el('th', { text: 'Most recent delivery' }), el('th', { text: 'Furthest requested delivery' }),
      el('th', { text: 'Orders' }),
    ])]));
    const body = el('tbody');

    for (const c of contracts) {
      const chipClass = c.isOver ? 'error' : (c.isClosed ? 'ok' : 'pdf');
      body.appendChild(el('tr', {}, [
        el('td', {}, [
          el('b', { text: c.itemName || c.itemId }),
          el('div', { class: 'note', text: c.accountName }),
        ]),
        el('td', { text: c.cycle || '—' }),
        el('td', {}, [el('span', {
          class: 'chip ' + chipClass, text: c.stateLabel, 'data-tip': c.reason,
        })]),
        el('td', {
          class: 'num' + (c.isOver ? ' over' : ''),
          'data-tip': c.balanceFrom ? 'The tracker’s running balance after PO ' + c.balanceFrom + '.' : '',
          text: c.balanceBt == null ? '—' : c.balanceBt.toLocaleString(),
        }),
        el('td', {
          class: 'num' + (c.isOver ? ' over' : ''),
          text: c.balanceCs == null ? '—' : c.balanceCs.toLocaleString(),
        }),
        el('td', {}, [dateCell(c.lastDelivery, c.lastDeliveryPo)]),
        el('td', {}, [dateCell(c.furthestRequested, c.furthestRequestedPo)]),
        el('td', { class: 'num', text: c.open + ' / ' + c.orders }),
      ]));
    }
    table.appendChild(body);

    const over = contracts.filter((c) => c.isOver);
    const closed = contracts.filter((c) => c.isClosed);

    return el('div', { class: 'card span-2' }, [
      el('h2', {}, [
        document.createTextNode('Contract standing'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: contracts.length + ' item tracker(s) in scope' }),
      ]),
      el('div', { class: 'body' }, [
        over.length ? el('div', { class: 'msg error' }, [
          el('span', { class: 'icon', text: '!' }),
          el('div', {}, [
            el('strong', {
              text: over.length + ' item(s) have ordered past the contract: '
                + over.map((c) => c.itemName + ' (' + c.balanceBt.toLocaleString() + ' bt)').join(', '),
            }),
            el('span', {
              class: 'detail',
              text: 'The balance column on the tracker has gone below zero. Shown exactly as the '
                + 'sheet has it — check the contract quantity or the orders posted against it.',
            }),
          ]),
        ]) : null,
        closed.length ? el('div', { class: 'msg ok' }, [
          el('span', { class: 'icon', text: '✓' }),
          el('div', {}, [
            el('strong', {
              text: closed.length + ' item(s) are closed: ' + closed.map((c) => c.itemName).join(', '),
            }),
            el('span', { class: 'detail', text: 'The contract balance is zero — everything contracted has been ordered.' }),
          ]),
        ]) : null,
        contracts.length
          ? el('div', { class: 'table-scroll' }, [table])
          : el('div', { class: 'empty', text: 'No item trackers in scope.' }),
        el('p', {
          class: 'help',
          text: 'Balance is the tracker’s own running total after the last order on the sheet, not a '
            + 'figure worked out here. Dates are the latest delivery actually recorded and the '
            + 'furthest-out delivery date anyone has asked for.',
        }),
      ]),
    ]);
  }

  /**
   * Collections and deliveries still outstanding, by week or month.
   *
   * Overdue gets its own group at the top rather than being filed under the week
   * it was due — burying a missed date in a past week is how it stays missed.
   */
  function scheduleCard(entries) {
    const body = el('div');

    const draw = () => {
      clear(body);
      markActive();
      const groups = AMI.groupSchedule(entries, state.scheduleBy, new Date());
      if (!groups.length) {
        body.appendChild(el('div', { class: 'empty', text: 'Nothing outstanding — every collection and delivery date on the trackers has been met.' }));
        return;
      }
      for (const g of groups) {
        const table = el('table', { class: 'data' });
        table.appendChild(el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Date' }), el('th', { text: 'What' }), el('th', { text: 'PO' }),
          el('th', { text: 'Account' }), el('th', { text: 'Item' }), el('th', { text: 'Cases' }),
          el('th', { text: g.overdue ? 'Days past' : 'In' }),
        ])]));
        const rows = el('tbody');
        for (const e of g.entries) {
          rows.appendChild(el('tr', {}, [
            el('td', { text: AMI.formatShort(e.date) }),
            el('td', {}, [el('span', {
              class: 'chip ' + (e.kind === 'delivery' ? 'computed' : 'pdf'),
              text: e.label,
            })]),
            el('td', { class: 'mono', text: e.order.po }),
            el('td', { text: e.order.accountName }),
            el('td', { text: e.order.itemName }),
            el('td', { class: 'num', text: e.order.values.cases != null ? String(e.order.values.cases) : '—' }),
            el('td', { class: 'num', text: g.overdue ? Math.abs(e.days) + ' d' : e.days + ' d' }),
          ]));
        }
        table.appendChild(rows);

        body.appendChild(el('div', { class: 'sched-group' + (g.overdue ? ' overdue' : '') }, [
          el('div', { class: 'sched-head' }, [
            el('span', { class: 'sched-label', text: g.label }),
            g.sub ? el('span', { class: 'note', text: g.sub }) : null,
            el('span', { class: 'spacer' }),
            el('span', {
              class: 'chip ' + (g.overdue ? 'error' : 'manual'),
              text: g.entries.length + (g.overdue ? ' missed' : ' due'),
            }),
          ]),
          el('div', { class: 'table-scroll' }, [table]),
        ]));
      }
    };

    // The toggles outlive each redraw, so their active state has to be reapplied
    // rather than baked in when they are built.
    const toggles = ['week', 'month'].map((id) => el('button', {
      class: 'btn small',
      text: id === 'week' ? 'By week' : 'By month',
      onclick: () => { state.scheduleBy = id; saveLocal({ scheduleBy: id }); draw(); },
    }));

    const markActive = () => {
      toggles.forEach((b, i) => {
        b.classList.toggle('primary', state.scheduleBy === (i === 0 ? 'week' : 'month'));
        b.setAttribute('aria-pressed', state.scheduleBy === (i === 0 ? 'week' : 'month') ? 'true' : 'false');
      });
    };

    draw();

    return el('div', { class: 'card span-2' }, [
      el('h2', {}, [
        document.createTextNode('Upcoming collections and deliveries'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'chart-actions', role: 'group', 'aria-label': 'Group the schedule by' }, toggles),
      ]),
      el('div', { class: 'body' }, [
        el('p', {
          class: 'help',
          text: 'Every requested collection date with nothing collected yet, and every required '
            + 'delivery date with nothing delivered yet. A date that has been met drops off — it '
            + 'needs nothing.',
        }),
        body,
      ]),
    ]);
  }

  /** The dates that have already been missed, split by which kind. */
  function missedCard(collectionsOverdue, deliveriesOverdue) {
    const list = (title, orders, kind, tip) => {
      const table = el('table', { class: 'data' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: 'PO' }), el('th', { text: 'Account' }), el('th', { text: 'Item' }),
        el('th', { text: 'Due' }), el('th', { text: 'Days past' }),
      ])]));
      const body = el('tbody');
      const sorted = orders.slice().sort((a, b) =>
        b.schedule[kind].days - a.schedule[kind].days);
      for (const o of sorted) {
        body.appendChild(el('tr', {}, [
          el('td', { class: 'mono', text: o.po }),
          el('td', { text: o.accountName }),
          el('td', { text: o.itemName }),
          el('td', { text: AMI.formatShort(o.schedule[kind].due) }),
          el('td', { class: 'num' }, [el('span', {
            class: 'chip error', text: o.schedule[kind].days + ' d',
          })]),
        ]));
      }
      table.appendChild(body);

      return el('div', { class: 'missed-col' }, [
        el('h3', {}, [
          document.createTextNode(title),
          el('span', { class: 'spacer' }),
          el('span', {
            class: 'chip ' + (orders.length ? 'error' : 'ok'),
            text: String(orders.length),
          }),
        ]),
        el('p', { class: 'help', text: tip }),
        orders.length
          ? el('div', { class: 'table-scroll' }, [table])
          : el('div', { class: 'msg ok' }, [
            el('span', { class: 'icon', text: '✓' }),
            el('div', { text: 'Nothing past its date.' }),
          ]),
      ]);
    };

    return el('div', { class: 'card span-2' }, [
      el('h2', {}, [
        document.createTextNode('Dates that have passed'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: 'this is what sets account health' }),
      ]),
      el('div', { class: 'body' }, [
        el('div', { class: 'missed-grid' }, [
          list('Not collected', collectionsOverdue, 'collectionOverdue',
            'The requested collection date has passed and the tracker records no collection.'),
          list('Not delivered', deliveriesOverdue, 'deliveryOverdue',
            'The customer’s required delivery date has passed and the tracker records no delivery.'),
        ]),
      ]),
    ]);
  }

  /**
   * A dashboard card whose chart can be redrawn larger. `build(big)` returns the
   * nodes; it is called once for the card and again, with `big` set, for the
   * enlarged copy, so the two never drift apart.
   */
  function chartCard(spec) {
    const body = el('div', { class: 'body' }, spec.build(false));
    return el('div', { class: 'card' + (spec.span === 2 ? ' span-2' : '') }, [
      el('h2', {}, [
        document.createTextNode(spec.title),
        el('span', { class: 'spacer' }),
        spec.note ? el('span', { class: 'context-note', text: spec.note }) : null,
        el('button', {
          class: 'btn small',
          text: 'Expand',
          'data-tip': 'Open this chart larger, with every row rather than the top few.',
          onclick: () => openOverlay(spec.title, spec.note || '', (host) => {
            for (const n of spec.build(true)) host.appendChild(n);
            wireDrill(host);
          }, { wide: true }),
        }),
      ].filter(Boolean)),
      body,
    ]);
  }

  /** Record what sits behind a mark, so clicking it can show the orders. */
  function drill(key, title, sub, orders) {
    if (!state.drillIndex) state.drillIndex = new Map();
    state.drillIndex.set(key, { title, sub, orders });
  }

  function onDrillClick(e) {
    const mark = e.target.closest && e.target.closest('[data-drill]');
    if (!mark) return;
    if (e.type === 'keydown') e.preventDefault();
    const entry = state.drillIndex && state.drillIndex.get(mark.getAttribute('data-drill'));
    if (!entry) return;
    showDrill(entry.title, entry.sub, entry.orders);
  }

  /** The orders behind one mark, as a table you can act on. */
  function showDrill(title, sub, orders) {
    openOverlay(title, sub, (host) => {
      if (!orders.length) {
        host.appendChild(el('div', { class: 'empty', text: 'No orders here.' }));
        return;
      }
      host.appendChild(el('p', {
        class: 'drill-note',
        text: orders.length + ' order(s). Every column is read from the tracker or from a status '
          + 'someone set — nothing here is calculated for the chart.',
      }));

      const table = el('table', { class: 'data' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: 'PO' }), el('th', { text: 'Account' }), el('th', { text: 'Item' }),
        el('th', { text: 'Cases' }), el('th', { text: 'Stage' }), el('th', { text: 'Where it comes from' }),
        el('th', { text: 'Last dated activity' }), el('th', { text: 'Days' }),
      ])]));
      const body = el('tbody');
      const sorted = orders.slice().sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
      for (const o of sorted) {
        const st = AMI.statusById(o.status.statusId);
        body.appendChild(el('tr', {}, [
          el('td', {}, [el('b', { text: o.po })]),
          el('td', { text: o.accountName }),
          el('td', { text: o.itemName }),
          el('td', { class: 'num', text: o.values.cases != null ? String(o.values.cases) : '—' }),
          el('td', { html: AMI.statusPill(st, { short: true }) }),
          el('td', {}, [el('span', {
            class: 'chip ' + (SOURCE_CHIP[o.status.source] || 'manual'),
            text: SOURCE_LONG[o.status.source] || o.status.source,
            'data-tip': o.status.reason,
          })]),
          el('td', { text: o.lastEvent ? AMI.formatShort(o.lastEvent) + ' (' + o.lastEventLabel + ')' : '—' }),
          el('td', { class: 'num', text: o.ageDays == null ? '—' : String(o.ageDays) }),
        ]));
      }
      table.appendChild(body);
      host.appendChild(el('div', { class: 'table-scroll' }, [table]));

      host.appendChild(el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn', text: 'Set statuses for these',
          onclick: () => {
            if (closeOverlay) closeOverlay();
            showTab('orderstatus');
          },
        }),
      ]));
    }, { wide: true });
  }

  /* ------------------------------------------------------------------ *
   * Kanban
   * ------------------------------------------------------------------ */

  function buildKanban(orders) {
    const board = el('div', { class: 'kanban' });

    const columns = AMI.ORDER_STATUSES.map((s) => ({ status: s, orders: [] }));
    const unset = [];
    for (const o of orders) {
      const col = columns.find((c) => c.status.id === o.status.statusId);
      if (col) col.orders.push(o);
      else unset.push(o);
    }

    const makeColumn = (title, stage, list, statusId, hint) => {
      const cards = el('div', { class: 'kan-cards' });
      if (!list.length) cards.appendChild(el('div', { class: 'kan-empty', text: 'Nothing here' }));
      for (const o of list) cards.appendChild(makeCard(o));

      // The heading carries the stage's weave, so the columns stay apart at a
      // glance without depending on their shade.
      const head = el('div', {
        class: 'kan-head' + (stage ? ' ' + AMI.stageClass(stage.step) : ' kan-head-unset'),
        'data-tip': hint + (stage ? ' Shown as ' + AMI.patternWord(stage) + '.' : ''),
      }, [
        el('span', { class: 'kan-title', text: title }),
        el('span', { class: 'kan-count', text: String(list.length) }),
      ]);

      const col = el('div', { class: 'kan-col' }, [head, cards]);

      if (statusId) {
        col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-target'); });
        col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
        col.addEventListener('drop', async (e) => {
          e.preventDefault();
          col.classList.remove('drop-target');
          const key = e.dataTransfer.getData('text/plain');
          if (!key) return;
          if (await applyStatus(key, statusId)) {
            toast('Moved to ' + title + '.', 'ok');
            renderDashboard();
          }
        });
      }
      return col;
    };

    for (const c of columns) {
      board.appendChild(makeColumn(c.status.short, c.status, c.orders, c.status.id, c.status.hint));
    }
    if (unset.length) {
      board.appendChild(makeColumn('No status', null, unset, '',
        'Nothing in the tracker indicates a stage, and nobody has set one.'));
    }
    return board;
  }

  function makeCard(order) {
    const st = AMI.statusById(order.status.statusId);
    // Only the stage tokens, not the fill — a card is mostly text and needs a
    // plain ground. Its left rail carries the weave instead.
    const card = el('div', {
      class: 'kan-card ' + (st ? 'stage-' + st.step : 'kan-card-unset'),
      draggable: 'true',
      'data-tip': order.status.reason,
      'data-po': order.po,
    }, [
      el('div', { class: 'kan-po', text: order.po }),
      el('div', { class: 'kan-meta', text: order.accountName + ' · ' + order.itemName }),
      el('div', { class: 'kan-meta', text: (order.values.cases != null ? order.values.cases + ' cs' : '') }),
      el('div', { class: 'kan-foot' }, [
        el('span', {
          class: 'chip ' + SOURCE_CHIP[order.status.source],
          text: SOURCE_SHORT[order.status.source],
        }),
        el('span', { class: 'kan-age', text: order.ageDays == null ? '' : order.ageDays + ' d' }),
      ]),
    ]);
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', order.key);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    return card;
  }

  /* ------------------------------------------------------------------ *
   * Order status page
   * ------------------------------------------------------------------ */

  async function renderOrderStatus() {
    const host = $('#orderStatusBody');
    clear(host);
    if (!state.workspace || !currentUser()) {
      host.appendChild(el('div', { class: 'empty', text: 'Open the workspace and choose your name first.' }));
      return;
    }
    if (!state.portfolio) {
      host.appendChild(el('div', { class: 'empty', text: 'Reading the trackers for your accounts…' }));
      await ensurePortfolio();
      renderOrderStatus();
      return;
    }

    host.appendChild(pageHeader(
      'Orders',
      'Order status',
      'Set where each order stands. A status you set here is what the dashboard shows; where none is set, the stage is read from the tracker’s dated columns and labelled as such.',
      [
        closedToggle(() => renderOrderStatus()),
        el('button', { class: 'btn', text: 'Open Account Health', onclick: () => showTab('dashboard') }),
        el('button', { class: 'btn primary', text: 'Generate account summary', onclick: () => generateSummary() }),
      ],
    ));

    host.appendChild(filterBar(() => renderOrderStatus(), { withItem: true, withStatus: true, withSearch: true }));

    host.appendChild(el('div', { class: 'msg info' }, [
      el('span', { class: 'icon', text: 'i' }),
      el('div', {}, [
        el('strong', { text: 'An invoiced order is a closed order.' }),
        el('span', {
          class: 'detail',
          text: 'Invoicing is the end of the pipeline here, so the last stage reads '
            + '“Invoiced and Closed”. A NAV invoice number on the tracker puts an order there '
            + 'on its own. Use the “Hide invoiced and closed” switch on this page or on Account '
            + 'Health to work with only what is still live.',
        }),
      ]),
    ]));

    const f = state.filters;
    let orders = filteredOrders();
    if (f.statusId === '__open') orders = orders.filter((o) => o.isOpen);
    else if (f.statusId === '__unset') orders = orders.filter((o) => !o.status.statusId);
    else if (f.statusId) orders = orders.filter((o) => o.status.statusId === f.statusId);
    if (f.query) {
      const q = f.query.trim().toLowerCase();
      orders = orders.filter((o) => o.po.toLowerCase().includes(q));
    }
    orders.sort((a, b) => a.accountName.localeCompare(b.accountName)
      || a.itemName.localeCompare(b.itemName) || a.po.localeCompare(b.po));

    if (!orders.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No orders match these filters.' }));
      return;
    }

    /* Bulk action */
    const bulkSel = el('select', {}, [
      el('option', { value: '', text: 'Set selected to…' }),
      ...AMI.ORDER_STATUSES.map((s) => el('option', { value: s.id, text: s.label })),
      el('option', { value: '__clear', text: 'Clear status (fall back to the tracker)' }),
    ]);
    const selected = new Set();

    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', {}), el('th', { text: 'PO' }), el('th', { text: 'Account' }), el('th', { text: 'Item' }),
      el('th', { text: 'Cases' }), el('th', { text: 'Status' }), el('th', { text: 'Where it comes from' }),
      el('th', { text: 'Last dated activity' }), el('th', { text: 'Days' }),
    ])]));
    const tbody = el('tbody');

    for (const o of orders) {
      const st = AMI.statusById(o.status.statusId);
      const sel = el('select', {
        onchange: async (e) => {
          const v = e.target.value;
          if (await applyStatus(o.key, v === '__none' ? '' : v)) {
            toast('PO ' + o.po + ' → ' + (v === '__none' ? 'no status' : AMI.statusById(v).label), 'ok');
            renderOrderStatus();
          }
        },
      }, [
        el('option', { value: '__none', text: '— not set —', selected: o.status.source !== 'set' }),
        ...AMI.ORDER_STATUSES.map((s) => el('option', {
          value: s.id, selected: o.status.source === 'set' && s.id === o.status.statusId, text: s.label,
        })),
      ]);

      const box = el('input', {
        type: 'checkbox',
        onchange: (e) => { if (e.target.checked) selected.add(o.key); else selected.delete(o.key); },
      });

      tbody.appendChild(el('tr', {}, [
        el('td', {}, [box]),
        el('td', { class: 'mono', text: o.po }),
        el('td', { text: o.accountName }),
        el('td', { text: o.itemName }),
        el('td', { class: 'num', text: o.values.cases != null ? String(o.values.cases) : '—' }),
        el('td', {}, [
          el('div', { html: AMI.statusPill(st, { short: true, tip: o.status.reason }) }).firstChild,
          sel,
        ]),
        el('td', {}, [el('span', {
          class: 'chip ' + SOURCE_CHIP[o.status.source],
          text: SOURCE_LONG[o.status.source],
        }), el('div', { class: 'bar-sub', text: o.status.reason })]),
        el('td', { text: o.lastEvent ? AMI.formatShort(o.lastEvent) + ' · ' + o.lastEventLabel : '—' }),
        el('td', { class: 'num', text: o.ageDays == null ? '—' : String(o.ageDays) }),
      ]));
    }
    table.appendChild(tbody);

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Orders'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: orders.length + ' shown' })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'btn-row', style: 'margin:0 0 12px' }, [
          el('button', {
            class: 'btn small', text: 'Select all shown',
            onclick: () => {
              for (const o of orders) selected.add(o.key);
              $$('#orderStatusBody tbody input[type="checkbox"]').forEach((b) => { b.checked = true; });
            },
          }),
          bulkSel,
          el('button', {
            class: 'btn small primary', text: 'Apply',
            onclick: async () => {
              const v = bulkSel.value;
              if (!v) { toast('Choose a status first.', 'error'); return; }
              if (!selected.size) { toast('Nothing selected.', 'error'); return; }
              for (const key of selected) await applyStatus(key, v === '__clear' ? '' : v);
              toast(selected.size + ' order(s) updated.', 'ok');
              renderOrderStatus();
            },
          }),
        ]),
        el('div', { class: 'table-scroll' }, [table]),
      ]),
    ]));

    host.appendChild(el('div', { id: 'summaryHost' }));
    if (state.summaryHtml) renderSummaryCard();
  }

  /* ------------------------------------------------------------------ *
   * Account summary
   * ------------------------------------------------------------------ */

  function generateSummary() {
    const f = state.filters;
    const accounts = visibleAccounts();
    const account = accounts.find((a) => a.id === f.accountId);
    if (!account) {
      toast('Choose a single account first — a summary covers one account.', 'error');
      return;
    }
    const scope = filteredPortfolio().filter((p) => p.account.id === account.id);
    const orders = AMI.decorate(scope.flatMap((p) => p.orders),
      state.statusDoc || AMI.emptyStatusDoc(), new Date());
    const user = currentUser() || {};

    const built = AMI.buildAccountSummary({
      accountName: account.name,
      divisionName: AMI.divisionName(state.workspace, account.divisionId),
      itemNames: [...new Set(scope.map((p) => p.item.name))],
      orders,
      preparedBy: user.name || '',
      today: new Date(),
      openOnly: true,
    });
    state.summaryHtml = built.html;
    state.summaryMeta = { account, built };
    renderSummaryCard();
    const holder = $('#summaryHost');
    if (holder) holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSummaryCard() {
    const holder = $('#summaryHost');
    if (!holder) return;
    clear(holder);
    const meta = state.summaryMeta;
    if (!state.summaryHtml || !meta) return;
    const account = meta.account;
    const user = currentUser() || {};

    holder.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode('Account summary — ' + account.name),
        el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: meta.built.open + ' open of ' + meta.built.total }),
        el('button', { class: 'btn small ghost', text: 'Close', onclick: () => { state.summaryHtml = ''; clear(holder); } }),
      ]),
      el('div', { class: 'body' }, [
        el('div', { class: 'email-preview', html: state.summaryHtml }),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn', text: 'Copy',
            onclick: async () => {
              try {
                await navigator.clipboard.write([new ClipboardItem({
                  'text/html': new Blob([state.summaryHtml], { type: 'text/html' }),
                })]);
                toast('Summary copied.', 'ok');
              } catch (e) { toast('Clipboard blocked here; use a download instead.', 'error'); }
            },
          }),
          el('button', {
            class: 'btn', text: 'Download as HTML',
            onclick: () => download(
              new Blob(['<!doctype html><meta charset="utf-8"><title>'
                + account.name + ' summary</title>' + state.summaryHtml], { type: 'text/html' }),
              safeName(account.name + ' account summary ' + stamp()) + '.html'),
          }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'btn primary', text: 'Email it (.eml draft)',
            onclick: () => {
              const recipients = AMI.resolveRecipients(account, null, 'customer', null, user);
              const eml = AMI.buildEml({
                from: user.email ? (user.name ? user.name + ' <' + user.email + '>' : user.email) : '',
                to: recipients.to, cc: recipients.cc,
                subject: account.name + ' — open order summary, ' + AMI.formatEmailDate(new Date()),
                html: '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">'
                  + state.summaryHtml + (user.signature || '') + '</body></html>',
              });
              download(new Blob([eml], { type: 'message/rfc822' }),
                safeName(account.name + ' summary ' + stamp()) + '.eml');
              toast('Draft saved. Double-click it to open in Outlook.', 'ok');
            },
          }),
        ]),
      ]),
    ]));
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
    initTooltip();
    renderWorkspace();
    refreshTabs();
    showTab('workspace');

    // Saved work is not the same as posted work, so say so on the way out.
    window.addEventListener('beforeunload', (e) => {
      if (!unpostedCount()) return;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });

    // A debounced save may still be pending when the tab goes away.
    const flush = () => { saveSessionSoon.flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });

    bootstrap();
  }

  /** Reconnect to last time's folder, and load any saved work, without blocking startup. */
  async function bootstrap() {
    state.canRemember = await AMI.persistAvailable();
    if (!state.canRemember) { renderWorkspace(); return; }
    const reconnected = await tryReconnect();
    if (!reconnected) {
      state.pendingSession = await AMI.loadSession();
      renderWorkspace();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
