'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const h=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={document:{addEventListener(){}},esc,durText:m=>m+'分',durMin:(s,e,d)=>{const n=t=>+t.slice(0,2)*60+ +t.slice(3);return n(e)-n(s)+1440*d;},actMdOn:x=>!!x.md,actShareMin:()=>30,
 actsSort:a=>a.slice().sort((a,b)=>(a.s||'').localeCompare(b.s||'')),actsBase:()=>'',actRowOk:()=>true,kindOf:id=>({ic:'📖',lb:id,co:'#123456'}),toolOf:id=>({ic:'💻',lb:id}),actSwHtml:()=>'<span class="a-sw">settings</span>',hitoHtml:esc,txtHtml:esc,AI_KINDS:{ai:1},aiTool:id=>({co:'#123456',lb:id}),aipOf:id=>({ic:'🔎',lb:id}),MP0:[],wmValues:(x,k)=>[x[k]],wkTagHtml:()=>'<span class="a-ap"><i>PC</i></span>',phUrl:id=>'photo/'+id};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'diary-layout.js'),'utf8'),ctx);
vm.runInContext(h.slice(h.indexOf('function actsHtml(en){'),h.indexOf("let topView='diary';")),ctx);
const time=(en,x)=>ctx.dlTimeHtml(en,x);
assert.match(time({s:'09:00',e:'17:00'},{s:'10:15',e:'10:45',m:999}),/10:15 → 10:45/);
assert.match(time({},{s:'10:15',e:'10:45',m:999}),/30分/);
assert.match(time({s:'23:00',e:'01:00',ed:1},{w:1}),/23:00 → 翌日 01:00/);
assert.match(time({s:'09:00',e:'17:00'},{w:1}),/この記録の間ずっと/);
assert.match(time({s:'09:00',e:'17:00'},{w:1,m:30}),/時刻未記入/);
assert.match(time({s:'09:00',e:'17:00'},{sk:1,w:1}),/時刻未記入/);
assert.match(time({s:'09:00',e:'17:00'},{sk:1,w:1}),/合間に行ったこと/);
assert.match(time({},{s:'23:50',e:'00:20'}),/翌日 00:20/);
assert.match(time({s:'23:00',e:'02:00',ed:1},{s:'00:10',e:'00:40'}),/翌日 00:10 → 翌日 00:40/);
assert.match(time({s:'23:00',e:'02:00',ed:1},{s:'00:10',e:'00:40'}),/30分/);
assert.match(ctx.dlDevices({d:'pc'}),/pc/);
assert.match(time({},{s:'10:00'}),/終了未記入/);
assert.match(time({},{e:'10:00'}),/開始未記入/);
assert.match(time({noT:1,s:'09:00',e:'17:00'},{w:1}),/時刻未記入/);
const en={s:'09:00',e:'12:00',acts:[{k:'ai',kx:['read'],t:'Long <script> text.\n'.repeat(12),c:'Comment preserved',s:'10:00',e:'11:00',m:60,ai:['Codex'],ap:['research'],ph:['synthetic']},{k:'read',t:'read',sk:1}]};
const before=JSON.stringify(en),out=ctx.actsHtml(en);
assert.equal(JSON.stringify(en),before);assert(out.includes('10:00 → 11:00'));assert(out.includes('📖 ai'));assert(out.includes('📖 read'));assert(out.includes('Codex'));assert(out.includes('research'));assert(out.includes('photo/synthetic'));assert(out.includes('Comment preserved'));assert(out.includes('&lt;script&gt;'));assert(!out.includes('<script>'));assert(out.includes('本文をすべて見る'));assert(out.includes('分類・使ったものを見る'));
for(const mv of [false,true]){assert(ctx.actsHtml({...en,mv}).includes('dl-clock'));}
// A setting changes its markup on every click; the panel must stay open after render.
const setting={k:'test',md:1},record={s:'10:00',p:'Synthetic',acts:[setting]};
const panel=ctx.dlSettings('before',setting,record),key=panel.match(/data-dl-toggle="([^"]+)"/)[1];
ctx.panelKey=key;vm.runInContext('DL_OPEN.add(panelKey)',ctx);setting.mdm=5;
assert(ctx.dlSettings('after',setting,record).includes('is-open'));
assert(h.includes('class="dl-favorites"'));assert(h.includes('カテゴリーから選ぶ'));
console.log('PASS: explicit/full-span/partial/unknown/overnight times; saved duration fallback; gap distinction; all selections/photos/comments retained; escaping; stay/travel share renderer; no data mutation; separate button tiers.');
