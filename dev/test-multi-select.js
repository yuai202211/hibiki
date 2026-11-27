'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(a,b){const s=html.indexOf(a),e=html.indexOf(b,s);assert(s>=0&&e>s,a);return html.slice(s,e);}
const ctx={state:{kinds:{},_cfg:{}},grpOk:()=>true,kSg:()=>'',localStorage:{getItem:()=>null,setItem(){}},esc:s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),AI_TOOLS:[['codex','Codex'],['claude','Claude']],AI_KINDS:{ai:1},aipList:()=>[{id:'app',ic:'📲',lb:'アプリ開発'},{id:'research',ic:'🔍',lb:'調べ物'}]};
vm.createContext(ctx);const run=s=>vm.runInContext(s,ctx);
run(section('const KIND_BASE=','function coLb()')+section('function kindOf(','function acPlCands(')+section('var WK_SITE=','var WK_SCT1='));
run(fs.readFileSync(path.join(__dirname,'multi-select.js'),'utf8'));
run(section('function wkTagHtml(x){','const AIP0='));
run('function kindList(){return KIND_BASE.map(b=>kindOf(b[0]));}');
function edit(key,v){ctx.key=key;ctx.v=v;return run('wkApply(row,key,v,"test")');}
function data(s){return JSON.parse(JSON.stringify(run(s)));}
function has(ks){for(const k of ks)assert(data('[row.k].concat(row.kx||[])').includes(k),k);}
ctx.row={t:'Keep my exact note',c:'Keep detail',s:'09:00',e:'10:00',m:60,ph:['photo-reference']};
edit('p~','car');edit('p~car','scr');edit('p~car~scr','cis');edit('p~car~scr~cis','mkt');edit('p~car~scr~cis','c_shitami');
has(['mkt','c_shitami']);assert.equal(data('row.t'),'Keep my exact note');
edit('f~d','pc');edit('f~d','phone');edit('f~ws','desk');edit('f~ws','car');
assert.deepEqual(data('wmValues(row,"d")'),['pc','phone']);assert.deepEqual(data('wmValues(row,"ws")'),['desk','car']);
edit('p~','ai');edit('f~ai','codex');edit('f~ai','claude');edit('f~ap','app');edit('f~ap','research');edit('f~wy','hibiki');edit('f~wy','car');
has(['ai','mkt','c_shitami']);assert.equal(run('wkDone(row)'),true);
edit('p~','email_send');edit('p~','email_read');has(['email_send','email_read','ai','mkt','c_shitami']);
assert.equal(data('row.m'),60);assert.deepEqual(data('row.ph'),['photo-reference']);assert.equal(data('row.c'),'Keep detail');
assert.equal(data('row.s'),'09:00');assert.equal(data('row.e'),'10:00');
const saved=JSON.parse(JSON.stringify(ctx.row));ctx.row=JSON.parse(JSON.stringify(saved));
assert.equal(run('wkDone(row)'),true);assert(run('wkHtml(row,"test",true)').includes('aria-pressed="true"'));
assert(run('wkTagHtml(row)').includes('スマホ'));assert(run('wkTagHtml(row)').includes('デスク'));assert(run('wkTagHtml(row)').includes('車内'));
edit('p~car~scr~cis','mkt');has(['c_shitami','ai','email_send','email_read']);assert(!data('[row.k].concat(row.kx||[])').includes('mkt'));
edit('f~d','pc');assert.deepEqual(data('wmValues(row,"d")'),['phone']);assert.deepEqual(data('wmValues(row,"ai")'),['codex','claude']);
edit('p~','ai');assert(!data('[row.k].concat(row.kx||[])').includes('ai'));has(['c_shitami','email_send','email_read']);
// Switching root categories is additive; removing a branch preserves unrelated work and all authored fields.
edit('p~','car');has(['email_send','email_read']);assert.equal(data('row.t'),'Keep my exact note');
ctx.row={k:'bizcall',t:'Call and inspection',w:1,wc:['car','proc','c_inspection'],kx:['c_inspection']};
edit('p~car~proc','c_inspection');has(['bizcall']);assert.equal(data('row.t'),'Call and inspection');
edit('p~','car');has(['bizcall']);assert.equal(data('row.w'),1);
// Legacy single-path entries retain their original selection and can grow without migration writes.
ctx.row={k:'c_cust',t:'Original',wc:['car','ppl','c_cust'],hw:'line',s:'23:40',e:'00:20',ai:['claude']};
edit('f~hw','mail');assert.deepEqual(data('wmValues(row,"hw")'),['line','mail']);
edit('p~car~ppl','c_inq');has(['c_cust','c_inq']);assert.equal(data('row.s'),'23:40');
assert.equal(data('row.e'),'00:20');assert.deepEqual(data('row.ai'),['claude']);
// Actual editor lifecycle hooks: restore -> DOM dataset -> read -> save -> continue.
ctx.row=saved;ctx.dest={};run('wmCopy(dest,row)');assert.deepEqual(data('dest.wm'),saved.wm);
ctx.serial=run('wmJson(row)');ctx.restored={};run('wmRead(restored,serial)');assert.deepEqual(data('restored'),data('dest'));
assert(html.includes('wmCopy(a,o);'));assert(html.includes('wmRead(o,r.dataset.wmulti);'));assert(html.includes('data-wmulti="'));
assert(html.includes('wmCopy(o,a);'));assert(html.includes('wmJson(a),(a.kx||[]).join'));assert(html.includes("some(k=>AI_KINDS[k])){const v=Array.isArray(a.ai)"));
ctx.row={t:'<script>&"'};edit('p~','email_send');assert(!run('wkHtml(row,"test",true)').includes('<script>'));
const before=JSON.stringify(ctx.row);edit('p~','unknown');assert.equal(JSON.stringify(ctx.row),before);
ctx.row={bz:'Original, exact name'};ctx.dest={};run("wmBizToggle(row,'Second');wmCopy(dest,row)");assert.deepEqual(data('wmValues(row,"bz")'),['Original, exact name','Second']);assert.deepEqual(data('dest.bzx'),['Second']);run("wmBizToggle(row,'Original, exact name')");assert.deepEqual(data('wmValues(row,"bz")'),['Second']);
console.log('PASS: multiple roots/leaves, devices/places/contact methods, AI metadata, legacy reopen, toggling, unrelated activities, comments/photos/times, lifecycle hooks, escaping.');
