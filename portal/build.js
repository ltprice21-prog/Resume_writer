#!/usr/bin/env node
/* Inline the sources into self-contained HTML files.
 *
 *   node portal/build.js
 *
 * Outputs:
 *   portal/AMI-Order-Desk.html        single-account portal
 *   portal/AMI-Order-Desk-Teams.html  multi-account portal with shared templates
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// A literal </script> inside a script block would close it early.
const guard = (js, label) => {
  if (/<\/script/i.test(js)) throw new Error(label + ' contains a literal </script>; escape it before inlining.');
  return js;
};

const TARGETS = [
  {
    out: 'AMI-Order-Desk.html',
    shell: 'shell.html',
    parts: { STYLES: 'styles.css', ENGINE: 'engine.js', PERSIST: 'persist.js', APP: 'app.js' },
  },
  {
    out: 'AMI-Order-Desk-Teams.html',
    shell: 'shell-teams.html',
    parts: {
      STYLES: 'styles.css',
      ENGINE: 'engine.js',
      TEMPLATES: 'templates.js',
      AIRPORTS: 'airports.js',
      WORKSPACE: 'workspace.js',
      PERSIST: 'persist.js',
      STATUS: 'status.js',
      CHARTS: 'charts.js',
      APP: 'app-teams.js',
    },
  },
];

for (const target of TARGETS) {
  let html = read(target.shell);
  for (const [marker, file] of Object.entries(target.parts)) {
    const token = '/*' + marker + '*/';
    if (!html.includes(token)) throw new Error(target.out + ': shell has no ' + token + ' marker.');
    const body = file.endsWith('.css') ? read(file) : guard(read(file), file);
    html = html.replace(token, () => body);
  }
  const leftover = html.match(/\/\*[A-Z]+\*\//g);
  if (leftover) throw new Error(target.out + ': unreplaced markers ' + leftover.join(', '));

  const outPath = path.join(__dirname, target.out);
  fs.writeFileSync(outPath, html);
  console.log('Built ' + path.relative(process.cwd(), outPath)
    + '  (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB, single file, no dependencies)');
}
