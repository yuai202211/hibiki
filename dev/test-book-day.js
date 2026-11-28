'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
let now=new Date('2026-11-28T16:00:00');
class Clock extends Date{constructor(...a){super(...(a.length?a:[now.getTime()]));}static now(){return now.getTime();}}
const fmt=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
const addDays=(d,n)=>{const x=new Date(d+'T12:00:00');x.setDate(x.getDate()+n);return fmt(x);};
const ctx={Date:Clock,addDays,todayStr:()=>fmt(now),durMin:(s,e,ed=0)=>{const n=t=>+t.slice(0,2)*60+ +t.slice(3);return n(e)-n(s)+1440*ed;},state:{entries:{},rlog:{},prep:{}}};
ctx.brWrite=f=>{f();ctx.state.updatedAt=Clock.now();};vm.createContext(ctx);
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),src=fs.readFileSync(path.join(__dirname,'book-reading.js'),'utf8');
vm.runInContext(html.slice(html.indexOf('function sleepSessions(){'),html.indexOf('const SLEEP_MAX8=')),ctx);
vm.runInContext(src.slice(0,src.indexOf('function brSlots(')),ctx);
const run=s=>vm.runInContext(s,ctx),day=()=>run('brDay()');
const reset=()=>{ctx.state={entries:{},rlog:{},prep:{}};run('BR_DAY_CACHE=null');};
// A location-only overnight stay is not invented sleep; explicit first-action progress advances the day.
ctx.state.entries={'2026-11-28':{stay:{p:'Synthetic place',s:'02:00',e:'09:00'}}};
assert.equal(day(),'2026-11-27');ctx.state.prep={'2026-11-28':{fp:1,dd:[1],dos:['Synthetic first task']}};
const before=JSON.stringify(ctx.state);assert.equal(day(),'2026-11-28');assert.equal(JSON.stringify(ctx.state),before);
reset();ctx.state.prep={'2026-11-28':{fp:1,fpStart:new Date('2026-11-28T09:00:00').getTime()}};assert.equal(day(),'2026-11-28');
reset();ctx.state.prep={'2026-11-28':{fp:1,to:'A plan only',dd:[0]}};assert.equal(day(),'2026-11-27');
reset();ctx.state.prep={'2026-11-29':{fp:1,dd:[1]}};assert.equal(day(),'2026-11-27');
for(const entry of [
 {s:'01:00',e:'08:00',k:'sleep'},
 {s:'01:00',e:'08:00',acts:[{k:'read',kx:['sleep'],s:'02:00',e:'07:00'}]},
 {s:'01:00',e:'',acts:[{k:'sleep',s:'02:00',e:'07:00'}]},
 {s:'01:00',e:'08:00',acts:[{k:'sleep',w:1}]}
]){reset();ctx.state.entries={'2026-11-28':{x:entry}};assert.equal(day(),'2026-11-28');}
reset();ctx.state.entries={'2026-11-27':{x:{s:'23:00',e:'',acts:[{k:'read',kx:['sleep'],s:'00:30',e:'07:00'}]}}};assert.equal(day(),'2026-11-28');
for(const entry of [{k:'sleep',s:'23:00',e:''},{k:'sleep',s:'23:00',e:'08:00',ed:1,del:1},{s:'22:00',e:'',acts:[{k:'sleep',s:'23:00',e:''}]}]){reset();ctx.state.entries={'2026-11-27':{x:entry}};assert.equal(day(),'2026-11-27');}
reset();ctx.state.entries={'2026-11-28':{x:{k:'sleep',s:'23:00',e:'08:00',ed:1}}};assert.equal(day(),'2026-11-27');
// Keep late bedtime in the preceding day, even after 05:00. Explicit waking is synced separately.
reset();now=new Date('2026-11-29T06:00:00');ctx.state.rlog={old:{br:1,brDay:'2026-11-28',brDone:1,brNote:'Keep this note'}};
assert.equal(day(),'2026-11-28');const saved=JSON.stringify(ctx.state.rlog);assert.equal(run("brBeginDay('2026-11-29')"),true);assert.equal(day(),'2026-11-29');assert.equal(JSON.stringify(ctx.state.rlog),saved);assert.equal(run("brBeginDay('2026-11-29')"),false);
ctx.state=JSON.parse(JSON.stringify(ctx.state));run('BR_DAY_CACHE=null');assert.equal(day(),'2026-11-29');assert.equal(run("brBeginDay('2026-11-30')"),false);
console.log('PASS: location-only stay + completed/started first task; no inferred sleep; real sleep extractor; secondary sleep selection; closed sleep in open stay; overnight offsets; unfinished/deleted/future exclusions; late bedtime preserved; explicit next day and reload preserve all notes.');
