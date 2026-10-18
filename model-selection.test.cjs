// Model profiles and real RPC launch/resume with the offline fake Pi; no provider requests.
// Run: node model-selection.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const PI = process.env.PI_ROOT || (process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent')
  : path.resolve(path.dirname(fs.realpathSync(execSync('command -v pi', { encoding: 'utf8' }).trim())), '../..'));
const { createJiti } = require(path.join(PI, 'node_modules/jiti'));
const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: {
  '@earendil-works/pi-coding-agent': path.join(PI, 'dist/bundle/index.js'),
  '@earendil-works/pi-tui': path.join(PI, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: require.resolve('typebox', { paths: [PI] }),
} });
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-models-'));
const agentDir = path.join(sandbox, 'agent');
const project = path.join(sandbox, '.pi');
fs.mkdirSync(agentDir); fs.mkdirSync(project);
const write = (dir, value) => fs.writeFileSync(path.join(dir, 'subagents.json'), JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for offline model fixture'); await sleep(20); }
}
let runtime;
const runs = [];
const keys = ['PI_SUBAGENT_COMMAND', 'FAKE_ARGS_DIR', 'FAKE_MODE', 'FAKE_DELAY_MS', 'FAKE_EXIT', 'FAKE_PROVIDER', 'FAKE_MODEL'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
(async () => {
  try {
    const config = await jiti.import(path.join(__dirname, 'config.ts'));
    const models = await jiti.import(path.join(__dirname, 'model-selection.ts'));
    runtime = await jiti.import(path.join(__dirname, 'spawn-agent.ts'));
    const registry = await jiti.import(path.join(__dirname, 'registry.ts'));
    const options = { agentDir, cwd: sandbox, projectTrusted: false, env: {} };
    const aliases = {
      var2: { model: 'test/b', thinking: 'high', description: 'Literal user text.\nNo inferred pricing.' },
      var1: { model: 'test/a', thinking: 'low', description: 'Вариант один', enabled: true },
      same: { model: 'test/a', thinking: 'max', description: '' },
      pending: { model: 'future/unavailable', description: 'PRESERVED_DISABLED_DESCRIPTION', enabled: false },
    };
    write(agentDir, { modelAliases: aliases, defaultModel: 'var1', defaultThinking: 'medium' });
    let settings = config.loadSettings(options);
    assert.deepEqual(settings.modelAliases, aliases);
    for (const bad of [null, [], 'test/a', { bad: 'test/a' }, { '@bad': { model: 'test/a' } },
      { 'test/a': { model: 'test/a' } }, { bad: {} }, { bad: { model: 'var1' } },
      { bad: { model: 'test/*' } }, { bad: { model: 'test/a', thinking: 'ultra' } },
      { bad: { model: 'test/a', description: 10 } }, { bad: { model: 'test/a', tools: [] } }]) {
      write(agentDir, { modelAliases: bad });
      assert.throws(() => config.loadSettings(options), /modelAliases/);
    }
    for (const enabled of [null, 'false', 'true', 0, 1, {}, []]) {
      write(agentDir, { modelAliases: { bad: { model: 'test/a', enabled } } });
      assert.throws(() => config.loadSettings(options), /enabled must be a boolean/);
    }
    write(agentDir, { modelAliases: { bad: { model: 'not-canonical', enabled: false } } });
    assert.throws(() => config.loadSettings(options), /exact provider\/model/);
    write(agentDir, { modelAliases: { docker: { model: 'ollama/llama3:8b' } } });
    assert.equal(config.loadSettings(options).modelAliases.docker.model, 'ollama/llama3:8b');
    for (const aliasesOnly of [null, 'true', 'false', 0, 1, {}, []]) {
      write(agentDir, { modelAliases: aliases, aliasesOnly });
      assert.throws(() => config.loadSettings(options), /subagents\.json.*aliasesOnly must be a boolean/s);
    }
    write(agentDir, { aliasOnly: true });
    assert.throws(() => config.loadSettings(options), /aliasOnly.*not.*supported.*aliasesOnly/s, 'typo must not silently disable protection');
    for (const modelAliases of [undefined, {}, { pending: aliases.pending }]) {
      write(agentDir, { modelAliases, aliasesOnly: true });
      assert.throws(() => config.loadSettings(options), /aliasesOnly.*at least one enabled alias/s);
    }
    for (const defaultModel of ['test/a', 'a', 'typo']) {
      write(agentDir, { modelAliases: aliases, aliasesOnly: true, defaultModel });
      assert.throws(() => config.loadSettings(options), /defaultModel.*enabled alias.*same, var1, var2/s);
    }
    write(agentDir, { modelAliases: aliases, aliasesOnly: true, defaultModel: 'pending' });
    assert.throws(() => config.loadSettings(options), /defaultModel.*pending.*disabled/s);
    write(agentDir, { modelAliases: aliases, aliasesOnly: true });
    const strictSettings = config.loadSettings(options);
    assert.equal(strictSettings.aliasesOnly, true);
    assert.equal(strictSettings.defaultModel, undefined, 'strict mode may require an explicit alias per call');
    write(project, { aliasesOnly: false, modelAliases: {}, defaultModel: 'openrouter/expensive' });
    const strictInherited = config.loadSettings({ ...options, projectTrusted: true, env: {
      [config.MODEL_CONFIG_ENV]: config.serializeModelSettings(strictSettings),
      PI_SUBAGENT_DEFAULT_MODEL: 'openrouter/expensive',
    } });
    assert.equal(strictInherited.aliasesOnly, true, 'child cwd cannot relax inherited protection');
    assert.deepEqual(strictInherited.modelAliases, aliases);
    assert.equal(strictInherited.defaultModel, undefined, 'env cannot introduce parent/raw fallback');
    assert.equal(JSON.parse(config.serializeModelSettings(strictInherited)).aliasesOnly, true, 'grandchild snapshot retains protection');
    const malformedSnapshot = { ...JSON.parse(config.serializeModelSettings(strictSettings)), aliasesOnly: 'true' };
    assert.throws(() => config.loadSettings({ ...options, env: { [config.MODEL_CONFIG_ENV]: JSON.stringify(malformedSnapshot) } }), /PI_SUBAGENT_MODEL_CONFIG.*aliasesOnly must be a boolean/s);
    write(agentDir, { modelAliases: aliases, defaultModel: 'var1', defaultThinking: 'medium' });
    write(project, { modelAliases: { project: { model: 'test/b' } }, defaultModel: 'project' });
    assert.deepEqual(config.loadSettings(options).modelAliases, aliases, 'untrusted settings ignored');
    assert.deepEqual(Object.keys(config.loadSettings({ ...options, projectTrusted: true }).modelAliases), ['project']);
    write(project, { modelAliases: {} });
    assert.deepEqual(config.loadSettings({ ...options, projectTrusted: true }).modelAliases, {}, 'project replaces map');
    const frozen = config.serializeModelSettings(settings);
    write(project, { modelAliases: 'invalid but ignored in inherited model settings', defaultThinking: 'bad', defaultModel: 'other', maxConcurrency: 2 });
    let inherited = config.loadSettings({ ...options, projectTrusted: true, env: {
      [config.MODEL_CONFIG_ENV]: frozen, PI_SUBAGENT_DEFAULT_MODEL: 'other', PI_SUBAGENT_DEFAULT_THINKING: 'bad',
    } });
    assert.deepEqual(inherited.modelAliases, aliases);
    assert.equal(inherited.defaultModel, 'var1'); assert.equal(inherited.defaultThinking, 'medium');
    assert.equal(inherited.maxConcurrency, 2, 'non-model settings still load normally');
    inherited = config.loadSettings({ ...options, projectTrusted: true, env: { [config.MODEL_CONFIG_ENV]: config.serializeModelSettings(inherited) } });
    assert.deepEqual(inherited.modelAliases, aliases, 'grandchild keeps effective model configuration');
    const noModels = config.serializeModelSettings(config.DEFAULT_SETTINGS);
    inherited = config.loadSettings({ ...options, projectTrusted: true, env: { [config.MODEL_CONFIG_ENV]: noModels } });
    assert.equal(inherited.modelAliases, undefined, 'absence is frozen, not inherited from child cwd');
    assert.equal(inherited.defaultModel, undefined); assert.equal(inherited.defaultThinking, undefined);
    for (const bad of ['', '{}', 'null', '[]', '{']) {
      assert.throws(() => config.loadSettings({ ...options, env: { [config.MODEL_CONFIG_ENV]: bad } }), /PI_SUBAGENT_MODEL_CONFIG/);
    }
    console.log('ok - profile validation, trusted map replacement, frozen defaults and recursive inheritance');

    const catalog = [{ provider: 'test', id: 'a' }, { provider: 'test', id: 'b' }];
    const context = { settings, parentModel: 'test/b', parentThinking: 'off', scopedModels: [], availableModels: catalog };
    const select = (model, thinking, override = {}) => models.resolveModelSelection(model, thinking, { ...context, ...override });
    assert.deepEqual(select(), { model: 'test/a', thinking: 'low' });
    assert.deepEqual(select('var1', 'high'), { model: 'test/a', thinking: 'high' });
    assert.deepEqual(select('same'), { model: 'test/a', thinking: 'max' }, 'omitted enabled remains on');
    assert.throws(() => select('pending'), /Alias "pending".*disabled.*Available aliases: same, var1, var2/s);
    const disabled = { ...settings, modelAliases: { ...aliases, var2: { ...aliases.var2, enabled: false } } };
    assert.throws(() => select('var2', 'high', { settings: disabled }), /disabled/);
    assert.throws(() => select(undefined, undefined, { settings: { ...disabled, defaultModel: 'var2' } }), /disabled/, 'disabled default never falls back');
    assert.deepEqual(select('test/b', undefined, { settings: disabled }), { model: 'test/b', thinking: 'medium' }, 'enabled disables the alias, not the underlying canonical model');
    assert.deepEqual(select('same', undefined, { settings: { ...disabled, modelAliases: { ...disabled.modelAliases, var1: { ...aliases.var1, enabled: false } } } }), { model: 'test/a', thinking: 'max' }, 'other aliases for the same model remain usable');
    assert.deepEqual(select('test/b'), { model: 'test/b', thinking: 'medium' });
    assert.deepEqual(select('B'), { model: 'test/b', thinking: 'medium' });
    const routed = { provider: 'openrouter', id: 'anthropic/claude-sonnet-4' };
    assert.deepEqual(select(routed.id, undefined, { availableModels: [routed] }), { model: 'openrouter/anthropic/claude-sonnet-4', thinking: 'medium' });
    assert.deepEqual(select(routed.id, undefined, { availableModels: [routed], scopedModels: [routed] }), { model: 'openrouter/anthropic/claude-sonnet-4', thinking: 'medium' });
    const literalAlias = { ...settings, modelAliases: { literal: { model: routed.id } } };
    assert.throws(() => select('literal', undefined, { settings: literalAlias, availableModels: [routed] }), /not available/);
    assert.throws(() => select('literal', undefined, { settings: literalAlias, availableModels: [routed], scopedModels: [routed] }), /outside/);
    const misleading = { ...context, settings: { ...settings, modelAliases: { a: { model: 'test/b' } } } };
    assert.deepEqual(models.resolveSavedModelSelection('a', 'low', misleading), { model: 'test/a', thinking: 'low' }, 'legacy bare saved IDs are never aliases');
    assert.deepEqual(models.resolveSavedModelSelection('test/a', 'low', misleading), { model: 'test/a', thinking: 'low' });
    assert.throws(() => models.resolveSavedModelSelection('test/a', 'low', { ...context, availableModels: [{ provider: 'gateway', id: 'test/a' }] }), /not available/);
    assert.deepEqual(select(undefined, undefined, { settings: { ...settings, defaultModel: undefined } }), { model: 'test/b', thinking: 'medium' });
    assert.deepEqual(select('test/a', undefined, { settings: { ...settings, defaultThinking: undefined } }), { model: 'test/a', thinking: 'off' });
    assert.throws(() => select('unknown'), /unknown.*not available.*Available aliases/s);
    assert.throws(() => select('test/a', undefined, { availableModels: [] }), /not available/);
    assert.throws(() => select('a', undefined, { availableModels: [...catalog, { provider: 'other', id: 'a' }] }), /ambiguous/);
    assert.throws(() => select('var1', undefined, { scopedModels: [catalog[1]] }), /Alias "var1" resolves to test\/a.*outside.*Available aliases: var2/s);
    assert.throws(() => select(undefined, undefined, { scopedModels: [catalog[1]] }), /Alias "var1"/);
    assert.deepEqual(select('var2', undefined, { scopedModels: [catalog[1]] }), { model: 'test/b', thinking: 'high' });
    const pin = [{ ...catalog[0], thinkingLevel: 'high' }];
    assert.throws(() => select('var1', undefined, { scopedModels: pin }), /pin/);
    assert.deepEqual(select('var1', 'high', { scopedModels: pin }), { model: 'test/a', thinking: 'high' });
    assert.deepEqual(select('test/a', undefined, { scopedModels: pin }), { model: 'test/a', thinking: 'high' });
    const collision = { ...settings, modelAliases: { A: { model: 'test/b' } } };
    assert.throws(() => select('A', undefined, { settings: collision }), /conflicts with a bare model ID/);
    assert.throws(() => models.formatModelCatalog({ ...context, settings: collision }), /conflicts/);
    const dormantCollision = { ...settings, modelAliases: { A: { model: 'test/b', enabled: false } } };
    assert.deepEqual(select('test/b', undefined, { settings: dormantCollision }), { model: 'test/b', thinking: 'medium' }, 'disabled alias names cannot break unrelated model selection');
    assert.throws(() => select('A', undefined, { settings: dormantCollision }), /disabled/);
    assert.equal(models.formatModelCatalog({ ...context, settings: config.DEFAULT_SETTINGS }), '');
    const section = models.formatModelCatalog(context);
    assert.equal(section, models.formatModelCatalog({ ...context, availableModels: [...catalog].reverse() }), 'stable ordering');
    assert.ok(section.includes(aliases.var2.description), 'description preserved verbatim');
    assert.ok(!section.includes(aliases.pending.description) && !section.includes('pending →') && !section.includes('future/unavailable'), 'disabled alias is fully hidden');
    const disabledDefault = models.formatModelCatalog({ ...context, settings: { ...disabled, defaultModel: 'var2' } });
    assert.ok(disabledDefault.includes('Default: var2 (disabled).') && !disabledDefault.includes('var2 →'));
    const allDisabled = { ...settings, modelAliases: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, { ...value, enabled: false }])) };
    const noAliases = models.formatModelCatalog({ ...context, settings: allDisabled });
    assert.ok(noAliases.includes('No available aliases') && !noAliases.includes(' → '));
    assert.ok(section.includes('Default: var1.') && section.includes('thinking=low') && section.includes('thinking=max'));
    assert.ok(!/prefer|least expensive|cheapest/i.test(section), 'no invented policy');
    const filtered = models.formatModelCatalog({ ...context, scopedModels: [catalog[1]] });
    assert.ok(filtered.includes('var1 (unavailable)') && filtered.includes('var2 → test/b') && !filtered.includes('var1 →'));
    const empty = models.formatModelCatalog({ ...context, availableModels: [] });
    assert.ok(empty.includes('No available aliases') && !empty.includes(' → '));
    console.log('ok - selection precedence, same-model profiles, scope/registry intersection, pins, collisions and stable factual catalog');

    const strict = { ...settings, aliasesOnly: true };
    const strictContext = { ...context, settings: strict };
    const strictSelect = (model, thinking, override = {}) => models.resolveModelSelection(model, thinking, { ...strictContext, ...override });
    assert.deepEqual(strictSelect(), { model: 'test/a', thinking: 'low' });
    assert.deepEqual(strictSelect('var2', 'max'), { model: 'test/b', thinking: 'max' });
    for (const model of ['', '   ']) {
      assert.throws(() => strictSelect(model), /model must be a non-empty.*Available aliases: same, var1, var2/s, 'blank model is not an omitted argument');
    }
    for (const model of ['test/a', 'a', 'B', 'openrouter/expensive', 'typo']) {
      assert.throws(() => strictSelect(model), /aliasesOnly.*not a configured alias.*Available aliases: same, var1, var2/s);
    }
    assert.throws(() => strictSelect('pending'), /disabled.*Available aliases: same, var1, var2/s);
    const explicitOnly = { ...strict, defaultModel: undefined };
    assert.throws(() => strictSelect(undefined, undefined, { settings: explicitOnly }), /aliasesOnly.*explicit alias.*Available aliases: same, var1, var2/s);
    assert.deepEqual(strictSelect('var1', undefined, { settings: explicitOnly }), { model: 'test/a', thinking: 'low' });
    assert.throws(() => strictSelect(undefined, undefined, { settings: { ...strict, defaultModel: 'test/a' } }), /aliasesOnly.*not a configured alias/s);
    const strictPrompt = models.formatModelCatalog({ ...context, settings: explicitOnly });
    assert.ok(/explicit alias required/.test(strictPrompt) && /Only enabled aliases/.test(strictPrompt));
    assert.ok(!strictPrompt.includes('parent (test/b)'), 'strict prompt never advertises a parent fallback');
    assert.doesNotThrow(() => models.validateModelConfiguration(strictContext));
    assert.doesNotThrow(() => models.validateModelConfiguration({ ...strictContext, settings: explicitOnly }));
    assert.throws(() => models.validateModelConfiguration({ ...strictContext, availableModels: [catalog[1]] }), /var1.*test\/a.*not available/s);
    assert.throws(() => models.validateModelConfiguration({ ...strictContext, scopedModels: [catalog[1]] }), /var1.*test\/a.*outside/s);
    assert.throws(() => models.validateModelConfiguration({ ...strictContext, scopedModels: pin }), /pin/);
    assert.throws(() => models.validateModelConfiguration({ ...context, settings: collision }), /conflicts/);
    assert.throws(() => models.validateModelConfiguration({ ...context, settings: { ...disabled, defaultModel: 'var2' } }), /defaultModel.*disabled/s);
    assert.deepEqual(models.resolveSavedModelSelection('test/a', 'high', strictContext), { model: 'test/a', thinking: 'high' });
    const onlyB = { ...strict, defaultModel: 'var2', modelAliases: { var2: aliases.var2 } };
    assert.throws(() => models.resolveSavedModelSelection('test/a', 'low', { ...strictContext, settings: onlyB }), /Cannot resume.*test\/a.*enabled alias.*var2/s);
    assert.throws(() => models.resolveSavedModelSelection('a', 'low', strictContext), /Cannot resume.*enabled alias/s, 'strict resume never reinterprets legacy bare IDs');
    const disabledA = { ...strict, defaultModel: 'var2', modelAliases: { var1: { ...aliases.var1, enabled: false }, var2: aliases.var2 } };
    assert.throws(() => models.resolveSavedModelSelection('test/a', 'low', { ...strictContext, settings: disabledA }), /Cannot resume.*enabled alias/s);
    assert.deepEqual(models.resolveSavedModelSelection('test/a', 'low', { ...strictContext, settings: { ...strict, modelAliases: { renamed: aliases.var1 } } }), { model: 'test/a', thinking: 'low' }, 'rename allowed without retargeting saved identity');
    console.log('ok - aliasesOnly forbids raw IDs and parent fallback, validates startup and saved target membership with actionable choices');

    process.env.PI_SUBAGENT_COMMAND = path.join(__dirname, 'fake-pi.cjs');
    process.env.FAKE_ARGS_DIR = path.join(sandbox, 'args');
    process.env.FAKE_PROVIDER = 'test'; process.env.FAKE_MODEL = 'a';
    delete process.env.FAKE_MODE; delete process.env.FAKE_DELAY_MS; delete process.env.FAKE_EXIT;
    const spawnContext = {
      ...context, agentDir, parentRunId: 'parent', rootRunId: 'parent', currentDepth: 0,
      parentTools: ['read', 'pwsh', 'codemode', 'spawn_agent'], parentCwd: sandbox,
      projectTrusted: false, persistAfterSettled: false,
    };
    const record = await runtime.startSubagent({ task: 'offline profile test', model: 'var1' }, spawnContext);
    runs.push(record.runId);
    const row = () => registry.readRecords(agentDir).find(item => item.runId === record.runId);
    await until(() => row()?.status === 'completed' && !row().pid);
    const argsFile = path.join(process.env.FAKE_ARGS_DIR, `${record.runId}.json`);
    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    const arg = name => args[args.indexOf(name) + 1];
    assert.equal(arg('--model'), 'test/a'); assert.equal(arg('--thinking'), 'low');
    assert.equal(arg('--tools'), 'read,pwsh,codemode,spawn_agent', 'profile never replaces tool inheritance');
    assert.equal(row().model, 'test/a'); assert.equal(row().thinking, 'low');
    const env = JSON.parse(fs.readFileSync(path.join(process.env.FAKE_ARGS_DIR, `${record.runId}.env.json`), 'utf8'));
    assert.equal(env[config.MODEL_CONFIG_ENV], frozen, 'real process gets frozen aliases and defaults');
    const descendant = config.loadSettings({ ...options, projectTrusted: true, env });
    assert.deepEqual(descendant.modelAliases, aliases);
    const saved = row();
    saved.sessionFile = path.join(sandbox, 'saved.jsonl');
    fs.writeFileSync(saved.sessionFile, JSON.stringify({ type: 'session', version: 3, id: saved.sessionId, cwd: saved.cwd }) + '\n');
    registry.saveRecord(agentDir, saved);
    const changed = { ...spawnContext, settings: { ...settings, modelAliases: { var1: { model: 'test/b', thinking: 'high', enabled: false } } } };
    await runtime.resumeSubagent(saved, 'resume after alias edit', changed);
    await until(() => row()?.status === 'completed' && !row().pid);
    args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(arg('--model'), 'test/a'); assert.equal(arg('--thinking'), 'low');
    assert.equal(arg('--session'), saved.sessionFile, 'same saved session, no fresh history');
    await assert.rejects(runtime.resumeSubagent(row(), 'identity unavailable', { ...changed, availableModels: [{ provider: 'gateway', id: 'test/a' }] }), /not available/);
    await assert.rejects(runtime.resumeSubagent(row(), 'unavailable', { ...changed, availableModels: [] }), /not available/);
    await assert.rejects(runtime.resumeSubagent(row(), 'conflicting pin', { ...changed, scopedModels: pin }), /pin/);
    const strictSpawnContext = { ...spawnContext, settings: strict };
    const strictRecord = await runtime.startSubagent({ task: 'strict alias', model: 'var1' }, strictSpawnContext);
    runs.push(strictRecord.runId);
    await until(() => registry.readRecords(agentDir).some(item => item.runId === strictRecord.runId && item.status === 'completed' && !item.pid));
    const strictEnv = JSON.parse(fs.readFileSync(path.join(process.env.FAKE_ARGS_DIR, `${strictRecord.runId}.env.json`), 'utf8'));
    assert.equal(JSON.parse(strictEnv[config.MODEL_CONFIG_ENV]).aliasesOnly, true, 'real child process inherits flag');
    const count = registry.readRecords(agentDir).length;
    await assert.rejects(runtime.startSubagent({ task: 'raw must not launch', model: 'test/a' }, strictSpawnContext), /aliasesOnly/);
    await assert.rejects(runtime.startSubagent({ task: 'no fallback' }, { ...strictSpawnContext, settings: explicitOnly }), /explicit alias/);
    await assert.rejects(runtime.resumeSubagent(row(), 'removed saved model', { ...strictSpawnContext, settings: onlyB }), /Cannot resume.*enabled alias/s);
    await assert.rejects(runtime.startSubagent({ task: 'disabled', model: 'pending' }, spawnContext), /disabled/);
    await assert.rejects(runtime.startSubagent({ task: 'disabled default' }, { ...spawnContext, settings: { ...disabled, defaultModel: 'var2' } }), /disabled/);
    await assert.rejects(runtime.startSubagent({ task: 'invalid', model: 'var1' }, { ...spawnContext, availableModels: [] }), /not available/);
    assert.equal(registry.readRecords(agentDir).length, count, 'failed capability validation saves no run');
    console.log('ok - canonical RPC args/record, pwsh tool inheritance, real snapshot propagation and alias-independent resume');
    console.log('All model-selection tests passed');
  } finally {
    if (runtime) await runtime.terminateOwnedSubagents(runs);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
