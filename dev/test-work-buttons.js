'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert(start>=0&&end>start);return html.slice(start,end);}
const ctx={state:{kinds:{},_cfg:{wkLb:{cis:'業者用画面'}}},grpOk:()=>true,kSg:()=>'',localStorage:{getItem:()=>null,setItem(){}},esc:s=>String(s),AI_TOOLS:[],aipList:()=>[]};
vm.createContext(ctx);
vm.runInContext(section('const KIND_BASE=','function coLb()')+section('function kindOf(','function acPlCands(')+section('var WK_SITE=','var WK_SCT1='),ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'multi-select.js'),'utf8'),ctx);
const run=s=>vm.runInContext(s,ctx);
run('function kindList(){return KIND_BASE.map(b=>kindOf(b[0]));}');
const roots=run('wkOpts(WK_ROOT)');for(const [id,label] of [['email_send','📧 メール作成・送信'],['email_read','📥 受信メール確認']])assert.equal(roots.find(x=>x[0]===id)[1],label);
assert.equal(run("wkOpts(WK_ROOT.nx('car').nx('scr').nx('cis')).find(x=>x[0]==='c_shitami')[1]"),'🔍 下見検索');
assert.equal(run("wkOpts(WK_ROOT.nx('car').nx('proc')).find(x=>x[0]==='c_inspection')[1]"),'🚘 車検');
assert.equal(run("wkQ(WK_ROOT.nx('car').nx('scr').nx('cis'))"),'業者用画面のどれ？');
for(const [id,steps,label] of [
 ['email_send',['email_send','pc','desk'],'メール作成・送信'],
 ['email_read',['email_read','phone','move'],'受信メール確認'],
 ['c_shitami',['car','scr','cis','c_shitami','pc','desk'],'下見検索'],
 ['c_inspection',['car','proc','c_inspection'],'車検']
]){
 ctx.row={};steps.forEach((v,i)=>{ctx.choice=v;run('wkApply(row,wkChain(row).length-1,choice,"test")');});
 assert.equal(ctx.row.k,id);assert.equal(ctx.row.t,label);assert.equal(run('wkDone(row)'),true);
 ctx.row=JSON.parse(JSON.stringify(ctx.row));assert.equal(run('wkKind(row.wc)'),id);assert.equal(run('wkDone(row)'),true);
 assert(run('wkHtml(row,"test",true)').includes(label));
 assert.equal(run('kindOf(row.k).muda'),false);
}
ctx.row={};run("wkApply(row,0,'email_send','test');wkApply(row,1,'pc','test');wkApply(row,2,'desk','test');row.t='Preserve authored comment';wkApply(row,0,'email_read','test')");
assert.equal(ctx.row.k,'email_send');assert(ctx.row.kx.includes('email_read'));assert.equal(ctx.row.t,'Preserve authored comment');assert.equal(ctx.row.d,'pc');assert.equal(ctx.row.ws,'desk');
run("wkApply(row,0,'email_read','test')");assert.equal(ctx.row.k,'email_send');
assert.equal(run("wkApply(row,0,'email_send','test')"),'del');assert.equal(ctx.row.k,'');
assert.equal(run("wkKind(['car','scr','cis','mkt'])"),'mkt');assert.equal(run("wkKind(['tel','bizcall'])"),'bizcall');assert.equal(run("wkKind(['ai'])"),'ai');
assert.equal(run("WK_HW.o().find(x=>x[0]==='mail')[1]"),'✉️ メール・掲載サイト');
assert.equal(run("kindOf('c_shaken').lb"),'車検証コピー依頼');
assert.equal(run("kindOf('c_inspection').g"),'V');
console.log('PASS: independent send/read work types, auction preview search, vehicle inspection, device/place selection, save/reopen serialization, category switching, deselection, comments and existing work flows.');

assert.equal(run("kindOf('dreambook').lb"),'夢手帳タイム');
assert.equal(run("kindOf('dreambook').g"),'S');
assert.equal(run("kindOf('dreambook').muda"),false);

// The important activity is pinned first even without usage history; user pins stay intact.
vm.runInContext(section('function qFixIds(){','const KUSEN='),ctx);
ctx.state._cfg.qfix=['read','dreambook','read'];
assert.deepEqual(Array.from(run('qFixIds()')),['dreambook','read']);
ctx.KSEC=[];ctx.WK_SITE=false;ctx.QTOP_N=8;ctx.QMORE=false;ctx.todayStr=()=> '2026-11-28';ctx.qTopStart=()=> '2026-11-01';ctx.parseD=d=>new Date(d+'T00:00:00');ctx.kUseDays=()=>({});
ctx.mk=id=>'<button class="chip" data-kind="'+id+'">'+run('kindOf("'+id+'").lb')+'</button>';
const pinHtml=run("qTopHtml([], 'data-kind', mk, [], [], [])");
assert(pinHtml.includes('夢手帳タイム'));assert(pinHtml.indexOf('夢手帳タイム')<pinHtml.indexOf('読書'));assert.equal((pinHtml.match(/data-kind="dreambook"/g)||[]).length,1);assert.deepEqual(ctx.state._cfg.qfix,['read','dreambook','read']);
console.log('PASS: dream notebook activity pinned first, no history required, no duplicate, existing pin configuration unchanged.');
