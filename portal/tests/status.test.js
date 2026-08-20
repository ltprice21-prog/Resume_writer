/* Tests for the order-status model and the chart builders.
 *
 *   node portal/tests/status.test.js [fixturesDir]
 */
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
require('../src/workspace.js');
require('../src/status.js');
const AMI = require('../src/charts.js');

const FIXTURES = process.argv[2] || process.env.AMI_FIXTURES
  || '/root/.claude/uploads/ce5dd401-299f-5618-9ee9-da4319624cf3';

let passed = 0, failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { failed++; failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : '')); }
};
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else {
    failed++; failures.push(name);
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       expected: ' + JSON.stringify(expected));
    console.log('       actual:   ' + JSON.stringify(actual));
  }
};

function fixture(re) {
  const f = fs.readdirSync(FIXTURES).find((n) => re.test(n));
  if (!f) throw new Error('No fixture matching ' + re);
  return path.join(FIXTURES, f);
}

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8');

function memoryStore(seed) {
  const files = new Map(seed || []);
  return {
    files,
    async read(p) { return files.has(p) ? files.get(p) : null; },
    async write(p, b) { files.set(p, b); },
    async list() { return []; },
    async remove(p) { files.delete(p); },
  };
}

(async () => {
  console.log('\nPipeline definition');
  check('four stages, ending at invoiced and closed', AMI.ORDER_STATUSES.map((s) => s.id),
    ['placed', 'transit', 'delivered', 'invoiced']);
  check('steps run 1..4', AMI.ORDER_STATUSES.map((s) => s.step), [1, 2, 3, 4]);
  check('everything short of invoicing is open', AMI.ORDER_STATUSES.filter((s) => s.open).map((s) => s.id),
    ['placed', 'transit', 'delivered']);
  ok('invoicing ends the order', !AMI.isOpenStatus('invoiced'));
  check('and says so in its label', AMI.statusById('invoiced').label, 'Invoiced and Closed');
  ok('an unknown status is treated as open rather than dropped', AMI.isOpenStatus('nonsense'));
  ok('every stage explains itself', AMI.ORDER_STATUSES.every((s) => s.hint && s.label && s.short));

  console.log('\nStages are separable without colour');
  check('each stage carries its own weave', AMI.ORDER_STATUSES.map((s) => s.pattern),
    ['solid', 'diagonal', 'horizontal', 'vertical']);
  ok('no two stages share a weave',
    new Set(AMI.ORDER_STATUSES.map((s) => s.pattern)).size === AMI.ORDER_STATUSES.length);

  console.log('\nStatuses recorded before the terminal stages merged');
  check('"closed" now resolves to the merged stage', AMI.canonicalStatusId('closed'), 'invoiced');
  check('and finds the same stage object', AMI.statusById('closed').id, 'invoiced');
  ok('an ordinary id is left alone', AMI.canonicalStatusId('transit') === 'transit');
  const legacyDoc = AMI.emptyStatusDoc();
  legacyDoc.entries['a/b/c'] = { status: 'closed', updated: '2026-05-01T00:00:00.000Z', updatedBy: 'Bo Price' };
  const legacy = AMI.effectiveStatus({ key: 'a/b/c', derived: null }, legacyDoc);
  check('an order stored as closed reads as invoiced and closed', legacy.statusId, 'invoiced');
  check('and is still attributed to the person', legacy.source, 'set');
  ok('the reason says the record predates the merge',
    /before invoiced and closed became one stage/.test(legacy.reason), legacy.reason);
  const written = AMI.setStatus(AMI.emptyStatusDoc(), 'k', 'closed', 'Bo');
  check('writing "closed" stores the merged id', written.entries.k.status, 'invoiced');

  console.log('\nReading orders from a real tracker');
  const wb = await AMI.Workbook.load(new Uint8Array(fs.readFileSync(fixture(/Tracking_Chart.*\.xlsx$/i))));
  const sheet = wb.sheet('2026 Cycle');
  const header = AMI.findHeaderRow(sheet);
  const orders = AMI.readOrders(sheet, header, {
    accountId: 'aeromexico', accountName: 'Aeromexico', divisionId: 'europe',
    itemId: 'evidencia', itemName: 'Evidencia Tempranillo',
  });
  check('every logged order is read', orders.length, 12);
  check('keys namespace account, item and PO', orders[0].key, 'aeromexico/evidencia/319843-1');
  check('first PO', orders[0].po, '319843-1');
  check('last PO', orders[orders.length - 1].po, '350633-2');
  check('cases read', orders[0].values.cases, 336);
  check('account context carried', orders[0].accountName, 'Aeromexico');

  console.log('\nStatus derived from the tracker');
  const first = orders[0];
  check('an invoiced order derives from the NAV invoice number', first.derived.statusId, 'invoiced');
  ok('and says which column said so', /NAV invoice number/.test(first.derived.reason), first.derived.reason);

  const last = orders[orders.length - 1];
  check('an order only sent to the winery derives as placed', last.derived.statusId, 'placed');
  ok('and says why', /sent to the winery/.test(last.derived.reason), last.derived.reason);

  ok('every order on this tracker derives something', orders.every((o) => o.derived));
  ok('no order derives "closed" — nothing in the tracker means closed',
    orders.every((o) => o.derived.statusId !== 'closed'));

  console.log('\nLast dated activity');
  ok('the last event is a real date', last.lastEvent instanceof Date, String(last.lastEvent));
  ok('and is labelled with the column it came from', !!last.lastEventLabel, last.lastEventLabel);
  ok('planned dates are not counted as activity',
    last.lastEventLabel !== 'customer required delivery' && last.lastEventLabel !== 'requested collection',
    last.lastEventLabel);

  console.log('\nWhat a person sets beats what the tracker implies');
  const doc = AMI.emptyStatusDoc();
  const eff0 = AMI.effectiveStatus(last, doc);
  check('with nothing set, the tracker speaks', eff0.source, 'derived');
  check('and the stage is the derived one', eff0.statusId, 'placed');

  AMI.setStatus(doc, last.key, 'transit', 'Bo Price', 'left the cellars today');
  const eff1 = AMI.effectiveStatus(last, doc);
  check('a set status wins', eff1.statusId, 'transit');
  check('and is marked as set', eff1.source, 'set');
  ok('naming who set it', /Bo Price/.test(eff1.reason), eff1.reason);
  check('the note is kept', eff1.note, 'left the cellars today');

  AMI.clearStatus(doc, last.key);
  check('clearing falls back to the tracker', AMI.effectiveStatus(last, doc).source, 'derived');

  const orphan = { key: 'x/y/z', derived: null };
  const effNone = AMI.effectiveStatus(orphan, doc);
  check('an order with nothing to go on is "not set", never guessed', effNone.statusId, '');
  check('and reports that plainly', effNone.source, 'none');

  let threw = null;
  try { AMI.setStatus(doc, 'a/b/c', 'shipped-ish', 'X'); } catch (e) { threw = e; }
  ok('an unknown status is refused', threw && /Unknown status/.test(threw.message), String(threw));

  console.log('\nInvoicing closes the order');
  const ruleDoc = AMI.emptyStatusDoc();
  const invoicedOrder = orders[0];
  const ruled = AMI.effectiveStatus(invoicedOrder, ruleDoc);
  check('a NAV invoice number puts the order at the terminal stage', ruled.statusId, 'invoiced');
  check('read from the tracker, not invented', ruled.source, 'derived');
  ok('and the reason says the invoice closes it',
    /NAV invoice number/.test(ruled.reason) && /closes the order/.test(ruled.reason), ruled.reason);

  const earlier = AMI.effectiveStatus(orders[orders.length - 1], ruleDoc);
  check('an order short of invoicing is unaffected', earlier.statusId, 'placed');
  check('and keeps its ordinary source', earlier.source, 'derived');

  const ruleDay = new Date(2026, 7, 12);
  const ruledOrders = AMI.decorate(orders, ruleDoc, ruleDay);
  const ruledCounts = AMI.countByStatus(ruledOrders);
  ok('invoiced orders exist on this tracker', ruledCounts.invoiced > 0, JSON.stringify(ruledCounts));
  ok('and none of them counts as open',
    ruledOrders.filter((o) => o.status.statusId === 'invoiced').every((o) => o.isOpen === false));

  const split = AMI.partitionClosed(ruledOrders);
  check('splitting finished from live covers every order',
    split.closed.length + split.open.length, ruledOrders.length);
  check('the finished set is exactly the invoiced one', split.closed.length, ruledCounts.invoiced);

  console.log('\nImplausible dates in the tracker');
  const badRow = orders.find((o) => o.dateIssues.length);
  ok('a mistyped date is caught rather than used', !!badRow, 'none flagged');
  check('it names the PO', badRow.po, '319844-2');
  check('and the column', badRow.dateIssues[0].label, 'delivered');
  ok('the out-of-range value is kept for the report',
    badRow.dateIssues[0].date.getFullYear() > 3000, String(badRow.dateIssues[0].date));
  ok('but is not treated as history', !badRow.dates.delivered);
  ok('so the last real activity still stands',
    badRow.lastEvent && badRow.lastEvent.getFullYear() === 2026, String(badRow.lastEvent));
  const flagged = orders.filter((o) => o.dateIssues.length);
  check('all three mistyped rows in this tracker are found', flagged.map((o) => o.po),
    ['319844-2', '350632-3', '350632-4']);
  // O41/O42 are mistyped and K is computed from O, so one typo surfaces twice.
  check('a typo that feeds a formula is reported on both columns',
    flagged[1].dateIssues.map((i) => i.label), ['requested collection', 'customer required delivery']);
  ok('the rest of the tracker is clean', orders.length - flagged.length === 9);

  console.log('\nRoll-ups');
  const today = new Date(2026, 7, 12);
  const decorated = AMI.decorate(orders, doc, today);
  ok('ages are computed from the last dated activity, never negative',
    decorated.every((o) => o.ageDays == null || o.ageDays >= 0),
    decorated.filter((o) => o.ageDays < 0).map((o) => o.po + ':' + o.ageDays).join(', '));
  const counts = AMI.countByStatus(decorated);
  check('counts cover every stage plus unset',
    Object.keys(counts).sort(), ['delivered', 'invoiced', 'placed', 'transit', 'unset'].sort());
  check('the counts add up', Object.values(counts).reduce((a, b) => a + b, 0), 12);

  const invoicedDoc = AMI.emptyStatusDoc();
  AMI.setStatus(invoicedDoc, orders[0].key, 'invoiced', 'Bo');
  AMI.setStatus(invoicedDoc, orders[1].key, 'closed', 'Bo');
  const openness = AMI.decorate([orders[0], orders[1]], invoicedDoc, today);
  ok('an invoiced order is finished', openness[0].isOpen === false);
  ok('and one stored as closed lands in the same place',
    openness[1].isOpen === false && openness[1].status.statusId === 'invoiced');

  console.log('\nContract standing');
  const decoratedAll = AMI.withSchedule(
    AMI.decorate(orders, AMI.emptyStatusDoc(), new Date(2026, 7, 20)), new Date(2026, 7, 20));
  const standing = AMI.contractStanding(decoratedAll, {
    accountName: 'Aeromexico', itemName: 'Evidencia Tempranillo', cycle: '2026 Cycle',
  });
  check('the balance is the tracker\'s own running total after the last order',
    standing.balanceBt, 44544);
  check('in cases too', standing.balanceCs, 3712);
  ok('and says which PO it was read after', standing.balanceFrom === '350633-2', standing.balanceFrom);
  check('a balance above zero is an open contract', standing.state, 'open');
  ok('the cycle is the sheet the item posts into', standing.cycle === '2026 Cycle');

  check('the most recent delivery is the latest one actually recorded',
    AMI.formatISO(standing.lastDelivery), '2026-06-18');
  check('attributed to its PO', standing.lastDeliveryPo, '350633-1');
  check('the furthest requested delivery is the latest date asked for',
    AMI.formatISO(standing.furthestRequested), '2026-06-26');
  check('also attributed', standing.furthestRequestedPo, '350633-2');

  // A mistyped year would otherwise become "the furthest date" and stay there.
  ok('a date the tracker cannot mean is not the furthest date',
    standing.furthestRequested.getFullYear() === 2026, String(standing.furthestRequested));

  // The 2025 sheet on this workbook really has over-ordered.
  const olderSheet = wb.sheet('2025');
  const olderHeader = AMI.findHeaderRow(olderSheet);
  const olderOrders = AMI.decorate(AMI.readOrders(olderSheet, olderHeader, { itemId: 'evidencia' }),
    AMI.emptyStatusDoc(), new Date(2026, 7, 20));
  const overdrawn = AMI.contractStanding(olderOrders, { itemName: 'Evidencia', cycle: '2025' });
  check('a balance below zero reads as over contract', overdrawn.state, 'over');
  check('and keeps the negative figure rather than clamping it', overdrawn.balanceBt, -10176);
  ok('flagged for the interface', overdrawn.isOver === true && overdrawn.isClosed === false);
  ok('with a reason a person can act on',
    /more has been ordered than the contract covers/.test(overdrawn.reason), overdrawn.reason);

  const zeroed = AMI.contractStanding([Object.assign({}, decoratedAll[0], {
    row: 99, values: { balanceBt: 0, balanceCs: 0 },
  })], {});
  check('a balance of exactly zero closes the item', zeroed.state, 'closed');
  ok('and is flagged as closed', zeroed.isClosed === true && zeroed.isOver === false);
  ok('with the reason stated', /everything contracted has been ordered/.test(zeroed.reason), zeroed.reason);

  const noBalance = AMI.contractStanding([Object.assign({}, decoratedAll[0], { values: {} })], {});
  check('a tracker with no balance column says so rather than guessing', noBalance.state, 'unknown');
  check('and reports no figure', noBalance.balanceBt, null);
  check('an item with no orders at all is unknown too', AMI.contractStanding([], {}).state, 'unknown');

  console.log('\nCollection and delivery dates');
  const NOW = new Date(2026, 7, 20);
  const day = (y, m, d) => new Date(y, m - 1, d);
  /* A decorated order, built by hand so each date condition can be isolated. */
  const order = (po, dates, extra) => Object.assign({
    po, key: 'a/i/' + po, row: 10, accountId: 'aeromexico', accountName: 'Aeromexico',
    itemId: 'evidencia', itemName: 'Evidencia', divisionId: 'europe',
    dates, values: {}, dateIssues: [], lastEvent: NOW, lastEventLabel: 'delivered',
    ageDays: 0, isOpen: true, status: { statusId: 'transit', source: 'derived', reason: '' },
  }, extra || {});

  const onTime = order('A-1', {
    requestedCollection: day(2026, 8, 3), actualCollection: day(2026, 8, 3),
    requiredDelivery: day(2026, 8, 7), delivered: day(2026, 8, 6),
  });
  const f1 = AMI.scheduleFlags(onTime, NOW);
  ok('meeting both dates raises nothing',
    !f1.collectionOverdue && !f1.deliveryOverdue && !f1.collectedLate && !f1.deliveredLate,
    JSON.stringify(f1));

  const onTheDay = order('A-2', {
    requestedCollection: day(2026, 8, 20), requiredDelivery: day(2026, 8, 20),
  });
  const f2 = AMI.scheduleFlags(onTheDay, NOW);
  ok('a date due today is not yet overdue',
    !f2.collectionOverdue && !f2.deliveryOverdue, JSON.stringify(f2));

  const missedCollection = order('A-3', {
    requestedCollection: day(2026, 8, 10), requiredDelivery: day(2026, 9, 30),
  });
  const f3 = AMI.scheduleFlags(missedCollection, NOW);
  check('a passed collection date with nothing collected is overdue', f3.collectionOverdue.days, 10);
  ok('and the delivery still ahead of us is not', !f3.deliveryOverdue);

  const missedDelivery = order('A-4', {
    requestedCollection: day(2026, 7, 1), actualCollection: day(2026, 7, 1),
    requiredDelivery: day(2026, 7, 20),
  });
  const f4 = AMI.scheduleFlags(missedDelivery, NOW);
  check('a passed delivery date with nothing delivered is overdue', f4.deliveryOverdue.days, 31);
  ok('and a collection that happened is not chased', !f4.collectionOverdue);

  const metLate = order('A-5', {
    requestedCollection: day(2026, 6, 1), actualCollection: day(2026, 6, 5),
    requiredDelivery: day(2026, 6, 10), delivered: day(2026, 6, 12),
  });
  const f5 = AMI.scheduleFlags(metLate, NOW);
  check('collected after the date asked for is recorded as late', f5.collectedLate.days, 4);
  check('and delivered late likewise', f5.deliveredLate.days, 2);
  ok('but neither is overdue — there is nothing left to chase',
    !f5.collectionOverdue && !f5.deliveryOverdue);

  const noDates = order('A-6', {});
  const f6 = AMI.scheduleFlags(noDates, NOW);
  ok('an order with no requested dates raises nothing',
    !f6.collectionOverdue && !f6.deliveryOverdue && !f6.collectedLate && !f6.deliveredLate);

  console.log('\nAccount health from those dates');
  const account = { id: 'aeromexico', name: 'Aeromexico', divisionId: 'europe' };
  const health = (list, followUps) =>
    AMI.summariseAccount(account, 'Europe', list, followUps || 0, null, NOW);

  const clean = health([onTime, onTheDay]);
  check('every date met or still ahead reads as on track', clean.health.level, 'good');
  ok('and says so plainly',
    /every requested collection and required delivery date/.test(clean.health.reasons.join(' ')),
    clean.health.reasons.join(' | '));

  const slipping = health([onTime, missedCollection]);
  check('one collection past its date needs attention', slipping.health.level, 'warning');
  check('and is counted', slipping.collectionsOverdue, 1);
  ok('the reason names the PO and the days',
    /PO A-3 by 10 days/.test(slipping.health.reasons.join(' ')), slipping.health.reasons.join(' | '));

  const badlyLate = health([order('A-7', { requestedCollection: day(2026, 7, 1) })]);
  check('a collection more than a fortnight past is at risk', badlyLate.health.level, 'critical');

  const undelivered = health([missedDelivery]);
  check('any delivery past its date is at risk', undelivered.health.level, 'critical');
  check('and is counted separately from collections', undelivered.deliveriesOverdue, 1);
  ok('the reason says no delivery is recorded',
    /no delivery recorded/.test(undelivered.health.reasons.join(' ')), undelivered.health.reasons.join(' | '));

  // The whole reason lateness is split two ways: an account that always runs a
  // few days late would otherwise sit permanently at risk over nothing chaseable.
  const lateButDone = health([metLate, metLate, metLate]);
  check('orders met late do not move the health mark', lateButDone.health.level, 'good');
  check('but they are counted', lateButDone.collectedLate, 3);
  check('and so are the late deliveries', lateButDone.deliveredLate, 3);

  const withFollowUps = health([onTime], 9);
  check('follow-ups no longer set health on their own', withFollowUps.health.level, 'good');
  check('though they are still reported', withFollowUps.followUps, 9);
  ok('thresholds are reported alongside the verdict', withFollowUps.thresholds.lateCollectionDays > 0);

  console.log('\nThe schedule of what is still coming');
  const sched = AMI.scheduleEntries(
    [onTime, missedCollection, missedDelivery, order('A-8', {
      requestedCollection: day(2026, 8, 26), requiredDelivery: day(2026, 9, 4),
    })], NOW);
  check('a date already met drops out of the schedule',
    sched.some((e) => e.order.po === 'A-1'), false);
  check('what is left is in date order', sched.map((e) => e.order.po + ':' + e.kind),
    ['A-4:delivery', 'A-3:collection', 'A-8:collection', 'A-8:delivery', 'A-3:delivery']);
  check('missed dates are marked overdue', sched.filter((e) => e.overdue).map((e) => e.order.po),
    ['A-4', 'A-3']);

  const byWeek = AMI.groupSchedule(sched, 'week', NOW);
  check('overdue is its own group, at the top', byWeek[0].key, 'overdue');
  ok('rather than buried in the week it was due',
    byWeek.slice(1).every((g) => !g.entries.some((e) => e.overdue)));
  ok('weeks run Monday to Sunday',
    AMI.startOfWeek(day(2026, 8, 20)).getDay() === 1, String(AMI.startOfWeek(day(2026, 8, 20))));
  ok('and each week says how far off it is',
    byWeek.slice(1).some((g) => /week/.test(g.sub)), byWeek.map((g) => g.label + '/' + g.sub).join(' | '));

  const byMonth = AMI.groupSchedule(sched, 'month', NOW);
  check('grouping by month keeps overdue first', byMonth[0].key, 'overdue');
  ok('and names the month', /August 2026/.test(byMonth.map((g) => g.label).join(' ')),
    byMonth.map((g) => g.label).join(' | '));
  ok('the same entries appear either way',
    byWeek.reduce((n, g) => n + g.entries.length, 0) === byMonth.reduce((n, g) => n + g.entries.length, 0));

  console.log('\nStatus storage');
  const store = memoryStore();
  const fresh = await AMI.loadStatuses(store);
  check('a missing file is an empty document', Object.keys(fresh.entries).length, 0);

  AMI.setStatus(fresh, 'a/b/1', 'transit', 'Bo');
  const saved = await AMI.saveStatuses(store, fresh, { by: 'Bo' });
  ok('written to the shared folder', store.files.has('order-status.json'));
  check('author recorded', JSON.parse(DEC.decode(store.files.get('order-status.json'))).updatedBy, 'Bo');
  const reread = await AMI.loadStatuses(store);
  check('entries survive the round trip', reread.entries['a/b/1'].status, 'transit');

  // Two people editing different orders must both survive.
  const mine = await AMI.loadStatuses(store);
  const theirs = await AMI.loadStatuses(store);
  AMI.setStatus(mine, 'a/b/2', 'delivered', 'Me');
  AMI.setStatus(theirs, 'a/b/3', 'invoiced', 'Them');
  await AMI.saveStatuses(store, theirs, { by: 'Them' });
  const afterBoth = await AMI.saveStatuses(store, mine, { by: 'Me' });
  check('a colleague\'s other edits are not lost', afterBoth.entries['a/b/3'].status, 'invoiced');
  check('and neither are mine', afterBoth.entries['a/b/2'].status, 'delivered');
  check('the untouched entry stays', afterBoth.entries['a/b/1'].status, 'transit');

  const older = { entries: { k: { status: 'placed', updated: '2026-01-01T00:00:00.000Z' } } };
  const newer = { entries: { k: { status: 'invoiced', updated: '2026-06-01T00:00:00.000Z' } } };
  check('on the same order the newer edit wins', AMI.mergeStatusDocs(older, newer).entries.k.status, 'invoiced');
  check('regardless of argument order', AMI.mergeStatusDocs(newer, older).entries.k.status, 'invoiced');

  console.log('\nAccount summary');
  const summaryDoc = AMI.emptyStatusDoc();
  AMI.setStatus(summaryDoc, orders[11].key, 'transit', 'Bo Price');
  const summary = AMI.buildAccountSummary({
    accountName: 'Aeromexico', divisionName: 'Europe', itemNames: ['Evidencia Tempranillo'],
    orders: AMI.decorate(orders, summaryDoc, today), preparedBy: 'Bo Price', today, openOnly: true,
  });
  ok('the account is named', /Aeromexico — account summary/.test(summary.html));
  ok('the division and date are stated', /Europe division/.test(summary.html) && /Aug 12 2026/.test(summary.html));
  ok('open orders are counted against the total',
    new RegExp('<strong>' + summary.open + '</strong> open order').test(summary.html), String(summary.open));
  ok('every stage is listed in the breakdown',
    AMI.ORDER_STATUSES.every((s) => summary.html.includes(s.label)));
  ok('the set order appears with its source', /set by Bo Price/.test(summary.html));
  ok('the source column is explained at the foot', /whether a person set the stage/.test(summary.html));
  ok('no unresolved placeholders', !/\{\{/.test(summary.html));
  ok('html is escaped, not injected', !/<script/i.test(summary.html));

  const allOrders = AMI.buildAccountSummary({
    accountName: 'Aeromexico', orders: AMI.decorate(orders, summaryDoc, today), today, openOnly: false,
  });
  ok('an all-orders summary is offered too', /All orders/.test(allOrders.html));
  ok('rows whose stage came from the tracker say so', /From the tracker: a NAV invoice number is recorded/
    .test(allOrders.html), allOrders.html.slice(0, 200));
  ok('and the set row still names its author', /set by Bo Price/.test(allOrders.html));

  console.log('\nChart builders');
  const tiles = AMI.statTiles([
    { label: 'Open orders', value: 7, sub: 'of 12', tone: 'neutral' },
    { label: 'Follow-ups', value: 3, tone: 'warning', tip: 'across 2 trackers' },
  ]);
  ok('tiles carry their label and value', /Open orders/.test(tiles) && />7</.test(tiles));
  ok('tone becomes a class, not a bare colour', /tone-warning/.test(tiles));
  ok('tips are attached for the hover layer', /data-tip="across 2 trackers"/.test(tiles));

  const bar = AMI.stackedBar([
    { label: 'In transit', value: 6, step: 2 },
    { label: 'Delivered', value: 2, step: 3 },
  ]);
  ok('segments are proportional', /flex:6/.test(bar) && /flex:2/.test(bar));
  ok('each segment describes itself on hover', /data-tip="In transit: 6 of 8 \(75%\)"/.test(bar), bar);
  ok('the dominant segment is labelled in place', /bar-inline/.test(bar));
  ok('each segment is painted by its stage class, not an inline colour',
    /stage-fill stage-2/.test(bar) && /stage-fill stage-3/.test(bar) && !/background:/.test(bar), bar);
  const patterned = AMI.stackedBar([{ label: 'Invoiced and Closed', value: 9, step: 4 }]);
  ok('a number sitting on a weave gets its own ground',
    /bar-inline on-pattern/.test(patterned), patterned);
  const plain = AMI.stackedBar([{ label: 'Awaiting shipment', value: 9, step: 1 }]);
  ok('but a number on the solid stage does not need one',
    /bar-inline"/.test(plain) && !/on-pattern/.test(plain), plain);
  const drillable = AMI.stackedBar([{ label: 'In transit', value: 3, step: 2, key: 'stage:transit' }]);
  ok('a segment given a key can be drilled into',
    /data-drill="stage:transit"/.test(drillable) && /role="button"/.test(drillable), drillable);
  ok('and one without a key is inert', !/data-drill/.test(bar));
  ok('an empty bar says so instead of rendering nothing',
    /Nothing to show/.test(AMI.stackedBar([{ label: 'x', value: 0, step: 1 }])));

  const legend = AMI.statusLegend(AMI.ORDER_STATUSES, counts);
  ok('a legend is always present for the ramp',
    AMI.ORDER_STATUSES.every((s) => legend.includes(s.short)));
  ok('legend swatches are painted by their stage class', /swatch stage-fill stage-1/.test(legend), legend);
  ok('and the weave is named as well as shown',
    /diagonal stripes/.test(legend) && /horizontal stripes/.test(legend) && /vertical stripes/.test(legend), legend);
  ok('so the key still works read aloud or printed in grey',
    AMI.ORDER_STATUSES.every((st) => legend.includes(AMI.patternWord(st))));

  const list = AMI.barList([
    { label: 'Aeromexico', sub: 'Europe', segments: [{ label: 'a', value: 3, step: 1 }], meta: '3 open' },
  ]);
  ok('rows keep a text label so colour never carries identity', /Aeromexico/.test(list));
  ok('and a sub-label for the division', /Europe/.test(list));
  ok('empty lists explain themselves', /Nothing to show/.test(AMI.barList([])));

  const aged = AMI.barList([{ label: 'PO 1', value: 60, tone: 'critical', key: 'order:1' }]);
  ok('a row measuring an age takes the status palette, not a stage weave',
    /bar-tone-critical/.test(aged) && !/stage-fill/.test(aged), aged);
  ok('and can still be drilled into', /data-drill="order:1"/.test(aged));

  const svgDefs = AMI.stagePatternDefs();
  ok('svg gets one pattern per stage',
    AMI.ORDER_STATUSES.every((st) => svgDefs.includes('stagepat-' + st.step)), svgDefs.slice(0, 120));
  ok('and they reference the same tokens as the css', /var\(--stage-ink-2\)/.test(svgDefs));
  check('a stage paints from its own pattern', AMI.stagePaint(3), 'url(#stagepat-3)');

  const series = AMI.monthlySeries([
    { date: new Date(2026, 6, 3), value: 5 },
    { date: new Date(2026, 6, 20), value: 7 },
    { date: new Date(2026, 7, 1), value: 2 },
    { date: new Date(2020, 0, 1), value: 99 },
  ], 12, new Date(2026, 7, 12));
  check('twelve trailing months', series.length, 12);
  check('the final bucket is the current month', series[11].label, 'Aug 2026');
  check('values land in their month', series[10].value, 12);
  check('out-of-range dates are dropped, not clamped', series.reduce((a, b) => a + b.value, 0), 14);

  series[10].key = 'month:2026-6';
  const chart = AMI.columnChart(series, { unit: 'cases' });
  ok('a column given a key can be drilled into', /data-drill="month:2026-6"/.test(chart), chart.slice(0, 300));
  ok('the chart is an svg with an accessible name', /<svg[^>]*role="img"/.test(chart) && /aria-label=/.test(chart));
  ok('columns carry hover text', /data-tip="Jul 2026: 12 cases"/.test(chart), chart.slice(0, 200));
  ok('labels are selective, not one per column',
    (chart.match(/col-label/g) || []).length <= 2, String((chart.match(/col-label/g) || []).length));
  ok('an empty series says so', /No dated activity yet/.test(AMI.columnChart([])));

  ok('health pills ship an icon and a word, never colour alone',
    /health-icon/.test(AMI.healthPill('critical')) && /At risk/.test(AMI.healthPill('critical')));
  ok('status pills name the stage', /In transit/.test(AMI.statusPill(AMI.statusById('transit'), { short: true })));
  ok('an unset pill is visibly different', /pill-unset/.test(AMI.statusPill(null)));

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailed:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All green.\n');
})().catch((e) => { console.error('\nTest run crashed:\n', e); process.exit(1); });
