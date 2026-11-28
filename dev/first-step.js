/* The four-field diary preparation uses the existing per-day prep collection. */
var FP_DRAFTS={},FP_EDIT='',FP_SIG='',FP_FOCUS=null,FP_SCROLL='',FP_EDIT_PART='';
var FP_VIEW_TIMER=0;
function fpInputViewport(){const app=$('app'),a=document.activeElement;if(!app)return;
const active=!!(a&&a.matches&&a.matches('#fpForm input,#fpForm textarea')&&window.innerWidth<500);
app.classList.toggle('fp-typing',active);if(!active)return;
const sc=$('scr');if(!sc)return;const vv=window.visualViewport,r=a.getBoundingClientRect(),sr=sc.getBoundingClientRect();
const top=Math.max(vv?vv.offsetTop:0,sr.top)+12,bottom=Math.min(vv?vv.offsetTop+vv.height:window.innerHeight,sr.bottom)-12;
const field=a.closest('.fp-field'),label=field&&field.querySelector('label'),lr=label&&label.getBoundingClientRect();
const start=lr&&r.bottom-lr.top<bottom-top?lr.top:r.top;
if(r.bottom>bottom)sc.scrollTop+=Math.ceil(r.bottom-bottom);else if(start<top)sc.scrollTop-=Math.ceil(top-start);
}
function fpInputViewportSoon(){if(!$('app'))return;clearTimeout(FP_VIEW_TIMER);FP_VIEW_TIMER=setTimeout(fpInputViewport,30);}
document.addEventListener('focusin',fpInputViewportSoon);
document.addEventListener('focusout',fpInputViewportSoon);
if(typeof window!=='undefined'){window.addEventListener('resize',fpInputViewportSoon);if(window.visualViewport){window.visualViewport.addEventListener('resize',fpInputViewportSoon);window.visualViewport.addEventListener('scroll',fpInputViewportSoon);}}
function fpDay(){const t=todayStr();return new Date().getHours()>=22?addDays(t,1):t;}
function fpRecord(d){const p=(state.prep||{})[d];return p&&!p.del?p:null;}
function fpComplete(p){return !!(p&&!p.del&&!p.skip&&!p.quit&&String(p.to||'').trim()&&String(p.tr||'').trim()&&/^([01]\d|2[0-3]):[0-5]\d$/.test(p.dep||'')&&prepDos(p)[0]);}
function fpKey(d){return 'hibiki-first-step-draft|'+(typeof CL!=='undefined'&&CL.uid?CL.uid:'local')+'|'+d;}
function fpTextFit(){['fpHeading','fpTask'].forEach(id=>{const el=$(id);if(el&&el.tagName==='TEXTAREA'){el.style.height='auto';el.style.height=(el.scrollHeight+2)+'px';}});}
function fpDraft(d){const k=fpKey(d),p=fpRecord(d)||{};if(FP_DRAFTS[k]){const x=FP_DRAFTS[k];if(!x.headingDirty)x.heading=String(p.fpHeading||'');return x;}
let x=null;try{x=JSON.parse(localStorage.getItem(k)||'null');}catch(e){}
if(!x||x.d!==d||!x.dirty||['to','tr','dep','task'].some(f=>typeof x[f]!=='string'))x={d,to:p.to||'',tr:p.tr||'',dep:p.dep||'',task:prepDos(p)[0]||'',tid:(p.dsi||[])[0]||'',dirty:false};
if(!x.headingDirty)x.heading=String(p.fpHeading||'');FP_DRAFTS[k]=x;return x;}
function fpRemember(x){FP_DRAFTS[fpKey(x.d)]=x;try{localStorage.setItem(fpKey(x.d),JSON.stringify(x));}catch(e){}}
function fpForget(d){delete FP_DRAFTS[fpKey(d)];try{localStorage.removeItem(fpKey(d));}catch(e){}}
function fpDate(){return FP_EDIT||fpDay();}
function fpTitle(d){return d===todayStr()?'今日':d===addDays(todayStr(),1)?'明日':prepDateText(d);}
function fpCurrent(){return topView==='diary'&&ui.tab==='di'&&ui.date===todayStr();}
function fpBusy(){return !!document.querySelector('.ovl.open')||!!(document.activeElement&&document.activeElement.matches('input,textarea,select,[contenteditable="true"]'));}
function fpCardHtml(){if(!fpCurrent())return '';const d=fpDate(),p=fpRecord(d),dr=fpDraft(d),edit=FP_EDIT===d||!fpComplete(p)||dr.dirty,lab=fpTitle(d),h=new Date().getHours(),late=d===todayStr()||h>=23;
if(p&&(p.dd||[])[0]&&!edit)return '';
const hd='<div class="fp-head"><span>🌅 '+esc(lab)+'、はじめにやる事'+(edit?'':' ✓')+'</span>'+(!edit?'<button type="button" class="fp-edit-top" data-fp="edit" aria-label="確定した準備を編集する">✎ 編集</button>':'<small>'+(fpComplete(p)?'編集中':d>todayStr()?'夜のうちに準備':'小さな一歩を選ぼう')+'</small>')+'</div><div class="fp-welcome"><h2>日々の習慣が<br>未来をつくる！</h2><p>小さく始めて、気持ちよく進もう。</p></div>';
if(!edit){const done=!!(p.dd||[])[0],started=!!p.fpStart,now=d===todayStr(),mv=now&&openMove(),arr=now&&!!fpLinked(p),tr=TRS.find(x=>x[0]===p.tr),mode=tr?tr[1]:p.tr;
return '<section class="fp-card" id="fpCard" data-date="'+esc(d)+'">'+hd+'<div class="fp-first"><span class="fp-eyebrow">'+esc(lab)+'のテーマ</span>'+(p.fpHeading?'<h3 class="fp-theme">'+esc(p.fpHeading)+'</h3>':'')+'<div class="fp-action"><span>最初の一歩</span><p>'+esc(prepDos(p)[0])+'</p></div>'+(done?'<div class="fp-done">✓ 最初の1つ、終わった！ いいスタート！</div>':now?'<small>'+(started?'いいね。その一歩が、今日を動かしている。':'準備はできている。まずは、この一歩から。')+'</small><button type="button" class="savebtn" data-fp="'+(started?'finish':'start')+'">'+(started?'終わった！':'これを始める')+'</button>':'<small>朝の自分に、楽しみをひとつ。</small>')+'</div><div class="fp-summary" id="fpRouteSummary"><span class="fp-eyebrow">'+esc(lab)+'の行き先</span><b>📍 '+esc(p.to)+'</b><span>'+esc(p.dep)+' 出発　'+esc(mode)+'</span></div>'+fpLinkedHtml(p)+'<button type="button" class="fp-route-edit" data-fp="route">✎ 場所・時間を変更</button>'+(now?'<button type="button" class="fp-move" data-fp="'+(mv?'arrive':arr?'next':'go')+'">'+(mv?'🏁 到着した':arr?'🚗 次の移動を記録する':esc(mode)+'で出発する')+'</button>':'')+'</section>';}
const opts=prepTodos(d).slice(0,20),first=dr.task,route=FP_EDIT_PART==='route';
return '<section class="fp-card" id="fpCard" data-date="'+esc(d)+'">'+hd+'<p class="fp-intro">行き先と、最初の一歩。朝の自分に用意しておこう。</p><form id="fpForm" novalidate>'+
'<div class="fp-field"><label for="fpTo">① '+esc(lab)+'は、どこへ行く？</label><input type="text" id="fpTo" value="'+esc(dr.to)+'" placeholder="例：駅名やエリア名" autocomplete="off"><small>ざっくりした場所でOK。住所やお店の名前は不要です。</small></div>'+
'<fieldset class="fp-field"><legend>② どうやって行く？</legend><div class="sh-chips" id="fpTr">'+TRS.map(x=>'<button type="button" class="chip'+(dr.tr===x[0]?' sel':'')+'" data-fptr="'+esc(x[0])+'" aria-pressed="'+(dr.tr===x[0]?'true':'false')+'">'+esc(x[1])+'</button>').join('')+'</div></fieldset>'+
'<div class="fp-field"><label for="fpDep">③ 何時に出発する？</label><input type="time" id="fpDep" value="'+esc(dr.dep)+'"></div>'+
'<div class="fp-task-field"'+(route?' style="display:none"':'')+'><div class="fp-eyebrow">④ 最初にやる事</div><div class="fp-field fp-heading-field"><label for="fpHeading">大タイトル</label><textarea id="fpHeading" rows="1" placeholder="例：ノート・手帳の整理">'+esc(dr.heading||'')+'</textarea><button type="button" class="fp-heading-save" id="fpHeadingSave">タイトルだけ保存</button></div><div class="fp-field fp-detail-field"><label for="fpTask">やる事の詳細（1行）</label><textarea id="fpTask" rows="1" placeholder="例：メールを1件返す" aria-describedby="fpTaskHelp">'+esc(first)+'</textarea><small id="fpTaskHelp">すぐに取りかかれて、短い時間で終わるものを1つだけ決めてください。</small></div>'+(opts.length?'<details><summary>やる事から大タイトルを選ぶ</summary><small>詳細の1行はそのまま残ります。</small><div class="fp-options">'+opts.map(x=>'<button type="button" class="chip" data-fptodo="'+esc(x.id)+'">'+esc(x.t)+'</button>').join('')+'</div></details>':'')+'</div>'+
'<p class="fp-error" id="fpError" role="alert"></p><button type="submit" class="savebtn">'+(route?'場所・時間の変更を保存':fpComplete(p)?'変更を保存':'これで'+esc(lab)+'の準備を確定する')+'</button></form></section>';}
function fpCapture(){const card=$('fpCard'),form=$('fpForm');if(!card||!form)return;const d=card.dataset.date,x=fpDraft(d);x.to=$('fpTo').value;x.dep=$('fpDep').value;x.task=$('fpTask').value;if(x.headingDirty&&$('fpHeading'))x.heading=$('fpHeading').value;if(x.dirty)fpRemember(x);}
function fpReadInput(d){const x=fpDraft(d);x.to=$('fpTo').value;x.dep=$('fpDep').value;const task=$('fpTask').value;if(task!==x.task)x.tid='';x.task=task;const h=$('fpHeading');if(h&&h.value!==x.heading){x.heading=h.value;x.headingDirty=true;}x.dirty=true;FP_EDIT=d;fpRemember(x);fpTextFit();fpInputViewportSoon();}
function fpSaveHeading(d,heading){heading=String(heading||'').trim();const x=fpDraft(d);x.heading=heading;x.headingDirty=false;fpRemember(x);mutate(()=>{state.prep=state.prep||{};state.prep[d]=Object.assign({},state.prep[d]||{},{fpHeading:heading,ts:Date.now()});});toast('✓ 大タイトルを保存した');}
function fpSaveRoute(d){const x=fpDraft(d),to=x.to.trim(),prior=fpRecord(d);if(!prior)return false;
if(!to||!x.tr||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.dep)){const e=$('fpError');if(e)e.textContent='行き先・移動手段・出発時刻を入れてください。';return false;}
const patch={to,tr:x.tr,dep:x.dep,ts:Date.now()};if(prior.to!==to){patch.fpLink=null;patch.fpAsked='';}
FP_EDIT='';FP_EDIT_PART='';fpForget(d);FP_SCROLL='fpRouteSummary';
mutate(()=>{state.prep[d]=Object.assign({},prior,patch);});toast('✓ 場所・時間を変更した');return true;}
function fpSave(d){const x=fpDraft(d),to=x.to.trim(),task=x.task.trim(),miss=[];if(!to)miss.push('行き先');if(!x.tr)miss.push('移動手段');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.dep))miss.push('出発時刻');if(!task)miss.push('最初にやる事（軽いものを1つだけ）');
if(miss.length){const e=$('fpError');if(e)e.textContent=miss.join('・')+'を決めてください。';return false;}
const prior=fpRecord(d)||{},same=prepDos(prior)[0]===task,ds=prepDos(prior),si=Array.isArray(prior.dsi)?prior.dsi.slice():[],dd=Array.isArray(prior.dd)?prior.dd.slice():[];
ds[0]=task;si[0]=x.tid||(same?si[0]||'':'');dd[0]=same?(dd[0]||0):0;
const patch={fp:1,fpHeading:String(x.heading||'').trim(),to,tr:x.tr,dep:x.dep,do:task,dos:ds,dsi:si,dd,home:0,skip:0,quit:0,del:0,cross:0,done:dd.length&&dd.every(Boolean)?1:0,fpConfirmed:Date.now(),ts:Date.now()};
if(!same)patch.fpStart=0;
if(!same||prior.to!==to){patch.fpLink=null;patch.fpAsked='';}
FP_EDIT='';fpForget(d);FP_SCROLL='fpCard';
mutate(()=>{state.prep=state.prep||{};state.prep[d]=Object.assign({},prior,patch);});
toast('✓ '+fpTitle(d)+'の準備を確定した');try{ntfKick();}catch(e){}return true;}
function fpBind(pane){const card=pane.querySelector('#fpCard');if(!card)return;const d=card.dataset.date;
const form=card.querySelector('#fpForm');if(form){form.oninput=()=>fpReadInput(d);form.onchange=()=>fpReadInput(d);form.onsubmit=e=>{e.preventDefault();fpReadInput(d);if(FP_EDIT_PART==='route')fpSaveRoute(d);else fpSave(d);};}
const headingSave=card.querySelector('#fpHeadingSave');if(headingSave)headingSave.onclick=()=>fpSaveHeading(d,$('fpHeading').value);
card.querySelectorAll('[data-fptr]').forEach(b=>b.onclick=()=>{fpReadInput(d);const x=fpDraft(d);x.tr=x.tr===b.dataset.fptr?'':b.dataset.fptr;fpRemember(x);card.querySelectorAll('[data-fptr]').forEach(c=>{const on=c.dataset.fptr===x.tr;c.classList.toggle('sel',on);c.setAttribute('aria-pressed',String(on));});});
card.querySelectorAll('[data-fptodo]').forEach(b=>b.onclick=()=>{const todo=(state.todos||{})[b.dataset.fptodo];if(!todo||todo.del)return;fpReadInput(d);const x=fpDraft(d);x.heading=todo.t;x.headingDirty=true;fpRemember(x);$('fpHeading').value=x.heading;fpTextFit();});
card.querySelectorAll('[data-fp]').forEach(b=>b.onclick=()=>{const a=b.dataset.fp;if(a==='edit'||a==='route'){FP_EDIT=d;FP_EDIT_PART=a==='route'?'route':'';fpForget(d);FP_SCROLL=a==='route'?'fpTo':'fpHeading';render();return;}if(d!==todayStr())return;const p=fpRecord(d);if(!p)return;
if(a==='start'){mutate(()=>{state.prep[d]=Object.assign({},state.prep[d],{fpStart:Date.now(),ts:Date.now()});});}
else if(a==='finish'){prepDoSet(0,1);const id=prepTdId(p,0);if(id&&(state.todos||{})[id]&&!tdDone(state.todos[id]))tdComplete(id,true);toast('✓ 最初の1つ、終わった！');}
else if(a==='go'){quickMoveStart(p.tr);}
else if(a==='arrive'){if(openMove())mvpArrAsk();}
else if(a==='next'){quickMoveStart();}
else if(a==='record'){const r=fpLinked(p);if(r)openEntrySheet(r.d,{key:r.k});}
else if(a==='unlink'){mutate(()=>{state.prep[d]=Object.assign({},state.prep[d],{fpLink:null,ts:Date.now()});});toast('紐づけを取り消した。次の記録でまた確認する');}
});}
function fpBeforeRender(){fpCapture();const a=document.activeElement;FP_FOCUS=a&&a.closest&&a.closest('#fpForm')?{id:a.id,start:a.selectionStart,end:a.selectionEnd}:null;}
function fpAfterRender(){const f=FP_FOCUS;FP_FOCUS=null;if(f&&$(f.id)){try{$(f.id).focus({preventScroll:true});if(f.start!==null)$(f.id).setSelectionRange(f.start,f.end);}catch(e){}}
fpTextFit();fpInputViewportSoon();
if(FP_SCROLL){const el=$(FP_SCROLL),sc=$('scr');FP_SCROLL='';if(el&&sc){const target=el.closest('.fp-field')||el;sc.scrollTop+=target.getBoundingClientRect().top-sc.getBoundingClientRect().top-16;}}
const card=$('fpCard');if(!card)return;const d=card.dataset.date,missing=!fpComplete(fpRecord(d)),sig=d+'|'+(new Date().getHours()>=23?'late':'open')+'|'+missing;
if(missing&&FP_SIG!==sig&&!fpBusy()){const pane=$('pane');if(pane)pane.scrollTop=0;ui._jump=null;}FP_SIG=sig;}
function fpTick(){const d=fpDay(),h=new Date().getHours(),sig=d+'|'+(h>=23?'late':'open')+'|'+!fpComplete(fpRecord(d));if(sig===FP_SIG||fpBusy())return;
if(fpCurrent()){if(FP_EDIT&&fpDraft(FP_EDIT).dirty)return;render();}else if(h>=22&&!fpComplete(fpRecord(d))){FP_SIG=sig;toast(h>=23?'明日の一歩を、朝の自分に用意しよう。':'日記で、明日が楽しみになる準備をしよう。');}}
function fpOpen(d){fpCapture();FP_EDIT_PART='';FP_EDIT=d||fpDay();topView='diary';ui.tab='di';ui.date=todayStr();ui._jump=null;render();const pane=$('pane');if(pane)pane.scrollTop=0;}
var fpRenderBase=render;
render=function(){fpBeforeRender();const result=fpRenderBase.apply(this,arguments);fpAfterRender();return result;};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)fpTick();});

/* Link only after an explicit answer. Never copy the planned place into entries. */
var FP_PENDING=null,FP_ASK_TIMER=0;
function fpLinked(p){const r=p&&p.fpLink,e=r&&((state.entries||{})[r.d]||{})[r.k];return e&&!e.del?{d:r.d,k:r.k,en:e}:null;}
function fpEntryLabel(e){return (e.mv?String(e.rt||'').trim():String(e.p||'').trim())||(e.mv?'移動の記録':'日記の記録');}
function fpLinkedHtml(p){const r=fpLinked(p);if(!r)return '';return '<div class="fp-linked"><strong>✓ 実際の記録と紐づけ済み</strong><span>'+esc(r.en.s||'')+' '+esc(fpEntryLabel(r.en))+'</span><button type="button" class="fp-edit" data-fp="record">この記録を見る</button><button type="button" class="fp-edit" data-fp="unlink">紐づけを取り消す</button></div>';}
function fpCanAsk(p){return fpComplete(p)&&!fpLinked(p)&&!(p.dd||[])[0];}
function fpEntrySig(e){if(!e||e.del||e.noT||e.k==='sleep'||(!e.mv&&!e.p))return '';return JSON.stringify([e.mv||0,e.p||'',e.rt||'',e.tr||'',e.s||'',e.mv?e.e||'':'',e.t||'',e.k||'',e.acts||[]]);}
function fpEntrySnapshot(){const out={};const t=todayStr();for(const d of [t,addDays(t,-1)]){const eo=(state.entries||{})[d]||{};for(const k in eo){const e=eo[k];if(d!==t&&!(e&&e.mv&&!e.e))continue;out[d+'|'+k]=fpEntrySig(e);}}return out;}
function fpFindChanged(before){const t=todayStr(),eo=state.entries||{},out=[];for(const d of [t,addDays(t,-1)])for(const k in eo[d]||{}){const e=eo[d][k],id=d+'|'+k,sig=fpEntrySig(e);if(!sig||sig===before[id]||e.gapfix)continue;if(d!==t&&!before[id])continue;const fresh=!Object.prototype.hasOwnProperty.call(before,id);out.push({d,k,sig,score:(fresh?4:0)+(!e.mv?2:0),ts:Number(e.ts)||0});}out.sort((a,b)=>b.score-a.score||b.ts-a.ts);return out[0]||null;}
function fpScheduleAsk(){clearTimeout(FP_ASK_TIMER);FP_ASK_TIMER=setTimeout(fpAskRecord,650);}
function fpAskRecord(){const c=FP_PENDING,t=todayStr(),p=fpRecord(t);if(!c||!fpCanAsk(p)){FP_PENDING=null;return;}const e=((state.entries||{})[c.d]||{})[c.k];if(!fpEntrySig(e)){FP_PENDING=null;return;}const sig=c.d+'|'+c.k+'|'+fpEntrySig(e);if(p.fpAsked===sig){FP_PENDING=null;return;}
if(document.hidden||fpBusy()){fpScheduleAsk();return;}
FP_PENDING=null;const confirmed=p.fpConfirmed||0;
openSub('<div class="sh-time"><span>🌅 今日、はじめにやる事</span></div><div class="sh-note" style="text-align:left"><b>今回の移動・滞在は、決めていた「今日、はじめにやる事」のためですか？</b><p>📍 '+esc(p.to)+'<br>やる事：'+esc(prepDos(p)[0])+'</p><p>今回の記録：<br>'+esc(e.s||'')+' '+esc(fpEntryLabel(e))+'</p><small>「はい」でこの記録と紐づけます。作業の完了は別に記録します。</small></div><div class="sh-btns"><button type="button" class="delbtn" id="fpLinkNo" style="flex:1">いいえ</button><button type="button" class="savebtn" id="fpLinkYes" style="flex:1">はい</button></div>',null);
const answer=yes=>{closeSub();const q=fpRecord(t),en=((state.entries||{})[c.d]||{})[c.k];if(t!==todayStr()||!fpCanAsk(q)||(q.fpConfirmed||0)!==confirmed||!fpEntrySig(en))return;mutate(()=>{state.prep[t]=Object.assign({},q,{fpAsked:sig,ts:Date.now()},yes?{fpLink:{d:c.d,k:c.k}}:{});});toast(yes?'✓ 実際の記録と紐づけた':'次の移動・場所の記録でまた確認する');};
$('fpLinkNo').onclick=()=>answer(false);$('fpLinkYes').onclick=()=>answer(true);}
var fpMutateBase=mutate;
mutate=function(fn){const watch=fpCanAsk(fpRecord(todayStr())),before=watch?fpEntrySnapshot():null;const result=fpMutateBase.apply(this,arguments);if(before&&fpCanAsk(fpRecord(todayStr()))){const c=fpFindChanged(before);if(c){FP_PENDING=c;fpScheduleAsk();}}return result;};
