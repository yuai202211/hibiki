'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'todo-flow.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const timers=new Map(),store=new Map();let n=0,writes=0,scheduled=0;
const ctx={state:{todos:{},memos:{}},Date,Math,localSaveFail:false,todayStr:()=> '2026-11-28',CL:{uid:'test'},
 localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},mutate:fn=>{writes++;fn();},
 setTimeout:fn=>{timers.set(++n,fn);scheduled++;return n;},clearTimeout:id=>timers.delete(id),$:()=>null,toast:()=>{}};
vm.createContext(ctx);vm.runInContext(src,ctx);const run=s=>vm.runInContext(s,ctx);
run("TF.composing=true;tfInput('・にほんご')");assert.equal(writes,0);assert.equal(scheduled,0);assert.equal(run('tfApply()'),false);assert.equal(run('tfSaveDraft()'),false);assert(store.size);
run("TF.composing=false;tfInput('・日本語の大タイトル\n長い内容'.repeat(300))".replace(/\n/g,'\\n'));assert.equal(scheduled,1);assert.equal(timers.size,1);[...timers.values()][0]();assert.equal(writes,1);assert.equal(run('TF.draft.dirty'),false);
const before=run('TF.draft.text');run('TF.draft=null;tfLoad()');assert.equal(run('TF.draft.text'),before);
// The shipped guard prevents a direct background renderer from replacing focused/IME fields.
ctx.document={activeElement:{closest:()=>true}};assert.equal(run('tfRender()'),undefined);run('TF.composing=true');assert.equal(run('tfRender(true)'),undefined);run('TF.composing=false');
let scroll=0;const sc={get scrollTop(){return scroll;},set scrollTop(v){scroll=v;},getBoundingClientRect:()=>({top:50,bottom:500})};
const field={tagName:'TEXTAREA',isConnected:true,style:{},closest:()=>sc,getBoundingClientRect:()=>({top:300-scroll,bottom:540-scroll})};
ctx.document.activeElement=field;ctx.window={visualViewport:{offsetTop:0,height:500},innerHeight:800};ctx.field=field;
run('tfKeepVisible(field)');assert.equal(scroll,48);for(let i=0;i<20;i++)run('tfKeepVisible(field)');assert.equal(scroll,48,'repeated input/selection events must not oscillate');assert.equal(field.style.maxHeight,'426px');
ctx.window.visualViewport.height=380;run('tfKeepVisible(field)');const shortened=scroll;assert(shortened>48);for(let i=0;i<20;i++)run('tfKeepVisible(field)');assert.equal(scroll,shortened,'keyboard viewport stabilizes');
run('TF.composing=true');ctx.window.visualViewport.height=300;run('tfKeepVisible(field)');assert.equal(scroll,shortened,'IME composition never triggers outer scrolling');
assert(html.includes("ta.closest('.tf-root')"));assert(html.includes("host.querySelector('.tf-root')"));assert(html.includes('return tfKeepVisible(el)'));assert(html.includes("#sheet2,#page .tf-root"));
console.log('PASS: IME defers save/parse/apply/render, long draft persists intact, direct background renders preserve editor, viewport corrections settle without oscillation, legacy DOM reparent/spacer excluded and update reload guarded.');
