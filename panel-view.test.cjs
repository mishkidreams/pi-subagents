// Native fullscreen transcript regression. No agents, API, real terminal or clipboard.
// Run: node panel-view.test.cjs (PI_ROOT may point at the installed Pi package).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const jiti = createJiti(__filename, {
  interopDefault: true, fsCache: false, moduleCache: false,
  alias: {
    '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
    '@earendil-works/pi-tui': path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    typebox: require.resolve('typebox', { paths: [pi] }),
  },
});
const theme = { fg: (_c, t) => String(t), bg: (_c, t) => String(t), bold: t => String(t) };

(async () => {
  const host = await jiti.import('@earendil-works/pi-coding-agent');
  host.initTheme('dark', false);
  const { SubagentPanel } = await jiti.import(path.join(__dirname, 'panel.ts'));
  const registry = await jiti.import(path.join(__dirname, 'registry.ts'));
  const { TuiAltScreen, ScrollView, Text, stripTerminalSequences } = await import(pathToFileURL(path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-view-'));
  let panel, ui;
  const forbidden = () => { throw new Error('OFFLINE: OS integration is forbidden'); };
  try {
    const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, write: value => assert.ok(!/\x1b\]52;/.test(value)) };
    for (const method of ['start', 'stop', 'drainInput', 'moveBy', 'hideCursor', 'showCursor', 'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress', 'setProgramStatus']) terminal[method] = forbidden;
    terminal.hideCursor = terminal.showCursor = () => {}; // Memory-terminal cursor operations, no OS output.
    ui = new TuiAltScreen(terminal, false, sandbox, { mouse: true, copyOnSelect: false, copySelection: forbidden, openUrl: forbidden, onRightClickPaste: forbidden });
    const parent = new ScrollView(new Text(Array.from({ length: 90 }, (_, i) => `PARENT_SENTINEL ${i}`).join('\n'), 0, 0), { primary: true, scrollbar: 'always' });
    ui.setLayoutRoot(parent);
    ui.beforeTerminalStart(); // Activate only the in-memory renderer, never Terminal.start().
    const frame = () => { ui.renderNow(false); return ui.getScreenLines().map(stripTerminalSequences); };
    assert.ok(frame().some(l => l.includes('PARENT_SENTINEL')), 'positive control: parent is really rendered before opening');
    parent.scrollTo(15); frame();
    const parentTop = parent.scrollTop;
    const session = path.join(sandbox, 'child.jsonl');
    const entries = [{ type: 'session', version: 3, id: 'child', timestamp: '2026-01-01T00:00:00Z', cwd: sandbox }];
    const append = (from, to) => {
      for (let i = from; i < to; i++) entries.push({ type: 'message', id: `msg-${i}`, parentId: i ? `msg-${i - 1}` : null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: `CHILD_MESSAGE ${i}`, timestamp: i } });
      fs.writeFileSync(session, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    };
    append(0, 70);
    const record = { version: 1, runId: 'actual-child-id', parentRunId: 'root', rootRunId: 'root', sessionId: 'child', sessionFile: session, name: 'actual-child-name', task: 'public fixture', cwd: sandbox, depth: 1, maxDepth: 2, status: 'completed', model: 'test/model', thinking: 'off', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:01Z' };
    registry.saveRecord(sandbox, record);
    let sent;
    let cancelled = 0;
    let sendError = false;
    let pendingSend;
    let sendCalls = 0;
    panel = new SubagentPanel(ui, theme, sandbox, 'root', {
      onMessage: async (r, text) => {
        sendCalls++;
        if (sendError) throw new Error('PUBLIC_SEND_FAILURE');
        sent = [r.runId, text];
        if (pendingSend && r.runId === record.runId) await pendingSend;
      },
      onCancel: () => { cancelled++; },
    });
    assert.equal(panel.openReview(), true);
    ui.handleTerminalInput('\x1b[C');
    let screen = frame();
    assert.ok(!screen.some(l => l.includes('PARENT_SENTINEL')), 'the child view must cover the parent, including all terminal edges');
    assert.ok(screen[0].includes('actual-child-name'), 'actual child identity is pinned at top');
    assert.ok(!/\b(?:FOLLOW|HISTORY)\b|\d+[–-]\d+\/\d+/.test(screen.slice(0,4).join('\n')), 'header omits redundant scroll modes and line counters');
    assert.ok(screen.at(-1).includes('Esc'), 'navigation help is pinned at bottom');
    assert.ok(screen.some(l => l.includes('Message this subagent')), 'message field stays visible');
    assert.ok(screen.some(l => /[█░]/.test(l)), 'the transcript has a persistent visible scrollbar');
    assert.ok(!/[╭╮╰╯┌┐└┘]/.test(screen.join('\n')), 'fullscreen view has no outer frame');
    console.log('ok - fullscreen covers parent; fixed identity, input, help and scrollbar; no outer frame');

    const body = () => frame().filter(l => l.includes('CHILD_MESSAGE')).map(l => l.slice(0, -1).trimEnd());
    const click = needle => {
      const lines = frame();
      const y = lines.findIndex(line => line.includes(needle));
      assert.ok(y >= 0, `visible control: ${needle}`);
      const x = lines[y].indexOf(needle) + 1;
      ui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
      ui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
      frame();
    };
    const latest = body();
    ui.handleTerminalInput('\x1b[5~');
    const older = body();
    assert.notDeepEqual(older, latest);
    assert.ok(frame()[0].includes('actual-child-name'));
    assert.equal(parent.scrollTop, parentTop, 'page keys must not scroll the parent');
    append(70, 75);
    assert.deepEqual(body(), older, 'appended child messages must not move a reader of old history');
    ui.handleTerminalInput('\x1b[<65;5;8M');
    assert.notDeepEqual(body(), older, 'native SGR mouse wheel scrolls the child');
    assert.equal(parent.scrollTop, parentTop, 'wheel must not scroll the parent');
    console.log('ok - page/wheel isolation and stable old-history reading during append');

    click('[↓ Latest]');
    assert.ok(body().some(l => l.includes('CHILD_MESSAGE 74')), 'mouse alone reaches latest');
    append(75, 76);
    assert.ok(body().some(l => l.includes('CHILD_MESSAGE 75')), 'Latest resumes follow-tail');
    click('[↑ Start]');
    assert.ok(body().some(l => l.includes('CHILD_MESSAGE 0')), 'mouse alone reaches the original prompt');
    ui.handleTerminalInput('\x1b[1;5F'); frame();
    assert.ok(body().some(l => l.includes('CHILD_MESSAGE 75')), 'Ctrl+End is an optional alternative');
    ui.handleTerminalInput('\x1b[1;5H'); frame();
    assert.ok(body().some(l => l.includes('CHILD_MESSAGE 0')), 'Ctrl+Home is an optional alternative');
    ui.handleTerminalInput('hello');
    ui.handleTerminalInput('\x1b[H');
    ui.handleTerminalInput('X');
    ui.handleTerminalInput('\x1b[F');
    ui.handleTerminalInput('Y');
    frame();
    ui.handleTerminalInput('\r'); await new Promise(setImmediate); frame();
    assert.deepEqual(sent, ['actual-child-id', 'XhelloY'], 'plain Home/End keep their input editing meaning');
    assert.ok(frame()[0].includes('actual-child-name'), 'send does not close the view');
    console.log('ok - clickable Start/Latest, optional Ctrl+Home/End and normal input editing/send');

    // Native scrollbar press/drag/release controls the child, never the parent.
    ui.handleTerminalInput(`\x1b[<0;${terminal.columns};5M`);
    ui.handleTerminalInput(`\x1b[<32;${terminal.columns};4M`);
    ui.handleTerminalInput(`\x1b[<0;${terminal.columns};4m`);
    assert.ok(body().some(l => l.includes('CHILD_MESSAGE 0')));
    assert.equal(parent.scrollTop, parentTop);
    console.log('ok - native scrollbar drag');

    ui.handleTerminalInput('draft for this child');
    click('[Esc back]');
    assert.equal(cancelled, 0, 'mouse Back must not cancel an agent');
    ui.handleTerminalInput('\x1b[C'); frame();
    assert.ok(frame().some(l => l.includes('draft for this child')), 'Back/reopen preserves the unsent draft');
    sendError = true;
    ui.handleTerminalInput('\r'); await new Promise(setImmediate); frame();
    assert.ok(frame().some(l => l.includes('PUBLIC_SEND_FAILURE')), 'send failure is visible');
    assert.ok(frame().some(l => l.includes('draft for this child')), 'failed send preserves the draft for retry');
    sendError = false;
    ui.handleTerminalInput('\r'); await new Promise(setImmediate); frame();
    assert.deepEqual(sent, ['actual-child-id', 'draft for this child']);
    console.log('ok - safe Back, saved draft, visible failure and retry');

    for (const [columns, rows] of [[40, 12], [120, 36], [18, 8], [80, 24]]) {
      terminal.columns = columns; terminal.rows = rows;
      screen = frame();
      assert.equal(screen.length, rows);
      assert.ok(!screen.some(l => l.includes('PARENT_SENTINEL')));
      assert.ok(screen.at(-1).includes('Esc'));
      if (columns >= 40) {
        assert.ok(screen.at(-1).includes('Start') && screen.at(-1).includes('Latest') && screen.at(-1).includes('back'), 'named mouse controls must remain discoverable at 40 columns');
      }
      assert.ok(screen.some(line => line.includes('test/model')), 'model stays pinned at eight rows');
    }
    ui.handleTerminalInput('\x1b'); frame();
    assert.ok(panel.render(80).some(l => l.includes('actual-child-name')), 'Esc returns to the list');
    ui.handleTerminalInput('\x1b'); frame();
    assert.ok(frame().some(l => l.includes('PARENT_SENTINEL')), 'second Esc restores the parent');
    assert.equal(parent.scrollTop, parentTop);
    assert.equal(cancelled, 0, 'Esc never stops the child');
    console.log('ok - resize, Esc navigation without cancellation and original parent position');

    registry.saveRecord(sandbox, { ...record, status: 'thinking', finishedAt: undefined, pid: process.pid });
    const other = { ...record, runId: 'other-child-id', name: 'other-child', startedAt: '2026-01-01T00:00:02Z' };
    registry.saveRecord(sandbox, other);
    const openChild = name => {
      assert.equal(panel.openReview(), true);
      panel.handleInput('\x1b[A');
      panel.openReview(); // Start at the first row even when Up from row zero returns to the editor.
      for (let i = 0; i < 2; i++) {
        panel.handleInput('\x1b[C');
        if (frame()[0].includes(name)) return;
        ui.handleTerminalInput('\x1b'); frame();
        panel.handleInput('\x1b[B');
      }
      assert.fail(`child not found: ${name}`);
    };
    openChild('actual-child-name');
    ui.handleTerminalInput('private draft A');
    ui.handleTerminalInput('\x1b'); frame();
    openChild('other-child');
    ui.handleTerminalInput('\x1a'); // Undo must not expose a different child's editor history.
    assert.ok(!frame().some(line => line.includes('private draft A')));
    ui.handleTerminalInput('draft B');
    ui.handleTerminalInput('\x1b'); frame();
    openChild('actual-child-name');
    assert.ok(frame().some(line => line.includes('private draft A')));
    let release;
    pendingSend = new Promise(resolve => { release = resolve; });
    const beforeCalls = sendCalls;
    ui.handleTerminalInput('\r');
    ui.handleTerminalInput('\r');
    await new Promise(setImmediate);
    assert.equal(sendCalls, beforeCalls + 1, 'repeated Enter cannot duplicate a pending send');
    ui.handleTerminalInput('\x15');
    ui.handleTerminalInput('private draft A');
    release(); await new Promise(setImmediate);
    assert.ok(frame().some(line => line.includes('private draft A')), 'old acknowledgment cannot clear a newly edited identical draft');
    pendingSend = undefined;
    ui.handleTerminalInput('\x1b'); frame();
    openChild('other-child');
    assert.ok(frame().some(line => line.includes('draft B')), 'drafts are isolated per recipient');
    assert.ok(!frame().some(line => line.includes('private draft A')));
    assert.deepEqual(sent, ['actual-child-id', 'private draft A']);
    ui.handleTerminalInput('\x1b'); frame();
    openChild('actual-child-name');
    pendingSend = new Promise(resolve => { release = resolve; });
    ui.handleTerminalInput('\r');
    ui.handleTerminalInput('\x1b'); frame();
    openChild('other-child'); // Switch before the queued send callback even starts.
    await new Promise(setImmediate);
    assert.deepEqual(sent, ['actual-child-id', 'private draft A'], 'recipient is frozen before asynchronous delivery');
    release(); await new Promise(setImmediate);
    assert.ok(frame()[0].includes('other-child'));
    assert.ok(frame().some(line => line.includes('draft B')), 'another child acknowledgment cannot clear this draft');
    assert.ok(!frame().some(line => line.includes('Sent ·')), 'another child acknowledgment cannot overwrite this status');
    pendingSend = undefined;
    ui.handleTerminalInput('\x1b'); frame();
    ui.handleTerminalInput('\x1b'); frame();
    assert.equal(cancelled, 0);
    assert.equal(registry.readRecords(sandbox).find(r => r.runId === record.runId).status, 'thinking', 'closing leaves a running agent running');
    console.log('ok - per-child drafts/undo, pending-send deduplication, stale acknowledgment and no accidental stop');
    console.log('ALL PASS');
  } finally {
    panel?.dispose();
    if (ui) { ui.stopped = true; ui.beforeTerminalStop({ preserveScreen: true }); ui.afterTerminalStop({ preserveScreen: true }); }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
