const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'style.css');
const css = fs.readFileSync(file, 'utf8');
let depth = 0;
let line = 1;
let inString = null;
let inComment = false;

for (let i = 0; i < css.length; i += 1) {
  const ch = css[i];
  const next = css[i + 1];
  if (ch === '\n') line += 1;

  if (inComment) {
    if (ch === '*' && next === '/') {
      inComment = false;
      i += 1;
    }
    continue;
  }

  if (inString) {
    if (ch === '\\') {
      i += 1;
    } else if (ch === inString) {
      inString = null;
    }
    continue;
  }

  if (ch === '/' && next === '*') {
    inComment = true;
    i += 1;
  } else if (ch === '"' || ch === "'") {
    inString = ch;
  } else if (ch === '{') {
    depth += 1;
  } else if (ch === '}') {
    depth -= 1;
    if (depth < 0) throw new Error(`Unexpected } at line ${line}`);
  }
}

if (depth !== 0) throw new Error(`CSS brace mismatch: depth=${depth}`);
console.log('css ok');
