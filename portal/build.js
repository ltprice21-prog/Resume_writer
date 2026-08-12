#!/usr/bin/env node
/* Inline styles.css, engine.js and app.js into one self-contained HTML file.
 *
 *   node portal/build.js
 *
 * Output: portal/AMI-Order-Desk.html — the only file the end user needs.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'AMI-Order-Desk.html');

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const shell = read('shell.html');
const styles = read('styles.css');
const engine = read('engine.js');
const app = read('app.js');

// A literal </script> inside a script block would close it early.
const guard = (js, label) => {
  if (/<\/script/i.test(js)) throw new Error(label + ' contains a literal </script>; escape it before inlining.');
  return js;
};

const html = shell
  .replace('/*STYLES*/', () => styles)
  .replace('/*ENGINE*/', () => guard(engine, 'engine.js'))
  .replace('/*APP*/', () => guard(app, 'app.js'));

for (const marker of ['/*STYLES*/', '/*ENGINE*/', '/*APP*/']) {
  if (html.includes(marker)) throw new Error('Marker ' + marker + ' was not replaced.');
}

fs.writeFileSync(OUT, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('Built ' + path.relative(process.cwd(), OUT) + '  (' + kb + ' KB, single file, no dependencies)');
