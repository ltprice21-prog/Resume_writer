/* Browser test for the multi-account portal.
 *
 *   node portal/tests/teams-ui.test.js [fixturesDir]
 *
 * Builds a workspace bundle (config + templates + a real tracker), loads it into
 * the built HTML file over file://, and drives the whole path: pick a user, see
 * only their accounts, switch account, post an order, draft from a template.
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

async function buildBundle() {
  const workspace = {
    version: 1,
    updated: new Date().toISOString(),
    divisions: [{ id: 'europe', name: 'Europe' }, { id: 'us', name: 'US' }],
    accounts: [
      {
        id: 'aeromexico', name: 'Aeromexico', divisionId: 'europe', product: 'Evidencia Tempranillo Spain',
        trackerPath: 'trackers/Aeromexico Tracking Chart.xlsx', sheet: '2026 Cycle',
        defaultCc: 'euwineorders@amigrp.com',
        contacts: {
          vendor: { name: 'Caroline Mounier-Duchamp', email: 'caroline@vins-biecher.com' },
          trucker: { name: 'Steffy Demouchy', email: 'sdemouchy@stpicargo.com', cc: 'comat@stpicargo.com' },
          customer: { name: 'Aeromexico Ops', email: 'ops@aeromexico.example' },
          internal: {},
        },
      },
      { id: 'british-airways', name: 'British Airways', divisionId: 'europe', trackerPath: '' },
      { id: 'delta', name: 'Delta', divisionId: 'us', trackerPath: '' },
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
    { label: 'Vendor order placement', role: 'vendor', subject: 'AMI Wines for {{customer}} - {{poCount}} new Purchase Orders {{poGroups}}' },
    '<p>Dear {{vendorContact}},</p><p>Please find attached {{poCount}} order(s) for {{product}}.</p>{{table}}<p>{{signature}}</p>',
  );
  const truckerTemplate = AMI.templateFileText(
    { label: 'Trucker collection booking', role: 'trucker', subject: 'Collection booking {{poList}} — {{collectionDate}}' },
    '<p>Dear {{recipientName}},</p><p>Please collect {{totalPallets}} pallet(s) / {{totalCases}} case(s) from:</p>'
    + '<p>{{collectionAddress}}</p><p>Delivery to:<br>{{deliveryAddress}}</p><p>Total weight: {{totalWeight}}</p><p>{{signature}}</p>',
  );

  return AMI.zip([
    { name: 'workspace.json', bytes: ENC.encode(JSON.stringify(workspace, null, 2)) },
    { name: 'templates/aeromexico/vendor-order.html', bytes: ENC.encode(vendorTemplate) },
    { name: 'templates/aeromexico/trucker-booking.html', bytes: ENC.encode(truckerTemplate) },
    {
      name: 'trackers/Aeromexico Tracking Chart.xlsx',
      bytes: new Uint8Array(fs.readFileSync(fixture(/Tracking_Chart.*\.xlsx$/i))),
    },
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
  page.on('dialog', (d) => d.accept('New Division'));

  await page.goto('file://' + PORTAL);
  console.log('\nShell');
  ok('page title', await page.title() === 'AMI Order Desk — Teams');
  ok('seven tabs', (await page.locator('nav.tabs button').count()) === 7);
  ok('context bar hidden until a workspace loads', await page.locator('#contextBar').isHidden());

  console.log('\nWorkspace load');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#workspaceBody button', { hasText: 'Load a workspace bundle' }).click(),
  ]);
  await chooser.setFiles(bundlePath);
  await page.waitForSelector('#contextBar .context-row', { timeout: 15000 });

  const strip = await page.locator('#workspaceBody .status-strip').first().innerText();
  ok('divisions counted', /Divisions\s*2/.test(strip), strip.replace(/\n/g, ' | '));
  ok('accounts counted', /Accounts\s*3/.test(strip), strip.replace(/\n/g, ' | '));
  ok('users counted', /Users\s*2/.test(strip), strip.replace(/\n/g, ' | '));

  console.log('\nPer-user account visibility');
  const userSelect = page.locator('#contextBar select').first();
  const accountSelect = page.locator('#contextBar select').nth(1);

  await userSelect.selectOption('eu-coordinator');
  await page.waitForTimeout(1200);
  let options = await accountSelect.locator('option').allInnerTexts();
  check('EU coordinator sees only Europe accounts', options.slice().sort(), ['Aeromexico', 'British Airways']);
  let groups = await accountSelect.locator('optgroup').evaluateAll((els) => els.map((e) => e.label));
  check('grouped under their division', groups, ['Europe']);

  await userSelect.selectOption('us-coordinator');
  await page.waitForTimeout(1500);
  options = await accountSelect.locator('option').allInnerTexts();
  check('an administrator sees every division', options.slice().sort(),
    ['Aeromexico', 'British Airways', 'Delta']);
  groups = await accountSelect.locator('optgroup').evaluateAll((els) => els.map((e) => e.label));
  check('both divisions grouped', groups, ['Europe', 'US']);

  await userSelect.selectOption('eu-coordinator');
  await page.waitForTimeout(1500);
  ok('division shown in the context bar',
    (await page.locator('#contextBar').innerText()).toLowerCase().includes('europe'));

  console.log('\nAccount tracker binding');
  await accountSelect.selectOption('aeromexico');
  // Selecting an account reads and parses its tracker; wait for that, not a clock.
  await page.waitForFunction(
    () => /Orders logged/.test(document.querySelector('#workspaceBody').innerText),
    null, { timeout: 20000 });
  const wsText = await page.locator('#workspaceBody').innerText();
  ok('tracker auto-loaded for the account', /Orders logged\s*12/.test(wsText), wsText.replace(/\n/g, ' | ').slice(0, 300));
  ok('configured sheet honoured', /Sheet\s*2026 Cycle/.test(wsText));
  ok('tracker path shown in the context bar',
    (await page.locator('#contextBar').innerText()).includes('Aeromexico Tracking Chart.xlsx'));

  await accountSelect.selectOption('british-airways');
  await page.waitForTimeout(1200);
  await page.locator('nav.tabs button[data-tab="orders"]').click().catch(() => {});
  ok('an account with no tracker disables the order tabs',
    await page.locator('nav.tabs button[data-tab="review"]').isDisabled());

  await accountSelect.selectOption('aeromexico');
  await page.waitForFunction(
    () => /Orders logged/.test(document.querySelector('#workspaceBody').innerText),
    null, { timeout: 20000 });

  console.log('\nTemplates');
  await page.locator('nav.tabs button[data-tab="templates"]').click();
  await page.waitForSelector('#templatesBody table.data');
  const tplText = await page.locator('#templatesBody').innerText();
  ok('vendor template listed', tplText.includes('Vendor order placement'), tplText.replace(/\n/g, ' | '));
  ok('trucker template listed', tplText.includes('Trucker collection booking'));
  ok('grouped by counterparty', /Vendor \/ winery/i.test(tplText) && /Trucker \/ forwarder/i.test(tplText));
  ok('placeholders surfaced per template', tplText.includes('vendorContact'), tplText.replace(/\n/g, ' | '));

  console.log('\nOrders');
  await page.locator('nav.tabs button[data-tab="orders"]').click();
  await page.locator('#ordersBody input[type="file"]').setInputFiles(fixture(/Purchase_Order.*\.pdf$/i));
  await page.waitForSelector('#ordersBody .po-card', { timeout: 20000 });
  ok('PO read', (await page.locator('#ordersBody .po-card header').innerText()).includes('350633-2'));

  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewBody .po-card');
  ok('duplicate blocked', (await page.locator('#reviewBody .po-card header .chip').innerText()).toLowerCase().includes('blocked'));

  const poField = page.locator('#reviewBody .fieldrow').filter({ hasText: 'PO#' }).first().locator('input');
  await poField.fill('350635-1');
  await poField.dispatchEvent('change');
  await page.waitForTimeout(900);
  ok('unique PO becomes postable',
    (await page.locator('#reviewBody .po-card header .chip').innerText()).toLowerCase().includes('ready'));

  console.log('\nPosting into the workspace store');
  await page.locator('#reviewBody button.primary').click();
  await page.waitForTimeout(2500);
  await page.locator('nav.tabs button[data-tab="workspace"]').click();
  await page.waitForFunction(
    () => /Orders logged\s*13/.test(document.querySelector('#workspaceBody').innerText),
    null, { timeout: 20000 }).catch(() => {});
  const afterPost = await page.locator('#workspaceBody').innerText();
  ok('tracker in the shared folder now has the extra order', /Orders logged\s*13/.test(afterPost),
    afterPost.replace(/\n/g, ' | ').slice(0, 300));
  ok('last PO updated', /Last PO\s*350635-1/.test(afterPost), afterPost.replace(/\n/g, ' | ').slice(0, 300));

  console.log('\nEmails from account templates');
  await page.locator('nav.tabs button[data-tab="email"]').click();
  await page.waitForSelector('#emailBody select');

  const subject = await page.locator('#emailBody input').nth(2).inputValue();
  ok('vendor subject built from the account template',
    /AMI Wines for Aeromexico - 1 new Purchase Orders 350635/.test(subject), subject);
  const to = await page.locator('#emailBody input').nth(0).inputValue();
  ok('vendor recipient from the PO', to.includes('caroline@vins-biecher.com'), to);
  const preview = await page.locator('#emailBody .email-preview').innerText();
  ok('vendor body filled', /Dear Caroline Mounier-Duchamp/.test(preview), preview.slice(0, 120));
  ok('signature inserted', /EU Coordinator/.test(preview));
  ok('no unfilled placeholders left', !/\{\{/.test(preview), (preview.match(/\{\{\w+\}\}/g) || []).join(' '));

  await page.locator('#emailBody button', { hasText: 'Trucker / forwarder' }).click();
  await page.waitForTimeout(700);
  const truckerTo = await page.locator('#emailBody input').nth(0).inputValue();
  ok('trucker recipient from the account contact', truckerTo.includes('sdemouchy@stpicargo.com'), truckerTo);
  const truckerCc = await page.locator('#emailBody input').nth(1).inputValue();
  ok('per-role cc applied', truckerCc.includes('comat@stpicargo.com'), truckerCc);
  const truckerSubject = await page.locator('#emailBody input').nth(2).inputValue();
  ok('trucker subject uses its own template', /Collection booking 350635-1/.test(truckerSubject), truckerSubject);
  const truckerPreview = await page.locator('#emailBody .email-preview').innerText();
  ok('pallet and case counts filled', /7 pallet\(s\) \/ 336 case\(s\)/.test(truckerPreview),
    truckerPreview.replace(/\n/g, ' | '));
  ok('collection address from the PO', /Vins Biecher/.test(truckerPreview));
  ok('delivery address from the PO', /Aerovias De Mexico/.test(truckerPreview));
  ok('weight computed from the tracker constant', /4466 kg/.test(truckerPreview),
    (truckerPreview.match(/Total weight:.*/) || [''])[0]);
  ok('no unfilled placeholders in the trucker draft', !/\{\{/.test(truckerPreview));

  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.locator('#emailBody button', { hasText: 'Download Outlook draft' }).click();
  await page.waitForTimeout(1500);
  ok('trucker draft downloaded', downloads.length === 1, downloads.length + ' downloads');
  const emlPath = path.join(os.tmpdir(), 'ami-teams.eml');
  await downloads[0].saveAs(emlPath);
  const eml = fs.readFileSync(emlPath, 'utf8');
  ok('draft opens unsent in Outlook', /X-Unsent: 1/.test(eml));
  ok('trucker draft carries no PO attachment by default', !/filename="[^"]*\.pdf"/.test(eml));
  ok('sender taken from the signed-in user', /From: EU Coordinator <eu@amigrp\.com>/.test(eml),
    (eml.match(/From:.*/) || [''])[0]);

  console.log('\nCustomer role with no template');
  await page.locator('#emailBody button', { hasText: 'Customer / airline' }).click();
  await page.waitForTimeout(600);
  const customerText = await page.locator('#emailBody').innerText();
  ok('missing template is reported, not faked', /No customer template for Aeromexico yet/i.test(customerText),
    customerText.replace(/\n/g, ' | ').slice(0, 200));

  console.log('\nFollow-ups');
  await page.locator('nav.tabs button[data-tab="followups"]').click();
  await page.waitForSelector('#followBody table.data');
  const follow = (await page.locator('#followBody').innerText()).toLowerCase();
  ok('open items listed for the account', /\d+ open/.test(follow), follow.slice(0, 200).replace(/\n/g, ' | '));
  ok('grouped by counterparty', /winery|forwarder|internal/.test(follow));

  console.log('\nAccounts administration');
  await page.locator('nav.tabs button[data-tab="accounts"]').click();
  await page.waitForSelector('#accountsBody table.data');
  const accountsText = await page.locator('#accountsBody').innerText();
  ok('all accounts listed', ['Aeromexico', 'British Airways', 'Delta'].every((n) => accountsText.includes(n)));
  ok('people listed', accountsText.includes('EU Coordinator') && accountsText.includes('US Coordinator'));
  ok('view-filter limitation stated plainly',
    /does not lock anything/i.test(accountsText) && /SharePoint/i.test(accountsText),
    accountsText.replace(/\n/g, ' | ').slice(-300));
  ok('a non-administrator gets no edit controls',
    (await page.locator('#accountsBody button', { hasText: 'Edit' }).count()) === 0);
  ok('and is told why', /only administrators change the shared setup/i.test(accountsText));

  await userSelect.selectOption('us-coordinator');
  await page.waitForTimeout(1500);
  await page.locator('nav.tabs button[data-tab="accounts"]').click();
  await page.waitForSelector('#accountsBody table.data');
  ok('an administrator does get edit controls',
    (await page.locator('#accountsBody button', { hasText: 'Edit' }).count()) > 0);

  await page.locator('#accountsBody button', { hasText: 'Edit' }).first().click();
  await page.waitForSelector('#entityEditor .card');
  const editorText = await page.locator('#entityEditor').innerText();
  ok('account editor exposes per-role contacts',
    ['Vendor / winery', 'Trucker / forwarder', 'Customer / airline', 'Internal'].every((r) => editorText.includes(r)),
    editorText.replace(/\n/g, ' | ').slice(0, 260));
  // The tracker picker scans the workspace folder asynchronously.
  await page.waitForFunction(() => {
    const sel = document.querySelectorAll('#entityEditor select')[1];
    return sel && !/Scanning/.test(sel.textContent);
  }, null, { timeout: 10000 });
  const trackerOptions = await page.locator('#entityEditor select').nth(1).locator('option').allInnerTexts();
  ok('tracker picker found the workbook in the workspace',
    trackerOptions.some((o) => o.includes('Aeromexico Tracking Chart.xlsx')), trackerOptions.join(' | '));

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
