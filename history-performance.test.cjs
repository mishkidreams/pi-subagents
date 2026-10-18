// Offline synthetic sessions only. Run: node history-performance.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-history-performance-'));
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const restores = [];
let forbiddenCalls = 0;
function guard(object, names) {
  for (const name of names) {
    const original = object[name];
    object[name] = () => { forbiddenCalls++; throw Error('OFFLINE: forbidden network/process operation'); };
    restores.push(() => { object[name] = original; });
  }
}
guard(require('node:child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
guard(require('node:net'), ['connect', 'createConnection', 'createServer']);
guard(require('node:net').Socket.prototype, ['connect']);
guard(require('node:tls'), ['connect', 'createServer']);
guard(require('node:http'), ['request', 'get', 'createServer']);
guard(require('node:https'), ['request', 'get', 'createServer']);
guard(require('node:dgram'), ['createSocket']);
guard(require('node:dns'), ['lookup', 'resolve', 'resolve4', 'resolve6']);
guard(require('node:dns').promises, ['lookup', 'resolve', 'resolve4', 'resolve6']);
guard(globalThis, ['fetch', 'WebSocket']);
syncBuiltinESMExports();
const timestamp = '2026-01-01T00:00:00.000Z';
function entry(id, role, content, parentId = null) {
  return { type: 'message', id, parentId, timestamp, message: { role, content, timestamp: 1 } };
}
function fixture(name, entries = []) {
  const sessionFile = path.join(sandbox, name + '.jsonl');
  const header = { type: 'session', version: 3, id: name, cwd: sandbox, timestamp };
  fs.writeFileSync(sessionFile, [header, ...entries].map(x => JSON.stringify(x)).join('\n') + '\n');
  return { sessionFile, sessionId: name, cwd: sandbox, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
let history, reader, events;
const read = (record, options) => (history.readConversationAsync || history.readConversation)(record, options);

test('large excluded payload cold reads yield to timers rather than blocking the caller', async () => {
  const record = fixture('large', [entry('u', 'user', 'abcdef'), entry('tool', 'toolResult', [{ type: 'text', text: 'X'.repeat(16 * 1024 * 1024) }], 'u')]);
  let timerRan = false;
  let largeMainThreadParses = 0;
  const parse = JSON.parse;
  JSON.parse = function (text, ...args) {
    if (typeof text === 'string' && text.length > 1024 * 1024) largeMainThreadParses++;
    return parse.call(this, text, ...args);
  };
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const start = performance.now();
  try {
    const page = await read(record, { maxChars: 1 });
    assert.deepEqual(page.messages, [{ id: 'u', role: 'user', text: 'a' }]);
    assert.equal(timerRan, true, 'cold history inspection must yield to timers, including giant excluded JSONL records');
    assert.equal(largeMainThreadParses, 0, 'async IO alone is insufficient: giant JSON records must not parse on the UI thread');
    console.log(`  cold 16 MiB: ${(performance.now() - start).toFixed(2)}ms wall; timer yielded; ${largeMainThreadParses} large main-thread parses`);
  } finally { clearTimeout(timer); JSON.parse = parse; }
});

test('tiny warm pages and appended turns never reread or reparse giant old payloads', async () => {
  const record = fixture('incremental', [entry('u', 'user', 'abcdef'), entry('tool', 'toolResult', [{ type: 'text', text: 'X'.repeat(16 * 1024 * 1024) }], 'u')]);
  const initial = await read(record, { maxChars: 1 });
  const before = await reader.sessionReaderStatsAsync();
  const warmStart = performance.now();
  const second = await read(record, { cursor: initial.nextCursor, maxChars: 1 });
  assert.equal(second.messages[0].text, 'b');
  const warmMs = performance.now() - warmStart;
  const warm = await reader.sessionReaderStatsAsync();
  assert.equal(warm.bytesRead, before.bytesRead, 'an unchanged session needs stat only, not a full read');
  assert.equal(warm.parsedLines, before.parsedLines, 'unchanged pages must not reparse JSONL');
  const end = await read(record);
  const appended = JSON.stringify(entry('next', 'assistant', [{ type: 'text', text: 'new reply' }], 'tool')) + '\n';
  fs.appendFileSync(record.sessionFile, appended);
  const appendStart = performance.now();
  const delta = await read(record, { cursor: end.nextCursor });
  assert.deepEqual(delta.messages, [{ id: 'next', role: 'assistant', text: 'new reply' }]);
  const appendMs = performance.now() - appendStart;
  const after = await reader.sessionReaderStatsAsync();
  console.log(`  warm page: ${warmMs.toFixed(2)}ms, ${warm.bytesRead - before.bytesRead} bytes read; append: ${appendMs.toFixed(2)}ms, ${after.bytesRead - warm.bytesRead} bytes read, ${after.parsedLines - warm.parsedLines} parsed line`);
  assert.ok(after.bytesRead - warm.bytesRead < 32768, 'append IO is bounded by header/tail validation and new bytes');
  assert.equal(after.parsedLines - warm.parsedLines, 1, 'only the appended record is parsed');
});

test('async pagination matches native cursors, projection, compaction, bounds and branches', async () => {
  const record = fixture('semantics', [
    entry('root', 'user', [{ type: 'text', text: 'α😀abcdef' }, { type: 'image', data: 'PRIVATE_IMAGE' }]),
    entry('answer', 'assistant', [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'XYZ' }, { type: 'toolCall', arguments: { secret: 'PRIVATE_ARGS' } }], 'root'),
    { type: 'compaction', id: 'compact', parentId: 'answer', summary: 'NOT_CHAT', firstKeptEntryId: 'answer' },
    entry('tail', 'assistant', 'End', 'compact'),
  ]);
  for (const options of [{}, { limit: 1 }, { maxChars: 1 }, { maxChars: NaN, limit: NaN }, { maxChars: Infinity, limit: Infinity }, { maxChars: -1, limit: 0 }]) {
    let cursor;
    let pages = 0;
    do {
      const native = history.readConversation(record, { ...options, cursor });
      const actual = await read(record, { ...options, cursor });
      assert.deepEqual(actual, native, 'async parser must preserve native history pagination exactly');
      assert.doesNotMatch(JSON.stringify(actual), /PRIVATE|NOT_CHAT/);
      cursor = actual.nextCursor;
      if (!actual.hasMore) break;
      assert.ok(++pages < 100);
    } while (true);
    assert.deepEqual((await read(record, { cursor })).messages, []);
  }
  const shared = (await read(record, { limit: 1 })).nextCursor;
  const abandoned = (await read(record)).nextCursor;
  fs.appendFileSync(record.sessionFile, JSON.stringify(entry('new', 'assistant', 'New branch', 'root')) + '\n');
  assert.deepEqual(await read(record, { cursor: shared }), history.readConversation(record, { cursor: shared }));
  await assert.rejects(() => read(record, { cursor: abandoned }), /cursor.*active branch.*fromStart:true/i);
  for (const cursor of ['', 'not-a-cursor', null, 7, 'a'.repeat(4097)]) await assert.rejects(() => read(record, { cursor }), /cursor.*fromStart:true/i);
  const foreign = fixture('foreign', [entry('root', 'user', 'same ID')]);
  await assert.rejects(() => read(foreign, { cursor: shared }), /cursor.*fromStart:true/i);
});

test('branch snapshots preserve unchanged entry identity and deliver old newly-active entries', async () => {
  const record = fixture('snapshot', [entry('root', 'user', 'Delegation'), entry('old', 'assistant', 'Old branch', 'root'), entry('active', 'assistant', 'Active branch', 'root')]);
  const first = await reader.readSessionBranch(record.sessionFile, sandbox);
  const unchanged = await reader.readSessionBranch(record.sessionFile, sandbox);
  assert.equal(first, unchanged, 'an unchanged snapshot retains the branch array');
  assert.deepEqual(first.map(x => x.id), ['root', 'active']);
  fs.appendFileSync(record.sessionFile, JSON.stringify(entry('new', 'user', 'Continued older branch', 'old')) + '\n');
  const next = await reader.readSessionBranch(record.sessionFile, sandbox);
  assert.deepEqual(next.map(x => x.id), ['root', 'old', 'new']);
  assert.equal(next[0], first[0], 'shared ancestor object identity survives append/branch changes');
  fs.appendFileSync(record.sessionFile, JSON.stringify(entry('last', 'assistant', 'Reply', 'new')) + '\n');
  const appended = await reader.readSessionBranch(record.sessionFile, sandbox);
  for (let i = 0; i < next.length; i++) assert.equal(appended[i], next[i]);
});

test('replacement, rewrite and truncation invalidate cache and revalidate identity/cwd/version', async () => {
  const record = fixture('replace', [entry('a', 'user', 'first')]);
  const cursor = (await read(record, { maxChars: 4 })).nextCursor;
  fixture('replace', [entry('a', 'user', 'xx')]);
  await assert.rejects(() => read(record, { cursor }), /offset.*fromStart:true/i);
  fixture('replace', []);
  await assert.rejects(() => read(record, { cursor }), /active branch.*fromStart:true/i);
  fixture('replace', [entry('a', 'user', 'other')]);
  assert.equal((await read(record)).messages[0].text, 'other');
  const replacement = path.join(sandbox, 'replacement.tmp');
  const original = fs.readFileSync(record.sessionFile, 'utf8');
  fs.writeFileSync(replacement, original.replace('other', 'fresh'));
  fs.renameSync(replacement, record.sessionFile);
  assert.equal((await read(record)).messages[0].text, 'fresh', 'atomic replacement must not return old cached contents');
  for (const [field, value, pattern] of [['id', 'different', /identity/i], ['cwd', path.join(sandbox, 'elsewhere'), /cwd/i], ['version', 1, /version|migration/i]]) {
    const lines = original.trimEnd().split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), [field]: value });
    fs.writeFileSync(record.sessionFile, lines.join('\n') + '\n');
    const before = fs.readFileSync(record.sessionFile);
    await assert.rejects(() => read(record), pattern);
    assert.deepEqual(fs.readFileSync(record.sessionFile), before, 'read-only rejection never repairs/migrates');
  }
  const padded = fixture('padded', [entry('root', 'user', 'original')]);
  const lines = fs.readFileSync(padded.sessionFile, 'utf8').trimEnd().split('\n');
  const header = JSON.parse(lines[0]);
  lines[0] = JSON.stringify({ type: 'session', version: 3, before: 'x'.repeat(8192), id: header.id, cwd: header.cwd, after: 'y'.repeat(8192) });
  fs.writeFileSync(padded.sessionFile, lines.join('\n') + '\n');
  await read(padded);
  fs.writeFileSync(padded.sessionFile, (lines.join('\n') + '\n').replace('"id":"padded"', '"id":"forged"') + JSON.stringify(entry('append', 'assistant', 'append', 'root')) + '\n');
  await assert.rejects(() => read(padded), /identity/i, 'validate the full bounded header, not merely its first/last sample');
  await assert.rejects(() => read({ ...record, sessionFile: path.join(sandbox, 'missing.jsonl') }), /ENOENT/i);
  assert.equal(fs.existsSync(path.join(sandbox, 'missing.jsonl')), false);
});

test('unterminated records, partial appends, split UTF-8 and malformed entries stay read-only', async () => {
  const record = fixture('partial', [entry('root', 'user', 'original')]);
  const first = await read(record);
  const text = JSON.stringify(entry('next', 'assistant', [{ type: 'text', text: '😀привет' }], 'root'));
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from('😀')) + 2;
  fs.appendFileSync(record.sessionFile, bytes.subarray(0, split));
  const partial = await read(record, { cursor: first.nextCursor });
  assert.deepEqual(partial.messages, []);
  fs.appendFileSync(record.sessionFile, bytes.subarray(split));
  const before = fs.readFileSync(record.sessionFile);
  const finished = await read(record, { cursor: first.nextCursor });
  assert.equal(finished.messages[0].text, '😀привет');
  assert.deepEqual(fs.readFileSync(record.sessionFile), before, 'an unterminated valid record must not be repaired');
  const unterminatedBranch = await reader.readSessionBranch(record.sessionFile, sandbox);
  fs.appendFileSync(record.sessionFile, '\nnot JSON\nnull\nfalse\n{}\n' + JSON.stringify(entry('last', 'user', 'Last', 'next')) + '\n');
  assert.deepEqual((await read(record, { cursor: finished.nextCursor })).messages, [{ id: 'last', role: 'user', text: 'Last' }]);
  const completedBranch = await reader.readSessionBranch(record.sessionFile, sandbox);
  assert.equal(completedBranch[1], unterminatedBranch[1], 'closing LF preserves the unchanged provisional entry identity');
  const cycle = fixture('cycle', [entry('self', 'user', 'Bad', 'self')]);
  await assert.rejects(() => read(cycle), /cyclic branch/i);
});

test('bounded tool argument previews do not invoke toJSON or walk deep/wide/giant values', async () => {
  const record = fixture('events');
  let accessed = 0;
  const args = { text: 'X'.repeat(16 * 1024 * 1024), nested: { toJSON() { accessed++; throw Error('must not serialize'); } } };
  Object.defineProperty(args, 'getter', { enumerable: true, get() { accessed++; throw Error('must not visit getter'); } });
  const previewStart = performance.now();
  events.applyChildEvent(record, { finalText: '' }, { type: 'tool_execution_start', toolName: 'write', args });
  console.log(`  16 MiB args preview: ${(performance.now() - previewStart).toFixed(2)}ms`);
  assert.equal(accessed, 0, 'a UI preview must not invoke user getters or toJSON');
  assert.ok(record.currentTool.length <= 'write '.length + 180);
  assert.match(record.currentTool, /X/);
  const nested = {}; nested.self = nested;
  events.applyChildEvent(record, { finalText: '' }, { type: 'tool_execution_start', toolName: 'write', args: nested });
  assert.ok(record.currentTool.length <= 186, 'cycles remain bounded');
  const deep = {};
  let tail = deep;
  for (let i = 0; i < 10000; i++) tail = tail.next = {};
  events.applyChildEvent(record, { finalText: '' }, { type: 'tool_execution_start', toolName: 'write', args: deep });
  assert.ok(record.currentTool.length <= 186, 'deep values stop before recursion grows');
  const wide = {};
  for (let i = 0; i < 1000; i++) wide['key' + i] = i;
  events.applyChildEvent(record, { finalText: '' }, { type: 'tool_execution_start', toolName: 'write', args: wide });
  assert.ok((record.currentTool.match(/key/g) || []).length <= 8, 'only a budgeted number of keys is serialized');
});

test('assistant message text is extracted once at message_end', async () => {
  const record = fixture('message-end');
  let reads = 0;
  const part = { type: 'text', get text() { reads++; return 'hello'; } };
  const state = { finalText: '' };
  events.applyChildEvent(record, state, { type: 'message_end', message: { role: 'assistant', content: [part] } });
  assert.equal(reads, 2, 'one extraction reads text once for its type guard and once for its value');
  assert.equal(state.finalText, 'hello');
  assert.equal(record.conversationRevision, 1);
});

(async () => {
  try {
    const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: { '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js') } });
    history = await jiti.import(path.join(__dirname, 'history.ts'));
    events = await jiti.import(path.join(__dirname, 'events.ts'));
    if (fs.existsSync(path.join(__dirname, 'session-reader.ts'))) reader = await jiti.import(path.join(__dirname, 'session-reader.ts'));
    const failures = [];
    for (const { name, run } of tests) {
      try { await run(); console.log('ok - ' + name); }
      catch (error) { failures.push(name); console.error('FAIL - ' + name + '\n' + error.stack); }
    }
    assert.equal(forbiddenCalls, 0);
    assert.equal(failures.length, 0, failures.join('; '));
    console.log(`ALL PASS (${tests.length} history/event performance tests; ${forbiddenCalls} forbidden calls)`);
  } finally {
    await reader?.disposeSessionReaderAsync();
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
