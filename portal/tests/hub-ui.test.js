/* Browser test for the hub-style pages: My Work, Tasks, Exceptions, Shipments,
 * the order drawer, search, and what a read-only person can and cannot do.
 *
 *   node portal/tests/hub-ui.test.js
 *
 * Needs no fixtures. The tracker is built in memory, with the real headings,
 * and loaded into the built HTML over file://.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
require('../src/engine.js');
require('../src/templates.js');
const AMI = require('../src/workspace.js');

const PORTAL = path.join(__dirname, '..', 'AMI-Order-Desk-Teams.html');
const ENC = new TextEncoder();

let passed = 0, failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { failed++; failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : '')); }
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const L = (i) => String.fromCharCode(65 + i);
const serial = (date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000) + 25569;
/** A date relative to the day the test runs, so "overdue" stays overdue. */
const rel = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return serial(d); };

const HEAD = ['PO#', 'Quantity (bt)', 'Quantity (cs)', 'Quantity (pallets)', 'Bottling Date Confirmed', 'Lot Number', 'Ship To',
  'PO Received Date', 'ORDERS MUST BE SEND TO WINERY PRIOR TO', 'PO date sent to winery', 'AMI Requested Collection Date',
  'Winery Confirmed Available Date', 'Actual Collection Date from Cellars', 'Delivery date to CDG', 'Customer Required Delivery Date',
  'Method of Shipment', 'Forwarder', 'Truck Type', 'Balance on Contract (bt)', 'Balance on Contract (cs)', 'Winery invoice received',
  'Proof of Export Sent to Winery', "Forwarder's invoice", "Forwarder's invoice received date for ACCT", 'NAV INV #', 'Notes'];

const ROWS = [
  { 'PO#': 'T-100', 'Quantity (cs)': 336, 'PO Received Date': rel(-10) },
  { 'PO#': 'T-200', 'Quantity (cs)': 336, 'PO Received Date': rel(-30), 'PO date sent to winery': rel(-28), 'Winery Confirmed Available Date': rel(-20),
    'AMI Requested Collection Date': rel(-6), 'Customer Required Delivery Date': rel(-4), 'Truck Type': 'Reefer' },
  { 'PO#': 'T-300', 'Quantity (cs)': 288, 'PO date sent to winery': rel(-40), 'Actual Collection Date from Cellars': rel(-20),
    'AMI Requested Collection Date': rel(-22), 'Delivery date to CDG': rel(-15) },
  { 'PO#': 'T-350', 'Quantity (cs)': 144, 'PO date sent to winery': rel(-60), 'Actual Collection Date from Cellars': rel(-45),
    'Delivery date to CDG': rel(-40), 'NAV INV #': 416001, 'Winery invoice received': 'yes' },
  { 'PO#': 'T-400', 'Quantity (cs)': 288, 'PO Received Date': rel(-5), 'PO date sent to winery': rel(-4),
    'AMI Requested Collection Date': rel(20), 'Customer Required Delivery Date': rel(22) },
];

const cell = (ref, v) => (typeof v === 'number' ? '<c r="' + ref + '"><v>' + v + '</v></c>' : '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(v) + '</t></is></c>');

async function buildBundle() {
  let rows = '<row r="2">' + cell('B2', 'Product Name:') + cell('C2', 'Test Tempranillo') + '</row>'
    + '<row r="7">' + cell('B7', 'NAV Code:') + cell('C7', 'TESTTMP') + '</row>'
    + '<row r="10">' + HEAD.map((h, i) => cell(L(i) + '10', h)).join('') + '</row>';
  ROWS.forEach((r, i) => {
    const n = 11 + i;
    rows += '<row r="' + n + '">' + HEAD.map((h, j) => (h in r ? cell(L(j) + n, r[h]) : '')).join('') + '</row>';
  });
  const xlsx = await AMI.zip([
    { name: '[Content_Types].xml', bytes: ENC.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'xl/workbook.xml', bytes: ENC.encode('<workbook xmlns:r="r"><sheets><sheet name="2026 Cycle" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', bytes: ENC.encode('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', bytes: ENC.encode('<worksheet><sheetData>' + rows + '</sheetData></worksheet>') },
  ]);
  const workspace = {
    version: 1, updated: new Date().toISOString(), divisions: [{ id: 'eu', name: 'Europe' }],
    accounts: [{ id: 'acc', name: 'Test Airline', divisionId: 'eu', contacts: { vendor: {}, trucker: {}, customer: {}, internal: {} },
      items: [{ id: 'tmp', name: 'Test Tempranillo', trackerPath: 'trackers/Test.xlsx', sheet: '2026 Cycle' }] }],
    users: [
      { id: 'boss', name: 'Ada Admin', divisionId: 'eu', accountIds: [], isAdmin: true },
      { id: 'desk', name: 'Dan Desk', divisionId: 'eu', accountIds: [] },
      { id: 'look', name: 'Vera Viewer', divisionId: 'eu', accountIds: [], role: 'viewer' },
    ],
  };
  return AMI.zip([
    { name: 'workspace.json', bytes: ENC.encode(JSON.stringify(workspace)) },
    { name: 'trackers/Test.xlsx', bytes: xlsx },
  ]);
}

(async () => {
  const bundlePath = path.join(os.tmpdir(), 'ami-hub-ui-' + process.pid + '.zip');
  fs.writeFileSync(bundlePath, Buffer.from(await buildBundle()));

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const wait = (ms) => page.waitForTimeout(ms || 500);
  const go = async (tab) => { await page.locator('#rail [data-tab="' + tab + '"]').click(); await wait(900); };

  console.log('Shell');
  await page.goto('file://' + PORTAL);
  ok('a rail, a top bar and a search box', (await page.locator('#rail').count()) === 1 && (await page.locator('#globalSearch').count()) === 1);
  ok('work pages are off until someone is chosen', await page.locator('#rail [data-tab="mywork"]').isDisabled());

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#workspaceBody button', { hasText: 'Load a workspace bundle' }).click(),
  ]);
  await chooser.setFiles(bundlePath);
  await page.waitForSelector('#contextBar .context-row', { timeout: 15000 });
  await page.locator('#meSlot select').selectOption('boss');
  await wait(1500);
  ok('the work pages open once someone is chosen', !(await page.locator('#rail [data-tab="mywork"]').isDisabled()));

  console.log('\nMy Work');
  await go('mywork');
  const work = await page.locator('#myworkBody').innerText();
  ok('greets by first name', /Ada\./.test(work));
  ok('lists the missed collection as an exception', /Collection overdue/.test(work));
  ok('and the milestones come from the tracker', /Upcoming milestones/.test(work));
  ok('the rail badge counts high or critical exceptions', Number(await page.locator('[data-badge="exceptions"]').innerText()) >= 2);

  console.log('\nExceptions');
  await go('exceptions');
  const exc = await page.locator('#exceptionsBody').innerText();
  ok('flags the missed collection and delivery', /Collection overdue/.test(exc) && /Delivery overdue/.test(exc));
  ok('says they come from tracker dates', /from tracker dates/.test(exc));
  await page.locator('#exceptionsBody .wk-item button', { hasText: 'Acknowledge' }).first().click();
  await wait(800);
  ok('an exception can be acknowledged', /Acknowledged/.test(await page.locator('#exceptionsBody').innerText()));

  console.log('\nTasks');
  await go('tasks');
  await page.locator('#tasksBody .chip-filter', { hasText: 'All open' }).click();
  await wait(500);
  const before = await page.locator('#tasksBody .tsk').count();
  ok('every open order has its stage\'s checklist', before >= 8, String(before));
  await page.locator('#tasksBody .tsk-box').first().click();
  await wait(700);
  ok('ticking a step takes it off the open list', (await page.locator('#tasksBody .tsk').count()) === before - 1);

  console.log('\nInvoiced archive');
  await go('orderstatus');
  const openList = await page.locator('#orderStatusBody table.data').first().innerText();
  ok('an invoiced order is not on the open Orders list', !/T-350/.test(openList) && /T-200/.test(openList));
  ok('which says how many have moved', /Invoiced archive \(1\)/.test(await page.locator('#orderStatusBody').innerText()));
  await page.locator('#orderStatusBody button', { hasText: 'Invoiced archive' }).click();
  await wait(900);
  const inv = await page.locator('#invoicedBody').innerText();
  ok('it is in the archive', /T-350/.test(inv) && !/T-200/.test(inv));
  ok('with its NAV invoice number and what is still blank', /416001/.test(inv) && /Waiting on 2/.test(inv));
  await go('dashboard');
  await wait(1200);
  const dash = await page.locator('#dashboardBody').innerText();
  ok('an invoiced order is not on the dashboard', !/T-350/.test(dash) && /T-200/.test(dash) && (await page.locator('#dashboardBody .kan-card').allInnerTexts()).every((t) => !/T-350/.test(t)));
  await go('followups');
  ok('nor in the follow-ups', !/T-350/.test(await page.locator('#followBody').innerText()));
  await go('tasks');
  await page.locator('#tasksBody .chip-filter', { hasText: 'All open' }).click();
  await wait(400);
  ok('and none of its steps are on the open task list', !/T-350/.test(await page.locator('#tasksBody').innerText()));

  console.log('\nShipments');
  await go('shipments');
  const ship = await page.locator('#shipmentsBody').innerText();
  ok('shows the truck type from the tracker', /Reefer/.test(ship));
  ok('and counts what is overdue', /overdue/i.test(ship));

  console.log('\nOrder drawer');
  await go('orderstatus');
  await page.locator('#orderStatusBody table.data tbody tr button.wk-link', { hasText: 'T-200' }).click();
  await page.waitForSelector('#drawer .dr-body');
  await wait(300);
  ok('opens on the order', /PO T-200/.test(await page.locator('#drawer .dr-head').innerText()));
  ok('draws all twelve stages in four phases', (await page.locator('#drawer .wf-step').count()) === 12 && (await page.locator('#drawer .wf-phase').count()) === 4);
  ok('marks the two person checks', (await page.locator('#drawer .wf-step.gate').count()) === 2);
  ok('shows the tracker\'s own dates', /Collection asked/i.test(await page.locator('#drawer').innerText()));
  await page.locator('#drawer .tsk-add input').fill('Call the forwarder');
  await page.locator('#drawer .tsk-add button').click();
  await wait(700);
  ok('a task can be added', /Call the forwarder/.test(await page.locator('#drawer').innerText()));
  await page.locator('#drawer button', { hasText: '+ Raise exception' }).click();
  await wait(300);
  await page.locator('.overlay input[type="text"]').fill('Pallet count disputed');
  await page.locator('.overlay button', { hasText: 'Raise exception' }).click();
  await wait(900);
  ok('an exception can be raised by hand', /Pallet count disputed/.test(await page.locator('#drawer').innerText()));
  await page.locator('#drawer button', { hasText: /Mark .* complete/ }).click();
  await wait(900);
  ok('a stage can be marked complete', /Documentation Management/.test(await page.locator('#drawer .dr-head').innerText()) && /Delivery|Shipment|Pre-Shipment/.test(await page.locator('#drawer .kv').first().innerText()));
  ok('and every action is in the activity log', (await page.locator('#drawer .activity-row').count()) >= 3);
  await page.keyboard.press('Escape');
  await wait(200);
  ok('Escape closes it', await page.locator('#drawer').isHidden());

  console.log('\nSearch');
  await page.locator('#globalSearch').fill('T-3');
  await wait(500);
  ok('finds an order by PO', /T-300/.test(await page.locator('#globalResults').innerText()));
  await page.locator('#globalResults button').first().click();
  await page.waitForSelector('#drawer .dr-body');
  ok('and opens it', /PO T-300/.test(await page.locator('#drawer .dr-head').innerText()));
  await page.keyboard.press('Escape');

  console.log('\nPermissions');
  await page.locator('#meSlot select').selectOption('look');
  await wait(1500);
  await go('orderstatus');
  await page.locator('#orderStatusBody table.data tbody tr button.wk-link', { hasText: 'T-200' }).click();
  await page.waitForSelector('#drawer .dr-body');
  ok('a viewer cannot tick a step', await page.locator('#drawer .tsk-box').first().isDisabled());
  ok('or move an order on', await page.locator('#drawer button', { hasText: /Mark .* complete/ }).isDisabled());
  ok('or raise an exception', await page.locator('#drawer button', { hasText: '+ Raise exception' }).isDisabled());
  await page.keyboard.press('Escape');
  await go('accounts');
  ok('or change accounts and people', (await page.locator('#accountsBody button', { hasText: /^(Add|Edit)/ }).count()) === 0);

  await page.locator('#meSlot select').selectOption('desk');
  await wait(1500);
  await go('accounts');
  ok('an order-desk user cannot change accounts either', (await page.locator('#accountsBody button', { hasText: /^(Add|Edit)/ }).count()) === 0);
  await go('orderstatus');
  await page.locator('#orderStatusBody table.data tbody tr button.wk-link', { hasText: 'T-200' }).click();
  await page.waitForSelector('#drawer .dr-body');
  ok('but can work orders', !(await page.locator('#drawer .tsk-box').first().isDisabled()));
  await page.keyboard.press('Escape');

  await page.locator('#meSlot select').selectOption('boss');
  await wait(1500);
  await go('accounts');
  await page.locator('#accountsBody tr', { hasText: 'Dan Desk' }).locator('button', { hasText: 'Edit' }).click();
  await wait(400);
  ok('an administrator can edit a person\'s role and permissions',
    (await page.locator('#entityEditor select option').count()) >= 4 && (await page.locator('#entityEditor input[data-permission]').count()) === 8);
  await page.locator('#entityEditor select').nth(1).selectOption('viewer');
  await wait(200);
  const boxes = await page.locator('#entityEditor input[data-permission]').evaluateAll((els) => els.map((e) => e.checked));
  ok('choosing Viewer clears the permissions', boxes.every((c) => !c));

  console.log('\nPhone width');
  await page.setViewportSize({ width: 420, height: 860 });
  await go('mywork');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('nothing scrolls sideways', overflow <= 1, 'overflow ' + overflow);

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.unlinkSync(bundlePath);

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
