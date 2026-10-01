/* Tests for the stage checklists, exceptions, shipments and permissions.
 *
 *   node portal/tests/orderwork.test.js
 *
 * Needs no fixtures: the tracker is built in memory with the real headings.
 */
require('../src/engine.js');
require('../src/workspace.js');
require('../src/status.js');
require('../src/charts.js');
const AMI = require('../src/orderwork.js');

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

function trackerSheet(rows) {
  const header = { row: 1, columns: HEADINGS.map((h, i) => ({ col: letter(i), header: h })) };
  const sheet = {
    rows: new Map(),
    cell(r, c) { const rw = this.rows.get(r); return rw ? rw.cells.get(c) || null : null; },
    cellText(r, c) { const x = this.cell(r, c); return x ? x.text : ''; },
  };
  sheet.rows.set(1, { cells: new Map(HEADINGS.map((h, i) => [letter(i), { text: h, num: null }])) });
  rows.forEach((values, idx) => {
    const cells = new Map();
    for (const [heading, v] of Object.entries(values)) {
      const i = HEADINGS.indexOf(heading);
      const isDate = v instanceof Date;
      const num = isDate ? AMI.dateToSerial(v) : (typeof v === 'number' ? v : null);
      cells.set(letter(i), { text: isDate ? String(num) : String(v), num });
    }
    sheet.rows.set(idx + 2, { cells });
  });
  return { sheet, header };
}

const d = (m, day) => new Date(2026, m - 1, day);
const TODAY = d(10, 1);
const ctx = { accountId: 'acc', accountName: 'Acc', itemId: 'it', itemName: 'Item', today: TODAY };

function load(rows, statusEntries) {
  const { sheet, header } = trackerSheet(rows);
  const orders = AMI.readOrders(sheet, header, ctx);
  const followUps = AMI.findOpenItems(sheet, header, TODAY);
  const doc = { version: 1, entries: statusEntries || {} };
  const decorated = AMI.withSchedule(AMI.decorate(orders, doc, TODAY), TODAY);
  for (const o of decorated) o.followUps = followUps.filter((f) => f.row === o.row);
  return Object.fromEntries(decorated.map((o) => [o.po, o]));
}

const memoryStore = () => {
  const files = new Map();
  return {
    files,
    async read(p) { return files.has(p) ? files.get(p) : null; },
    async write(p, b) { files.set(p, b); },
  };
};

(async () => {
  console.log('Checklist');
  const O = load([
    { 'PO#': 'A-1', 'Quantity (cs)': 100 },
    { 'PO#': 'B-1', 'PO Received Date': d(9, 1), 'PO date sent to winery': d(9, 2), 'Winery Confirmed Available Date': d(9, 10),
      'AMI Requested Collection Date': d(10, 8), 'Customer Required Delivery Date': d(10, 12) },
    { 'PO#': 'C-1', 'PO Received Date': d(8, 1), 'PO date sent to winery': d(8, 2), 'Winery Confirmed Available Date': d(8, 10),
      'AMI Requested Collection Date': d(9, 25), 'Customer Required Delivery Date': d(9, 27), 'Truck Type': 'Reefer' },
  ]);
  const doc = AMI.emptyWorkDoc();
  const a = AMI.tasksFor(O['A-1'], doc, TODAY);
  check('an order with nothing recorded works on the first stage', a.stage.id, 'received');
  check('and shows that stage\'s standard steps', a.current.length, AMI.STAGE_TASKS.received.length);
  ok('none of them is ticked or dated', a.current.every((t) => !t.done && !t.due));

  const b = AMI.tasksFor(O['B-1'], doc, TODAY);
  check('an order the winery has confirmed is working on Logistics Planning', b.stage.id, 'logistics');
  const sched = b.current.find((t) => /Schedule collection/.test(t.title));
  ok('a logistics step is due three days before the requested collection', sched.due && sched.due.getTime() === d(10, 5).getTime(), String(sched.due));
  ok('and says where that date came from', /3 days before the requested collection date/.test(sched.dueSource));

  AMI.setTaskDone(doc, O['B-1'], sched.id, true, 'Bo');
  const b2 = AMI.tasksFor(O['B-1'], doc, TODAY);
  ok('ticking records who and when', b2.current.find((t) => t.id === sched.id).done && b2.current.find((t) => t.id === sched.id).doneBy === 'Bo');
  ok('the tracker moving on never ticks anything', AMI.tasksFor(O['C-1'], doc, TODAY).all.every((t) => !t.done));
  AMI.setTaskDone(doc, O['B-1'], sched.id, false, 'Bo');
  ok('a step can be reopened', !AMI.tasksFor(O['B-1'], doc, TODAY).current.find((t) => t.id === sched.id).done);

  AMI.setTaskField(doc, O['B-1'], sched.id, 'due', '2026-10-02', 'Bo');
  const moved = AMI.tasksFor(O['B-1'], doc, TODAY).current.find((t) => t.id === sched.id);
  ok('a person can set a due date, and it is credited to them', moved.due.getTime() === d(10, 2).getTime() && /Bo/.test(moved.dueSource));

  const added = AMI.addCustomTask(doc, O['B-1'], { title: 'Chase pallet labels' }, 'Bo');
  ok('an added task sits on the current stage', AMI.tasksFor(O['B-1'], doc, TODAY).current.some((t) => t.id === added.id && t.custom));
  let threw = false;
  try { AMI.addCustomTask(doc, O['B-1'], { title: '  ' }, 'Bo'); } catch (e) { threw = true; }
  ok('a task needs a title', threw);
  AMI.removeCustomTask(doc, O['B-1'], added.id, 'Bo');
  ok('a removed task disappears', !AMI.tasksFor(O['B-1'], doc, TODAY).all.some((t) => t.id === added.id));
  ok('every action is logged with who', AMI.activityFor(doc, O['B-1'].key).every((x) => x.who === 'Bo') && AMI.activityFor(doc, O['B-1'].key).length >= 5);

  console.log('\nExceptions');
  const c = AMI.exceptionsFor(O['C-1'], doc, { followUps: O['C-1'].followUps, now: TODAY });
  const codes = c.map((x) => x.code);
  ok('a missed collection date is flagged', codes.includes('COLLECTION_OVERDUE'));
  ok('so is a missed delivery date', codes.includes('DELIVERY_OVERDUE'));
  ok('and each says which dates produced it', /9\/25\/2026|Sep 25|25 Sep|2026/.test(c.find((x) => x.code === 'COLLECTION_OVERDUE').title) && /6 days/.test(c.find((x) => x.code === 'COLLECTION_OVERDUE').title));
  ok('they come from tracker dates, not from a person', c.filter((x) => x.auto).every((x) => x.raisedBy === 'Tracker dates'));
  check('nothing is flagged on an order with no dates', AMI.exceptionsFor(O['A-1'], doc, { now: TODAY }), []);
  ok('a collection still ahead is not an exception', !AMI.exceptionsFor(O['B-1'], doc, { followUps: O['B-1'].followUps, now: TODAY }).some((x) => x.code === 'COLLECTION_OVERDUE'));

  const exc = c.find((x) => x.code === 'COLLECTION_OVERDUE');
  AMI.setExceptionState(doc, O['C-1'], exc, 'Acknowledged', {}, 'Bo');
  ok('an automatic one can be acknowledged', AMI.exceptionsFor(O['C-1'], doc, { now: TODAY }).find((x) => x.id === exc.id).status === 'Acknowledged');
  threw = false;
  try { AMI.setExceptionState(doc, O['C-1'], exc, 'Resolved', {}, 'Bo'); } catch (e) { threw = true; }
  ok('resolving needs an answer', threw);
  AMI.setExceptionState(doc, O['C-1'], exc, 'Resolved', { resolution: 'Tracker corrected', rootCause: 'Data quality' }, 'Bo');
  const resolved = AMI.exceptionsFor(O['C-1'], doc, { now: TODAY }).find((x) => x.id === exc.id);
  ok('resolved keeps the answer', resolved.status === 'Resolved' && resolved.resolution === 'Tracker corrected' && resolved.rootCause === 'Data quality');
  ok('and is no longer open', !AMI.isOpenException(resolved));

  const raised = AMI.raiseException(doc, O['A-1'], { title: 'Customer changed destination', severity: 'High' }, 'Bo');
  const rl = AMI.exceptionsFor(O['A-1'], doc, { now: TODAY });
  ok('a person can raise one by hand', rl.length === 1 && rl[0].id === raised.id && !rl[0].auto && rl[0].raisedBy === 'Bo' && rl[0].severity === 'High');

  const clearedOrder = load([{ 'PO#': 'K-1', 'PO Received Date': d(8, 1), 'AMI Requested Collection Date': d(9, 25), 'Actual Collection Date from Cellars': d(9, 28) }])['K-1'];
  const priorDoc = AMI.emptyWorkDoc();
  AMI.setExceptionState(priorDoc, clearedOrder, { id: 'auto-COLLECTION_OVERDUE', title: 'Collection overdue', severity: 'High', auto: true }, 'Acknowledged', {}, 'Bo');
  const cleared = AMI.exceptionsFor(clearedOrder, priorDoc, { now: TODAY });
  ok('one whose cause has gone reads Cleared instead of vanishing', cleared.length === 1 && cleared[0].status === 'Cleared');

  const closed = load([{ 'PO#': 'Z-1', 'Delivery date to CDG': d(7, 3), 'NAV INV #': 415008, 'Winery invoice received': 'yes',
    'Proof of Export Sent to Winery': 'sent', "Forwarder's invoice received date for ACCT": d(7, 20), 'AMI Requested Collection Date': d(6, 1) }])['Z-1'];
  check('a closed order raises nothing', AMI.detectExceptions(closed, { now: TODAY }), []);

  const inv = load([{ 'PO#': 'N-1', 'Actual Collection Date from Cellars': d(9, 1), 'Delivery date to CDG': d(9, 10) }])['N-1'];
  ok('a delivery with no invoice number is flagged after three days', AMI.detectExceptions(inv, { now: TODAY }).some((x) => x.code === 'INVOICE_OVERDUE'));

  console.log('\nShipments');
  const s = AMI.shipmentLine(O['C-1']);
  check('an uncollected order with a requested date is awaiting collection', s.status.id, 'awaiting');
  check('the truck type is the tracker\'s own', s.truck, 'Reefer');
  ok('overdue dates carry their day count', s.collectionOverdue && s.collectionOverdue.days === 6);
  check('no collection date means just that', AMI.shipmentLine(O['A-1']).status.id, 'unscheduled');
  check('a delivery date means delivered', AMI.shipmentLine(closed).status.id, 'delivered');

  console.log('\nSaving');
  const store = memoryStore();
  const mine = AMI.emptyWorkDoc();
  AMI.setTaskDone(mine, O['B-1'], 'logistics:schedule-collection', true, 'Bo');
  await AMI.saveWork(store, mine, { by: 'Bo' });
  const theirs = await AMI.loadWork(store);
  ok('work round-trips through the folder', theirs.orders[O['B-1'].key].tasks['logistics:schedule-collection'].done === true);

  // Two people, working at once from the same starting point.
  const bo = await AMI.loadWork(store);
  const vera = await AMI.loadWork(store);
  AMI.setTaskDone(bo, O['B-1'], 'logistics:confirm-booking-and-eta', true, 'Bo');
  AMI.raiseException(vera, O['B-1'], { title: 'Booking not confirmed', severity: 'Medium' }, 'Vera');
  AMI.setTaskDone(vera, O['C-1'], 'logistics:schedule-collection', true, 'Vera');
  await AMI.saveWork(store, bo, { by: 'Bo' });
  await AMI.saveWork(store, vera, { by: 'Vera' });
  const merged = await AMI.loadWork(store);
  const mb = merged.orders[O['B-1'].key];
  ok('both people\'s ticks survive a simultaneous save',
    mb.tasks['logistics:schedule-collection'].done && mb.tasks['logistics:confirm-booking-and-eta'].done);
  ok('and so does an exception raised alongside', mb.raised.length === 1 && mb.raised[0].raisedBy === 'Vera');
  ok('and work on a different order', merged.orders[O['C-1'].key].tasks['logistics:schedule-collection'].done);
  ok('the activity log keeps both', mb.activity.some((x) => x.who === 'Bo') && mb.activity.some((x) => x.who === 'Vera'));

  const later = await AMI.loadWork(store);
  AMI.setTaskDone(later, O['B-1'], 'logistics:schedule-collection', false, 'Bo');
  await new Promise((r) => setTimeout(r, 5));
  await AMI.saveWork(store, later, { by: 'Bo' });
  ok('the later of two edits to one step wins',
    !(await AMI.loadWork(store)).orders[O['B-1'].key].tasks['logistics:schedule-collection'].done);

  const bad = memoryStore();
  await bad.write(AMI.WORK_PATH, new TextEncoder().encode('{nope'));
  let msg = '';
  try { await AMI.loadWork(bad); } catch (e) { msg = e.message; }
  ok('a damaged file is reported by name', /order-work\.json/.test(msg));

  console.log('\nRoles and permissions');
  const ws = AMI.normaliseWorkspace({
    users: [
      { id: 'bo', name: 'Bo', isAdmin: true },
      { id: 'ann', name: 'Ann' },
      { id: 'fin', name: 'Fin', role: 'finance' },
      { id: 'vi', name: 'Vi', role: 'viewer' },
      { id: 'cus', name: 'Cus', role: 'coordinator', permissions: { sendEmails: false, editAccounts: true } },
    ],
  });
  const role = (id) => ws.users.find((u) => u.id === id).role;
  check('a saved administrator stays one', role('bo'), 'admin');
  check('a saved member becomes an order-desk user', role('ann'), 'coordinator');
  ok('an administrator can do everything', AMI.PERMISSIONS.every((p) => AMI.userCan(ws, 'bo', p.id)));
  ok('an order-desk user can post but not change accounts or people',
    AMI.userCan(ws, 'ann', 'postOrders') && !AMI.userCan(ws, 'ann', 'editAccounts') && !AMI.userCan(ws, 'ann', 'manageUsers'));
  ok('finance can change stages but not post to trackers', AMI.userCan(ws, 'fin', 'setStatus') && !AMI.userCan(ws, 'fin', 'postOrders'));
  ok('a viewer can do nothing', AMI.PERMISSIONS.every((p) => !AMI.userCan(ws, 'vi', p.id)));
  ok('an administrator can tailor one person', !AMI.userCan(ws, 'cus', 'sendEmails') && AMI.userCan(ws, 'cus', 'editAccounts'));
  ok('someone unknown can do nothing', !AMI.userCan(ws, 'nobody', 'setStatus'));
  ok('an empty workspace lets the first person set it up', AMI.userCan(AMI.normaliseWorkspace({}), '', 'manageUsers'));
  const again = AMI.normaliseWorkspace(JSON.parse(JSON.stringify(ws)));
  check('normalising twice changes nothing', again.users, ws.users);

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})();
