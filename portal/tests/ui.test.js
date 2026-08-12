/* Browser test: drives the built single-file portal end to end in Chromium.
 *
 *   node portal/tests/ui.test.js [fixturesDir]
 *
 * Exercises the real user path: load the tracker, drop the PO PDF, review the
 * planned row, post it, and generate the vendor email — all from file://.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const FIXTURES = process.argv[2] || process.env.AMI_FIXTURES
  || '/root/.claude/uploads/ce5dd401-299f-5618-9ee9-da4319624cf3';
const PORTAL = path.join(__dirname, '..', 'AMI-Order-Desk.html');

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { failed++; failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : '')); }
}

function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else {
    failed++; failures.push(name);
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       expected: ' + JSON.stringify(expected));
    console.log('       actual:   ' + JSON.stringify(actual));
  }
}

function fixture(re) {
  const f = fs.readdirSync(FIXTURES).find((n) => re.test(n));
  if (!f) throw new Error('No fixture matching ' + re);
  return path.join(FIXTURES, f);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto('file://' + PORTAL);
  console.log('\nPortal shell');
  ok('page title', await page.title() === 'AMI Order Desk');
  ok('tabs rendered', (await page.locator('nav.tabs button').count()) === 6);
  ok('downstream tabs start disabled', await page.locator('nav.tabs button[data-tab="review"]').isDisabled());

  /* ---- load tracker via the upload path (works on file://) ---- */
  console.log('\nTracker load');
  await page.locator('#trackerInput').setInputFiles(fixture(/Tracking_Chart.*\.xlsx$/i));
  await page.waitForSelector('#trackerInfo .card', { timeout: 15000 });

  const strip = await page.locator('.status-strip').innerText();
  ok('sheet auto-selected as the 2026 cycle', strip.includes('2026 Cycle'), strip.replace(/\n/g, ' | '));
  ok('order count shown', /Orders logged\s*12/.test(strip), strip.replace(/\n/g, ' | '));
  ok('last PO shown', strip.includes('350633-2'), strip.replace(/\n/g, ' | '));
  ok('next row shown', /Next row\s*45/.test(strip), strip.replace(/\n/g, ' | '));
  ok('contract balance shown', /Contract balance/.test(strip));

  const kv = await page.locator('#trackerInfo .kv').innerText();
  ok('config lists bottles per case', /Bottles per case\s*12/.test(kv), kv.replace(/\n/g, ' | '));
  ok('config lists cases per pallet', /Cases per pallet\s*48/.test(kv));
  ok('config lists lead time', /Production lead time\s*37 days/.test(kv));
  ok('intake tab now enabled', !(await page.locator('nav.tabs button[data-tab="intake"]').isDisabled()));

  /* ---- load the PO ---- */
  console.log('\nPurchase order intake');
  await page.locator('nav.tabs button[data-tab="intake"]').click();
  await page.locator('#pdfInput').setInputFiles(fixture(/Purchase_Order.*\.pdf$/i));
  await page.waitForSelector('#poList .po-card', { timeout: 20000 });

  const poHeader = await page.locator('#poList .po-card header').innerText();
  ok('PO number read from the PDF', poHeader.includes('350633-2'), poHeader.replace(/\n/g, ' | '));
  const poKv = await page.locator('#poList .po-card .kv').innerText();
  ok('quantity read', /Quantity\s*336 CS/.test(poKv), poKv.replace(/\n/g, ' | '));
  ok('vendor contact read', /Caroline Mounier-Duchamp/.test(poKv));
  ok('pickup date read', /Pickup date\s*6\/24\/2026/.test(poKv));
  ok('blank delivery date is stated, not invented', /Delivery date\s*\(blank on PO\)/.test(poKv));

  /* ---- review ---- */
  console.log('\nReview');
  await page.locator('nav.tabs button[data-tab="review"]').click();
  await page.waitForSelector('#reviewList .po-card');

  // The sample PO is already row 44, so re-posting it must be blocked.
  const blocked = await page.locator('#reviewList .po-card header .chip').innerText();
  ok('duplicate PO is blocked in the UI', blocked.trim().toLowerCase() === 'blocked', blocked);
  const dupMsg = await page.locator('#reviewList .msg.error').first().innerText();
  ok('duplicate reason is explained', /already in this sheet/.test(dupMsg), dupMsg.replace(/\n/g, ' '));
  ok('post button disabled while blocked', await page.locator('#postBar button.primary').isDisabled());

  // Edit the PO number to make it a genuinely new order.
  const poField = page.locator('#reviewList .fieldrow').filter({ hasText: 'PO#' }).first().locator('input');
  await poField.fill('350634-1');
  await poField.dispatchEvent('change');
  await page.waitForTimeout(600);

  const readyChip = await page.locator('#reviewList .po-card header .chip').innerText();
  ok('row becomes postable once the PO is unique', readyChip.trim().toLowerCase() === 'ready', readyChip);

  const raw = await page.locator('#reviewList .fieldrow').allInnerTexts();
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const rows = raw.map((r) => ({ head: norm(r.split('\n')[0]), all: norm(r), lines: r.split('\n').length }));
  const find = (h) => (rows.find((r) => r.head === norm(h)) || { all: '' }).all;
  ok('bottles computed and labelled', /computed/.test(find('Quantity (bt)')), find('Quantity (bt)'));
  ok('bottles arithmetic is shown', /336 cs x 12 bottles\/case/.test(find('Quantity (bt)')));
  ok('cases stays a formula', /formula/.test(find('Quantity (cs)')), find('Quantity (cs)'));
  ok('collection date is a formula', /formula/.test(find('AMI Requested Collection Date')),
    find('AMI Requested Collection Date'));
  ok('collection date resolves to the PO pickup date',
    find('AMI Requested Collection Date').includes('6/24/2026'),
    find('AMI Requested Collection Date'));
  ok('ship-to flagged as carried forward', /carried/.test(find('Ship To')), find('Ship To'));
  ok('lot number left blank', /blank/.test(find('Lot Number')), find('Lot Number'));
  ok('every row states an origin', rows.every((r) => r.lines >= 3));

  /* ---- post ---- */
  console.log('\nPosting');
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.locator('#postBar button.primary').click();
  await page.waitForTimeout(2500);

  ok('two files produced: backup and updated tracker', downloads.length === 2, downloads.length + ' downloads');
  const names = downloads.map((d) => d.suggestedFilename());
  ok('a timestamped backup was written first', /\(backup .*\)\.xlsx$/.test(names[0]), names.join(', '));
  ok('updated tracker keeps the original name', names[1].endsWith('.xlsx'), names.join(', '));

  const outPath = path.join(require('os').tmpdir(), 'ami-ui-out.xlsx');
  await downloads[1].saveAs(outPath);

  const AMI = require('../src/engine.js');
  const wb = await AMI.Workbook.load(new Uint8Array(fs.readFileSync(outPath)));
  const sheet = wb.sheet('2026 Cycle');
  const header = AMI.findHeaderRow(sheet);
  const dataRows = AMI.dataRows(sheet, header);
  check('written file has one more order', dataRows.length, 13);
  check('new PO landed in the sheet', sheet.cellText(45, 'A'), '350634-1');
  check('bottles written', sheet.cell(45, 'B').num, 4032);
  check('cases formula preserved in the written file', sheet.cell(45, 'C').formula.text, 'B45/$F$2');
  check('collection date computed into the written file',
    AMI.formatISO(AMI.serialToDate(sheet.cell(45, 'K').num)), '2026-06-24');
  check('balance decremented', sheet.cell(45, 'S').num, 40512);
  check('previous rows untouched', sheet.cellText(44, 'A'), '350633-2');
  ok('threaded comments preserved through the browser round-trip',
    wb.map.has('xl/threadedComments/threadedComment1.xml'));
  ok('all three sheets preserved', wb.sheets.length === 3);

  /* ---- email ---- */
  console.log('\nVendor email');
  await page.locator('nav.tabs button[data-tab="email"]').click();
  await page.waitForSelector('#emailPanelBody input');

  const subject = await page.locator('#emailPanelBody input').nth(2).inputValue();
  ok('subject built from the PO and tracker',
    /AMI Wines for Aeromexico - 1 new Purchase Orders 350634/.test(subject), subject);
  const to = await page.locator('#emailPanelBody input').nth(0).inputValue();
  ok('recipient taken from the PO vendor block',
    to.includes('caroline@vins-biecher.com') && to.includes('Caroline'), to);
  const cc = await page.locator('#emailPanelBody input').nth(1).inputValue();
  ok('cc taken from the PO document instructions', cc.includes('euwineorders@amigrp.com'), cc);

  const tableText = await page.locator('#emailPanelBody table.data').innerText();
  ok('email table lists the PO', tableText.includes('350634-1'), tableText.replace(/\n/g, ' | '));
  ok('email table shows bottles', tableText.includes('4,032.00') || tableText.includes('4032.00'),
    tableText.replace(/\n/g, ' | '));

  const preview = await page.locator('.email-preview').innerText();
  ok('preview greets the vendor contact', /Dear Caroline Mounier-Duchamp/.test(preview), preview.slice(0, 120));
  ok('preview quotes the final delivery address', /COMI-BOND/.test(preview));
  ok('preview keeps the standing instructions', /PALLETS NOT TO BE HIGHER THAN 160 CM/.test(preview));

  downloads.length = 0;
  await page.locator('#emailPanelBody button.primary').click();
  await page.waitForTimeout(1500);
  ok('eml draft downloaded', downloads.length === 1, downloads.length + ' downloads');
  const emlPath = path.join(require('os').tmpdir(), 'ami-ui-out.eml');
  await downloads[0].saveAs(emlPath);
  const eml = fs.readFileSync(emlPath, 'utf8');
  ok('eml is flagged unsent so Outlook opens a draft', /X-Unsent: 1/.test(eml));
  ok('eml carries the PO pdf as an attachment', /filename="[^"]*\.pdf"/.test(eml));
  ok('eml body contains the breakdown table', Buffer.from(
    eml.split('Content-Transfer-Encoding: base64')[1].split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''),
    'base64').toString('utf8').includes('350634-1'));

  /* ---- follow-ups ---- */
  console.log('\nFollow-ups');
  await page.locator('nav.tabs button[data-tab="followups"]').click();
  await page.waitForSelector('#followBody');
  const followText = (await page.locator('#followBody').innerText()).toLowerCase();
  ok('open items listed', /\d+ open/.test(followText), followText.slice(0, 240).replace(/\n/g, ' | '));
  ok('follow-ups name the blank column and its anchor',
    /measured from/.test(followText) && /outstanding/.test(followText));
  ok('follow-ups group by counterparty', /winery|forwarder|internal/.test(followText));
  const followRows = await page.locator('#followBody table.data tbody tr').count();
  ok('follow-up rows listed', followRows > 0, followRows + ' rows');

  /* ---- console hygiene ---- */
  console.log('\nRuntime');
  ok('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' ; '));

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
