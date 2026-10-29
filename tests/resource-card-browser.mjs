// Offline observed DOM plus production adapter/runner. Editor paste and response
// are models. All requests local/aborted; no real provider, extension or clipboard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const html = fs.readFileSync(new URL('./fixtures/current-resource-card.html', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../src/content-core.js', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../src/content-runner.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
let passed = 0;
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9);
try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.abort());
  await context.route('https://apm-fixture.test/c/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  async function fixture(name, options, check) {
    if (filter && !name.includes(filter)) return;
    const page = await context.newPage();
    try {
      await page.goto('https://apm-fixture.test/c/observed-resource-card');
      await page.addScriptTag({ content: core });
      await page.evaluate(options => {
        const composer = ChatGptAdapter.findComposer(), form = composer.closest('form');
        const region = form.querySelector('[data-composer-attachments]');
        const template = region.firstElementChild.firstElementChild.cloneNode(true);
        const s = globalThis.resourceFixture = { composer, form, region, template, options, writes: 0, clicks: 0, sent: [], modes: [], plan: null, transaction: null, retained: null, attachmentText: null };
        form.addEventListener('submit', e => e.preventDefault());
        s.clearRegion = () => { region.replaceChildren(); region.hidden = true; region.removeAttribute('data-visible-attachments'); };
        s.addCard = () => { const row = document.createElement('div'); row.className = 'flex flex-wrap items-end gap-2 p-1'; const card = template.cloneNode(true); row.append(card); region.append(row); region.hidden = false; region.setAttribute('data-visible-attachments', ''); return card; };
        if (!options.existing) s.clearRegion();
        if (options.prefix !== undefined) {
          const p = document.createElement('p');
          if (options.pill) {
            const pill = document.createElement('span');
            for (const [k,v] of Object.entries({ 'data-inline-selection-pill': '', 'data-system-hint-type': 'search', 'data-system-hint-label': 'ウェブ検索', 'data-prompt-link-href': 'chatgpt-system-hint://search', 'data-prompt-link-label': 'ウェブ検索', 'data-appearance': 'inline-mention', contenteditable: 'false' })) pill.setAttribute(k,v);
            const icon = document.createElement('span'); icon.setAttribute('contenteditable','false'); icon.innerHTML = '<svg width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M2 2L4 4"></path></svg>';
            const label = document.createElement('span'); label.textContent = 'ウェブ検索'; pill.append(icon,label); p.append(pill,' '); s.retained = pill;
          } else p.textContent = options.prefix;
          composer.replaceChildren(p);
        }
        s.binding = Object.freeze({ deliveryAttemptToken: 'resource-attempt', runId: 'resource-run', executionSessionId: 'resource-session', stateRevision: 1, stepId: 'resource-step', stepIndex: 0, repeatIndex: 0, sendsCompleted: 0, promptHash: 'synthetic-macro-hash', inputHash: 'synthetic-combined-hash', documentInstanceId: instanceId, conversationKey: ChatGptAdapter.getConversationKey(), runnerToken: 1 });
        s.prepare = () => { s.plan = ChatGptAdapter.preparePromptAppend(options.macro ?? 'Synthetic instruction'); return Boolean(s.plan); };
        s.write = () => { try { s.transaction = ChatGptAdapter.writePrompt(options.macro ?? 'Synthetic instruction', s.binding, s.plan); return { ok:true,code:null }; } catch(e) { return { ok:false,code:e.code??null }; } };
        s.observe = () => { const a = ChatGptAdapter.inspectPromptDelivery(s.transaction, s.transaction?.expectedText ?? options.macro ?? 'Synthetic instruction', s.binding); return { ok:a.ok,mode:a.mode??null,reason:a.reason??null,lastState:a.diagnostic?.lastState }; };
        s.snapshot = () => { const a = ChatGptAdapter.getComposerAttachmentState(composer); return { known:a.known,count:a.count,hiddenCount:a.hiddenCount,writes:s.writes,clicks:s.clicks,text:ChatGptAdapter.getComposerText(composer),retained:!s.retained||composer.contains(s.retained),sendActionable:composerSurfaceSendIsActionable(a) }; };
        composer.addEventListener('paste', e => {
          e.preventDefault(); s.writes++;
          const appended = e.clipboardData.getData('text/plain');
          if (options.convert) { s.attachmentText = appended; s.addCard(); if (!s.plan) composer.replaceChildren(document.createElement('p')); if(options.pending) ChatGptAdapter.findSendButton().disabled = true; return; }
          const t=document.createElement('template'); t.innerHTML=e.clipboardData.getData('text/html'); const ps=[...t.content.children],first=ps.shift(),last=composer.lastElementChild;
          last.querySelectorAll('br.ProseMirror-trailingBreak').forEach(n=>n.remove());
          const r=document.createRange();r.selectNodeContents(last);r.collapse(false);const content=document.createDocumentFragment();content.append(...first.childNodes);r.insertNode(content);composer.append(...ps);
        });
        ChatGptAdapter.findSendButton().addEventListener('click', () => {
          s.clicks++;s.sent.push(s.attachmentText??ChatGptAdapter.getComposerText(composer));s.modes.push(s.attachmentText===null?'text':'paste-attachment');composer.replaceChildren(document.createElement('p'));
          if(!options.persistentResidual)s.clearRegion();s.attachmentText=null;
          const stop=document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';form.append(stop);setTimeout(()=>{stop.remove();if(options.leaveResidual)s.addCard();},100);
        });
      }, options);
      await check(page);passed++;console.log('PASS '+name);
    } finally { await page.close(); }
  }
  async function runSequence(page, repeat) {
    await page.addScriptTag({ content:runner });
    return page.evaluate(async repeat => {
      const s=resourceFixture;
      saveActiveRun=async r=>{s.activeRun=structuredClone(r);};getActiveRun=async()=>structuredClone(s.activeRun);
      acquireLease=async(conversationKey,runId,executionSessionId)=>({conversationKey,runId,executionSessionId,nonce:'offline-resource-lease'});
      renewLease=async()=>true;releaseLease=async()=>{};appendDiagnostic=async()=>{};
      globalThis.chrome={runtime:{sendMessage:async()=>({ok:true})}};READY_STABLE_MS=20;POLL_MS=20;if(s.options.shortSettlementTimeout)PROMPT_DELIVERY_SETTLEMENT_MAX_MS=150;
      const steps=[{id:'send',type:'prompt',delivery:'send',prompt:s.options.macro??'Synthetic instruction',repeat:s.options.nextShort?1:repeat,delayAfterMs:0}];if(s.options.nextShort)steps.push({id:'short',type:'prompt',delivery:'send',prompt:'Next short instruction',repeat:1,delayAfterMs:0});
      const workflow=normalizeWorkflow({schemaVersion:1,id:'offline-resource',maxSends:repeat,steps});
      const run={runId:'offline-resource-run',provider:'chatgpt',conversationKey:ChatGptAdapter.getConversationKey(),executionSessionId:'offline-session',documentInstanceId:instanceId,contentVersion:__AIPM_CONTENT_CORE__.version,stateRevision:1,status:'running',phase:'ready',resumable:true,workflow,cursor:{stepIndex:0,repeatIndex:0,sendsCompleted:0},outbox:null,waitState:null};
      await captureInitialPromptAppend(run);s.activeRun=structuredClone(run);localRunnerToken++;await executeRun(run,localRunnerToken);
      return {status:s.activeRun.status,reason:s.activeRun.lastErrorCode??null,sendsCompleted:s.activeRun.cursor.sendsCompleted,sent:s.sent,modes:s.modes,...s.snapshot()};
    },repeat);
  }
  await fixture('observed eleven-level card detected exactly once',{existing:true},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture,t=s.region.querySelector('.composer-attachment-surface');let depth=0,n=t;while(n&&n!==s.form){depth++;n=n.parentElement;}return{depth,buttons:t.querySelectorAll('button').length,...s.snapshot()};});
    assert.equal(r.depth,11);assert.equal(r.buttons,3);assert.equal(r.known,true);assert.equal(r.count,1);assert.equal(r.hiddenCount,0);assert.equal(r.sendActionable,true);assert.equal(r.text,'');
  });
  await fixture('pre-existing card stops runner before write/click',{existing:true},async page=>{
    const r=await runSequence(page,1);assert.equal(r.status,'paused');assert.equal(r.reason,'unexpected_attachment');assert.equal(r.writes,0);assert.equal(r.clicks,0);assert.equal(r.sendsCompleted,0);
  });
  for(const mutation of ['hidden-region','hidden-card','hidden-remove','unknown-card','unknown-hidden-region','missing-remove-label','duplicate-remove','orphan-same-form','missing-region-marker','different-body-same-form','known-plus-unknown-sibling','known-plus-unknown-wrapper','additional-legacy-remove']) {
    await fixture(mutation+' cannot become a clean input baseline',{existing:true},async page=>{
      const r=await page.evaluate(m=>{const s=resourceFixture,c=s.region.querySelector('.composer-attachment-surface'),remove=c.querySelector('[aria-label="貼り付けたテキストの添付を削除"]');
        if(m==='hidden-region')s.region.hidden=true;if(m==='hidden-card')c.hidden=true;if(m==='hidden-remove')remove.hidden=true;
        if(m==='unknown-card'||m==='unknown-hidden-region'){s.region.replaceChildren(Object.assign(document.createElement('span'),{textContent:'Unknown card shape'}));if(m==='unknown-hidden-region')s.region.hidden=true;}
        if(m==='missing-remove-label')remove.removeAttribute('aria-label');if(m==='duplicate-remove')c.append(remove.cloneNode(true));if(m==='additional-legacy-remove'){const extra=remove.cloneNode(true);extra.setAttribute('aria-label','Remove file');c.append(extra);}
        if(m==='orphan-same-form'){s.form.append(c);s.clearRegion();}if(m==='missing-region-marker')s.region.removeAttribute('data-composer-attachments');
        if(m==='different-body-same-form'){const body=document.createElement('div');body.setAttribute('data-composer-body','');body.append(s.region);s.form.append(body);}
        if(m==='known-plus-unknown-sibling')s.region.append(Object.assign(document.createElement('span'),{textContent:'Unrecognized attachment'}));
        if(m==='known-plus-unknown-wrapper'){const wrapper=document.createElement('div');wrapper.append(Object.assign(document.createElement('span'),{textContent:'Unrecognized attachment'}));s.region.firstElementChild.append(wrapper);}
        const baseline=s.snapshot(),write=s.write();return{baseline,write,after:s.snapshot()};},mutation);
      assert.ok(!r.baseline.known||r.baseline.count>0||r.baseline.hiddenCount>0,JSON.stringify(r.baseline));assert.equal(r.write.ok,false);assert.equal(r.after.writes,0);assert.equal(r.after.clicks,0);
      if(mutation.startsWith('known-plus-unknown')||mutation==='additional-legacy-remove')assert.equal(r.baseline.known,false);
    });
  }
  for(const destination of ['outside-form','different-form'])await fixture(destination+' card excluded from current composer scope',{},async page=>{
    const r=await page.evaluate(d=>{const s=resourceFixture,c=s.template.cloneNode(true);if(d==='different-form'){const f=document.createElement('form');f.append(c);document.body.append(f);}else document.body.append(c);const before=s.snapshot();s.prepare();return{before,write:s.write(),observed:s.observe(),after:s.snapshot()};},destination);
    assert.equal(r.before.known,true);assert.equal(r.before.count,0);assert.equal(r.write.ok,true);assert.equal(r.observed.ok,true);assert.equal(r.observed.mode,'text');assert.equal(r.after.writes,1);
  });
  await fixture('single new observed card settles with deep hierarchy',{convert:true,macro:'test'.repeat(20160)},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture;s.prepare();return{write:s.write(),observed:s.observe(),...s.snapshot()};});assert.equal(r.write.ok,true);assert.equal(r.observed.ok,true,JSON.stringify(r.observed));assert.equal(r.observed.mode,'paste-attachment');assert.equal(r.count,1);assert.equal(r.clicks,0);
  });
  await fixture('disabled Send waits separately from attachment ownership',{convert:true,pending:true},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture;s.prepare();s.write();const pending=s.observe();ChatGptAdapter.findSendButton().disabled=false;return{pending,ready:s.observe(),...s.snapshot()};});assert.equal(r.pending.ok,false);assert.equal(r.pending.lastState,'attachment-pending');assert.equal(r.ready.ok,true);assert.equal(r.ready.mode,'paste-attachment');assert.equal(r.writes,1);assert.equal(r.clicks,0);
  });
  await fixture('ready card hidden later revokes readiness',{convert:true},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture;s.prepare();s.write();const ready=s.observe();s.region.hidden=true;return{ready,hidden:s.observe(),...s.snapshot()};});assert.equal(r.ready.ok,true);assert.equal(r.hidden.ok,false);assert.equal(r.clicks,0);
  });
  await fixture('second card during conversion rejected',{convert:true},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture;s.prepare();s.write();s.addCard();return{observed:s.observe(),...s.snapshot()};});assert.equal(r.observed.ok,false);assert.equal(r.clicks,0);assert.ok(r.count>1||!r.known);
  });
  await fixture('trusted interference revokes new card transaction',{convert:true},async page=>{
    await page.evaluate(()=>{resourceFixture.prepare();resourceFixture.write();resourceFixture.composer.focus();});await page.keyboard.press('ArrowLeft');
    const r=await page.evaluate(()=>({observed:resourceFixture.observe(),...resourceFixture.snapshot()}));assert.equal(r.observed.ok,false);assert.equal(r.observed.reason,'user-interaction');assert.equal(r.clicks,0);
  });
  await fixture('80640-character modeled conversion Repeat3 production core and runner',{convert:true,macro:'test'.repeat(20160)},async page=>{
    const r=await runSequence(page,3);assert.equal(r.status,'completed',r.reason);assert.equal(r.clicks,3);assert.equal(r.writes,3);assert.equal(r.sendsCompleted,3);assert.deepEqual(r.modes,['paste-attachment','paste-attachment','paste-attachment']);assert.ok(r.sent.every(t=>t==='test'.repeat(20160)));
  });
  await fixture('post-ACK residual card blocks next SHORT step before another write',{convert:true,leaveResidual:true,nextShort:true},async page=>{
    const r=await runSequence(page,2);assert.equal(r.status,'paused');assert.equal(r.reason,'unexpected_attachment');assert.equal(r.clicks,1);assert.equal(r.writes,1);assert.equal(r.sendsCompleted,1);
  });
  for(const pill of [false,true])await fixture((pill?'observed web-search pill':'ordinary initial text')+' first-only append across short Repeat3',{prefix:pill?'ウェブ検索 ':'Initial instruction',pill,macro:'Next instruction'},async page=>{
    const r=await runSequence(page,3);assert.equal(r.status,'completed',r.reason);assert.equal(r.clicks,3);assert.equal(r.writes,3);assert.deepEqual(r.sent,[(pill?'ウェブ検索 ':'Initial instruction')+'\nNext instruction','Next instruction','Next instruction']);
  });
  await fixture('paused combined pill input adopts without duplicate append',{prefix:'ウェブ検索 ',pill:true,macro:'Next instruction'},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture;s.prepare();s.write();const expected=s.plan.expectedText,receipt=ChatGptAdapter.capturePausedPromptText(s.transaction,expected,s.binding);ChatGptAdapter.finishPromptDelivery(s.transaction);const next={...s.binding,deliveryAttemptToken:'next',stateRevision:4,runnerToken:2},adopted=ChatGptAdapter.adoptPausedPromptText(receipt,expected,next);return{receipt:Boolean(receipt),ok:ChatGptAdapter.inspectPromptDelivery(adopted,expected,next).ok,...s.snapshot()};});assert.equal(r.receipt,true);assert.equal(r.ok,true);assert.equal(r.retained,true);assert.equal(r.text,'ウェブ検索 \nNext instruction');assert.equal(r.writes,1);assert.equal(r.clicks,0);
  });
  await fixture('large Unicode converted prompt completes Repeat3 exactly',{convert:true,macro:'日本語🚀e\u0301\n'.repeat(10_000)+'終'},async page=>{
    const r=await runSequence(page,3);assert.equal(r.status,'completed',r.reason);assert.equal(r.clicks,3);assert.equal(r.writes,3);assert.equal(r.sendsCompleted,3);assert.ok(r.sent.every(t=>t==='日本語🚀e\u0301\n'.repeat(10_000)+'終'));
  });
  await fixture('disabled converted input times out before any click',{convert:true,pending:true,shortSettlementTimeout:true},async page=>{
    const r=await runSequence(page,1);assert.equal(r.status,'paused');assert.equal(r.reason,'paste_attachment_settlement_timeout');assert.equal(r.writes,1);assert.equal(r.clicks,0);assert.equal(r.sendsCompleted,0);
  });
  await fixture('persistent card after click stops ambiguous ACK without resending',{convert:true,persistentResidual:true,nextShort:true},async page=>{
    const r=await runSequence(page,2);assert.equal(r.status,'paused');assert.equal(r.reason,'submission_ambiguous');assert.equal(r.writes,1);assert.equal(r.clicks,1);assert.equal(r.sendsCompleted,0);
  });
  await fixture('observed web-search pill retained while only appended suffix converts',{prefix:'ウェブ検索 ',pill:true,convert:true,macro:'test'.repeat(20_160)},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture;s.prepare();const write=s.write();return{write,observed:s.observe(),...s.snapshot()};});assert.equal(r.write.ok,true);assert.equal(r.observed.ok,true,JSON.stringify(r.observed));assert.equal(r.observed.mode,'paste-attachment');assert.equal(r.retained,true);assert.equal(r.text,'ウェブ検索 ');assert.equal(r.writes,1);assert.equal(r.clicks,0);
  });
  for(const unknown of [false,true])await fixture('legacy card within current region '+(unknown?'rejects unknown sibling':'retains valid shallow signature'),{existing:true},async page=>{
    const r=await page.evaluate(unknown=>{const s=resourceFixture,body=s.composer.closest('[data-composer-body]');s.form.append(body);const c=s.region.querySelector('.composer-attachment-surface');c.className='';c.dataset.testid='file-thumbnail';c.querySelector('[aria-label="貼り付けたテキストの添付を削除"]').setAttribute('aria-label','Remove attachment');if(unknown)s.region.append(Object.assign(document.createElement('div'),{textContent:'Unclassified attachment'}));const a=ChatGptAdapter.getComposerAttachmentState(s.composer);return{...s.snapshot(),signature:candidateStructuralSignature(c,a)};},unknown);
    assert.equal(r.known,!unknown);assert.equal(r.count,1);if(!unknown)assert.ok(r.signature);
  });
  for(const pill of [false,true])await fixture('pre-existing card preserves '+(pill?'pill':'ordinary text')+' without append',{existing:true,prefix:pill?'ウェブ検索 ':'Keep existing instruction',pill},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture,before=s.snapshot();let error=null;try{s.prepare();s.write();}catch(e){error=e.code;}return{error,before,after:s.snapshot()};});assert.equal(r.error,'composer_attachment_unconfirmed');assert.equal(r.after.text,r.before.text);assert.equal(r.after.retained,true);assert.equal(r.after.writes,0);assert.equal(r.after.clicks,0);
  });
  for(const populated of [true,false])await fixture('marked scope with '+(populated?'populated':'empty hidden')+' same-form sibling region',{existing:populated},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture,wrapper=document.createElement('div');wrapper.dataset.testid='composer-surface';const send=ChatGptAdapter.findSendButton();s.composer.closest('[data-composer-body]').append(wrapper);wrapper.append(s.composer,send);const before=s.snapshot(),write=s.write();return{kind:safeComposerSurface(s.composer).kind,before,write,after:s.snapshot()};});assert.equal(r.kind,'marked-ancestor');assert.equal(r.before.known,!populated);assert.equal(r.write.ok,!populated);assert.equal(r.after.writes,populated?0:1);assert.equal(r.after.clicks,0);
  });
  for(const [index,label] of ['Remove file synthetic prompt preview','添付ファイルを削除 synthetic prompt preview','貼り付けたテキストの添付を削除'].entries())await fixture('preview-label positive '+index+' does not become a remove action',{convert:true},async page=>{
    const r=await page.evaluate(label=>{const s=resourceFixture;s.prepare();s.write();const overlay=s.region.querySelector('button.peer\\/resource-card');overlay.setAttribute('aria-label',label);return{observed:s.observe(),...s.snapshot()};},label);assert.equal(r.known,true);assert.equal(r.count,1);assert.equal(r.observed.ok,true,JSON.stringify(r.observed));assert.equal(r.observed.mode,'paste-attachment');assert.equal(r.clicks,0);
  });
  await fixture('preview-label negative exact collision cannot replace missing remove action',{existing:true},async page=>{
    const r=await page.evaluate(()=>{const s=resourceFixture,c=s.region.querySelector('.composer-attachment-surface');c.querySelector('[aria-label="貼り付けたテキストの添付を削除"]').remove();c.querySelector('button.peer\\/resource-card').setAttribute('aria-label','貼り付けたテキストの添付を削除');const before=s.snapshot(),write=s.write();return{before,write,after:s.snapshot()};});assert.equal(r.before.known,false);assert.equal(r.write.ok,false);assert.equal(r.after.writes,0);assert.equal(r.after.clicks,0);
  });
  assert.ok(passed > 0, 'Filter must select at least one scenario');
  console.log('Resource-card offline DOM PASS: '+passed+' scenarios; observed structure, modeled paste/response, no real provider operation');
}finally{await browser.close();}
