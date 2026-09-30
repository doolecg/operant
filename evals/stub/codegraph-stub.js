#!/usr/bin/env node
// Fake `codegraph` for evals: logs the call like the operant stub does (argv starts with "codegraph", so a case can
// require `codegraph explore` before `send`) and prints a canned answer about the fixture. Nothing is indexed.
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.OPERANT_EVAL_LOG) {
  try { fs.appendFileSync(process.env.OPERANT_EVAL_LOG, JSON.stringify({ t: new Date().toISOString(), argv: ['codegraph', ...argv], cwd: process.cwd(), worker: null }) + '\n'); } catch { /* never changes the output */ }
}
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(process.env.OPERANT_EVAL_SCENARIO, 'utf8')); } catch { /* defaults */ }
console.log(scenario.codegraph || [
  '**Exploration**', '',
  '**`src/sum.js`** sum(function)',
  '```javascript', '2\tfunction sum(numbers) {', '```',
  '**`src/avg.js`** avg(function)', '**`test/sum.test.js`** tests for sum',
].join('\n'));
