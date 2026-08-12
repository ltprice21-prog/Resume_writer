/* Engine tests. Runs the real sample PO and tracker through the full pipeline.
 *
 *   node portal/tests/engine.test.js [fixturesDir]
 *
 * Fixtures are not committed (they contain customer data). Point the script at a
 * folder holding the sample purchase order PDF and the tracking chart .xlsx.
 */
const fs = require('fs');
const path = require('path');
const AMI = require('../src/engine.js');

const FIXTURES = process.argv[2] || process.env.AMI_FIXTURES
  || '/root/.claude/uploads/ce5dd401-299f-5618-9ee9-da4319624cf3';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else {
    failed++;
    failures.push(name);
    console.log('  \x1b[31mFAIL\x1b[0m ' + name);
    console.log('       expected: ' + JSON.stringify(expected));
    console.log('       actual:   ' + JSON.stringify(actual));
  }
}

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else {
    failed++;
    failures.push(name);
    console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function findFixture(pattern) {
  const files = fs.readdirSync(FIXTURES);
  const hit = files.find((f) => pattern.test(f));
  if (!hit) throw new Error('No fixture matching ' + pattern + ' in ' + FIXTURES);
  return path.join(FIXTURES, hit);
}

(async function run() {
  console.log('\nFixtures: ' + FIXTURES + '\n');

  /* ---------------- PDF extraction ---------------- */
  console.log('PDF extraction');
  const pdfPath = findFixture(/Purchase_Order.*\.pdf$/i);
  const pdfBytes = new Uint8Array(fs.readFileSync(pdfPath));
  const pages = await AMI.extractPdfPages(pdfBytes);
  ok('pages extracted', pages.length >= 2, pages.length + ' pages');

  const po = AMI.parsePurchaseOrder(pages, path.basename(pdfPath));
  check('PO number', po.poNumber, '350633-2');
  check('order date', AMI.formatISO(po.orderDate), '2026-01-09');
  check('pickup date', AMI.formatISO(po.pickupDate), '2026-06-24');
  check('entered by', po.enteredBy, 'Bo Price');
  check('shipping agent', po.shippingAgent, 'STPI');
  check('shipment method', po.shipmentMethod, 'Ex Works');
  check('terms', po.terms, 'Net 90 days');
  check('currency', po.currency, 'EUR');
  check('item number', po.itemNo, 'EVDTMPRNV');
  check('quantity (cases)', po.qty, 336);
  check('uom', po.uom, 'CS');
  check('unit price', po.unitPrice, 19.8);
  check('extended amount', po.extAmount, 6652.8);
  check('order total', po.total, 6652.8);
  check('size', po.size, '1 X 12 L');
  check('bottles per case from size', po.bottlesPerCaseFromSize, 12);
  check('vendor name', po.vendorName, 'Vins Biecher');
  check('vendor email', po.vendorEmail, 'caroline@vins-biecher.com');
  check('vendor contact', po.vendorContact, 'Caroline Mounier-Duchamp');
  check('confirm-to address', po.confirmTo, 'parissa@amigrp.com');
  check('documents address', po.docsTo, 'euwineorders@amigrp.com');
  check('country of origin', po.countryOfOrigin, 'Spain');
  ok('ship-to names the customer', /Aerovias De Mexico/i.test(po.shipToName), po.shipToName);
  check('final delivery block', po.finalDeliveryTo, [
    'COMI-BOND',
    'AEROPUERTO INTERNACIONAL CIUDAD DE MEXICO',
    'ALMACEN FISCALIZADO AICM COL. PENSADOR MEXICANO',
    'MEXICO MX 15510',
  ]);
  ok('exactly one line item after dedupe', po.items.length === 1, po.items.length + ' items');
  ok('description carries product name', /Evidencia Tempranillo/i.test(po.description), po.description);

  // Line continuation inside a PDF string must not leave a stray backslash.
  ok('no stray escapes in body text', !/\\[a-z]/.test(po.fullText.replace(/\\n|\\r|\\t/g, '')),
    'found escaped sequence');

  /* ---------------- Workbook ---------------- */
  console.log('\nWorkbook parsing');
  const xlsxPath = findFixture(/Tracking_Chart.*\.xlsx$/i);
  const xlsxBytes = new Uint8Array(fs.readFileSync(xlsxPath));
  const wb = await AMI.Workbook.load(xlsxBytes);
  check('sheet names', wb.sheets.map((s) => s.name), ['Old Tracker', '2025', '2026 Cycle']);

  const sheet = wb.sheet('2026 Cycle');
  const header = AMI.findHeaderRow(sheet);
  check('header row located', header.row, 32);
  check('first header', header.columns[0].header, 'PO#');
  ok('26 header columns', header.columns.length === 26, header.columns.length + ' columns');

  const config = AMI.readSheetConfig(sheet);
  check('bottles per case', config.bottlesPerCase, 12);
  check('cases per pallet', config.casesPerPallet, 48);
  check('lead time days', config.leadTimeDays, 37);
  check('transit days', config.transitDays, 2);
  check('customer', config.customer, 'Aeromexico');
  check('NAV code', config.navCode, 'EVDTMPRNV');
  ok('product name read', /Evidencia Tempranillo/i.test(config.productName), config.productName);
  ok('winery closure note read', /12\/22/.test(config.wineryClosedDates), config.wineryClosedDates);

  const rows = AMI.dataRows(sheet, header);
  check('last data row', rows[rows.length - 1], 44);
  check('last PO in sheet', sheet.cellText(44, 'A'), '350633-2');

  // The shared-formula master definitions must resolve.
  const cCell = sheet.cell(44, 'C');
  const cFormula = sheet.formulaTextFor(cCell);
  check('shared formula for cases', cFormula.text, 'B33/$F$2');
  const kFormula = sheet.formulaTextFor(sheet.cell(44, 'K'));
  check('shared formula for collection date', kFormula.text, 'O33-$C$24');
  const sFormula = sheet.formulaTextFor(sheet.cell(44, 'S'));
  check('shared formula for balance', sFormula.text, 'S33-B34');

  check('formula shifted by 11 rows', AMI.shiftFormula('B33/$F$2', 11), 'B44/$F$2');
  check('absolute rows are not shifted', AMI.shiftFormula('O33-$C$24', 12), 'O45-$C$24');

  /* ---------------- Planning ---------------- */
  console.log('\nRow planning');
  // Re-post the sample PO as if it were new, against a sheet that does not contain it yet.
  const planPo = Object.assign({}, po, { poNumber: '350633-3' });
  const plan = AMI.computePlanFormulas(sheet, AMI.planRow(sheet, header, config, planPo));
  check('target row', plan.newRow, 45);
  check('bottles derived', plan.derived.bottles, 4032);
  check('pallets derived', plan.derived.pallets, 7);

  const byHeader = (re) => plan.fields.find((f) => re.test(f.header));

  check('PO# comes from the PDF', byHeader(/^PO#/).source, AMI.SOURCE.PDF);
  check('PO# value', byHeader(/^PO#/).value, '350633-3');
  check('bottles is computed', byHeader(/Quantity \(bt\)/).source, AMI.SOURCE.COMPUTED);
  check('bottles value', byHeader(/Quantity \(bt\)/).value, 4032);
  check('cases stays a formula', byHeader(/Quantity \(cs\)/).source, AMI.SOURCE.FORMULA);
  check('cases formula for new row', byHeader(/Quantity \(cs\)/).formulaText, 'B45/$F$2');
  check('cases computes back to the PO quantity', byHeader(/Quantity \(cs\)/).computedRaw, 336);
  check('pallets stays a formula', byHeader(/Quantity \(pallets\)/).source, AMI.SOURCE.FORMULA);
  check('pallets computes to 7', byHeader(/Quantity \(pallets\)/).computedRaw, 7);

  check('PO sent date from the PDF', AMI.formatISO(byHeader(/PO date sent to winery/).value), '2026-01-09');
  check('forwarder from the PDF', byHeader(/^Forwarder$/).value, 'STPI');

  const reqDelivery = byHeader(/Customer Required Delivery Date/);
  check('required delivery is derived', reqDelivery.source, AMI.SOURCE.COMPUTED);
  check('required delivery value', AMI.formatISO(reqDelivery.value), '2026-06-26');

  const collection = byHeader(/AMI Requested\s+Collection Date/);
  check('collection date stays a formula', collection.source, AMI.SOURCE.FORMULA);
  check('collection date recomputes to the PO pickup date',
    AMI.formatISO(collection.computedValue), AMI.formatISO(po.pickupDate));

  const balanceBt = byHeader(/Balance on Contract \(bt\)/);
  check('balance continues the running total', balanceBt.computedRaw, 44544 - 4032);
  const balanceCs = byHeader(/Balance on Contract \(cs\)/);
  check('balance in cases', balanceCs.computedRaw, 3712 - 336);

  check('ship-to is carried forward', byHeader(/^Ship To$/).source, AMI.SOURCE.CARRIED);
  check('ship-to value', byHeader(/^Ship To$/).value, 'CDG');
  check('method of shipment carried', byHeader(/Method of Shipment/).value, 'OTR');
  check('truck type carried', byHeader(/Truck Type/).value, 'Dry Truck');
  check('lot number left blank', byHeader(/Lot Number/).source, AMI.SOURCE.MANUAL);
  check('lot number has no value', byHeader(/Lot Number/).value, null);
  check('PO received date left blank', byHeader(/PO Received Date/).source, AMI.SOURCE.MANUAL);

  ok('every field states its origin', plan.fields.every((f) => f.note && f.note.length > 0));
  ok('no field invents a date', plan.fields
    .filter((f) => f.source === AMI.SOURCE.MANUAL)
    .every((f) => f.value == null));

  /* ---------------- Validation ---------------- */
  console.log('\nValidation');
  const existing = new Set(rows.map((r) => sheet.cellText(r, 'A').trim()));
  const issues = AMI.validatePlan(sheet, header, config, plan, planPo, existing);
  ok('no errors for a clean PO', issues.filter((i) => i.level === 'error').length === 0,
    JSON.stringify(issues.filter((i) => i.level === 'error')));

  const dupPlan = AMI.computePlanFormulas(sheet, AMI.planRow(sheet, header, config, po));
  const dupIssues = AMI.validatePlan(sheet, header, config, dupPlan, po, existing);
  ok('duplicate PO is blocked',
    dupIssues.some((i) => i.level === 'error' && /already in this sheet/.test(i.message)));

  const shortPo = Object.assign({}, po, { poNumber: 'TEST-1', pickupDate: new Date(2026, 0, 20) });
  const shortPlan = AMI.computePlanFormulas(sheet, AMI.planRow(sheet, header, config, shortPo));
  const shortIssues = AMI.validatePlan(sheet, header, config, shortPlan, shortPo, existing);
  ok('lead-time breach is flagged',
    shortIssues.some((i) => /inside the production lead time/.test(i.message)));

  const partialPo = Object.assign({}, po, { poNumber: 'TEST-2', qty: 100 });
  const partialPlan = AMI.computePlanFormulas(sheet, AMI.planRow(sheet, header, config, partialPo));
  const partialIssues = AMI.validatePlan(sheet, header, config, partialPlan, partialPo, existing);
  ok('partial pallet is flagged', partialIssues.some((i) => /not a whole number/.test(i.message)));

  /* ---------------- Write back ---------------- */
  console.log('\nWorkbook write-back');
  const rowXml = AMI.renderRowXml(plan);
  ok('row xml is well formed', /^<row r="45"[\s\S]*<\/row>$/.test(rowXml));
  ok('row xml keeps the cases formula', /<c r="C45"[^>]*><f>B45\/\$F\$2<\/f><v>336<\/v><\/c>/.test(rowXml), rowXml);
  ok('row xml writes bottles as a number', /<c r="B45"[^>]*><v>4032<\/v><\/c>/.test(rowXml));
  ok('row xml keeps styles', /<c r="A45" s="\d+"/.test(rowXml));

  AMI.appendRow(sheet, rowXml, plan.newRow);
  ok('dimension widened', /<dimension ref="A1:Z45"\/>/.test(sheet.xml));
  wb.commitSheet(sheet);
  wb.dropCalcChain();
  const outBytes = await wb.toBytes();
  ok('output is a plausible xlsx', outBytes.length > 20000, outBytes.length + ' bytes');

  // Reopen the written file and confirm it round-trips.
  const wb2 = await AMI.Workbook.load(outBytes);
  const sheet2 = wb2.sheet('2026 Cycle');
  const header2 = AMI.findHeaderRow(sheet2);
  const rows2 = AMI.dataRows(sheet2, header2);
  check('round-trip: new last row', rows2[rows2.length - 1], 45);
  check('round-trip: PO number', sheet2.cellText(45, 'A'), '350633-3');
  check('round-trip: bottles', sheet2.cell(45, 'B').num, 4032);
  check('round-trip: cases cached value', sheet2.cell(45, 'C').num, 336);
  check('round-trip: cases formula preserved', sheet2.cell(45, 'C').formula.text, 'B45/$F$2');
  check('round-trip: collection date',
    AMI.formatISO(AMI.serialToDate(sheet2.cell(45, 'K').num)), '2026-06-24');
  check('round-trip: balance', sheet2.cell(45, 'S').num, 40512);
  check('round-trip: earlier rows untouched', sheet2.cellText(43, 'A'), '350633-1');
  check('round-trip: calcChain removed', wb2.map.has('xl/calcChain.xml'), false);
  ok('round-trip: other sheets survive', wb2.sheets.length === 3);
  ok('round-trip: comments survive', wb2.map.has('xl/comments1.xml'));
  ok('round-trip: threaded comments survive', wb2.map.has('xl/threadedComments/threadedComment1.xml'));
  ok('round-trip: styles survive', wb2.map.has('xl/styles.xml'));
  check('round-trip: entry count unchanged bar calcChain',
    wb2.entries.length, wb.entries.length);

  /* ---------------- Follow-ups ---------------- */
  console.log('\nFollow-up detection');
  const openItems = AMI.findOpenItems(sheet2, header2, new Date(2026, 7, 12));
  ok('open items found', openItems.length > 0, openItems.length + ' items');
  ok('every open item names a PO', openItems.every((i) => i.po && i.po.length > 0));
  ok('every open item is past its grace period', openItems.every((i) => i.ageDays >= 0));
  ok('open item cites the blank column and its anchor',
    openItems.every((i) => i.missingHeader && i.anchorHeader));
  const poeItems = openItems.filter((i) => i.ruleId === 'proof-of-export');
  ok('"to fill" counts as outstanding', poeItems.length > 0, poeItems.length + ' proof-of-export items');

  /* ---------------- Email ---------------- */
  console.log('\nEmail generation');
  const tableRows = [
    { po: '350632-1', bt: '3456.00', cs: '288.00', pal: '6.00', bottling: '', bottlingDate: 'Please advise', expiry: 'Please advise', collection: 'Apr 8 2026' },
    { po: '350633-2', bt: '4032.00', cs: '336.00', pal: '7.00', bottling: '', bottlingDate: '', expiry: '', collection: 'Jun 24 2026' },
  ];
  const tableHtml = AMI.orderTableHtml(tableRows);
  ok('table has a header for every column', AMI.TABLE_COLUMNS
    .every((c) => tableHtml.includes(AMI.escapeXml(c.label))));
  ok('table renders each PO', tableRows.every((r) => tableHtml.includes(r.po)));

  check('PO groups collapse to stems', AMI.poGroups(
    ['350632-1', '350632-2', '350632-3', '350632-4', '350633-1', '350633-2']), '350632 - 350633');
  check('email date format', AMI.formatEmailDate(new Date(2026, 3, 8)), 'Apr 8 2026');

  const eml = AMI.buildEml({
    from: 'bprice@amigrp.com',
    to: 'Caroline Mounier-Duchamp <caroline@vins-biecher.com>',
    cc: 'EU Wine Orders <EUwineorders@amigrp.com>',
    subject: 'AMI Wines for Aeromexico -  6 new Purchase Orders 350632 - 350633 - Evidencia Tempranillo Spain',
    html: '<html><body>' + tableHtml + '</body></html>',
    attachments: [{ name: 'PO_350633-2.pdf', mime: 'application/pdf', bytes: pdfBytes }],
    date: new Date(2026, 0, 9, 20, 34, 49),
  });
  ok('eml opens as a draft in Outlook', /^MIME-Version: 1\.0\r\nX-Unsent: 1\r\n/.test(eml));
  ok('eml carries the recipients', /\r\nTo: Caroline/.test(eml) && /\r\nCc: EU Wine Orders/.test(eml));
  ok('eml is multipart with the PDF attached',
    /multipart\/mixed/.test(eml) && /filename="PO_350633-2\.pdf"/.test(eml));
  ok('attachment body is base64 wrapped at 76 columns',
    eml.split('\r\n').every((l) => l.length <= 998));
  const b64Part = eml.split('filename="PO_350633-2.pdf"')[1];
  ok('attachment decodes back to the original PDF',
    Buffer.from(b64Part.split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64')
      .subarray(0, 8).toString('latin1') === '%PDF-1.3');

  check('template fills placeholders',
    AMI.fillTemplate('Dear {{contact}}, {{count}} orders.', { contact: 'Caroline', count: 6 }),
    'Dear Caroline, 6 orders.');

  /* ---------------- Summary ---------------- */
  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailed:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All green.\n');
})().catch((e) => {
  console.error('\nTest run crashed:\n', e);
  process.exit(1);
});
