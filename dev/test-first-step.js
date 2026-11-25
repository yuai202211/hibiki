'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const src=fs.readFileSync(path.join(__dirname,'first-step.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
let clock=new Date('2026-11-25T21:00:00'),calls=0;
class TestDate extends Date{constructor(...v){super(...(v.length?v:[clock.getTime()]));}static now(){return clock.getTime();}}
const elements=new Map(),storage=new Map();
const elem=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',dataset:{},scrollTop:0});return elements.get(id);};
const ctx={Date:TestDate,state:{entries:{'2026-11-25':{original:{s:'08:00',p:'Example',ts:1}}},prep:{},todos:{}},CL:{uid:'test-user'},topView:'diary',ui:{tab:'di',date:'2026-11-25'},
 todayStr:()=>clock.getFullYear()+'-'+String(clock.getMonth()+1).padStart(2,'0')+'-'+String(clock.getDate()).padStart(2,'0'),
 addDays:(d,n)=>{const x=new Date(d+'T12:00:00');x.setDate(x.getDate()+n);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');},
 prepDos:p=>(p&&p.dos)||[],prepDateText:d=>d,prepTodos:()=>[],TRS:[['car','🚗 車'],['train','🚈 電車']],
 esc:x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 openMove:()=>null,prepArrived:()=>false,$:id=>elements.get(id)||null,
 document:{activeElement:null,hidden:false,querySelector:()=>null,addEventListener(){}},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 render:()=>{calls++;},toast:()=>{},ntfKick:()=>{},mutate:fn=>{fn();ctx.render();}
};
vm.createContext(ctx);vm.runInContext(src,ctx);
const run=s=>vm.runInContext(s,ctx);
assert.equal(run('fpDay()'),'2026-11-25');clock=new Date('2026-11-25T22:00:00');assert.equal(run('fpDay()'),'2026-11-26');
elem('fpError');assert.equal(run("fpSave('2026-11-26')"),false);assert.match(elem('fpError').textContent,/移動手段/);
const entries=JSON.stringify(ctx.state.entries);
run("Object.assign(fpDraft('2026-11-26'),{to:'Example district',tr:'train',dep:'10:00',task:'Reply to one email',dirty:true});fpRemember(fpDraft('2026-11-26'))");
const persisted=storage.get('hibiki-first-step-draft|test-user|2026-11-26');assert(persisted);
run('FP_DRAFTS={}');assert.equal(run("fpDraft('2026-11-26').task"),'Reply to one email');
assert.equal(run("fpSave('2026-11-26')"),true);assert.equal(JSON.stringify(ctx.state.entries),entries);assert.equal(ctx.state.prep['2026-11-26'].tr,'train');assert.equal(storage.size,0);
assert.match(run('fpCardHtml()'),/Example district/);assert(!run('fpCardHtml()').includes('id="fpForm"'));
ctx.state.prep['2026-11-26'].bring='Preserve old preparation';ctx.state.prep['2026-11-26'].dos.push('Existing second task');
run("Object.assign(fpDraft('2026-11-26'),{task:'One small document edit',tid:'',dirty:true});fpSave('2026-11-26')");assert.equal(ctx.state.prep['2026-11-26'].bring,'Preserve old preparation');assert.equal(ctx.state.prep['2026-11-26'].dos[1],'Existing second task');
ctx.state.prep['2026-11-26'].to='<img src=x onerror=alert(1)>';assert(!run('fpCardHtml()').includes('<img'));ctx.state.prep['2026-11-26'].to='Example district';
clock=new Date('2026-11-26T09:00:00');ctx.ui.date='2026-11-26';assert.match(run('fpCardHtml()'),/これを始める/);
ctx.state.prep['2026-11-26'].fpStart=clock.getTime();assert.match(run('fpCardHtml()'),/終わった！/);ctx.state.prep['2026-11-26'].dd=[1];assert.match(run('fpCardHtml()'),/最初の1つ、終わった！/);
ctx.ui.date='2026-11-25';assert.equal(run('fpCardHtml()'),'');ctx.ui.date='2026-11-26';
clock=new Date('2026-11-25T21:00:00');ctx.ntfCfg=()=>({on:{prep:1},t:{prep:'18:00'}});ctx.ntfAt=(d,t)=>new TestDate(d+'T'+t+':00');
const ntf=html.slice(html.indexOf('function ntfPlan(){'),html.indexOf('function ntfRowsOf('));vm.runInContext(ntf,ctx);
let plan=run('ntfPlan()');assert.equal(plan.filter(x=>x.tag.includes('2026-11-25')).length,0,'confirmed plan cancels both reminders');
delete ctx.state.prep['2026-11-26'];plan=run('ntfPlan()');const tonight=plan.filter(x=>x.tag.includes('2026-11-25'));assert.equal(tonight.length,2);assert.deepEqual(Array.from(tonight,x=>x.fire_at.getHours()),[22,23]);
ctx.ntfCfg=()=>({on:{prep:0},t:{}});assert.equal(run('ntfPlan().length'),0,'notification opt-out preserved');
assert(html.includes("'cond','prep','ckin'"),'existing per-day cloud collection preserved');
assert(html.includes('prep:1'),'merge known collection preserved');
require('./guard-inputs.js')(src);
console.log('PASS: 21/22 date boundary, required fields, reload drafts, confirmed summary, existing data preservation, escaping, morning task states, historical dates, both notifications/cancellation/opt-out, sync registration.');

// Exercise the mutation observer and real Yes/No handlers with synthetic entries.
clock=new Date('2026-11-25T14:00:00');ctx.ui.date='2026-11-25';
ctx.state.prep['2026-11-25']={fp:1,to:'Planned district',tr:'car',dep:'12:00',dos:['Reply once'],dd:[0],fpConfirmed:1};
let pending=null,dialog='',busy=false;
ctx.setTimeout=fn=>{pending=fn;return 1;};ctx.clearTimeout=()=>{pending=null;};
ctx.document.querySelector=()=>busy?{}:null;
ctx.openSub=h=>{dialog=h;elem('fpLinkYes');elem('fpLinkNo');};ctx.closeSub=()=>{dialog='';};
const fire=()=>{const f=pending;pending=null;if(f)f();};
assert.match(run('fpCardHtml()'),/今日、はじめにやる事/);
run("mutate(()=>{state.entries['2026-11-25'].detour={p:'Actual stop',s:'14:00',t:'Coffee',ts:2};})");
assert(pending);busy=true;fire();assert.equal(dialog,'');assert(pending,'defer while editing');busy=false;fire();
assert.match(dialog,/今回の移動・滞在は/);assert.match(dialog,/Actual stop/);
elem('fpLinkNo').onclick();assert(!ctx.state.prep['2026-11-25'].fpLink);assert.equal(pending,null,'No does not immediately ask again');
run("mutate(()=>{state.entries['2026-11-25'].detour.e='14:10';state.entries['2026-11-25'].trip={mv:1,s:'14:10',rt:'Actual stop → ',tr:'car',ts:3};})");fire();assert.match(dialog,/Actual stop →/,'next movement asks after No');
elem('fpLinkNo').onclick();
run("mutate(()=>{state.entries['2026-11-25'].trip.e='14:40';state.entries['2026-11-25'].trip.rt='Actual stop → Actual cafe';state.entries['2026-11-25'].cafe={p:'Actual cafe',s:'14:40',t:'Work',ts:4};})");fire();assert.match(dialog,/14:40 Actual cafe/,'arrival chooses the new stay, not the preceding movement');
const beforeYes=JSON.stringify(ctx.state.entries);elem('fpLinkYes').onclick();
assert.equal(JSON.stringify(ctx.state.entries),beforeYes,'link never changes, duplicates, or renames diary entries');
assert.equal(ctx.state.prep['2026-11-25'].to,'Planned district');assert.equal(ctx.state.prep['2026-11-25'].fpLink.k,'cafe');assert.equal(ctx.state.prep['2026-11-25'].dd[0],0,'linking is not task completion');
assert.match(run('fpCardHtml()'),/実際の記録と紐づけ済み/);
run("mutate(()=>{state.entries['2026-11-25'].later={p:'Later stop',s:'16:00',ts:5};})");assert.equal(pending,null,'linked plan does not ask again');
run("state.entries['2026-11-25'].cafe.del=1");assert.equal(run("fpLinked(state.prep['2026-11-25'])"),null,'deleted linked records are not shown');
run("mutate(()=>{state.entries['2026-11-25'].again={p:'Another cafe',s:'17:00',ts:6};})");assert(pending,'deleted link can be replaced at the next record');fire();elem('fpLinkNo').onclick();
run("mutate(()=>{state.entries['2026-11-24']={old:{p:'Old visit',s:'10:00',ts:7}};})");assert.equal(pending,null,'historical edits do not prompt for today');
assert(html.includes('if(p.fp){quickMoveStart(p.tr);return;}'),'legacy departure also avoids inserting a planned destination');
assert(src.includes("else if(a==='arrive'){if(openMove())mvpArrAsk();}"),'arrival opens the actual place picker');
console.log('PASS: new labels, editor deferral, No then next record, arrival candidate, explicit Yes, no place overwrite/duplicate/time change, separate completion, no repeat after link, deleted links and historical edits.');
