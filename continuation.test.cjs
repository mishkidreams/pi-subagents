// Actual extension + RPC transport, synthetic sessions only; no Pi/provider/clipboard/OS terminal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-continuation-'));
const fixture = path.join(sandbox, 'rpc-fixture.cjs');
const calls = path.join(sandbox, 'calls.jsonl');
const envKeys = ['PI_CODING_AGENT_DIR', 'PI_SUBAGENT_COMMAND', 'PI_SUBAGENT_RUN_ID', 'PI_SUBAGENT_ROOT_ID'];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originals = { spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync };
const children = new Set();
let launches = 0;
cp.execFileSync = () => { throw new Error('OFFLINE: synchronous OS probes forbidden'); };
cp.execFile = (file, args, options, callback) => {
  assert.match(file, /powershell\.exe$/i, 'only stubbed process identity probes allowed');
  process.nextTick(() => callback(null, '123456\n', ''));
};
cp.spawn = (file, args, options) => {
  if (file === 'taskkill') {
    const child = [...children].find(item => item.pid === Number(args[1]));
    assert.ok(child, 'termination must target an owned fixture');
    const request = new EventEmitter();
    request.stdout = new EventEmitter(); request.stderr = new EventEmitter(); request.kill = () => {};
    if (child.exitCode !== null || child.signalCode !== null) process.nextTick(() => request.emit('close', 0));
    else { child.once('close', () => request.emit('close', 0)); child.kill(); }
    return request;
  }
  assert.equal(file, process.execPath, 'only the offline Node fixture may launch');
  assert.equal(args[0], fixture, 'never launch real Pi or a provider');
  assert.ok(args.includes('--session'), 'resume must use the exact saved file');
  assert.ok(!args.includes('--session-id'), 'must not silently create a fresh session');
  launches++;
  const child = originals.spawn(file, args, { ...options, windowsHide: true });
  children.add(child);
  return child;
};
fs.writeFileSync(fixture, `
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const file = args[args.indexOf('--session') + 1];
const log = ${JSON.stringify(calls)};
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let exit;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') return emit({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionFile: file } });
  if (command.type !== 'prompt') return;
  if (!fs.readFileSync(file, 'utf8').includes('ORIGINAL_DELEGATION')) process.exit(2);
  fs.appendFileSync(log, JSON.stringify({ file, message: command.message, args, runId: process.env.PI_SUBAGENT_RUN_ID, depth: process.env.PI_SUBAGENT_MAX_DEPTH }) + '\\n');
  if (command.message === 'reject') return emit({ type: 'response', id: command.id, command: command.type, success: false, error: 'fixture rejected prompt' });
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: command.id, parentId: 'original', message: { role: 'user', content: command.message, timestamp: 1 } }) + '\\n');
  emit({ type: 'response', id: command.id, command: command.type, success: true });
  emit({ type: 'agent_start' });
  clearTimeout(exit);
  setTimeout(() => {
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'continued: ' + command.message }] } });
    emit({ type: 'agent_settled' });
    clearTimeout(exit);
    exit = setTimeout(() => process.exit(0), 40);
  }, command.message === 'slow' ? 300 : 10);
});
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state'); await sleep(10); }
}
(async () => {
  const handlers = new Map(), tools = new Map();
  try {
    process.env.PI_CODING_AGENT_DIR = sandbox;
    process.env.PI_SUBAGENT_COMMAND = fixture;
    delete process.env.PI_SUBAGENT_RUN_ID; delete process.env.PI_SUBAGENT_ROOT_ID;
    fs.writeFileSync(path.join(sandbox, 'subagents.json'), JSON.stringify({ maxConcurrency: 1 }));
    const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: {
      '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
      '@earendil-works/pi-tui': path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
      typebox: require.resolve('typebox', { paths: [pi] }),
    } });
    const registry = await jiti.import(path.join(__dirname, 'registry.ts'));
    const runtime = await jiti.import(path.join(__dirname, 'spawn-agent.ts'));
    const { default: extension } = await jiti.import(path.join(__dirname, 'index.ts'));
    extension({ registerFlag() {}, on: (event, handler) => handlers.set(event, handler), registerMessageRenderer() {}, registerCommand() {}, registerTool: tool => tools.set(tool.name, tool), getFlag() {}, getActiveTools: () => [], sendMessage() {}, sendUserMessage() {} });
    const context = { sessionManager: { getSessionId: () => 'parent', getBranch: () => [] }, cwd: sandbox, isProjectTrusted: () => false, mode: 'rpc', hasUI: false, model: { provider: 'test', id: 'model' }, scopedModels: [{ model: { provider: 'test', id: 'model' } }], ui: {} };
    await handlers.get('session_start')({}, context);
    const send = (target, message, signal) => tools.get('send_to_subagent').execute('followup', { target, message }, signal, undefined, context);
    const row = id => registry.readRecords(sandbox).find(item => item.runId === id);
    const make = (id, overrides = {}, closed = true) => {
      const session = path.join(sandbox, `${id}.jsonl`);
      fs.writeFileSync(session, JSON.stringify({ type: 'session', version: 3, id, cwd: sandbox }) + '\n' + JSON.stringify({ type: 'message', id: 'original', parentId: null, message: { role: 'user', content: 'ORIGINAL_DELEGATION', timestamp: 0 } }) + '\n');
      const persist = closed ? registry.clearRecordPid : registry.saveRecord;
      return persist(sandbox, { version: 1, runId: id, parentRunId: 'parent', rootRunId: 'parent', sessionId: id, sessionFile: session, name: id, task: 'ORIGINAL_DELEGATION', cwd: sandbox, depth: 1, maxDepth: 2, status: 'completed', model: 'test/model', thinking: 'off', tools: [], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides });
    };
    const holdRecordLock = id => {
      const dir = path.join(registry.registryDir(sandbox), `${id}.lock`);
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner'), `${process.pid}-test`);
      return () => fs.rmSync(dir, { recursive: true, force: true });
    };
    if (process.platform === 'win32') {
      const running = make('same-pid', { pid: process.pid, pidStartTime: '123456' }, false);
      const unknown = make('unknown-pid', { pid: process.pid }, false);
      await assert.rejects(send(running.runId, 'never run'), /still running/);
      await assert.rejects(send(unknown.runId, 'never run'), /still running/);
      const recycled = make('reused-pid', { pid: process.pid, pidStartTime: 'old-creation-time' }, false);
      await assert.doesNotReject(() => send(recycled.runId, 'PID_REUSED'), 'a recycled PID must not block the saved session');
      await until(() => row(recycled.runId)?.latestText === 'continued: PID_REUSED' && !row(recycled.runId).pid);
      console.log('ok - recycled PID permits resume; same or unproven process identity remains blocked');
    }
    if (process.argv.includes('--identity-check')) return;
    const contended = make('lock-test');
    const unlock = holdRecordLock(contended.runId);
    const lockStart = performance.now();
    try {
      assert.throws(() => registry.saveRecord(sandbox, contended), error => error.code === 'EBUSY');
      assert.ok(performance.now() - lockStart < 200, 'writer contention must fail fast, not freeze the event loop');
    } finally { unlock(); }
    console.log('ok - contended registry writers fail fast with retryable EBUSY');
    if (process.argv.includes('--lock-check')) return;
    const finished = make('finished-child', { resultsDelivered: true, resultsPreviewed: true, footerDismissed: true });
    const original = fs.readFileSync(finished.sessionFile, 'utf8');
    await assert.doesNotReject(() => send(finished.runId, 'FOLLOWUP'), 'a saved child session must accept a follow-up after its process exited');
    await until(() => row(finished.runId)?.latestText === 'continued: FOLLOWUP' && !row(finished.runId).pid);
    const first = row(finished.runId);
    assert.equal(first.sessionFile, finished.sessionFile);
    assert.equal(first.sessionId, finished.sessionId);
    assert.equal(first.task, 'ORIGINAL_DELEGATION');
    assert.equal(first.usage.totalTokens, 3);
    assert.equal(first.resultsDelivered, false);
    assert.equal(first.resultsPreviewed, false);
    assert.equal(first.footerDismissed, false);
    assert.ok(fs.readFileSync(first.sessionFile, 'utf8').startsWith(original));
    console.log('ok - exited child resumes same history/identity without replaying the original task');

    await send(first.runId, 'slow');
    const second = row(first.runId);
    assert.notEqual(second.processInstanceId, first.processInstanceId);
    assert.ok(second.pid, 'old close marker must not hide the resumed process');
    assert.throws(() => registry.saveRecord(sandbox, first), registry.StaleSubagentProcessError);
    assert.throws(() => registry.clearRecordPid(sandbox, finished), registry.StaleSubagentProcessError);
    assert.equal(row(first.runId).pid, second.pid);
    assert.ok((await registry.readRecordsAsync(sandbox)).find(item => item.runId === first.runId).pid);
    await until(() => !row(first.runId).pid);
    console.log('ok - repeated resume fences stale records and close markers, sync and async readers agree');

    const parallel = make('parallel');
    const beforeParallel = launches;
    await Promise.all([send(parallel.runId, 'FIRST'), send(parallel.runId, 'SECOND')]);
    await until(() => !row(parallel.runId).pid);
    assert.equal(launches - beforeParallel, 1, 'concurrent sends must share one resumed process');
    const received = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.runId === parallel.runId);
    assert.deepEqual(received.map(item => item.message), ['FIRST', 'SECOND']);
    assert.ok(received.every(item => item.args.includes('--no-tools') && !item.args.includes('--approve')));
    console.log('ok - concurrent sends use one process, exact prompts, and original capability/trust bounds');

    const busyClaim = make('busy-claim');
    const beforeClaim = launches;
    const releaseClaim = holdRecordLock(busyClaim.runId);
    const claimStart = performance.now();
    const claimAbort = new AbortController();
    let claimTimerProgress = false;
    const abortClaim = setTimeout(() => { claimTimerProgress = true; claimAbort.abort(); }, 25);
    try {
      await assert.rejects(send(busyClaim.runId, 'not accepted', claimAbort.signal), /aborted/i);
      assert.equal(claimTimerProgress, true, 'claim contention must yield to input timers');
      assert.ok(performance.now() - claimStart < 500, 'abort must not wait for the registry lock deadline');
      assert.equal(row(busyClaim.runId).status, 'completed');
      assert.equal(launches, beforeClaim);
    } finally { clearTimeout(abortClaim); releaseClaim(); }
    await sleep(30);
    assert.equal(launches, beforeClaim, 'a cancelled claim must not launch after the writer releases');

    const busyPublish = make('busy-publish');
    await send(busyPublish.runId, 'slow');
    const releasePublish = holdRecordLock(busyPublish.runId);
    const publishStart = performance.now();
    try {
      await sleep(450); // Includes terminal and close callbacks while the writer is held.
      assert.ok(performance.now() - publishStart < 1000, 'terminal/close publication must not block timers');
    } finally { releasePublish(); }
    await until(() => row(busyPublish.runId).status === 'completed' && !row(busyPublish.runId).pid);
    assert.equal(row(busyPublish.runId).latestText, 'continued: slow');

    const busyFailure = make('busy-failure');
    const releaseFailureGate = await runtime.gate.acquire(1);
    const failureAbort = new AbortController();
    const beforeFailure = launches;
    const failure = send(busyFailure.runId, 'never launched', failureAbort.signal).then(() => undefined, error => error);
    await until(() => row(busyFailure.runId).status === 'queued');
    const releaseFailureLock = holdRecordLock(busyFailure.runId);
    const failureStart = performance.now();
    try {
      failureAbort.abort();
      assert.match(String(await failure), /aborted|stopped/);
      await sleep(30);
      assert.ok(performance.now() - failureStart < 500, 'admission failure must use asynchronous persistence retry');
    } finally { releaseFailureLock(); releaseFailureGate(); }
    await until(() => row(busyFailure.runId).status === 'failed');
    assert.equal(launches, beforeFailure);
    console.log('ok - claim fails safely; terminal, close and admission-failure writes retry without blocking input');

    const queued = make('queued');
    const release = await runtime.gate.acquire(1);
    const abort = new AbortController();
    const queuedCount = launches;
    const sending = send(queued.runId, 'not accepted', abort.signal).then(() => undefined, error => error);
    await until(() => row(queued.runId).status === 'queued');
    assert.equal(launches, queuedCount);
    abort.abort();
    assert.match(String(await sending), /aborted|stopped/);
    release();
    await send(queued.runId, 'retry');
    await until(() => !row(queued.runId).pid);
    assert.equal(row(queued.runId).latestText, 'continued: retry');
    console.log('ok - concurrency admission, abort before launch, and retry after failure');

    const rejected = make('rpc-reject');
    await assert.rejects(send(rejected.runId, 'reject'), /fixture rejected prompt/);
    await until(() => !row(rejected.runId).pid);
    console.log('ok - RPC rejection is reported, not a false Sent acknowledgement');

    const denied = [
      [make('cancelled', { status: 'cancelled' }), /cancelled/],
      [make('no-session', { sessionFile: undefined }), /no saved session/],
      [make('no-tools', { tools: undefined }), /saved tool allowlist/],
      [make('extra-tools', { tools: ['write'] }), /subset/],
      [make('wrong-model', { model: 'outside/model' }), /model scope/],
      [make('too-deep', { depth: 3 }), /depth limit/],
      [make('wrong-id', { sessionId: 'not-the-session' }), /identity/],
    ];
    const missing = make('missing'); fs.unlinkSync(missing.sessionFile); denied.push([missing, /ENOENT/]);
    const beforeDenied = launches;
    for (const [record, error] of denied) await assert.rejects(send(record.runId, 'never run'), error);
    await assert.rejects(send(first.runId, '  '), /blank/);
    await assert.rejects(send(first.runId, 'never run', AbortSignal.abort()), /aborted/);
    assert.equal(launches, beforeDenied, 'invalid requests must never launch a process');
    console.log('ok - cancelled/missing/mismatched history and reduced capabilities fail closed');

    const descendant = make('grandchild', { parentRunId: first.runId, depth: 2 });
    await assert.rejects(send(descendant.runId, 'never run'), /owner is no longer running/);
    assert.equal(launches, beforeDenied, 'must not bypass a dead descendant owner');
    console.log('ok - descendants remain routed through their owner, never adopted silently');
  } finally {
    await handlers.get('session_shutdown')?.({}, { mode: 'rpc' });
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise(resolve => child.once('close', resolve)); child.kill(); await done;
      }
    }
    Object.assign(cp, originals);
    for (const key of envKeys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
