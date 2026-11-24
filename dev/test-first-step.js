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
