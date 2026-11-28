/* A dedicated view over existing records; grouping never rewrites stored data. */
var BN_TAB='history';
function bnInDiary(x){return !x.br;}
function bnNavOrder(ids){const list=ids.filter(x=>x!=='navBookNotes'&&x!=='navEarn');if(ids.includes('navBookNotes'))list.splice(6,0,'navBookNotes');if(ids.includes('navEarn'))list.splice(7,0,'navEarn');return list;}
function bnGroups(q){q=q||{};const tokens=srNorm(q.q||'').split(/\s+/).filter(Boolean),groups=new Map();
for(const [id,x] of Object.entries(state.rlog||{})){
 if(!x||!x.br||x.del||(!x.brStart&&!bnText(x).trim())||(x.brReset&&!bnText(x).trim()))continue;
 if((q.day&&(x.brDay||x.d)!==q.day)||(q.from&&x.d<q.from)||(q.to&&x.d>q.to)||(q.star&&!x.brStar)||!tokens.every(t=>srNorm(bnText(x)+' '+brLabel(x)+' '+x.brDay).includes(t)))continue;
 const d=x.brDay||x.d,key=d+'|'+(x.brSlot||'note');let g=groups.get(key);if(!g){g={key,d,slot:x.brSlot,rows:[],total:0,done:false,running:false,last:0};groups.set(key,g);}
 g.rows.push(Object.assign({id},x));g.last=Math.max(g.last,x.brCreated||x.brStart||0);
 if(!x.brReset&&!x.brNoteOnly&&x.brStart){g.total+=brElapsed(x);g.running=g.running||!x.brEnd;g.done=g.done||!!(x.brDone&&x.brEnd&&(x.brReviewed||brReflectionValid(x.brReflection)));}
}
return [...groups.values()].sort((a,b)=>b.d.localeCompare(a.d)||b.last-a.last).map(g=>{g.rows.sort((a,b)=>(a.brCreated||a.brStart)-(b.brCreated||b.brStart));return g;});}
function bnDuration(ms){const n=Math.max(0,Math.floor(ms/1000));return Math.floor(n/60)+'分'+String(n%60).padStart(2,'0')+'秒';}
function bnGroupHtml(g){const slot=brSlot(g.slot),notes=g.rows.filter(x=>bnText(x).trim()),sessions=g.rows.filter(x=>!x.brNoteOnly&&x.brStart&&!x.brReset),status=g.running?'読書中':g.done?'✓ 読了':g.total?'中断・振り返り待ち':'ひと言';
return '<article class="bn-group"><div class="bn-group-head"><b>'+esc(g.d)+'の1日分</b><span>'+esc(status)+'</span></div><h3>'+esc(slot?slot[1]+' '+slot[2]:'✎ 今の気持ち')+'</h3>'+(sessions.length?'<p class="bn-total">'+bnDuration(g.total)+'<small>読んだ時間</small></p>':'')+
(notes.length?notes.map(x=>bnCard(x,false)).join(''):'<p class="bn-meta">ひと言はまだありません。</p>')+
(sessions.length?'<details data-bn-group="'+esc(g.key)+'"><summary>読んだ時間の内訳・修正 <span>'+sessions.length+'区間</span></summary><div class="bn-segments">'+sessions.map(x=>'<button type="button" class="br-log" data-bn-session="'+esc(x.id)+'"><b>'+esc(x.d)+' '+esc(x.s)+' → '+(x.brEnd?esc((fmt(new Date(x.brEnd))!==x.d?fmt(new Date(x.brEnd))+' ':'')+x.e):'読書中')+'</b><span>'+bnDuration(brElapsed(x))+' · '+(x.brDone?'✓ 読了':x.brEnd?'中断':'読書中')+'　✎ 修正</span></button>').join('')+'</div></details>':'')+'</article>';}
function bnPageRender(){
 pageMode='booknotes';const p=$('page'),old=p.querySelector('.page-body'),y=old?old.scrollTop:0,opened=new Set([...p.querySelectorAll('details[open][data-bn-group]')].map(x=>x.dataset.bnGroup)),filterOpen=!!p.querySelector('#bnFilters[open]');
 const groups=BN_TAB==='history'?bnGroups(BN_Q):[];
 p.innerHTML='<div class="page-head"><button class="bk" id="pgBk">‹ 戻る</button><span class="tt">📖 熊谷手帳</span></div><div class="page-body bn-page"><p class="bn-lead">読み返した時間と、心に残ったひと言。</p><div class="bn-tabs"><button type="button" data-bn-tab="today" aria-pressed="'+(BN_TAB==='today')+'">今日の10分</button><button type="button" data-bn-tab="history" aria-pressed="'+(BN_TAB==='history')+'">ひと言・履歴</button></div>'+
 (BN_TAB==='today'?brCardHtml(true):
 '<div class="bn-day-picker"><label for="bnDay">日付で探す（何日分の手帳タイム？）</label><div><button type="button" id="bnPrevDay" aria-label="前の日の手帳を見る">‹</button><input id="bnDay" type="date" value="'+esc(BN_Q.day||'')+'"><button type="button" id="bnNextDay" aria-label="次の日の手帳を見る">›</button><button type="button" id="bnToday">今日</button></div></div><details class="bn-filters" id="bnFilters"'+(filterOpen?' open':'')+'><summary>検索・絞り込み</summary><form id="bnFilter" class="bn-filter"><label>言葉で探す<input id="bnQuery" type="search" value="'+esc(BN_Q.q)+'" placeholder="夢、挑戦、家族…"></label><div class="bn-dates"><label>読んだ日付・いつから<input id="bnFrom" type="date" value="'+esc(BN_Q.from)+'"></label><label>読んだ日付・いつまで<input id="bnTo" type="date" value="'+esc(BN_Q.to)+'"></label></div><button class="br-primary" type="submit">絞り込む</button></form></details><div class="bn-actions"><button class="chip'+(BN_Q.star?' sel':'')+'" id="bnStars">★ 支えになる言葉'+(BN_Q.star?'だけ':'')+'</button><button class="chip" id="bnReset">直近3回</button><button class="chip" id="bnMeeting">会議で振り返る</button></div><p class="bn-meta">'+Math.min(groups.length,BN_Q.limit)+'回を表示 / 全'+groups.length+'回 · 新しい順'+(BN_Q.q||BN_Q.day||BN_Q.from||BN_Q.to||BN_Q.star?' · 絞り込み中':'')+'</p><div id="bnResults">'+(groups.length?groups.slice(0,BN_Q.limit).map(bnGroupHtml).join(''):'<p class="an-empty">該当する記録はありません。「今日の10分」から読み始められます。</p>')+'</div>'+(groups.length>BN_Q.limit?'<button class="br-secondary" id="bnMore">さらに3回分を見る</button>':'')+'<p class="bn-encourage">あの日の自分が、今日の力になる。</p>')+'</div>';
 p.classList.add('open');$('pgBk').onclick=closePage;
 p.querySelectorAll('[data-bn-tab]').forEach(b=>b.onclick=()=>{BN_TAB=b.dataset.bnTab;bnRender();p.querySelector('.page-body').scrollTop=0;});
 if(BN_TAB==='today')brBind(p);else{
  const chooseDay=d=>{BN_Q.day=d;BN_Q.from='';BN_Q.to='';BN_Q.limit=3;bnRender();p.querySelector('.page-body').scrollTop=0;};
  $('bnDay').onchange=()=>chooseDay($('bnDay').value);$('bnPrevDay').onclick=()=>chooseDay(addDays(BN_Q.day||brDay(),-1));$('bnNextDay').onclick=()=>chooseDay(addDays(BN_Q.day||brDay(),1));$('bnToday').onclick=()=>chooseDay(brDay());
  $('bnFilter').onsubmit=e=>{e.preventDefault();BN_Q.q=$('bnQuery').value;BN_Q.from=$('bnFrom').value;BN_Q.to=$('bnTo').value;if(BN_Q.from||BN_Q.to)BN_Q.day='';BN_Q.limit=3;bnRender();};
  $('bnStars').onclick=()=>{BN_Q.star=!BN_Q.star;BN_Q.limit=3;bnRender();};
  $('bnReset').onclick=()=>{BN_Q={q:'',day:'',from:'',to:'',star:false,limit:3};bnRender();};
  $('bnMeeting').onclick=bnMeeting;const more=$('bnMore');if(more)more.onclick=()=>{BN_Q.limit+=3;bnRender();};
  bnBind(p);p.querySelectorAll('[data-bn-session]').forEach(b=>b.onclick=()=>brEdit(b.dataset.bnSession));p.querySelectorAll('[data-bn-group]').forEach(el=>{el.open=opened.has(el.dataset.bnGroup);});
 }
 p.querySelector('.page-body').scrollTop=y;navPaint();
}
