// Actual extension/UI ingress + offline Node RPC fixture. No provider, clipboard, or OS terminal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const piRoot = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(piRoot, 'node_modules/jiti'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-routing-'));
const fixture = path.join(sandbox, 'rpc-fixture.cjs');
const keys = ['PI_CODING_AGENT_DIR', 'PI_SUBAGENT_COMMAND', 'PI_SUBAGENT_RUN_ID', 'PI_SUBAGENT_ROOT_ID'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const original = { spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync, renameSync: fs.renameSync, readdirSync: fs.readdirSync };
let measureProgressScans = false, progressScans = 0;
fs.readdirSync = (file, ...args) => {
  if (measureProgressScans && path.resolve(String(file)) === path.join(sandbox,'subagents','runs')) progressScans++;
  return original.readdirSync(file,...args);
};
let renameFault;
fs.renameSync = (from,to) => {
  if (renameFault && String(to) === renameFault.target && (!renameFault.onlyStatus || JSON.parse(fs.readFileSync(from,'utf8')).status === renameFault.onlyStatus)) {
    if (renameFault.notify && !renameFault.notified) { renameFault.notified=true;fs.writeFileSync(renameFault.notify,'start'); }
    if (renameFault.onFault && !renameFault.notified) { renameFault.notified=true;renameFault.onFault(); }
    const error = Object.assign(new Error('fixture rename is locked until the event loop can progress'), {code:renameFault.code || 'EPERM',syscall:'rename'});
    throw error;
  }
  return original.renameSync(from,to);
};
const children = new Set();
const keepAliveTimers = new Set();
const nativeSetInterval = global.setInterval, nativeClearInterval = global.clearInterval;
global.setInterval = (callback,ms,...args) => {
  const timer=nativeSetInterval(callback,ms,...args);if(ms===60000)keepAliveTimers.add(timer);return timer;
};
global.clearInterval = timer => {keepAliveTimers.delete(timer);return nativeClearInterval(timer);};
cp.execFileSync = () => { throw new Error('OFFLINE: synchronous OS integration forbidden'); };
cp.execFile = (file, args, options, callback) => {
  assert.match(file, /powershell\.exe$/i);
  process.nextTick(() => callback(null, '123456\n', ''));
};
cp.spawn = (file, args, options) => {
  if (file === 'taskkill') {
    const child = [...children].find(item => item.pid === Number(args[1]));
    assert.ok(child, 'kill only an owned fixture');
    const request = new EventEmitter(); request.stdout = new EventEmitter(); request.stderr = new EventEmitter();
    request.kill = () => {};
    if (child.exitCode !== null || child.signalCode !== null) process.nextTick(() => request.emit('close', 0));
    else { child.once('close', () => request.emit('close', 0)); child.kill(); }
    return request;
  }
  assert.equal(file, process.execPath); assert.equal(args[0], fixture, 'never start real Pi');
  const child = original.spawn(file, args, { ...options, windowsHide: true }); children.add(child); return child;
};
fs.writeFileSync(fixture, `
const fs = require('node:fs');
const args = process.argv.slice(2); const file = args[args.indexOf('--session') + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let last = 'original', seq = 0, busy = false, timer;
const append = message => { const id = 'entry-' + ++seq + '-' + Date.now(); fs.appendFileSync(file, JSON.stringify({type:'message',id,parentId:last,message}) + '\\n'); last = id; };
setInterval(() => {
 if (!busy && fs.existsSync(file+'.autonomous')) {
  fs.unlinkSync(file+'.autonomous');busy=true;emit({type:'agent_start'});fs.writeFileSync(file+'.autonomous.ready','ready');
 }
},5).unref();
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const command = JSON.parse(line);
 if (command.type === 'get_state') return emit({type:'response', id:command.id, success:true, data:{sessionFile:file}});
 if (command.type !== 'prompt') return;
 if (busy && !command.streamingBehavior) return emit({type:'response',id:command.id,success:false,error:'fixture requires streamingBehavior for an active execution'});
 if (command.message === 'reject') return emit({type:'response',id:command.id,success:false,error:'fixture rejection'});
 const expanded = command.message === '/skill:fixture' ? 'EXPANDED_SKILL_INSTRUCTION' : command.message;
 const user = {role:'user',content:expanded,timestamp:Date.now()}; append(user);
 const accepted = () => emit({type:'response',id:command.id,success:true});
 if (command.message.startsWith('SLOW_ACK_DELAY')) {
  const ack = setInterval(() => { if(fs.existsSync(file+'.'+command.message+'.ack')) { clearInterval(ack); accepted(); } },5);
 } else accepted();
 if (!busy) { busy = true; emit({type:'agent_start'}); }
 emit({type:'message_end',message:user}); clearTimeout(timer);
 let progressTimer;
 const finish = () => { clearInterval(progressTimer); const message = {role:'assistant',content:[{type:'text',text:'reply: '+command.message}],timestamp:Date.now()}; append(message); emit({type:'message_end',message}); busy = false; emit({type:'agent_settled'}); };
 if (command.message.startsWith('SLOW_STREAM')) progressTimer=setInterval(()=>emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PUBLIC_STREAM_PROGRESS '}}),20);
 if (command.message.startsWith('SLOW')) {
  const token = file + '.' + command.message; fs.writeFileSync(token+'.ready','ready');
  timer = setInterval(() => { if(fs.existsSync(token+'.release')) { clearInterval(timer); finish(); } },5);
 } else timer = setTimeout(finish,15);
});
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let diagnostics = () => ({});
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for routing fixture: '+JSON.stringify(diagnostics())); await sleep(10); } }
(async () => {
  let panel, registry, runtime;
  const handlers = new Map(), tools = new Map(), deliveries = [], branch = [];
  try {
    process.env.PI_CODING_AGENT_DIR = sandbox; process.env.PI_SUBAGENT_COMMAND = fixture;
    delete process.env.PI_SUBAGENT_RUN_ID; delete process.env.PI_SUBAGENT_ROOT_ID;
    fs.writeFileSync(path.join(sandbox,'subagents.json'),JSON.stringify({maxConcurrency:1}));
    const jiti = createJiti(__filename, { interopDefault:true, fsCache:false, moduleCache:true, alias:{
      '@earendil-works/pi-coding-agent':path.join(piRoot,'dist/bundle/index.js'),
      '@earendil-works/pi-tui':path.join(piRoot,'node_modules/@earendil-works/pi-tui/dist/index.js'),
      typebox:require.resolve('typebox',{paths:[piRoot]}),
    } });
    const host = await jiti.import('@earendil-works/pi-coding-agent'); host.initTheme('dark', false);
    registry = await jiti.import(path.join(__dirname,'registry.ts'));
    runtime = await jiti.import(path.join(__dirname,'spawn-agent.ts'));
    const { default: extension } = await jiti.import(path.join(__dirname,'index.ts'));
    extension({ registerFlag(){},on:(event,handler)=>handlers.set(event,handler),registerMessageRenderer(){},registerCommand(){},registerTool:tool=>tools.set(tool.name,tool),getFlag(){},getActiveTools:()=>[],sendMessage:async(message,options)=>deliveries.push({message,options}),appendEntry:(customType,data)=>branch.push({type:'custom',customType,data}) });
    const tui = { requestRender(){},setFocus(){},showOverlay(){return {hide(){}};},terminal:{columns:80,rows:24} };
    const theme = { fg:(_key,text)=>text,bg:(_key,text)=>text,bold:text=>text };
    let editorFactory;
    const ctx = {sessionManager:{getSessionId:()=> 'parent',getBranch:()=>branch},cwd:sandbox,isProjectTrusted:()=>false,mode:'tui',hasUI:true,model:{provider:'test',id:'model'},scopedModels:[{model:{provider:'test',id:'model'}}],ui:{setWidget:(_key,factory)=>{if(factory)panel=factory(tui,theme);},getEditorComponent:()=>editorFactory,setEditorComponent:value=>{editorFactory=value;},notify(){}}};
    const row = () => registry.readRecords(sandbox).find(item=>item.runId==='child');
    diagnostics = () => ({status:row()?.status,route:row()?.resultRoute,text:row()?.latestText,gate:runtime.gate.running,queued:runtime.gate.waiters.length,sendStatus:panel?.detailStates?.get('child')?.status,ui:panel?.renderDetailForOverlay(80)});
    const file = path.join(sandbox,'child.jsonl');
    fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'child',cwd:sandbox})+'\n'+JSON.stringify({type:'message',id:'original',parentId:null,message:{role:'user',content:'ORIGINAL_DELEGATION',timestamp:1}})+'\n');
    registry.clearRecordPid(sandbox,{version:1,runId:'child',parentRunId:'parent',rootRunId:'parent',sessionId:'child',sessionFile:file,name:'child',task:'ORIGINAL_DELEGATION',cwd:sandbox,depth:1,maxDepth:2,status:'completed',executionId:'initial',resultsDelivered:true,model:'test/model',thinking:'off',tools:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:0},startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    assert.equal(typeof registry.saveRecordAsync,'function','message persistence must have an event-loop-friendly rename retry boundary');
    const target = path.join(sandbox,'subagents','runs','child.json');
    renameFault = {target};
    const releaseRename = setTimeout(()=>{renameFault=undefined;},60);
    try { await registry.saveRecordAsync(sandbox,row()); } finally { clearTimeout(releaseRename);renameFault=undefined; }
    assert.ok(row(),'asynchronous persistence retries after the simulated open handle can close');
    const renameAbort = new AbortController();renameFault = {target};
    const stopRename = setTimeout(()=>renameAbort.abort(),20);
    try { await assert.rejects(registry.saveRecordAsync(sandbox,row(),renameAbort.signal),/aborted/i); } finally {clearTimeout(stopRename);renameFault=undefined;}
    renameFault = {target,code:'EIO'};
    try { await assert.rejects(registry.saveRecordAsync(sandbox,row()),{code:'EIO'}); } finally {renameFault=undefined;}
    console.log('ok - transient rename persistence yields to the event loop, respects abort, and propagates unrelated failures');
    await handlers.get('session_start')({},ctx);
    handlers.get('agent_start')({},ctx);
    const startManual = text => { panel.openReview();panel.handleInput('\r');panel.handleInput(text);panel.handleInput('\r'); };
    const manual = async text => { startManual(text); await until(()=>row()?.latestText==='reply: '+text && row()?.status==='completed'); await until(()=>panel.renderDetailForOverlay(80).some(line=>line.includes('Sent'))); panel.handleInput('\x1b'); };
    const check = () => tools.get('check_subagents').execute('check',{wait:false},undefined,undefined,ctx);
    const send = (message,signal) => tools.get('send_to_subagent').execute('send',{target:'child',message},signal,undefined,ctx);
    const preview = () => handlers.get('tool_result')({content:[{type:'text',text:'ordinary parent tool'}]},ctx);
    await send('SLOW_STREAM_RESPONSIVENESS');
    let blockedMs;
    const released = new Promise(resolve => {
      renameFault = {target,onlyStatus:'thinking',onFault:()=>{
        const start=performance.now();setTimeout(()=>{blockedMs=performance.now()-start;renameFault=undefined;resolve();},25);
      }};
    });
    try {
      await Promise.race([released,sleep(3000).then(()=>{throw new Error('streaming fixture never attempted a registry write');})]);
      assert.ok(blockedMs<150,`streaming persistence must yield to input timers, not block ${blockedMs.toFixed(1)}ms in a synchronous Windows rename retry`);
      console.log('ok - active RPC progress cannot block input while a Windows rename needs an event-loop callback');
      progressScans=0;measureProgressScans=true;
      await sleep(300);measureProgressScans=false;
      assert.equal(progressScans,0,'progress publication must not synchronously rescan every historical child record');
      console.log('ok - progress callbacks update liveness without a synchronous full-registry scan');
      const terminalWriteBlocked = new Promise(resolve => {renameFault={target,onlyStatus:'completed',onFault:resolve};});
      fs.writeFileSync(file+'.SLOW_STREAM_RESPONSIVENESS.release','release');
      await Promise.race([terminalWriteBlocked,sleep(3000).then(()=>{throw new Error('terminal fixture write did not reach its retry boundary');})]);
      await sleep(40);
      assert.equal(keepAliveTimers.size,1,'an unpersisted settlement must keep a print-mode parent alive for the scheduled retry');
      renameFault=undefined;
      await until(()=>row()?.latestText==='reply: SLOW_STREAM_RESPONSIVENESS' && row()?.status==='completed' && keepAliveTimers.size===0);
      console.log('ok - print-mode liveness outlasts failed terminal persistence and releases after successful retry');
    } finally {measureProgressScans=false;renameFault=undefined;fs.writeFileSync(file+'.SLOW_STREAM_RESPONSIVENESS.release','release');}
    await check();
    if (process.argv.includes('--progress-check')) {console.log('ALL PROGRESS TESTS PASS');return;}
    await manual('MANUAL_ONE');
    assert.equal(preview(),undefined,'manual child reply must NOT append to an unrelated parent tool result');
    handlers.get('agent_settled')(); await sleep(50);
    assert.equal(deliveries.length,0,'manual child reply must NOT wake an idle parent');
    const quiet = await check();
    assert.ok(!quiet.content[0].text.includes('reply: MANUAL_ONE'),'status snapshot must not smuggle manual reply as delegated result');
    assert.match(quiet.content[0].text,/new messages/i,'status exposes unread conversation separately');
    console.log('ok - manual UI conversation stays quiet during work and at idle; status remains visible');
    assert.ok(tools.has('read_subagent_messages'),'a normal tool must expose both sides of the conversation');
    const read = params => tools.get('read_subagent_messages').execute('read',{target:'child',...params},undefined,undefined,ctx);
    const history = await read({});
    assert.match(history.content[0].text,/MANUAL_ONE/); assert.match(history.content[0].text,/reply: MANUAL_ONE/);
    const deltaEmpty = await read({}); assert.ok(!deltaEmpty.content[0].text.includes('reply: MANUAL_ONE'),'delta read must not repeat consumed messages');
    console.log('ok - parent reads both sides, with persistent delta cursor instead of latestText only');
    handlers.get('agent_start')({},ctx);
    await send('DELEGATED'); await until(()=>row()?.latestText==='reply: DELEGATED' && row()?.status==='completed');
    await manual('MANUAL_TWO');
    const pending = preview();
    assert.match(pending.content.at(-1).text,/reply: DELEGATED/,'manual follow-up must not overwrite an uncollected delegated result');
    assert.ok(!pending.content.at(-1).text.includes('reply: MANUAL_TWO'));
    const collected = await check();
    assert.match(collected.content[0].text,/reply: DELEGATED/,'previewed result remains explicitly collectable');
    assert.ok(!collected.content[0].text.includes('reply: MANUAL_TWO'));
    const repeated = await check(); assert.ok(!repeated.content[0].text.includes('reply: DELEGATED'),'authoritative result is delivered only once');
    console.log('ok - delegated result survives a later manual turn; preview/check delivery semantics unchanged');
    await send('IDLE_DELEGATED'); await until(()=>row()?.latestText==='reply: IDLE_DELEGATED' && row()?.status==='completed');
    handlers.get('agent_settled')(); await until(()=>deliveries.length===1);
    assert.match(deliveries[0].message.content,/reply: IDLE_DELEGATED/);assert.equal(deliveries[0].options.triggerTurn,true);
    console.log('ok - expected delegated completion still wakes an idle parent exactly once');
    await manual('MANUAL_THREE');
    handlers.get('agent_settled')();await sleep(50);assert.equal(deliveries.length,1);
    const newer = await read({});assert.match(newer.content[0].text,/MANUAL_TWO/);assert.match(newer.content[0].text,/MANUAL_THREE/);
    const replay = await read({fromStart:true});assert.match(replay.content[0].text,/ORIGINAL_DELEGATION/);
    console.log('ok - multiple manual turns are readable on demand, without repeated parent wakeups');
    handlers.get('session_tree')({},ctx);
    const afterRestore = await read({}); assert.ok(!afterRestore.content[0].text.includes('reply: MANUAL_THREE'),'saved read receipts restore the delta cursor after branch/reload reconstruction');
    const firstPage = await read({fromStart:true,limit:1,maxChars:100});
    assert.equal(firstPage.details.hasMore,true);assert.match(firstPage.content[0].text,/Next cursor:/);
    const secondPage = await read({limit:1});assert.ok(!secondPage.content[0].text.includes('ORIGINAL_DELEGATION'),'automatic pages advance past the first message');
    console.log('ok - nested-tool read receipts restore and bounded pages retain their next cursor');
    handlers.get('agent_start')({},ctx);
    const ready = text => fs.existsSync(file+'.'+text+'.ready');
    const release = text => fs.writeFileSync(file+'.'+text+'.release','release');
    await send('SLOW_DELEGATED');await until(()=>ready('SLOW_DELEGATED') && row()?.status==='thinking');
    startManual('SLOW_MANUAL_STEER');await until(()=>ready('SLOW_MANUAL_STEER'));release('SLOW_MANUAL_STEER');
    await until(()=>row()?.latestText==='reply: SLOW_MANUAL_STEER' && row()?.status==='completed');
    assert.equal(row().resultRoute,'parent','manual steering cannot demote an already expected delegation');
    await until(()=>panel.renderDetailForOverlay(80).some(line=>line.includes('Sent')));panel.handleInput('\x1b');
    const steered = await check();assert.match(steered.content[0].text,/reply: SLOW_MANUAL_STEER/);
    console.log('ok - manual steering preserves an in-flight delegated result');
    startManual('SLOW_PRIVATE');await until(()=>ready('SLOW_PRIVATE') && row()?.status==='thinking');
    const start = performance.now();const statusOnly = await tools.get('check_subagents').execute('status',{},undefined,undefined,ctx);
    assert.ok(performance.now()-start<200,'default check does not block on a manual-only conversation');
    assert.ok(!statusOnly.content[0].text.includes('reply: SLOW_PRIVATE'));
    await send('SLOW_PARENT_STEER');await until(()=>ready('SLOW_PARENT_STEER'));release('SLOW_PARENT_STEER');await until(()=>row()?.latestText==='reply: SLOW_PARENT_STEER' && row()?.status==='completed');
    assert.equal(row().resultRoute,'parent','an accepted parent instruction promotes a running manual turn to expected work');
    const promoted = await check();assert.match(promoted.content[0].text,/reply: SLOW_PARENT_STEER/);
    await until(()=>panel.renderDetailForOverlay(80).some(line=>line.includes('Sent')));panel.handleInput('\x1b');
    console.log('ok - parent steering remains collectable; a manual-only running child never causes a wasted default wait');
    const owner = await jiti.import(path.join(__dirname,'owner-control.ts'));
    let receivedRoute;
    const stop = owner.startOwnerMessageConsumer(sandbox,'protocol-owner','parent',async(_target,_text,_signal,route)=>{receivedRoute=route;});
    try { await owner.requestOwnerMessage(sandbox,'protocol-owner',{targetRunId:'child',rootRunId:'parent',text:'quiet recursive message',resultRoute:'manual'},{ownerAlive:()=>true});assert.equal(receivedRoute,'manual'); } finally { await stop(); }
    console.log('ok - recursive owner ingress preserves the manual route');
    await send('BEFORE_QUEUED_PARENT');await until(()=>row()?.latestText==='reply: BEFORE_QUEUED_PARENT' && row()?.status==='completed');
    const releaseSlot = await runtime.gate.acquire(1);
    const queuedSend = send('AFTER_QUEUED_PARENT');queuedSend.catch(()=>{});
    try {
      await until(()=>row()?.status==='queued');
      assert.equal(preview(),undefined,'a live queued parent follow-up supersedes its old result before a new execution ID is assigned');
      assert.ok(!(await check()).content[0].text.includes('reply: BEFORE_QUEUED_PARENT'));
    } finally { releaseSlot(); }
    await queuedSend;await until(()=>row()?.latestText==='reply: AFTER_QUEUED_PARENT' && row()?.status==='completed');await check();
    console.log('ok - a live parent continuation waiting for admission never leaks the superseded result');
    startManual('SLOW_EXPANSION');await until(()=>ready('SLOW_EXPANSION') && row()?.status==='thinking');
    await send('/skill:fixture');await until(()=>row()?.latestText==='reply: /skill:fixture' && row()?.status==='completed');
    assert.equal(row().resultRoute,'parent','accepted parent steering must not depend on the expanded user message matching the original command');
    assert.match((await check()).content[0].text,/reply: \/skill:fixture/);
    await until(()=>panel.renderDetailForOverlay(80).some(line=>line.includes('Sent')));panel.handleInput('\x1b');
    await manual('AFTER_EXPANDED_STEERING');assert.equal(row().resultRoute,'manual','the next manual follow-up must not inherit a stale steering route');
    assert.equal(preview(),undefined);
    console.log('ok - transformed parent steering is collectable and leaves no stale route for the next manual turn');
    await send('BEFORE_AUTONOMOUS');await until(()=>row()?.latestText==='reply: BEFORE_AUTONOMOUS' && row()?.status==='completed');await check();
    renameFault={target,onlyStatus:'completed',notify:file+'.autonomous'};
    let preflightStatus;
    try {
      startManual('MANUAL_DURING_PREFLIGHT');
      await until(()=>fs.existsSync(file+'.autonomous.ready'));
      await until(()=>/Sent|Send failed/.test(panel.detailStates.get('child')?.status || ''));
      preflightStatus=panel.detailStates.get('child').status;
      assert.equal(renameFault.notified,true,'the real message persistence must cross an asynchronous rename retry');
    } finally { renameFault=undefined; }
    assert.match(preflightStatus,/^Sent/,'manual send must recheck execution state after asynchronous preflight, not submit a new prompt to an already active child');
    await until(()=>row()?.latestText==='reply: MANUAL_DURING_PREFLIGHT' && row()?.status==='completed');
    assert.equal(row().resultRoute,'parent','a native delegated execution that starts during preflight cannot be demoted by manual steering');
    assert.match((await check()).content[0].text,/reply: MANUAL_DURING_PREFLIGHT/);panel.handleInput('\x1b');
    console.log('ok - asynchronous preflight revalidates native execution and preserves delegated steering');
    await send('BEFORE_AUTONOMOUS_ADMISSION');await until(()=>row()?.latestText==='reply: BEFORE_AUTONOMOUS_ADMISSION' && row()?.status==='completed');await check();
    fs.rmSync(file+'.autonomous.ready',{force:true});
    const priorExecution=row().executionId;
    const releaseAutonomousSlot=await runtime.gate.acquire(1);
    try {
      startManual('MANUAL_DURING_ADMISSION');await until(()=>row()?.status==='queued' && runtime.gate.waiters.length===1);
      fs.writeFileSync(file+'.autonomous','start');
      await until(()=>row()?.executionId!==priorExecution && row()?.status==='thinking');
      assert.equal(row().resultRoute,'parent','native delegated work starting during admission cannot inherit the queued manual route');
    } finally { releaseAutonomousSlot(); }
    await until(()=>/Sent|Send failed/.test(panel.detailStates.get('child')?.status || ''));
    assert.match(panel.detailStates.get('child').status,/^Sent/,'admission must recheck native execution before choosing prompt versus steering');
    await until(()=>row()?.latestText==='reply: MANUAL_DURING_ADMISSION' && row()?.status==='completed');
    assert.equal(row().resultRoute,'parent');assert.match((await check()).content[0].text,/reply: MANUAL_DURING_ADMISSION/);panel.handleInput('\x1b');
    console.log('ok - native work starting during admission retains its route and receives steering without a leaked slot');
    assert.equal(runtime.gate.running,0,'a steering send releases the no-longer-needed continuation slot');
    startManual('SLOW_ABORT_MANUAL');await until(()=>ready('SLOW_ABORT_MANUAL') && row()?.status==='thinking');
    const callerAbort = new AbortController();
    const cancelledWait = send('SLOW_ACK_DELAY_PARENT',callerAbort.signal).then(()=>({}),error=>({error}));
    await until(()=>ready('SLOW_ACK_DELAY_PARENT'));callerAbort.abort();
    assert.match(String((await cancelledWait).error),/aborted/i,'caller can cancel its wait after the child receives steering');
    assert.equal(runtime.gate.running,1,'accepted work keeps its concurrency slot despite caller cancellation');
    fs.writeFileSync(file+'.SLOW_ACK_DELAY_PARENT.ack','ack');release('SLOW_ACK_DELAY_PARENT');
    await until(()=>row()?.latestText==='reply: SLOW_ACK_DELAY_PARENT' && row()?.status==='completed');
    assert.equal(row().resultRoute,'parent','a late acceptance response must still account for parent steering after caller cancellation');
    assert.match((await check()).content[0].text,/reply: SLOW_ACK_DELAY_PARENT/);
    await until(()=>panel.renderDetailForOverlay(80).some(line=>line.includes('Sent')));panel.handleInput('\x1b');
    console.log('ok - caller cancellation cannot erase a late accepted steering result or release its live slot');
    const followUpAbort = new AbortController();
    const acceptedFollowUp = send('SLOW_ACK_DELAY_FOLLOWUP',followUpAbort.signal);acceptedFollowUp.catch(()=>{});
    await until(()=>ready('SLOW_ACK_DELAY_FOLLOWUP'));followUpAbort.abort();
    fs.writeFileSync(file+'.SLOW_ACK_DELAY_FOLLOWUP.ack','ack');release('SLOW_ACK_DELAY_FOLLOWUP');
    await acceptedFollowUp;await until(()=>row()?.latestText==='reply: SLOW_ACK_DELAY_FOLLOWUP' && row()?.status==='completed');
    assert.match((await check()).content[0].text,/reply: SLOW_ACK_DELAY_FOLLOWUP/);
    console.log('ok - accepted follow-up retains its established successful acknowledgement despite caller abort');
    const grand = {...row(),runId:'quiet-grandchild',parentRunId:'child',depth:2,status:'completed',executionId:'grand-delegation',resultRoute:'parent',resultsDelivered:false,resultsPreviewed:false,latestText:'PRESERVED_GRAND_DELEGATION'};
    registry.saveRecord(sandbox,grand);
    registry.saveRecord(sandbox,{...grand,executionId:'grand-manual',resultRoute:'manual',latestText:'PRIVATE_GRAND_CONVERSATION'});
    const descendant = await check();assert.match(descendant.content[0].text,/PRESERVED_GRAND_DELEGATION/);
    assert.ok(!descendant.content[0].text.includes('PRIVATE_GRAND_CONVERSATION'));
    assert.ok(registry.readParentResults(sandbox).some(item=>item.runId===grand.runId),'ancestor observation must not claim the direct parent delivery');
    assert.ok(!(await check()).content[0].text.includes('PRESERVED_GRAND_DELEGATION'),'ancestor sees the saved descendant execution only once');
    console.log('ok - preserved descendant delegation remains observable once by ancestors without claiming its parent delivery');
    const base = {...row(),runId:'archive-guard',executionId:'delegation-guard',status:'completed',resultRoute:'parent',latestText:'must survive a later cancellation',resultsDelivered:false,resultsPreviewed:false};
    registry.saveRecord(sandbox,base);
    registry.saveRecord(sandbox,{...base,executionId:'manual-guard',resultRoute:'manual',status:'cancelled',latestText:'private conversation'});
    const saved = registry.readParentResults(sandbox).find(item=>item.runId==='archive-guard');
    assert.equal(saved.status,'completed');assert.equal(saved.latestText,'must survive a later cancellation');
    registry.markRecordResultState(sandbox,saved,'resultsDelivered');
    assert.ok(!registry.readParentResults(sandbox).some(item=>item.runId==='archive-guard'));
    assert.ok(!fs.readdirSync(path.join(sandbox,'subagents','results')).some(name=>name.startsWith('archive-guard.')),'delivered outbox entries are retired instead of accumulating full payloads on the hot path');
    console.log('ok - later manual cancellation cannot rewrite a saved delegation; delivered outbox payload is retired');
    {
    const older = {...base,runId:'latest-guard',executionId:'older',latestText:'superseded'};
    const pendingLatest = {...older,executionId:'newer',latestText:'latest pending delegation'};
    registry.saveRecord(sandbox,older);registry.saveRecord(sandbox,pendingLatest);
    let pending = registry.readParentResults(sandbox).filter(item=>item.runId==='latest-guard');
    assert.equal(pending.length,1);assert.equal(pending[0].executionId,'newer');
    registry.markRecordResultState(sandbox,older,'resultsDelivered');
    assert.equal(registry.readParentResults(sandbox).find(item=>item.runId==='latest-guard').executionId,'newer','a delayed acknowledgement must not delete a newer pending payload');
    registry.saveRecord(sandbox,{...pendingLatest,executionId:'third',status:'queued'});
    assert.ok(!registry.readParentResults(sandbox).some(item=>item.runId==='latest-guard'),'new parent work supersedes the older unread delegation before it completes');
    registry.saveRecord(sandbox,{...pendingLatest,executionId:'third',latestText:'third result'});
    pending = registry.readParentResults(sandbox).filter(item=>item.runId==='latest-guard');
    assert.equal(pending.length,1);assert.equal(pending[0].latestText,'third result');
    console.log('ok - latest-only delegation coalescing and delayed acknowledgements preserve the correct pending payload');
    }
    console.log('ALL ROUTING TESTS PASS');
  } finally {
    try { await handlers.get('session_shutdown')?.({}, {mode:'rpc'}); } catch {}
    panel?.dispose();fs.renameSync=original.renameSync;fs.readdirSync=original.readdirSync;
    global.setInterval=nativeSetInterval;global.clearInterval=nativeClearInterval;
    for (const child of children) if (child.exitCode===null && child.signalCode===null) child.kill();
    if (runtime) await runtime.terminateOwnedSubagents(['child']);
    Object.assign(cp,original);
    for (const key of keys) if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
    fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
