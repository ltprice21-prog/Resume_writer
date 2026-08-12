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
  check('five stages, invoiced before closed', AMI.ORDER_STATUSES.map((s) => s.id),
    ['placed', 'transit', 'delivered', 'invoiced', 'closed']);
  check('steps run 1..5', AMI.ORDER_STATUSES.map((s) => s.step), [1, 2, 3, 4, 5]);
  check('everything short of closed is open', AMI.ORDER_STATUSES.filter((s) => s.open).map((s) => s.id),
    ['placed', 'transit', 'delivered', 'invoiced']);
  ok('closed is the only terminal stage', !AMI.isOpenStatus('closed'));
  ok('an invoiced order still counts as open until it is closed', AMI.isOpenStatus('invoiced'));
  ok('an unknown status is treated as open rather than dropped', AMI.isOpenStatus('nonsense'));
  ok('every stage explains itself', AMI.ORDER_STATUSES.every((s) => s.hint && s.label && s.short));
  ok('closed says it cannot be derived', /not derivable/i.test(AMI.statusById('closed').hint));

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
    Object.keys(counts).sort(), ['closed', 'delivered', 'invoiced', 'placed', 'transit', 'unset'].sort());
  check('the counts add up', Object.values(counts).reduce((a, b) => a + b, 0), 12);

  const invoicedDoc = AMI.emptyStatusDoc();
  AMI.setStatus(invoicedDoc, orders[0].key, 'invoiced', 'Bo');
  AMI.setStatus(invoicedDoc, orders[1].key, 'closed', 'Bo');
  const openness = AMI.decorate([orders[0], orders[1]], invoicedDoc, today);
  ok('an invoiced order is counted among the open ones', openness[0].isOpen === true);
  ok('a closed order is not', openness[1].isOpen === false);

  const account = { id: 'aeromexico', name: 'Aeromexico', divisionId: 'europe' };
  const healthy = AMI.summariseAccount(account, 'Europe', AMI.decorate(
    orders.map((o) => Object.assign({}, o, { lastEvent: today })), doc, today), 0);
  check('a current account reads as on track', healthy.health.level, 'good');

  const stale = AMI.summariseAccount(account, 'Europe', AMI.decorate(
    orders.map((o) => Object.assign({}, o, { lastEvent: new Date(2026, 5, 1) })), doc, today), 0);
  ok('a long-idle open order raises attention', stale.health.level !== 'good', stale.health.level);
  ok('and says which PO and how long', /no dated activity for \d+ days/.test(stale.health.reasons.join(' ')),
    stale.health.reasons.join(' | '));

  const busy = AMI.summariseAccount(account, 'Europe', AMI.decorate(
    orders.map((o) => Object.assign({}, o, { lastEvent: today })), doc, today), 9);
  check('many outstanding follow-ups read as at risk', busy.health.level, 'critical');
  ok('and the reason names them', /9 outstanding follow-up/.test(busy.health.reasons.join(' ')),
    busy.health.reasons.join(' | '));
  ok('thresholds are reported alongside the verdict', busy.thresholds.warningDays > 0);

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
  AMI.setStatus(theirs, 'a/b/3', 'closed', 'Them');
  await AMI.saveStatuses(store, theirs, { by: 'Them' });
  const afterBoth = await AMI.saveStatuses(store, mine, { by: 'Me' });
  check('a colleague\'s other edits are not lost', afterBoth.entries['a/b/3'].status, 'closed');
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
    { label: 'In transit', value: 6, color: 'var(--stage-2)' },
    { label: 'Delivered', value: 2, color: 'var(--stage-3)' },
  ]);
  ok('segments are proportional', /flex:6/.test(bar) && /flex:2/.test(bar));
  ok('each segment describes itself on hover', /data-tip="In transit: 6 of 8 \(75%\)"/.test(bar), bar);
  ok('the dominant segment is labelled in place', /bar-inline/.test(bar));
  const inked = AMI.stackedBar([{ label: 'Invoiced', value: 9, color: 'var(--stage-5)', ink: 'var(--stage-fg-5)' }]);
  ok('an in-bar number takes the ink matched to its fill',
    /--ink:var\(--stage-fg-5\)/.test(inked), inked);
  ok('an empty bar says so instead of rendering nothing',
    /Nothing to show/.test(AMI.stackedBar([{ label: 'x', value: 0, color: 'red' }])));

  const legend = AMI.statusLegend(AMI.ORDER_STATUSES, counts);
  ok('a legend is always present for the ramp',
    AMI.ORDER_STATUSES.every((s) => legend.includes(s.short)));
  ok('legend swatches use the stage ramp variables', /var\(--stage-1\)/.test(legend));

  const list = AMI.barList([
    { label: 'Aeromexico', sub: 'Europe', segments: [{ label: 'a', value: 3, color: 'var(--stage-1)' }], meta: '3 open' },
  ]);
  ok('rows keep a text label so colour never carries identity', /Aeromexico/.test(list));
  ok('and a sub-label for the division', /Europe/.test(list));
  ok('empty lists explain themselves', /Nothing to show/.test(AMI.barList([])));

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

  const chart = AMI.columnChart(series, { unit: 'cases' });
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
