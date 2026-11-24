/* The four-field diary preparation uses the existing per-day prep collection. */
var FP_DRAFTS={},FP_EDIT='',FP_SIG='',FP_FOCUS=null;
function fpDay(){const t=todayStr();return new Date().getHours()>=22?addDays(t,1):t;}
function fpRecord(d){const p=(state.prep||{})[d];return p&&!p.del?p:null;}
function fpComplete(p){return !!(p&&!p.del&&!p.skip&&!p.quit&&String(p.to||'').trim()&&String(p.tr||'').trim()&&/^([01]\d|2[0-3]):[0-5]\d$/.test(p.dep||'')&&prepDos(p)[0]);}
function fpKey(d){return 'hibiki-first-step-draft|'+(typeof CL!=='undefined'&&CL.uid?CL.uid:'local')+'|'+d;}
function fpDraft(d){const k=fpKey(d);if(FP_DRAFTS[k])return FP_DRAFTS[k];const p=fpRecord(d)||{};
let x=null;try{x=JSON.parse(localStorage.getItem(k)||'null');}catch(e){}
if(!x||x.d!==d||!x.dirty||['to','tr','dep','task'].some(f=>typeof x[f]!=='string'))x={d,to:p.to||'',tr:p.tr||'',dep:p.dep||'',task:prepDos(p)[0]||'',tid:(p.dsi||[])[0]||'',dirty:false};
FP_DRAFTS[k]=x;return x;}
function fpRemember(x){FP_DRAFTS[fpKey(x.d)]=x;try{localStorage.setItem(fpKey(x.d),JSON.stringify(x));}catch(e){}}
function fpForget(d){delete FP_DRAFTS[fpKey(d)];try{localStorage.removeItem(fpKey(d));}catch(e){}}
function fpDate(){return FP_EDIT||fpDay();}
function fpTitle(d){return d===todayStr()?'今日':d===addDays(todayStr(),1)?'明日':prepDateText(d);}
function fpCurrent(){return topView==='diary'&&ui.tab==='di'&&ui.date===todayStr();}
function fpBusy(){return !!document.querySelector('.ovl.open')||!!(document.activeElement&&document.activeElement.matches('input,textarea,select,[contenteditable="true"]'));}
function fpCardHtml(){if(!fpCurrent())return '';const d=fpDate(),p=fpRecord(d),dr=fpDraft(d),edit=FP_EDIT===d||!fpComplete(p)||dr.dirty,lab=fpTitle(d),h=new Date().getHours(),late=d===todayStr()||h>=23;
const hd='<div class="fp-head"><span>🌅 '+esc(lab)+'の準備'+(edit?'':' ✓')+'</span><small>'+(d>todayStr()?'23:00までに確定':'前夜に決めた予定')+'</small></div><h2>フライング以外、遅刻。</h2>';
if(!edit){const done=!!(p.dd||[])[0],started=!!p.fpStart,now=d===todayStr(),mv=now&&openMove(),arr=now&&prepArrived(p),tr=TRS.find(x=>x[0]===p.tr),mode=tr?tr[1]:p.tr;
return '<section class="fp-card" id="fpCard" data-date="'+esc(d)+'">'+hd+'<div class="fp-summary"><b>📍 '+esc(p.to)+'</b><span>'+esc(p.dep)+' 出発　'+esc(mode)+'</span></div><button type="button" class="fp-edit" data-fp="edit">予定を変更する</button><div class="fp-first"><strong>最初にやる事（軽いものを1つだけ）</strong><p>'+esc(prepDos(p)[0])+'</p>'+(done?'<div class="fp-done">✓ 最初の1つ、終わった！</div>':now?'<small>'+(started?'今はこの1つ。終わったら下のボタンを押そう。':'まずは、決めたこの1つから始めよう。')+'</small><button type="button" class="savebtn" data-fp="'+(started?'finish':'start')+'">'+(started?'終わった！':'これを始める')+'</button>':'<small>朝は、まずこの1つから始めよう。</small>')+'</div>'+(now?'<button type="button" class="fp-move" data-fp="'+(arr?'next':mv?'arrive':'go')+'">'+(arr?'🚗 次の移動を記録する':mv?'🏁 到着した':esc(mode)+'で出発する')+'</button>':'')+'</section>';}
const opts=prepTodos(d).slice(0,20),first=dr.task;
return '<section class="fp-card'+(late?' fp-late':'')+'" id="fpCard" data-date="'+esc(d)+'">'+hd+'<p class="fp-intro">'+(late?'行き先・移動手段・出発時刻・軽いやる事1つ。今ここで決めよう。':'朝に迷わず動けるように、下の4つを決めておこう。')+'</p><form id="fpForm" novalidate>'+
'<div class="fp-field"><label for="fpTo">① '+esc(lab)+'は、どこへ行く？</label><input type="text" id="fpTo" value="'+esc(dr.to)+'" placeholder="例：駅名やエリア名" autocomplete="off"><small>ざっくりした場所でOK。住所やお店の名前は不要です。</small></div>'+
'<fieldset class="fp-field"><legend>② どうやって行く？</legend><div class="sh-chips" id="fpTr">'+TRS.map(x=>'<button type="button" class="chip'+(dr.tr===x[0]?' sel':'')+'" data-fptr="'+esc(x[0])+'" aria-pressed="'+(dr.tr===x[0]?'true':'false')+'">'+esc(x[1])+'</button>').join('')+'</div></fieldset>'+
'<div class="fp-field"><label for="fpDep">③ 何時に出発する？</label><input type="time" id="fpDep" value="'+esc(dr.dep)+'"></div>'+
'<div class="fp-field fp-task-field"><label for="fpTask">④ 最初にやる事<br><b>（軽いものを1つだけ）</b></label><p>すぐに取りかかれて、短い時間で終わるものを1つだけ決めてください。</p><input type="text" id="fpTask" value="'+esc(first)+'" placeholder="例：メールを1件返す"><small>大きな仕事なら、最初の小さな作業だけでOK。<br>例：資料を作る → 資料の見出しを3つ書く</small>'+(opts.length?'<details><summary>やる事から選ぶ</summary><div class="fp-options">'+opts.map(x=>'<button type="button" class="chip" data-fptodo="'+esc(x.id)+'">'+esc(x.t)+'</button>').join('')+'</div></details>':'')+'</div>'+
'<p class="fp-error" id="fpError" role="alert"></p><button type="submit" class="savebtn">これで'+esc(lab)+'の準備を確定する</button></form></section>';}
function fpCapture(){const card=$('fpCard'),form=$('fpForm');if(!card||!form)return;const d=card.dataset.date,x=fpDraft(d);x.to=$('fpTo').value;x.dep=$('fpDep').value;x.task=$('fpTask').value;if(x.dirty)fpRemember(x);}
function fpReadInput(d){const x=fpDraft(d);x.to=$('fpTo').value;x.dep=$('fpDep').value;const task=$('fpTask').value;if(task!==x.task)x.tid='';x.task=task;x.dirty=true;FP_EDIT=d;fpRemember(x);}
function fpSave(d){const x=fpDraft(d),to=x.to.trim(),task=x.task.trim(),miss=[];if(!to)miss.push('行き先');if(!x.tr)miss.push('移動手段');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.dep))miss.push('出発時刻');if(!task)miss.push('最初にやる事（軽いものを1つだけ）');
if(miss.length){const e=$('fpError');if(e)e.textContent=miss.join('・')+'を決めてください。';return false;}
const prior=fpRecord(d)||{},same=prepDos(prior)[0]===task,ds=prepDos(prior),si=Array.isArray(prior.dsi)?prior.dsi.slice():[],dd=Array.isArray(prior.dd)?prior.dd.slice():[];
ds[0]=task;si[0]=x.tid||(same?si[0]||'':'');dd[0]=same?(dd[0]||0):0;
const patch={fp:1,to,tr:x.tr,dep:x.dep,do:task,dos:ds,dsi:si,dd,home:0,skip:0,quit:0,del:0,cross:0,done:dd.length&&dd.every(Boolean)?1:0,fpConfirmed:Date.now(),ts:Date.now()};
if(!same)patch.fpStart=0;
FP_EDIT='';fpForget(d);
mutate(()=>{state.prep=state.prep||{};state.prep[d]=Object.assign({},prior,patch);});
toast('✓ '+fpTitle(d)+'の準備を確定した');try{ntfKick();}catch(e){}return true;}
function fpBind(pane){const card=pane.querySelector('#fpCard');if(!card)return;const d=card.dataset.date;
const form=card.querySelector('#fpForm');if(form){form.oninput=()=>fpReadInput(d);form.onchange=()=>fpReadInput(d);form.onsubmit=e=>{e.preventDefault();fpReadInput(d);fpSave(d);};}
card.querySelectorAll('[data-fptr]').forEach(b=>b.onclick=()=>{fpReadInput(d);const x=fpDraft(d);x.tr=x.tr===b.dataset.fptr?'':b.dataset.fptr;fpRemember(x);card.querySelectorAll('[data-fptr]').forEach(c=>{const on=c.dataset.fptr===x.tr;c.classList.toggle('sel',on);c.setAttribute('aria-pressed',String(on));});});
card.querySelectorAll('[data-fptodo]').forEach(b=>b.onclick=()=>{const todo=(state.todos||{})[b.dataset.fptodo];if(!todo||todo.del)return;fpReadInput(d);const x=fpDraft(d);x.task=todo.t;x.tid=b.dataset.fptodo;fpRemember(x);$('fpTask').value=x.task;});
card.querySelectorAll('[data-fp]').forEach(b=>b.onclick=()=>{const a=b.dataset.fp;if(a==='edit'){FP_EDIT=d;fpForget(d);render();return;}if(d!==todayStr())return;const p=fpRecord(d);if(!p)return;
if(a==='start'){mutate(()=>{state.prep[d]=Object.assign({},state.prep[d],{fpStart:Date.now(),ts:Date.now()});});}
else if(a==='finish'){prepDoSet(0,1);const id=prepTdId(p,0);if(id&&(state.todos||{})[id]&&!tdDone(state.todos[id]))tdComplete(id,true);toast('✓ 最初の1つ、終わった！');}
else if(a==='go'){prepGo();}
else if(a==='arrive'){if(openMove())quickMoveArrive();else quickPlace(p.to);}
else if(a==='next'){quickMoveStart();}
});}
function fpBeforeRender(){fpCapture();const a=document.activeElement;FP_FOCUS=a&&a.closest&&a.closest('#fpForm')?{id:a.id,start:a.selectionStart,end:a.selectionEnd}:null;}
function fpAfterRender(){const f=FP_FOCUS;FP_FOCUS=null;if(f&&$(f.id)){try{$(f.id).focus({preventScroll:true});if(f.start!==null)$(f.id).setSelectionRange(f.start,f.end);}catch(e){}}
const card=$('fpCard');if(!card)return;const d=card.dataset.date,missing=!fpComplete(fpRecord(d)),sig=d+'|'+(new Date().getHours()>=23?'late':'open')+'|'+missing;
if(missing&&FP_SIG!==sig&&!fpBusy()){const pane=$('pane');if(pane)pane.scrollTop=0;ui._jump=null;}FP_SIG=sig;}
function fpTick(){const d=fpDay(),h=new Date().getHours(),sig=d+'|'+(h>=23?'late':'open')+'|'+!fpComplete(fpRecord(d));if(sig===FP_SIG||fpBusy())return;
if(fpCurrent()){if(FP_EDIT&&fpDraft(FP_EDIT).dirty)return;render();}else if(h>=22&&!fpComplete(fpRecord(d))){FP_SIG=sig;toast(h>=23?'23時。明日の準備を決めてください。':'22時。日記で明日の準備を決めよう。');}}
function fpOpen(d){fpCapture();FP_EDIT=d||fpDay();topView='diary';ui.tab='di';ui.date=todayStr();ui._jump=null;render();const pane=$('pane');if(pane)pane.scrollTop=0;}
var fpRenderBase=render;
render=function(){fpBeforeRender();const result=fpRenderBase.apply(this,arguments);fpAfterRender();return result;};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)fpTick();});
