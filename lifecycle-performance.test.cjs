// Public lifecycle/owner IPC seams; temporary registry and offline Node fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = require(path.join(pi, 'node_modules/jiti'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-lifecycle-performance-'));
const stub = path.join(sandbox, 'pi.cjs');
const fixture = path.join(sandbox, 'child.cjs');
const locatedCli = path.join(sandbox, 'located/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const originals = { renameSync: fs.renameSync, rename: fsp.rename, spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync };
const previousCommand = process.env.PI_SUBAGENT_COMMAND;
const children = new Set();
let renameFault;
let launches = 0;
let locatorFixture;
function transientRename(from) {
  if (!renameFault || renameFault.remaining === 0) return;
  const name=path.basename(from);
  if (typeof renameFault.name === 'string' ? name !== renameFault.name : !renameFault.name.test(name)) return;
  renameFault.remaining--;
  throw Object.assign(new Error('offline transient rename fixture'), { code: 'EPERM', syscall: 'rename' });
}
fs.renameSync = (from, to) => { transientRename(from); return originals.renameSync(from, to); };
fsp.rename = async (from, to) => { transientRename(from); return originals.rename(from, to); };
cp.execFileSync = file => {
  if (file === 'where.exe' && locatorFixture) {
    locatorFixture.syncCalls++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, locatorFixture.delayMs);
    return locatorFixture.output;
  }
  throw new Error('OFFLINE: synchronous OS probes forbidden');
};
cp.execFile = (file, args, options, callback) => {
  if (file === 'where.exe') {
    const locator = locatorFixture;
    assert.ok(locator, 'locator must be an owned offline fixture');
    assert.deepEqual(args, ['pi']);
    assert.equal(options.timeout, 2000);
    locator.calls++;
    const finish = error => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback(error, error ? '' : locator.output, '');
    };
    const onAbort = () => { locator.aborted = true; finish(Object.assign(new Error('locator aborted'), {name:'AbortError'})); };
    const timer = setTimeout(() => finish(null), locator.delayMs);
    options.signal?.addEventListener('abort', onAbort, {once:true});
    return new EventEmitter();
  }
  assert.match(file, /powershell\.exe$/i);
  process.nextTick(() => callback(null, '123456\n', ''));
};
cp.spawn = (file, args, options) => {
  if (file === 'taskkill') {
    const target = [...children].find(child => child.pid === Number(args[1]));
    assert.ok(target, 'termination must target an owned fixture');
    const result = new EventEmitter();
    result.stdout = new EventEmitter(); result.stderr = new EventEmitter(); result.kill = () => {};
    if (target.exitCode !== null || target.signalCode !== null) process.nextTick(() => result.emit('close', 0));
    else { target.once('close', () => result.emit('close', 0)); target.kill(); }
    return result;
  }
  assert.equal(file, process.execPath);
  assert.ok(args[0] === fixture || args[0] === locatedCli, 'never launch Pi or a real model');
  launches++;
  const child = originals.spawn(file, args, { ...options, windowsHide: true });
  children.add(child);
  return child;
};
fs.writeFileSync(stub, 'exports.CONFIG_DIR_NAME=".pi"; exports.SessionManager={list:async()=>[]};');
fs.writeFileSync(fixture, `
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let keepAlive = false;
readline.createInterface({input: process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') return send({type:'response',id:command.id,success:true,data:{sessionFile:__filename}});
  if (command.type !== 'prompt') return;
  if (command.message === 'keepalive') keepAlive = true;
  send({type:'response',id:command.id,success:true});
  send({type:'agent_start'});
  send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'offline done'}]}});
  send({type:'agent_end'});
  send({type:'agent_settled'});
  if (!keepAlive) setTimeout(()=>process.exit(0),20);
});
`);
fs.mkdirSync(path.dirname(locatedCli), {recursive:true});
fs.copyFileSync(fixture, locatedCli);
process.env.PI_SUBAGENT_COMMAND = fixture;
const jiti = createJiti(__filename, { fsCache: false, moduleCache: true, alias: {'@earendil-works/pi-coding-agent': stub} });
const registry = jiti(path.join(__dirname, 'registry.ts'));
const runtime = jiti(path.join(__dirname, 'spawn-agent.ts'));
const owner = jiti(path.join(__dirname, 'owner-control.ts'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = id => ({version:1,runId:id,rootRunId:'root',parentRunId:'root',sessionId:id,processInstanceId:'fixture-'+id,executionId:'execution-'+id,name:id,task:'offline fixture',cwd:sandbox,model:'test/model',tools:[],depth:1,maxDepth:2,status:'queued',resultRoute:'manual',activity:'queued',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:0},startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
function holdLock(agentDir, id) {
  const lock = path.join(registry.registryDir(agentDir), id+'.lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'owner'), process.pid+'-offline-fixture');
  return () => fs.rmSync(lock, {recursive:true,force:true});
}
async function until(predicate) {
  const deadline = Date.now()+5000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for offline lifecycle fixture');
    await sleep(10);
  }
}
async function responsive(name, run) {
  let last=performance.now(), maxGap=0;
  const heartbeat=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},5);
  await sleep(15);
  try { await run(); await sleep(15); }
  finally { clearInterval(heartbeat); }
  assert.ok(maxGap<200, `${name} stalled timers for ${Math.round(maxGap)}ms (budget 200ms)`);
}
const request = target => ({rootRunId:'root',targetRunId:target,text:'offline fixture'});
(async()=>{
  const cancelDir=path.join(sandbox,'cancel');
  const rec=registry.saveRecord(cancelDir,record('contended-cancel'));
  const unlock=holdLock(cancelDir,rec.runId);
  try {
    await responsive('synchronous cancellation contention',async()=>{
      assert.throws(()=>runtime.cancelSubagent(cancelDir,rec),error=>error.code==='EBUSY');
    });
  } finally {unlock();}
  console.log('ok - synchronous cancellation fails fast rather than blocking five seconds');

  const asyncRec=registry.saveRecord(cancelDir,record('async-cancel'));
  const descendant=registry.saveRecord(cancelDir,{...record('descendant'),parentRunId:asyncRec.runId});
  const releaseAsync=holdLock(cancelDir,asyncRec.runId);
  try {
    await responsive('asynchronous cancellation contention',async()=>{
      setTimeout(releaseAsync,25);
      const result=await runtime.cancelSubagentAsync(cancelDir,asyncRec);
      assert.equal(result.status,'cancelled');
      assert.equal(registry.readRecord(cancelDir,descendant.runId).status,'cancelled');
      assert.equal(registry.saveRecord(cancelDir,asyncRec).status,'cancelled','a stale writer cannot erase cancellation');
    });
  } finally { releaseAsync(); }
  console.log('ok - asynchronous cancellation yields for writers and preserves descendant/monotonic cancellation');

  const retryCancel=registry.saveRecord(cancelDir,record('retry-cancel'));
  try {
    renameFault={name:/^retry-cancel\.cancelled\.tmp-/,remaining:7};
    await responsive('cancellation marker rename retries',async()=>{
      assert.equal((await runtime.cancelSubagentAsync(cancelDir,retryCancel)).status,'cancelled');
    });
    assert.equal(renameFault.remaining,0);
  } finally {renameFault=undefined;}
  console.log('ok - cancellation marker sharing violations retry without blocking timers');

  const launchDir=path.join(sandbox,'launch');
  let releaseLaunch;
  let launchLock;
  let launchRecord;
  const beforeLaunch=launches;
  try {
    await responsive('launch admission contention',async()=>{
      launchRecord=await runtime.startSubagent({task:'offline fixture'}, {
        agentDir:launchDir,parentRunId:'root',rootRunId:'root',currentDepth:0,
        settings:{maxDepth:2,maxConcurrency:1,rpcMaxLineChars:65536,aliasesOnly:false},
        parentModel:'test/model',parentTools:[],scopedModels:[{provider:'test',id:'model'}],
        parentCwd:sandbox,projectTrusted:false,rpcStartupTimeoutMs:2000,
        onRecord: rec=>{
          if (!launchLock) {
            launchLock=rec.runId; releaseLaunch=holdLock(launchDir,rec.runId);
            setTimeout(releaseLaunch,25);
          }
        },
      });
      await until(()=>registry.readRecord(launchDir,launchRecord.runId)?.status==='completed');
      await until(()=>!registry.readRecord(launchDir,launchRecord.runId)?.pid);
      assert.equal(launches-beforeLaunch,1,'lock retry must not replay spawn');
    });
  } finally { releaseLaunch?.(); }
  console.log('ok - launch lock contention yields without replaying spawn');

  const abortedLaunch=new AbortController();
  let releaseAbortedLaunch;
  const beforeAbortedLaunch=launches;
  let abortedRecord;
  try {
    await responsive('cancelling launch admission',async()=>{
      abortedRecord=await runtime.startSubagent({task:'must not launch'}, {
        agentDir:launchDir,parentRunId:'root',rootRunId:'root',currentDepth:0,signal:abortedLaunch.signal,
        settings:{maxDepth:2,maxConcurrency:1,rpcMaxLineChars:65536,aliasesOnly:false},
        parentModel:'test/model',parentTools:[],scopedModels:[{provider:'test',id:'model'}],
        parentCwd:sandbox,projectTrusted:false,rpcStartupTimeoutMs:2000,
        onRecord:rec=>{if(!releaseAbortedLaunch)releaseAbortedLaunch=holdLock(launchDir,rec.runId);},
      });
      setTimeout(()=>abortedLaunch.abort(),25);
      await until(()=>runtime.gate.running===0);
      releaseAbortedLaunch();
      await sleep(30);
      assert.equal(launches,beforeAbortedLaunch,'aborted lock admission must not launch after the writer releases');
    });
  } finally {releaseAbortedLaunch?.();await runtime.terminateOwnedSubagents(abortedRecord?[abortedRecord.runId]:[]);}
  console.log('ok - cancelling lock admission releases its slot without spawning later');

  const resumeFile=path.join(sandbox,'resume.jsonl');
  fs.writeFileSync(resumeFile,JSON.stringify({type:'session',version:3,id:'resume-admission',cwd:sandbox})+'\n');
  const resumeRecord=registry.saveRecord(launchDir,{...record('resume-admission'),status:'completed',sessionFile:resumeFile});
  const releaseResume=holdLock(launchDir,resumeRecord.runId);
  const beforeResume=launches;
  try {
    renameFault={name:/^resume-admission\.json\.tmp-/,remaining:7};
    await responsive('resume lock and rename admission',async()=>{
      setTimeout(releaseResume,25);
      await runtime.resumeSubagent(resumeRecord,'resume fixture',{
        agentDir:launchDir,parentRunId:'root',rootRunId:'root',currentDepth:0,
        settings:{maxDepth:2,maxConcurrency:1,rpcMaxLineChars:65536,aliasesOnly:false},
        parentModel:'test/model',parentTools:[],scopedModels:[{provider:'test',id:'model'}],
        parentCwd:sandbox,projectTrusted:false,rpcStartupTimeoutMs:2000,
      });
      await until(()=>!registry.readRecord(launchDir,resumeRecord.runId)?.pid);
      assert.equal(launches-beforeResume,1,'retrying a resume claim must not launch twice');
      assert.equal(renameFault.remaining,0);
      assert.notEqual(registry.readRecord(launchDir,resumeRecord.runId).processInstanceId,resumeRecord.processInstanceId);
    });
  } finally {renameFault=undefined;releaseResume();await runtime.terminateOwnedSubagents([resumeRecord.runId]);}
  console.log('ok - resume lock and rename contention yields without duplicating its process claim');

  const followUp=await runtime.startSubagent({task:'keepalive'}, {
    agentDir:launchDir,parentRunId:'root',rootRunId:'root',currentDepth:0,
    settings:{maxDepth:2,maxConcurrency:1,rpcMaxLineChars:65536,aliasesOnly:false},
    parentModel:'test/model',parentTools:[],scopedModels:[{provider:'test',id:'model'}],
    parentCwd:sandbox,projectTrusted:false,rpcStartupTimeoutMs:2000,
  });
  await until(()=>registry.readRecord(launchDir,followUp.runId)?.status==='completed');
  const releaseFollowUp=holdLock(launchDir,followUp.runId);
  try {
    await responsive('follow-up preflight contention',async()=>{
      setTimeout(releaseFollowUp,25);
      assert.equal(await runtime.sendSubagentMessage(followUp,'follow-up',undefined,'manual'),true);
    });
  } finally {releaseFollowUp();await runtime.terminateOwnedSubagents([followUp.runId]);}
  console.log('ok - a result-receipt lock cannot reject a live follow-up preflight');

  if (process.platform === 'win32') {
    const previousScript=process.argv[1];
    try {
      delete process.env.PI_SUBAGENT_COMMAND;
      process.argv[1]=path.join(sandbox,'missing-launcher.cjs');
      locatorFixture={output:locatedCli+'\n',delayMs:350,calls:0,syncCalls:0};
      const locatorContext={
        agentDir:launchDir,parentRunId:'root',rootRunId:'root',currentDepth:0,
        settings:{maxDepth:2,maxConcurrency:1,rpcMaxLineChars:65536,aliasesOnly:false},
        parentModel:'test/model',parentTools:[],scopedModels:[{provider:'test',id:'model'}],
        parentCwd:sandbox,projectTrusted:false,rpcStartupTimeoutMs:2000,
      };
      await responsive('delayed Windows PATH locator',async()=>{
        const launched=await runtime.startSubagent({task:'offline locator fixture'},locatorContext);
        await until(()=>!registry.readRecord(launchDir,launched.runId)?.pid&&registry.readRecord(launchDir,launched.runId)?.status==='completed');
      });
      assert.equal(locatorFixture.syncCalls,0,'production launch must never invoke synchronous where.exe');
      assert.equal(locatorFixture.calls,1);
      const locatedResumeFile=path.join(sandbox,'located-resume.jsonl');
      fs.writeFileSync(locatedResumeFile,JSON.stringify({type:'session',version:3,id:'located-resume',cwd:sandbox})+'\n');
      const locatedResume=registry.saveRecord(launchDir,{...record('located-resume'),status:'completed',sessionFile:locatedResumeFile});
      await responsive('delayed Windows resume locator',async()=>{
        await runtime.resumeSubagent(locatedResume,'offline located resume',locatorContext);
        await until(()=>!registry.readRecord(launchDir,locatedResume.runId)?.pid&&registry.readRecord(launchDir,locatedResume.runId)?.status==='completed');
      });
      assert.equal(locatorFixture.calls,2,'resume must use the same asynchronous locator');
      const abortLocator=new AbortController();
      const beforeLocatorAbort=launches;
      await responsive('cancelling a Windows PATH locator',async()=>{
        const aborted=await runtime.startSubagent({task:'must not launch after locator abort'},{...locatorContext,signal:abortLocator.signal});
        await until(()=>locatorFixture.calls===3);
        abortLocator.abort();
        await until(()=>runtime.gate.running===0);
        assert.match(registry.readRecord(launchDir,aborted.runId).error,/aborted/i);
        assert.equal(locatorFixture.aborted,true,'cancellation must abort the pending locator');
        await sleep(400);
        assert.equal(launches,beforeLocatorAbort,'a delayed locator must never spawn after cancellation');
      });
      assert.equal(locatorFixture.syncCalls,0);
    } finally {locatorFixture=undefined;process.argv[1]=previousScript;process.env.PI_SUBAGENT_COMMAND=fixture;}
    console.log('ok - delayed Windows PATH lookup yields for spawn/resume and aborts before spawning');
  }

  const ownerDir=path.join(sandbox,'owner');
  let deliveries=0;
  const stop=owner.startOwnerMessageConsumer(ownerDir,'owner','root',async()=>{deliveries++;});
  try {
    renameFault={name:'response.tmp',remaining:7};
    await responsive('owner acknowledgement rename retries',()=>owner.requestOwnerMessage(ownerDir,'owner',request('child'),{ownerAlive:()=>true,timeoutMs:2000}));
    assert.equal(renameFault.remaining,0);
    assert.equal(deliveries,1,'acknowledgement retries must not replay an accepted prompt');
  } finally {renameFault=undefined;await stop();}
  console.log('ok - owner acknowledgement retries yield and never replay accepted prompts');

  const failedAckAbort=new AbortController();
  let failedAckDeliveries=0;
  const stopFailedAck=owner.startOwnerMessageConsumer(ownerDir,'failed-ack','root',async()=>{failedAckDeliveries++;});
  renameFault={name:'response.tmp',remaining:Number.MAX_SAFE_INTEGER};
  const failedAck=owner.requestOwnerMessage(ownerDir,'failed-ack',request('child'),{ownerAlive:()=>true,signal:failedAckAbort.signal}).then(()=>undefined,error=>error);
  try {
    await until(()=>failedAckDeliveries===1);
    await sleep(2300);
    assert.equal(failedAckDeliveries,1,'an exhausted acknowledgement retry must not replay an accepted prompt');
    failedAckAbort.abort();
    assert.match(String(await failedAck),/aborted/);
  } finally {renameFault=undefined;failedAckAbort.abort();await failedAck;await stopFailedAck();}
  console.log('ok - exhausted acknowledgement persistence cannot replay an accepted prompt');

  await assert.rejects(owner.requestOwnerMessage(ownerDir,'absent-owner',request('child'),{ownerAlive:async()=>false,timeoutMs:100}),/owner is no longer running/);
  let ownerChecks=0;
  await assert.rejects(owner.requestOwnerMessage(ownerDir,'exiting-owner',request('child'),{ownerAlive:async()=>++ownerChecks<3,timeoutMs:100}),/owner is no longer running/);
  console.log('ok - asynchronous owner liveness is awaited before enqueue and during admission');

  const pendingAbort=new AbortController();
  let resolveOwnerCheck;
  const pendingCheck=new Promise(resolve=>{resolveOwnerCheck=resolve;});
  const pendingSend=owner.requestOwnerMessage(ownerDir,'pending-owner',request('child'),{ownerAlive:()=>pendingCheck,signal:pendingAbort.signal}).then(()=>undefined,error=>error);
  try {
    pendingAbort.abort();
    const result=await Promise.race([pendingSend,sleep(200).then(()=>{throw new Error('Cancellation waited for pending owner liveness');})]);
    assert.match(String(result),/aborted/);
  } finally {resolveOwnerCheck(true);await pendingSend;}
  assert.ok(!fs.existsSync(path.join(ownerDir,'subagents','owner-inbox','pending-owner')),'aborted liveness must not enqueue later');
  console.log('ok - cancelling an asynchronous liveness check cannot enqueue a request later');

  const raceOwner='ack-race';
  const raceBase=path.join(ownerDir,'subagents','owner-inbox',raceOwner);
  let finishRaceCheck;
  const raceCheck=new Promise(resolve=>{finishRaceCheck=resolve;});
  let raceChecks=0;
  const stopRace=owner.startOwnerMessageConsumer(ownerDir,raceOwner,'root',async()=>{});
  const raceSend=owner.requestOwnerMessage(ownerDir,raceOwner,request('child'),{ownerAlive:()=>++raceChecks===1?true:raceCheck}).then(()=>undefined,error=>error);
  try {
    await until(()=>fs.existsSync(raceBase)&&fs.readdirSync(raceBase).some(name=>fs.existsSync(path.join(raceBase,name,'response.json'))));
    finishRaceCheck(false);
    assert.equal(await raceSend,undefined,'accepted acknowledgement wins over a concurrent owner-exit check');
  } finally {finishRaceCheck(false);await raceSend;await stopRace();}
  console.log('ok - owner exit during asynchronous liveness cannot hide an accepted acknowledgement');
})().finally(async()=>{
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve=>child.once('close',resolve)); child.kill(); await closed;
    }
  }
  fs.renameSync=originals.renameSync; fsp.rename=originals.rename;
  cp.spawn=originals.spawn; cp.execFile=originals.execFile; cp.execFileSync=originals.execFileSync;
  if (previousCommand === undefined) delete process.env.PI_SUBAGENT_COMMAND; else process.env.PI_SUBAGENT_COMMAND=previousCommand;
  fs.rmSync(sandbox,{recursive:true,force:true});
}).catch(error=>{console.error(error);process.exitCode=1;});
