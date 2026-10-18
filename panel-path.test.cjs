// Native path-copy regression: memory terminal, synthetic sessions, injected clipboard only.
// Run: node panel-path.test.cjs (PI_ROOT may point to the installed Pi package).
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
  '@earendil-works/pi-tui': path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: require.resolve('typebox', { paths: [pi] }),
} });
const theme = { fg: (_c, text) => String(text), bg: (_c, text) => String(text), bold: text => String(text) };
(async () => {
  const host = await jiti.import('@earendil-works/pi-coding-agent'); host.initTheme('dark', false);
  const { SubagentPanel } = await jiti.import(path.join(__dirname, 'panel.ts'));
  const registry = await jiti.import(path.join(__dirname, 'registry.ts'));
  const { TuiAltScreen, Text, stripTerminalSequences, visibleWidth } = await import(pathToFileURL(path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-path-'));
  const forbidden = () => { throw new Error('OFFLINE: real OS interaction forbidden'); };
  let panel, ui;
  try {
    const terminal = { columns: 160, rows: 24, kittyProtocolActive: false, write: text => assert.ok(!/\x1b\]52;/.test(text)), hideCursor() {}, showCursor() {} };
    for (const method of ['start','stop','drainInput','moveBy','clearLine','clearFromCursor','clearScreen','setTitle','setProgress','setProgramStatus']) terminal[method] = forbidden;
    ui = new TuiAltScreen(terminal, false, sandbox, { mouse: true, copyOnSelect: false, copySelection: forbidden, openUrl: forbidden, onRightClickPaste: forbidden });
    ui.setLayoutRoot(new Text('PARENT_SENTINEL', 0, 0)); ui.beforeTerminalStart();
    const frame = () => { ui.renderNow(false); return ui.getScreenLines().map(stripTerminalSequences); };
    assert.ok(frame().some(line => line.includes('PARENT_SENTINEL')));
    const sessionFile = path.join(sandbox, 'child.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'child', cwd: sandbox, timestamp: '2026-01-01T00:00:00Z' }) + '\n');
    const record = { version: 1, runId: 'path-child', parentRunId: 'root', rootRunId: 'root', sessionId: 'child', sessionFile, name: 'path-fixture', task: 'Public fixture only', cwd: path.join(os.homedir(), 'S01-public-fixture', 'nested folder'), depth: 1, maxDepth: 2, status: 'completed', model: 'test/model', thinking: 'off', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:01Z' };
    registry.saveRecord(sandbox, record);
    let copied = [], fail = false, release;
    let pending, messagePending, messageFailure = false;
    panel = new SubagentPanel(ui, theme, sandbox, 'root', { onCopyPath: async value => {
      copied.push(value);
      if (fail) throw new Error('PUBLIC_CLIPBOARD_FAILURE');
      if (pending) await pending;
    }, onMessage: async () => {
      if (messagePending) await messagePending;
      if (messageFailure) throw new Error('PUBLIC_PATH_SEND_FAILURE');
    } });
    await panel.ready();
    const open = () => { assert.equal(panel.openReview(), true); ui.handleTerminalInput('\x1b[C'); return frame(); };
    const click = text => {
      const screen = frame(), y = screen.findIndex(line => line.includes(text));
      assert.ok(y >= 0, `visible click target: ${text}`);
      const x = visibleWidth(screen[y].slice(0, screen[y].indexOf(text))) + 1;
      ui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
      ui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
      frame();
    };
    open();
    if (!process.argv.includes('--copy')) {
      assert.ok(frame().some(line => /~[\\/]S01-public-fixture/.test(line)), 'home path uses ~ for the native platform separators');
      console.log('ok - native home path is abbreviated');
    }
    if (process.argv.includes('--home')) return;
    if (process.argv.includes('--layout')) {
      for (const [columns, pathRow] of [[240, 0], [100, 1], [40, 2], [240, 0]]) {
        terminal.columns = columns;
        const screen = frame();
        assert.equal(screen.findIndex(line => line.includes('Path:')), pathRow, 'header packs identity, model and path into the available width instead of always reserving three rows');
        if (columns >= 100) assert.ok(screen[0].includes(record.model), 'wide title row retains the model');
        click('Path:'); await new Promise(setImmediate);
        assert.equal(copied.at(-1), record.cwd, 'copy hitbox follows the responsive header');
      }
      const count = copied.length;
      click('Subagent:'); await new Promise(setImmediate);
      assert.equal(copied.length, count, 'clicking an identity on the same row must not copy the path');
      console.log('ok - responsive one/two/three-row header and path-only hitbox after resize');
      return;
    }
    mock.timers.enable({ apis: ['setTimeout'] });
    click('S01-public-fixture'); await new Promise(setImmediate);
    assert.deepEqual(copied, [record.cwd], 'clicking the displayed folder copies the full unmodified absolute cwd');
    assert.ok(frame().some(line => /Copied/.test(line)), 'copy completion has visible feedback');
    mock.timers.tick(2500); await new Promise(setImmediate);
    assert.ok(!frame().some(line => /Copied path/.test(line)), 'successful copy feedback expires instead of permanently replacing message status');
    if (process.argv.includes('--feedback')) return;
    fail = true;
    click('S01-public-fixture'); await new Promise(setImmediate);
    assert.ok(frame().some(line => /Copy failed/.test(line)), 'clipboard rejection is visible, not an unhandled rejection');
    mock.timers.tick(2500); await new Promise(setImmediate);
    assert.ok(frame().some(line => /Copy failed/.test(line)), 'copy failure stays visible for retry instead of timing out like success');
    fail = false;
    click('S01-public-fixture'); await new Promise(setImmediate);
    mock.timers.tick(1000);
    pending = new Promise(resolve => { release = resolve; });
    const count = copied.length;
    click('S01-public-fixture'); click('S01-public-fixture'); await new Promise(setImmediate);
    assert.equal(copied.length, count + 1, 'a pending clipboard operation is not duplicated');
    mock.timers.tick(1500); await new Promise(setImmediate);
    assert.ok(frame().some(line => /Copying path/.test(line)), 'the previous success deadline cannot clear a new pending copy');
    release(); await new Promise(setImmediate); pending = undefined;
    mock.timers.tick(1500); await new Promise(setImmediate);
    assert.ok(frame().some(line => /Copied path/.test(line)), 'success gets a fresh timeout after the pending copy resolves');
    mock.timers.tick(501); await new Promise(setImmediate);
    assert.ok(!frame().some(line => /Copied path/.test(line)));
    for (const [columns, rows] of [[40,12], [18,8], [80,24]]) {
      terminal.columns = columns; terminal.rows = rows;
      const screen = frame();
      assert.equal(screen.length, rows);
      assert.ok(!screen.some(line => line.includes('PARENT_SENTINEL')));
      click('Path'); await new Promise(setImmediate);
      assert.equal(copied.at(-1), record.cwd, 'short layout still copies the full path');
    }
    terminal.columns = 160; terminal.rows = 24;
    for (const cwd of [os.homedir(), os.homedir().replaceAll('\\', '/') + '/S01-public-fixture', os.homedir() + '-other/S01-public-fixture']) {
      ui.handleTerminalInput('\x1b'); frame();
      registry.saveRecord(sandbox, { ...record, cwd });
      await panel.ready();
      const screen = open();
      assert.equal(screen.some(line => line.includes('~')), !cwd.includes('-other/'), 'home abbreviation respects separator variants and the directory boundary');
    }
    pending = new Promise(resolve => { release = resolve; });
    click('Path:'); await new Promise(setImmediate);
    messageFailure = true;
    ui.handleTerminalInput('message while copying'); ui.handleTerminalInput('\r'); await new Promise(setImmediate);
    assert.ok(frame().some(line => line.includes('PUBLIC_PATH_SEND_FAILURE')));
    release(); await new Promise(setImmediate); pending = undefined;
    assert.ok(frame().some(line => line.includes('PUBLIC_PATH_SEND_FAILURE')), 'late clipboard success cannot replace the newer send failure');
    assert.ok(!frame().some(line => /Copied path/.test(line)));
    for (const copyOutcome of ['pending', 'success', 'failure']) {
      messageFailure = false;
      let rejectMessage;
      messagePending = new Promise((_resolve, reject) => { rejectMessage = reject; });
      const draft = `message before path ${copyOutcome}`;
      ui.handleTerminalInput('\x15'); ui.handleTerminalInput(draft); ui.handleTerminalInput('\r');
      await new Promise(setImmediate);
      assert.ok(frame().some(line => /Sending/.test(line)), 'the send is still pending before the copy starts');
      pending = new Promise(resolve => { release = resolve; });
      fail = copyOutcome === 'failure';
      click('Path:'); await new Promise(setImmediate);
      if (copyOutcome !== 'pending') {
        release(); await new Promise(setImmediate); pending = undefined;
        const feedback = copyOutcome === 'failure' ? /Copy failed/ : /Copied path/;
        assert.ok(frame().some(line => feedback.test(line)), 'the copy feedback exists before the send fails');
      } else {
        assert.ok(frame().some(line => /Copying path/.test(line)));
      }
      const failure = `PUBLIC_LATE_SEND_FAILURE_${copyOutcome}`;
      rejectMessage(new Error(failure)); await new Promise(setImmediate);
      assert.ok(frame().some(line => line.includes(failure)), `a later send failure must replace ${copyOutcome} clipboard feedback immediately`);
      assert.ok(frame().some(line => line.includes(draft)), 'a failed send keeps the original draft');
      if (copyOutcome === 'pending') {
        release(); await new Promise(setImmediate); pending = undefined;
        assert.ok(frame().some(line => line.includes(failure)), 'a copy completing after the failure cannot hide it again');
      }
      mock.timers.tick(2500); await new Promise(setImmediate);
      assert.ok(frame().some(line => line.includes(failure)), 'a stale copy deadline cannot remove the send failure');
      assert.ok(!frame().some(line => /Copying path|Copied path|Copy failed/.test(line)));
      messagePending = undefined;
      fail = false;
    }
    pending = new Promise(resolve => { release = resolve; });
    click('Path:'); await new Promise(setImmediate);
    panel.dispose();
    release(); await new Promise(setImmediate); pending = undefined;
    mock.timers.tick(3000); await new Promise(setImmediate);
    console.log('ok - full-path copy, transient feedback, failures, pending races, narrow layout, home boundaries and disposal');
    console.log('ALL PASS');
  } finally {
    panel?.dispose();
    mock.timers.reset();
    if (ui) { ui.stopped = true; ui.beforeTerminalStop({ preserveScreen: true }); ui.afterTerminalStop({ preserveScreen: true }); }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
