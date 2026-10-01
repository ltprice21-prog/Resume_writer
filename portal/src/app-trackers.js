/* AMI Order Desk (Teams) — the Order trackers page: edit tracker rows in place.
 *
 * Builds on `AMI.ui` (app-teams.js) and the cell-editing functions in engine.js.
 *
 * The tracker workbook in the shared folder is the one source of truth, so a
 * change made here is a change to that file. Every save:
 *   - checks the file has not changed on disk since it was opened, and refuses
 *     if a colleague got there first;
 *   - writes a timestamped backup beside the workbook;
 *   - refuses any cell that holds a formula, so the tracker's shared formulas
 *     are never overwritten;
 *   - tells every other page to read the trackers again, and logs who changed
 *     what on each affected order.
 * Colleagues see the change when the shared folder syncs and they next open or
 * return to the app. No network access of any kind.
 */
(function () {
  'use strict';

  const ui = typeof AMI !== 'undefined' ? AMI.ui : null;
  if (!ui) return;
  const { state, RENDERERS, $, el, clear, toast } = ui;

  const SHOW = 40;

  /** What is open: one item's tracker, and the edits not yet saved. */
  let edit = null;
  let showAll = false;
  let query = '';

  const fileOf = (p) => String(p || '').split('/').pop();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = () => {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes());
  };
  const sameBytes = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const isoOf = (serial) => {
    const d = AMI.serialToDate(serial);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  /** Every item the person can see that has a tracker to open. */
  function trackerChoices() {
    const out = [];
    for (const account of ui.visibleAccounts()) {
      for (const item of AMI.accountItems(account)) {
        if (item.trackerPath) out.push({ account, item, key: account.id + '/' + item.id });
      }
    }
    return out;
  }

  async function openTracker(choice) {
    const bytes = await state.store.read(choice.item.trackerPath);
    if (!bytes) throw new Error('The tracker is not at ' + choice.item.trackerPath + '.');
    const wb = await AMI.Workbook.load(bytes);
    let name = '';
    if (choice.item.sheet && wb.sheet(choice.item.sheet) && AMI.findHeaderRow(wb.sheet(choice.item.sheet))) name = choice.item.sheet;
    else for (const s of wb.sheets) if (!name && AMI.findHeaderRow(s)) name = s.name;
    if (!name) throw new Error('No sheet in ' + fileOf(choice.item.trackerPath) + ' has a “PO#” header row.');
    const sheet = wb.sheet(name);
    edit = {
      choice, bytes, wb, sheet, sheetName: name, header: AMI.findHeaderRow(sheet),
      pending: new Map(), stale: false, store: state.store,
    };
  }

  const keyOf = (row, col) => row + '|' + col;
  const poOf = (row) => edit.sheet.cellText(row, (edit.header.columns.find((c) => /^PO\s*#/i.test(c.header)) || {}).col).trim();

  /* ------------------------------------------------------------------ *
   * Page
   * ------------------------------------------------------------------ */

  async function render() {
    const host = $('#trackersBody');
    clear(host);
    if (!state.workspace || !ui.currentUser() || !state.store) {
      host.appendChild(el('div', { class: 'empty', text: 'Open the workspace and choose your name first.' }));
      return;
    }
    const choices = trackerChoices();
    if (!choices.length) {
      host.appendChild(ui.pageHeader('Work', 'Order trackers', '', []));
      host.appendChild(el('div', { class: 'empty', text: 'None of your accounts has an item with a tracker yet. Add one under Accounts & people.' }));
      return;
    }

    if (edit && edit.store !== state.store) edit = null;     // a different workspace folder
    if (!edit || !choices.some((c) => c.key === edit.choice.key)) {
      const preferred = choices.find((c) => c.account.id === state.accountId && c.item.id === state.itemId) || choices[0];
      try { await openTracker(preferred); } catch (e) {
        host.appendChild(el('div', { class: 'msg error' }, [el('span', { class: 'icon', text: '!' }), el('div', { text: e.message })]));
        edit = null;
        return;
      }
    }

    host.appendChild(ui.pageHeader('Work', 'Order trackers',
      'Edit the tracker itself. Each save updates the workbook in the shared folder, after writing a timestamped backup beside it. '
      + 'Every other page reads the same file, so a date entered here moves an order along at once; colleagues see it when the shared folder syncs. '
      + 'Cells the sheet calculates are shown but cannot be changed — the tracker’s formulas are never overwritten.',
      [el('button', { class: 'btn', text: 'Reload from the folder', onclick: () => reload(true) })]));

    const picker = el('select', {
      'aria-label': 'Tracker',
      onchange: async (e) => {
        if (edit.pending.size && !window.confirm('You have ' + edit.pending.size + ' unsaved change(s). Switch trackers and lose them?')) {
          e.target.value = edit.choice.key;
          return;
        }
        const next = choices.find((c) => c.key === e.target.value);
        try { await openTracker(next); showAll = false; query = ''; render(); } catch (err) { toast(err.message, 'error'); }
      },
    }, choices.map((c) => el('option', { value: c.key, selected: c.key === edit.choice.key, text: c.account.name + ' — ' + c.item.name })));

    const search = el('input', { type: 'text', value: query, placeholder: 'PO number…' });
    search.addEventListener('input', () => { query = search.value; drawTable(); });

    host.appendChild(el('div', { class: 'filter-bar' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Tracker' }), picker]),
      el('label', { class: 'field' }, [el('span', { text: 'Find' }), search]),
      el('span', { class: 'spacer' }),
      el('span', { class: 'context-note', text: fileOf(edit.choice.item.trackerPath) + ' · sheet “' + edit.sheetName + '”' }),
    ]));

    host.appendChild(el('div', { id: 'trackerStale' }));
    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Orders'), el('span', { class: 'spacer' }), el('span', { class: 'context-note', id: 'trackerCount' })]),
      el('div', { class: 'body' }, [el('div', { class: 'table-scroll tr-scroll', id: 'trackerTable' })]),
    ]));
    host.appendChild(el('div', { class: 'tr-savebar', id: 'trackerSave' }));

    drawTable();
    drawSave();
    checkStale();
  }

  function visibleRows() {
    const q = query.trim().toLowerCase();
    const all = AMI.dataRows(edit.sheet, edit.header).slice().reverse();   // newest first
    const matching = q ? all.filter((r) => poOf(r).toLowerCase().includes(q)) : all;
    return { total: all.length, matching, shown: showAll || q ? matching : matching.slice(0, SHOW) };
  }

  function cellInput(row, col, heading) {
    const cell = edit.sheet.cell(row, col);
    const kind = AMI.columnKind(edit.sheet, edit.header, col);
    const original = cellOriginal(cell, kind);
    const key = keyOf(row, col);
    const value = edit.pending.has(key) ? edit.pending.get(key) : original;
    const input = el('input', {
      type: kind === 'date' ? 'date' : 'text', value, class: 'tr-in',
      'aria-label': heading + ', row ' + row, disabled: !ui.can('editTrackers'),
      inputmode: kind === 'number' ? 'decimal' : null,
    });
    input.addEventListener('input', () => {
      if (input.value === original) edit.pending.delete(key); else edit.pending.set(key, input.value);
      input.parentNode.classList.toggle('tr-dirty', edit.pending.has(key));
      drawSave();
    });
    return el('td', { class: edit.pending.has(key) ? 'tr-dirty' : '' }, [input]);
  }

  /** What a cell reads as in its editor: ISO for a date, plain text otherwise. */
  function cellOriginal(cell, kind) {
    if (!cell) return '';
    const t = String(cell.text || '').trim();
    if (!t || /^to fill$/i.test(t)) return '';
    if (kind === 'date' && cell.num != null && Number.isFinite(cell.num) && cell.num > 1) return isoOf(cell.num);
    return t;
  }

  function formulaCell(cell, heading) {
    let shown = cell ? String(cell.text || '').trim() : '';
    if (cell && cell.num != null && /date|prior to/i.test(heading) && cell.num > 30000 && cell.num < 80000) shown = AMI.formatShort(AMI.serialToDate(cell.num));
    return el('td', { class: 'tr-formula', 'data-tip': 'Calculated by the sheet. It is shown for reference and cannot be edited here.', text: shown || '—' });
  }

  function drawTable() {
    const host = $('#trackerTable');
    if (!host || !edit) return;
    clear(host);
    const { total, matching, shown } = visibleRows();
    const count = $('#trackerCount');
    if (count) count.textContent = shown.length + ' of ' + (query.trim() ? matching.length + ' matching' : total) + ' rows, newest first';

    const table = el('table', { class: 'data tr-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, edit.header.columns.map((c, i) => el('th', { class: i === 0 ? 'tr-sticky' : '', text: c.header })))]));
    const body = el('tbody');
    for (const row of shown) {
      body.appendChild(el('tr', {}, edit.header.columns.map((c, i) => {
        const cell = edit.sheet.cell(row, c.col);
        if (i === 0) return el('td', { class: 'tr-sticky mono' }, [el('b', { text: poOf(row) })]);
        if (cell && cell.formula) return formulaCell(cell, c.header);
        return cellInput(row, c.col, c.header);
      })));
    }
    table.appendChild(body);
    host.appendChild(table);

    if (!shown.length) host.appendChild(el('div', { class: 'wk-empty', text: 'No rows match.' }));
    if (!showAll && !query.trim() && matching.length > SHOW) {
      host.appendChild(el('div', { style: 'margin-top:10px' }, [el('button', {
        class: 'btn small', text: 'Show all ' + matching.length + ' rows', onclick: () => { showAll = true; drawTable(); },
      })]));
    }
  }

  function drawSave() {
    const bar = $('#trackerSave');
    if (!bar || !edit) return;
    clear(bar);
    const n = edit.pending.size;
    const allowed = ui.can('editTrackers');
    bar.hidden = !n && allowed;
    if (!allowed) {
      bar.hidden = false;
      bar.appendChild(el('span', { class: 'context-note', text: 'Your role can look at the tracker but not change it. An administrator can give you the “Edit order trackers” permission.' }));
      return;
    }
    bar.appendChild(el('b', { text: n + ' unsaved change' + (n === 1 ? '' : 's') }));
    bar.appendChild(el('span', { class: 'spacer' }));
    bar.appendChild(el('button', { class: 'btn', text: 'Discard', onclick: () => { edit.pending.clear(); drawTable(); drawSave(); } }));
    bar.appendChild(el('button', { class: 'btn primary', text: 'Save to the tracker', onclick: save }));
  }

  /* ------------------------------------------------------------------ *
   * Staleness
   * ------------------------------------------------------------------ */

  /** Has anyone changed the workbook on disk since it was opened here? */
  async function checkStale() {
    if (!edit) return false;
    const now = await state.store.read(edit.choice.item.trackerPath);
    edit.stale = !sameBytes(now, edit.bytes);
    const host = $('#trackerStale');
    if (host) {
      clear(host);
      if (edit.stale) {
        host.appendChild(el('div', { class: 'msg warn' }, [el('span', { class: 'icon', text: '!' }), el('div', {}, [
          el('strong', { text: 'This tracker has changed in the shared folder since you opened it.' }),
          el('span', { class: 'detail', text: 'Someone else saved it. Reload to see their changes; saving now would overwrite them, so it is refused.' }),
          el('div', { class: 'btn-row' }, [el('button', { class: 'btn small primary', text: 'Reload', onclick: () => reload(true) })]),
        ])]));
      }
    }
    return edit.stale;
  }

  async function reload(confirmLoss) {
    if (!edit) return;
    if (confirmLoss && edit.pending.size && !window.confirm('Reloading discards your ' + edit.pending.size + ' unsaved change(s). Continue?')) return;
    const choice = edit.choice;
    try { await openTracker(choice); } catch (e) { toast(e.message, 'error'); return; }
    render();
    toast('Reloaded ' + fileOf(choice.item.trackerPath) + ' from the shared folder.', 'ok');
  }

  /* ------------------------------------------------------------------ *
   * Save
   * ------------------------------------------------------------------ */

  async function save() {
    if (!edit || !edit.pending.size) return;
    if (!ui.requirePermission('editTrackers', 'edit trackers')) return;
    if (await checkStale()) { toast('The tracker changed in the shared folder since you opened it. Reload before saving.', 'error'); return; }

    const { choice } = edit;
    const path = choice.item.trackerPath;
    let out;
    const changes = [];
    try {
      // Apply to a fresh copy, so a refused batch leaves what is on screen as it was.
      const wb = await AMI.Workbook.load(edit.bytes);
      const sheet = wb.sheet(edit.sheetName);
      const header = AMI.findHeaderRow(sheet);
      const edits = [];
      for (const [k, value] of edit.pending) {
        const [row, col] = k.split('|');
        edits.push({ row: Number(row), col, value });
        const heading = (header.columns.find((c) => c.col === col) || {}).header || col;
        changes.push({ po: poOf(Number(row)), heading, value: String(value).trim() || '(cleared)' });
      }
      AMI.applyCellEdits(wb, sheet, header, edits);
      wb.dropCalcChain();
      out = await wb.toBytes();
    } catch (e) {
      toast(e.message, 'error');
      return;
    }

    try {
      const parts = AMI.splitPath(path);
      const name = parts.pop();
      const dir = parts.join('/');
      const backup = (dir ? dir + '/' : '') + name.replace(/\.xlsx?m?$/i, '') + ' (backup ' + stamp() + ').xlsx';
      await state.store.write(backup, edit.bytes);
      await state.store.write(path, out);
    } catch (e) {
      toast('Nothing was saved to ' + fileOf(path) + ': ' + e.message, 'error');
      return;
    }

    const count = changes.length;
    const byPo = new Map();
    for (const c of changes) (byPo.get(c.po) || byPo.set(c.po, []).get(c.po)).push(c);

    await openTracker(choice);
    await ui.trackerWritten(choice.account.id, choice.item.id, out);
    // Who changed what, on each order, in the log the drawer shows.
    await ui.applyWork(null, (doc, by) => {
      for (const [po, list] of byPo) {
        AMI.logActivity(doc, AMI.statusKey(choice.account.id, choice.item.id, po), by,
          'Edited the tracker: ' + list.map((c) => c.heading + ' → ' + c.value).join('; '));
      }
    });
    render();
    toast('Saved ' + count + ' change' + (count === 1 ? '' : 's') + ' to ' + fileOf(path) + '. A backup is beside it; every page now reads the update.', 'ok');
  }

  RENDERERS.trackers = render;
  ui.hooks.trackersChanged = () => { if (state.tab === 'trackers') checkStale(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.tab === 'trackers') checkStale();
  });
})();
