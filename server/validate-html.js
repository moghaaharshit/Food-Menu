/**
 * Syntax guard: extract the <script type="text/babel"> block from index.html
 * and compile it with the same Babel that the browser uses. Fails loudly if
 * any JSX/JS error exists, so edits to index.html can't silently break the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Babel from '@babel/standalone';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');

const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);

if (!match) {
  console.error('FAIL: no <script type="text/babel"> block found in ' + htmlPath);
  process.exit(1);
}

const code = match[1];
console.log(`Extracted ${code.split('\n').length} lines of JSX from ${path.basename(htmlPath)}`);

try {
  const out = Babel.transform(code, {
    presets: [['react', { runtime: 'classic' }]],
    filename: 'index.html.jsx',
  });
  const lines = out.code.split('\n').length;
  console.log(`Babel compiled OK -> ${lines} lines of JS`);
  console.log('PASS: index.html JSX is syntactically valid');
} catch (e) {
  console.error('FAIL: JSX syntax error\n' + (e && e.message ? e.message : String(e)));
  process.exit(1);
}