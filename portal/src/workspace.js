/* Workspace model: divisions, accounts, users and per-account templates,
 * stored as plain files inside a OneDrive/SharePoint-synced folder.
 *
 * Pure logic only. File access goes through a small `store` interface so the
 * same code runs against a real directory handle in the browser and an
 * in-memory store in the tests.
 *
 *   store.read(path)   -> Uint8Array | null
 *   store.write(path, bytes)
 *   store.list(dir)    -> [{ name, kind }]
 *   store.remove(path)
 *
 * Extends the global `AMI` namespace.
 */
(function (global) {
  'use strict';

  const AMI = global.AMI || (global.AMI = {});
  const DEC = new TextDecoder('utf-8');
  const ENC = new TextEncoder();

  const CONFIG_PATH = 'workspace.json';
  const TEMPLATE_DIR = 'templates';
  const SCHEMA_VERSION = 1;

  /** The counterparties a template can address. */
  const ROLES = [
    { id: 'vendor', name: 'Vendor / winery', hint: 'Order placement, confirmations, document chasing.' },
    { id: 'trucker', name: 'Trucker / forwarder', hint: 'Collection booking, delivery confirmation, freight documents.' },
    { id: 'customer', name: 'Customer / airline', hint: 'Order acknowledgement, delivery updates, delays.' },
    { id: 'internal', name: 'Internal', hint: 'Handovers, escalations, accounting notes.' },
  ];

  function slug(text) {
    return String(text || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item';
  }

  function uniqueId(base, taken) {
    let id = slug(base);
    let n = 2;
    while (taken.includes(id)) id = slug(base) + '-' + n++;
    return id;
  }

  function nowIso() { return new Date().toISOString(); }

  /* ------------------------------------------------------------------ *
   * Schema
   * ------------------------------------------------------------------ */

  function defaultWorkspace() {
    return {
      version: SCHEMA_VERSION,
      updated: nowIso(),
      updatedBy: '',
      divisions: [
        { id: 'europe', name: 'Europe' },
        { id: 'us', name: 'US' },
      ],
      users: [],
      accounts: [],
    };
  }

  function normaliseWorkspace(raw) {
    const ws = Object.assign(defaultWorkspace(), raw || {});
    ws.divisions = (ws.divisions || []).map((d) => ({ id: slug(d.id || d.name), name: d.name || d.id }));
    ws.users = (ws.users || []).map((u) => ({
      id: slug(u.id || u.name),
      name: u.name || '',
      email: u.email || '',
      divisionId: u.divisionId || '',
      accountIds: Array.isArray(u.accountIds) ? u.accountIds.slice() : [],
      signature: u.signature || '',
      defaultCc: u.defaultCc || '',
      isAdmin: !!u.isAdmin,
    }));
    ws.accounts = (ws.accounts || []).map((a) => {
      const account = {
        id: slug(a.id || a.name),
        name: a.name || '',
        divisionId: a.divisionId || '',
        defaultCc: a.defaultCc || '',
        contacts: Object.assign({ vendor: {}, trucker: {}, customer: {}, internal: {} }, a.contacts || {}),
        notes: a.notes || '',
        items: [],
      };

      const takenIds = [];
      account.items = (a.items || []).map((it) => {
        const id = uniqueId(it.id || it.name || 'item', takenIds);
        takenIds.push(id);
        return {
          id,
          name: it.name || '',
          product: it.product || '',
          navCode: it.navCode || '',
          trackerPath: it.trackerPath || '',
          sheet: it.sheet || '',
          contacts: Object.assign({ vendor: {}, trucker: {}, customer: {}, internal: {} }, it.contacts || {}),
          notes: it.notes || '',
        };
      });

      // An account written before items existed carried a single tracker.
      if (!account.items.length && (a.trackerPath || a.product)) {
        account.items.push({
          id: 'item-1',
          name: a.product || account.name,
          product: a.product || '',
          navCode: a.navCode || '',
          trackerPath: a.trackerPath || '',
          sheet: a.sheet || '',
          contacts: { vendor: {}, trucker: {}, customer: {}, internal: {} },
          notes: '',
        });
      }
      return account;
    });
    return ws;
  }

  /** Structural problems that would make the workspace behave unpredictably. */
  function validateWorkspace(ws) {
    const issues = [];
    const divisionIds = ws.divisions.map((d) => d.id);
    const accountIds = ws.accounts.map((a) => a.id);

    const seenAccount = new Set();
    for (const a of ws.accounts) {
      if (!a.name) issues.push({ level: 'error', message: 'An account has no name.' });
      if (seenAccount.has(a.id)) issues.push({ level: 'error', message: 'Two accounts share the id "' + a.id + '".' });
      seenAccount.add(a.id);
      if (a.divisionId && !divisionIds.includes(a.divisionId)) {
        issues.push({ level: 'error', message: 'Account "' + a.name + '" points at a division that no longer exists.' });
      }
      if (!a.divisionId) issues.push({ level: 'warn', message: 'Account "' + a.name + '" has no division.' });
      if (!a.items.length) {
        issues.push({ level: 'warn', message: 'Account "' + a.name + '" has no items yet.' });
      }

      const seenPath = new Map();
      for (const it of a.items) {
        const where = 'Item "' + (it.name || it.id) + '" on ' + a.name;
        if (!it.name) issues.push({ level: 'error', message: 'An item on "' + a.name + '" has no name.' });
        if (!it.trackerPath) issues.push({ level: 'warn', message: where + ' has no tracker file assigned.' });
        else {
          const key = it.trackerPath + '::' + (it.sheet || '');
          if (seenPath.has(key)) {
            issues.push({
              level: 'error',
              message: where + ' and "' + seenPath.get(key) + '" post to the same sheet of the same workbook.',
            });
          }
          seenPath.set(key, it.name || it.id);
        }
      }
    }

    const seenUser = new Set();
    for (const u of ws.users) {
      if (!u.name) issues.push({ level: 'error', message: 'A user has no name.' });
      if (seenUser.has(u.id)) issues.push({ level: 'error', message: 'Two users share the id "' + u.id + '".' });
      seenUser.add(u.id);
      if (u.divisionId && !divisionIds.includes(u.divisionId)) {
        issues.push({ level: 'error', message: 'User "' + u.name + '" points at a division that no longer exists.' });
      }
      for (const id of u.accountIds) {
        if (!accountIds.includes(id)) {
          issues.push({ level: 'warn', message: 'User "' + u.name + '" is assigned to an account that no longer exists.' });
        }
      }
    }
    return issues;
  }

  /* ------------------------------------------------------------------ *
   * Visibility
   * ------------------------------------------------------------------ */

  /**
   * Accounts a user works on. An admin, or a user with no explicit assignment,
   * sees every account in their own division.
   *
   * This organises the view; it is not a security boundary. File access is
   * governed by SharePoint permissions on the folder.
   */
  function accountsForUser(ws, userId) {
    const user = ws.users.find((u) => u.id === userId);
    if (!user) return [];
    if (user.isAdmin) return ws.accounts.slice();
    if (user.accountIds && user.accountIds.length) {
      return ws.accounts.filter((a) => user.accountIds.includes(a.id));
    }
    return ws.accounts.filter((a) => a.divisionId === user.divisionId);
  }

  function divisionName(ws, divisionId) {
    const d = ws.divisions.find((x) => x.id === divisionId);
    return d ? d.name : '';
  }

  /** Group accounts by division, for the account switcher. */
  function accountsByDivision(ws, accounts) {
    const groups = [];
    for (const d of ws.divisions) {
      const inDivision = accounts.filter((a) => a.divisionId === d.id);
      if (inDivision.length) groups.push({ division: d, accounts: inDivision });
    }
    const orphans = accounts.filter((a) => !ws.divisions.some((d) => d.id === a.divisionId));
    if (orphans.length) groups.push({ division: { id: '', name: 'Unassigned' }, accounts: orphans });
    return groups;
  }

  /* ------------------------------------------------------------------ *
   * Items
   * ------------------------------------------------------------------ */

  const accountItems = (account) => (account && account.items ? account.items : []);

  function findItem(account, itemId) {
    return accountItems(account).find((i) => i.id === itemId) || null;
  }

  function addItem(account, name) {
    const item = {
      id: uniqueId(name || 'item', accountItems(account).map((i) => i.id)),
      name: name || '',
      product: '', navCode: '', trackerPath: '', sheet: '',
      contacts: { vendor: {}, trucker: {}, customer: {}, internal: {} },
      notes: '',
    };
    account.items.push(item);
    return item;
  }

  const norm = (s) => String(s || '').trim().toUpperCase();

  /**
   * Decide which of an account's items a purchase order belongs to.
   *
   * `configs` maps item id to the constants read from that item's tracker, so
   * the NAV code is taken from the workbook itself rather than a stale copy.
   * Returns the item and the reason, or a null item and why nothing matched —
   * it never falls back to "the first one".
   */
  function matchItemForPo(items, configs, po) {
    const cfgs = configs || {};
    const code = norm(po && po.itemNo);

    if (code) {
      const byCode = items.filter((it) => {
        const cfg = cfgs[it.id] || {};
        return [cfg.navCode, it.navCode].filter(Boolean).map(norm).includes(code);
      });
      if (byCode.length === 1) {
        return { item: byCode[0], reason: 'item number ' + code + ' matches this item\'s tracker', confident: true };
      }
      if (byCode.length > 1) {
        return {
          item: null, confident: false,
          reason: 'item number ' + code + ' matches more than one item ('
            + byCode.map((i) => i.name).join(', ') + ') — pick the right one',
        };
      }
    }

    const desc = String((po && po.description) || '').toLowerCase().trim();
    if (desc) {
      const byName = items.filter((it) => {
        const cfg = cfgs[it.id] || {};
        const name = String(cfg.productName || it.product || it.name || '').toLowerCase().trim();
        return name && (name.includes(desc) || desc.includes(name));
      });
      if (byName.length === 1) {
        return { item: byName[0], reason: 'product description matches this item', confident: true };
      }
    }

    return {
      item: null, confident: false,
      reason: code
        ? 'no item on this account has item number ' + code
        : 'this PO carries no item number to match on',
    };
  }

  /* ------------------------------------------------------------------ *
   * Template files
   * ------------------------------------------------------------------ */

  const META_OPEN = '<!--ami-template';
  const META_CLOSE = '-->';

  /**
   * Templates are stored as ordinary .html files with a JSON header comment,
   * so they open in a browser and read sensibly in SharePoint.
   */
  function templateFileText(meta, html) {
    const header = {
      label: meta.label || '',
      role: meta.role || '',
      itemId: meta.itemId || '',
      subject: meta.subject || '',
      to: meta.to || '',
      cc: meta.cc || '',
      source: meta.source || '',
      updated: meta.updated || nowIso(),
    };
    return META_OPEN + '\n' + JSON.stringify(header, null, 2) + '\n' + META_CLOSE + '\n' + (html || '');
  }

  function parseTemplateFileText(text) {
    const s = String(text);
    if (!s.startsWith(META_OPEN)) {
      return { label: '', role: '', itemId: '', subject: '', to: '', cc: '', source: '', updated: '', html: s.trim() };
    }
    const end = s.indexOf(META_CLOSE);
    if (end < 0) throw new Error('Template header is not closed.');
    const json = s.slice(META_OPEN.length, end).trim();
    let meta = {};
    try { meta = JSON.parse(json); } catch (e) { throw new Error('Template header is not valid JSON.'); }
    return Object.assign({ label: '', role: '', itemId: '', subject: '', to: '', cc: '', source: '', updated: '' }, meta, {
      html: s.slice(end + META_CLOSE.length).replace(/^\r?\n/, ''),
    });
  }

  const templateDirFor = (accountId) => TEMPLATE_DIR + '/' + accountId;
  const templatePathFor = (accountId, templateId) => templateDirFor(accountId) + '/' + templateId + '.html';

  /* ------------------------------------------------------------------ *
   * Store operations
   * ------------------------------------------------------------------ */

  async function loadWorkspace(store) {
    const bytes = await store.read(CONFIG_PATH);
    if (!bytes) return { workspace: normaliseWorkspace(defaultWorkspace()), created: true };
    let parsed;
    try { parsed = JSON.parse(DEC.decode(bytes)); } catch (e) {
      throw new Error('workspace.json could not be read: ' + e.message);
    }
    return { workspace: normaliseWorkspace(parsed), created: false };
  }

  /**
   * Write the workspace back, refusing to clobber a newer copy written by a
   * colleague since this one was loaded.
   */
  async function saveWorkspace(store, ws, opts) {
    const options = opts || {};
    if (!options.force) {
      const existing = await store.read(CONFIG_PATH);
      if (existing) {
        try {
          const onDisk = JSON.parse(DEC.decode(existing));
          if (onDisk.updated && options.loadedAt && onDisk.updated > options.loadedAt) {
            const err = new Error('workspace.json was changed by '
              + (onDisk.updatedBy || 'someone else') + ' at ' + onDisk.updated + '.');
            err.code = 'STALE';
            err.onDisk = normaliseWorkspace(onDisk);
            throw err;
          }
        } catch (e) {
          if (e.code === 'STALE') throw e;
          // Unparseable existing file: overwrite it rather than block the user.
        }
      }
    }
    const out = Object.assign({}, ws, { version: SCHEMA_VERSION, updated: nowIso(), updatedBy: options.by || '' });
    await store.write(CONFIG_PATH, ENC.encode(JSON.stringify(out, null, 2)));
    return out;
  }

  async function listTemplates(store, accountId) {
    const dir = templateDirFor(accountId);
    const entries = await store.list(dir);
    const out = [];
    for (const e of entries) {
      if (e.kind !== 'file' || !/\.html$/i.test(e.name)) continue;
      const bytes = await store.read(dir + '/' + e.name);
      if (!bytes) continue;
      try {
        const parsed = parseTemplateFileText(DEC.decode(bytes));
        out.push(Object.assign(parsed, {
          id: e.name.replace(/\.html$/i, ''),
          path: dir + '/' + e.name,
          accountId,
        }));
      } catch (err) {
        out.push({
          id: e.name.replace(/\.html$/i, ''), path: dir + '/' + e.name, accountId,
          label: e.name, role: '', itemId: '', subject: '', html: '', error: err.message,
        });
      }
    }
    out.sort((a, b) => (a.role || '').localeCompare(b.role || '') || (a.label || '').localeCompare(b.label || ''));
    return out;
  }

  async function saveTemplate(store, accountId, template) {
    const existing = await listTemplates(store, accountId);
    const id = template.id || uniqueId(template.label || template.role || 'template', existing.map((t) => t.id));
    const path = templatePathFor(accountId, id);
    const text = templateFileText({
      label: template.label, role: template.role, itemId: template.itemId || '',
      subject: template.subject, to: template.to, cc: template.cc,
      source: template.source, updated: nowIso(),
    }, template.html);
    await store.write(path, ENC.encode(text));
    return Object.assign({}, template, { id, path, accountId, updated: nowIso() });
  }

  async function deleteTemplate(store, accountId, templateId) {
    await store.remove(templatePathFor(accountId, templateId));
  }

  /* ------------------------------------------------------------------ *
   * Recipient resolution
   * ------------------------------------------------------------------ */

  function formatAddress(contact) {
    if (!contact) return '';
    const name = (contact.name || '').trim();
    const email = (contact.email || '').trim();
    if (name && email) return name + ' <' + email + '>';
    return email || '';
  }

  /**
   * Work out who a draft should go to, preferring the address printed on the
   * purchase order and falling back to the account's saved contact.
   * Every result reports which of the two it came from.
   */
  function resolveRecipients(account, item, role, po, user) {
    const accountContact = (account && account.contacts && account.contacts[role]) || {};
    const itemContact = (item && item.contacts && item.contacts[role]) || {};
    let to = '';
    let toSource = '';

    if (role === 'vendor' && po && po.vendorEmail) {
      to = po.vendorContact ? po.vendorContact + ' <' + po.vendorEmail + '>' : po.vendorEmail;
      toSource = 'vendor block on the PO';
    } else if (formatAddress(itemContact)) {
      to = formatAddress(itemContact);
      toSource = 'item contact';
    } else if (formatAddress(accountContact)) {
      to = formatAddress(accountContact);
      toSource = 'account contact';
    }

    const ccParts = [];
    if (role === 'vendor' && po && po.docsTo) ccParts.push(po.docsTo);
    if (account && account.defaultCc) ccParts.push(account.defaultCc);
    if (user && user.defaultCc) ccParts.push(user.defaultCc);
    if (accountContact.cc) ccParts.push(accountContact.cc);
    if (itemContact.cc) ccParts.push(itemContact.cc);

    const seen = new Set();
    const cc = ccParts
      .join(',')
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => {
        if (!s) return false;
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .join('; ');

    return { to, toSource, cc };
  }

  /* ------------------------------------------------------------------ *
   * Path helpers
   * ------------------------------------------------------------------ */

  function splitPath(path) {
    return String(path || '').split('/').filter((p) => p !== '' && p !== '.');
  }

  /** Find spreadsheets anywhere under the workspace, for the tracker picker. */
  async function findWorkbooks(store, root, depth) {
    const maxDepth = depth == null ? 3 : depth;
    const out = [];
    async function walk(dir, level) {
      if (level > maxDepth) return;
      let entries = [];
      try { entries = await store.list(dir); } catch (e) { return; }
      for (const e of entries) {
        const path = dir ? dir + '/' + e.name : e.name;
        if (e.kind === 'directory') {
          if (e.name.startsWith('.') || e.name === TEMPLATE_DIR) continue;
          await walk(path, level + 1);
        } else if (/\.xlsx?m?$/i.test(e.name) && !e.name.startsWith('~$')) {
          out.push(path);
        }
      }
    }
    await walk(root || '', 0);
    out.sort();
    return out;
  }

  Object.assign(AMI, {
    CONFIG_PATH, TEMPLATE_DIR, ROLES, SCHEMA_VERSION,
    defaultWorkspace, normaliseWorkspace, validateWorkspace,
    accountsForUser, accountsByDivision, divisionName,
    accountItems, findItem, addItem, matchItemForPo,
    templateFileText, parseTemplateFileText, templateDirFor, templatePathFor,
    loadWorkspace, saveWorkspace, listTemplates, saveTemplate, deleteTemplate,
    resolveRecipients, formatAddress, findWorkbooks, splitPath, slug, uniqueId,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = AMI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
