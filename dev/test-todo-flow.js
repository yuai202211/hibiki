'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const src=fs.readFileSync(path.join(__dirname,'todo-flow.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const store=new Map();let day='2026-11-28',writes=0,completions=0;
const ctx={state:{todos:{old:{t:'Old title',c:'old detail',d:'2026-11-27',ts:1},keep:{t:'Existing',d:day,ts:2,fl:{a:1},custom:'keep'}},memos:{keep:{t:'Unrelated memo',ts:1}},entries:{keep:{t:'Existing diary'}},prep:{keep:{dos:['Existing prep']}}},localSaveFail:false,CL:{uid:'test'},Date,Math,Set,JSON,Number,String,Object,Array,
 todayStr:()=>day,tdHib:()=>false,tdDone:x=>!!x.done,toast:()=>{},$:()=>null,
 localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},setTimeout:()=>1,clearTimeout:()=>{},
 mutate:fn=>{fn();writes++;},saveLocal:()=>{},tdSet:(id,p)=>Object.assign(ctx.state.todos[id],p,{ts:Date.now()}),
 tdComplete:id=>{completions++;ctx.state.todos[id].done=1;ctx.state.todos[id].dn=day;},
 esc:x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))};
vm.createContext(ctx);vm.runInContext(src,ctx);const run=s=>vm.runInContext(s.replace(/\n/g,'\\n'),ctx);ctx.tfRender=()=>{};
const preserved=JSON.stringify([ctx.state.entries,ctx.state.prep,ctx.state.memos.keep]);
let p=run("tfParse('・Title A\nDetail A\n\nsecond paragraph\n・Title B\nDetail B')");assert.equal(p.items.length,2);assert.equal(p.items[0].c,'Detail A\n\nsecond paragraph');
assert.equal(run("tfParse('Plain title\nbody').items[0].c"),'body');assert(run("tfParse('・\nbody').error"));assert.equal(run("tfParse('・valid\n・\ninvalid').items.length"),0);
run("tfInput('・First\nＤｅｔａｉｌ Alpha\n・Second\nBody B\n── 今日、最低ここまで ──\n・Third\nBody C')");assert(run('tfSaveDraft()'));assert(store.size);const draftId=run('TF.draft.id');
run('TF.draft=null; tfLoad()');assert.equal(run('TF.draft.id'),draftId);assert.equal(run('TF.draft.text.includes("Body C")'),true);
assert(run('tfApply()'));assert.equal(run('tfToday(false).length'),4);assert.equal(run('tfRows().filter(x=>x.tfDivider).length'),1);assert.equal(ctx.state.memos[draftId].tfApplied,1);assert.equal(ctx.state.todos[draftId+'-0'].c,'Ｄｅｔａｉｌ Alpha');
const total=Object.keys(ctx.state.todos).length;assert.equal(run('tfApply()'),false);assert.equal(Object.keys(ctx.state.todos).length,total,'double click does not duplicate');
assert.equal(run('tfToday(false).some(x=>x.id==="old")'),false);
run("TF.search=true;TF.q='detail alpha';TF.status='all'");assert(run('tfRows().filter(tfMatch).length')===1);run("TF.q='';TF.from='2026-11-27';TF.to='2026-11-27'");assert.equal(run('tfRows().filter(tfMatch).length'),1);run("TF.from='';TF.to='';TF.q='・First'");assert.equal(run('tfRows().filter(tfMatch).length'),1,'original wording searchable');
run(`tfComplete('${draftId}-0',false)`);assert.equal(completions,0);run("TF.confirm=''");assert.equal(completions,0);run(`tfComplete('${draftId}-0',false);tfComplete('${draftId}-0',true);tfComplete('${draftId}-0',true)`);assert.equal(completions,1);
run("TF.q='';TF.status='done'");assert.equal(run('tfRows().filter(tfMatch).length'),1);run("TF.status='open'");assert.equal(run('tfRows().filter(tfMatch).length'),4);
const ids=run('tfRows().filter(x=>tfDate(x)===todayStr()&&(x.tfDivider||!tdDone(x))).sort(tfOrder).map(x=>x.id).reverse()');ctx.ids=ids;assert(run('tfReorder(ids)'));assert.deepEqual(Array.from(run('tfRows().filter(x=>tfDate(x)===todayStr()&&(x.tfDivider||!tdDone(x))).sort(tfOrder).map(x=>x.id)')),Array.from(ids));assert(!run("tfReorder(['wrong'])"));assert.equal(ctx.state.todos.old.ts,1);assert.equal(ctx.state.todos.keep.custom,'keep');
run(`TF.edit={id:'${draftId}-1',t:'Changed',c:'New detail',baseT:'Second',baseC:'Body B'};tfSaveEdit()`);assert.equal(ctx.state.todos[draftId+'-1'].t,'Changed');assert.equal(ctx.state.todos[draftId+'-1'].tfSource,'・Second\nBody B');
run(`TF.edit={id:'${draftId}-1',t:'Conflict',c:'',baseT:'Second',baseC:'Body B'};tfSaveEdit()`);assert.equal(ctx.state.todos[draftId+'-1'].t,'Changed','stale editor cannot overwrite');run('TF.edit=null');
// Failed local save keeps input. A retry after in-memory application reuses the same IDs.
run("tfInput('・Retry title\nRetain every word')");ctx.localSaveFail=true;assert(!run('tfApply()'));assert(run('TF.draft.text.includes("Retain")'));ctx.localSaveFail=false;assert(run('tfSaveDraft()'));
const failedId=run('TF.draft.id');let failStep=0;ctx.mutate=fn=>{fn();if(++failStep===2)ctx.localSaveFail=true;};assert(!run('tfApply()'));assert.equal(ctx.state.memos[failedId].tfApplied,1);const n=Object.keys(ctx.state.todos).length;
ctx.mutate=fn=>fn();ctx.saveLocal=()=>{ctx.localSaveFail=false;};assert(run('tfApply()'));assert.equal(Object.keys(ctx.state.todos).length,n);
// Another device's draft is preserved while the local revision gets a new identity.
run("tfInput('・My draft');tfSaveDraft()");const conflictId=run('TF.draft.id');ctx.state.memos[conflictId].t='Other device';run("tfInput('・My revised draft');tfSaveDraft()");assert.notEqual(run('TF.draft.id'),conflictId);assert.equal(ctx.state.memos[conflictId].t,'Other device');
const cleanId=run('TF.draft.id');ctx.state.memos[cleanId].t='Newer remote draft';assert(run('tfApply()'));assert.equal(ctx.state.memos[cleanId].t,'Newer remote draft');assert(!ctx.state.memos[cleanId].tfApplied);
day='2026-11-29';assert.equal(run('tfToday(false).length'),0);assert.equal(run('tfToday(true).length'),0);assert(Object.keys(ctx.state.todos).length>0,'midnight does not remove tasks');
assert.equal(JSON.stringify([ctx.state.entries,ctx.state.prep,ctx.state.memos.keep]),preserved);
const escaped=run("tfCard({id:'test',t:'<script>alert(1)</script>',c:'<img onerror=alert(1)>',done:0},false)");assert(!escaped.includes('<script>'));assert(escaped.includes('&lt;script&gt;'));
assert(html.includes('<option value="')||html.includes("['all','すべて']"));assert(html.includes('todo-flow.css?v=c50.34'));assert(html.includes('function renderTodoPage(){return tfRender();}'));
assert.equal(fs.readFileSync(path.join(__dirname,'../todo-flow.css'),'utf8'),fs.readFileSync(path.join(__dirname,'todo-flow.css'),'utf8'));
// Exercise the actual cloud serializer and merge, including all new fields and tombstones.
const grab=re=>{const m=html.match(re);assert(m);return m[0];},m0=html.indexOf('function mergeStates('),m1=html.indexOf('\n}\n',m0)+3,c0=html.indexOf('function clItems('),c1=html.indexOf('const clKey=');
const cloudCode='const DEF_DREAM={name:"",due:"",ts:0};\n'+grab(/^const emptyState=.*$/m)+'\n'+['CL_ID','CL_DAY','CL_DAY2','CL_SKIP'].map(n=>grab(new RegExp('^const '+n+'=.*$','m'))).join('\n')+'\n'+html.slice(c0,c1)+html.slice(m0,m1)+'\n({clItems,clRowsToState,mergeStates,emptyState})';
const cloud=vm.runInNewContext(cloudCode,{}),plain=x=>JSON.parse(JSON.stringify(x));
const original=plain(ctx.state),restored=cloud.mergeStates(cloud.emptyState(),cloud.clRowsToState(cloud.clItems(original)));
assert.deepEqual(plain(restored.todos),original.todos);assert.deepEqual(plain(restored.memos),original.memos);
const deleted={del:1,ts:Date.now()+10000},merged=cloud.mergeStates(restored,cloud.clRowsToState(cloud.clItems({todos:{old:deleted}})));
assert.equal(merged.todos.old.del,1);assert.deepEqual(plain(merged.todos.keep),original.todos.keep);
const mt=original.memos[draftId].ts;assert(mt>0);const older=plain(original);older.memos[draftId].tfApplied=0;older.memos[draftId].ts=mt-1;
assert.equal(cloud.mergeStates(older,original).memos[draftId].tfApplied,1);
// Hold-to-drag: early motion cancels, a held grip reorders, pointer cancellation never saves.
let pending=null,frame=null,orders=[];ctx.setTimeout=fn=>{pending=fn;return 1;};ctx.clearTimeout=()=>{pending=null;};ctx.requestAnimationFrame=fn=>{frame=fn;return 1;};ctx.cancelAnimationFrame=()=>{frame=null;};
const make=(id,top)=>({dataset:{row:id},classList:{add(){},remove(){}},getBoundingClientRect:()=>({top,height:100})});
const a=make('a',100),b=make('b',200),list={children:[a,b],insertBefore(node,before){this.children=this.children.filter(x=>x!==node);const i=before?this.children.indexOf(before):this.children.length;this.children.splice(i,0,node);}};
Object.defineProperty(a,'nextElementSibling',{get:()=>list.children[list.children.indexOf(a)+1]||null});
const pane={scrollTop:0,getBoundingClientRect:()=>({top:0,bottom:500})};ctx.$=id=>id==='tfList'?list:id==='page'?{querySelector:()=>pane}:null;ctx.tfReorder=ids=>{orders.push([...ids]);return true;};
const grip={closest:()=>a,setPointerCapture(){},dataset:{grip:'a'}};ctx.grip=grip;run("TF.edit=null;TF.confirm='';tfGrip(grip)");
const event=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){}});
grip.onpointerdown(event(20,150));grip.onpointermove(event(20,180));assert.equal(pending,null);grip.onpointerup();assert.equal(orders.length,0);
grip.onpointerdown(event(20,150));pending();grip.onpointermove(event(20,350));frame();grip.onpointerup();assert.deepEqual(orders,[['b','a']]);
list.children=[a,b];grip.onpointerdown(event(20,150));pending();grip.onpointermove(event(20,350));frame();grip.onpointercancel();assert.equal(orders.length,1);
console.log('PASS: parser, raw retention, draft reload/conflict, idempotency, local-save failure retry, today-only, date/keyword/status search, confirmation, priority, editing, escaping, metadata and diary preservation.');
console.log('PASS: actual cloud serialization/merge/tombstones, raw memo roundtrip, hold-to-drag, early-motion cancellation and cancelled-drop safety.');
