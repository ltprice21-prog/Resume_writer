/* Tests for editing tracker rows in place — no fixtures.
 *
 *   node portal/tests/trackeredit.test.js
 */
require('../src/engine.js');
const AMI = require('../src/workspace.js');

let passed = 0, failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { failed++; failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : '')); }
};
const ENC = new TextEncoder();
const serial = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;

const str = (ref, t, s) => '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + ' t="inlineStr"><is><t>' + t + '</t></is></c>';
const num = (ref, v, s) => '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + '><v>' + v + '</v></c>';

const HEAD = ['PO#', 'Quantity (cs)', 'Total (cs x 2)', 'Actual Collection Date', 'Notes', 'Balance on Contract (cs)', 'NAV INV #'];
const rows = [
  '<row r="1" spans="1:7">' + HEAD.map((h, i) => str(String.fromCharCode(65 + i) + '1', h)).join('') + '</row>',
  '<row r="2" spans="1:7">' + str('A2', 'P-1') + num('B2', 10) + '<c r="C2"><f t="shared" ref="C2:C4" si="0">B2*2</f><v>20</v></c>'
    + num('D2', serial(2026, 8, 1), 5) + str('E2', 'first') + '<c r="F2"><f>1000-B2</f><v>990</v></c>' + num('G2', 415001) + '</row>',
  '<row r="3" spans="1:7">' + str('A3', 'P-2') + num('B3', 20) + '<c r="C3"><f t="shared" si="0"/><v>40</v></c>'
    + '<c r="F3"><f>F2-B3</f><v>970</v></c></row>',
  '<row r="4">' + str('A4', 'P-3') + num('B4', 5) + '<c r="C4"><f t="shared" si="0"/><v>10</v></c>'
    + '<c r="F4"><f>F3-B4</f><v>965</v></c></row>',
].join('');

async function book() {
  const bytes = await AMI.zip([
    { name: '[Content_Types].xml', bytes: ENC.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'xl/workbook.xml', bytes: ENC.encode('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', bytes: ENC.encode('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', bytes: ENC.encode('<worksheet><dimension ref="A1:G4"/><sheetData>' + rows + '</sheetData></worksheet>') },
  ]);
  const wb = await AMI.Workbook.load(bytes);
  const sheet = wb.sheet('S');
  return { wb, sheet, header: AMI.findHeaderRow(sheet) };
}

const reload = async (wb) => {
  const w = await AMI.Workbook.load(await wb.toBytes());
  const sheet = w.sheet('S');
  return { w, sheet, header: AMI.findHeaderRow(sheet) };
};

(async () => {
  console.log('Column kinds');
  let { wb, sheet, header } = await book();
  const kind = (col) => AMI.columnKind(sheet, header, col);
  ok('a date heading is a date', kind('D') === 'date');
  ok('a column of numbers is a number', kind('B') === 'number' && kind('G') === 'number');
  ok('a column of words is text', kind('E') === 'text');

  console.log('\nParsing what was typed');
  ok('a date is read as a serial', AMI.parseCellInput('date', '2026-09-30').value === serial(2026, 9, 30));
  ok('a bad date is refused', !!AMI.parseCellInput('date', 'soon').error);
  ok('a number may carry a thousands comma', AMI.parseCellInput('number', '1,250').value === 1250);
  ok('words in a number column are refused', !!AMI.parseCellInput('number', 'ten').error);
  ok('blank clears', AMI.parseCellInput('text', '  ').value === '');

  console.log('\nEditing');
  AMI.applyCellEdits(wb, sheet, header, [
    { row: 3, col: 'B', value: '30' },
    { row: 3, col: 'D', value: '2026-09-30' },
    { row: 3, col: 'E', value: 'collected & sealed <ok>' },
    { row: 3, col: 'G', value: '416002' },
  ]);
  ({ w: wb, sheet, header } = await reload(wb));
  ok('a number is written', sheet.cell(3, 'B').num === 30);
  ok('a date is written as a serial', sheet.cell(3, 'D').num === serial(2026, 9, 30));
  ok('and takes the column\'s date style', sheet.cell(3, 'D').style === '5');
  ok('text is written and escaped', sheet.cell(3, 'E').text === 'collected & sealed <ok>');
  ok('a cell that did not exist is added', sheet.cell(3, 'G').num === 416002);
  ok('cells stay in column order', [...sheet.rows.get(3).cells.keys()].join('') === 'ABCDEFG');
  ok('other rows are untouched', sheet.cell(2, 'E').text === 'first' && sheet.cell(2, 'B').num === 10);

  console.log('\nFormulas');
  ok('a shared formula is still shared', sheet.cell(3, 'C').formula && /t="shared"/.test(sheet.cell(3, 'C').formula.attrs));
  ok('the master is intact', sheet.cell(2, 'C').formula.text === 'B2*2');
  ok('its cached result follows the input', sheet.cell(3, 'C').num === 60);
  ok('so does a running balance', sheet.cell(3, 'F').num === 960 && sheet.cell(4, 'F').num === 955,
    sheet.cell(3, 'F').num + ' / ' + sheet.cell(4, 'F').num);
  ok('rows above the edit are not recalculated', sheet.cell(2, 'F').num === 990);
  ok('Excel is told to recalculate on open', /fullCalcOnLoad="1"/.test(new TextDecoder().decode(wb.map.get('xl/workbook.xml').bytes)));

  const before = sheet.xml;
  let msg = '';
  try { AMI.applyCellEdits(wb, sheet, header, [{ row: 4, col: 'E', value: 'fine' }, { row: 4, col: 'C', value: '99' }]); } catch (e) { msg = e.message; }
  ok('a formula cell is refused, naming it', /Total \(cs x 2\)/.test(msg) && /formula/.test(msg), msg);
  ok('and refuses the whole batch, not just that cell', sheet.xml === before && sheet.cell(4, 'E') === null);
  msg = '';
  try { AMI.applyCellEdits(wb, sheet, header, [{ row: 4, col: 'D', value: 'whenever' }]); } catch (e) { msg = e.message; }
  ok('an unreadable date is refused', /not a date/.test(msg) && /Nothing was changed/.test(msg), msg);

  console.log('\nClearing');
  AMI.applyCellEdits(wb, sheet, header, [{ row: 3, col: 'E', value: '' }]);
  ({ w: wb, sheet, header } = await reload(wb));
  ok('a blank clears the cell and keeps it', sheet.cell(3, 'E') && sheet.cell(3, 'E').text === '');

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})();
