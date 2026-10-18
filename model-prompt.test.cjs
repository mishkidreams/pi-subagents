// Offline extension lifecycle tests: node model-prompt.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const npmRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules') : '';
const pi = process.env.PI_PACKAGE_DIR || path.join(npmRoot, '@earendil-works/pi-coding-agent');
const { createJiti } = require(process.env.JITI_PATH || path.join(pi, 'node_modules/jiti'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-model-prompt-'));
const restores = [];
let forbiddenCalls = 0;
for (const [moduleName, methods] of [
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
]) {
  const module = require(moduleName);
  for (const method of methods) {
    const original = module[method];
    module[method] = () => { forbiddenCalls++; throw new Error(`Forbidden offline operation: ${moduleName}.${method}`); };
    restores.push(() => { module[method] = original; });
  }
}
const originalFetch = global.fetch;
global.fetch = () => { forbiddenCalls++; throw new Error('Forbidden offline operation: fetch'); };
restores.push(() => { global.fetch = originalFetch; });
syncBuiltinESMExports();

const envNames = [
  'PI_CODING_AGENT_DIR', 'PI_SUBAGENT_DEPTH', 'PI_SUBAGENT_RUN_ID', 'PI_SUBAGENT_ROOT_RUN_ID',
  'PI_SUBAGENT_PARENT_RUN_ID', 'PI_SUBAGENT_PARENT_SESSION_ID', 'PI_SUBAGENT_PARENT_AGENT_DIR',
  'PI_SUBAGENT_OWNER', 'PI_SUBAGENT_MAX_DEPTH', 'PI_SUBAGENT_MAX_CONCURRENCY', 'PI_SUBAGENT_MODEL_CONFIG',
];
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const setEnv = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
restores.push(() => { for (const name of envNames) setEnv(name, originalEnv[name]); });

const tests = [];
const test = (name, run) => tests.push({ name, run });
const model = id => ({ provider: 'test', id });
const userDescription = '  USER text: preserve punctuation, spacing & choice.\nSecond line, verbatim.  ';
const settings = () => ({
  maxDepth: 2,
  defaultModel: 'selected',
  modelAliases: {
    selected: { model: 'test/alpha', thinking: 'low', description: userDescription },
    inherited: { model: 'test/beta' },
    disabled: { model: 'test/alpha', enabled: false, description: 'DISABLED_ALIAS_DESCRIPTION' },
    excluded: { model: 'test/gamma', description: 'EXCLUDED_ALIAS_DESCRIPTION' },
    unavailable: { model: 'test/missing', description: 'UNAVAILABLE_ALIAS_DESCRIPTION' },
    incompatible: { model: 'test/beta', thinking: 'high', description: 'INCOMPATIBLE_ALIAS_DESCRIPTION' },
  },
});
const strictSettings = () => ({
  maxDepth: 2, aliasesOnly: true, defaultModel: 'selected',
  modelAliases: {
    selected: settings().modelAliases.selected,
    inherited: settings().modelAliases.inherited,
    disabled: { model: 'test/missing', enabled: false, description: 'DISABLED_ALIAS_DESCRIPTION' },
  },
});
let extension, normalizeBuildSystemPromptOptions, buildSystemPrompt;
let sessionNumber = 0;

async function withSession(options, run) {
  const number = ++sessionNumber;
  const agentDir = path.join(sandbox, `agent-${number}`);
  const cwd = path.join(sandbox, `project-${number}`);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const configPath = path.join(agentDir, 'subagents.json');
  fs.writeFileSync(configPath, options.rawSettings ?? JSON.stringify(options.settings ?? settings()));
  for (const name of envNames) delete process.env[name];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_DEPTH = String(options.depth ?? 0);
  if (options.inheritedSettings) {
    process.env.PI_SUBAGENT_MODEL_CONFIG = JSON.stringify(options.inheritedSettings);
  }
  const handlers = new Map();
  const tools = new Map();
  const notifications = [];
  const messages = [];
  let activeTools = options.activeTools ?? ['spawn_agent'];
  let allTools = options.allTools;
  const api = {
    on(name, handler) { handlers.set(name, handler); },
    registerFlag() {}, getFlag() { return undefined; },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMessageRenderer() {}, registerCommand() {},
    getActiveTools() { return activeTools; },
    ...(options.allTools === undefined ? {} : { getAllTools() { return allTools; } }),
    sendMessage(message) { messages.push(message); },
    setLabel() {},
  };
  const ctx = {
    cwd, hasUI: options.hasUI ?? true, mode: options.hasUI === false ? 'json' : 'rpc', thinkingLevel: 'medium', model: model('alpha'), isProjectTrusted: () => false,
    scopedModels: options.scopedModels ?? [{ model: model('alpha') }, { model: model('beta'), thinkingLevel: 'low' }],
    ...(options.registry === false ? {} : { modelRegistry: { getAvailable: () => options.availableModels ?? [model('alpha'), model('beta'), model('gamma')] } }),
    sessionManager: { getSessionId: () => `model-prompt-${number}`, getBranch: () => [], getSessionFile: () => undefined },
    ui: { setWidget() {}, notify(message) { notifications.push(message); } },
  };
  extension(api);
  const prompt = (input = {}) => {
    const event = {
      type: 'before_agent_start', prompt: 'Delegate this task', images: [], systemPrompt: 'BASE_SYSTEM_PROMPT',
      systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd, sections: { other_extension: 'KEEP_ME' }, ...input }),
    };
    const originalOptions = event.systemPromptOptions;
    const originalSections = originalOptions.sections;
    const originalOther = structuredClone({ ...originalOptions, sections: undefined });
    const result = handlers.get('before_agent_start')(event, ctx);
    assert.equal(result, undefined, 'must mutate only the structured section, not return a replacement prompt or chat message');
    assert.equal(event.systemPrompt, 'BASE_SYSTEM_PROMPT');
    assert.equal(event.systemPromptOptions, originalOptions);
    assert.equal(event.systemPromptOptions.sections, originalSections);
    assert.deepEqual({ ...originalOptions, sections: undefined }, originalOther);
    assert.equal(originalSections.other_extension, 'KEEP_ME');
    return event;
  };
  try {
    await handlers.get('session_start')({ type: 'session_start' }, ctx);
    if (options.startupError && ctx.hasUI) {
      assert.equal(notifications.length, 1, 'startup failure must notify UI once');
      assert.match(notifications[0], options.startupError);
    } else {
      assert.deepEqual(notifications, [], 'valid or non-UI sessions must not notify');
    }
    await run({ ctx, tools, handlers, prompt, messages, notifications, configPath, setActive: value => { activeTools = value; }, setAll: value => { allTools = value; } });
    assert.deepEqual(messages, [], 'catalog must never be appended as a chat message');
  } finally {
    await handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx);
  }
}

test('malformed config retains its path and actionable cause in UI and every unavailable tool', async () => {
  for (const hasUI of [true, false]) {
    await withSession({ rawSettings: '{ invalid JSON', hasUI, startupError: /Could not read/ }, async ({ tools, ctx, prompt, notifications, configPath }) => {
      const spawn = await tools.get('spawn_agent').execute('bad-config', { task: 'must not spawn' }, undefined, undefined, ctx);
      assert.equal(spawn.isError, true);
      const cause = spawn.content[0].text;
      assert.ok(cause.includes(configPath), 'config path must survive initialization failure');
      assert.match(cause, /Could not read/);
      assert.match(cause, /fix.*reload/is);
      assert.doesNotMatch(cause, /settings failed to initialize/);
      if (hasUI) assert.equal(notifications[0], cause);
      for (const [name, params] of [
        ['send_to_subagent', { target: 'missing', message: 'hello' }],
        ['check_subagents', { wait: false }], ['read_subagent_messages', { target: 'missing' }], ['cancel_subagent', { target: 'missing' }],
      ]) {
        const result = await tools.get(name).execute('bad-config', params, undefined, undefined, ctx);
        assert.equal(result.isError, true, name);
        assert.equal(result.content[0].text, cause, name);
      }
      for (let turn = 0; turn < 2; turn++) {
        const section = prompt().systemPromptOptions.sections.subagent_models;
        assert.match(section, /unavailable.*configuration error/is);
        assert.ok(section.includes(cause));
      }
      assert.equal(notifications.length, hasUI ? 1 : 0, 'turns and tools must not repeat startup notification');
    });
  }
});

function checkCatalog(event) {
  const catalog = event.systemPromptOptions.sections.subagent_models;
  assert.equal(typeof catalog, 'string');
  assert.match(catalog, /selected.*test\/alpha; thinking=low/);
  assert.match(catalog, /Default: selected/);
  assert.ok(catalog.includes(userDescription), 'user description must be present verbatim');
  assert.match(catalog, /inherited.*test\/beta; thinking=low/);
  for (const omitted of ['DISABLED_ALIAS_DESCRIPTION', 'disabled →', 'EXCLUDED_ALIAS_DESCRIPTION', 'UNAVAILABLE_ALIAS_DESCRIPTION', 'INCOMPATIBLE_ALIAS_DESCRIPTION', 'test/gamma', 'test/missing']) {
    assert.ok(!catalog.includes(omitted), `ineligible alias leaked into catalog: ${omitted}`);
  }
  return catalog;
}

test('root gets only eligible aliases, canonical IDs, effective thinking, default, and verbatim descriptions', async () => {
  await withSession({}, async ({ prompt, tools }) => {
    const event = prompt({ appendSystemPrompt: 'KEEP_ADDENDUM' });
    const catalog = checkCatalog(event);
    assert.equal(Object.keys(event.systemPromptOptions.sections).length, 2);
    const rendered = buildSystemPrompt(event.systemPromptOptions);
    assert.ok(rendered.includes(`<subagent_models>\n${catalog}\n</subagent_models>`));
    assert.ok(rendered.includes('KEEP_ADDENDUM'));
    assert.equal(rendered.split(userDescription).length - 1, 1);
    const schema = tools.get('spawn_agent').parameters;
    assert.ok(schema.properties.model && schema.properties.thinking, 'preserve separate model and thinking fields');
    assert.match(schema.properties.model.description, /alias.*provider\/model ID/);
    assert.match(schema.properties.thinking.description, /override/i);
    assert.deepEqual(schema.properties.thinking.enum, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(!schema.required.includes('model') && !schema.required.includes('thinking'));
    assert.ok(!JSON.stringify(schema).includes(userDescription), 'catalog must not be duplicated in tool descriptions');
  });
});

test('successive turns replace one stable section and remove only our stale section when unavailable', async () => {
  await withSession({}, async ({ prompt, handlers, ctx, setActive }) => {
    const event = prompt({ customPrompt: 'CUSTOM_SYSTEM_PROMPT' });
    const first = checkCatalog(event);
    handlers.get('before_agent_start')(event, ctx);
    assert.equal(event.systemPromptOptions.sections.subagent_models, first);
    assert.equal(buildSystemPrompt(event.systemPromptOptions).split(userDescription).length - 1, 1);
    assert.ok(buildSystemPrompt(event.systemPromptOptions).startsWith('CUSTOM_SYSTEM_PROMPT'));
    ctx.scopedModels = [{ model: model('beta'), thinkingLevel: 'low' }];
    handlers.get('before_agent_start')(event, ctx);
    assert.ok(!event.systemPromptOptions.sections.subagent_models.includes(userDescription));
    assert.match(event.systemPromptOptions.sections.subagent_models, /unavailable.*configuration error/is);
    assert.match(event.systemPromptOptions.sections.subagent_models, /defaultModel.*selected[\s\S]*outside.*scope/);
    ctx.scopedModels = [{ model: model('alpha') }, { model: model('beta'), thinkingLevel: 'low' }];
    handlers.get('before_agent_start')(event, ctx);
    checkCatalog(event);
    setActive([]);
    handlers.get('before_agent_start')(event, ctx);
    assert.deepEqual(event.systemPromptOptions.sections, { other_extension: 'KEEP_ME' });
    assert.equal(event.systemPromptOptions.customPrompt, 'CUSTOM_SYSTEM_PROMPT');
  });
});

test('availability and current parent thinking are read afresh on each turn', async () => {
  await withSession({ settings: { maxDepth: 2, modelAliases: { inherited: { model: 'test/alpha' } } } }, async ({ ctx, prompt, handlers }) => {
    ctx.scopedModels = [];
    const event = prompt();
    assert.match(event.systemPromptOptions.sections.subagent_models, /thinking=medium/);
    ctx.thinkingLevel = 'high';
    handlers.get('before_agent_start')(event, ctx);
    assert.match(event.systemPromptOptions.sections.subagent_models, /thinking=high/);
    ctx.modelRegistry.getAvailable = () => [];
    handlers.get('before_agent_start')(event, ctx);
    assert.ok(!/inherited.*test\/alpha/.test(event.systemPromptOptions.sections.subagent_models));
  });
});

test('codemode-only keeps the section even when the native spawn declaration is hidden', async () => {
  await withSession({ activeTools: ['codemode', 'spawn_agent'] }, async ({ prompt }) => {
    const event = prompt({ selectedTools: ['codemode', 'spawn_agent'], hiddenTools: ['spawn_agent'], toolSnippets: { codemode: 'Run code', spawn_agent: 'Spawn child' } });
    checkCatalog(event);
    const rendered = buildSystemPrompt(event.systemPromptOptions);
    assert.ok(rendered.includes('<subagent_models>'));
    assert.ok(!rendered.includes('- spawn_agent: Spawn child'));
  });
});

test('code-exposed and deferred spawn tools are reachable through an active orchestrator', async () => {
  for (const exposure of ['codemode', 'deferred']) {
    await withSession({ activeTools: ['codemode'], allTools: [{ name: 'spawn_agent', exposure }, { name: 'codemode', reachesTools: () => ['spawn_agent'] }] }, async ({ prompt, handlers, ctx, setActive, setAll }) => {
      const event = prompt({ selectedTools: ['codemode'] });
      checkCatalog(event);
      setActive([]);
      handlers.get('before_agent_start')(event, ctx);
      assert.deepEqual(event.systemPromptOptions.sections, { other_extension: 'KEEP_ME' });
      setActive(['codemode']);
      setAll([{ name: 'spawn_agent', exposure: 'hidden' }, { name: 'codemode', reachesTools: () => ['spawn_agent'] }]);
      handlers.get('before_agent_start')(event, ctx);
      assert.deepEqual(event.systemPromptOptions.sections, { other_extension: 'KEEP_ME' });
    });
  }
});

test('sessions without spawn permission or aliases never receive a section', async () => {
  for (const options of [{ activeTools: [] }, { settings: { maxDepth: 2 } }]) {
    await withSession(options, async ({ prompt }) => {
      assert.deepEqual(prompt({ sections: { other_extension: 'KEEP_ME', subagent_models: 'STALE' } }).systemPromptOptions.sections, { other_extension: 'KEEP_ME' });
    });
  }
});

test('delegating children receive inherited aliases but boundary-depth children and disabled roots do not', async () => {
  const inheritedSettings = { modelAliases: settings().modelAliases, defaultModel: 'selected', defaultThinking: null };
  await withSession({ depth: 1, settings: { maxDepth: 2 }, inheritedSettings }, async ({ prompt }) => { checkCatalog(prompt()); });
  for (const options of [
    { depth: 2, settings: settings() }, { depth: 3, settings: settings() }, { depth: 0, settings: { ...settings(), maxDepth: 0 } },
  ]) {
    await withSession(options, async ({ prompt }) => {
      assert.deepEqual(prompt({ sections: { other_extension: 'KEEP_ME', subagent_models: 'STALE' } }).systemPromptOptions.sections, { other_extension: 'KEEP_ME' });
    });
  }
});

test('a disabled configured default is a startup error, not a silently unusable catalog', async () => {
  await withSession({ settings: { ...settings(), defaultModel: 'disabled' }, startupError: /defaultModel.*disabled.*disabled/ }, async ({ prompt, tools, ctx, notifications }) => {
    const catalog = prompt().systemPromptOptions.sections.subagent_models;
    assert.match(catalog, /unavailable.*configuration error/is);
    assert.ok(!catalog.includes('DISABLED_ALIAS_DESCRIPTION') && !catalog.includes('disabled →'));
    const spawn = tools.get('spawn_agent');
    for (const params of [{ task: 'disabled explicit', model: 'disabled' }, { task: 'disabled default' }]) {
      const result = await spawn.execute('disabled-test', params, undefined, undefined, ctx);
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, notifications[0]);
    }
  });
});

test('startup rejects model configuration that cannot resolve in the current scope, registry or thinking pin', async () => {
  for (const [configuration, expected, sessionOptions] of [
    [{ maxDepth: 2, modelAliases: { selected: { model: 'test/gamma' } }, defaultModel: 'selected' }, /defaultModel.*selected[\s\S]*outside.*scope/],
    [{ maxDepth: 2, modelAliases: { alpha: { model: 'test/beta' } } }, /alias "alpha" conflicts with a bare model ID/],
    [{ maxDepth: 2, aliasesOnly: true, modelAliases: { worker: { model: 'test/gamma' } } }, /modelAliases.worker.*test\/gamma.*outside.*scope/],
    [{ maxDepth: 2, aliasesOnly: true, modelAliases: { worker: { model: 'test/beta', thinking: 'high' } } }, /modelAliases.worker.*thinking.*pin/],
    [{ maxDepth: 2, aliasesOnly: true, modelAliases: { worker: { model: 'test/missing' } } }, /modelAliases.worker.*test\/missing.*not available.*registry/, { scopedModels: [] }],
  ]) {
    await withSession({ ...sessionOptions, settings: configuration, startupError: expected }, async ({ tools, ctx, notifications, prompt }) => {
      const result = await tools.get('spawn_agent').execute('invalid-model-config', { task: 'must not spawn', model: 'worker' }, undefined, undefined, ctx);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, expected);
      assert.match(result.content[0].text, /fix.*reload/is);
      assert.equal(result.content[0].text, notifications[0]);
      assert.ok(prompt().systemPromptOptions.sections.subagent_models.includes(notifications[0]));
    });
  }
});

test('dynamic strict scope, registry and alias collisions report a safe section and recover without reload', async () => {
  await withSession({ settings: strictSettings() }, async ({ ctx, prompt, handlers, tools, notifications }) => {
    const event = prompt({ customPrompt: 'PRESERVE_CUSTOM' });
    checkCatalog(event);
    const initialScope = ctx.scopedModels;
    const initialRegistry = ctx.modelRegistry.getAvailable;
    for (const [change, expected] of [
      [() => { ctx.scopedModels = [{ model: model('beta'), thinkingLevel: 'low' }]; }, /modelAliases.selected.*outside.*scope/],
      [() => { ctx.modelRegistry.getAvailable = () => []; }, /not available.*model registry/],
      [() => { ctx.modelRegistry.getAvailable = () => [...initialRegistry(), model('selected')]; }, /alias "selected" conflicts with a bare model ID/],
    ]) {
      change();
      assert.doesNotThrow(() => handlers.get('before_agent_start')(event, ctx));
      const section = event.systemPromptOptions.sections.subagent_models;
      assert.match(section, /unavailable.*configuration error/is);
      assert.match(section, expected);
      assert.match(section, /fix.*reload/is);
      assert.equal(event.systemPrompt, 'BASE_SYSTEM_PROMPT');
      assert.equal(event.systemPromptOptions.customPrompt, 'PRESERVE_CUSTOM');
      assert.equal(event.systemPromptOptions.sections.other_extension, 'KEEP_ME');
      ctx.scopedModels = initialScope;
      ctx.modelRegistry.getAvailable = initialRegistry;
      handlers.get('before_agent_start')(event, ctx);
      checkCatalog(event);
      assert.doesNotMatch(event.systemPromptOptions.sections.subagent_models, /configuration error/);
    }
    assert.deepEqual(notifications, [], 'dynamic availability changes must not produce repeated chat/UI reminders');
    await assert.rejects(tools.get('spawn_agent').execute('still-alive', { task: 'reject raw ID', model: 'test/alpha' }, undefined, undefined, ctx), error => {
      assert.match(error.message, /aliasesOnly/);
      assert.match(error.message, /Available aliases: inherited, selected/);
      return true;
    });
  });
});

test('strict prompts require enabled aliases and never imply a parent fallback when no default is configured', async () => {
  for (const configuredDefault of [true, false]) {
    const configuration = strictSettings();
    if (!configuredDefault) delete configuration.defaultModel;
    await withSession({ settings: configuration }, async ({ prompt, tools, ctx }) => {
      const section = prompt().systemPromptOptions.sections.subagent_models;
      assert.match(section, /Only enabled aliases are allowed; raw model IDs and parent-model fallback are disabled\./);
      assert.match(section, configuredDefault ? /Default: selected/ : /Default: \(none; explicit alias required\)/);
      assert.doesNotMatch(section, /Default: parent/);
      assert.match(section, /selected → test\/alpha/);
      assert.match(section, /inherited → test\/beta/);
      assert.doesNotMatch(section, /disabled →|DISABLED_ALIAS_DESCRIPTION/);
      const spawn = tools.get('spawn_agent');
      assert.match(spawn.parameters.properties.model.description, /aliasesOnly.*enabled alias/);
      assert.match(spawn.description, /aliasesOnly.*enabled alias/);
      for (const requested of ['test/alpha', 'alpha', 'unknown', 'disabled', ...(configuredDefault ? [] : [undefined])]) {
        await assert.rejects(spawn.execute('strict-selector', { task: 'reject before spawning', model: requested }, undefined, undefined, ctx), error => {
          assert.match(error.message, requested === 'disabled' ? /disabled/ : /aliasesOnly/);
          assert.match(error.message, /Available aliases: inherited, selected/);
          if (requested === undefined) assert.match(error.message, /explicit alias.*parent-model fallback is disabled/);
          return true;
        });
      }
    });
  }
});

test('leaf and tool-disabled sessions skip inaccessible delegation model validation', async () => {
  const configuration = { maxDepth: 2, aliasesOnly: true, defaultModel: 'worker', modelAliases: { worker: { model: 'test/gamma' } } };
  for (const options of [
    { depth: 2 }, { depth: 3 }, { settings: { ...configuration, maxDepth: 0 } },
    { activeTools: [] },
    { activeTools: ['codemode'], allTools: [{ name: 'spawn_agent', exposure: 'hidden' }, { name: 'codemode', reachesTools: () => ['spawn_agent'] }] },
  ]) {
    await withSession({ settings: configuration, ...options }, async ({ prompt, tools, ctx }) => {
      assert.deepEqual(prompt().systemPromptOptions.sections, { other_extension: 'KEEP_ME' });
      const result = await tools.get('check_subagents').execute('leaf-runtime', { wait: false }, undefined, undefined, ctx);
      assert.notEqual(result.isError, true, 'inaccessible delegation models must not destroy the leaf runtime');
      assert.match(result.content[0].text, /No subagents/);
    });
  }
});

test('children use the inherited aliasesOnly snapshot instead of a conflicting local setting', async () => {
  for (const strict of [true, false]) {
    await withSession({
      depth: 1,
      settings: { maxDepth: 2, aliasesOnly: !strict, modelAliases: { local: { model: 'test/gamma' } } },
      inheritedSettings: { aliasesOnly: strict, modelAliases: strictSettings().modelAliases, defaultModel: null, defaultThinking: null },
    }, async ({ prompt, tools, ctx }) => {
      const section = prompt().systemPromptOptions.sections.subagent_models;
      assert.match(section, /selected → test\/alpha/);
      assert.doesNotMatch(section, /local →/);
      if (strict) {
        assert.match(section, /Only enabled aliases/);
        assert.match(section, /explicit alias required/);
        await assert.rejects(tools.get('spawn_agent').execute('inherited-strict', { task: 'no fallback' }, undefined, undefined, ctx), /aliasesOnly.*explicit alias/);
      } else {
        assert.match(section, /Default: parent \(test\/alpha\)/);
        assert.doesNotMatch(section, /Only enabled aliases|explicit alias required/);
      }
    });
  }
});

test('older ExtensionAPI mocks without getAllTools or modelRegistry remain supported', async () => {
  await withSession({ registry: false }, async ({ prompt }) => { checkCatalog(prompt()); });
});

(async () => {
  try {
    const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: {
      '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
      '@earendil-works/pi-tui': path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
      typebox: require.resolve('typebox', { paths: [pi] }),
    } });
    const host = await jiti.import('@earendil-works/pi-coding-agent');
    host.initTheme('dark', false);
    extension = await jiti.import(path.join(__dirname, 'index.ts'), { default: true });
    ({ normalizeBuildSystemPromptOptions, buildSystemPrompt } = await jiti.import(path.join(pi, 'dist/core/system-prompt.js')));
    for (const { name, run } of tests) { await run(); console.log(`ok - ${name}`); }
    assert.equal(forbiddenCalls, 0, 'catalog lifecycle must never perform a model, network, or process operation');
    console.log(`ALL PASS (${tests.length} model prompt tests; ${forbiddenCalls} forbidden calls)`);
  } finally {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
