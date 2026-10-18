// Offline regressions at the real wait/tool-result boundaries. No agents or API calls.
// Run: node responsiveness.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const cp = require('node:child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-responsiveness-'));
const runs = path.join(sandbox, 'subagents', 'runs');
fs.mkdirSync(runs, { recursive: true });
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const piRoot = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
let measuring = false, syncCalls = 0, reads = 0, scans = 0, activeScans = 0, maxScans = 0, readDelay = 0;
let afterListing;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const name of ['existsSync', 'readdirSync', 'readFileSync', 'statSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) {
    if (measuring && String(file).startsWith(runs)) syncCalls++;
    return original.call(this, file, ...args);
  };
}
const realReadFile = fsp.readFile, realReaddir = fsp.readdir;
fsp.readFile = async function(file, ...args) {
  if (measuring && String(file).startsWith(runs)) {
    reads++;
    if (readDelay) await sleep(readDelay);
  }
  return realReadFile.call(this, file, ...args);
};
fsp.readdir = async function(file, ...args) {
  if (!measuring || path.resolve(String(file)) !== runs) return realReaddir.call(this, file, ...args);
  scans++; activeScans++; maxScans = Math.max(maxScans, activeScans);
  try {
    if (readDelay) await sleep(readDelay);
    const result = await realReaddir.call(this, file, ...args);
    if (afterListing) await afterListing();
    return result;
  }
  finally { activeScans--; }
};
cp.execFileSync = () => { throw new Error('OFFLINE: synchronous process execution forbidden'); };
cp.spawn = () => { throw new Error('OFFLINE: process launch forbidden'); };
cp.execFile = () => { throw new Error('OFFLINE: process launch forbidden'); };
const { createJiti } = require(path.join(piRoot, 'node_modules/jiti'));
const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: {
  '@earendil-works/pi-coding-agent': path.join(piRoot, 'dist/bundle/index.js'),
  '@earendil-works/pi-tui': path.join(piRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: require.resolve('typebox', { paths: [piRoot] }),
} });
const makeRecord = (runId, extra = {}) => ({
  version: 1, runId, parentRunId: 'other-session', rootRunId: 'other-session', sessionId: runId,
  name: runId, task: 'offline fixture', cwd: sandbox, depth: 1, maxDepth: 2, status: 'completed',
  model: 'test/model', thinking: 'off', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
  latestText: 'x'.repeat(4000), ...extra,
});
const write = record => fs.writeFileSync(path.join(runs, record.runId + '.json'), JSON.stringify(record));
const reset = () => { syncCalls = reads = scans = maxScans = 0; };
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('ok - ' + name); }
  catch (error) { failures++; console.error('FAIL - ' + name + ': ' + error.stack); }
}
(async () => {
  let handlers, ctx, shutdownDone = false;
  const tools = new Map();
  const registry = await jiti.import(path.join(__dirname, 'registry.ts'));
  const wait = await jiti.import(path.join(__dirname, 'wait.ts'));
  try {
    for (let i = 0; i < 96; i++) write(makeRecord('old-' + i));
    write(makeRecord('active', { parentRunId: 'parent', rootRunId: 'parent', status: 'thinking', latestText: '' }));
    await test('wait and completion wakes never synchronously rescan history', async () => {
      reset(); measuring = true;
      const finish = setTimeout(() => {
        write(makeRecord('active', { parentRunId: 'parent', rootRunId: 'parent', latestText: 'finished' }));
        wait.notifyWaiters(sandbox);
      }, 70);
      try {
        const rows = await wait.waitUntilSubagentsIdle(sandbox, 'parent', { timeoutMs: 2000, pollMs: 20 });
        assert.equal(rows[0]?.status, 'completed');
        assert.equal(syncCalls, 0, 'wait must not perform synchronous per-record filesystem operations');
      } finally { measuring = false; clearTimeout(finish); }
      assert.deepEqual(wait.waitDebugState(), { waiters: 0, watches: 0 });
    });
    await test('unchanged snapshots reuse parsed records; concurrent readers share I/O', async () => {
      reset(); measuring = true;
      try {
        const [a, b] = await Promise.all([registry.readRecordsAsync(sandbox), registry.readRecordsAsync(sandbox)]);
        assert.equal(a.length, 97); assert.equal(b.length, 97);
        assert.ok(reads <= 97, 'concurrent consumers must not each read all historical payloads: ' + reads);
        reads = 0;
        await registry.readRecordsAsync(sandbox);
        assert.equal(reads, 0, 'unchanged historical response bodies must not be read/JSON-parsed again');
        const changed = makeRecord('old-0', { latestText: 'changed', executionId: 'new' }); write(changed);
        fs.writeFileSync(path.join(runs, 'old-0.new.resultsDelivered'), 'true\n');
        const fresh = await registry.readRecordsAsync(sandbox);
        assert.equal(fresh.find(row => row.runId === 'old-0').latestText, 'changed');
        assert.equal(fresh.find(row => row.runId === 'old-0').resultsDelivered, true, 'markers remain fresh even with cached record payloads');
        assert.equal(reads, 1, 'only the modified payload is reread');
      } finally { measuring = false; }
    });
    await test('a local write invalidates an older in-flight directory snapshot', async () => {
      let release, listed;
      const gate = new Promise(resolve => { release = resolve; });
      const sawListing = new Promise(resolve => { listed = resolve; });
      afterListing = async () => { afterListing = undefined; listed(); await gate; };
      measuring = true;
      const old = registry.readRecordsAsync(sandbox);
      try {
        await sawListing;
        registry.saveRecord(sandbox, makeRecord('new-local-write'));
        const fresh = await Promise.race([
          registry.readRecordsAsync(sandbox),
          sleep(1000).then(() => { throw new Error('new reader joined the deliberately blocked stale snapshot'); }),
        ]);
        assert.ok(fresh.some(row => row.runId === 'new-local-write'), 'a later reader must not join a snapshot from before its own write');
      } finally { release(); await old; measuring = false; afterListing = undefined; }
    });
    await test('watch storms coalesce and abort/timeout do not await slow storage', async () => {
      write(makeRecord('active', { parentRunId: 'parent', rootRunId: 'parent', status: 'thinking', latestText: '' }));
      reset(); readDelay = 80; measuring = true;
      const ac = new AbortController();
      const storm = setInterval(() => wait.notifyWaiters(sandbox), 1);
      const abort = setTimeout(() => ac.abort(), 20);
      try {
        const start = performance.now();
        await assert.rejects(wait.waitUntilSubagentsIdle(sandbox, 'parent', { timeoutMs: 2000, signal: ac.signal, pollMs: 1 }), /aborted/i);
        assert.ok(performance.now() - start < 200, 'abort must not wait for a full slow registry snapshot');
        const timeoutStart = performance.now();
        await wait.waitUntilSubagentsIdle(sandbox, 'parent', { timeoutMs: 20, pollMs: 1 });
        assert.ok(performance.now() - timeoutStart < 200, 'timeout is a ceiling, not added after initial I/O');
        assert.equal(maxScans, 1, 'polls and notifications must not start overlapping directory snapshots');
        assert.deepEqual(wait.waitDebugState(), { waiters: 0, watches: 0 });
      } finally { clearInterval(storm); clearTimeout(abort); readDelay = 0; measuring = false; await sleep(200); }
    });
    await test('ordinary tool-result previews use async registry reads', async () => {
      const { default: extension } = await jiti.import(path.join(__dirname, 'index.ts'));
      handlers = new Map();
      extension({ registerFlag(){}, registerMessageRenderer(){}, registerCommand(){}, registerTool(tool){tools.set(tool.name, tool);}, appendEntry(){},
        on:(name, handler) => handlers.set(name, handler), getFlag(){}, getActiveTools:() => [], sendMessage(){} });
      ctx = { sessionManager:{ getSessionId:() => 'parent', getBranch:() => [] }, cwd:sandbox,
        isProjectTrusted:() => false, mode:'rpc', hasUI:false, ui:{}, isIdle:() => false };
      await handlers.get('session_start')({}, ctx); handlers.get('agent_start')({}, ctx);
      write(makeRecord('active', { parentRunId:'parent', rootRunId:'parent', executionId:'delegation', latestText:'real report' }));
      reset(); measuring = true;
      try {
        const result = await handlers.get('tool_result')({content:[{type:'text',text:'original'}]}, ctx);
        assert.ok(result.content.some(block => block.text.includes('real report')));
        assert.equal(syncCalls, 0, 'tool boundaries must not synchronously read every old run');
      } finally { measuring = false; }
    });
    await test('parallel automatic conversation reads advance one shared delta cursor', async () => {
      const sessionFile = path.join(sandbox, 'conversation.jsonl');
      const { CURRENT_SESSION_VERSION } = await jiti.import('@earendil-works/pi-coding-agent');
      fs.writeFileSync(sessionFile, [
        {type:'session', version:CURRENT_SESSION_VERSION, id:'active', cwd:sandbox},
        {type:'message', id:'greeting', parentId:null, message:{role:'assistant', content:[{type:'text', text:'abcd'}]}},
      ].map(entry => JSON.stringify(entry)).join('\n')+'\n');
      write(makeRecord('active', {parentRunId:'parent', rootRunId:'parent', sessionFile}));
      const read = tools.get('read_subagent_messages');
      const pages = await Promise.all([1,2,3].map(id => read.execute(`read-${id}`, {target:'active', maxChars:1}, undefined, undefined, ctx)));
      assert.deepEqual(pages.map(page => page.details.messages[0]?.text), ['a','b','c'], 'concurrent automatic reads must not duplicate a page or rewind their cursor');
      const last = await read.execute('last', {target:'active', maxChars:1}, undefined, undefined, ctx);
      assert.equal(last.details.messages[0]?.text, 'd', 'the next delta begins after all admitted parallel reads');
    });
    await test('a branch reset fences an in-flight automatic conversation receipt', async () => {
      const { Worker } = require('node:worker_threads');
      const post = Worker.prototype.postMessage;
      let release, entered, intercept = true;
      const admitted = new Promise(resolve => { entered = resolve; });
      Worker.prototype.postMessage = function(message, ...args) {
        if (intercept && message.kind === 'page') {
          intercept = false;
          release = () => post.call(this, message, ...args);
          entered();
          return;
        }
        return post.call(this, message, ...args);
      };
      const read = tools.get('read_subagent_messages');
      const old = read.execute('old-branch', {target:'active', maxChars:1}, undefined, undefined, ctx);
      old.catch(() => {});
      try {
        await admitted;
        await handlers.get('session_tree')({}, ctx);
        const first = await read.execute('new-branch', {target:'active', maxChars:1}, undefined, undefined, ctx);
        assert.equal(first.details.messages[0]?.text, 'a');
        release(); release = undefined;
        await assert.rejects(old, /session changed/i, 'the obsolete read must not overwrite the restored branch cursor');
        const next = await read.execute('next-new-branch', {target:'active', maxChars:1}, undefined, undefined, ctx);
        assert.equal(next.details.messages[0]?.text, 'b');
      } finally {
        Worker.prototype.postMessage = post;
        release?.();
        await old.catch(() => {});
      }
    });
    await test('extension shutdown terminates its history worker instead of retaining its thread and caches', async () => {
      const { Worker } = require('node:worker_threads');
      const post = Worker.prototype.postMessage, owned = new Set();
      Worker.prototype.postMessage = function(message, ...args) {
        if (message.kind === 'page') owned.add(this);
        return post.call(this, message, ...args);
      };
      try {
        await tools.get('read_subagent_messages').execute('before-shutdown', {target:'active', fromStart:true}, undefined, undefined, ctx);
      } finally { Worker.prototype.postMessage = post; }
      assert.equal(owned.size, 1, 'exercise the real background history reader');
      await handlers.get('session_shutdown')({}, ctx);
      shutdownDone = true;
      assert.ok([...owned].every(worker => worker.threadId === -1), 'the history worker must be terminated, not merely unrefed, when this extension unloads');
    });
  } finally {
    measuring = false;
    await (await jiti.import(path.join(__dirname, 'session-reader.ts'))).disposeSessionReaderAsync();
    if (handlers && !shutdownDone) await handlers.get('session_shutdown')({}, ctx);
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    fs.rmSync(sandbox, { recursive:true, force:true, maxRetries:10, retryDelay:50 });
  }
  if (failures) process.exitCode = 1; else console.log('ALL RESPONSIVENESS TESTS PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
