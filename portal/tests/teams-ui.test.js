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
  ok('seven tabs', (await page.locator('nav.tabs button').count()) === 7);

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
  await page.waitForFunction(() => {
    const sel = document.querySelectorAll('#entityEditor select')[0];
    return sel && !/Scanning/.test(sel.textContent);
  }, null, { timeout: 10000 });
  const itemEditor = await page.locator('#entityEditor').innerText();
  ok('the item editor covers matching', /Item number override/.test(itemEditor),
    itemEditor.replace(/\n/g, ' | ').slice(0, 400));
  ok('and per-item contacts', /Item contacts/.test(itemEditor));
  const trackerOptions = await page.locator('#entityEditor select').first().locator('option').allInnerTexts();
  ok('the tracker picker finds both workbooks',
    trackerOptions.some((o) => o.includes('Evidencia Tracking Chart.xlsx'))
    && trackerOptions.some((o) => o.includes('Montenero Tracking Chart.xlsx')), trackerOptions.join(' | '));
  ok('and flags a workbook already used by another item',
    trackerOptions.some((o) => /already used by another item/.test(o)), trackerOptions.join(' | '));

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
