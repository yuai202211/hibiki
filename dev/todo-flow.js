/* Today's ToDo: the existing todos/memos maps remain the source of truth. */
const TF={search:false,q:'',from:'',to:'',status:'all',limit:30,paper:true,done:false,confirm:'',edit:null,draft:null,drag:null,busy:false,stamp:'',timer:null};
function tfId(){return 'tf'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);}
function tfTs(x){return Math.max(Date.now(),Number(x&&x.ts||0)+1);}
function tfKey(){return 'hibiki-todo-draft|'+(typeof CL!=='undefined'&&CL.uid||'local');}
function tfDate(x){return x.sd||x.pin||x.tfDay||x.d||'';}
function tfRows(){return Object.entries(state.todos||{}).filter(([,x])=>x&&!x.del&&(x.t||x.tfDivider)).map(([id,x])=>Object.assign({id},x));}
function tfOrder(a,b){return (Number.isFinite(a.tfRank)?a.tfRank:(a.ts0||0))-(Number.isFinite(b.tfRank)?b.tfRank:(b.ts0||0))||a.id.localeCompare(b.id);}
function tfToday(done){return tfRows().filter(x=>!x.tfDivider&&!x.quit&&!tdHib(x)&&tfDate(x)===todayStr()&&!!tdDone(x)===!!done).sort(tfOrder);}
function tfParse(raw){
 const items=[];let title=null,lines=[],source=[];
 const flush=()=>{if(title===null)return;if(!title.trim())throw Error('「・」の後に大タイトルを書いてください。');items.push({t:title.trim(),c:lines.join('\n').trim(),source:source.join('\n').trim()});title=null;lines=[];source=[];};
 try{for(const line of String(raw).replace(/\r\n?/g,'\n').split('\n')){
  if(/^\s*─+\s*今日、最低ここまで\s*─+\s*$/.test(line)){flush();items.push({divider:true,source:line});continue;}
  const m=line.match(/^\s*[・•●]\s*(.*)$/);
  if(m){flush();title=m[1];source=[line];}
  else if(title!==null){lines.push(line);source.push(line);}
  else if(line.trim()){title=line;source=[line];}
 }flush();return {items,error:''};}catch(e){return {items:[],error:e.message};}
}
function tfNorm(v){return String(v||'').normalize('NFKC').toLowerCase();}
function tfMatch(x){const d=tfDate(x);return !x.tfDivider&&(!TF.from||d>=TF.from)&&(!TF.to||d<=TF.to)&&(TF.status==='all'||(TF.status==='done')===!!tdDone(x))&&tfNorm(TF.q).split(/\s+/).filter(Boolean).every(w=>tfNorm([x.t,x.c,x.tfSource].join('\n')).includes(w));}
function tfBackup(){try{localStorage.setItem(tfKey(),JSON.stringify({draft:TF.draft,edit:TF.edit}));return true;}catch(e){return false;}}
function tfLoad(){
 if(TF.draft)return;
 let cache=null;try{cache=JSON.parse(localStorage.getItem(tfKey())||'null');}catch(e){}
 if(cache&&cache.edit)TF.edit=cache.edit;
 if(cache&&cache.draft){const d=cache.draft,m=(state.memos||{})[d.id];if(!m||!m.tfApplied){TF.draft=d;return;}}
 const found=Object.entries(state.memos||{}).filter(([,m])=>m&&!m.del&&m.tfDraft&&!m.tfApplied&&m.tfDay===todayStr()).sort((a,b)=>(b[1].ts||0)-(a[1].ts||0))[0];
 TF.draft=found?{id:found[0],day:found[1].tfDay,text:found[1].t,base:found[1].t,dirty:false}:{id:tfId(),day:todayStr(),text:'',base:'',dirty:false};
}
function tfSaveDraft(){
 if(TF.composing)return false;
 clearTimeout(TF.timer);const d=TF.draft;if(!d||!d.dirty)return true;
 const m=(state.memos||{})[d.id];
 // A concurrent device's draft is kept intact; save this version separately.
 if(m&&(m.tfApplied||m.del||m.t!==d.base&&m.t!==d.text)){d.id=tfId();d.base='';}
 TF.busy=true;
 try{mutate(()=>{state.memos=state.memos||{};state.memos[d.id]={t:d.text,tfDraft:1,tfDay:d.day,ts:tfTs(state.memos[d.id])};});
  if(localSaveFail)return false;d.base=d.text;d.dirty=false;TF.stamp=tfStamp();tfBackup();return true;
 }finally{TF.busy=false;}
}
function tfInput(text){tfLoad();TF.draft.text=text;TF.draft.dirty=true;tfBackup();clearTimeout(TF.timer);if(TF.composing)return;TF.timer=setTimeout(()=>{const ok=tfSaveDraft();const el=$('tfSave');if(el)el.textContent=ok?'下書き保存済み':'保存できません。入力はこのまま残しています';},700);}
function tfApply(){
 if(TF.busy||TF.composing)return false;tfLoad();const d=TF.draft,p=tfParse(d.text);if(p.error||!p.items.length){tfMessage(p.error||'まず、メモを書いてください。');return false;}
 const applied=(state.memos||{})[d.id];
 if(applied&&applied.tfApplied&&applied.t===d.text){saveLocal(false);if(localSaveFail){tfMessage('まだ保存できません。元の文章は残しています。');return false;}if((applied.tfIds||[]).some(id=>!state.todos[id])){tfMessage('別の端末で反映したToDoを同期中です。入力は残しています。');return false;}tfApplied();return true;}
 d.dirty=true; // Re-check a remote draft revision even when this editor has not changed.
 if(!tfSaveDraft()){tfMessage('端末の保存に失敗しました。入力を残しています。空き容量を確認してからもう一度押してください。');return false;}
 const prior=(state.memos||{})[d.id];if(prior&&prior.tfApplied){tfMessage('このメモは反映済みです。');return false;}
 const base=Math.max(Date.now(),...tfRows().filter(x=>tfDate(x)===d.day).map(x=>Number.isFinite(x.tfRank)?x.tfRank:(x.ts0||0)))+1;
 TF.busy=true;
 try{mutate(()=>{
  state.todos=state.todos||{};state.memos=state.memos||{};
  p.items.forEach((x,i)=>{const id=d.id+'-'+i;if(state.todos[id])return;state.todos[id]=Object.assign({d:d.day,tfDay:d.day,tfRank:base+i,tfSource:x.source,tfMemo:d.id,ts0:Date.now(),ts:Date.now()},x.divider?{tfDivider:1}:{t:x.t,c:x.c});});
  state.memos[d.id]={t:d.text,tfDraft:1,tfApplied:1,tfDay:d.day,tfIds:p.items.map((x,i)=>d.id+'-'+i),ts:tfTs(state.memos[d.id])};
 });if(localSaveFail){tfMessage('保存に失敗しました。元の文章を残しています。もう一度押して保存し直してください。');return false;}
 }finally{TF.busy=false;}
 tfApplied();tfMessage(p.items.filter(x=>!x.divider).length+'件を反映しました。元の文章も保存しています。');return true;
}
function tfApplied(){TF.draft={id:tfId(),day:todayStr(),text:'',base:'',dirty:false};TF.paper=false;tfBackup();tfRender(true);}
function tfMessage(s){const el=$('tfMessage');if(el)el.textContent=s;else toast(s);}
function tfStartEdit(id){if(TF.edit&&TF.edit.id!==id)return tfMessage('編集中の内容を保存してから、次を開いてください。');const x=(state.todos||{})[id];if(!x||x.del)return;TF.confirm='';TF.edit={id,t:x.t||'',c:x.c||'',baseT:x.t||'',baseC:x.c||''};tfBackup();tfRender(true);$('tfTitle').focus();}
function tfSaveEdit(){
 const e=TF.edit;if(!e||!e.t.trim())return tfMessage('大タイトルを入力してください。');const x=(state.todos||{})[e.id];
 if(x&&!x.del&&x.t===e.t.trim()&&String(x.c||'')===e.c){saveLocal(false);if(localSaveFail)return tfMessage('まだ保存できません。入力を残しています。');TF.edit=null;tfBackup();tfRender(true);return;}
 if(!x||x.del||x.t!==e.baseT||String(x.c||'')!==e.baseC){tfMessage('別の画面で変更されています。入力をコピーしてから「戻る」で最新の内容を確認してください。');return;}
 TF.busy=true;try{mutate(()=>{state.todos[e.id]=Object.assign({},x,{t:e.t.trim(),c:e.c,ts:tfTs(x)});});if(localSaveFail){tfMessage('保存できません。入力を残しています。');return;}
 TF.edit=null;tfBackup();}finally{TF.busy=false;}tfRender(true);tfMessage('変更を保存しました。');
}
function tfComplete(id,yes){
 if(!yes){TF.confirm=id;tfRender(true);const b=$('tfNo');if(b)b.focus();return;}
 if(TF.busy||TF.confirm!==id)return;const x=(state.todos||{})[id];if(!x||x.del||tdDone(Object.assign({id},x))){TF.confirm='';tfRender(true);return;}
 TF.confirm='';TF.busy=true;try{tdComplete(id,true);}finally{TF.busy=false;}
 tfRender(true);tfMessage(localSaveFail?'端末保存に失敗しています。同期表示を確認してください。':'✓ 完了しました。「今日できたこと」から戻せます。');
}
function tfReorder(ids){
 const visible=tfRows().filter(x=>tfDate(x)===todayStr()&&!x.quit&&!tdHib(x)&&(x.tfDivider||!tdDone(x))).sort(tfOrder);
 if(ids.length!==visible.length||new Set(ids).size!==ids.length||visible.some(x=>!ids.includes(x.id)))return false;
 // Reassign only today's pending slots. Completed tasks retain their original slot.
 const all=tfRows().filter(x=>tfDate(x)===todayStr()).sort(tfOrder),slots=new Set(ids);let i=0;
 TF.busy=true;try{mutate(()=>{all.forEach((x,n)=>{const id=slots.has(x.id)?ids[i++]:x.id;const row=state.todos[id];row.tfRank=n;row.ts=tfTs(row);});});}finally{TF.busy=false;}return !localSaveFail;
}
function tfCard(x,next){
 const id=esc(x.id),done=tdDone(x),edit=TF.edit&&TF.edit.id===x.id;
 const grip=!TF.search&&!done?'<button type="button" class="tf-grip" data-grip="'+id+'" aria-label="長押しで並べ替え。上下キーでも移動">⠿</button>':'';
 if(x.tfDivider)return '<div class="tf-divider" data-row="'+id+'"><span>今日、最低ここまで</span>'+grip+'</div>';
 let h='<article class="tf-card'+(next?' tf-next':'')+'" data-row="'+id+'">';
 if(TF.search)h+='<small>'+esc(tfDate(x)||'日付なし')+' · '+(done?'完了':'未完了')+(x.quit?' · 保留済み':'')+'</small>';
 if(edit)return h+'<label>大タイトル<input id="tfTitle" type="text" value="'+esc(TF.edit.t)+'"></label><label>簡単な内容<textarea id="tfDetail" rows="3">'+esc(TF.edit.c)+'</textarea></label><div class="tf-actions"><button class="tf-quiet" data-action="cancelEdit">戻る</button><button class="tf-primary" data-action="saveEdit">保存する</button></div></article>';
 if(TF.confirm===x.id)return h+'<h3>完了にしてもいいですか？</h3><p>'+esc(x.t)+'</p><div class="tf-actions"><button id="tfNo" class="tf-quiet" data-action="no">いいえ、戻る</button><button class="tf-primary" data-yes="'+id+'">はい、完了にする</button></div></article>';
 if(next)h+='<div class="tf-next-label">次はこれ</div>';
 h+='<div class="tf-row"><button class="tf-check" '+(done?'data-undo':'data-complete')+'="'+id+'" aria-label="'+(done?'未完了に戻す':'完了の確認')+'">'+(done?'☑':'□')+'</button><div class="tf-copy"><h3>'+esc(x.t)+'</h3>'+(x.c?'<p>'+esc(x.c)+'</p>':'')+'</div>'+grip+'</div><div class="tf-actions"><button class="tf-link" data-edit="'+id+'">✎ その場で編集</button><button class="tf-link" data-settings="'+id+'" aria-label="時刻・分類などの設定">⋯</button></div></article>';
 return h;
}
function tfRender(force){
 if(TF.composing||!force&&typeof document!=='undefined'&&document.activeElement?.closest?.('.tf-root input,.tf-root textarea,.tf-root select'))return;
 tfLoad();pageMode='todo';const pg=$('page'),old=pg.querySelector('.page-body'),scroll=old?old.scrollTop:0,t=todayStr(),today=tfToday(false),done=tfToday(true);
 const active=tfRows().filter(x=>tfDate(x)===t&&!x.quit&&!tdHib(x)&&(x.tfDivider||!tdDone(x))).sort(tfOrder);
 const matches=TF.search?tfRows().filter(tfMatch).sort((a,b)=>tfDate(b).localeCompare(tfDate(a))||tfOrder(a,b)):active;
 const p=tfParse(TF.draft.text),originals=Object.entries(state.memos||{}).filter(([,m])=>m&&!m.del&&m.tfDraft&&m.tfDay===t);
 let h='<div class="page-head"><button class="bk" id="pgBk">‹ 戻る</button><span class="tt">ToDo</span><span></span></div><div class="page-body"><div class="tf-root"><header class="tf-head"><div><small>'+esc(t)+'</small><h1>今日のToDo</h1></div><div><b class="tf-count">'+(TF.search?'検索 '+matches.length+'件':'あと '+today.length+'件')+'</b><button class="tf-quiet" data-action="search">🔍 検索</button></div></header>';
 if(TF.search)h+='<section class="tf-panel"><label>キーワード<input id="tfQ" value="'+esc(TF.q)+'" placeholder="タイトル・内容・元のメモ"></label><div class="tf-dates"><label>いつから<input type="date" id="tfFrom" value="'+esc(TF.from)+'"></label><label>いつまで<input type="date" id="tfTo" value="'+esc(TF.to)+'"></label></div><div class="tf-actions"><button class="tf-quiet" data-day="0">今日</button><button class="tf-quiet" data-day="-1">昨日</button><button class="tf-quiet" data-day="all">全期間</button></div><label>状態<select id="tfStatus">'+[['all','すべて'],['done','完了'],['open','未完了']].map(([v,l])=>'<option value="'+v+'"'+(TF.status===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label><small>ToDoの日付・言葉・状態で探せます。</small><button class="tf-primary" data-action="find">検索する</button><button class="tf-link" data-action="today">今日の一覧に戻る</button></section>';
 else h+='<details class="tf-paper" id="tfPaper"'+(TF.paper?' open':'')+'><summary>自由メモ・追記</summary><div class="tf-inside">'+(TF.draft.day!==t?'<small>'+esc(TF.draft.day)+' の入力を復元しました。この日付に反映します。</small>':'')+'<textarea id="tfRaw" rows="5" placeholder="・大タイトル&#10;簡単な内容&#10;&#10;・次の大タイトル">'+esc(TF.draft.text)+'</textarea><div class="tf-hint"><span>「・」で次の項目。続く文章が内容。</span><span id="tfParseCount">反映する項目：'+p.items.filter(x=>!x.divider).length+'件</span></div><small id="tfSave">'+(TF.draft.dirty?'下書きを保存中…':'下書きは自動保存')+'</small><button class="tf-primary" data-action="apply">↓ この内容をToDoに反映</button></div></details>';
 h+='<div id="tfMessage" role="status" aria-live="polite"></div>';
 if(!TF.search)h+='<div class="tf-list-head"><b>上から、ひとつずつ。</b><small>⠿ 長押しで並べ替え</small></div>';
 h+='<div id="tfList">'+(matches.length?matches.slice(0,TF.search?TF.limit:matches.length).map(x=>tfCard(x,!TF.search&&today[0]&&x.id===today[0].id)).join(''):'<p class="tf-empty">'+(TF.search?'条件に合うToDoはありません。':'上のメモから、そのままToDoへ。')+'</p>')+'</div>';
 if(TF.search&&matches.length>TF.limit)h+='<button class="tf-quiet" data-action="more">もっと見る</button>';
 if(!TF.search){
 h+='<details class="tf-done" id="tfDone"'+(TF.done?' open':'')+'><summary>✓ 今日できたこと '+done.length+'件 · 開いて戻せる</summary>'+done.map(x=>tfCard(x,false)).join('')+'</details>';
 h+='<details class="tf-originals"><summary>元のメモ・下書き '+originals.length+'件</summary>'+originals.map(([id,m])=>'<details><summary>'+esc((m.t||'空のメモ').split('\n').find(s=>s.trim())||'空のメモ')+' · '+(m.tfApplied?'反映済み':'下書き')+'</summary><pre>'+esc(m.t)+'</pre>'+(!m.tfApplied&&id!==TF.draft.id?'<button class="tf-quiet" data-draft="'+esc(id)+'">この下書きを開く</button>':'')+'</details>').join('')+'</details><details class="tf-plans"><summary>📅 時間の予定・従来の設定</summary>'+plnSectionHtml()+'<button class="tf-quiet" data-action="legacy">以前のToDoを検索</button></details>';
 }
 h+='</div></div>';pg.innerHTML=h;pg.classList.add('open');$('pgBk').onclick=closePage;
 tfBind(pg);if(!TF.search){const pl=pg.querySelector('.pln-wrap');if(pl)plnBind(pl);}pg.querySelector('.page-body').scrollTop=scroll;TF.stamp=tfStamp();
}
function tfBind(pg){
 const raw=$('tfRaw');if(raw)raw.oninput=()=>{tfInput(raw.value);if(TF.composing)return;const p=tfParse(raw.value);$('tfParseCount').textContent=p.error||'反映する項目：'+p.items.filter(x=>!x.divider).length+'件';$('tfSave').textContent='下書きを保存中…';};
 pg.querySelectorAll('.tf-root input,.tf-root textarea').forEach(el=>{
  el.oncompositionstart=()=>{TF.composing=true;clearTimeout(TF.timer);};
  el.oncompositionend=()=>{TF.composing=false;if(el.oninput)el.oninput();};
  el.addEventListener('blur',()=>{TF.composing=false;if(!el.isConnected)return;if(el===raw){if(TF.draft&&el.value!==TF.draft.text)el.oninput();tfSaveDraft();}else if(TF.edit&&el.oninput)el.oninput();});
 });
 if($('tfPaper'))$('tfPaper').ontoggle=()=>{TF.paper=$('tfPaper').open;};
 if($('tfDone'))$('tfDone').ontoggle=()=>{TF.done=$('tfDone').open;};
 if(TF.edit&&$('tfTitle')){for(const [id,key] of [['tfTitle','t'],['tfDetail','c']])$(id).oninput=()=>{if(TF.edit){TF.edit[key]=$(id).value;tfBackup();}};}
 const root=pg.querySelector('.tf-root');root.onclick=ev=>{
  const b=ev.target.closest('button');if(!b)return;
  if(b.dataset.complete)return tfComplete(b.dataset.complete,false);
  if(b.dataset.yes)return tfComplete(b.dataset.yes,true);
  if(b.dataset.undo){TF.busy=true;try{tdUndo(b.dataset.undo);}finally{TF.busy=false;}tfRender(true);return;}
  if(b.dataset.edit)return tfStartEdit(b.dataset.edit);
  if(b.dataset.settings){tfSaveDraft();return tdEditSheet(b.dataset.settings,()=>tfRender());}
  if(b.dataset.draft){if(!tfSaveDraft())return;const m=state.memos[b.dataset.draft];TF.draft={id:b.dataset.draft,day:m.tfDay,text:m.t,base:m.t,dirty:false};TF.paper=true;tfBackup();tfRender(true);return;}
  if(b.hasAttribute('data-day')){const v=b.dataset.day;const d=v==='all'?'':addDays(todayStr(),Number(v));$('tfFrom').value=d;$('tfTo').value=d;return;}
  switch(b.dataset.action){
   case 'apply':tfApply();break;
   case 'search':tfSaveDraft();TF.search=!TF.search;TF.confirm='';tfRender(true);break;
   case 'find':{const a=$('tfFrom').value,z=$('tfTo').value;if(a&&z&&a>z)return tfMessage('日付の前後を確認してください。');TF.q=$('tfQ').value;TF.from=a;TF.to=z;TF.status=$('tfStatus').value;TF.limit=30;TF.confirm='';tfRender(true);break;}
   case 'today':TF.search=false;TF.confirm='';tfRender(true);break;
   case 'more':TF.limit+=30;tfRender(true);break;
   case 'no':TF.confirm='';tfRender(true);break;
   case 'saveEdit':tfSaveEdit();break;
   case 'cancelEdit':TF.edit=null;tfBackup();tfRender(true);break;
   case 'legacy':tfSaveDraft();TF.search=true;TF.from='';TF.to='';TF.status='all';TF.q='';tfRender(true);break;
  }
 };
 root.onkeydown=ev=>{if(ev.key==='Escape'&&TF.confirm){ev.preventDefault();TF.confirm='';tfRender(true);}};
 root.querySelectorAll('[data-grip]').forEach(b=>tfGrip(b));
}
function tfGrip(b){
 let timer=null,drag=null;
 const clear=cancel=>{clearTimeout(timer);timer=null;if(!drag)return;cancelAnimationFrame(drag.raf);const moved=drag.on;drag.card.classList.remove('tf-dragging');drag=null;TF.drag=null;
  if(moved){if(!cancel){const ids=[...$('tfList').children].map(x=>x.dataset.row).filter(Boolean);if(!tfReorder(ids))toast('並びを保存できませんでした。');}tfRender(true);}};
 const move=()=>{if(!drag||!drag.on)return;const list=$('tfList'),pb=$('page').querySelector('.page-body'),r=pb.getBoundingClientRect();
  if(drag.y<r.top+55)pb.scrollTop-=10;else if(drag.y>r.bottom-55)pb.scrollTop+=10;
  const other=[...list.children].filter(x=>x!==drag.card),before=other.find(x=>{const z=x.getBoundingClientRect();return drag.y<z.top+z.height/2;});if(drag.card.nextElementSibling!==(before||null)){list.insertBefore(drag.card,before||null);try{b.setPointerCapture(drag.pointer);}catch(e){}}drag.raf=requestAnimationFrame(move);
 };
 b.onpointerdown=ev=>{if(ev.button!==0||TF.edit||TF.confirm)return;drag={card:b.closest('[data-row]'),pointer:ev.pointerId,x:ev.clientX,y:ev.clientY,startY:ev.clientY,on:false,raf:0};
  try{b.setPointerCapture(ev.pointerId);}catch(e){}timer=setTimeout(()=>{if(!drag)return;drag.on=true;TF.drag=drag;drag.card.classList.add('tf-dragging');move();},380);};
 b.onpointermove=ev=>{if(!drag)return;if(!drag.on&&(Math.abs(ev.clientY-drag.startY)>12||Math.abs(ev.clientX-drag.x)>12)){clear(true);return;}drag.y=ev.clientY;if(drag.on)ev.preventDefault();};
 b.onpointerup=()=>clear(false);b.onpointercancel=()=>clear(true);b.onlostpointercapture=()=>{if(drag)clear(true);};
 b.onkeydown=ev=>{if(!['ArrowUp','ArrowDown'].includes(ev.key))return;ev.preventDefault();const ids=[...$('tfList').children].map(x=>x.dataset.row),i=ids.indexOf(b.dataset.grip),j=i+(ev.key==='ArrowUp'?-1:1);if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];tfReorder(ids);tfRender(true);const el=$('page').querySelector('[data-grip="'+b.dataset.grip+'"]');if(el)el.focus();};
}
function tfStamp(){return todayStr()+JSON.stringify(state.todos||{})+JSON.stringify(state.memos||{});}
function tfKeepVisible(el){
 if(document.activeElement!==el||!el.isConnected||TF.composing)return;
 const sc=el.closest('.page-body');if(!sc)return;
 const vv=window.visualViewport,s=sc.getBoundingClientRect(),top=Math.max(s.top,vv?vv.offsetTop:0)+8,bot=Math.min(s.bottom,vv?vv.offsetTop+vv.height:window.innerHeight)-8;
 if(el.tagName==='TEXTAREA'){const cap=Math.max(80,bot-top-8)+'px';if(el.style.maxHeight!==cap)el.style.maxHeight=cap;}
 const r=el.getBoundingClientRect();let dy=r.bottom>bot?r.bottom-bot:r.top<top?r.top-top:0;
 if(Math.abs(dy)>2)sc.scrollTop+=Math.round(dy);
}
function tfRefresh(){
 const root=$('page')&&$('page').querySelector('.tf-root');if(!root||pageMode!=='todo'||TF.busy||TF.drag||TF.edit||TF.confirm||TF.search||root.contains(document.activeElement))return;
 const s=tfStamp();if(s!==TF.stamp){if(TF.draft&&!TF.draft.text&&TF.draft.day!==todayStr())TF.draft=null;tfRender(true);}
}
if(typeof window!=='undefined'){
 window.addEventListener('pagehide',()=>{tfBackup();tfSaveDraft();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){tfBackup();tfSaveDraft();}else tfRefresh();});
 setInterval(tfRefresh,2500);
}
