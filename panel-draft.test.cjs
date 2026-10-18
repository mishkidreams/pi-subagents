// Draft safety through native Pi CustomEditor, fullscreen overlay and keyboard dispatch.
// Synthetic sessions and callbacks only: no agents, provider, clipboard or OS terminal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const pi = process.env.PI_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@earendil-works/pi-coding-agent');
const {createJiti} = require(path.join(pi, 'node_modules/jiti'));
const jiti = createJiti(__filename, {interopDefault:true,fsCache:false,moduleCache:false,alias:{
  '@earendil-works/pi-coding-agent':path.join(pi,'dist/bundle/index.js'),
  '@earendil-works/pi-tui':path.join(pi,'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox:require.resolve('typebox',{paths:[pi]}),
}});
const theme={fg:(_c,t)=>String(t),bg:(_c,t)=>String(t),bold:t=>String(t)};
(async()=>{
  const host=await jiti.import('@earendil-works/pi-coding-agent');host.initTheme('dark',false);
  const {SubagentPanel}=await jiti.import(path.join(__dirname,'panel.ts'));
  const registry=await jiti.import(path.join(__dirname,'registry.ts'));
  const {TuiAltScreen,stripTerminalSequences,setKeybindings}=await import(pathToFileURL(path.join(pi,'node_modules/@earendil-works/pi-tui/dist/index.js')));
  const {KeybindingsManager}=await import(pathToFileURL(path.join(pi,'dist/core/keybindings.js')));
  const keys=new KeybindingsManager();setKeybindings(keys);
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'subagent-drafts-'));
  const forbidden=()=>{throw new Error('OFFLINE: OS interaction forbidden');};
  let panel,ui;
  try{
    const terminal={columns:160,rows:24,kittyProtocolActive:false,write:text=>assert.ok(!/\x1b\]52;/.test(text)),hideCursor(){},showCursor(){}};
    for(const method of ['start','stop','drainInput','moveBy','clearLine','clearFromCursor','clearScreen','setTitle','setProgress','setProgramStatus'])terminal[method]=forbidden;
    ui=new TuiAltScreen(terminal,false,sandbox,{mouse:true,copyOnSelect:false,copySelection:forbidden,openUrl:forbidden,onRightClickPaste:forbidden});
    const editor=new host.CustomEditor(ui,{borderColor:t=>t,selectList:{}},keys);
    const parentSent=[],childSent=[];
    editor.onSubmit=text=>{parentSent.push(text);editor.setText('');};
    editor.setText('PARENT_LONG_DRAFT');
    ui.setLayoutRoot(editor);ui.setFocus(editor);ui.beforeTerminalStart();
    const frame=()=>{ui.renderNow(false);return ui.getScreenLines().map(stripTerminalSequences);};
    const key=text=>{ui.handleTerminalInput(text);frame();};
    const flush=()=>new Promise(setImmediate);
    assert.ok(frame().some(line=>line.includes('PARENT_LONG_DRAFT')),'positive control: real parent editor is rendered');
    const records=['A','B'].map((label,i)=>{
      const sessionFile=path.join(sandbox,`child-${label}.jsonl`);
      fs.writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:`session-${label}`,cwd:sandbox,timestamp:'2026-01-01T00:00:00Z'})+'\n');
      const record={version:1,runId:`child-${label}`,parentRunId:'root',rootRunId:'root',sessionId:`session-${label}`,sessionFile,name:`DRAFT_CHILD_${label}`,task:'Public draft fixture',cwd:sandbox,depth:1,maxDepth:2,status:'thinking',pid:process.pid,model:'test/drafts',thinking:'off',startedAt:`2026-01-01T00:00:0${i}Z`,updatedAt:'2026-01-01T00:00:02Z'};
      registry.saveRecord(sandbox,record);return record;
    });
    const originalFiles=records.map(r=>fs.readFileSync(r.sessionFile,'utf8'));
    let fail=false,pending,cancelled=0;
    const options={onMessage:async(record,text)=>{
      childSent.push([record.runId,text]);
      if(fail)throw new Error('PUBLIC_DRAFT_SEND_FAILURE');
      if(pending)await pending;
    },onCancel:()=>{cancelled++;}};
    panel=new SubagentPanel(ui,theme,sandbox,'root',options);panel.setEditor(editor);
    await panel.ready();
    const open=label=>{
      assert.equal(panel.openReview(),true);panel.handleInput('\x1b[A');panel.openReview();
      for(let i=0;i<records.length;i++){
        key('\x1b[C');if(frame()[0].includes(`DRAFT_CHILD_${label}`))return;
        key('\x1b');panel.handleInput('\x1b[B');
      }
      assert.fail(`missing child ${label}`);
    };
    const field=()=>frame().at(-2);
    const back=()=>{key('\x1b');key('\x1b');};
    const replace=text=>{key('\x15');key(text);};

    open('A');key('UNSENT_A');key('\x1b');
    key('\r');await flush();
    assert.ok(field().includes('UNSENT_A'),'Enter in the list opens the child and restores its draft');
    assert.equal(childSent.length,0,'the Enter used to open a child must not also submit its draft');
    back();await flush();
    assert.equal(childSent.length,0,'Esc, returning to parent and microtasks must not submit a child draft');
    assert.equal(editor.getText(),'PARENT_LONG_DRAFT','child input cannot modify the native parent draft');
    key('\r');await flush();
    assert.deepEqual(parentSent,['PARENT_LONG_DRAFT'],'parent Enter sends only the parent prompt');
    assert.equal(childSent.length,0,'parent Enter cannot submit an abandoned child draft');
    editor.setText('PARENT_NEXT');
    console.log('ok - Esc never sends; native parent draft and parent submission remain separate');

    open('B');assert.ok(!field().includes('UNSENT_A'));
    key('B_ONLY');key('\r');await flush();frame();
    assert.deepEqual(childSent,[['child-B','B_ONLY']]);
    key('\r');await flush();assert.equal(childSent.length,1,'empty Enter after success cannot resend');
    back();open('A');assert.ok(field().includes('UNSENT_A'),'only the same child restores its unsent draft');
    replace('A_NEW_ONLY');key('\r');await flush();frame();
    assert.deepEqual(childSent.at(-1),['child-A','A_NEW_ONLY'],'replacement sends only the new text, not restored or parent text');
    key('  ');key('\r');await flush();assert.equal(childSent.length,2,'whitespace-only Enter does not send');
    replace('');key('\x1b[200~PASTED\nSECOND\x1b[201~');await flush();
    assert.equal(childSent.length,2,'a pasted newline is not an implicit Enter');
    key('\r');await flush();frame();
    assert.ok(childSent.at(-1)[1].includes('PASTED')&&childSent.at(-1)[1].includes('SECOND'));
    assert.ok(!childSent.at(-1)[1].includes('UNSENT_A'));
    console.log('ok - per-recipient restoration, clean replacement, empty Enter and bracketed paste');

    fail=true;key('FAIL_RETRY_A');key('\r');await flush();frame();back();
    open('A');assert.ok(field().includes('FAIL_RETRY_A'));
    assert.ok(frame().some(line=>line.includes('PUBLIC_DRAFT_SEND_FAILURE')),'reopened failure stays visible');
    fail=false;key('\r');await flush();frame();
    assert.deepEqual(childSent.at(-1),['child-A','FAIL_RETRY_A'],'retry submits the same one draft without concatenation');
    key('AFTER_SUCCESS');key('\r');await flush();frame();
    assert.deepEqual(childSent.at(-1),['child-A','AFTER_SUCCESS'],'successful old text never prefixes the next message');
    back();open('B');key('PRESERVED_B');back();
    console.log('ok - failed-send retry and fresh message after success stay independent');

    open('A');
    const longDraft='Живой draft 🧪 '.repeat(1000);
    key(`\x1b[200~${longDraft}\x1b[201~`);back();await flush();
    const beforeLong=childSent.length;
    open('A');assert.equal(childSent.length,beforeLong,'reopening a long draft never submits it');
    key('\r');await flush();frame();
    assert.deepEqual(childSent.at(-1),['child-A',longDraft.trim()],'long Unicode draft survives Esc without truncation or extra content');
    back();
    console.log('ok - long Unicode draft survives Esc exactly and sends only on explicit Enter');

    open('A');key('PENDING_A');let release;pending=new Promise(resolve=>{release=resolve;});
    const before=childSent.length;
    key('\r');key('\r');await flush();
    assert.equal(childSent.length,before+1,'duplicate Enter while pending does not duplicate delivery');
    replace('AFTER_ACK_A');back();
    key('_AFTER_BACK');key('\r');await flush();
    assert.equal(parentSent.at(-1),'PARENT_NEXT_AFTER_BACK','even an in-flight child send cannot contaminate the parent prompt');
    open('B');assert.ok(field().includes('PRESERVED_B'));
    release();await flush();pending=undefined;frame();
    assert.ok(field().includes('PRESERVED_B'),'another child acknowledgement cannot clear the visible draft');
    assert.deepEqual(childSent.at(-1),['child-A','PENDING_A'],'recipient and payload were frozen before the callback');
    back();open('A');assert.ok(field().includes('AFTER_ACK_A'),'late acknowledgement keeps an edited draft');
    key('\r');await flush();frame();assert.deepEqual(childSent.at(-1),['child-A','AFTER_ACK_A']);
    key('MEMORY_ONLY_A');back();
    key('\x1a');assert.ok(!/UNSENT_A|PRESERVED_B|AFTER_ACK_A|MEMORY_ONLY_A/.test(editor.getText()),'parent undo has no child text');
    assert.equal(cancelled,0,'all back navigation leaves children running');
    console.log('ok - in-flight Esc, dedup, parent typing, late ack and parent undo stay isolated');

    panel.dispose();panel=new SubagentPanel(ui,theme,sandbox,'root',options);panel.setEditor(editor);
    await panel.ready();
    const beforeRecreate=childSent.length;
    open('A');assert.ok(!field().includes('MEMORY_ONLY_A'),'recreating a panel does not load drafts from saved history');
    key('\r');await flush();assert.equal(childSent.length,beforeRecreate,'recreating/reopening never auto-submits a draft');
    back();
    assert.deepEqual(records.map(r=>fs.readFileSync(r.sessionFile,'utf8')),originalFiles,'UI-only draft storage never writes child history');
    console.log('ok - memory-only draft lifecycle, no implicit replay and no history writes');
    console.log('ALL PASS');
  }finally{
    panel?.dispose();
    if(ui){ui.stopped=true;ui.beforeTerminalStop({preserveScreen:true});ui.afterTerminalStop({preserveScreen:true});}
    fs.rmSync(sandbox,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
