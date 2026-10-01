/* Tests for the twelve-stage workflow, against a tracker built in memory.
 *
 *   node portal/tests/workflow.test.js
 *
 * Needs no fixtures: the sheet here carries the real tracker's headings, so
 * the heading matches are exercised exactly as they are on a live chart.
 */
require('../src/engine.js');
require('../src/workspace.js');
require('../src/status.js');
const AMI = require('../src/charts.js');

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

/* The 2026 cycle sheet's headings, in column order. */
const HEADINGS = [
  'PO#', 'Quantity (bt)', 'Quantity (cs)', 'Quantity (pallets)', 'Bottling Date Confirmed', 'Lot Number',
  'Ship To', 'PO Received Date', 'ORDERS MUST BE SEND TO WINERY PRIOR TO', 'PO date sent to winery',
  'AMI Requested Collection Date', 'Winery Confirmed Available Date', 'Actual Collection Date from Cellars',
  'Delivery date to CDG', 'Customer Required Delivery Date', 'Method of Shipment', 'Forwarder', 'Truck Type',
  'Balance on Contract (bt)', 'Balance on Contract (cs)', 'Winery invoice received',
  'Proof of Export Sent to Winery', "Forwarder's invoice", "Forwarder's invoice received date for ACCT",
  'NAV INV #', 'Notes',
];
const letter = (i) => String.fromCharCode(65 + i);

/** A sheet with the tracker's headings on row 1 and one order per later row. */
function trackerSheet(rows, headings) {
  const heads = headings || HEADINGS;
  const header = { row: 1, columns: heads.map((h, i) => ({ col: letter(i), header: h })) };
  const sheet = {
    rows: new Map(),
    cell(r, c) { const rw = this.rows.get(r); return rw ? rw.cells.get(c) || null : null; },
    cellText(r, c) { const x = this.cell(r, c); return x ? x.text : ''; },
  };
  sheet.rows.set(1, { cells: new Map(heads.map((h, i) => [letter(i), { text: h, num: null }])) });
  rows.forEach((values, idx) => {
    const cells = new Map();
    for (const [heading, v] of Object.entries(values)) {
      const i = heads.indexOf(heading);
      if (i < 0) throw new Error('no heading ' + heading);
      const isDate = v instanceof Date;
      const num = isDate ? AMI.dateToSerial(v) : (typeof v === 'number' ? v : null);
      cells.set(letter(i), { text: isDate ? String(num) : String(v), num });
    }
    sheet.rows.set(idx + 2, { cells });
  });
  return { sheet, header };
}

const d = (m, day) => new Date(2026, m - 1, day);
const TODAY = d(8, 20);

/* One row per point in the workflow, each carrying only what that point records. */
const BASE = { 'PO#': '', 'Quantity (cs)': 336 };
const ROWS = [
  { ...BASE, 'PO#': 'R-1', 'PO Received Date': d(6, 1) },
  { ...BASE, 'PO#': 'S-1', 'PO Received Date': d(6, 1), 'PO date sent to winery': d(6, 2) },
  { ...BASE, 'PO#': 'C-1', 'PO date sent to winery': d(6, 2), 'Winery Confirmed Available Date': d(6, 20) },
  { ...BASE, 'PO#': 'L-1', 'PO date sent to winery': d(6, 2), 'Winery Confirmed Available Date': d(6, 20), 'Truck Type': 'Reefer' },
  { ...BASE, 'PO#': 'D-1', 'PO date sent to winery': d(6, 2), 'Bottling Date Confirmed': d(5, 30), 'Lot Number': 'L2605' },
  { ...BASE, 'PO#': 'D-2', 'PO date sent to winery': d(6, 2), 'Lot Number': 'L2605' },
  { ...BASE, 'PO#': 'X-1', 'PO date sent to winery': d(6, 2), 'Actual Collection Date from Cellars': d(7, 1) },
  { ...BASE, 'PO#': 'V-1', 'Actual Collection Date from Cellars': d(7, 1), 'Delivery date to CDG': d(7, 3) },
  { ...BASE, 'PO#': 'I-1', 'Delivery date to CDG': d(7, 3), 'NAV INV #': 415006 },
  {
    ...BASE, 'PO#': 'P-1', 'Delivery date to CDG': d(7, 3), 'NAV INV #': 415007,
    'Winery invoice received': 'yes', 'Proof of Export Sent to Winery': 'to fill',
    "Forwarder's invoice received date for ACCT": d(7, 20),
  },
  {
    ...BASE, 'PO#': 'Z-1', 'Delivery date to CDG': d(7, 3), 'NAV INV #': 415008,
    'Winery invoice received': 'yes', 'Proof of Export Sent to Winery': 'sent',
    "Forwarder's invoice received date for ACCT": d(7, 20),
  },
  {
    ...BASE, 'PO#': 'U-1', 'Winery invoice received': 'yes', 'Proof of Export Sent to Winery': 'sent',
    "Forwarder's invoice received date for ACCT": d(7, 20),
  },
  { ...BASE, 'PO#': 'N-1', 'Quantity (cs)': 48 },
];

const { sheet, header } = trackerSheet(ROWS);
const orders = AMI.readOrders(sheet, header, { accountId: 'am', itemId: 'ev', accountName: 'Aeromexico', itemName: 'Evidencia' });
const byPo = Object.fromEntries(orders.map((o) => [o.po, o]));
const derived = (po) => (byPo[po].derived ? byPo[po].derived.statusId : '');

console.log('\nThe workflow');
check('twelve stages, in the division\'s order', AMI.ORDER_STATUSES.map((s) => s.label), [
  'Purchase Order Received', 'Order Validation', 'Supplier PO Creation', 'Supply Confirmation',
  'Logistics Planning', 'Documentation Management', 'Pre-Shipment Review', 'Shipment Execution',
  'Delivery Confirmation', 'Customer Invoicing', 'Supplier Settlement', 'Order Closure & Reporting']);
check('in four phases', AMI.PHASES.map((p) => p.label + ':' + p.stages.length),
  ['Order intake:3', 'Supply & preparation:4', 'Shipment:2', 'Financial close:3']);
check('two stages are person checks', AMI.GATE_STATUSES.map((s) => s.label), ['Order Validation', 'Pre-Shipment Review']);
ok('and they have no tracker evidence to read', AMI.GATE_STATUSES.every((s) => !s.evidence));
check('one stage ends the order', AMI.ORDER_STATUSES.filter((s) => s.terminal).map((s) => s.label),
  ['Order Closure & Reporting']);
ok('every stage explains what completes it', AMI.ORDER_STATUSES.every((s) => s.hint && s.short && s.label));
check('next after delivery is invoicing', AMI.nextStatus('delivered').label, 'Customer Invoicing');
check('next after a person check is the stage after it', AMI.nextStatus('validated').label, 'Supplier PO Creation');
check('nothing follows closure', AMI.nextStatus('closed'), null);
check('a status set behind the tracker waits on the stage after the tracker',
  AMI.nextForOrder({ status: { statusId: 'validated', trackerStatusId: 'shipped' } }).label, 'Delivery Confirmation');
check('a status set ahead of the tracker waits on the stage after it',
  AMI.nextForOrder({ status: { statusId: 'pre-shipment', trackerStatusId: 'supply-confirmed' } }).label, 'Shipment Execution');
check('an order with no stage is waiting on the first', AMI.nextStatus('').label, 'Purchase Order Received');

console.log('\nEach stage read from the tracker column that records it');
check('PO received date', derived('R-1'), 'received');
check('PO sent to winery', derived('S-1'), 'supplier-po');
check('winery confirmed available', derived('C-1'), 'supply-confirmed');
check('truck type booked', derived('L-1'), 'logistics');
check('bottling date and lot number', derived('D-1'), 'documents');
check('a lot number alone is not documentation done', derived('D-2'), 'supplier-po');
check('actual collection', derived('X-1'), 'shipped');
check('delivery date', derived('V-1'), 'delivered');
check('NAV invoice', derived('I-1'), 'customer-invoiced');
check('"to fill" counts as blank, so settlement is not done', derived('P-1'), 'customer-invoiced');
check('invoiced and settled is closed', derived('Z-1'), 'closed');
check('settled without an invoice is not closed', derived('U-1'), 'settled');
check('a row with nothing but a PO number is not given a stage', derived('N-1'), '');

console.log('\nPerson checks are never inferred');
ok('no row derives a person check',
  orders.every((o) => !o.derived || !AMI.statusById(o.derived.statusId).gate));
ok('and no row has evidence for one', orders.every((o) => !o.evidence.validated && !o.evidence['pre-shipment']));
ok('a shipped order does not claim its pre-shipment review happened',
  !byPo['X-1'].evidence['pre-shipment'] && byPo['X-1'].derived.statusId === 'shipped');

console.log('\nEvidence names its cells');
check('closure cites every column behind it', byPo['Z-1'].evidence.closed.cells.map((c) => c.header), [
  'NAV INV #', 'Winery invoice received', 'Proof of Export Sent to Winery', "Forwarder's invoice received date for ACCT"]);
ok('dates in dated columns are read as dates', byPo['X-1'].evidence.shipped.cells[0].date instanceof Date);
ok('an invoice number is never read as a date', byPo['I-1'].evidence['customer-invoiced'].cells[0].date === null);

console.log('\nAn older sheet with fewer columns');
const older = HEADINGS.filter((h) => h !== 'Proof of Export Sent to Winery' && h !== 'Truck Type');
const oldSheet = trackerSheet([
  {
    'PO#': 'O-1', 'NAV INV #': 1, 'Winery invoice received': 'yes',
    "Forwarder's invoice received date for ACCT": d(7, 20),
  },
  { 'PO#': 'O-2', 'Winery Confirmed Available Date': d(6, 20) },
], older);
const oldOrders = AMI.readOrders(oldSheet.sheet, oldSheet.header, {});
check('settlement is judged on the columns the sheet has', oldOrders[0].derived.statusId, 'closed');
ok('a stage with no column on the sheet cannot be read from it',
  oldOrders.every((o) => !o.evidence.logistics), JSON.stringify(oldOrders[1].evidence));

console.log('\nWhat a person sets');
const doc = AMI.emptyStatusDoc();
AMI.setStatus(doc, byPo['S-1'].key, 'validated', 'Bo Price');
const behind = AMI.effectiveStatus(byPo['S-1'], doc);
check('a person check can be set', behind.statusId, 'validated');
check('and wins over the tracker', behind.source, 'set');
ok('but the tracker being further along is said, not hidden',
  behind.behindTracker && /the tracker already shows Supplier PO Creation/.test(behind.reason), behind.reason);

AMI.setStatus(doc, byPo['X-1'].key, 'pre-shipment', 'Bo Price');
const ahead = AMI.effectiveStatus(byPo['X-1'], doc);
ok('setting a check the tracker has already passed is flagged',
  ahead.behindTracker === true, ahead.reason);

AMI.setStatus(doc, byPo['C-1'].key, 'pre-shipment', 'Bo Price');
const gateSet = AMI.effectiveStatus(byPo['C-1'], doc);
ok('setting a check ahead of the tracker is not flagged', gateSet.behindTracker === false, gateSet.reason);

console.log('\nStatuses stored under the four-stage pipeline');
const legacy = AMI.emptyStatusDoc();
legacy.entries[byPo['I-1'].key] = { status: 'invoiced', updated: '2026-05-01T00:00:00.000Z', updatedBy: 'Bo Price' };
legacy.entries[byPo['R-1'].key] = { status: 'placed', updated: '2026-05-01T00:00:00.000Z', updatedBy: 'Bo Price' };
legacy.entries[byPo['V-1'].key] = { status: 'transit', updated: '2026-05-01T00:00:00.000Z', updatedBy: 'Bo Price' };
const li = AMI.effectiveStatus(byPo['I-1'], legacy);
check('"Invoiced and Closed" still means closed', li.statusId, 'closed');
ok('and the reason says where it came from', /“Invoiced and Closed” under the four-stage pipeline/.test(li.reason), li.reason);
check('"Order placed" is the supplier PO', AMI.effectiveStatus(byPo['R-1'], legacy).statusId, 'supplier-po');
check('"In transit" is shipment execution', AMI.effectiveStatus(byPo['V-1'], legacy).statusId, 'shipped');
check('a new write stores the new id', AMI.setStatus(AMI.emptyStatusDoc(), 'k', 'transit', 'X').entries.k.status, 'shipped');

console.log('\nThe trail through all twelve stages');
const plain = AMI.decorate(orders, AMI.emptyStatusDoc(), TODAY);
const plainBy = Object.fromEntries(plain.map((o) => [o.po, o]));
const states = (o) => AMI.stageTrail(o).map((t) => t.state[0]).join('');
check('a shipped order: what is recorded, what is not, what is ahead',
  states(plainBy['X-1']), 'uuduuuudpppp');
check('a person check behind the current stage is unrecorded, never done',
  AMI.stageTrail(plainBy['X-1']).filter((t) => t.status.gate).map((t) => t.state), ['unrecorded', 'unrecorded']);
ok('and says why', /no tracker column/.test(AMI.stageTrail(plainBy['X-1'])[1].detail));
const setOrders = AMI.decorate(orders, doc, TODAY);
const setBy = Object.fromEntries(setOrders.map((o) => [o.po, o]));
check('a person-set check shows as the current stage', states(setBy['C-1']), 'uudduucppppp');
ok('done stages quote the tracker', /Winery Confirmed Available Date: /.test(AMI.stageTrail(plainBy['C-1'])[3].detail));
check('a closed order is done throughout where the tracker shows it',
  states(plainBy['Z-1']), 'uuuuuuuudddd');

console.log('\nOpen and closed');
const finished = plain.filter((o) => !o.isOpen).map((o) => o.po).sort().join();
ok('an order is closed once it is invoiced, settled or not', finished === 'I-1,P-1,Z-1', finished);
ok('settlement columns without an invoice do not close an order', plainBy['U-1'].isOpen && plainBy['U-1'].evidence.settled);
ok('an order that has not been invoiced is open', ['R-1', 'S-1', 'X-1', 'V-1'].every((po) => plainBy[po].isOpen));
const invoicedByHand = AMI.decorate(orders, { entries: { [plainBy['X-1'].key]: { status: 'customer-invoiced', updated: '2026-08-01T00:00:00.000Z', updatedBy: 'Bo' } } }, TODAY)
  .find((o) => o.po === 'X-1');
ok('one a person marks invoiced is closed too', invoicedByHand.isOpen === false);
const reopened = AMI.decorate(orders, { entries: { [plainBy['I-1'].key]: { status: 'delivered', updated: '2026-08-01T00:00:00.000Z', updatedBy: 'Bo' } } }, TODAY)
  .find((o) => o.po === 'I-1');
ok('and setting an earlier stage reopens it', reopened.isOpen === true);
check('the closing stages are invoicing, settlement and closure',
  AMI.ORDER_STATUSES.filter((s) => !s.open).map((s) => s.id), ['customer-invoiced', 'settled', 'closed']);
const counts = AMI.countByStatus(plain);
check('counts cover every stage plus unset', Object.keys(counts).length, 13);
check('and add up', Object.values(counts).reduce((a, b) => a + b, 0), orders.length);
const phases = AMI.countByPhase(plain);
check('phase counts add up too', Object.values(phases).reduce((a, b) => a + b, 0), orders.length);
check('by phase', phases, { unset: 1, intake: 3, supply: 3, shipment: 2, close: 4 });

console.log('\nFollow-ups belong to stages');
ok('every rule names a real stage', AMI.FOLLOW_UP_RULES.every((r) => AMI.statusById(r.stage)));
const chaseSheet = trackerSheet([
  { 'PO#': 'F-1', 'Actual Collection Date from Cellars': d(6, 1), 'Delivery date to CDG': d(6, 3), 'NAV INV #': 9 },
]);
const chases = AMI.findOpenItems(chaseSheet.sheet, chaseSheet.header, TODAY);
const live = chases.filter((c) => !c.superseded).map((c) => c.ruleId).sort();
check('after the customer invoice, settlement is still chased',
  live, ['forwarder-invoice', 'proof-of-export', 'winery-invoice']);
ok('each chase carries its stage', chases.every((c) => AMI.statusById(c.stage)));
const loggedSheet = trackerSheet([{
  'PO#': 'F-2', 'Delivery date to CDG': d(6, 3), 'NAV INV #': 10,
  "Forwarder's invoice received date for ACCT": d(7, 1),
}]);
const logged = AMI.findOpenItems(loggedSheet.sheet, loggedSheet.header, TODAY)
  .find((c) => c.ruleId === 'forwarder-invoice');
ok('a forwarder invoice logged as received for accounts is not chased',
  logged && logged.superseded && /forwarder's invoice received date/i.test(logged.supersededReason),
  logged && logged.supersededReason);
ok('and the lot number, a documentation item, is set aside by the invoice',
  chases.some((c) => c.ruleId === 'lot-number' && c.superseded));

console.log('\nAccount summary');
const summary = AMI.buildAccountSummary({ accountName: 'Aeromexico', orders: plain, today: TODAY, openOnly: false });
ok('lists all twelve stages', AMI.ORDER_STATUSES.every((s) => summary.html.includes(s.step + '. ' + AMI.escapeXml(s.label))));
ok('marks the person checks', (summary.html.match(/\(person check\)/g) || []).length === 2);
ok('and gives each order its next stage', /Next stage/.test(summary.html) && /10\. Customer Invoicing/.test(summary.html));

console.log('\nFills');
ok('stages share their phase fill', AMI.ORDER_STATUSES.every((s) => s.fill === AMI.phaseById(s.phase).fill));
ok('a pill is numbered and painted by phase',
  /stage-fill stage-4/.test(AMI.statusPill(AMI.statusById('settled'))) && /11\. Supplier Settlement/.test(AMI.statusPill(AMI.statusById('settled'))));
const legend = AMI.statusLegend(AMI.PHASES, phases);
ok('the phase legend names each weave',
  ['solid', 'diagonal stripes', 'horizontal stripes', 'vertical stripes'].every((w) => legend.includes(w)));

console.log('\n' + '-'.repeat(52));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
