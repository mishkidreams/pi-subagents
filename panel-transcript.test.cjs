// Real Pi + installed compact-transcript integration, with a memory terminal only.
// No agents, providers, clipboard or real session files. Optional PI_COMPACT_TRANSCRIPT_ROOT.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const compact = process.env.PI_COMPACT_TRANSCRIPT_ROOT || path.resolve(__dirname, '../pi-compact-transcript');
const stock = process.argv.includes('--stock');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const jiti = createJiti(__filename, {
  interopDefault: true, fsCache: false, moduleCache: false,
  alias: {
    '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
    '@earendil-works/pi-tui': path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    typebox: require.resolve('typebox', { paths: [pi] }),
  },
});

(async () => {
  const host = await jiti.import('@earendil-works/pi-coding-agent');
  host.initTheme('dark', false);
  const handlers = new Map();
  const commands = new Map();
  const extension = stock ? undefined : await jiti.import(path.join(compact, 'extensions/compact-transcript.ts'));
  extension?.default({ on: (event, fn) => handlers.set(event, fn), registerCommand: (name, command) => commands.set(name, command), registerEntryRenderer() {}, appendEntry() {} });
  const theme = { fg: (_c, t) => String(t), bg: (_c, t) => String(t), bold: t => String(t), italic: t => String(t) };
  const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {}, notify() {} } };
  handlers.get('agent_start')?.({}, ctx);
  const { SubagentPanel } = await jiti.import(path.join(__dirname, 'panel.ts'));
  const registry = await jiti.import(path.join(__dirname, 'registry.ts'));
  const { TuiAltScreen, ScrollView, Text, stripTerminalSequences } = await import(pathToFileURL(path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-transcript-'));
  let panel, ui, capturedChildTool;
  const originalToolRender = host.ToolExecutionComponent.prototype.render;
  host.ToolExecutionComponent.prototype.render = function(width) {
    if (this.toolCallId === 'child-call') capturedChildTool = this;
    return originalToolRender.call(this, width);
  };
  const forbidden = () => { throw new Error('OFFLINE: OS integration is forbidden'); };
  try {
    const terminal = { columns: 140, rows: stock ? 100 : 38, kittyProtocolActive: false, write: value => assert.ok(!/\x1b\]52;/.test(value)) };
    for (const method of ['start', 'stop', 'drainInput', 'moveBy', 'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress', 'setProgramStatus']) terminal[method] = forbidden;
    terminal.hideCursor = terminal.showCursor = () => {};
    ui = new TuiAltScreen(terminal, false, sandbox, { mouse: true, copyOnSelect: false, copySelection: forbidden, openUrl: forbidden, onRightClickPaste: forbidden });
    const parent = new ScrollView(new Text('PARENT_SENTINEL\n'.repeat(70), 0, 0), { primary: true, scrollbar: 'always' });
    ui.setLayoutRoot(parent); ui.beforeTerminalStart();
    const frame = () => { ui.renderNow(false); return ui.getScreenLines().map(stripTerminalSequences); };
    assert.ok(frame().some(line => line.includes('PARENT_SENTINEL')));
    parent.scrollTo(11); frame();
    const parentTop = parent.scrollTop;
    const parentTool = new host.ToolExecutionComponent('read', 'parent-call', { path: 'PARENT_FILE' }, {}, undefined, ui, sandbox);
    parentTool.updateResult({ content: [{ type: 'text', text: 'PARENT_PREVIEW\nPARENT_DEEP_DETAIL' }], isError: false });
    const parentThought = new host.AssistantMessageComponent({ content: [{ type: 'thinking', thinking: 'PARENT_THINK_DETAIL\nPARENT_THINK_PREVIEW' }] }, true);
    const plain = component => component.render(120).map(stripTerminalSequences);
    const parentBefore = { tool: plain(parentTool), thought: plain(parentThought) };
    // Restore an adjacent read burst: opening a child must not append to it.
    parentTool.updateArgs({ path: 'PARENT_FILE' });
    const session = path.join(sandbox, 'child.jsonl');
    const entries = [{ type: 'session', version: 3, id: 'child', timestamp: '2026-01-01T00:00:00Z', cwd: sandbox }];
    const append = message => {
      const id = `entry-${entries.length}`;
      entries.push({ type: 'message', id, parentId: entries.length > 1 ? entries.at(-1).id : null, timestamp: '2026-01-01T00:00:00Z', message });
      fs.writeFileSync(session, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    };
    append({ role: 'user', content: 'ORIGINAL_DELEGATION', timestamp: 0 });
    append({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'CHILD_THINK_DETAIL\nCHILD_THINK_PREVIEW' },
      { type: 'toolCall', id: 'child-call', name: 'read', arguments: { path: 'CHILD_FILE' } },
    ], stopReason: 'toolUse', timestamp: 1 });
    append({ role: 'toolResult', toolCallId: 'child-call', toolName: 'read', content: [{ type: 'text', text: stock ? 'PUBLIC_PREVIEW\n' + 'STOCK_EXTRA_ROW\n'.repeat(40) + 'CHILD_DEEP_DETAIL_2' : 'PUBLIC_PREVIEW\nCHILD_DEEP_DETAIL_1\nCHILD_DEEP_DETAIL_2' }], isError: false, timestamp: 2 });
    let expectedSession = fs.readFileSync(session, 'utf8');
    registry.saveRecord(sandbox, { version: 1, runId: 'child-id', parentRunId: 'root', rootRunId: 'root', sessionId: 'child', sessionFile: session, name: 'child-name', task: 'public fixture', cwd: sandbox, depth: 1, maxDepth: 2, status: 'completed', model: 'test/model', thinking: 'off', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:01Z' });
    const otherSession = path.join(sandbox, 'other.jsonl');
    fs.writeFileSync(otherSession, expectedSession.replaceAll('CHILD_', 'OTHER_'));
    registry.saveRecord(sandbox, { ...registry.readRecords(sandbox)[0], runId: 'other-id', sessionId: 'other', sessionFile: otherSession, name: 'other-child' });
    let sends = 0;
    panel = new SubagentPanel(ui, theme, sandbox, 'root', { onMessage: async () => { sends++; }, onCancel: forbidden });
    const openByName = name => {
      assert.equal(panel.openReview(), true);
      panel.handleInput('\x1b[A'); panel.handleInput('\x1b[A');
      assert.equal(panel.openReview(), true);
      for (let i = 0; i < 3; i++) {
        ui.handleTerminalInput('\x1b[C');
        if (frame().some(line => line.startsWith('Subagent:') && line.includes(name))) return;
        ui.handleTerminalInput('\x1b'); ui.handleTerminalInput('\x1b[B');
      }
      assert.fail(`child not found: ${name}`);
    };
    openByName('child-name');
    ui.handleTerminalInput('UNSENT_CHILD_DRAFT');
    const click = needle => {
      const lines = frame();
      const y = lines.findIndex(line => line.includes(needle) && (needle !== 'CHILD_FILE' || !line.includes('SECOND_CHILD_FILE')));
      assert.ok(y >= 0, `visible click target: ${needle}\n${lines.join('\n')}`);
      const x = lines[y].indexOf(needle) + 1;
      ui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
      ui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
      return frame();
    };
    const mode = process.argv.find(arg => arg.startsWith('--'));
    if (!mode || mode === '--keys') {
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')));
      ui.handleTerminalInput('\x0f');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'Ctrl+O expands tool output in the child overlay');
      ui.handleTerminalInput('\x0f');
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'Ctrl+O collapses child tools again');
      assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'child thinking begins collapsed');
      ui.handleTerminalInput('\x14');
      assert.ok(frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'Ctrl+T reveals child thinking');
      ui.handleTerminalInput('\x14');
      assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'Ctrl+T hides child thinking again');
      console.log('ok - Ctrl+O/Ctrl+T toggle only child disclosure');
    }
    if (stock) {
      // This projection has no renderer definition: native Pi's generic fallback
      // deliberately shows full output even when expanded=false.
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')));
      ui.handleTerminalInput('\x0f'); ui.handleTerminalInput('\x0f');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')));
      assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')));
      ui.handleTerminalInput('\x14');
      assert.ok(frame().some(line => line.includes('CHILD_THINK_DETAIL')));
      ui.handleTerminalInput('\x14');
      assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')));
      assert.ok(frame().some(line => line.includes('UNSENT_CHILD_DRAFT')));
      console.log('ok - stock Pi fallback remains readable and child thinking shortcuts need no compact adapter');
    }
    if (!mode || mode === '--async') {
      assert.ok(capturedChildTool);
      capturedChildTool.invalidate(); // Native image/transcoder callbacks run outside mouse/render dispatch.
      assert.deepEqual(plain(parentTool), parentBefore.tool, 'asynchronous native child invalidation must not publish into the main compact group');
      console.log('ok - asynchronous native child invalidation retains its owning display scope');
    }
    if (!mode || mode === '--tool') {
      click('CHILD_FILE');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'native SGR click expands the compact child tool');
      click('read');
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'click collapses the child tool again');
      console.log('ok - compact tool receives native viewport mouse coordinates');
    }
    if (!mode || mode === '--thinking') {
      click('CHILD_THINK_PREVIEW');
      assert.ok(frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'native SGR click expands the compact child thought');
      click('CHILD_THINK_DETAIL');
      assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'click collapses the child thought again');
      console.log('ok - compact thinking receives native viewport mouse coordinates');
    }
    if (!mode) {
      click('CHILD_FILE'); click('CHILD_THINK_PREVIEW');
      append({ role: 'user', content: 'APPEND_AFTER_LOCAL_DISCLOSURE', timestamp: 3 });
      expectedSession = fs.readFileSync(session, 'utf8');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'unrelated appended history preserves a locally opened tool');
      assert.ok(frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'unrelated appended history preserves a locally opened thought');
      ui.handleTerminalInput('\x0f'); ui.handleTerminalInput('\x0f');
      ui.handleTerminalInput('\x14'); ui.handleTerminalInput('\x14');
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')));
      assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')));
      append({ role: 'assistant', content: [{ type: 'toolCall', id: 'second-call', name: 'read', arguments: { path: 'SECOND_CHILD_FILE' } }], stopReason: 'toolUse', timestamp: 4 });
      append({ role: 'toolResult', toolCallId: 'second-call', toolName: 'read', content: [{ type: 'text', text: 'PUBLIC_PREVIEW\nSECOND_DEEP_DETAIL' }], isError: false, timestamp: 5 });
      expectedSession = fs.readFileSync(session, 'utf8');
      click('2×');
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')));
      click('CHILD_FILE');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'group offers the original call, not only its last member');
      assert.ok(!frame().some(line => line.includes('SECOND_DEEP_DETAIL')));
      click('2×');
      console.log('ok - local disclosure survives append and compact groups keep individual call selection');

      const savedRows = terminal.rows;
      for (let i = 0; i < 18; i++) append({ role: 'user', content: `SCROLL_MESSAGE_${i}`, timestamp: 10 + i });
      expectedSession = fs.readFileSync(session, 'utf8');
      terminal.rows = 15; frame();
      click('[↑ Start]');
      click('CHILD_THINK_PREVIEW');
      assert.ok(frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'thinking click uses visible coordinates after scrolling to old history');
      ui.handleTerminalInput('\x14'); ui.handleTerminalInput('\x14');
      click('2×');
      // Entries opened below the last visible row need a real child-only wheel step.
      ui.handleTerminalInput('\x1b[<65;5;8M'); frame();
      click('CHILD_FILE');
      ui.handleTerminalInput('\x1b[<65;5;8M'); frame();
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), `scrolled call details: ${frame().join('\n')}`);
      ui.handleTerminalInput('\x0f'); ui.handleTerminalInput('\x0f');
      click('[↑ Start]');
      assert.equal(parent.scrollTop, parentTop);
      terminal.rows = savedRows; frame();
      console.log('ok - scrolled viewport translates native mouse hit tests without moving the parent');

      const tui = await import(pathToFileURL(path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
      const previousBindings = tui.getKeybindings();
      try {
        const definitions = { 'app.tools.expand': { defaultKeys: 'ctrl+o' }, 'app.thinking.toggle': { defaultKeys: 'ctrl+t' } };
        tui.setKeybindings(new tui.KeybindingsManager(definitions, { 'app.tools.expand': 'ctrl+y', 'app.thinking.toggle': 'ctrl+b' }));
        ui.handleTerminalInput('\x0f'); ui.handleTerminalInput('\x14');
        assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'remapped defaults do not toggle child disclosure');
        ui.handleTerminalInput('\x02');
        assert.ok(frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'configured thinking binding is honored');
        ui.handleTerminalInput('\x02');
        ui.handleTerminalInput('\x19');
        click('[↓ Latest]');
        click('[↑ Start]');
        assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'configured tool binding is honored');
        ui.handleTerminalInput('\x19');
        tui.setKeybindings(new tui.KeybindingsManager(definitions, { 'app.tools.expand': [], 'app.thinking.toggle': [] }));
        ui.handleTerminalInput('\x0f'); ui.handleTerminalInput('\x14');
        assert.ok(!frame().some(line => line.includes('CHILD_THINK_DETAIL')), 'explicitly disabled bindings do not fall back to defaults');
      } finally { tui.setKeybindings(previousBindings); }
      const factory = globalThis[Symbol.for('pi-compact-transcript.scope-factory')];
      const disposable = factory();
      assert.throws(() => disposable.run(() => { throw new Error('PUBLIC_SCOPE_FAILURE'); }), /PUBLIC_SCOPE_FAILURE/);
      disposable.dispose();
      extension.default({ on() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {} });
      click('2×'); click('CHILD_FILE');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'existing child scope survives repeated extension load');
      click('2×');
      console.log('ok - remapped/disabled keys, exception restoration and existing scopes across reload');
      await commands.get('compact-transcript').handler('off', ctx);
      assert.ok(!frame().some(line => line.includes('2×')), 'existing child scopes follow compact off without stale compact rows');
      await commands.get('compact-transcript').handler('on', ctx);
      assert.ok(frame().some(line => line.includes('2×')), 'existing child scopes restore compact grouping');
      const abandonedTool = capturedChildTool;
      fs.writeFileSync(session, entries.slice(0, 4).map(entry => JSON.stringify(entry)).join('\n') + '\n');
      expectedSession = fs.readFileSync(session, 'utf8');
      assert.ok(frame().some(line => line.includes('CHILD_FILE')), 'rewinding the active branch does not leave its surviving call hidden by a removed group');
      assert.ok(!frame().some(line => line.includes('2×') || line.includes('SECOND_CHILD_FILE')));
      abandonedTool.invalidate();
      assert.deepEqual(plain(parentTool), parentBefore.tool, 'late callback from an abandoned branch cannot escape its disposed scope');
      assert.ok(!frame().some(line => line.includes('2×')));
      console.log('ok - compact on/off and active-branch replacement discard stale grouping');
    }
    if (!mode) {
      openByName('other-child');
      assert.ok(!frame().some(line => line.includes('UNSENT_CHILD_DRAFT')), 'other child has its own input');
      ui.handleTerminalInput('\x0f');
      assert.ok(frame().some(line => line.includes('OTHER_DEEP_DETAIL_2')));
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')));
      openByName('child-name');
      assert.ok(!frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'other child expansion cannot change this child');
      assert.ok(frame().some(line => line.includes('UNSENT_CHILD_DRAFT')), 'disclosure shortcuts and clicks never alter or send the draft');
      click('CHILD_FILE');
      openByName('other-child');
      ui.handleTerminalInput('\x0f');
      openByName('child-name');
      assert.ok(frame().some(line => line.includes('CHILD_DEEP_DETAIL_2')), 'per-call override survives switching children');
      click('read');
      console.log('ok - per-child disclosure isolation with colliding tool IDs and independent drafts');
    }
    if (!mode || mode === '--isolation' || stock) {
      assert.deepEqual(plain(parentTool), parentBefore.tool, 'child hydration must not group or reformat parent tool rows');
      assert.deepEqual(plain(parentThought), parentBefore.thought, 'child interaction must not change parent thinking');
      assert.equal(parent.scrollTop, parentTop);
      assert.equal(fs.readFileSync(session, 'utf8'), expectedSession, 'disclosure never writes child history');
      assert.equal(sends, 0, 'disclosure never submits a prompt');
      console.log('ok - parent transcript and saved child history are untouched');
    }
    console.log('ALL PASS');
  } finally {
    panel?.dispose();
    host.ToolExecutionComponent.prototype.render = originalToolRender;
    handlers.get('session_shutdown')?.({}, ctx);
    if (ui) { ui.stopped = true; ui.beforeTerminalStop({ preserveScreen: true }); ui.afterTerminalStop({ preserveScreen: true }); }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
