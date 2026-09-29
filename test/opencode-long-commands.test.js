const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

async function before(input, output) {
  const { default: OperantLongCommands } = await import(
    'file://' + path.join(__dirname, '..', 'hooks', 'opencode-long-commands.mjs').replace(/\\/g, '/')
  );
  const { 'tool.execute.before': hook } = await OperantLongCommands();
  await hook(input, output);
}

test('rewrites the bash tool command when OPERANT=1', async () => {
  const old = process.env.OPERANT;
  process.env.OPERANT = '1';
  try {
    const output = { args: { command: 'npm test' } };
    await before({ tool: 'bash' }, output);
    assert.strictEqual(output.args.command, 'operant run "npm test" --background --inline --title "npm-test"');
  } finally {
    if (old === undefined) delete process.env.OPERANT; else process.env.OPERANT = old;
  }
});

test('leaves the command alone when OPERANT is unset', async () => {
  const old = process.env.OPERANT;
  delete process.env.OPERANT;
  try {
    const output = { args: { command: 'npm test' } };
    await before({ tool: 'bash' }, output);
    assert.strictEqual(output.args.command, 'npm test');
  } finally {
    if (old === undefined) delete process.env.OPERANT; else process.env.OPERANT = old;
  }
});

test('leaves non-bash tools and non-rewritable commands alone', async () => {
  const old = process.env.OPERANT;
  process.env.OPERANT = '1';
  try {
    const output = { args: { command: 'npm test' } };
    await before({ tool: 'edit' }, output);
    assert.strictEqual(output.args.command, 'npm test');

    const output2 = { args: { command: 'git status' } };
    await before({ tool: 'bash' }, output2);
    assert.strictEqual(output2.args.command, 'git status');
  } finally {
    if (old === undefined) delete process.env.OPERANT; else process.env.OPERANT = old;
  }
});
