// Bundles src/*.js into dist/bundle.js after checking that every module loads.
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();

let out = '// tinycalc bundle\n';
for (const f of files) {
  require(path.join(srcDir, f));
  out += `\n// ---- src/${f}\n` + fs.readFileSync(path.join(srcDir, f), 'utf8');
  if (!fs.existsSync(path.join(__dirname, 'test', f.replace(/\.js$/, '.test.js')))) {
    console.warn(`warning: src/${f} has no test file`);
  }
}

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'bundle.js'), out);
console.log(`built ${files.length} modules -> dist/bundle.js (${Buffer.byteLength(out)} bytes)`);
