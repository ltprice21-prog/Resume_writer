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
  const unroutedPos = () => state.pos.filter((p) => p.include && p.po && !p.itemId);

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  const RENDERERS = {
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
    const { workspace, created } = await AMI.loadWorkspace(store);
    state.workspace = workspace;
    state.loadedAt = workspace.updated;

    const saved = loadLocal();
    if (saved.userId && workspace.users.some((u) => u.id === saved.userId)) state.userId = saved.userId;
    else if (workspace.users.length === 1) state.userId = workspace.users[0].id;

    const accounts = visibleAccounts();
    const preferred = saved.accountId && accounts.some((a) => a.id === saved.accountId)
      ? saved.accountId : (accounts.length ? accounts[0].id : '');

    renderHeaderBar();
    if (preferred) await selectAccount(preferred, saved.itemId);
    else { renderWorkspace(); refreshTabs(); }

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
              el('div', {}, [el('strong', { text: (item.name || item.id) + ': ' + st.error })]),
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

    host.appendChild(el('div', { class: 'btn-row' }, [
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
    renderIntake(); renderReview(); refreshTabs();

    const unrouted = unroutedPos().length;
    if (unrouted) toast(unrouted + ' PO(s) could not be matched to an item — choose one on each card.', 'error');
  }

  function renderIntake() {
    const host = $('#ordersBody');
    clear(host);
    const account = currentAccount();
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
          onchange: async (e) => { entry.include = e.target.checked; await rebuildPlans(); renderIntake(); renderReview(); refreshTabs(); },
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
            await rebuildPlans(); renderIntake(); renderReview(); refreshTabs();
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
            await rebuildPlans();
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
            onchange: async (e) => { entry.overrides[f.col] = e.target.value; await rebuildPlans(); renderReview(); },
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
      await rebuildPlans();
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

    return {
      rows, included, first, recipients, item,
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
      },
    };
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
      onclick: () => { state.selectedRole = r.id; state.selectedTemplateId = ''; state.emailOverrides = {}; renderEmail(); },
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
        attachBox, document.createTextNode('Attach the ' + included.length + ' PO PDF(s) for ' + item.name),
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
      const saved = await AMI.saveTemplate(state.store, account.id, {
        label: parsed.subject ? parsed.subject.slice(0, 60) : file.name.replace(/\.[a-z0-9]+$/i, ''),
        role: state.selectedRole, itemId: '',
        subject: parsed.subject, to: parsed.to, cc: parsed.cc,
        html: parsed.html, source: file.name + ' — ' + parsed.bodySource,
      });
      state.templates = await AMI.listTemplates(state.store, account.id);
      toast('Imported ' + file.name + ' (' + parsed.bodySource + '). Set its role, item scope and placeholders.', 'ok');
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
    const sheet = el('input', { type: 'text', value: it.sheet, placeholder: 'auto — last sheet with a PO# header' });
    const trackerPath = el('input', { type: 'text', value: it.trackerPath, placeholder: 'trackers/Item Tracking Chart.xlsx' });
    const notes = el('input', { type: 'text', value: it.notes });
    const contactInputs = {};

    const trackerPick = el('select', {}, [el('option', { value: '', text: 'Scanning folder…' })]);
    const usedPaths = ws.accounts.flatMap((acc) => AMI.accountItems(acc)
      .filter((x) => x !== it && x.trackerPath).map((x) => x.trackerPath));
    AMI.findWorkbooks(state.store, '', 4).then((paths) => {
      clear(trackerPick);
      trackerPick.appendChild(el('option', { value: '', text: paths.length ? 'Pick a workbook…' : 'No workbooks found in this folder' }));
      for (const p of paths) {
        trackerPick.appendChild(el('option', {
          value: p, selected: p === it.trackerPath,
          text: p + (usedPaths.includes(p) ? '  (already used by another item)' : ''),
        }));
      }
    });
    trackerPick.addEventListener('change', () => { if (trackerPick.value) trackerPath.value = trackerPick.value; });

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        document.createTextNode(a.name + ' → item: ' + (it.name || it.id)),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Back to account', onclick: () => openAccountEditor(a.id) }),
      ]),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid-2' }, [
          editorField('Item name', name, 'How it appears in the item switcher.'),
          editorField('Sheet to post into', sheet),
        ]),
        el('h3', { text: 'Tracker' }),
        editorField('Workbook in this folder', trackerPick),
        editorField('Path', trackerPath, 'Relative to the workspace folder.'),
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
              it.sheet = sheet.value.trim();
              it.trackerPath = trackerPath.value.trim();
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

    host.appendChild(el('p', { class: 'help', text: 'Every item tracker on ' + account.name + ' is scanned. Each line names the blank column and the dated column it is measured from — nothing here is inferred.' }));

    if (!state.openItems.length) {
      host.appendChild(el('div', { class: 'msg ok' }, [el('span', { class: 'icon', text: '✓' }), el('div', { text: 'Nothing outstanding across any item.' })]));
      return;
    }

    const byParty = {};
    for (const i of state.openItems) (byParty[i.party] = byParty[i.party] || []).push(i);

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
