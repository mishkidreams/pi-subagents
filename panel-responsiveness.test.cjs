// Offline panel responsiveness: real temporary registry/sessions and native Pi components.
// No providers, agents, settings, terminal integration, or live registry access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
let observedDir, syncCalls = 0;
for (const name of ['existsSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'statSync', 'renameSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) {
    if (observedDir && String(file).startsWith(observedDir)) syncCalls++;
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const jiti = createJiti(__filename, { interopDefault: true, fsCache: false, moduleCache: true, alias: {
  '@earendil-works/pi-coding-agent': path.join(pi, 'dist/bundle/index.js'),
  '@earendil-works/pi-tui': path.join(pi, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: require.resolve('typebox', { paths: [pi] }),
} });
const theme = { fg: (_c,t) => String(t), bg: (_c,t) => String(t), bold: t => String(t) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  for (let i=0;i<400;i++) { if (await predicate()) return; await sleep(10); }
  assert.fail(message);
}
const base = { version: 1, parentRunId: 'root', rootRunId: 'root', sessionId: 'session', name: 'finished-child',
  task: 'test', cwd: os.tmpdir(), depth: 1, maxDepth: 2, status: 'completed', model: 'test/model', thinking: 'off',
  startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:01Z' };
(async () => {
  const host = await jiti.import('@earendil-works/pi-coding-agent'); host.initTheme('dark', false);
  const { SubagentPanel } = await jiti.import(path.join(__dirname, 'panel.ts'));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-panel-responsive-'));
  const runs = path.join(sandbox, 'subagents/runs'); fs.mkdirSync(runs, { recursive: true });
  for (let i=0;i<48;i++) fs.writeFileSync(path.join(runs, `run-${i}.json`), JSON.stringify({ ...base, runId: `run-${i}`, parentRunId: i ? 'unrelated' : 'root' }));
  let panel, renders=0;
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() { renders++; }, setFocus() {} };
  try {
    observedDir = sandbox;
    panel = new SubagentPanel(tui, theme, sandbox, 'root');
    assert.equal(syncCalls, 0, 'constructor must never synchronously scan historical agents');
    await panel.ready();
    syncCalls=0;
    assert.equal(panel.open(), true); assert.equal(panel.openReview(), true);
    assert.equal(panel.dismissFinished(), 1);
    assert.equal(syncCalls, 0, 'open and interactive dismissal must use the maintained snapshot and async persistence');
    panel.handleInput('\x1b');
    assert.ok(!panel.render(80).join('\n').includes('finished-child'), 'dismissal hides immediately, before async marker writes');
    await until(async () => (await fsp.readdir(runs)).some(name => name.endsWith('.footerDismissed')), 'dismissal marker must eventually persist');
    assert.equal(panel.openReview(), true);
    assert.ok(panel.render(80).join('\n').includes('finished-child'), 'dismissal retains reviewable history');
    console.log('ok - initialization/open/dismissal never synchronously scan global history; optimistic hiding persists asynchronously');
    const originalList=host.SessionManager.list, originalNow=Date.now;
    let calls=0, now=100000; const resolves=[];
    host.SessionManager.list=()=>{ calls++; return new Promise(resolve=>resolves.push(resolve)); };
    Date.now=()=>now;
    try {
      panel.handleInput('\r');
      for(let i=0;i<5;i++) { panel.renderDetailForOverlay(80); now+=2001; }
      assert.equal(calls, 1, 'one child can have only one unresolved discovery, regardless of timer advances');
      panel.dispose(); const before=renders;
      resolves.forEach(resolve=>resolve([{id:'session',path:path.join(sandbox,'never-open.jsonl')}]));
      await Promise.resolve(); await Promise.resolve();
      assert.equal(renders,before,'discovery completion after disposal must not mutate/render the panel');
    } finally { host.SessionManager.list=originalList; Date.now=originalNow; }
    console.log('ok - session discovery is single-flight and disposed completions are ignored');

    observedDir=undefined;
    const { TranscriptView } = await jiti.import(process.env.TRANSCRIPT_TEST_FILE || path.join(__dirname,'transcript.ts'));
    const header={type:'session',version:3,id:'layout',cwd:sandbox,timestamp:'2026-01-01T00:00:00Z'};
    const file=path.join(sandbox,'layout.jsonl');
    const entries=Array.from({length:1000},(_,i)=>({type:'message',id:`m-${i}`,parentId:i?`m-${i-1}`:null,
      message:{role:'user',content:`MESSAGE_${i}_`+'x'.repeat(500),timestamp:i}}));
    fs.writeFileSync(file,[header,...entries].map(entry=>JSON.stringify(entry)).join('\n')+'\n');
    let nativeCalls=0, turnCalls=0, maximumTurnCalls=0, ticking=true;
    const originalRender=host.UserMessageComponent.prototype.render;
    host.UserMessageComponent.prototype.render=function(...args){nativeCalls++;turnCalls++;return originalRender.apply(this,args);};
    const tick=()=>{maximumTurnCalls=Math.max(maximumTurnCalls,turnCalls);turnCalls=0;if(ticking)setImmediate(tick);};
    setImmediate(tick);
    const view=new TranscriptView(tui,sandbox);
    try {
      await view.update(file); view.render(78); await view.ready?.(); await new Promise(resolve=>setImmediate(resolve));
      maximumTurnCalls=Math.max(maximumTurnCalls,turnCalls);
      assert.ok(maximumTurnCalls<=16,`cold layout must yield between bounded native batches, got ${maximumTurnCalls} native renders in one turn`);
      const lines=view.render(78), before=nativeCalls;
      for(let i=0;i<20;i++) view.render(78);
      assert.equal(nativeCalls,before,'unchanged typing must reuse cleaned layout without revisiting native components');
      assert.ok(lines.some(line=>line.includes('MESSAGE_0_'))&&lines.some(line=>line.includes('MESSAGE_999_')),'preparation keeps first and last history navigable');
    } finally {view.dispose();ticking=false;host.UserMessageComponent.prototype.render=originalRender;}
    console.log('ok - cold history preparation yields; warm layout does zero native work and retains all history');

    const disclosureFile=path.join(sandbox,'disclosure.jsonl');
    const toolCalls=Array.from({length:300},(_,i)=>({type:'toolCall',id:`call-${i}`,name:'custom',arguments:{index:i}}));
    fs.writeFileSync(disclosureFile,[header,{type:'message',id:'many-calls',parentId:null,message:{role:'assistant',content:toolCalls}}].map(entry=>JSON.stringify(entry)).join('\n')+'\n');
    const disclosureView=new TranscriptView(tui,sandbox);
    const oldExpanded=host.ToolExecutionComponent.prototype.setExpanded;
    let expandedCalls=0,expandedTurn=0,maximumExpandedTurn=0,watching=true;
    const expandedStates=new Map();
    const expandedTick=()=>{maximumExpandedTurn=Math.max(maximumExpandedTurn,expandedTurn);expandedTurn=0;if(watching)setImmediate(expandedTick);};
    try {
      await disclosureView.update(disclosureFile);disclosureView.render(78);await disclosureView.ready();
      host.ToolExecutionComponent.prototype.setExpanded=function(...args){expandedCalls++;expandedTurn++;expandedStates.set(this,args[0]);return oldExpanded.apply(this,args);};
      setImmediate(expandedTick);
      disclosureView.toggleTools();
      assert.equal(expandedCalls,0,'input callbacks must schedule, never synchronously expand historical tools');
      await disclosureView.ready();await new Promise(resolve=>setImmediate(resolve));
      maximumExpandedTurn=Math.max(maximumExpandedTurn,expandedTurn);
      assert.equal(expandedCalls,300,'all historical tools eventually receive the disclosure change');
      assert.ok(maximumExpandedTurn<=16,`disclosure changes must yield between native batches, got ${maximumExpandedTurn}`);
      let expectedExpanded=true;
      for (const mode of ['immediate', 'mid-slice', 'changed-history']) {
        expandedStates.clear(); expectedExpanded=!expectedExpanded;
        disclosureView.toggleTools();
        if (mode!=='immediate') await new Promise(resolve=>setImmediate(resolve));
        disclosureView.pause();
        if (mode==='changed-history') fs.appendFileSync(disclosureFile,JSON.stringify({type:'message',id:'later',parentId:'many-calls',message:{role:'user',content:'appended while closed'}})+'\n');
        await disclosureView.update(disclosureFile); await disclosureView.ready();
        assert.equal(expandedStates.size,300,`${mode}: reopening reconciles every tool, not just the interrupted slice`);
        assert.ok([...expandedStates.values()].every(value=>value===expectedExpanded),`${mode}: all tools receive the requested state`);
      }
    } finally {watching=false;disclosureView.dispose();host.ToolExecutionComponent.prototype.setExpanded=oldExpanded;}
    console.log('ok - bulk disclosure is sliced and interrupted disclosure resumes after reopening unchanged or appended history');

    const thinkingFile=path.join(sandbox,'thinking.jsonl');
    const thinkingEntries=Array.from({length:48},(_,i)=>({type:'message',id:`thinking-${i}`,parentId:i?`thinking-${i-1}`:null,
      message:{role:'assistant',content:[{type:'thinking',thinking:`THINKING_${i}`},{type:'text',text:`answer ${i}`}]}}));
    fs.writeFileSync(thinkingFile,[header,...thinkingEntries].map(entry=>JSON.stringify(entry)).join('\n')+'\n');
    const thinkingView=new TranscriptView(tui,sandbox), thinkingStates=new Map();
    const oldThinking=host.AssistantMessageComponent.prototype.setHideThinkingBlock;
    try {
      await thinkingView.update(thinkingFile); thinkingView.render(78); await thinkingView.ready();
      host.AssistantMessageComponent.prototype.setHideThinkingBlock=function(hidden){thinkingStates.set(this,hidden);return oldThinking.call(this,hidden);};
      let hidden=true;
      for (const midSlice of [false,true]) {
        thinkingStates.clear(); hidden=!hidden; thinkingView.toggleThinking();
        if(midSlice) await new Promise(resolve=>setImmediate(resolve));
        thinkingView.pause(); await thinkingView.update(thinkingFile); await thinkingView.ready();
        assert.equal(thinkingStates.size,48,'reopening resumes interrupted thinking disclosure');
        assert.ok([...thinkingStates.values()].every(value=>value===hidden),'all assistants receive requested thinking visibility');
      }
    } finally {thinkingView.dispose();host.AssistantMessageComponent.prototype.setHideThinkingBlock=oldThinking;}
    console.log('ok - immediate and mid-slice thinking disclosure survives close/reopen');

    const giant=path.join(sandbox,'giant.jsonl');
    fs.writeFileSync(giant,[header,
      {type:'message',id:'call',parentId:null,message:{role:'assistant',content:[{type:'toolCall',id:'tool',name:'custom',arguments:{path:'file'}}]}},
      {type:'message',id:'result',parentId:'call',message:{role:'toolResult',toolCallId:'tool',toolName:'custom',content:[{type:'text',text:'BEGIN_PAYLOAD\n'+'x'.repeat(4*1024*1024)+'\nEND_PAYLOAD'}]}}
    ].map(entry=>JSON.stringify(entry)).join('\n')+'\n');
    const nativeTui=await jiti.import('@earendil-works/pi-tui');
    const oldTextRender=nativeTui.Text.prototype.render,oldToolRender=host.ToolExecutionComponent.prototype.render;
    let maximumText=0,toolRenders=0;
    nativeTui.Text.prototype.render=function(...args){maximumText=Math.max(maximumText,this.text?.length??0);return oldTextRender.apply(this,args);};
    host.ToolExecutionComponent.prototype.render=function(...args){toolRenders++;return oldToolRender.apply(this,args);};
    const giantView=new TranscriptView(tui,sandbox);
    try {
      await giantView.update(giant);giantView.render(78);await giantView.ready?.();
      const lines=giantView.render(78);
      assert.equal(toolRenders,0,'one giant result must never reach an uninterruptible native tool renderer');
      assert.ok(maximumText<=4096,`plain text rendering chunks must be bounded, got ${maximumText}`);
      assert.ok(lines.some(line=>line.includes('BEGIN_PAYLOAD'))&&lines.some(line=>line.includes('END_PAYLOAD')),'large payload fallback must preserve every navigable suffix');
    } finally {giantView.dispose();nativeTui.Text.prototype.render=oldTextRender;host.ToolExecutionComponent.prototype.render=oldToolRender;}
    console.log('ok - a multi-megabyte tool result uses bounded plain chunks, not one blocking native render');
  } finally { observedDir=undefined; panel?.dispose(); await sleep(50); fs.rmSync(sandbox, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode=1; });
