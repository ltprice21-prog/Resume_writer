/* Tests for template ingestion and the multi-account workspace model.
 *
 *   node portal/tests/teams.test.js [fixturesDir]
 */
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
require('../src/templates.js');
const AMI = require('../src/workspace.js');

const FIXTURES = process.argv[2] || process.env.AMI_FIXTURES
  || '/root/.claude/uploads/ce5dd401-299f-5618-9ee9-da4319624cf3';

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { failed++; failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  (' + detail + ')' : '')); }
}

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
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

const ENC = new TextEncoder();

/** In-memory store matching the interface workspace.js expects. */
function memoryStore(seed) {
  const files = new Map(seed || []);
  return {
    files,
    async read(p) { return files.has(p) ? files.get(p) : null; },
    async write(p, b) { files.set(p, b); },
    async list(dir) {
      const prefix = dir ? dir.replace(/\/$/, '') + '/' : '';
      const seen = new Map();
      for (const key of files.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash < 0) seen.set(rest, 'file');
        else seen.set(rest.slice(0, slash), 'directory');
      }
      return [...seen].map(([name, kind]) => ({ name, kind }));
    },
    async remove(p) { files.delete(p); },
  };
}

/** Build a minimal but valid .docx so the Word path is covered without a binary fixture. */
async function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => {
    if (p.table) {
      return '<w:tbl>' + p.table.map((row) => '<w:tr>' + row.map((cell) =>
        '<w:tc><w:p><w:r><w:t>' + cell + '</w:t></w:r></w:p></w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>';
    }
    const style = p.style ? '<w:pPr><w:pStyle w:val="' + p.style + '"/></w:pPr>' : '';
    const list = p.list ? '<w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>' : '';
    const bold = p.bold ? '<w:rPr><w:b/></w:rPr>' : '';
    return '<w:p>' + style + list + '<w:r>' + bold + '<w:t xml:space="preserve">' + p.text + '</w:t></w:r></w:p>';
  }).join('');

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + body + '</w:body></w:document>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  return AMI.zip([
    { name: '[Content_Types].xml', bytes: ENC.encode(contentTypes) },
    { name: '_rels/.rels', bytes: ENC.encode(rels) },
    { name: 'word/document.xml', bytes: ENC.encode(documentXml) },
  ]);
}

(async () => {
  console.log('\nOutlook .msg ingestion');
  const msgBytes = new Uint8Array(fs.readFileSync(fixture(/\.msg$/i)));
  const msg = await AMI.parseTemplateFile(msgBytes, 'vendor-order.msg');
  check('format detected', msg.format, 'Outlook message (.msg)');
  ok('subject read', /6 new Purchase Orders 350632 - 350633/.test(msg.subject), msg.subject);
  ok('display recipients read', /Caroline Mounier-Duchamp/.test(msg.to) && /EU Wine Orders/.test(msg.cc),
    msg.to + ' | ' + msg.cc);
  ok('body recovered as HTML', /HTML/i.test(msg.bodySource), msg.bodySource);
  ok('greeting preserved', /Dear Caroline/.test(msg.html));
  ok('breakdown table preserved as a real table', /<table/i.test(msg.html));
  ok('every PO row survived', ['350632-1', '350632-2', '350632-3', '350632-4', '350633-1', '350633-2']
    .every((p) => msg.html.includes(p)));
  ok('standing instructions preserved', /PALLETS NOT TO BE HIGHER THAN 160 CM/.test(msg.html));
  ok('final delivery block preserved', /COMI-BOND/.test(msg.html));
  ok('document instruction preserved verbatim', /sent to the above email address/i.test(msg.html));
  ok('signature block preserved', /amigrp/i.test(msg.html));
  ok('rtf-only list bullets are not leaked into the markup', !/\*\t/.test(msg.html),
    (msg.html.match(/.{0,40}\*\t.{0,40}/) || [''])[0]);
  ok('html not wrapped in a document shell', !/<html|<body|<!DOCTYPE/i.test(msg.html));

  console.log('\nRTF plumbing');
  ok('de-encapsulation refuses non-html rtf', AMI.deEncapsulateHtml('{\\rtf1\\ansi hello}') === null);
  ok('rtf stripped to text as a fallback',
    AMI.rtfToText('{\\rtf1\\ansi\\b Bold\\b0\\par Next}').includes('Bold'));

  console.log('\n.docx ingestion');
  const docx = await makeDocx([
    { text: 'Subject: Collection booking {{poList}}' },
    { text: 'Dear {{recipientName}},' },
    { text: 'Please collect the following:', bold: true },
    { table: [['PO', 'Pallets'], ['{{poList}}', '{{totalPallets}}']] },
    { text: 'Collection address', style: 'Heading2' },
    { text: '{{collectionAddress}}', list: true },
    { text: '{{deliveryAddress}}', list: true },
  ]);
  const doc = await AMI.parseTemplateFile(docx, 'trucker.docx');
  check('docx format', doc.format, 'Word (.docx)');
  check('leading Subject: line becomes the subject', doc.subject, 'Collection booking {{poList}}');
  ok('subject line removed from the body', !/Subject:/.test(doc.html), doc.html.slice(0, 80));
  ok('bold run preserved', /<strong>Please collect the following:<\/strong>/.test(doc.html), doc.html);
  ok('table rendered', /<table[\s\S]*Pallets[\s\S]*<\/table>/.test(doc.html));
  ok('heading rendered', /<h2>Collection address<\/h2>/.test(doc.html));
  ok('list items wrapped in a list', /<ul>\s*<li>\{\{collectionAddress\}\}<\/li>/.test(doc.html), doc.html);
  check('placeholders discovered', AMI.templatePlaceholders(doc.html + ' ' + doc.subject),
    ['recipientName', 'poList', 'totalPallets', 'collectionAddress', 'deliveryAddress']);

  console.log('\n.eml and text ingestion');
  const eml = ['MIME-Version: 1.0', 'Subject: =?UTF-8?B?' + Buffer.from('Delivery update — Aeroméxico').toString('base64') + '?=',
    'To: ops@example.com', 'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable',
    '', '<html><body><p>Dear {{recipientName}},</p><p>Total =3D {{totalCases}} cases.</p></body></html>'].join('\r\n');
  const emlParsed = await AMI.parseTemplateFile(ENC.encode(eml), 'update.eml');
  check('eml subject decoded from RFC2047', emlParsed.subject, 'Delivery update — Aeroméxico');
  ok('quoted-printable decoded', /Total = \{\{totalCases\}\} cases/.test(emlParsed.html), emlParsed.html);
  ok('eml body unwrapped', !/<body/i.test(emlParsed.html));

  const txt = await AMI.parseTemplateFile(ENC.encode('Subject: Quick note\n\nHello {{recipientName}},\n\nThanks.'), 'note.txt');
  check('txt subject', txt.subject, 'Quick note');
  ok('txt body paragraphed', /<p>Hello \{\{recipientName\}\},<\/p>/.test(txt.html), txt.html);

  const html = await AMI.parseTemplateFile(ENC.encode('<html><head><title>Ack</title></head><body><p>Hi</p></body></html>'), 't.html');
  check('html title becomes subject', html.subject, 'Ack');
  check('html body extracted', html.html, '<p>Hi</p>');

  ok('unsupported format is refused clearly', await (async () => {
    try { await AMI.parseTemplateFile(ENC.encode('x'), 'a.pages'); return false; }
    catch (e) { return /Unsupported template format/.test(e.message); }
  })());

  console.log('\nPlaceholder assistance');
  const literal = '<p>Dear Caroline Mounier-Duchamp,</p><p>Orders for Aeromexico.</p>';
  const suggestions = AMI.suggestPlaceholders(literal, {
    vendorContact: 'Caroline Mounier-Duchamp', customer: 'Aeromexico', product: 'Nothing Here',
  });
  check('only values actually present are suggested', suggestions.map((s) => s.key).sort(), ['customer', 'vendorContact']);
  const swapped = AMI.applyPlaceholderSuggestions(literal, suggestions);
  ok('substitution applied', swapped.includes('{{vendorContact}}') && swapped.includes('{{customer}}'), swapped);
  ok('nothing is changed without confirmation', literal.includes('Caroline Mounier-Duchamp'));

  console.log('\nWorkspace schema and items');
  const ws = AMI.normaliseWorkspace({
    divisions: [{ id: 'europe', name: 'Europe' }, { id: 'us', name: 'US' }],
    accounts: [
      {
        id: 'aeromexico', name: 'Aeromexico', divisionId: 'europe',
        items: [
          { id: 'evidencia', name: 'Evidencia Tempranillo', trackerPath: 'trackers/evidencia.xlsx', sheet: '2026 Cycle' },
          { id: 'montenero', name: 'Montenero', trackerPath: 'trackers/montenero.xlsx' },
          { id: 'blanco', name: 'Blanco', trackerPath: 'trackers/blanco.xlsx' },
        ],
      },
      { id: 'delta', name: 'Delta', divisionId: 'us', items: [{ id: 'd1', name: 'Delta Red', trackerPath: 'trackers/delta.xlsx' }] },
      { id: 'ba', name: 'British Airways', divisionId: 'europe', items: [{ id: 'b1', name: 'BA White', trackerPath: 'trackers/ba.xlsx' }] },
    ],
    users: [
      { id: 'bo', name: 'Bo Price', divisionId: 'us', accountIds: ['delta'] },
      { id: 'eu1', name: 'EU Coordinator', divisionId: 'europe', accountIds: [] },
      { id: 'admin', name: 'Admin', divisionId: 'us', isAdmin: true },
    ],
  });
  check('no structural issues', AMI.validateWorkspace(ws).filter((i) => i.level === 'error'), []);
  check('an account carries several items',
    AMI.accountItems(ws.accounts[0]).map((i) => i.name),
    ['Evidencia Tempranillo', 'Montenero', 'Blanco']);
  check('items are addressable by id', AMI.findItem(ws.accounts[0], 'montenero').trackerPath, 'trackers/montenero.xlsx');
  check('an unknown item id yields null', AMI.findItem(ws.accounts[0], 'nope'), null);

  const added = AMI.addItem(ws.accounts[0], 'Montenero');
  ok('adding an item with a clashing name gets its own id', added.id !== 'montenero', added.id);
  check('the new item starts with no tracker', added.trackerPath, '');
  ws.accounts[0].items = ws.accounts[0].items.filter((i) => i !== added);

  // The old auto-close rule moved invoiced orders to a separate closed stage.
  // The stages are one now, so a workspace file carrying the flag must not
  // resurrect a rule that no longer has anything to do.
  ok('the retired auto-close flag is dropped, not honoured',
    !('autoCloseInvoiced' in AMI.normaliseWorkspace({ settings: { autoCloseInvoiced: false } }).settings));
  check('finished orders are shown unless someone hides them',
    AMI.normaliseWorkspace({}).settings.excludeClosed, false);
  check('and that choice round-trips',
    AMI.normaliseWorkspace({ settings: { excludeClosed: true } }).settings.excludeClosed, true);

  console.log('\nLegacy single-tracker migration');
  const legacy = AMI.normaliseWorkspace({
    divisions: [{ id: 'europe', name: 'Europe' }],
    accounts: [{
      id: 'aeromexico', name: 'Aeromexico', divisionId: 'europe',
      product: 'Evidencia Tempranillo Spain',
      trackerPath: 'trackers/Aeromexico.xlsx', sheet: '2026 Cycle',
    }],
  });
  check('an old single-tracker account becomes one item', AMI.accountItems(legacy.accounts[0]).length, 1);
  check('its tracker is preserved', AMI.accountItems(legacy.accounts[0])[0].trackerPath, 'trackers/Aeromexico.xlsx');
  check('its sheet is preserved', AMI.accountItems(legacy.accounts[0])[0].sheet, '2026 Cycle');
  check('the item is named after the product', AMI.accountItems(legacy.accounts[0])[0].name, 'Evidencia Tempranillo Spain');

  console.log('\nVisibility');
  check('explicit assignment wins', AMI.accountsForUser(ws, 'bo').map((a) => a.id), ['delta']);
  check('unassigned user sees their whole division',
    AMI.accountsForUser(ws, 'eu1').map((a) => a.id), ['aeromexico', 'ba']);
  check('admin sees everything', AMI.accountsForUser(ws, 'admin').map((a) => a.id), ['aeromexico', 'delta', 'ba']);
  check('unknown user sees nothing', AMI.accountsForUser(ws, 'nobody'), []);
  check('accounts group by division',
    AMI.accountsByDivision(ws, AMI.accountsForUser(ws, 'admin')).map((g) => g.division.name + ':' + g.accounts.length),
    ['Europe:2', 'US:1']);

  console.log('\nWorkspace validation');
  const broken = AMI.normaliseWorkspace({
    divisions: [{ id: 'europe', name: 'Europe' }],
    accounts: [
      { id: 'x', name: 'X', divisionId: 'ghost', items: [{ id: 'i1', name: 'I1', trackerPath: 't.xlsx' }] },
      {
        id: 'y', name: 'Y', divisionId: 'europe',
        items: [
          { id: 'a', name: 'A', trackerPath: 'same.xlsx', sheet: '2026' },
          { id: 'b', name: 'B', trackerPath: 'same.xlsx', sheet: '2026' },
          { id: 'c', name: 'C', trackerPath: '' },
        ],
      },
      { id: 'z', name: 'Z', divisionId: 'europe', items: [] },
    ],
    users: [{ id: 'u', name: 'U', divisionId: 'europe', accountIds: ['missing'] }],
  });
  const brokenIssues = AMI.validateWorkspace(broken);
  ok('dangling division reference is an error',
    brokenIssues.some((i) => i.level === 'error' && /division that no longer exists/.test(i.message)));
  ok('dangling account assignment is a warning',
    brokenIssues.some((i) => i.level === 'warn' && /account that no longer exists/.test(i.message)));
  ok('two items pointing at the same sheet is an error',
    brokenIssues.some((i) => i.level === 'error' && /post to the same sheet of the same workbook/.test(i.message)),
    JSON.stringify(brokenIssues.filter((i) => i.level === 'error')));
  ok('an item with no tracker is a warning',
    brokenIssues.some((i) => i.level === 'warn' && /Item "C" on Y has no tracker/.test(i.message)));
  ok('an account with no items is a warning',
    brokenIssues.some((i) => i.level === 'warn' && /Account "Z" has no items/.test(i.message)));

  console.log('\nRouting a PO to the right item tracker');
  const routingItems = AMI.accountItems(ws.accounts[0]);
  const configs = {
    evidencia: { navCode: 'EVDTMPRNV', productName: 'Evidencia Tempranillo Spain (Vino Tinto Espanol Tempranillo Evidencia)' },
    montenero: { navCode: 'MONTENERO', productName: 'Montenero Rosso' },
    blanco: { navCode: 'BLANCONV', productName: 'Blanco' },
  };

  const byCode = AMI.matchItemForPo(routingItems, configs, { itemNo: 'EVDTMPRNV', description: 'Evidencia Tempranillo Spain' });
  check('item number routes the PO', byCode.item.id, 'evidencia');
  ok('and the match is confident', byCode.confident === true);
  ok('and it says why', /item number EVDTMPRNV/.test(byCode.reason), byCode.reason);

  const otherCode = AMI.matchItemForPo(routingItems, configs, { itemNo: 'MONTENERO', description: 'Montenero Rosso' });
  check('a different item number routes elsewhere', otherCode.item.id, 'montenero');

  const lowercase = AMI.matchItemForPo(routingItems, configs, { itemNo: ' evdtmprnv ', description: '' });
  check('matching ignores case and padding', lowercase.item.id, 'evidencia');

  const byName = AMI.matchItemForPo(routingItems, configs, { itemNo: '', description: 'Evidencia Tempranillo Spain' });
  check('description routes when there is no item number', byName.item.id, 'evidencia');
  ok('and says it fell back to the description', /description/.test(byName.reason), byName.reason);

  const unknown = AMI.matchItemForPo(routingItems, configs, { itemNo: 'NOSUCHCODE', description: 'Something else' });
  check('an unknown item number matches nothing', unknown.item, null);
  ok('rather than guessing the first item', /no item on this account has item number NOSUCHCODE/.test(unknown.reason),
    unknown.reason);

  const ambiguousConfigs = { evidencia: { navCode: 'DUP' }, montenero: { navCode: 'DUP' }, blanco: {} };
  const ambiguous = AMI.matchItemForPo(routingItems, ambiguousConfigs, { itemNo: 'DUP', description: '' });
  check('an ambiguous code refuses to pick', ambiguous.item, null);
  ok('and names the candidates', /Evidencia Tempranillo, Montenero/.test(ambiguous.reason), ambiguous.reason);

  const noCode = AMI.matchItemForPo(routingItems, configs, { itemNo: '', description: '' });
  check('a PO with nothing to match on is left unrouted', noCode.item, null);

  const override = AMI.matchItemForPo(
    [{ id: 'x', name: 'X', navCode: 'MANUAL1' }], {}, { itemNo: 'MANUAL1', description: '' });
  check('a stored item-number override is honoured', override.item.id, 'x');

  console.log('\nTemplate storage');
  const store = memoryStore();
  const saved = await AMI.saveTemplate(store, 'aeromexico', {
    label: 'Vendor order', role: 'vendor', subject: 'Orders {{poGroups}}',
    html: '<p>Dear {{vendorContact}}</p>', source: 'vendor-order.msg',
  });
  ok('template written to the account folder', store.files.has('templates/aeromexico/vendor-order.html'),
    [...store.files.keys()].join(', '));
  const listed = await AMI.listTemplates(store, 'aeromexico');
  check('template listed back', listed.length, 1);
  check('label round-trips', listed[0].label, 'Vendor order');
  check('subject round-trips', listed[0].subject, 'Orders {{poGroups}}');
  check('body round-trips', listed[0].html, '<p>Dear {{vendorContact}}</p>');
  check('role round-trips', listed[0].role, 'vendor');
  check('source recorded', listed[0].source, 'vendor-order.msg');
  check('an unscoped template applies to every item', listed[0].itemId, '');

  await AMI.saveTemplate(store, 'aeromexico', {
    label: 'Montenero vendor order', role: 'vendor', itemId: 'montenero',
    subject: 'Montenero {{poGroups}}', html: '<p>Item only</p>',
  });
  const scoped = (await AMI.listTemplates(store, 'aeromexico')).find((t) => t.label === 'Montenero vendor order');
  check('a template can be scoped to one item', scoped.itemId, 'montenero');
  await AMI.deleteTemplate(store, 'aeromexico', scoped.id);

  const second = await AMI.saveTemplate(store, 'aeromexico', { label: 'Vendor order', role: 'vendor', html: '<p>x</p>' });
  ok('a clashing name gets its own id', second.id !== saved.id, saved.id + ' vs ' + second.id);
  check('both templates listed', (await AMI.listTemplates(store, 'aeromexico')).length, 2);

  await AMI.deleteTemplate(store, 'aeromexico', second.id);
  check('deletion removes just the one', (await AMI.listTemplates(store, 'aeromexico')).length, 1);
  check('other accounts are unaffected', (await AMI.listTemplates(store, 'delta')).length, 0);

  const malformed = memoryStore([['templates/x/bad.html', ENC.encode('<!--ami-template\nnot json\n-->\n<p>hi</p>')]]);
  const badList = await AMI.listTemplates(malformed, 'x');
  ok('a corrupt template is reported, not thrown', badList.length === 1 && !!badList[0].error, JSON.stringify(badList[0]));

  console.log('\nWorkspace persistence');
  const wsStore = memoryStore();
  const fresh = await AMI.loadWorkspace(wsStore);
  ok('missing config yields a usable default', fresh.created === true && fresh.workspace.divisions.length === 2);
  const savedWs = await AMI.saveWorkspace(wsStore, ws, { by: 'Bo Price' });
  ok('config written', wsStore.files.has('workspace.json'));
  const reread = await AMI.loadWorkspace(wsStore);
  check('accounts survive the round trip', reread.workspace.accounts.map((a) => a.id), ['aeromexico', 'delta', 'ba']);
  check('workspace settings survive too', reread.workspace.settings.excludeClosed, false);
  check('author recorded', JSON.parse(new TextDecoder().decode(wsStore.files.get('workspace.json'))).updatedBy, 'Bo Price');

  let stale = null;
  try {
    await AMI.saveWorkspace(wsStore, ws, { loadedAt: '2000-01-01T00:00:00.000Z', by: 'Someone else' });
  } catch (e) { stale = e; }
  ok('a colleague\'s newer version is not clobbered silently', stale && stale.code === 'STALE', String(stale));
  ok('the conflict names who changed it', stale && /Bo Price/.test(stale.message), stale && stale.message);
  const forced = await AMI.saveWorkspace(wsStore, ws, { force: true, by: 'Bo Price' });
  ok('an explicit override still works', !!forced.updated);

  console.log('\nRecipient resolution');
  const account = {
    name: 'Aeromexico', defaultCc: 'euwineorders@amigrp.com',
    contacts: {
      vendor: { name: 'Caroline', email: 'caroline@vins-biecher.com' },
      trucker: { name: 'Steffy Demouchy', email: 'sdemouchy@stpicargo.com', cc: 'comat@stpicargo.com' },
      customer: { name: 'Aeromexico Ops', email: 'ops@aeromexico.example' },
      internal: {},
    },
  };
  const plainItem = { name: 'Evidencia', contacts: { vendor: {}, trucker: {}, customer: {}, internal: {} } };
  const ownContactItem = {
    name: 'Montenero',
    contacts: {
      vendor: { name: 'Montenero Cellars', email: 'orders@montenero.example' },
      trucker: { name: 'Alt Freight', email: 'ops@altfreight.example', cc: 'docs@altfreight.example' },
      customer: {}, internal: {},
    },
  };
  const po = { vendorContact: 'Caroline Mounier-Duchamp', vendorEmail: 'caroline@vins-biecher.com', docsTo: 'euwineorders@amigrp.com' };
  const user = { defaultCc: '' };

  const vendorTo = AMI.resolveRecipients(account, plainItem, 'vendor', po, user);
  check('vendor address comes from the PO', vendorTo.to, 'Caroline Mounier-Duchamp <caroline@vins-biecher.com>');
  check('and says so', vendorTo.toSource, 'vendor block on the PO');
  check('cc is deduplicated', vendorTo.cc, 'euwineorders@amigrp.com');

  const truckerTo = AMI.resolveRecipients(account, plainItem, 'trucker', po, user);
  check('trucker address falls back to the account', truckerTo.to, 'Steffy Demouchy <sdemouchy@stpicargo.com>');
  check('and says so', truckerTo.toSource, 'account contact');
  check('per-role cc is included', truckerTo.cc, 'euwineorders@amigrp.com; comat@stpicargo.com');

  const itemTrucker = AMI.resolveRecipients(account, ownContactItem, 'trucker', po, user);
  check('an item contact overrides the account', itemTrucker.to, 'Alt Freight <ops@altfreight.example>');
  check('and says which it used', itemTrucker.toSource, 'item contact');
  ok('both account and item ccs are carried',
    itemTrucker.cc.includes('comat@stpicargo.com') && itemTrucker.cc.includes('docs@altfreight.example'),
    itemTrucker.cc);

  const itemVendorNoPo = AMI.resolveRecipients(account, ownContactItem, 'vendor', null, user);
  check('without a PO the item vendor wins over the account', itemVendorNoPo.to,
    'Montenero Cellars <orders@montenero.example>');

  const internalTo = AMI.resolveRecipients(account, plainItem, 'internal', po, user);
  check('an unset contact yields no address, not a guess', internalTo.to, '');

  console.log('\nWorkbook discovery');
  const treeStore = memoryStore([
    ['trackers/Aeromexico.xlsx', ENC.encode('x')],
    ['trackers/2026/Delta.xlsx', ENC.encode('x')],
    ['templates/aeromexico/vendor.html', ENC.encode('x')],
    ['workspace.json', ENC.encode('{}')],
    ['trackers/~$Locked.xlsx', ENC.encode('x')],
  ]);
  const found = await AMI.findWorkbooks(treeStore, '', 3);
  check('workbooks found, lock files and templates skipped', found,
    ['trackers/2026/Delta.xlsx', 'trackers/Aeromexico.xlsx']);

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('\nFailed:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All green.\n');
})().catch((e) => { console.error('\nTest run crashed:\n', e); process.exit(1); });
