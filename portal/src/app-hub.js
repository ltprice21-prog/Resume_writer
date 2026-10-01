/* AMI Order Desk (Teams) — the working pages laid out after the Global Wine
 * Operations Hub: My Work, Tasks, Exceptions, Shipments, the order drawer and
 * the search box.
 *
 * Builds on what app-teams.js exposes as `AMI.ui` and on orderwork.js.
 *
 * Everything here reads the trackers the person's accounts point at. Nothing is
 * entered that the tracker or a purchase order did not provide: the checklists
 * are the division's standard steps, ticked by people; the exceptions are
 * worked out from tracker dates and say which; the shipment lines are tracker
 * columns. No network access of any kind.
 */
(function () {
  'use strict';

  const ui = global_ui();
  if (!ui) return;

  const { state, hooks, RENDERERS, $, el, clear, toast, showTab } = ui;

  function global_ui() { return typeof AMI !== 'undefined' ? AMI.ui : null; }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysFromToday = (date) => Math.round((startOfDay(date) - startOfDay(new Date())) / 864e5);
  const fmt = (d) => (d ? AMI.formatShort(d) : '—');
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const meName = () => (ui.currentUser() || {}).name || '';
  const stageName = (id) => { const s = AMI.statusById(id); return s ? s.step + '. ' + s.label : ''; };
  const workDoc = () => state.workDoc || AMI.emptyWorkDoc();

  const SEV_CLASS = { Critical: 'crit', High: 'bad', Medium: 'warn', Low: '' };
  const sevTag = (sev) => el('span', { class: 'tag ' + (SEV_CLASS[sev] || ''), text: sev });

  function dueTag(date, tip) {
    if (!date) return null;
    const n = daysFromToday(date);
    let text; let cls;
    if (n < 0) { text = plural(-n, 'day') + ' overdue'; cls = 'bad'; }
    else if (n === 0) { text = 'Due today'; cls = 'warn'; }
    else if (n === 1) { text = 'Due tomorrow'; cls = 'warn'; }
    else { text = 'Due ' + fmt(date); cls = ''; }
    return el('span', { class: 'tag ' + cls, text, 'data-tip': tip || null });
  }

  const orderLink = (o, text) => el('button', {
    class: 'wk-link', text: text || 'PO ' + o.po, onclick: () => ui.openOrder(o.key),
  });

  const orderWhere = (o) => o.accountName + ' · ' + o.itemName;

  /** A button that is switched off, with the reason, when the role does not allow it. */
  function permButton(permission, props) {
    const allowed = ui.can(permission);
    const p = AMI.PERMISSIONS.find((x) => x.id === permission);
    return el('button', Object.assign({}, props, {
      disabled: !allowed || props.disabled,
      'data-tip': allowed ? (props['data-tip'] || null) : 'Your role does not allow you to ' + (p ? p.label.toLowerCase() : 'do this') + '.',
    }));
  }

  function emptyState(title, detail) {
    return el('div', { class: 'wk-empty' }, [el('b', { text: title }), detail ? el('div', { text: detail }) : null]);
  }

  /**
   * The gate every hub page starts with: someone is signed in and the trackers
   * have been read. Returns false after drawing why not, so the caller stops.
   */
  function ready(host, rerender) {
    clear(host);
    if (!state.workspace || !ui.currentUser()) {
      host.appendChild(el('div', { class: 'empty', text: 'Open the workspace and choose your name first.' }));
      return false;
    }
    if (!state.portfolio) {
      host.appendChild(el('div', { class: 'empty', text: 'Reading the trackers for your accounts…' }));
      ui.ensurePortfolio().then(() => { if (state.tab && RENDERERS[state.tab] === rerender) rerender(); });
      return false;
    }
    return true;
  }

  /** Orders after the shared division / account / item filters and the closed switch. */
  function scopedOrders(opts) {
    const o = opts || {};
    const f = state.filters;
    let list = ui.allOrders().filter((x) => (
      (!f.divisionId || x.divisionId === f.divisionId)
      && (!f.accountId || x.accountId === f.accountId)
      && (!f.itemId || x.itemId === f.itemId)));
    if (o.useQuery && f.query) {
      const q = f.query.trim().toLowerCase();
      list = list.filter((x) => x.po.toLowerCase().includes(q));
    }
    return o.keepClosed ? list : list.filter((x) => x.isOpen);
  }

  const orderByKey = (key) => ui.allOrders().find((o) => o.key === key) || null;

  /* ------------------------------------------------------------------ *
   * Work items, gathered once per page render
   * ------------------------------------------------------------------ */

  function gatherTasks(orders) {
    const doc = workDoc();
    const out = [];
    for (const order of orders) {
      const t = AMI.tasksFor(order, doc);
      for (const task of [...t.current.filter((x) => !x.done), ...t.elsewhere]) out.push({ order, task });
    }
    return out;
  }

  function gatherExceptions(orders, includeResolved) {
    const doc = workDoc();
    const out = [];
    for (const order of orders) {
      for (const x of AMI.exceptionsFor(order, doc, { followUps: order.followUps })) {
        if (includeResolved || AMI.isOpenException(x)) out.push({ order, exc: x });
      }
    }
    return out;
  }

  const taskDueRank = (item) => (item.task.due ? item.task.due.getTime() : Infinity);

  /* ------------------------------------------------------------------ *
   * Task and exception rows
   * ------------------------------------------------------------------ */

  async function toggleTask(order, task, done) {
    const ok = await ui.applyWork('manageTasks', (doc, by) => AMI.setTaskDone(doc, order, task.id, done, by));
    if (ok) refresh();
  }

  function taskBox(order, task) {
    const allowed = ui.can('manageTasks');
    return el('button', {
      class: 'tsk-box' + (task.done ? ' on' : ''), type: 'button',
      'aria-pressed': String(task.done), 'aria-label': (task.done ? 'Untick: ' : 'Tick: ') + task.title,
      disabled: !allowed,
      'data-tip': allowed ? null : 'Your role does not allow you to tick off tasks.',
      onclick: () => toggleTask(order, task, !task.done),
      text: task.done ? '✓' : '',
    });
  }

  function ownerName(id) {
    if (!id) return '';
    const u = state.workspace.users.find((x) => x.id === id);
    return u ? u.name : id;
  }

  function ownerSelect(order, task) {
    const sel = el('select', {
      'aria-label': 'Owner',
      disabled: !ui.can('manageTasks'),
      onchange: async (e) => {
        const v = e.target.value;
        if (await ui.applyWork('manageTasks', (doc, by) => AMI.setTaskField(doc, order, task.id, 'owner', v, by))) refresh();
      },
    }, [
      el('option', { value: '', text: 'Unassigned', selected: !task.owner }),
      ...state.workspace.users.map((u) => el('option', { value: u.id, selected: u.id === task.owner, text: u.name })),
    ]);
    return sel;
  }

  function taskLine(order, task, opts) {
    const o = opts || {};
    return el('div', { class: 'tsk' + (task.done ? ' done' : '') }, [
      taskBox(order, task),
      el('div', { class: 'tsk-title' }, [
        el('div', { text: task.title }),
        o.showOrder
          ? el('div', { class: 'tsk-meta' }, [
            orderLink(order), el('span', { text: orderWhere(order) }),
            el('span', { text: stageName(task.stageId) }),
          ])
          : null,
        task.done && task.doneBy
          ? el('div', { class: 'tsk-meta', text: 'Ticked by ' + task.doneBy + (task.doneAt ? ' on ' + task.doneAt.slice(0, 10) : '') })
          : null,
      ]),
      task.done ? null : dueTag(task.due, task.dueSource),
      !task.done && o.editDue
        ? el('input', {
          type: 'date', value: task.due ? AMI.isoDay(task.due) : '', 'aria-label': 'Due date',
          disabled: !ui.can('manageTasks'),
          onchange: async (e) => {
            if (await ui.applyWork('manageTasks', (doc, by) => AMI.setTaskField(doc, order, task.id, 'due', e.target.value, by))) refresh();
          },
        })
        : null,
      !task.done && o.editOwner ? ownerSelect(order, task) : (task.owner ? el('span', { class: 'tag', text: ownerName(task.owner) }) : null),
      task.custom && !task.done
        ? el('button', {
          class: 'btn small ghost', text: 'Remove', disabled: !ui.can('manageTasks'),
          onclick: async () => { if (await ui.applyWork('manageTasks', (doc, by) => AMI.removeCustomTask(doc, order, task.id, by))) refresh(); },
        })
        : null,
    ]);
  }

  async function setException(order, exc, status, fields) {
    const ok = await ui.applyWork('manageExceptions', (doc, by) => AMI.setExceptionState(doc, order, exc, status, fields, by));
    if (ok) refresh();
    return ok;
  }

  /** The answer to an exception: how it was resolved and why it happened. */
  function resolveForm(order, exc, onDone) {
    const resolution = el('select', {}, [
      el('option', { value: '', text: 'Choose how it was resolved…' }),
      ...AMI.RESOLUTIONS.map((r) => el('option', { value: r, text: r })),
    ]);
    const cause = el('select', {}, [
      el('option', { value: '', text: 'Root cause (optional)' }),
      ...AMI.ROOT_CAUSES.map((r) => el('option', { value: r, text: r })),
    ]);
    const note = el('input', { type: 'text', placeholder: 'Note (optional)' });
    return el('div', { class: 'exc-form' }, [
      el('div', { class: 'grid-2' }, [resolution, cause]),
      note,
      el('div', { class: 'btn-row', style: 'margin:0' }, [
        el('button', {
          class: 'btn primary small', text: 'Mark resolved',
          onclick: async () => {
            if (!resolution.value) { toast('Say how it was resolved.', 'error'); return; }
            if (await setException(order, exc, 'Resolved', { resolution: resolution.value, rootCause: cause.value, note: note.value })) onDone();
          },
        }),
        el('button', { class: 'btn small ghost', text: 'Cancel', onclick: onDone }),
      ]),
    ]);
  }

  function exceptionLine(order, exc, opts) {
    const o = opts || {};
    const open = AMI.isOpenException(exc);
    const slot = el('div', {});
    const acts = el('div', { class: 'wk-acts' });
    const mgr = ui.can('manageExceptions');
    const tip = mgr ? null : 'Your role does not allow you to change exceptions.';

    const add = (text, status, cls) => acts.appendChild(el('button', {
      class: 'btn small' + (cls ? ' ' + cls : ''), text, disabled: !mgr, 'data-tip': tip,
      onclick: () => setException(order, exc, status),
    }));
    if (open) {
      if (exc.status === 'Open') add('Acknowledge', 'Acknowledged');
      if (exc.status !== 'Escalated') add('Escalate', 'Escalated');
      acts.appendChild(el('button', {
        class: 'btn small primary', text: 'Resolve', disabled: !mgr, 'data-tip': tip,
        onclick: () => { clear(slot); slot.appendChild(resolveForm(order, exc, () => clear(slot))); },
      }));
    } else if (exc.status === 'Cleared') {
      acts.appendChild(el('button', {
        class: 'btn small', text: 'Archive', disabled: !mgr, 'data-tip': tip || 'The tracker no longer shows the cause. Archive it to take it off the list.',
        onclick: () => setException(order, exc, 'Resolved', { resolution: 'Tracker corrected' }),
      }));
    } else {
      add('Reopen', 'Open');
    }

    const statusCls = exc.status === 'Escalated' ? 'bad' : exc.status === 'Acknowledged' ? 'info' : exc.status === 'Resolved' ? 'ok' : '';
    return el('div', { class: 'wk-item sev-' + exc.severity }, [
      el('span', { class: 'wk-kind exc', text: 'EXC' }),
      el('div', { class: 'wk-body' }, [
        el('div', { class: 'wk-title', text: exc.title }),
        el('div', { class: 'wk-meta' }, [
          o.showOrder ? orderLink(order) : null,
          o.showOrder ? el('span', { text: orderWhere(order) }) : null,
          exc.stageId ? el('span', { text: stageName(exc.stageId) }) : null,
          sevTag(exc.severity),
          el('span', { class: 'tag ' + statusCls, text: exc.status }),
          open ? dueTag(exc.due) : null,
          el('span', { class: 'tag', text: exc.auto ? 'from tracker dates' : 'raised by ' + (exc.raisedBy || 'someone') }),
          exc.status === 'Resolved' && exc.resolution ? el('span', { text: exc.resolution + (exc.rootCause ? ' · ' + exc.rootCause : '') }) : null,
        ]),
        exc.detail ? el('div', { class: 'wk-meta', text: exc.detail }) : null,
        exc.note ? el('div', { class: 'wk-meta', text: 'Note: ' + exc.note }) : null,
        slot,
      ]),
      acts,
    ]);
  }

  /** Raise an exception by hand, on any order the person can see. */
  function raiseExceptionDialog(preset) {
    const orders = scopedOrders({ keepClosed: true });
    if (!orders.length) { toast('No orders to raise an exception on.', 'error'); return; }
    let close = null;
    close = ui.openOverlay('Raise an exception', 'Something outside the tracker’s dates that needs attention on an order.', (body) => {
      const orderSel = el('select', {}, orders.slice().sort((a, b) => a.po.localeCompare(b.po)).map((o) => el('option', {
        value: o.key, selected: preset && preset.key === o.key, text: 'PO ' + o.po + ' — ' + orderWhere(o),
      })));
      const type = el('select', {}, [el('option', { value: '', text: 'Type (fills the title)…' }), ...AMI.MANUAL_TYPES.map((t) => el('option', { value: t, text: t }))]);
      const title = el('input', { type: 'text', placeholder: 'What is wrong?' });
      type.addEventListener('change', () => { if (type.value && !title.value) title.value = type.value; });
      const sev = el('select', {}, AMI.SEVERITIES.map((s) => el('option', { value: s, selected: s === 'Medium', text: s })));
      const due = el('input', { type: 'date' });
      const detail = el('textarea', { rows: 3, placeholder: 'Detail (optional)' });
      const field = (label, input) => el('label', { class: 'field' }, [el('span', { text: label }), input]);
      body.appendChild(el('div', { class: 'body' }, [
        field('Order', orderSel), field('Type', type), field('Title', title),
        el('div', { class: 'grid-2' }, [field('Severity', sev), field('Due', due)]),
        field('Detail', detail),
        el('div', { class: 'btn-row' }, [el('button', {
          class: 'btn primary', text: 'Raise exception',
          onclick: async () => {
            const order = orders.find((o) => o.key === orderSel.value);
            if (!title.value.trim()) { toast('Give it a title.', 'error'); return; }
            const ok = await ui.applyWork('manageExceptions', (doc, by) => AMI.raiseException(doc, order, {
              title: title.value, severity: sev.value, due: due.value, detail: detail.value,
              stageId: (AMI.workStage(order) || {}).id || '',
            }, by));
            if (ok) { if (close) close(); refresh(); toast('Exception raised.', 'ok'); }
          },
        })]),
      ]));
    });
  }

  /* ------------------------------------------------------------------ *
   * Tiles and chips
   * ------------------------------------------------------------------ */

  function tile(label, value, sub, tone, onclick, on) {
    return el('button', { class: 'tile' + (tone ? ' t-' + tone : '') + (on ? ' on' : ''), type: 'button', onclick }, [
      el('span', { class: 'k', text: label }),
      el('span', { class: 'v', text: String(value) }),
      el('span', { class: 's', text: sub || '' }),
    ]);
  }

  function chipRow(options, current, onPick) {
    return el('div', { class: 'chip-filters' }, options.map(([id, label, count]) => el('button', {
      class: 'chip-filter' + (current === id ? ' on' : ''), type: 'button', onclick: () => onPick(id),
    }, [document.createTextNode(label), count != null ? el('span', { class: 'n', text: String(count) }) : null])));
  }

  const view = { tasks: 'soon', exceptions: 'open', severity: '', shipments: 'live', mine: 'all' };

  /* ------------------------------------------------------------------ *
   * My Work
   * ------------------------------------------------------------------ */

  function renderMyWork() {
    const host = $('#myworkBody');
    if (!ready(host, renderMyWork)) return;

    const now = new Date();
    const orders = scopedOrders();
    const user = ui.currentUser();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    const tasks = gatherTasks(orders).filter((i) => view.mine === 'mine' ? i.task.owner === user.id : (!i.task.owner || i.task.owner === user.id));
    const dueTasks = tasks.filter((i) => i.task.due && daysFromToday(i.task.due) <= 0)
      .sort((a, b) => taskDueRank(a) - taskDueRank(b));
    const excs = gatherExceptions(orders).sort((a, b) => (AMI.SEVERITY_RANK[b.exc.severity] - AMI.SEVERITY_RANK[a.exc.severity]));
    const overdueTasks = dueTasks.filter((i) => daysFromToday(i.task.due) < 0).length;
    const overdueExc = excs.filter((i) => i.exc.due && daysFromToday(i.exc.due) < 0).length;
    const high = excs.filter((i) => AMI.SEVERITY_RANK[i.exc.severity] >= 3).length;
    const gateWaiting = orders.filter((o) => { const n = AMI.nextForOrder(o); return n && n.gate; }).length;
    const chases = orders.reduce((n, o) => n + o.followUps.filter((f) => !f.superseded).length, 0);

    host.appendChild(el('div', { class: 'greeting' }, [
      el('div', { class: 'eyebrow', text: AMI.formatLong ? AMI.formatLong(now) : now.toDateString() }),
      el('h1', { text: greeting + ', ' + user.name.split(' ')[0] + '.' }),
      el('p', {
        text: dueTasks.length + ' task' + (dueTasks.length === 1 ? '' : 's') + ' due or overdue, '
          + excs.length + ' open exception' + (excs.length === 1 ? '' : 's') + ' across '
          + plural(orders.length, 'open order') + '.',
      }),
    ]));

    host.appendChild(el('div', { class: 'tiles' }, [
      tile('Overdue', overdueTasks + overdueExc, 'tasks and exceptions past their date', overdueTasks + overdueExc ? 'bad' : 'ok',
        () => { view.tasks = 'overdue'; showTab('tasks'); }),
      tile('Due today', dueTasks.length - overdueTasks, 'tasks tied to a tracker date', 'warn',
        () => { view.tasks = 'today'; showTab('tasks'); }),
      tile('Open exceptions', excs.length, high + ' high or critical', high ? 'bad' : (excs.length ? 'warn' : 'ok'),
        () => { view.exceptions = 'open'; showTab('exceptions'); }),
      tile('Person checks waiting', gateWaiting, 'orders at Order Validation or Pre-Shipment Review', gateWaiting ? 'info' : 'ok',
        () => { state.filters.statusId = '__open'; showTab('orderstatus'); }),
      tile('Chases to send', chases, 'blank tracker cells still being chased', chases ? 'warn' : 'ok', () => showTab('followups')),
    ]));

    host.appendChild(chipRow([['all', 'My accounts', null], ['mine', 'Assigned to me', null]], view.mine, (id) => { view.mine = id; renderMyWork(); }));

    /* Needs my action */
    const actionItems = [];
    for (const x of excs.slice(0, 40)) actionItems.push({ kind: 'exc', ...x });
    for (const x of dueTasks.slice(0, 40)) actionItems.push({ kind: 'task', ...x });
    actionItems.sort((a, b) => {
      const ra = a.kind === 'exc' ? AMI.SEVERITY_RANK[a.exc.severity] : 0;
      const rb = b.kind === 'exc' ? AMI.SEVERITY_RANK[b.exc.severity] : 0;
      return (rb - ra) || ((a.kind === 'task' ? taskDueRank(a) : 0) - (b.kind === 'task' ? taskDueRank(b) : 0));
    });
    const shown = actionItems.slice(0, 25);

    const actionCard = el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Needs my action'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: actionItems.length + ' item' + (actionItems.length === 1 ? '' : 's') })]),
      shown.length
        ? el('div', { class: 'wk-list' }, shown.map((i) => (i.kind === 'exc'
          ? exceptionLine(i.order, i.exc, { showOrder: true })
          : el('div', { class: 'wk-item' }, [
            el('span', { class: 'wk-kind', text: 'TASK' }),
            el('div', { class: 'wk-body' }, [taskLine(i.order, i.task, { showOrder: true })]),
          ]))))
        : emptyState('Nothing needs you right now.', 'Tasks appear here once they fall due; exceptions appear as soon as the tracker’s dates raise them.'),
      actionItems.length > shown.length
        ? el('div', { class: 'body' }, [el('button', { class: 'btn small', text: 'See all tasks', onclick: () => { view.tasks = 'soon'; showTab('tasks'); } }),
          document.createTextNode(' '), el('button', { class: 'btn small', text: 'See all exceptions', onclick: () => showTab('exceptions') })])
        : null,
    ]);

    /* Upcoming milestones: the tracker's own planned dates */
    const entries = AMI.scheduleEntries(orders, now).filter((e) => e.overdue || e.days <= 14).slice(0, 14);
    const milestones = el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Upcoming milestones'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: 'next 14 days, from the tracker' })]),
      entries.length
        ? el('div', { class: 'wk-list' }, entries.map((e) => el('div', { class: 'wk-item' }, [
          el('span', { class: 'wk-kind', text: fmt(e.date).toUpperCase() }),
          el('div', { class: 'wk-body' }, [
            el('div', { class: 'wk-title', text: e.label + (e.kind === 'collection' ? ' requested' : ' required') }),
            el('div', { class: 'wk-meta' }, [orderLink(e.order), el('span', { text: orderWhere(e.order) }),
              e.overdue ? el('span', { class: 'tag bad', text: plural(-e.days, 'day') + ' overdue' }) : null]),
          ]),
        ])))
        : emptyState('No collections or deliveries in the next 14 days.'),
    ]);

    host.appendChild(el('div', { class: 'cols' }, [actionCard, milestones]));
  }

  /* ------------------------------------------------------------------ *
   * Tasks
   * ------------------------------------------------------------------ */

  function renderTasks() {
    const host = $('#tasksBody');
    if (!ready(host, renderTasks)) return;

    host.appendChild(ui.pageHeader('Work', 'Tasks',
      'The division’s standard steps for the stage each order is working on. A step is only done when a person ticks it. '
      + 'Due dates come from the tracker’s requested collection and delivery dates where one applies — otherwise a step has no due date until you set one.',
      [ui.closedToggle(renderTasks)]));
    host.appendChild(ui.filterBar(renderTasks, { withItem: true, withSearch: true }));

    const items = gatherTasks(scopedOrders({ useQuery: true }));
    const overdue = (i) => i.task.due && daysFromToday(i.task.due) < 0;
    const today = (i) => i.task.due && daysFromToday(i.task.due) === 0;
    const week = (i) => i.task.due && daysFromToday(i.task.due) <= 7;
    const filters = {
      soon: (i) => week(i), overdue, today, undated: (i) => !i.task.due, mine: (i) => i.task.owner === state.userId, all: () => true,
    };
    const sel = filters[view.tasks] || filters.all;
    const shown = items.filter(sel).sort((a, b) => taskDueRank(a) - taskDueRank(b) || a.order.po.localeCompare(b.order.po));

    host.appendChild(chipRow([
      ['soon', 'Overdue and next 7 days', items.filter(filters.soon).length],
      ['overdue', 'Overdue', items.filter(overdue).length],
      ['today', 'Due today', items.filter(today).length],
      ['undated', 'No due date', items.filter(filters.undated).length],
      ['mine', 'Assigned to me', items.filter(filters.mine).length],
      ['all', 'All open', items.length],
    ], view.tasks, (id) => { view.tasks = id; renderTasks(); }));

    const LIMIT = 200;
    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Open tasks'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: shown.length + ' shown' })]),
      shown.length
        ? el('div', { class: 'body' }, shown.slice(0, LIMIT).map((i) => taskLine(i.order, i.task, { showOrder: true, editDue: true, editOwner: true })))
        : emptyState('No tasks match.', 'Try “All open”, or widen the filters above.'),
      shown.length > LIMIT ? el('div', { class: 'body' }, [el('span', { class: 'help', text: 'Showing the first ' + LIMIT + '. Narrow the filters to see the rest.' })]) : null,
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Exceptions
   * ------------------------------------------------------------------ */

  function renderExceptions() {
    const host = $('#exceptionsBody');
    if (!ready(host, renderExceptions)) return;

    host.appendChild(ui.pageHeader('Work', 'Exceptions',
      'Things that need attention on an order. Those marked “from tracker dates” are worked out from the tracker alone — a missed requested date with nothing recorded, '
      + 'documents still blank close to collection, a delivery with no invoice number. You can also raise one by hand, and answer any of them.',
      [ui.closedToggle(renderExceptions),
        permButton('manageExceptions', { class: 'btn primary', text: '+ Raise exception', onclick: () => raiseExceptionDialog() })]));
    host.appendChild(ui.filterBar(renderExceptions, { withItem: true, withSearch: true }));

    const all = gatherExceptions(scopedOrders({ useQuery: true, keepClosed: true }), true);
    const open = all.filter((i) => AMI.isOpenException(i.exc));
    const bySev = (s) => open.filter((i) => i.exc.severity === s).length;

    host.appendChild(el('div', { class: 'tiles' }, AMI.SEVERITIES.map((s) => tile(
      s, bySev(s), s === 'Critical' ? 'act today' : s === 'High' ? 'act this week' : s === 'Medium' ? 'watch' : 'note',
      { Critical: 'bad', High: 'bad', Medium: 'warn', Low: '' }[s], () => { view.severity = view.severity === s ? '' : s; renderExceptions(); }, view.severity === s))));

    const states = {
      open: (i) => AMI.isOpenException(i.exc),
      Escalated: (i) => i.exc.status === 'Escalated',
      Acknowledged: (i) => i.exc.status === 'Acknowledged',
      done: (i) => i.exc.status === 'Resolved' || i.exc.status === 'Cleared',
      all: () => true,
    };
    host.appendChild(chipRow([
      ['open', 'Open', all.filter(states.open).length],
      ['Escalated', 'Escalated', all.filter(states.Escalated).length],
      ['Acknowledged', 'Acknowledged', all.filter(states.Acknowledged).length],
      ['done', 'Resolved or cleared', all.filter(states.done).length],
      ['all', 'All', all.length],
    ], view.exceptions, (id) => { view.exceptions = id; renderExceptions(); }));

    const shown = all.filter(states[view.exceptions] || states.all)
      .filter((i) => !view.severity || i.exc.severity === view.severity)
      .sort((a, b) => (AMI.SEVERITY_RANK[b.exc.severity] - AMI.SEVERITY_RANK[a.exc.severity]) || a.order.po.localeCompare(b.order.po));

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Exceptions'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: shown.length + ' shown' })]),
      shown.length
        ? el('div', { class: 'wk-list' }, shown.slice(0, 200).map((i) => exceptionLine(i.order, i.exc, { showOrder: true })))
        : emptyState('Nothing here.', view.exceptions === 'open' ? 'No open exceptions for these filters.' : 'Nothing matches these filters.'),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Shipments
   * ------------------------------------------------------------------ */

  function renderShipments() {
    const host = $('#shipmentsBody');
    if (!ready(host, renderShipments)) return;

    host.appendChild(ui.pageHeader('Work', 'Shipments',
      'Every collection and delivery, straight from the tracker’s dated columns. A blank means the tracker has nothing recorded — nothing is estimated.',
      [ui.closedToggle(renderShipments)]));
    host.appendChild(ui.filterBar(renderShipments, { withItem: true, withSearch: true }));

    const lines = scopedOrders({ useQuery: true, keepClosed: !ui.excludingClosed() }).map((o) => AMI.shipmentLine(o));
    const count = (id) => lines.filter((l) => l.status.id === id).length;
    const late = lines.filter((l) => l.collectionOverdue || l.deliveryOverdue);
    const live = lines.filter((l) => l.status.id !== 'delivered');

    host.appendChild(el('div', { class: 'tiles' }, [
      tile('Awaiting collection', count('awaiting'), 'requested date set, not collected', 'info', () => { view.shipments = 'awaiting'; renderShipments(); }, view.shipments === 'awaiting'),
      tile('Collected, not delivered', count('collected'), 'collected, no delivery recorded', 'info', () => { view.shipments = 'collected'; renderShipments(); }, view.shipments === 'collected'),
      tile('Delivered', count('delivered'), 'delivery date recorded', 'ok', () => { view.shipments = 'delivered'; renderShipments(); }, view.shipments === 'delivered'),
      tile('Overdue', late.length, 'a requested date has passed', late.length ? 'bad' : 'ok', () => { view.shipments = 'overdue'; renderShipments(); }, view.shipments === 'overdue'),
    ]));

    const sels = {
      live: (l) => l.status.id !== 'delivered', awaiting: (l) => l.status.id === 'awaiting', collected: (l) => l.status.id === 'collected',
      delivered: (l) => l.status.id === 'delivered', overdue: (l) => l.collectionOverdue || l.deliveryOverdue,
      unscheduled: (l) => l.status.id === 'unscheduled', all: () => true,
    };
    host.appendChild(chipRow([
      ['live', 'Not yet delivered', live.length], ['overdue', 'Overdue', late.length], ['delivered', 'Delivered', count('delivered')],
      ['unscheduled', 'No collection date', count('unscheduled')], ['all', 'All', lines.length],
    ], view.shipments, (id) => { view.shipments = id; renderShipments(); }));

    const nextDate = (l) => (l.status.id === 'awaiting' ? l.requestedCollection : l.status.id === 'collected' ? l.requiredDelivery : l.delivered) || null;
    const shown = lines.filter(sels[view.shipments] || sels.all)
      .sort((a, b) => ((nextDate(a) ? nextDate(a).getTime() : Infinity) - (nextDate(b) ? nextDate(b).getTime() : Infinity)) || a.po.localeCompare(b.po));

    const lateCell = (date, overdue, lateInfo) => el('td', {}, [
      el('span', { class: overdue ? 'ship-late' : '', text: fmt(date) }),
      overdue ? el('div', { class: 'bar-sub ship-late', text: plural(overdue.days, 'day') + ' overdue' }) : null,
      !overdue && lateInfo ? el('div', { class: 'bar-sub', text: plural(lateInfo.days, 'day') + ' after the date asked for' }) : null,
    ]);

    const table = el('table', { class: 'data' });
    table.appendChild(el('thead', {}, [el('tr', {}, ['PO', 'Account · item', 'Where it is', 'Collection asked', 'Collected', 'Customer needs by', 'Delivered', 'Truck', 'Cases', 'Pallets', 'Lot']
      .map((h) => el('th', { text: h })))]));
    const tb = el('tbody');
    for (const l of shown.slice(0, 300)) {
      tb.appendChild(el('tr', {}, [
        el('td', {}, [el('button', { class: 'wk-link mono', text: l.po, onclick: () => ui.openOrder(l.key) })]),
        el('td', { text: l.accountName + ' · ' + l.itemName }),
        el('td', {}, [el('span', { class: 'tag ' + ({ delivered: 'ok', collected: 'info', awaiting: 'warn', unscheduled: '' }[l.status.id]), text: l.status.label })]),
        el('td', { text: fmt(l.requestedCollection) }),
        lateCell(l.collected, null, l.collectedLate),
        el('td', { text: fmt(l.requiredDelivery) }),
        lateCell(l.delivered, null, l.deliveredLate),
        el('td', { text: l.truck || '—' }),
        el('td', { class: 'num', text: l.cases != null ? String(l.cases) : '—' }),
        el('td', { class: 'num', text: l.pallets != null ? String(l.pallets) : '—' }),
        el('td', { class: 'mono', text: l.lot ? String(l.lot) : '—' }),
      ]));
      const last = tb.lastChild;
      if (l.collectionOverdue) last.children[3].appendChild(el('div', { class: 'bar-sub ship-late', text: plural(l.collectionOverdue.days, 'day') + ' overdue' }));
      if (l.deliveryOverdue) last.children[5].appendChild(el('div', { class: 'bar-sub ship-late', text: plural(l.deliveryOverdue.days, 'day') + ' overdue' }));
    }
    table.appendChild(tb);

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Shipments'), el('span', { class: 'spacer' }),
        el('span', { class: 'context-note', text: shown.length + ' shown' })]),
      shown.length ? el('div', { class: 'body' }, [el('div', { class: 'table-scroll' }, [table])]) : emptyState('No shipments match.'),
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Order drawer
   * ------------------------------------------------------------------ */

  let openKey = '';

  const DATE_FACTS = [
    ['poReceived', 'PO received'], ['poSent', 'PO sent to winery'], ['wineryConfirmed', 'Winery confirmed'],
    ['requestedCollection', 'Collection asked'], ['actualCollection', 'Collected'],
    ['requiredDelivery', 'Customer needs by'], ['delivered', 'Delivered'],
  ];

  function workflowTracker(order) {
    const trail = AMI.stageTrail(order, order.status);
    const working = AMI.nextForOrder(order);
    const byPhase = AMI.PHASES.map((p) => el('div', { class: 'wf-phase' }, [
      el('div', { class: 'wf-phase-label', text: p.label }),
      el('div', { class: 'wf-steps' }, trail.filter((t) => t.status.phase === p.id).map((t) => {
        const isWorking = working && t.status.id === working.id && t.state === 'pending';
        const state_ = isWorking ? 'working' : t.state;
        return el('div', {
          class: 'wf-step ' + state_ + (t.status.gate ? ' gate' : ''),
          'data-tip': t.status.label + (t.status.gate ? ' — a person check with no tracker column' : '') + '. '
            + ({ done: 'Shown done by the tracker', current: 'The stage this order is at', unrecorded: 'Passed, but nothing records it',
              pending: 'Not reached', working: 'The stage being worked now' }[state_]) + (t.detail ? ': ' + t.detail : '') + '.',
        }, [
          el('div', { class: 'wf-dot' }, [el('span', { text: state_ === 'done' ? '✓' : String(t.status.step) })]),
          el('div', { class: 'wf-name', text: t.status.short || t.status.label }),
        ]);
      })),
    ]));
    return el('div', {}, [
      el('div', { class: 'wf' }, byPhase),
      el('p', { class: 'wf-key', text: 'Ticked: the tracker shows it done. Filled blue: where the order is. Outlined blue: being worked now. Dashed: passed with nothing recorded. Diamonds are the two person checks.' }),
    ]);
  }

  function stageControl(order) {
    const next = AMI.nextForOrder(order);
    const note = el('input', { type: 'text', placeholder: 'Note (optional)' });
    const sel = el('select', {}, [
      el('option', { value: '__none', text: '— not set (fall back to the tracker) —', selected: order.status.source !== 'set' }),
      ...ui.stageOptions((s) => order.status.source === 'set' && s.id === order.status.statusId),
    ]);
    const save = async (value, label) => {
      const v = value === '__none' ? '' : value;
      if (!(await ui.applyStatus(order.key, v, note.value))) return;
      await ui.applyWork(null, (doc, by) => AMI.logActivity(doc, order.key, by,
        v ? 'Set stage to ' + AMI.statusById(v).step + '. ' + AMI.statusById(v).label + (note.value ? ' — ' + note.value : '') : 'Cleared the stage set by hand (' + label + ')'));
      toast('PO ' + order.po + ' → ' + (v ? AMI.statusById(v).label : 'tracker’s view'), 'ok');
      refresh(true);
    };

    const tasks = AMI.tasksFor(order, workDoc());
    const total = tasks.current.length;
    const ticked = tasks.current.filter((t) => t.done).length;

    return el('div', {}, [
      el('div', { class: 'kv', style: 'margin-bottom:12px' }, [
        el('div', {}, [el('span', { text: 'Stage reached' }), el('b', { text: order.status.statusId ? stageName(order.status.statusId) : 'Not set' })]),
        el('div', {}, [el('span', { text: 'Next stage' }), el('b', { text: next ? next.step + '. ' + next.label : 'Workflow complete' })]),
        el('div', {}, [el('span', { text: 'Where it comes from' }), el('b', { text: order.status.reason })]),
      ]),
      next
        ? el('div', { class: 'btn-row', style: 'margin:0 0 10px' }, [
          permButton('setStatus', {
            class: 'btn primary', text: 'Mark “' + next.label + '” complete',
            onclick: () => save(next.id, next.label),
          }),
          next.gate ? el('span', { class: 'tag info', text: 'A person check — only you can record it' }) : null,
          total ? el('span', { class: 'context-note', text: ticked + ' of ' + total + ' checklist steps ticked' + (ticked < total ? ' — you can still mark it complete' : '') }) : null,
        ])
        : null,
      el('div', { class: 'btn-row', style: 'margin:0' }, [
        sel, note,
        permButton('setStatus', { class: 'btn small', text: 'Save stage', onclick: () => save(sel.value, '') }),
      ]),
      order.status.behindTracker
        ? el('div', { class: 'msg warn', style: 'margin-top:10px' }, [el('span', { class: 'icon', text: '!' }),
          el('div', { text: 'The tracker already shows a later stage than the one set here: ' + (AMI.statusById(order.status.trackerStatusId) || {}).label + '.' })])
        : null,
    ]);
  }

  function checklistCard(order) {
    const t = AMI.tasksFor(order, workDoc());
    const stage = t.stage;
    const input = el('input', { type: 'text', placeholder: 'Add a task to this order…', disabled: !ui.can('manageTasks') });
    const add = async () => {
      const title = input.value.trim();
      if (!title) return;
      if (await ui.applyWork('manageTasks', (doc, by) => AMI.addCustomTask(doc, order, { title, stageId: stage ? stage.id : '' }, by))) { input.value = ''; refresh(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

    return el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode(stage ? 'Next up: ' + stage.step + '. ' + stage.label : 'Workflow complete'), el('span', { class: 'spacer' }),
        stage ? el('span', { class: 'context-note', text: t.current.filter((x) => x.done).length + ' of ' + t.current.length + ' ticked' }) : null]),
      el('div', { class: 'body' }, [
        ...t.current.map((task) => taskLine(order, task, { editDue: true, editOwner: true })),
        ...(t.elsewhere.length ? [el('h3', { text: 'Other open tasks' }), ...t.elsewhere.map((task) => taskLine(order, task, { editDue: true, editOwner: true }))] : []),
        !t.current.length && !t.elsewhere.length ? el('p', { class: 'help', text: 'No checklist for this stage.' }) : null,
        el('div', { class: 'tsk-add' }, [input, permButton('manageTasks', { class: 'btn', text: 'Add', onclick: add })]),
        t.done.length
          ? el('details', {}, [el('summary', { text: 'Ticked on other stages (' + t.done.length + ')' }),
            ...t.done.map((task) => taskLine(order, task))])
          : null,
        el('p', { class: 'dr-foot-note', text: 'These are the division’s standard steps. Ticking one records who and when; it does not change the tracker or the order’s stage.' }),
      ]),
    ]);
  }

  function drawerExceptions(order) {
    const list = AMI.exceptionsFor(order, workDoc(), { followUps: order.followUps });
    const open = list.filter(AMI.isOpenException);
    return el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Exceptions (' + open.length + ' open)'), el('span', { class: 'spacer' }),
        permButton('manageExceptions', { class: 'btn small', text: '+ Raise exception', onclick: () => raiseExceptionDialog(order) })]),
      list.length
        ? el('div', { class: 'wk-list' }, list.map((x) => exceptionLine(order, x)))
        : emptyState('No exceptions.', 'None of the tracker’s dates raise one, and nobody has raised one by hand.'),
    ]);
  }

  function factsCard(order) {
    const d = order.dates;
    const v = order.values;
    const flags = order.schedule || {};
    const shipment = AMI.shipmentLine(order);
    const fact = (label, value, cls) => el('div', {}, [el('span', { text: label }), el('b', { class: cls || '', text: value })]);

    const dateFacts = DATE_FACTS.map(([key, label]) => {
      let cls = '';
      let text = fmt(d[key]);
      if (key === 'requestedCollection' && flags.collectionOverdue) { cls = 'late'; text += ' — ' + plural(flags.collectionOverdue.days, 'day') + ' overdue'; }
      if (key === 'requiredDelivery' && flags.deliveryOverdue) { cls = 'late'; text += ' — ' + plural(flags.deliveryOverdue.days, 'day') + ' overdue'; }
      return fact(label, text, cls);
    });

    return el('div', { class: 'card' }, [
      el('h2', { text: 'From the tracker' }),
      el('div', { class: 'body' }, [
        el('div', { class: 'kv' }, dateFacts),
        el('div', { class: 'kv', style: 'margin-top:14px' }, [
          fact('Cases', v.cases != null ? String(v.cases) : '—'),
          fact('Bottles', v.bottles != null ? String(v.bottles) : '—'),
          fact('Pallets', v.pallets != null ? String(v.pallets) : '—'),
          fact('Lot number', v.lot ? String(v.lot) : '—'),
          fact('NAV invoice', v.navInvoice ? String(v.navInvoice) : '—'),
          fact('Truck type', shipment.truck || '—'),
          fact('Contract balance (cases)', v.balanceCs != null ? String(v.balanceCs) : '—'),
          fact('Shipment', shipment.status.label),
        ]),
        v.notes ? el('p', { class: 'help', style: 'margin:12px 0 0', text: 'Tracker notes: ' + v.notes }) : null,
        order.dateIssues && order.dateIssues.length
          ? el('div', { class: 'msg warn', style: 'margin-top:12px' }, [el('span', { class: 'icon', text: '!' }),
            el('div', { text: order.dateIssues.map((i) => i.label + ' (' + fmt(i.date) + ')').join('; ') + ' looks mistyped in the tracker and is being ignored.' })])
          : null,
      ]),
    ]);
  }

  function chasesCard(order) {
    const live = order.followUps.filter((f) => !f.superseded);
    if (!order.followUps.length) return null;
    return el('div', { class: 'card' }, [
      el('h2', {}, [document.createTextNode('Still being chased (' + live.length + ')'), el('span', { class: 'spacer' }),
        el('button', { class: 'btn small', text: 'Open Follow-ups', onclick: () => showTab('followups') })]),
      el('div', { class: 'body' }, order.followUps.map((f) => el('div', { class: 'tsk' }, [
        el('div', { class: 'tsk-title' }, [
          el('div', { text: f.missingHeader + ' is blank' }),
          el('div', { class: 'tsk-meta', text: 'asked of the ' + f.party + ' · ' + plural(f.ageDays, 'day') + ' since ' + f.anchorHeader
            + (f.superseded ? ' · overtaken: ' + f.supersededReason : '') }),
        ]),
        el('span', { class: 'tag ' + (f.superseded ? '' : 'warn'), text: f.superseded ? 'overtaken' : 'live' }),
      ]))),
    ]);
  }

  function activityCard(order) {
    const rows = AMI.activityFor(workDoc(), order.key);
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Activity' }),
      el('div', { class: 'body' }, rows.length
        ? [el('div', { class: 'activity' }, rows.slice(0, 40).map((a) => el('div', { class: 'activity-row' }, [
          el('time', { text: a.at.slice(0, 16).replace('T', ' ') }),
          el('div', { text: a.who + ': ' + a.text }),
        ])))]
        : [el('p', { class: 'help', text: 'Nothing recorded yet. Ticks, exceptions and stage changes made here are logged with who and when.' })]),
    ]);
  }

  function renderDrawer() {
    const drawer = $('#drawer');
    const scrim = $('#drawerScrim');
    if (!openKey) { drawer.hidden = true; scrim.hidden = true; clear(drawer); return; }
    const order = orderByKey(openKey);
    if (!order) { closeDrawer(); return; }

    const keep = drawer.querySelector('.dr-body');
    const top = keep ? keep.scrollTop : 0;
    clear(drawer);

    const st = AMI.statusById(order.status.statusId);
    drawer.appendChild(el('div', { class: 'dr-head' }, [
      el('div', { class: 'dr-top' }, [
        el('button', { class: 'btn small', text: '✕ Close', onclick: closeDrawer, 'aria-label': 'Close' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'chip ' + ui.SOURCE_CHIP[order.status.source], text: ui.SOURCE_LONG[order.status.source] }),
      ]),
      el('h2', {}, [el('span', { class: 'mono', text: 'PO ' + order.po }), el('span', { html: AMI.statusPill(st, { tip: order.status.reason }) })]),
      el('div', { class: 'dr-sub', text: orderWhere(order) + (order.divisionName ? ' · ' + order.divisionName : '') }),
    ]));

    const body = el('div', { class: 'dr-body' }, [
      el('div', { class: 'card' }, [el('h2', { text: 'Workflow' }), el('div', { class: 'body' }, [workflowTracker(order), el('div', { style: 'margin-top:14px' }, [stageControl(order)])])]),
      checklistCard(order),
      drawerExceptions(order),
      factsCard(order),
      chasesCard(order),
      activityCard(order),
    ].filter(Boolean));
    drawer.appendChild(body);
    drawer.hidden = false;
    scrim.hidden = false;
    body.scrollTop = top;
  }

  function openOrder(key) {
    openKey = key;
    const s = $('#globalResults'); if (s) s.hidden = true;
    renderDrawer();
    const first = $('#drawer .btn');
    if (first) first.focus();
  }

  function closeDrawer() {
    if (!openKey) return;
    openKey = '';
    renderDrawer();
  }

  /* ------------------------------------------------------------------ *
   * Badges and refresh
   * ------------------------------------------------------------------ */

  function setBadge(name, count, warn) {
    const b = document.querySelector('[data-badge="' + name + '"]');
    if (!b) return;
    b.hidden = !count;
    b.textContent = count ? String(count) : '';
    b.classList.toggle('warn', !!warn);
  }

  function updateBadges() {
    if (!state.portfolio || !ui.currentUser()) { setBadge('exceptions', 0); setBadge('mywork', 0); return; }
    const orders = ui.allOrders().filter((o) => o.isOpen);
    const high = gatherExceptions(orders).filter((i) => AMI.SEVERITY_RANK[i.exc.severity] >= 3).length;
    const user = ui.currentUser();
    const due = gatherTasks(orders).filter((i) => i.task.due && daysFromToday(i.task.due) <= 0 && (!i.task.owner || i.task.owner === user.id)).length;
    setBadge('exceptions', high);
    setBadge('mywork', due, true);
  }

  /** Redraw whatever is on screen after something changed. */
  function refresh(stageChanged) {
    const fn = RENDERERS[state.tab];
    const pages = ['mywork', 'tasks', 'exceptions', 'shipments'];
    if (stageChanged) pages.push('orderstatus', 'dashboard');
    if (fn && pages.includes(state.tab)) fn();
    renderDrawer();
    updateBadges();
  }

  hooks.openOrder = openOrder;
  hooks.closeDrawer = closeDrawer;
  hooks.workChanged = () => refresh();
  hooks.statusChanged = () => { renderDrawer(); updateBadges(); };
  hooks.portfolioReady = () => { updateBadges(); if (['mywork', 'tasks', 'exceptions', 'shipments'].includes(state.tab)) refresh(); };

  RENDERERS.mywork = renderMyWork;
  RENDERERS.tasks = renderTasks;
  RENDERERS.exceptions = renderExceptions;
  RENDERERS.shipments = renderShipments;

  /* ------------------------------------------------------------------ *
   * Search
   * ------------------------------------------------------------------ */

  function wireSearch() {
    const input = $('#globalSearch');
    const out = $('#globalResults');
    if (!input || !out) return;
    let hi = -1;
    let hits = [];

    const close = () => { out.hidden = true; hi = -1; };
    const run = async () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      if (!state.portfolio) await ui.ensurePortfolio();
      const terms = q.split(/\s+/);
      hits = ui.allOrders().filter((o) => {
        const hay = [o.po, o.accountName, o.itemName, o.values.lot, o.values.navInvoice, o.values.notes].join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      }).sort((a, b) => (b.isOpen - a.isOpen) || a.po.localeCompare(b.po)).slice(0, 12);
      clear(out);
      if (!hits.length) out.appendChild(el('div', { class: 'gr-none', text: 'No order matches “' + input.value.trim() + '”.' }));
      hits.forEach((o, i) => out.appendChild(el('button', {
        type: 'button', class: i === hi ? 'hi' : '', onclick: () => { input.value = ''; close(); openOrder(o.key); },
      }, [
        el('span', { class: 'mono', text: 'PO ' + o.po }),
        el('span', { class: 'gr-sub', text: orderWhere(o) }),
        o.status.statusId ? el('span', { class: 'tag', text: stageName(o.status.statusId) }) : null,
      ])));
      out.hidden = false;
    };

    input.addEventListener('input', run);
    input.addEventListener('focus', () => { if (input.value.trim()) run(); else if (!state.portfolio && ui.currentUser()) ui.ensurePortfolio(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!hits.length) return;
        hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        Array.from(out.querySelectorAll('button')).forEach((b, i) => b.classList.toggle('hi', i === hi));
      } else if (e.key === 'Enter' && hits.length) {
        e.preventDefault();
        const pick = hits[hi >= 0 ? hi : 0];
        input.value = ''; close(); openOrder(pick.key);
      }
    });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('.gsearch')) close(); });
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.key === '/' && !['input', 'textarea', 'select'].includes(tag) && !input.disabled) { e.preventDefault(); input.focus(); }
      else if (e.key === 'Escape' && openKey && !document.querySelector('.overlay')) closeDrawer();
    });
  }

  $('#drawerScrim').addEventListener('click', closeDrawer);
  wireSearch();
})();
