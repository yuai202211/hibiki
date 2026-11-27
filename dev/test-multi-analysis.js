'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const h=fs.readFileSync(require('path').join(__dirname,'../index.html'),'utf8');
const part=(a,b)=>h.slice(h.indexOf(a),h.indexOf(b,h.indexOf(a)));
const kinds=['stay','move','mkt','c_shitami','ai','sleep','nap','mdrec','?'].map(id=>({id,lb:id,muda:false}));
const hmMin=s=>{const [hh,mm]=s.split(':').map(Number);return hh*60+mm;};
const ctx={state:{entries:{}},TRS:[['car','🚗 車'],['walk','🚶 徒歩']],TOOL_BASE:[['pc'],['phone']],ANA_REC:{stay:1},ANA_NOTR:40,ANA_WALK:2,AI_KINDS:{ai:1},KIND_NOMUDA:{},KIND_MUDA_ON:{},MV_V2_TS:0,SLEEP_MAX8:480,
 anaKinds:()=>kinds,kindOf:id=>kinds.find(k=>k.id===id),toolOwnIds:()=>[],hmMin,parseD:d=>new Date(d+'T00:00:00Z'),addDays:(d,n)=>new Date(new Date(d+'T00:00:00Z').getTime()+n*86400000).toISOString().slice(0,10),todayStr:()=>'2026-11-27',
 alarmCfg:()=>({nap:30,meal:'21:00',bed:'01:00',wake:'09:00'}),mvTrip:()=>false,prefOf:()=>null,rlogList:()=>[],mudaAuto:()=>false,sleepSessions:()=>[],sleepDay:()=>null,semeIs:()=>false,aiGuess:()=>[]};
vm.createContext(ctx);vm.runInContext(part('function actsExpand(A){','function rtVHtml('),ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname,'multi-select.js'),'utf8'),ctx);
vm.runInContext(part('function anaCount0(','function anaTr('),ctx);
const run=()=>vm.runInContext("anaCount0({s:'2026-11-20',e:'2026-11-21'},1,1440,1440,1440)",ctx);
const row={k:'mkt',kx:['c_shitami','ai'],d:'pc',dd:['phone'],ai:['codex','claude'],ap:['research'],t:'Synthetic',s:'10:00',e:'11:00'};
ctx.state.entries={'2026-11-20':{test:{k:'stay',s:'10:00',e:'11:00',acts:[row]}}};
let r=run();assert.equal(r.rec,60);for(const k of ['mkt','c_shitami','ai'])assert.equal(r.sum[k],60,k);assert.equal(r.aiUse.codex,60);assert.equal(r.aiUse.claude,60);assert.equal(r.tool.pc,60);assert.equal(r.tool.phone,60);
delete row.s;delete row.e;row.w=1;r=run();assert.equal(r.rec,60);for(const k of ['mkt','c_shitami','ai'])assert.equal(r.sum[k],60);assert.equal(r.tool.pc,60);assert.equal(r.tool.phone,60);
ctx.state.entries['2026-11-20'].test.mv=1;ctx.state.entries['2026-11-20'].test.tr='car';r=run();assert.equal(r.rec,60);assert.equal(r.mv.tot,60);assert.equal(r.mvK.c_shitami,60);
ctx.state.entries['2026-11-20'].test={k:'stay',s:'10:00',e:'11:00',acts:[{k:'mkt',s:'10:00',e:'10:20',d:'pc'},{k:'c_shitami',kx:['ai'],m:20,d:'pc',dd:['phone'],bz:'Synthetic A',bzx:['Synthetic B']}]};
r=run();assert.equal(r.rec,60);assert.equal(r.sum.mkt,20);assert.equal(r.sum.c_shitami,20);assert.equal(r.sum.ai,20);assert.equal(r.tool.pc,40);assert.equal(r.tool.phone,20);assert.equal(r.bzUse['Synthetic A'],20);assert.equal(r.bzUse['Synthetic B'],20);
ctx.state.entries['2026-11-20'].test={k:'stay',s:'23:30',e:'00:30',ed:1,acts:[{k:'mkt',kx:['c_shitami'],s:'23:45',e:'00:15',d:'pc',dd:['phone']}]};
r=run();assert.equal(r.rec,30);assert.equal(r.sum.mkt,15);assert.equal(r.sum.c_shitami,15);assert.equal(r.tool.pc,15);assert.equal(r.tool.phone,15);
console.log('PASS: each selected category/device/AI retained in analysis; elapsed and travel totals count each minute once.');
