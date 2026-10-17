// Native SessionManager + Jiti; synthetic JSONL only. No providers, network, or child processes.
// Run: node history.test.cjs (PI_ROOT defaults to the installed APPDATA Pi package).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-history-'));
const restores = [];
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error('OFFLINE: history tests forbid network, models, and process launches'); };
function guard(object, names) {
  for (const name of names) {
    const original = object[name];
    object[name] = forbidden;
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
guard(require('node:worker_threads'), ['Worker']);
guard(globalThis, ['fetch', 'WebSocket']);
syncBuiltinESMExports();

const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const timestamp = '2026-01-01T00:00:00.000Z';
const message = (id, role, content, parentId) => ({
  type: 'message', id, ...(parentId === undefined ? {} : { parentId }), timestamp,
  message: { role, content, timestamp: 1 },
});
const user = (id, content, parentId) => message(id, 'user', content, parentId);
const assistant = (id, text, parentId) => message(id, 'assistant', [{ type: 'text', text }], parentId);
function fixture(name, entries = [], headerOverrides = {}) {
  const sessionFile = path.join(sandbox, `${name}.jsonl`);
  const header = { type: 'session', version: 3, id: name, cwd: sandbox, timestamp, ...headerOverrides };
  const linked = entries.map((entry, i) => ({ parentId: i ? entries[i - 1].id : null, timestamp, ...entry }));
  fs.writeFileSync(sessionFile, [header, ...linked].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return {
    version: 1, runId: `run-${name}`, parentRunId: 'parent', rootRunId: 'parent', sessionId: name,
    sessionFile, name, task: 'ORIGINAL_DELEGATION', cwd: sandbox, model: 'test/model', thinking: 'off',
    depth: 1, maxDepth: 2, status: 'completed', latestText: 'LATEST_TEXT_IS_NOT_THE_CONVERSATION',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    startedAt: timestamp, updatedAt: timestamp,
  };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
let readConversation;

test('reads both sides of the native active branch, not latestText', () => {
  const record = fixture('both-roles', [user('u1', 'ORIGINAL_DELEGATION'), assistant('a1', 'First answer'), user('u2', 'Follow-up'), assistant('a2', 'Second answer')]);
  const page = readConversation(record, {});
  assert.deepEqual(page.messages, [
    { id: 'u1', role: 'user', text: 'ORIGINAL_DELEGATION' },
    { id: 'a1', role: 'assistant', text: 'First answer' },
    { id: 'u2', role: 'user', text: 'Follow-up' },
    { id: 'a2', role: 'assistant', text: 'Second answer' },
  ]);
  assert.equal(page.hasMore, false);
  assert.equal(typeof page.nextCursor, 'string', 'end cursors enable later delta reads');
});

test('keeps original delegation across compaction and excludes thinking, tool payloads, and image bytes', () => {
  const record = fixture('projection', [
    user('original', [{ type: 'text', text: 'ORIGINAL_DELEGATION' }, { type: 'image', data: 'IMAGE_BYTES_SECRET', mimeType: 'image/png' }]),
    message('answer', 'assistant', [{ type: 'thinking', thinking: 'THINKING_SECRET' }, { type: 'text', text: 'Visible answer' }, { type: 'toolCall', id: 'call', name: 'write', arguments: { text: 'TOOL_ARGUMENT_SECRET' } }]),
    message('result', 'toolResult', [{ type: 'text', text: 'TOOL_RESULT_SECRET' }]),
    { type: 'compaction', id: 'compact', summary: 'COMPACTION_SUMMARY_NOT_CHAT', firstKeptEntryId: 'answer', tokensBefore: 999 },
    { type: 'custom_message', id: 'custom', display: true, content: 'CUSTOM_NOT_USER_CHAT' },
    message('system', 'system', 'SYSTEM_NOT_CHAT'),
    { type: 'message', id: 'bad-message', message: null },
    message('bad-content', 'assistant', null),
    message('thinking-only', 'assistant', [{ type: 'thinking', thinking: 'ONLY_THINKING_SECRET' }]),
    user('mixed', [null, 5, {}, { type: 'text', text: 42 }, { type: 'text', text: 'Still visible' }]),
    message('legacy', 'assistant', 'Legacy string answer'),
  ]);
  fs.appendFileSync(record.sessionFile, 'not valid JSON\nnull\nfalse\n{}\n' + JSON.stringify(assistant('later', 'Later valid answer', 'legacy')) + '\n');
  const page = readConversation(record, {});
  assert.deepEqual(page.messages, [
    { id: 'original', role: 'user', text: 'ORIGINAL_DELEGATION\n[image omitted]' },
    { id: 'answer', role: 'assistant', text: 'Visible answer' },
    { id: 'mixed', role: 'user', text: 'Still visible' },
    { id: 'legacy', role: 'assistant', text: 'Legacy string answer' },
    { id: 'later', role: 'assistant', text: 'Later valid answer' },
  ]);
  assert.doesNotMatch(JSON.stringify(page), /SECRET|NOT_CHAT|CUSTOM_NOT_USER_CHAT/);
});

test('paginates oversized messages without losing suffixes and preserves end cursors', () => {
  const record = fixture('pages', [user('long', 'abcdefghij'), assistant('answer', 'XYZ'), user('last', 'next'), { type: 'custom', id: 'state', data: 'not chat' }]);
  const first = readConversation(record, { maxChars: 4, limit: 2 });
  assert.deepEqual(first.messages, [{ id: 'long', role: 'user', text: 'abcd' }]);
  assert.equal(first.hasMore, true);
  assert.doesNotMatch(first.nextCursor, /abcdefghij/);
  const second = readConversation(record, { cursor: first.nextCursor, maxChars: 4, limit: 2 });
  assert.deepEqual(second.messages, [{ id: 'long', role: 'user', text: 'efgh', continued: true }]);
  const third = readConversation(record, { cursor: second.nextCursor, maxChars: 4, limit: 2 });
  assert.deepEqual(third.messages, [{ id: 'long', role: 'user', text: 'ij', continued: true }, { id: 'answer', role: 'assistant', text: 'XY' }]);
  const fourth = readConversation(record, { cursor: third.nextCursor, maxChars: 4, limit: 2 });
  assert.deepEqual(fourth.messages, [{ id: 'answer', role: 'assistant', text: 'Z', continued: true }, { id: 'last', role: 'user', text: 'nex' }]);
  const fifth = readConversation(record, { cursor: fourth.nextCursor, maxChars: 4, limit: 2 });
  assert.deepEqual(fifth.messages, [{ id: 'last', role: 'user', text: 't', continued: true }]);
  assert.equal(fifth.hasMore, false);
  assert.deepEqual(readConversation(record, { cursor: fifth.nextCursor }), { messages: [], hasMore: false, nextCursor: fifth.nextCursor });
  assert.deepEqual(readConversation(record, { limit: 2 }).messages.map(message => message.id), ['long', 'answer']);
  assert.equal(readConversation(record, { limit: 2 }).hasMore, true);
});

test('defaults to 20 messages / 24000 chars and clamps caller bounds with forward progress', () => {
  const many = fixture('bounds-many', Array.from({ length: 120 }, (_, i) => user(`u${i}`, 'x')));
  assert.equal(readConversation(many, {}).messages.length, 20);
  assert.equal(readConversation(many, { limit: 10000 }).messages.length, 100);
  assert.equal(readConversation(many, { limit: Infinity }).messages.length, 100);
  assert.equal(readConversation(many, { limit: NaN }).messages.length, 20);
  assert.equal(readConversation(many, { limit: 2.9 }).messages.length, 2);
  const long = fixture('bounds-long', [user('long', 'a'.repeat(60001)), assistant('tail', 'THE_END')]);
  const first = readConversation(long, {});
  assert.equal(first.messages[0].text.length, 24000);
  assert.equal(first.hasMore, true);
  const second = readConversation(long, { cursor: first.nextCursor });
  const third = readConversation(long, { cursor: second.nextCursor });
  assert.equal(second.messages[0].text.length, 24000);
  assert.equal(third.messages[0].text.length, 12001);
  assert.deepEqual(third.messages[1], { id: 'tail', role: 'assistant', text: 'THE_END' });
  assert.equal(third.hasMore, false);
  assert.equal([first, second, third].flatMap(page => page.messages).filter(message => message.id === 'long').map(message => message.text).join(''), 'a'.repeat(60001));
  const capped = readConversation(long, { maxChars: 1000000 });
  assert.equal(capped.messages[0].text.length, 50000);
  assert.equal(readConversation(long, { maxChars: Infinity }).messages[0].text.length, 50000);
  assert.equal(readConversation(long, { maxChars: NaN }).messages[0].text.length, 24000);
  for (const small of [0, -100, -Infinity, 0.5, 1.9]) {
    const page = readConversation(long, { limit: small, maxChars: small });
    assert.deepEqual(page.messages, [{ id: 'long', role: 'user', text: 'a' }]);
    assert.equal(page.hasMore, true);
    assert.notEqual(readConversation(long, { cursor: page.nextCursor, maxChars: 1 }).nextCursor, page.nextCursor);
  }
});

test('empty and textless histories provide stable cursors for later appended conversation', () => {
  const empty = fixture('empty');
  const initial = readConversation(empty, {});
  assert.deepEqual(initial.messages, []);
  assert.equal(initial.hasMore, false);
  assert.equal(typeof initial.nextCursor, 'string');
  assert.deepEqual(readConversation(empty, { cursor: initial.nextCursor }), initial);
  fs.appendFileSync(empty.sessionFile, JSON.stringify(user('first', 'New delegation', null)) + '\n');
  assert.deepEqual(readConversation(empty, { cursor: initial.nextCursor }).messages, [{ id: 'first', role: 'user', text: 'New delegation' }]);

  const textless = fixture('textless', [message('thought', 'assistant', [{ type: 'thinking', thinking: 'HIDDEN' }]), { type: 'custom', id: 'state' }]);
  const cursor = readConversation(textless, {}).nextCursor;
  assert.deepEqual(readConversation(textless, { cursor }).messages, []);
  fs.appendFileSync(textless.sessionFile, JSON.stringify(user('new', 'After hidden entries', 'state')) + '\n');
  assert.deepEqual(readConversation(textless, { cursor }).messages, [{ id: 'new', role: 'user', text: 'After hidden entries' }]);
});

test('end cursors read appended turns and compaction without replaying prior chat', () => {
  const record = fixture('append', [user('root', 'Delegation'), assistant('first', 'First reply')]);
  const initial = readConversation(record, {});
  const append = entry => fs.appendFileSync(record.sessionFile, JSON.stringify(entry) + '\n');
  append({ type: 'compaction', id: 'compact', parentId: 'first', timestamp, summary: 'not conversation', firstKeptEntryId: 'first', tokensBefore: 500 });
  append(user('next', 'Follow-up', 'compact'));
  append(assistant('reply', 'Second reply', 'next'));
  const delta = readConversation(record, { cursor: initial.nextCursor });
  assert.deepEqual(delta.messages, [{ id: 'next', role: 'user', text: 'Follow-up' }, { id: 'reply', role: 'assistant', text: 'Second reply' }]);
  assert.equal(delta.hasMore, false);
  assert.deepEqual(readConversation(record, {}).messages.map(message => message.id), ['root', 'first', 'next', 'reply']);
});

test('branch changes reject abandoned cursors but retain valid shared-ancestor cursors', () => {
  const record = fixture('branch', [user('root', 'Delegation'), assistant('old', 'Abandoned answer')]);
  const shared = readConversation(record, { limit: 1 }).nextCursor;
  const abandoned = readConversation(record, {}).nextCursor;
  fs.appendFileSync(record.sessionFile, JSON.stringify(assistant('new', 'Active answer', 'root')) + '\n');
  assert.deepEqual(readConversation(record, {}).messages.map(message => message.text), ['Delegation', 'Active answer']);
  assert.deepEqual(readConversation(record, { cursor: shared }).messages, [{ id: 'new', role: 'assistant', text: 'Active answer' }]);
  assert.throws(() => readConversation(record, { cursor: abandoned }), /cursor.*active branch.*Reset by omitting cursor/i);
});

test('invalid, foreign, and out-of-range cursors fail with an actionable reset instruction', () => {
  const record = fixture('cursor-valid', [user('root', 'abcdef')]);
  for (const cursor of ['', 'not-a-cursor', 'a'.repeat(4097), Buffer.from('{}').toString('base64url'), null, 7]) {
    assert.throws(() => readConversation(record, { cursor }), /cursor.*Reset by omitting cursor.*fromStart:true/i);
  }
  const foreign = fixture('cursor-foreign', [user('root', 'abcdef')]);
  const cursor = readConversation(record, { maxChars: 4 }).nextCursor;
  assert.throws(() => readConversation(foreign, { cursor }), /cursor.*Reset by omitting cursor/i);
  fixture('cursor-valid', [user('root', 'ab')]);
  assert.throws(() => readConversation(record, { cursor }), /cursor.*offset.*Reset by omitting cursor/i);
  fixture('cursor-valid');
  assert.throws(() => readConversation(record, { cursor }), /cursor.*active branch.*Reset by omitting cursor/i);
});

test('fails closed for missing, invalid, or mismatched sessions without modifying them', () => {
  const valid = fixture('identity', [user('u', 'SYNTHETIC_PRIVATE_TEXT')]);
  const unchangedFailure = (record, pattern) => {
    const before = fs.existsSync(record.sessionFile) ? fs.readFileSync(record.sessionFile) : undefined;
    const names = fs.readdirSync(sandbox).sort();
    assert.throws(() => readConversation(record, {}), pattern);
    assert.deepEqual(fs.readdirSync(sandbox).sort(), names, 'inspection must not create a session');
    if (before) assert.deepEqual(fs.readFileSync(record.sessionFile), before, 'rejected history must not be rewritten');
  };
  assert.throws(() => readConversation({ ...valid, sessionFile: undefined }, {}), /no saved session/i);
  unchangedFailure({ ...valid, sessionFile: path.join(sandbox, 'missing.jsonl') }, /ENOENT|session.*not found/i);
  unchangedFailure({ ...valid, sessionId: 'another-child' }, /session.*identity/i);
  unchangedFailure({ ...valid, cwd: path.join(sandbox, 'another-project') }, /session.*cwd/i);
  for (const [name, header, pattern] of [
    ['bad-type', { type: 'message' }, /session.*header/i],
    ['missing-id', { id: null }, /session.*header/i],
    ['missing-cwd', { cwd: null }, /session.*header/i],
    ['legacy', { version: 1 }, /session.*version|migrat/i],
  ]) unchangedFailure(fixture(name, [user('u', 'text')], header), pattern);
  for (const [name, content] of [['zero-bytes', ''], ['invalid-header', 'not JSON\n']]) {
    const record = fixture(name);
    fs.writeFileSync(record.sessionFile, content);
    unchangedFailure(record, /session.*header/i);
  }
  const original = fs.readFileSync(valid.sessionFile);
  readConversation(valid, {});
  assert.deepEqual(fs.readFileSync(valid.sessionFile), original);
});

(async () => {
  try {
    const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: {
      '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
    } });
    ({ readConversation } = await jiti.import(path.join(__dirname, 'history.ts')));
    for (const { name, run } of tests) { await run(); console.log(`ok - ${name}`); }
    assert.equal(forbiddenCalls, 0, 'reading conversation must never attempt a model, network, or process operation');
    console.log(`ALL PASS (${tests.length} native history tests; ${forbiddenCalls} forbidden calls)`);
  } finally {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
