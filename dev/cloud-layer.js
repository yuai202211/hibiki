/* ===================== HIBIKI クラウド（Supabase）=====================
   旧版の「HTML全体を再公開して読み直す」方式をやめ、変わった項目だけをデータベースへ送る。
   合流の規則は旧版と同じ mergeStates（1件ずつ ts の新しい方が勝つ）。削除は del:1 の墓石。
   このブロックは build.js が boot(); の直前に差し込む。既存の名前（state・saveLocal・render・renderSync・
   unsynced・localOnly・permFail・schedulePublish・doPublish・getAssets・phUpload・toast・$）に乗る。 */
const CLOUD={url:'__SUPABASE_URL__',key:'__SUPABASE_KEY__',bucket:'photos'};
const CL_SESS='hibiki-session',CL_SYNC='hibiki-sync';
const CL={sess:null,seq:0,dirty:{},shadow:{},busy:false,pulling:false,timer:null,lastPull:0,lastPush:0,err:'',ready:false,firstPull:false,uid:'',pullTimer:null,photoQ:[],photoBusy:false};

function cloudConfigured(){return !!(CLOUD.url&&CLOUD.key&&CLOUD.url.indexOf('__')!==0&&/^https?:\/\//.test(CLOUD.url));}
function cloudLoggedIn(){return !!(CL.sess&&CL.sess.access_token&&CL.sess.user&&CL.sess.user.id);}
function clSaveSess(){try{if(CL.sess)localStorage.setItem(CL_SESS,JSON.stringify(CL.sess));else localStorage.removeItem(CL_SESS);}catch(e){}}
function clSaveSync(){try{localStorage.setItem(CL_SYNC,JSON.stringify({seq:CL.seq,dirty:CL.dirty,uid:CL.uid,lastPull:CL.lastPull}));}catch(e){}}
function clLoad(){
  try{CL.sess=JSON.parse(localStorage.getItem(CL_SESS)||'null');}catch(e){CL.sess=null;}
  try{const s=JSON.parse(localStorage.getItem(CL_SYNC)||'null');if(s){CL.seq=Number(s.seq)||0;CL.dirty=s.dirty||{};CL.uid=s.uid||'';CL.lastPull=Number(s.lastPull)||0;}}catch(e){}
}
clLoad();

/* ---------- Supabase への最小クライアント（fetch だけ） ---------- */
async function clFetch(path,opt,noAuth){
  opt=opt||{};
  const h=Object.assign({'apikey':CLOUD.key,'Content-Type':'application/json'},opt.headers||{});
  if(!noAuth&&CL.sess&&CL.sess.access_token)h['Authorization']='Bearer '+CL.sess.access_token;
  let r=await fetch(CLOUD.url+path,Object.assign({},opt,{headers:h}));
  if(r.status===401&&!noAuth&&CL.sess&&CL.sess.refresh_token&&!opt._retried){
    const ok=await clRefresh();
    if(ok){h['Authorization']='Bearer '+CL.sess.access_token;r=await fetch(CLOUD.url+path,Object.assign({},opt,{headers:h,_retried:1}));}
  }
  return r;
}
async function clJson(r){const t=await r.text();try{return t?JSON.parse(t):null;}catch(e){return {raw:t};}}
async function clLogin(email,password){
  const r=await clFetch('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})},true);
  const j=await clJson(r);
  if(!r.ok||!j||!j.access_token){const m=(j&&(j.msg||j.message||j.error_description||j.error))||('HTTP '+r.status);throw new Error(m);}
  CL.sess={access_token:j.access_token,refresh_token:j.refresh_token,expires_at:(j.expires_at||0)*1000,user:j.user};
  clSaveSess();return CL.sess.user;
}
async function clRefresh(){
  if(!CL.sess||!CL.sess.refresh_token)return false;
  try{
    const r=await fetch(CLOUD.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'apikey':CLOUD.key,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:CL.sess.refresh_token})});
    const j=await clJson(r);
    if(!r.ok||!j||!j.access_token){
      /* 更新用の合言葉が無効＝ログインし直しが要る（400/401/403）。回線の不調（他）ならセッションは残す */
      if(r.status===400||r.status===401||r.status===403){CL.sess=null;clSaveSess();renderSync();}
      return false;
    }
    CL.sess={access_token:j.access_token,refresh_token:j.refresh_token||CL.sess.refresh_token,expires_at:(j.expires_at||0)*1000,user:j.user||CL.sess.user};
    clSaveSess();return true;
  }catch(e){return false;}
}
async function clEnsureFresh(){
  /* 期限の5分前になったら先に更新しておく（送信中に切れて二度手間にならないように） */
  if(CL.sess&&CL.sess.expires_at&&Date.now()>CL.sess.expires_at-300000)await clRefresh();
}
async function clLogout(){
  try{await clFetch('/auth/v1/logout',{method:'POST'});}catch(e){}
  CL.sess=null;clSaveSess();renderSync();
}
async function clRpc(name,body){
  await clEnsureFresh();
  const r=await clFetch('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(body||{})});
  const j=await clJson(r);
  if(!r.ok){const m=(j&&(j.message||j.msg||j.error||j.hint))||('HTTP '+r.status);const e=new Error(m);e.status=r.status;throw e;}
  return j;
}

/* ---------- state ⇄ 項目（1行） ---------- */
const CL_ID=['dreams','memos','pays','aims','moves','pins','steps','payrep','rtn','rlog','payppl','pha'];
const CL_DAY=['ai','rules'];
const CL_DAY2=['entries','plans'];
const CL_SKIP={updatedAt:1,photos:1};
function clItems(st){
  /* state を {coll,k,ts,data} の並びにする。photos（端末の写真の実体）は送らない。pha は「写真id→保管番号」で ts が無いので 1 固定 */
  const out=[];
  for(const c of CL_DAY2)for(const d in (st[c]||{}))for(const k in st[c][d]){const v=st[c][d][k];if(v&&typeof v==='object')out.push({coll:c,k:d+'/'+k,ts:Number(v.ts)||0,data:v});}
  for(const c of CL_DAY)for(const d in (st[c]||{})){const v=st[c][d];if(v&&typeof v==='object')out.push({coll:c,k:d,ts:Number(v.ts)||0,data:v});}
  for(const c of CL_ID)for(const id in (st[c]||{})){const v=st[c][id];if(v==null)continue;
    if(c==='pha')out.push({coll:c,k:id,ts:1,data:{a:v}});
    else if(typeof v==='object')out.push({coll:c,k:id,ts:Number(v.ts)||0,data:v});}
  for(const k in st){if(CL_SKIP[k]||CL_DAY2.indexOf(k)>=0||CL_DAY.indexOf(k)>=0||CL_ID.indexOf(k)>=0)continue;
    const v=st[k];if(v==null)continue;out.push({coll:'_top',k,ts:(v&&typeof v==='object'&&Number(v.ts))||0,data:(typeof v==='object')?v:{v}});}
  return out;
}
function clRowsToState(rows){
  /* 受け取った行を state の形（部分）に戻す。mergeStates(state, 部分) で合流できる */
  const st={};
  for(const r of rows){
    if(!r||!r.coll)continue;const c=r.coll,d=r.data;
    if(CL_DAY2.indexOf(c)>=0){const i=String(r.k).indexOf('/');if(i<0)continue;const day=r.k.slice(0,i),k=r.k.slice(i+1);st[c]=st[c]||{};st[c][day]=st[c][day]||{};st[c][day][k]=d;}
    else if(CL_DAY.indexOf(c)>=0){st[c]=st[c]||{};st[c][r.k]=d;}
    else if(c==='pha'){st.pha=st.pha||{};if(d&&d.a)st.pha[r.k]=d.a;}
    else if(CL_ID.indexOf(c)>=0){st[c]=st[c]||{};st[c][r.k]=d;}
    else if(c==='_top'){st[r.k]=(d&&typeof d==='object'&&'v' in d&&Object.keys(d).length===1)?d.v:d;}
  }
  return st;
}
const clKey=it=>it.coll+'\u0000'+it.k;
function clSig(it){try{return String(it.ts)+'|'+JSON.stringify(it.data);}catch(e){return String(it.ts)+'|?';}}
/* 影（CL.shadow）＝「クラウドが持っていると分かっている中身」。state と影が違う項目が dirty（送る物）。
   影を更新するのは、受信した時と、送信が通った時だけ。saveLocal のたびに state と影を比べ直す（何度やっても同じ結果） */
function clMarkDirty(){
  if(!CL.ready)return 0;
  let n=0,changed=false;
  for(const it of clItems(state)){const k=clKey(it);const d=(CL.shadow[k]!==clSig(it));if(d&&!CL.dirty[k]){CL.dirty[k]=1;changed=true;}if(d)n++;}
  if(changed)clSaveSync();
  return n;
}
function clDirtyCount(){return Object.keys(CL.dirty).length;}
/* 起動時の影：今の state を「クラウドと同じ」とみなす。ただし前回までに送れていない項目（dirty に残っている物）は除く */
function clShadowFromState(){CL.shadow={};for(const it of clItems(state)){const k=clKey(it);if(!CL.dirty[k])CL.shadow[k]=clSig(it);}}
/* 受信・送信の後：state と影を比べ直して dirty を作り直す */
function clRecomputeDirty(){CL.dirty={};for(const it of clItems(state)){const k=clKey(it);if(CL.shadow[k]!==clSig(it))CL.dirty[k]=1;}clSaveSync();}

/* ---------- 送信（dirty の項目だけ） ---------- */
async function cloudPush(){
  if(!cloudConfigured()||!cloudLoggedIn()||CL.busy||!CL.firstPull)return false;
  const keys=Object.keys(CL.dirty);if(!keys.length){unsynced=false;renderSync();return true;}
  CL.busy=true;renderSync();
  try{
    const all=clItems(state),byKey={};for(const it of all)byKey[clKey(it)]=it;
    const rows=[];for(const k of keys){const it=byKey[k];if(it)rows.push(it);else delete CL.dirty[k];}   /* 影にあって state に無い＝通常は無い。あれば dirty から外すだけ（消さない） */
    for(let i=0;i<rows.length;i+=400){
      const part=rows.slice(i,i+400);
      await clRpc('put_items',{rows:part});
      for(const it of part){const k=clKey(it);CL.shadow[k]=clSig(it);delete CL.dirty[k];}   /* 通った分＝クラウドが持っている */
      clSaveSync();
    }
    CL.lastPush=Date.now();CL.err='';
    unsynced=clDirtyCount()>0;
    return true;
  }catch(e){
    CL.err=(e&&e.message)||'送信失敗';
    if(e&&e.status===401){/* ログインし直しが要る。データは端末に残っている */}
    return false;
  }finally{CL.busy=false;renderSync();}
}
/* ---------- 受信（seq より新しい行） ---------- */
async function cloudPull(full){
  if(!cloudConfigured()||!cloudLoggedIn()||CL.pulling)return false;
  CL.pulling=true;
  try{
    let since=full?0:CL.seq,got=0,changed=false,guard=0;
    if(full)CL.shadow={};   /* 全件取り直し＝クラウドの中身を影として作り直す（端末だけにある物は全部 dirty になる＝送られる） */
    const before=JSON.stringify(state);
    while(guard++<200){
      const rows=await clRpc('pull_items',{since_seq:since,lim:1000});
      if(!Array.isArray(rows)||!rows.length)break;
      /* 受け取った行＝クラウドが持っている中身。影に入れる（自分の方が新しい項目は合流で勝つので影と差が出て、次の送信で送られる） */
      for(const r of rows){if(!r||!r.coll)continue;const d=(r.coll==='_top')?((r.data&&typeof r.data==='object'&&'v' in r.data&&Object.keys(r.data).length===1)?{v:r.data.v}:r.data):r.data;
        CL.shadow[r.coll+'\u0000'+r.k]=clSig({ts:Number(r.ts)||0,data:d});since=Math.max(since,Number(r.seq)||0);}
      const part=clRowsToState(rows);
      state=mergeStates(state,part);
      /* 本人の設定（_cfg）は mergeStates の「知らない項目」扱い（端末側が常に勝つ）なので、ts で新しい方を採る */
      if(part._cfg&&typeof part._cfg==='object'&&(!state._cfg||(Number(part._cfg.ts)||0)>(Number(state._cfg.ts)||0)))state._cfg=part._cfg;
      got+=rows.length;
      if(rows.length<1000)break;
    }
    changed=(JSON.stringify(state)!==before);
    if(changed){try{cfgApply();}catch(e){}}
    if(since>CL.seq){CL.seq=since;}
    CL.lastPull=Date.now();CL.err='';
    clRecomputeDirty();
    if(changed){saveLocal(clDirtyCount()===0);render();}
    else{unsynced=clDirtyCount()>0;renderSync();}
    if(!CL.firstPull){CL.firstPull=true;try{afterCloudReady();}catch(e){}}
    return true;
  }catch(e){CL.err=(e&&e.message)||'受信失敗';renderSync();return false;}
  finally{CL.pulling=false;}
}
async function cloudSync(force){
  if(!cloudConfigured()||!cloudLoggedIn())return;
  if(!CL.firstPull)await cloudPull(true);
  await cloudPush();
  await cloudPull(false);
}
function scheduleSync(ms){clearTimeout(CL.timer);CL.timer=setTimeout(()=>{cloudSync();},ms||1500);}

/* ---------- 旧版の関数を差し替え ---------- */
schedulePublish=function(ms){scheduleSync(ms||1500);};
doPublish=async function(force){await cloudSync(force);};
/* 写真の置き場（旧版の assets 機能の代わり）。upload(blob)→{id} の形を合わせる */
function clNewAssetId(){const a=new Uint8Array(16);(window.crypto&&crypto.getRandomValues)?crypto.getRandomValues(a):a.forEach((_,i)=>a[i]=Math.floor(Math.random()*256));return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function cloudPhotoUpload(blob){
  if(!cloudLoggedIn())throw Object.assign(new Error('not_logged_in'),{code:'not_granted'});
  await clEnsureFresh();
  const id=clNewAssetId(),path='/storage/v1/object/'+CLOUD.bucket+'/'+CL.sess.user.id+'/'+id;
  const r=await fetch(CLOUD.url+path,{method:'POST',headers:{'apikey':CLOUD.key,'Authorization':'Bearer '+CL.sess.access_token,'Content-Type':blob.type||'image/jpeg','x-upsert':'false'},body:blob});
  if(!r.ok){const j=await clJson(r);const e=new Error((j&&(j.message||j.error))||('HTTP '+r.status));e.code=(r.status===429)?'rate_limited':(r.status===401||r.status===403)?'not_granted':'ERR';throw e;}
  return {id};
}
async function cloudPhotoFetch(assetId){
  if(!cloudLoggedIn())return null;
  await clEnsureFresh();
  const r=await fetch(CLOUD.url+'/storage/v1/object/authenticated/'+CLOUD.bucket+'/'+CL.sess.user.id+'/'+assetId,{headers:{'apikey':CLOUD.key,'Authorization':'Bearer '+CL.sess.access_token}});
  if(!r.ok)return null;
  const b=await r.blob();if(!b||!b.size)return null;
  return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result));fr.onerror=()=>res(null);fr.readAsDataURL(b);});
}
getAssets=async function(){return cloudLoggedIn()?{upload:cloudPhotoUpload}:null;};
verifyBlob=async function(url){
  /* 旧版は '/_blob/<id>' を画像として読めるか見ていた。クラウド版は保管番号を取り直して中身があるかを見る */
  const m=/^\/_blob\/(.+)$/.exec(String(url||''));
  if(!m)return false;
  const du=await cloudPhotoFetch(m[1]);
  return !!(du&&du.indexOf('data:image')===0);
};
/* 表示：保管番号だけある写真は、取りに行って端末に控える（取れるまでは薄い枠） */
const CL_BLANK='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function cloudPhotoWant(id,assetId){
  if(PH.mem[id]||(state.photos&&state.photos[id]))return;
  if(CL.photoQ.some(x=>x.id===id))return;
  CL.photoQ.push({id,assetId});
  cloudPhotoDrain();
}
async function cloudPhotoDrain(){
  if(CL.photoBusy)return;CL.photoBusy=true;
  try{
    let shown=0;
    while(CL.photoQ.length){
      const {id,assetId}=CL.photoQ.shift();
      if(PH.mem[id])continue;
      let du=null;try{du=await cloudPhotoFetch(assetId);}catch(e){}
      if(du){PH.mem[id]=du;try{if(IDB.ok)idbPut(id,du);}catch(e){}shown++;}
      if(shown&&(CL.photoQ.length===0||shown%4===0)){try{render();}catch(e){}}
    }
  }finally{CL.photoBusy=false;}
}
phUrl=function(id){
  if(state.photos&&state.photos[id])return state.photos[id];
  if(PH.mem[id])return PH.mem[id];
  if(state.pha&&state.pha[id]){cloudPhotoWant(id,state.pha[id]);return CL_BLANK;}
  return CL_BLANK;
};

/* ---------- ログイン画面 ----------
   本人の決め事（2026-10-03）：①未ログインなら起動した最初の画面がログイン ②メールアドレスは「覚える」で常に表示
   ③パスワードは忘れないように1日1回は入力する（その日の最初の起動で聞く）④「自動ログイン」にチェックした時だけ③も省く */
const CL_EMAIL='hibiki-email',CL_AUTO='hibiki-autologin',CL_PWDAY='hibiki-pwday';
const clGet=(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:v;}catch(e){return d;}};
const clSet=(k,v)=>{try{if(v==null)localStorage.removeItem(k);else localStorage.setItem(k,String(v));}catch(e){}};
const CL_APPVER='__APPVER__';   /* アプリの版（build.js が入れる）。版が変わった最初の起動でもパスワードを聞く（本人の希望 2026-10-03「更新した時は再ログインでもいい」） */
function clDailyDue(){return cloudLoggedIn()&&clGet(CL_AUTO,'0')!=='1'&&clGet(CL_PWDAY,'')!==todayStr();}
function openLoginSheet(opt){
  opt=opt||{};
  const u=cloudLoggedIn()?CL.sess.user:null;
  const daily=!!(u&&(opt.daily||clDailyDue()));   /* ログイン済みだが「今日のパスワード確認」がまだ */
  const remEmail=clGet(CL_EMAIL,'')||(u&&u.email)||'';
  const loginForm=(title,note)=>
      '<div class="sh-note" style="text-align:left;margin-bottom:6px">'+note+'</div>'+
      '<div><div class="sh-label">メールアドレス</div><input type="email" id="clEmail" autocomplete="username" inputmode="email" placeholder="登録したメールアドレス" value="'+esc(remEmail)+'" style="width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 13px;outline:none'+(daily?';background:#f1f3f8;color:#6a7080'+'" readonly':'"')+'></div>'+
      '<label style="display:flex;align-items:center;gap:8px;margin:6px 2px 0;font-size:12.5px;font-weight:700;color:#6a7080"><input type="checkbox" id="clRem" '+(clGet(CL_EMAIL,'')||!u?'checked':'')+' style="width:18px;height:18px">メールアドレスを覚える（次から表示したまま）</label>'+
      '<div style="margin-top:10px"><div class="sh-label">パスワード</div><div style="display:flex;gap:6px"><input type="password" id="clPass" autocomplete="current-password" style="flex:1;min-width:0" autofocus><button class="chip" id="clEye" style="flex-shrink:0">表示</button></div></div>'+
      '<label style="display:flex;align-items:center;gap:8px;margin:8px 2px 0;font-size:12.5px;font-weight:700;color:#6a7080"><input type="checkbox" id="clAuto" '+(clGet(CL_AUTO,'0')==='1'?'checked':'')+' style="width:18px;height:18px">自動ログイン（1日1回のパスワード入力も省く）</label>'+
      '<div class="sh-note" id="clMsg" style="color:#e0405a;display:none"></div>'+
      '<div class="sh-btns"><button class="savebtn" id="clIn">'+title+'</button></div>';
  $('sheet').innerHTML='<div class="grab"></div><div class="sh-time"><span>☁️ HIBIKI クラウド</span></div>'+
    (!cloudConfigured()?'<div class="sh-note">このアプリはまだクラウドの設定が入っていない（配信前の状態）。記録は端末に保存されている</div>':
    (daily?(loginForm('ログイン','🔑 <b>今日のパスワード確認</b>（忘れないように1日1回）。記録はこのまま続けられる')+
            '<div class="sh-note"><button class="chip" id="clLater" style="background:#f1f3f8;color:#8a90a0">あとで</button></div>'):
    (u?('<div class="sh-note" style="text-align:left">ログイン中：<b>'+esc(u.email||'')+'</b><br>クラウド '+esc(cloudStatusText())+'</div>'+
        '<div class="sh-btns"><button class="delbtn" id="clOut">ログアウト</button><button class="savebtn" id="clSyncNow">今すぐ同期</button></div>'+
        '<div class="sh-label" style="margin-top:14px">引っ越し（旧アプリから）</div>'+
        '<button class="bkbtn" id="clImpJsonBtn">📥 バックアップ JSON を取り込む（消さずに合流）</button>'+
        '<button class="bkbtn" id="clImpPhBtn" style="margin-top:6px">📦 写真をクラウドへ（ファイルを選ぶ）</button>'+
        '<div class="sh-note" id="clImpMsg" style="text-align:left"></div>'):
      (loginForm('ログイン','ログインすると、どの端末でも同じ記録が出る。しなくても記録はできる（この端末に保存）')))));
  const inB=$('clIn');
  if(inB)inB.onclick=async()=>{
    const em=$('clEmail').value.trim(),pw=$('clPass').value;
    if(!em||!pw){toast('メールとパスワードを入れてくれ');return;}
    inB.disabled=true;inB.textContent='ログイン中…';
    try{
      const wasIn=cloudLoggedIn();
      await clLogin(em,pw);
      clSet(CL_EMAIL,($('clRem')&&$('clRem').checked)?em:null);
      clSet(CL_AUTO,($('clAuto')&&$('clAuto').checked)?'1':'0');
      clSet(CL_PWDAY,todayStr());
      closeSheet();
      if(wasIn){toast('✓ 今日のパスワード確認 OK');renderSync();}
      else{toast('✓ ログインした。同期を始める');CL.firstPull=false;CL.seq=0;clSaveSync();cloudSync();}
    }
    catch(e){const m=$('clMsg');m.style.display='';m.textContent='ログインできない：'+String((e&&e.message)||e).slice(0,80);inB.disabled=false;inB.textContent='ログイン';}
  };
  const lt=$('clLater');if(lt)lt.onclick=()=>{closeSheet();toast('あとで。次に開いた時にまた聞く');};
  {const _cs=closeSheet;if(!window.__clCsWrapped){window.__clCsWrapped=1;closeSheet=function(){try{$('ovl').classList.remove('cl-first');}catch(e){}return _cs.apply(this,arguments);};}}
  if($('clRem'))$('clRem').onchange=()=>{if(!$('clRem').checked)clSet(CL_EMAIL,null);};
  if($('clAuto'))$('clAuto').onchange=()=>{clSet(CL_AUTO,$('clAuto').checked?'1':'0');};
  const eye=$('clEye');if(eye)eye.onclick=()=>{const p=$('clPass');p.type=(p.type==='password')?'text':'password';eye.textContent=(p.type==='password')?'表示':'隠す';};
  const out=$('clOut');if(out)out.onclick=async()=>{if(clDirtyCount()){toast('まだ送っていない記録がある（'+clDirtyCount()+'件）。先に同期してくれ');return;}await clLogout();closeSheet();toast('ログアウトした');};
  const sn=$('clSyncNow');if(sn)sn.onclick=async()=>{sn.disabled=true;await cloudSync(true);sn.disabled=false;openLoginSheet();};
  const ij=$('clImpJsonBtn');if(ij)ij.onclick=()=>clImpInput('json').click();
  const ip=$('clImpPhBtn');if(ip)ip.onclick=()=>clImpInput('ph').click();
  openOvl();
}
/* 引っ越し用のファイル入力（画面には出さない。1回作って使い回す） */
function clImpInput(kind){
  const id=kind==='json'?'clImpJson':'clImpPh';
  let inp=document.getElementById(id);
  if(!inp){inp=document.createElement('input');inp.type='file';inp.id=id;inp.style.display='none';
    if(kind==='json'){inp.accept='.json,application/json';}else{inp.accept='image/*';inp.multiple=true;}
    document.body.appendChild(inp);
    inp.addEventListener('change',()=>{if(kind==='json')clImportJson(inp.files&&inp.files[0]);else clImportPhotos(inp.files);inp.value='';});}
  return inp;
}
const clImpSay=t=>{const m=$('clImpMsg');if(m)m.textContent=t;toast(t);};
/* 旧アプリのバックアップ JSON（または埋め込みデータから作った JSON）を、消さずに合流する。何度やっても同じ結果 */
async function clImportJson(f){
  if(!f)return;
  try{
    const data=JSON.parse(await f.text());
    const st=(data&&data.entries)?data:((data&&data.state&&data.state.entries)?data.state:null);
    if(!st){clImpSay('このファイルは日記のバックアップじゃない');return;}
    const cnt=s=>{let n=0;for(const d in (s.entries||{}))for(const k in s.entries[d])n++;return n;};
    const before=cnt(state);
    state=mergeStates(state,st);
    if(st._cfg&&(!state._cfg||(Number(st._cfg.ts)||0)>=(Number(state._cfg.ts)||0)))state._cfg=st._cfg;
    try{cfgApply();}catch(e){}
    state.updatedAt=Math.max(state.updatedAt||0,Date.now());
    saveLocal(false);render();
    clImpSay('📥 取り込んだ：記録 '+before+'→'+cnt(state)+'件・支払い '+Object.keys(state.pays||{}).length+'・写真番号 '+Object.keys(state.pha||{}).length+'。クラウドへ送っている…');
    scheduleSync(300);
  }catch(e){clImpSay('取り込みに失敗：'+String((e&&e.message)||e).slice(0,60));}
}
/* 写真ファイル（名前＝保管番号）をクラウドの写真置き場へ。pha に無い番号は飛ばす。同じ物が既にあれば成功扱い */
async function clImportPhotos(files){
  if(!files||!files.length)return;
  if(!cloudLoggedIn()){clImpSay('先にログインしてくれ');return;}
  const want={};for(const id in (state.pha||{}))want[state.pha[id]]=1;
  const list=[...files].map(f=>({f,aid:String(f.name||'').replace(/\.[^.]+$/,'').toLowerCase()})).filter(x=>/^[0-9a-f]{32}$/.test(x.aid));
  const todo=list.filter(x=>want[x.aid]),skip=list.length-todo.length;
  let ok=0,dup=0,ng=0,i=0;
  const uid=CL.sess.user.id;
  const one=async(x)=>{
    try{await clEnsureFresh();
      const r=await fetch(CLOUD.url+'/storage/v1/object/'+CLOUD.bucket+'/'+uid+'/'+x.aid,{method:'POST',headers:{'apikey':CLOUD.key,'Authorization':'Bearer '+CL.sess.access_token,'Content-Type':x.f.type||'image/jpeg','x-upsert':'false'},body:x.f});
      if(r.ok)ok++;else{const j=await clJson(r);if(r.status===400&&j&&/exists/i.test(String(j.message||j.error||'')))dup++;else ng++;}
    }catch(e){ng++;}
    i++;if(i%10===0||i===todo.length)clImpSay('📦 写真 '+i+'/'+todo.length+'（新規 '+ok+'・既にあった '+dup+'・失敗 '+ng+'）');
  };
  /* 4枚ずつ並行 */
  for(let p=0;p<todo.length;p+=4)await Promise.all(todo.slice(p,p+4).map(one));
  clImpSay('📦 写真の引っ越し：新規 '+ok+'・既にあった '+dup+'・失敗 '+ng+(skip?'・番号が合わず飛ばした '+skip:'')+'（全 '+todo.length+'）');
  PH.mem={};render();
}
function cloudStatusText(){
  const n=clDirtyCount();
  return (CL.err?('⚠ '+CL.err+'｜'):'')+(n?('未送信 '+n+'件'):'送信済み')+(CL.lastPull?('｜最終受信 '+new Date(CL.lastPull).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})):'');
}
/* ランプと診断帯：旧版の renderSync を包む（未ログイン＝灰色・タップでログイン） */
{
  const _rs=renderSync;
  renderSync=function(){
    unsynced=clDirtyCount()>0;
    localOnly=!(cloudConfigured()&&cloudLoggedIn());
    _rs();
    const d=$('syncdot');if(d){d.onclick=openLoginSheet;if(localOnly&&cloudConfigured())d.title='未ログイン（タップでログイン）';}
    const s=$('diagstrip');
    if(s&&cloudConfigured()&&!cloudLoggedIn()){s.style.display='';s.className='diagstrip';s.textContent='⚪ 未ログイン：この端末だけに保存中（タップしてログインすると全端末で同期）';s.onclick=openLoginSheet;}
    else if(s&&CL.err&&cloudLoggedIn()){s.style.display='';s.className='diagstrip';s.textContent='🟠 '+CL.err+'（記録は端末に保存済み。電波を確認）';s.onclick=openLoginSheet;}
  };
}
/* 保存のたびに dirty を更新して、1.5秒後に送る */
{
  const _sl=saveLocal;
  saveLocal=function(synced){
    _sl(synced);
    if(CL.ready&&clMarkDirty())scheduleSync(1500);
  };
}
/* 受信のきっかけ：画面に戻った・ネット復帰・60秒ごと */
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&cloudLoggedIn())scheduleSync(300);});
window.addEventListener('online',()=>{if(cloudLoggedIn())scheduleSync(500);});
setInterval(()=>{if(cloudLoggedIn()&&!document.hidden&&Date.now()-CL.lastPull>55000)cloudPull(false);},60000);
/* 起動：端末のデータで先に画面を出し、ログイン済みなら裏で受信→送信 */
let afterCloudReady=function(){};
async function cloudBoot(){
  CL.ready=true;
  clShadowFromState();
  if(clGet('hibiki-ver','')!==CL_APPVER){clSet('hibiki-ver',CL_APPVER);clSet(CL_PWDAY,null);}   /* 版が上がった＝今日のパスワード確認をやり直す */
  /* 前回までの未送信（dirty）はそのまま。影は今の state を基準にする */
  unsynced=clDirtyCount()>0;renderSync();
  if(!cloudConfigured())return;
  /* 起動した最初の画面：未ログインならログイン画面、ログイン済みでも今日まだならパスワード確認（自動ログインなら出さない）。
     起動フラッシュ（毎日のルールの画面）が出ている間は、閉じられてから出す */
  /* 本人の決め事（2026-10-03）：ログインは「毎日のルールの画面より前の、本当の最初」。起動フラッシュの上に重ねて出す */
  if(!cloudLoggedIn()||clDailyDue()){try{$('ovl').classList.add('cl-first');openLoginSheet();}catch(e){}}
  if(!cloudLoggedIn()){return;}
  await cloudSync();
}
