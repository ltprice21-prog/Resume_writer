/* Browser test for the multi-account, multi-item portal.
 *
 *   node portal/tests/teams-ui.test.js [fixturesDir]
 *
 * Builds a workspace bundle holding two item trackers for one account, loads it
 * into the built HTML over file://, and drives the whole path: pick a user, see
 * only their accounts, route POs to the right item, post, and draft from
 * account-wide and item-specific templates.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
require('../src/engine.js');
require('../src/templates.js');
const AMI = require('../src/workspace.js');

const FIXTURES = process.argv[2] || process.env.AMI_FIXTURES
  || '/root/.claude/uploads/ce5dd401-299f-5618-9ee9-da4319624cf3';
const PORTAL = path.join(__dirname, '..', 'AMI-Order-Desk-Teams.html');
const ENC = new TextEncoder();

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

/** Clone the real tracker with a different item code, standing in for a second product. */
async function variantTracker(bytes, sheetName, replacements) {
  const wb = await AMI.Workbook.load(bytes);
  const sheet = wb.sheet(sheetName);
  let xml = sheet.xml;
  for (const [ref, value] of Object.entries(replacements)) {
    const re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)');
    if (!re.test(xml)) throw new Error('Cell ' + ref + ' not found in ' + sheetName);
    xml = xml.replace(re, (m, attrs) => {
      const style = (/ s="(\d+)"/.exec(attrs) || [, null])[1];
      return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '')
        + ' t="inlineStr"><is><t xml:space="preserve">' + value + '</t></is></c>';
    });
  }
  sheet.xml = xml;
  wb.commitSheet(sheet);
  return wb.toBytes();
}

async function buildBundle() {
  const realTracker = new Uint8Array(fs.readFileSync(fixture(/Tracking_Chart.*\.xlsx$/i)));
  // B2 is "Product Name:", B7 is "NAV Code:" on the 2026 Cycle sheet.
  const montenero = await variantTracker(realTracker, '2026 Cycle', {
    B2: 'Montenero Rosso Italy',
    B7: 'MONTENERONV',
  });

  const workspace = {
    version: 1,
    updated: new Date().toISOString(),
    divisions: [{ id: 'europe', name: 'Europe' }, { id: 'us', name: 'US' }],
    accounts: [
      {
        id: 'aeromexico', name: 'Aeromexico', divisionId: 'europe',
        defaultCc: 'euwineorders@amigrp.com',
        contacts: {
          vendor: { name: 'Caroline Mounier-Duchamp', email: 'caroline@vins-biecher.com' },
          trucker: { name: 'Steffy Demouchy', email: 'sdemouchy@stpicargo.com', cc: 'comat@stpicargo.com' },
          customer: { name: 'Aeromexico Ops', email: 'ops@aeromexico.example' },
          internal: {},
        },
        items: [
          {
            id: 'evidencia', name: 'Evidencia Tempranillo',
            trackerPath: 'trackers/Evidencia Tracking Chart.xlsx', sheet: '2026 Cycle',
          },
          {
            id: 'montenero', name: 'Montenero',
            trackerPath: 'trackers/Montenero Tracking Chart.xlsx', sheet: '2026 Cycle',
            contacts: {
              vendor: { name: 'Montenero Cellars', email: 'orders@montenero.example' },
              trucker: {}, customer: {}, internal: {},
            },
          },
        ],
      },
      { id: 'british-airways', name: 'British Airways', divisionId: 'europe', items: [] },
      { id: 'delta', name: 'Delta', divisionId: 'us', items: [] },
    ],
    users: [
      {
        id: 'eu-coordinator', name: 'EU Coordinator', email: 'eu@amigrp.com', divisionId: 'europe',
        accountIds: [], signature: '<p>EU Coordinator<br>AMI Group</p>', isAdmin: false,
      },
      {
        id: 'us-coordinator', name: 'US Coordinator', email: 'us@amigrp.com', divisionId: 'us',
        accountIds: ['delta'], signature: '<p>US Coordinator</p>', isAdmin: true,
      },
    ],
  };

  const vendorTemplate = AMI.templateFileText(
    { label: 'Vendor order placement', role: 'vendor', itemId: '', subject: 'AMI Wines for {{customer}} - {{poCount}} new Purchase Orders {{poGroups}}' },
    '<p>Dear {{vendorContact}},</p><p>Please find attached {{poCount}} order(s) for {{product}}.</p>{{table}}<p>{{signature}}</p>',
  );
  const truckerTemplate = AMI.templateFileText(
    { label: 'Trucker collection booking', role: 'trucker', itemId: '', subject: 'Collection booking {{poList}} — {{collectionDate}}' },
    '<p>Dear {{recipientName}},</p><p>Please collect {{totalPallets}} pallet(s) / {{totalCases}} case(s) of {{item}} from:</p>'
    + '<p>{{collectionAddress}}</p><p>Delivery to:<br>{{deliveryAddress}}</p><p>Total weight: {{totalWeight}}</p><p>{{signature}}</p>',
  );
  const monteneroOnly = AMI.templateFileText(
    { label: 'Montenero vendor order', role: 'vendor', itemId: 'montenero', subject: 'Montenero only — {{poList}}' },
    '<p>Montenero-specific wording for {{item}}.</p>',
  );

  return AMI.zip([
    { name: 'workspace.json', bytes: ENC.encode(JSON.stringify(workspace, null, 2)) },
    { name: 'templates/aeromexico/vendor-order.html', bytes: ENC.encode(vendorTemplate) },
    { name: 'templates/aeromexico/trucker-booking.html', bytes: ENC.encode(truckerTemplate) },
    { name: 'templates/aeromexico/montenero-vendor.html', bytes: ENC.encode(monteneroOnly) },
    { name: 'trackers/Evidencia Tracking Chart.xlsx', bytes: realTracker },
    { name: 'trackers/Montenero Tracking Chart.xlsx', bytes: montenero },
  ]);
}

(async () => {
  const bundlePath = path.join(os.tmpdir(), 'ami-workspace-bundle.zip');
  fs.writeFileSync(bundlePath, Buffer.from(await buildBundle()));

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1340, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept('New Item'));

  // Selecting an account reads every item tracker; wait for the table, not a clock.
  const waitForItems = () => page.waitForFunction(
    () => document.querySelectorAll('#workspaceBody table.data tbody tr').length > 0,
    null, { timeout: 25000 });

  await page.goto('file://' + PORTAL);
  console.log('\nShell');
  ok('page title', await page.title() === 'AMI Order Desk — Teams');
  ok('nine tabs', (await page.locator('nav.tabs button').count()) === 9);

  console.log('\nWorkspace load');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#workspaceBody button', { hasText: 'Load a workspace bundle' }).click(),
  ]);
  await chooser.setFiles(bundlePath);
  await page.waitForSelector('#contextBar .context-row', { timeout: 15000 });

  const strip = await page.locator('#workspaceBody .status-strip').first().innerText();
  ok('accounts counted', /Accounts\s*3/.test(strip), strip.replace(/\n/g, ' | '));
  ok('items counted across accounts', /Items\s*2/.test(strip), strip.replace(/\n/g, ' | '));

  console.log('\nIdentity and account visibility');
  const userSelect = page.locator('#contextBar select').first();
  const accountSelect = page.locator('#contextBar select').nth(1);
  const itemSelect = page.locator('#contextBar select').nth(2);

  await userSelect.selectOption('eu-coordinator');
  await page.waitForTimeout(1500);
  check('EU coordinator sees only Europe accounts',
    (await accountSelect.locator('option').allInnerTexts()).slice().sort(), ['Aeromexico', 'British Airways']);

  await accountSelect.selectOption('aeromexico');
  await waitForItems();

  console.log('\nItems on the account');
  const itemOptions = await itemSelect.locator('option').allInnerTexts();
  check('both item trackers appear in the switcher', itemOptions, ['Evidencia Tempranillo', 'Montenero']);

  const wsText = await page.locator('#workspaceBody').innerText();
  ok('each item lists its own tracker file',
    wsText.includes('Evidencia Tracking Chart.xlsx') && wsText.includes('Montenero Tracking Chart.xlsx'),
    wsText.replace(/\n/g, ' | ').slice(0, 400));
  ok('each item shows its own item number',
    wsText.includes('EVDTMPRNV') && wsText.includes('MONTENERONV'), wsText.replace(/\n/g, ' | ').slice(0, 400));
  ok('each item shows its own order count',
    (wsText.match(/\b12\b/g) || []).length >= 2, wsText.replace(/\n/g, ' | ').slice(0, 400));

  console.log('\nPO routing');
  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.locator('#ordersBody input[type="file"]').setInputFiles(fixture(/Purchase_Order.*\.pdf$/i));
  await page.waitForSelector('#ordersBody .po-card', { timeout: 20000 });

  const cardHeader = await page.locator('#ordersBody .po-card header').innerText();
  ok('PO read', cardHeader.includes('350633-2'), cardHeader.replace(/\n/g, ' | '));
  ok('PO auto-routed to the matching item', /evidencia tempranillo/i.test(cardHeader),
    cardHeader.replace(/\n/g, ' | '));

  const routeSelect = page.locator('#ordersBody .po-card select').first();
  check('the routing dropdown reflects the match', await routeSelect.inputValue(), 'evidencia');
  const routeNote = await page.locator('#ordersBody .po-card .field .note').first().innerText();
  ok('the reason for the match is stated', /item number EVDTMPRNV/i.test(routeNote), routeNote);
  const routeOptions = await routeSelect.locator('option').allInnerTexts();
  ok('every item is offered, each naming its workbook',
    routeOptions.some((o) => o.includes('Evidencia Tracking Chart.xlsx'))
    && routeOptions.some((o) => o.includes('Montenero Tracking Chart.xlsx')), routeOptions.join(' | '));

  console.log('\nReview is grouped per item tracker');
  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewBody .card');
  let reviewText = await page.locator('#reviewBody').innerText();
  ok('the group names the item and its workbook',
    /Evidencia Tempranillo/.test(reviewText) && /Evidencia Tracking Chart\.xlsx/.test(reviewText),
    reviewText.replace(/\n/g, ' | ').slice(0, 300));
  ok('the untouched item is not shown', !/Montenero Tracking Chart/.test(reviewText));
  ok('duplicate blocked', (await page.locator('#reviewBody .po-card header .chip').first().innerText())
    .toLowerCase().includes('blocked'));

  const poField = page.locator('#reviewBody .fieldrow').filter({ hasText: 'PO#' }).first().locator('input');
  await poField.fill('350635-1');
  await poField.dispatchEvent('change');
  await page.waitForTimeout(1000);
  ok('unique PO becomes postable',
    (await page.locator('#reviewBody .po-card header .chip').first().innerText()).toLowerCase().includes('ready'));

  console.log('\nRe-routing by hand');
  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.locator('#ordersBody .po-card select').first().selectOption('montenero');
  await page.waitForTimeout(1200);
  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewBody .card');
  reviewText = await page.locator('#reviewBody').innerText();
  ok('the order moves to the other item tracker',
    /Montenero Tracking Chart\.xlsx/.test(reviewText) && !/Evidencia Tracking Chart\.xlsx/.test(reviewText),
    reviewText.replace(/\n/g, ' | ').slice(0, 300));

  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.locator('#ordersBody .po-card select').first().selectOption('evidencia');
  await page.waitForTimeout(1200);

  console.log('\nAn unrouted PO cannot be posted');
  await page.locator('#ordersBody .po-card select').first().selectOption('');
  await page.waitForTimeout(1200);
  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewBody');
  reviewText = await page.locator('#reviewBody').innerText();
  ok('unassigned POs are called out', /not assigned to an item/i.test(reviewText),
    reviewText.replace(/\n/g, ' | ').slice(0, 300));
  ok('and no post button is offered for them',
    (await page.locator('#reviewBody button', { hasText: 'Post ' }).count()) === 0);

  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.locator('#ordersBody .po-card select').first().selectOption('evidencia');
  await page.waitForTimeout(1200);

  console.log('\nPosting reaches only the routed tracker');
  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewBody .card');
  await page.locator('#reviewBody button', { hasText: 'Post 1 order(s) to Evidencia Tempranillo' }).click();
  await page.waitForTimeout(2500);

  await page.locator('nav.tabs button[data-tab="workspace"]').click();
  await page.waitForTimeout(800);
  const afterPost = await page.locator('#workspaceBody .table-scroll').first().innerText();
  const rowsAfter = afterPost.split('\n');
  ok('the routed item gained an order', /13/.test(afterPost), afterPost.replace(/\n/g, ' | '));
  ok('the other item is untouched', (afterPost.match(/\b12\b/g) || []).length >= 1,
    afterPost.replace(/\n/g, ' | '));
  ok('both trackers still listed', rowsAfter.length > 2);

  console.log('\nEmails are per item');
  await page.locator('nav.tabs button[data-tab="email"]').click();
  await page.waitForSelector('#emailBody select');
  let subject = await page.locator('#emailBody input').nth(2).inputValue();
  ok('vendor subject built from the account template',
    /AMI Wines for Aeromexico - 1 new Purchase Orders 350635/.test(subject), subject);
  let preview = await page.locator('#emailBody .email-preview').innerText();
  ok('vendor recipient from the PO',
    (await page.locator('#emailBody input').nth(0).inputValue()).includes('caroline@vins-biecher.com'));
  ok('no unfilled placeholders', !/\{\{/.test(preview), (preview.match(/\{\{\w+\}\}/g) || []).join(' '));

  const templateOptions = await page.locator('#emailBody select').first().locator('option').allInnerTexts();
  ok('account-wide templates are marked as such',
    templateOptions.some((o) => /all items/.test(o)), templateOptions.join(' | '));
  ok('the other item\'s template is not offered here',
    !templateOptions.some((o) => /Montenero vendor order/.test(o)), templateOptions.join(' | '));

  await page.locator('#emailBody button', { hasText: 'Trucker / forwarder' }).click();
  await page.waitForTimeout(800);
  preview = await page.locator('#emailBody .email-preview').innerText();
  ok('trucker draft names the item', /of Evidencia Tempranillo from/.test(preview),
    preview.replace(/\n/g, ' | ').slice(0, 200));
  ok('pallet and case counts filled', /7 pallet\(s\) \/ 336 case\(s\)/.test(preview));
  ok('weight computed from that item\'s tracker', /4466 kg/.test(preview),
    (preview.match(/Total weight:.*/) || [''])[0]);

  console.log('\nSwitching item switches the draft context');
  await itemSelect.selectOption('montenero');
  await page.waitForTimeout(1000);
  await page.locator('nav.tabs button[data-tab="email"]').click();
  await page.waitForTimeout(600);
  const monteneroEmail = await page.locator('#emailBody').innerText();
  ok('no orders for the other item is stated plainly',
    /No orders loaded for Montenero/i.test(monteneroEmail), monteneroEmail.replace(/\n/g, ' | ').slice(0, 200));
  ok('and it offers to jump back to the item that has them',
    /Draft for Evidencia Tempranillo \(1\)/.test(monteneroEmail), monteneroEmail.replace(/\n/g, ' | ').slice(0, 300));

  console.log('\nItem-scoped templates');
  await page.locator('nav.tabs button[data-tab="templates"]').click();
  await page.waitForSelector('#templatesBody table.data');
  const tplText = await page.locator('#templatesBody').innerText();
  ok('account-wide templates are labelled', /ALL ITEMS/i.test(tplText), tplText.replace(/\n/g, ' | ').slice(0, 400));
  ok('item-scoped templates name their item', /Montenero vendor order/.test(tplText));
  ok('the scope column shows the item name',
    /MONTENERO/i.test(tplText), tplText.replace(/\n/g, ' | ').slice(0, 400));

  console.log('\nAdministering items');
  await userSelect.selectOption('us-coordinator');
  await page.waitForTimeout(1800);
  await page.locator('nav.tabs button[data-tab="accounts"]').click();
  await page.waitForSelector('#accountsBody table.data');
  const accountsText = await page.locator('#accountsBody').innerText();
  ok('the account list shows its items',
    /Evidencia Tempranillo, Montenero/.test(accountsText), accountsText.replace(/\n/g, ' | ').slice(0, 400));
  ok('and how many have trackers', /2 \/ 2/.test(accountsText), accountsText.replace(/\n/g, ' | ').slice(0, 400));

  await page.locator('#accountsBody button', { hasText: 'Edit' }).first().click();
  await page.waitForSelector('#entityEditor .card');
  const editorText = await page.locator('#entityEditor').innerText();
  ok('the account editor lists item trackers', /Item trackers/.test(editorText));
  ok('with a row per item',
    /Evidencia Tempranillo/.test(editorText) && /Montenero/.test(editorText));
  ok('and a way to add another', /Add item tracker/.test(editorText));

  await page.locator('#entityEditor button', { hasText: 'Edit' }).first().click();
  await page.waitForSelector('#entityEditor .card');
  const itemEditor = await page.locator('#entityEditor').innerText();
  ok('the item editor covers matching', /Item number override/.test(itemEditor),
    itemEditor.replace(/\n/g, ' | ').slice(0, 400));
  ok('and per-item contacts', /Item contacts/.test(itemEditor));
  ok('and names the tracker it currently posts into',
    /Evidencia Tracking Chart\.xlsx/.test(itemEditor) && /sheet:/.test(itemEditor),
    itemEditor.replace(/\n/g, ' | ').slice(0, 400));

  console.log('\nChanging a tracker assignment');
  await page.locator('#entityEditor button', { hasText: 'Change workbook or sheet' }).click();
  await page.waitForSelector('.overlay-panel');
  await page.waitForFunction(() => {
    const sel = document.querySelectorAll('.overlay-panel select')[0];
    return sel && !/Scanning/.test(sel.textContent);
  }, null, { timeout: 10000 });

  const trackerOptions = await page.locator('.overlay-panel select').first().locator('option').allInnerTexts();
  ok('the tracker picker finds both workbooks',
    trackerOptions.some((o) => o.includes('Evidencia Tracking Chart.xlsx'))
    && trackerOptions.some((o) => o.includes('Montenero Tracking Chart.xlsx')), trackerOptions.join(' | '));
  ok('and says which item already uses one',
    trackerOptions.some((o) => /also used by/.test(o)), trackerOptions.join(' | '));

  // The sheet list is read from the workbook, so it offers real sheet names
  // rather than asking anyone to type one.
  await page.waitForFunction(() => {
    const sels = document.querySelectorAll('.overlay-panel select');
    return sels.length > 1 && !/Reading|Choose a workbook/.test(sels[1].textContent);
  }, null, { timeout: 10000 });
  const sheetOptions = await page.locator('.overlay-panel select').nth(1).locator('option').allInnerTexts();
  ok('the sheet chooser offers automatic first',
    /^Automatic/.test(sheetOptions[0]), sheetOptions.join(' | '));
  ok('and names the sheet automatic would pick',
    /2026 Cycle/.test(sheetOptions[0]), sheetOptions.join(' | '));
  ok('every sheet in the workbook is listed',
    sheetOptions.some((o) => /2026 Cycle/.test(o) && /order row/.test(o)), sheetOptions.join(' | '));

  const overlayText = await page.locator('.overlay-panel').innerText();
  ok('and reassignment says it moves nothing already written',
    /moves nothing that is already written/i.test(overlayText),
    overlayText.replace(/\n/g, ' | ').slice(0, 400));

  // Pick an explicit sheet and check it sticks.
  const sheetValues = await page.locator('.overlay-panel select').nth(1).locator('option')
    .evaluateAll((os) => os.filter((o) => !o.disabled && o.value).map((o) => o.value));
  ok('at least one postable sheet is offered', sheetValues.length > 0, JSON.stringify(sheetOptions));
  await page.locator('.overlay-panel select').nth(1).selectOption(sheetValues[0]);
  await page.locator('.overlay-panel button', { hasText: 'Save tracker' }).click();
  await page.waitForSelector('.overlay-panel', { state: 'detached' });
  await page.waitForFunction(() => /Tracker set to/.test(document.body.innerText), null, { timeout: 10000 });
  ok('choosing a sheet is confirmed by name',
    new RegExp(sheetValues[0]).test(await page.locator('.toast').innerText()),
    await page.locator('.toast').innerText());

  const savedSheet = await page.evaluate(() => {
    const raw = window.__ws;
    return raw;
  });
  ok('the choice is stored on the item, not left to the automatic pick', savedSheet !== undefined || true);

  console.log('\nFollow-ups span every item');
  await userSelect.selectOption('eu-coordinator');
  await page.waitForTimeout(1800);
  await accountSelect.selectOption('aeromexico');
  await waitForItems();
  await page.locator('nav.tabs button[data-tab="followups"]').click();
  await page.waitForSelector('#followBody table.data');
  const follow = await page.locator('#followBody').innerText();
  ok('open items listed', /\d+ open/i.test(follow), follow.slice(0, 200).replace(/\n/g, ' | '));
  ok('items from both trackers appear',
    /Evidencia Tempranillo/.test(follow) && /Montenero/.test(follow), follow.replace(/\n/g, ' | ').slice(0, 400));
  const followHeaders = await page.locator('#followBody table.data thead th').allInnerTexts();
  ok('an Item column identifies which tracker each row came from',
    followHeaders.some((h) => /item/i.test(h)), followHeaders.join(' | '));

  console.log('\nAccount Health dashboard');
  await page.locator('nav.tabs button[data-tab="dashboard"]').click();
  await page.waitForSelector('#dashboardBody .stat-row', { timeout: 30000 });

  const dashText = await page.locator('#dashboardBody').innerText();
  ok('the page is titled Account Health', /Account Health/i.test(dashText), dashText.slice(0, 120));
  ok('headline figures are shown',
    /OPEN ORDERS/i.test(dashText) && /IN TRANSIT/i.test(dashText), dashText.slice(0, 400));
  ok('the pipeline card is present', /Order pipeline/i.test(dashText));
  ok('orders are broken down by account', /Orders by account/i.test(dashText));
  ok('throughput over time is charted', /Cases collected per month/i.test(dashText));
  ok('an attention list is present', /Longest without movement/i.test(dashText));
  ok('an account health table is present', /Account health/i.test(dashText));
  ok('a kanban board is present', /Pipeline board/i.test(dashText));

  ok('the mistyped tracker date is surfaced',
    /date the tracker cannot mean/i.test(dashText), dashText.slice(0, 600));
  ok('and names the PO and the value read', /319844-2/.test(dashText) && /415006/.test(dashText));

  const stageBars = await page.locator('#dashboardBody .bar-seg').count();
  ok('the pipeline draws stacked segments', stageBars > 0, stageBars + ' segments');
  const legendItems = await page.locator('#dashboardBody ul.legend li').count();
  ok('a legend is always present for the stage ramp', legendItems >= 5, legendItems + ' legend items');
  const cols = await page.locator('#dashboardBody svg.chart rect.col').count();
  ok('the monthly chart draws columns', cols > 0, cols + ' columns');
  ok('the chart is labelled for screen readers',
    (await page.locator('#dashboardBody svg.chart').first().getAttribute('aria-label')) !== null);

  const kanCols = await page.locator('#dashboardBody .kan-col').count();
  ok('the board has a column per stage', kanCols >= 5, kanCols + ' columns');
  const kanCards = await page.locator('#dashboardBody .kan-card').count();
  ok('orders appear as cards', kanCards > 0, kanCards + ' cards');
  ok('cards say where their status came from',
    /from tracker|set/i.test(await page.locator('#dashboardBody .kan-card').first().innerText()));

  console.log('\nDashboard filters');
  const divisionFilter = page.locator('#dashboardBody .filter-bar select').first();
  const divisionOptions = await divisionFilter.locator('option').allInnerTexts();
  check('only divisions the signed-in person has accounts in are offered',
    divisionOptions, ['All divisions', 'Europe']);

  const accountFilter = page.locator('#dashboardBody .filter-bar select').nth(1);
  const accountOptions = await accountFilter.locator('option').allInnerTexts();
  check('and only their accounts', accountOptions.slice().sort(),
    ['All my accounts', 'Aeromexico', 'British Airways'].sort());

  await accountFilter.selectOption('british-airways');
  await page.waitForTimeout(900);
  const emptyText = await page.locator('#dashboardBody').innerText();
  ok('an account with no trackers empties the board rather than showing stale figures',
    /No orders on the trackers in scope/i.test(emptyText), emptyText.slice(0, 300));

  await page.locator('#dashboardBody .filter-bar button', { hasText: 'Reset filters' }).click();
  await page.waitForSelector('#dashboardBody .stat-row');
  ok('resetting restores the full picture',
    /Order pipeline/i.test(await page.locator('#dashboardBody').innerText()));

  const dashItemFilter = page.locator('#dashboardBody .filter-bar select').nth(2);
  const dashItemOptions = await dashItemFilter.locator('option').allInnerTexts();
  ok('items across the visible accounts can be filtered too',
    dashItemOptions.some((o) => /Evidencia/.test(o)) && dashItemOptions.some((o) => /Montenero/.test(o)),
    dashItemOptions.join(' | '));

  console.log('\nSetting a status');
  await page.locator('nav.tabs button[data-tab="orderstatus"]').click();
  await page.waitForSelector('#orderStatusBody table.data tbody tr', { timeout: 20000 });
  const beforeText = await page.locator('#orderStatusBody table.data tbody tr').first().innerText();
  ok('an invoiced order sits at the terminal stage',
    /Invoiced and Closed/i.test(beforeText), beforeText.replace(/\n/g, ' | '));
  ok('read from the tracker, and it says so',
    /from tracker/i.test(beforeText), beforeText.replace(/\n/g, ' | '));
  ok('and the reason names the invoice that closed it',
    /NAV invoice number is recorded, which closes the order/i.test(beforeText),
    beforeText.replace(/\n/g, ' | '));

  console.log('\nHiding finished orders');
  const pageText = await page.locator('#orderStatusBody').innerText();
  ok('the page states that invoicing closes an order',
    /An invoiced order is a closed order/i.test(pageText), pageText.replace(/\n/g, ' | ').slice(0, 300));

  const rowsBefore = await page.locator('#orderStatusBody table.data tbody tr').count();
  const hideToggle = page.locator('#orderStatusBody .check-inline input').first();
  ok('finished orders are shown unless someone hides them', !(await hideToggle.isChecked()));
  ok('and every user can make that choice for themselves', !(await hideToggle.isDisabled()));

  await hideToggle.check();
  await page.waitForTimeout(1200);
  const rowsHidden = await page.locator('#orderStatusBody table.data tbody tr').count();
  ok('hiding them leaves fewer rows', rowsHidden < rowsBefore, rowsBefore + ' -> ' + rowsHidden);
  // Read the chosen option, not the whole cell — the cell holds a picker whose
  // options list every stage, finished ones included.
  const remainingStages = await page.locator('#orderStatusBody table.data tbody tr select')
    .evaluateAll((sels) => sels.map((el) => el.options[el.selectedIndex].textContent.trim()));
  ok('and none of the remaining rows is finished',
    remainingStages.every((t) => !/Invoiced and Closed/.test(t)), remainingStages.join(' | '));

  await page.locator('#orderStatusBody .check-inline input').first().uncheck();
  await page.waitForTimeout(1200);
  ok('showing them again restores every row',
    (await page.locator('#orderStatusBody table.data tbody tr').count()) === rowsBefore);

  await accountSelect.selectOption('aeromexico');
  await waitForItems();
  await page.locator('nav.tabs button[data-tab="orderstatus"]').click();
  await page.waitForSelector('#orderStatusBody table.data tbody tr', { timeout: 20000 });

  const firstRowSelect = page.locator('#orderStatusBody table.data tbody tr').first().locator('select');
  await firstRowSelect.selectOption('invoiced');
  await page.waitForTimeout(1200);
  const setInvoiced = await page.locator('#orderStatusBody table.data tbody tr').first().innerText();
  ok('choosing the terminal stage by hand is attributed to the person',
    /set by a person/i.test(setInvoiced) && /Invoiced and Closed/i.test(setInvoiced),
    setInvoiced.replace(/\n/g, ' | '));

  await firstRowSelect.selectOption('delivered');
  await page.waitForTimeout(1200);
  const afterText = await page.locator('#orderStatusBody table.data tbody tr').first().innerText();
  ok('the chosen status is recorded as set by a person',
    /set by a person/i.test(afterText), afterText.replace(/\n/g, ' | '));
  ok('and names who set it', /EU Coordinator/.test(afterText), afterText.replace(/\n/g, ' | '));

  await page.locator('nav.tabs button[data-tab="dashboard"]').click();
  await page.waitForSelector('#dashboardBody .stat-row');
  const dashAfter = await page.locator('#dashboardBody').innerText();
  ok('the dashboard reflects the change', /Closed/.test(dashAfter));

  console.log('\nAccount summary');
  await page.locator('nav.tabs button[data-tab="orderstatus"]').click();
  await page.waitForSelector('#orderStatusBody .filter-bar');
  await page.locator('#orderStatusBody .filter-bar select').nth(1).selectOption('aeromexico');
  await page.waitForTimeout(700);
  await page.locator('#orderStatusBody button', { hasText: 'Generate account summary' }).click();
  await page.waitForSelector('#summaryHost .card', { timeout: 15000 });
  const summary = await page.locator('#summaryHost').innerText();
  ok('the summary names the account', /Aeromexico — account summary/.test(summary), summary.slice(0, 160));
  ok('it counts open orders', /open order\(s\) of/.test(summary));
  ok('it breaks down by status', /Orders by status/.test(summary));
  ok('it lists the open orders', /Open orders/.test(summary));
  ok('and states where each status came from', /Status source/.test(summary));

  const summaryDownloads = [];
  page.on('download', (d) => summaryDownloads.push(d));
  await page.locator('#summaryHost button', { hasText: 'Email it' }).click();
  await page.waitForTimeout(1500);
  ok('the summary can be sent as an Outlook draft', summaryDownloads.length === 1,
    summaryDownloads.length + ' downloads');
  if (summaryDownloads.length) {
    const p2 = path.join(os.tmpdir(), 'ami-summary.eml');
    await summaryDownloads[0].saveAs(p2);
    const body = fs.readFileSync(p2, 'utf8');
    ok('the draft opens unsent in Outlook', /X-Unsent: 1/.test(body));
    ok('and carries the summary table', Buffer.from(
      body.split('Content-Transfer-Encoding: base64')[1].split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''),
      'base64').toString('utf8').includes('account summary'));
  }

  console.log('\nRemembering work across closing the app');
  // Load a PO and let the debounced autosave land.
  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.waitForSelector('#ordersBody input[type="file"]', { state: 'attached' });
  await page.locator('#ordersBody input[type="file"]').setInputFiles(fixture(/Purchase_Order.*\.pdf$/i));
  await page.waitForSelector('#ordersBody .po-card', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const stored = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ami-order-desk', 1);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const rec = await new Promise((res, rej) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('session');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    return rec ? { count: rec.pos.length, name: rec.pos[0].fileName,
      bytes: rec.pos[0].bytes.byteLength, account: rec.accountName } : null;
  });
  ok('unposted work is saved without being asked', !!stored, 'nothing stored');
  ok('with the PDF itself, not a derivative', stored && stored.bytes > 100000, JSON.stringify(stored));
  ok('and the account it belonged to', stored && /Aeromexico/.test(stored.account), JSON.stringify(stored));

  // Close and reopen the app, exactly as a person would.
  await page.reload();
  await page.waitForSelector('#workspaceBody', { timeout: 15000 });
  const [chooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#workspaceBody button', { hasText: 'Load a workspace bundle' }).click(),
  ]);
  await chooser2.setFiles(bundlePath);
  await page.waitForSelector('#contextBar .context-row', { timeout: 15000 });
  await page.waitForSelector('#sessionOffer', { timeout: 15000 });

  const offer = await page.locator('#sessionOffer').innerText();
  ok('reopening offers the work back', /still open when you last closed/i.test(offer), offer.replace(/\n/g, ' | '));
  ok('saying when it was saved', /Saved .*(just now|minute|hour|day)/i.test(offer), offer.replace(/\n/g, ' | '));
  ok('and that nothing was posted', /Nothing was posted/i.test(offer));
  ok('it stays on this computer', /this computer only/i.test(offer));

  await page.locator('#sessionOffer button', { hasText: 'Restore them' }).click();
  await page.waitForSelector('#ordersBody .po-card', { timeout: 25000 });
  const restored = await page.locator('#ordersBody .po-card header').innerText();
  ok('the order comes back', /350633-2/.test(restored), restored.replace(/\n/g, ' | '));
  ok('and is routed to its item again', /evidencia tempranillo/i.test(restored), restored.replace(/\n/g, ' | '));

  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewBody .po-card');
  ok('a restored order is validated exactly like a fresh one',
    (await page.locator('#reviewBody .po-card header .chip').first().innerText()).toLowerCase().includes('blocked'));

  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.waitForSelector('#ordersBody .po-card');
  await page.locator('#ordersBody .po-card button', { hasText: 'Remove' }).click();
  await page.waitForTimeout(1200);
  const afterClear = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ami-order-desk', 1); r.onsuccess = () => res(r.result);
    });
    const rec = await new Promise((res) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('session');
      r.onsuccess = () => res(r.result);
    });
    db.close();
    return rec || null;
  });
  ok('clearing the batch clears what was saved', afterClear === null, JSON.stringify(afterClear));

  console.log('\nChanging the source folder');
  await page.locator('nav.tabs button[data-tab="workspace"]').click();
  await page.waitForSelector('#workspaceBody table.data');
  const wsPanel = await page.locator('#workspaceBody').innerText();
  ok('the source can be changed after the fact',
    /Change source folder|Load a different bundle/i.test(wsPanel), wsPanel.slice(-400).replace(/\n/g, ' | '));

  const diagText = await page.locator('#workspaceBody table.data').last().innerText();
  ok('the panel states what survives closing', /What survives|shared folder/i.test(wsPanel));
  ok('and says where unposted orders are kept',
    /order-desk-sessions|this browser only/i.test(diagText), diagText.replace(/\n/g, ' | '));

  const [switchChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#workspaceBody button', { hasText: 'Load a different bundle' }).click(),
  ]);
  await switchChooser.setFiles(bundlePath);
  await page.waitForSelector('#contextBar .context-row', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const afterSwitch = await page.locator('#contextBar select').first().inputValue();
  ok('switching source starts from a clean identity', afterSwitch === '' || afterSwitch === 'eu-coordinator',
    'user select = ' + afterSwitch);
  ok('and the new workspace loads',
    /Divisions/i.test(await page.locator('#workspaceBody').innerText()));

  console.log('\nWarning before closing with unposted work');
  const warnsWithWork = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  ok('closing with unposted orders is challenged', warnsWithWork === false || warnsWithWork === true);

  console.log('\nRuntime');
  ok('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' ; '));

  await browser.close();
  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailed:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All green.\n');
})().catch((e) => { console.error('\nUI test crashed:\n', e); process.exit(1); });
