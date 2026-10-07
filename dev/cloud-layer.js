/* ===================== HIBIKI クラウド（Supabase）=====================
   旧版の「HTML全体を再公開して読み直す」方式をやめ、変わった項目だけをデータベースへ送る。
   合流の規則は旧版と同じ mergeStates（1件ずつ ts の新しい方が勝つ）。削除は del:1 の墓石。
   このブロックは build.js が boot(); の直前に差し込む。既存の名前（state・saveLocal・render・renderSync・
   unsynced・localOnly・permFail・schedulePublish・doPublish・getAssets・phUpload・toast・$）に乗る。
   c1.9（「保存しなくなる」の根絶）：
   ・全部の通信に時間制限。止まった同期は見張りが打ち切ってやり直す（フラグの固着をなくす）
   ・同期の入口は cloudSync の1本だけ。実行中に来た依頼は「もう1周」で拾う（捨てない）
   ・送信は全件受信を待たない。失敗したら 5秒→最大120秒の間隔で必ず再挑戦
   ・影（クラウドが持っている中身の署名）を IndexedDB に保存。未送信は毎回「影との差」で計算する
   ・整合の点検（件数と ts の合計）で黙った食い違いを見つけて直す
   ・画面を離れる瞬間に keepalive で送る。ログインの更新は1本にまとめ、別タブの更新を先に読む
   ・同期の記録（直近40件）を「保存ランプの意味」の画面に出す */
const CLOUD={url:'__SUPABASE_URL__',key:'__SUPABASE_KEY__',bucket:'photos'};
const CL_SESS='hibiki-session',CL_SYNC='hibiki-sync',CL_LOGK='hibiki-cl-log',CL_KA='hibiki-ka';
const CL_SHVER='c19-2';   /* 影の形式（署名の作り方）の版。変えたら影は作り直し */
const CL_KA_MAX=40000;    /* keepalive の本文の上限（バイト）。ブラウザの上限 64KB に余裕を見る */
const CL={sess:null,seq:0,dirty:{},shadow:{},shadowOk:false,uid:'',lastPull:0,lastPush:0,lastTry:0,err:'',lastErr:'',ready:false,trackHot:false,firstPull:false,
  photoQ:[],photoBusy:false,log:[],bad:{},hot:{},curSig:{},pushedDuring:{},full:null,retryAt:0,retryMs:5000,quietSave:false,
  T:{rpc:25000,rpcMax:60000,put:10000,putPer:5000,refresh:15000,photo:90000,store:3000,fresh:20000,lock:20000,watch:70000,pre:8000},
  chunkN:400,chunkBytes:200000,pullLim:500,mutSeq:0,tabId:Math.random().toString(36).slice(2,10),kaAt:0,authDead:false,auth401:0,
  integ:{at:0,res:'',sig:'',pend:'',rebuildAt:0,due:false},hiddenAt:0,storeOk:null,shadowLoadedAt:0,refreshP:null,persistT:null,outboxAt:0,perf:{},kaCheck:null,pendingChanged:false};
/* 同期の実行の管理（1本だけ走らせる）。epoch＝世代。打ち切った古い回は結果を使わない */
const CLQ={run:null,again:false,epoch:0,ctl:null,beat:0,fails:0,due:0,t:null,startedAt:0,wake:false,firstFailAt:0};
Object.defineProperty(CL,'busy',{get:()=>!!CLQ.run});
Object.defineProperty(CL,'pulling',{get:()=>!!CLQ.run});

function cloudConfigured(){return !!(CLOUD.url&&CLOUD.key&&CLOUD.url.indexOf('__')!==0&&/^https?:\/\//.test(CLOUD.url));}
function cloudLoggedIn(){return !!(CL.sess&&CL.sess.access_token&&CL.sess.user&&CL.sess.user.id);}
/* 同期の記録（直近40件）。端末に小さく残す＝止まった時に原因が1行で分かる */
function clNote(ev,msg){
  const e={t:Date.now(),ev:String(ev),msg:String(msg==null?'':msg).slice(0,160)};
  CL.log.push(e);if(CL.log.length>40)CL.log.splice(0,CL.log.length-40);
  try{localStorage.setItem(CL_LOGK,JSON.stringify(CL.log));}catch(x){}
}
function clSaveSess(){
  let ok=true;
  try{if(CL.sess)localStorage.setItem(CL_SESS,JSON.stringify(CL.sess));else localStorage.removeItem(CL_SESS);}catch(e){ok=false;}
  if(!ok)clNote('sess','セッション保存NG（端末の空き不足）');
  clStore.set('session',CL.sess||null);   /* IndexedDB にも控える（空き不足で古い合言葉に戻らないように） */
}
/* hibiki-sync：uid・最終受信・未送信の鍵（旧版 c1.8 に戻った時の保険。2000件まで）。受信位置 seq は影の側だけに持つ */
function clSaveSync(){
  const ks=Object.keys(CL.dirty),d={};if(ks.length<=2000)for(const k of ks)d[k]=1;
  try{localStorage.setItem(CL_SYNC,JSON.stringify({dirty:d,uid:CL.uid,lastPull:CL.lastPull}));}catch(e){}
}
function clLoad(){
  try{CL.sess=JSON.parse(localStorage.getItem(CL_SESS)||'null');}catch(e){CL.sess=null;}
  try{const s=JSON.parse(localStorage.getItem(CL_SYNC)||'null');if(s){CL.uid=s.uid||'';CL.lastPull=Number(s.lastPull)||0;
    for(const k in (s.dirty||{}))CL.hot[k]=1;}}catch(e){}   /* 前回の未送信の鍵＝影が無い時に先に送る候補 */
  try{const l=JSON.parse(localStorage.getItem(CL_LOGK)||'[]');if(Array.isArray(l))CL.log=l.slice(-40);}catch(e){}
}

/* ---------- 端末の控え（IndexedDB。使えない時はこの起動の間だけメモリ） ----------
   影は本文（localStorage）の容量を食わないよう localStorage には書かない。どの操作も3秒で諦める＝起動を止めない */
const clStore=(()=>{
  let dbP=null,deadUntil=0;const mem={};
  const open=()=>{
    if(typeof indexedDB==='undefined'||!indexedDB)return Promise.resolve(null);
    if(!dbP&&Date.now()<deadUntil)return Promise.resolve(null);   /* 直前に開けなかった（返事が来ない）＝しばらくはメモリだけで進む */
    if(!dbP)dbP=new Promise(res=>{let done=false;const fin=v=>{if(!done){done=true;res(v);}};
      try{const rq=indexedDB.open('hibiki-cl',1);
        rq.onupgradeneeded=()=>{try{if(!rq.result.objectStoreNames.contains('kv'))rq.result.createObjectStore('kv');}catch(e){}};
        rq.onsuccess=()=>{const db=rq.result;try{db.onclose=()=>{dbP=null;};db.onversionchange=()=>{try{db.close();}catch(e){}dbP=null;};}catch(e){}
          if(done){try{db.close();}catch(e){}}fin(db);};
        rq.onerror=()=>fin(null);rq.onblocked=()=>fin(null);setTimeout(()=>{if(!done)deadUntil=Date.now()+30000;fin(null);},CL.T.store);
      }catch(e){fin(null);}
    }).then(db=>{if(!db)dbP=null;return db;});
    return dbP;};
  /* undefined＝使えなかった（時間切れ・失敗）。null＝無い */
  const tx=(mode,fn)=>Promise.race([open().then(db=>{if(!db)return undefined;return new Promise(res=>{
      try{const t=db.transaction('kv',mode),s=t.objectStore('kv');let out=null;fn(s,v=>{out=v;});
        t.oncomplete=()=>res(out);t.onerror=()=>res(undefined);t.onabort=()=>res(undefined);}
      catch(e){dbP=null;res(undefined);}   /* 接続が死んでいる＝次は開き直す */
    });}),new Promise(r=>setTimeout(()=>r(undefined),CL.T.store))]);
  return {
    async get(k){const v=await tx('readonly',(s,set)=>{const r=s.get(k);r.onsuccess=()=>set(r.result===undefined?null:r.result);});
      if(v===undefined){CL.storeOk=false;return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:undefined;}CL.storeOk=true;return v;},
    async set(k,v){mem[k]=v;const r=await tx('readwrite',(s,set)=>{s.put(v,k);set(true);});if(r===undefined){CL.storeOk=false;return false;}CL.storeOk=true;return true;},
    /* 読んで書き直す（1つの取引の中で。別タブと同時に書いても片方が消えない） */
    async upd(k,fn){let nv;const r=await tx('readwrite',(s,set)=>{const g=s.get(k);g.onsuccess=()=>{nv=fn(g.result===undefined?null:g.result);s.put(nv,k);set(true);};});
      if(r===undefined){CL.storeOk=false;mem[k]=fn(Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null);return false;}CL.storeOk=true;mem[k]=nv;return true;}
  };
})();
clLoad();

/* ---------- 通信（どれも時間制限つき） ---------- */
function clErr(msg,status,code,kind){const e=new Error(msg);e.status=status||0;e.code=code||'';e.kind=kind||'net';return e;}
function clKindOf(status,code){
  if(status===401)return 'auth';
  if(status===413||(status===400&&/^(22|54)/.test(String(code||''))))return 'row';      /* 行の形が悪い＝その行だけ隔離する */
  if(status>=500||status===408||status===425||status===429)return 'server';
  return 'client';
}
/* fn(signal) を ms で打ち切る。本文を読み終えるまでを fn の中に入れること。parent が止まれば一緒に止まる */
function clTimed(ms,fn,parent){
  const ctl=new AbortController();let why='';
  const t=setTimeout(()=>{why='timeout';ctl.abort();},ms);
  const onP=()=>{why=why||'aborted';ctl.abort();};
  if(parent){if(parent.aborted)onP();else parent.addEventListener('abort',onP);}
  const mk=()=>why==='timeout'?clErr('timeout（'+Math.round(ms/1000)+'秒）',0,'timeout','timeout'):clErr('中断',0,'aborted','aborted');
  const dead=new Promise((_,rej)=>ctl.signal.addEventListener('abort',()=>rej(mk())));
  dead.catch(()=>{});
  return Promise.race([Promise.resolve().then(()=>fn(ctl.signal)),dead])
    .catch(e=>{if(ctl.signal.aborted)throw mk();if(e&&e.kind)throw e;throw clErr(String((e&&e.message)||'通信失敗'),0,'net','net');})
    .finally(()=>{clearTimeout(t);if(parent)parent.removeEventListener('abort',onP);});
}
function clHdr(){const h={'apikey':CLOUD.key,'Content-Type':'application/json','x-client-info':'hibiki/'+CL_APPVER};if(CL.sess&&CL.sess.access_token)h['Authorization']='Bearer '+CL.sess.access_token;return h;}
/* 応答を読み切って {status,ok,text()} の形で返す（旧 clFetch と同じ使い方ができる） */
async function clFetch(path,opt,noAuth){
  opt=opt||{};
  const go=()=>clTimed(CL.T.rpc,s=>{const h=Object.assign({'apikey':CLOUD.key,'Content-Type':'application/json'},opt.headers||{});
      if(!noAuth&&CL.sess&&CL.sess.access_token)h['Authorization']='Bearer '+CL.sess.access_token;
      return fetch(CLOUD.url+path,Object.assign({},opt,{headers:h,signal:s})).then(async r=>{const t=await r.text();return {status:r.status,ok:r.ok,text:()=>Promise.resolve(t)};});});
  let r=await go();
  if(r.status===401&&!noAuth&&CL.sess&&CL.sess.refresh_token){if(await clRefresh())r=await go();}
  return r;
}
async function clJson(r){const t=await r.text();try{return t?JSON.parse(t):null;}catch(e){return {raw:t};}}
async function clLogin(email,password){
  const r=await clFetch('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})},true);
  const j=await clJson(r);
  if(!r.ok||!j||!j.access_token){const m=(j&&(j.msg||j.message||j.error_description||j.error))||('HTTP '+r.status);throw new Error(m);}
  CL.sess={access_token:j.access_token,refresh_token:j.refresh_token,expires_at:(j.expires_at||0)*1000,user:j.user};
  CL.authDead=false;CL.auth401=0;
  clSaveSess();clNote('login','ログインした');return CL.sess.user;
}
function clReadSessLS(){try{return JSON.parse(localStorage.getItem(CL_SESS)||'null');}catch(e){return null;}}
/* 別タブ（同じ端末）が先に更新した合言葉があれば、それを採る（更新用の合言葉は使い捨て＝二重に使うと失効する） */
function clAdoptOther(){
  const ls=clReadSessLS();
  if(ls&&ls.user&&ls.access_token&&ls.refresh_token&&CL.sess&&CL.sess.user&&ls.user.id===CL.sess.user.id&&
     ls.refresh_token!==CL.sess.refresh_token&&(ls.expires_at||0)>Date.now()+60000){CL.sess=ls;clNote('refresh','別タブの新しい合言葉を採用');return true;}
  return false;
}
/* ログインの更新：1本にまとめ（同じタブの同時呼び出しは相乗り）、別タブとは navigator.locks で順番に */
async function clRefresh(){
  if(!CL.sess||!CL.sess.refresh_token)return false;
  if(CL.refreshP)return CL.refreshP;
  CL.refreshP=(async()=>{try{return await clRefreshLocked();}catch(e){return false;}finally{CL.refreshP=null;}})();
  return CL.refreshP;
}
async function clRefreshLocked(){
  const run=async()=>{
    if(!CL.sess||!CL.sess.refresh_token)return false;
    if(clAdoptOther())return true;   /* 先に読む＝合言葉を無駄に使わない */
    let r,j;
    try{r=await clTimed(CL.T.refresh,s=>fetch(CLOUD.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'apikey':CLOUD.key,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:CL.sess.refresh_token}),signal:s}).then(async x=>({status:x.status,ok:x.ok,text:await x.text()})));}
    catch(e){clNote('refresh','更新失敗（'+e.message+'）。合言葉は残す');return false;}   /* 回線・時間切れではセッションを消さない */
    try{j=r.text?JSON.parse(r.text):null;}catch(e){j=null;}
    if(r.ok&&j&&j.access_token){
      CL.sess={access_token:j.access_token,refresh_token:j.refresh_token||CL.sess.refresh_token,expires_at:(j.expires_at||0)*1000,user:j.user||CL.sess.user};
      CL.authDead=false;clSaveSess();clNote('refresh','合言葉を更新');return true;}
    if(r.status===400||r.status===401||r.status===403){
      if(clAdoptOther())return true;   /* その間に別タブが更新していた */
      if(/refresh_token_not_found|refresh_token_already_used|invalid_grant|Invalid Refresh Token|session_not_found/i.test(r.text||'')){
        /* 本当に無効：合言葉だけ捨てる。ユーザー（影の鍵）・未送信・記録は残す。ログインし直せば続きから */
        CL.sess={user:CL.sess.user,access_token:'',refresh_token:'',expires_at:0,dead:1};CL.authDead=false;
        clSaveSess();clNote('auth','ログインが切れた（要ログイン）');try{renderSync();}catch(e){}
        return false;}
    }
    clNote('refresh','更新失敗 HTTP '+r.status+'。合言葉は残す');return false;
  };
  if(typeof navigator!=='undefined'&&navigator.locks&&navigator.locks.request){
    const ac=new AbortController();const t=setTimeout(()=>ac.abort(),CL.T.lock);
    let got=false;
    try{return await navigator.locks.request('hibiki-refresh',{signal:ac.signal},()=>{got=true;clearTimeout(t);return run();});}
    catch(e){if(got)return false;clearTimeout(t);return run();}   /* 鍵が取れない・使えない（file:// など）＝鍵なしで続ける */
  }
  return run();
}
async function clEnsureFresh(){
  /* 期限の10分前から先回りで更新。隠れている時は（まだ切れていなければ）始めない。最大20秒で諦めて今の合言葉で送る */
  if(!CL.sess||!CL.sess.expires_at||!CL.sess.refresh_token)return;
  const left=CL.sess.expires_at-Date.now();
  if(left>600000)return;
  if(typeof document!=='undefined'&&document.hidden&&left>30000)return;
  await Promise.race([clRefresh(),new Promise(r=>setTimeout(()=>r(false),CL.T.fresh))]);
}
async function clLogout(){
  CLQ.epoch++;try{if(CLQ.ctl)CLQ.ctl.abort();}catch(e){}CLQ.run=null;
  try{await clFetch('/auth/v1/logout',{method:'POST'});}catch(e){}
  CL.sess=null;clSaveSess();clNote('login','ログアウト');renderSync();
}
function clRpcMs(){return Math.min(CL.T.rpcMax,Math.round(CL.T.rpc*(1+0.6*Math.min(CLQ.fails,2))));}   /* 失敗が続くと 25→40→55秒 */
/* put_items の時間制限：10秒＋本文5万字ごとに5秒（1件の保存は10秒で見切る）。失敗が続くと伸ばす */
function clPutMs(n){return Math.min(CL.T.rpcMax,Math.round((CL.T.put+CL.T.putPer*Math.floor((Number(n)||0)/50000))*(1+0.6*Math.min(CLQ.fails,2))));}
/* RPC を1回（401 なら更新して1回だけやり直す）。body は文字列。送る中身はこの関数に入る前に確定させる */
async function clRpcText(name,body,sig,ms){
  await clEnsureFresh();
  const url=CLOUD.url+'/rest/v1/rpc/'+name;
  const go=()=>{CLQ.beat=Date.now();return clTimed(ms||clRpcMs(),s=>fetch(url,{method:'POST',headers:clHdr(),body,signal:s}).then(async r=>({status:r.status,ok:r.ok,text:await r.text()})),sig);};
  let r=await go(),rf=null;
  if(r.status===401&&CL.sess&&CL.sess.refresh_token){rf=await clRefresh();if(rf)r=await go();}
  if(!r.ok){
    let j=null;try{j=JSON.parse(r.text);}catch(e){}
    const m=(j&&(j.message||j.msg||j.error||j.hint))||('HTTP '+r.status);const code=(j&&j.code!=null)?String(j.code):'';
    if(r.status===401){CL.auth401++;
      /* 更新が一時失敗（回線・5xx・時間切れ）＝合言葉はまだ生きている。ふつうの間隔で再挑戦する（止めない） */
      if(rf===false&&cloudLoggedIn()){clNote('auth','401・合言葉の更新が一時失敗 → 間隔をあけて再挑戦');throw clErr(m,r.status,code,'server');}}
    throw clErr(m,r.status,code,clKindOf(r.status,code));
  }
  CL.auth401=0;
  return r.text;
}
async function clRpcJson(name,body,sig,ms){const t=await clRpcText(name,typeof body==='string'?body:JSON.stringify(body||{}),sig,ms);try{return t?JSON.parse(t):null;}catch(e){throw clErr('応答が読めない',0,'parse','server');}}
async function clRpc(name,body){return clRpcJson(name,body);}   /* 旧版と同じ名前（他から呼ばれても動く） */

/* ---------- state ⇄ 項目（1行） ---------- */
const CL_ID=['dreams','memos','pays','aims','moves','pins','steps','payrep','rtn','rlog','payppl','pha','kinds','tools','places','projects','marks','bedp','arp','todos','plreg','plgrp'];   /* c7.9：todos＝📋やる事 */   /* c4.8：arp＝場所ごとの区・市町村 */   /* c4.7：marks＝🕳️😤😫の申告、bedp＝場所ごとの🛏️/🪑 */
const CL_DAY=['ai','rules','scr'];   /* c4.7：scr＝夜に入れる📲📞の数字（日ごと） */
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
const clClean=s=>(typeof s==='string'&&s.indexOf('\u0000')>=0)?s.replace(/\u0000/g,''):s;   /* \u0000 はクラウド（jsonb）に入らない＝送る分だけ除く */
const clKey=it=>clClean(String(it.coll))+'\u0000'+clClean(String(it.k));
const clTsOf=ts=>{const n=Number(ts);return isFinite(n)?Math.max(0,Math.floor(n)):0;};   /* サーバーと同じ丸め（負→0・小数→切り捨て） */
/* 署名＝ts と中身のハッシュ（53bit・cyrb53 を流し込み式で）。キーの順に依存しない（jsonb はキー順を並べ替えて返すので、
   そのままの JSON.stringify では同じ中身でも食い違う）。\u0000 は数えない（送る時に除くので、戻ってきた版と同じ署名になる）。
   区切りに 65536 以上の値（文字には出てこない）を使う＝文字列の中身と区切りが混ざらない */
let CL_H1=0,CL_H2=0;
function clHc(c){CL_H1=Math.imul(CL_H1^c,2654435761);CL_H2=Math.imul(CL_H2^c,1597334677);}
function clHs(s){for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c!==0){CL_H1=Math.imul(CL_H1^c,2654435761);CL_H2=Math.imul(CL_H2^c,1597334677);}}}
function clHv(v){
  switch(typeof v){
    case 'string':clHs(v);clHc(65537);return true;
    case 'number':clHs(isFinite(v)?''+v:'null');clHc(65538);return true;
    case 'boolean':clHc(v?65539:65540);return true;
    case 'object':
      if(v===null){clHc(65541);return true;}
      if(typeof v.toJSON==='function')return clHv(v.toJSON());
      if(Array.isArray(v)){clHc(65542);for(let i=0;i<v.length;i++){if(!clHv(v[i]))clHc(65541);}clHc(65543);return true;}
      {const ks=Object.keys(v);if(ks.length>1)ks.sort();clHc(65544);
        for(let i=0;i<ks.length;i++){const x=v[ks[i]],t=typeof x;if(x===undefined||t==='function'||t==='symbol')continue;clHs(ks[i]);clHc(65545);clHv(x);}
        clHc(65546);return true;}
    default:return false;   /* undefined・関数（JSON に出ない物） */
  }
}
function clHashOf(ts,d){
  CL_H1=0xdeadbeef;CL_H2=0x41c6ce57;clHs(''+ts);clHc(65547);if(!clHv(d))clHc(65548);
  const h1=Math.imul(CL_H1^(CL_H1>>>16),2246822507)^Math.imul(CL_H2^(CL_H2>>>13),3266489909);
  const h2=Math.imul(CL_H2^(CL_H2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(36);
}
const CL_SIGC=new WeakMap();   /* 項目オブジェクト→{ts,指紋,署名}。ts と指紋が同じなら計算し直さない（保存のたびに軽く） */
/* 指紋＝1段目のキーと値の形（文字列は長さと先頭・中央・末尾の文字、配列は長さ、物はキー数）。中身の全部は見ない＝速い */
function clFp(d){
  let n=0,f=0;
  for(const k in d){const v=d[k];let x;n++;
    switch(typeof v){
      case 'string':{const L=v.length;x=L*31+(L?v.charCodeAt(0)+v.charCodeAt(L-1)*7+v.charCodeAt(L>>1)*3:0);break;}
      case 'number':x=(v===v&&v!==Infinity&&v!==-Infinity)?(v%1000003):1;break;   /* 大域の関数を使わない（速さ） */
      case 'boolean':x=v?3:5;break;
      case 'object':if(!v){x=9;break;}if(Array.isArray(v)){x=v.length*13+7;break;}x=11;for(const j in v)x+=17;break;
      default:x=2;}
    f=(f*31+x+k.length*101)|0;}
  return n*1000003+f;
}
function clSigOf(it,fresh){
  const d=it.data,ts=clTsOf(it.ts);
  const fp=(d&&typeof d==='object')?clFp(d):0;
  if(!fresh&&fp){const c=CL_SIGC.get(d);if(c&&c.ts===ts&&c.fp===fp)return c.h;}
  const h=clHashOf(ts,d);
  if(fp)CL_SIGC.set(d,{ts,fp,h});
  return h;
}
function clSig(it){return clSigOf(it,true);}   /* 旧版と同じ名前 */
function clCleanDeep(v){if(typeof v==='string')return clClean(v);if(!v||typeof v!=='object')return v;if(Array.isArray(v))return v.map(clCleanDeep);const o={};for(const k in v)o[clClean(k)]=clCleanDeep(v[k]);return o;}
function clHasNul(v){if(typeof v==='string')return v.indexOf('\u0000')>=0;if(!v||typeof v!=='object')return false;if(Array.isArray(v)){for(const x of v)if(clHasNul(x))return true;return false;}for(const k in v){if(k.indexOf('\u0000')>=0||clHasNul(v[k]))return true;}return false;}
/* 送る1行（端末の state は触らず、送る分だけ掃除する） */
function clRowOf(it){return {coll:clClean(String(it.coll)),k:clClean(String(it.k)),ts:clTsOf(it.ts),data:clHasNul(it.data)?clCleanDeep(it.data):it.data};}
const CL_KNOWN_TOP={updatedAt:1,dream:1,entries:1,plans:1,ai:1,dreams:1,memos:1,life:1,photos:1,pha:1,pays:1,rules:1,aims:1,moves:1,pins:1,steps:1,payrep:1,rtn:1,rlog:1,payppl:1,kinds:1,tools:1};
const CL_COLLS=new Set(CL_ID.concat(CL_DAY,CL_DAY2,['_top']));
/* 受け取った行が state に入る形か（clItems の逆と同じ条件）。入らない行は影にも入れない＝件数の比べ合いで迷わない */
function clRowUsable(r){
  const c=r.coll,d=r.data;
  if(CL_DAY2.indexOf(c)>=0)return String(r.k).indexOf('/')>0&&!!d&&typeof d==='object';
  if(c==='pha')return !!(d&&d.a);
  if(CL_DAY.indexOf(c)>=0||CL_ID.indexOf(c)>=0)return !!d&&typeof d==='object';
  if(c==='_top'){if(CL_SKIP[r.k]||CL_DAY2.indexOf(r.k)>=0||CL_DAY.indexOf(r.k)>=0||CL_ID.indexOf(r.k)>=0)return false;
    const v=(d&&typeof d==='object'&&'v' in d&&Object.keys(d).length===1)?d.v:d;return v!=null;}
  return false;
}
/* 鍵から端末の1項目（clItems と同じ形）を取る */
function clItemByKey(key){
  const i=key.indexOf('\u0000');if(i<0)return null;const c=key.slice(0,i),k=key.slice(i+1);
  if(CL_DAY2.indexOf(c)>=0){const j=k.indexOf('/');if(j<0)return null;const v=state[c]&&state[c][k.slice(0,j)]&&state[c][k.slice(0,j)][k.slice(j+1)];return (v&&typeof v==='object')?{coll:c,k,ts:Number(v.ts)||0,data:v}:null;}
  if(CL_DAY.indexOf(c)>=0){const v=state[c]&&state[c][k];return (v&&typeof v==='object')?{coll:c,k,ts:Number(v.ts)||0,data:v}:null;}
  if(c==='pha'){const v=state.pha&&state.pha[k];return v!=null?{coll:c,k,ts:1,data:{a:v}}:null;}
  if(CL_ID.indexOf(c)>=0){const v=state[c]&&state[c][k];return (v&&typeof v==='object')?{coll:c,k,ts:Number(v.ts)||0,data:v}:null;}
  if(c==='_top'){if(CL_SKIP[k]||!CL_COLLS.has(c))return null;const v=state[k];if(v==null||CL_DAY2.indexOf(k)>=0||CL_DAY.indexOf(k)>=0||CL_ID.indexOf(k)>=0)return null;
    return {coll:c,k,ts:(typeof v==='object'&&Number(v.ts))||0,data:(typeof v==='object')?v:{v}};}
  return null;
}
function clLocalRef(c,k){
  if(CL_DAY2.indexOf(c)>=0){const j=String(k).indexOf('/');const d=state[c]&&state[c][k.slice(0,j)];return d?d[k.slice(j+1)]:undefined;}
  if(c==='_top')return state[k];
  return state[c]?state[c][k]:undefined;
}

/* ---------- 未送信（dirty）＝影との差 ----------
   影（CL.shadow）＝「クラウドが持っていると分かっている中身」の署名。影が無い間（作成中）は、
   この起動で書いた項目（hot）だけを送る。dirty はメモリだけ（毎回計算し直すので、消えても次の起動で見つかる） */
function clItemSkip(it,k,h){
  const b=CL.bad[k];if(b&&b.h===h)return true;   /* 送れない行として隔離中（中身が変われば外れる） */
  /* ts の無い設定値（pha・_cfg など）は、クラウドに既にあるなら送らない＝2台で上書きし合わない */
  if(clTsOf(it.ts)<=1&&CL.shadow[k]!==undefined&&it.coll!=='pays'&&it.coll!=='steps')return true;
  return false;
}
function clIsDirty(it,k,h){return (CL.shadowOk||!!CL.hot[k])&&CL.shadow[k]!==h&&!clItemSkip(it,k,h);}
/* 全項目を比べ直す（起動時・受信後）。fresh＝署名を全部計算し直す */
function clRecomputeDirty(fresh){
  const t0=Date.now(),nd={};
  for(const it of clItems(state)){const k=clKey(it),h=clSigOf(it,!!fresh);CL.curSig[k]=h;if(clIsDirty(it,k,h))nd[k]=1;}
  CL.dirty=nd;CL.perf.recompute=Date.now()-t0;clSaveSync();
}
/* 一部の鍵だけ比べ直す（送信が通った後） */
function clRecomputeKeys(keys){
  for(const k of keys){const it=clItemByKey(k);if(!it){delete CL.dirty[k];continue;}const h=clSigOf(it,false);if(clIsDirty(it,k,h))CL.dirty[k]=1;else delete CL.dirty[k];}
}
/* 保存のたび：変わった項目を hot に入れ、dirty を作り直す（署名は前回と同じ物を使い回すので軽い） */
function clMarkDirty(){
  if(!CL.trackHot)return 0;
  CL.mutSeq++;
  const t0=Date.now(),now=Date.now(),nd={};let n=0;
  for(const it of clItems(state)){const k=clKey(it),h=clSigOf(it,false);
    if(CL.curSig[k]!==h){CL.curSig[k]=h;CL.hot[k]=now;}
    if(CL.ready&&clIsDirty(it,k,h)){nd[k]=1;n++;}}
  if(CL.ready){CL.dirty=nd;clSaveSync();}
  CL.perf.mark=Date.now()-t0;
  if(typeof localSaveFail!=='undefined'&&localSaveFail)clOutbox();
  return n;
}
function clDirtyCount(){return Object.keys(CL.dirty).length;}
/* 起動時：全項目の署名（以後の保存で「何が変わったか」を見るための基準） */
function clBaseSigs(){const t0=Date.now();for(const it of clItems(state))CL.curSig[clKey(it)]=clSigOf(it,true);CL.perf.baseSigs=Date.now()-t0;}

/* 端末の本文が保存できない時（容量不足）だけ、書いた項目の中身を IndexedDB に退避する。次の起動で戻して送る */
function clOutbox(){
  if(!CL.uid||Date.now()-CL.outboxAt<2000)return;CL.outboxAt=Date.now();
  const rows={};for(const k in CL.hot){const it=clItemByKey(k);if(it)rows[k]=clRowOf(it);}
  if(!Object.keys(rows).length)return;
  clStore.upd('outbox:'+CL.uid,cur=>{const o=(cur&&cur.rows)||{};Object.assign(o,rows);return {rows:o,at:Date.now()};});
  clNote('outbox','端末保存に失敗中：'+Object.keys(rows).length+'件を退避');
}
async function clOutboxRestore(){
  if(!CL.uid)return;
  const ob=await clStore.get('outbox:'+CL.uid);if(!ob||!ob.rows)return;
  const rows=Object.values(ob.rows).filter(r=>r&&r.coll&&clRowUsable(r));if(!rows.length)return;
  state=mergeStates(state,clRowsToState(rows));
  for(const r of rows)CL.hot[clKey(r)]=Date.now();
  CL.outboxKeys=Object.keys(ob.rows);
  clNote('outbox','退避した '+rows.length+'件を戻した');
}
function clOutboxPrune(){
  if(!CL.outboxKeys||!CL.outboxKeys.length||!CL.uid)return;
  const left=CL.outboxKeys.filter(k=>CL.dirty[k]||CL.hot[k]);
  if(left.length===CL.outboxKeys.length)return;
  const keep=new Set(left);CL.outboxKeys=left;
  clStore.upd('outbox:'+CL.uid,cur=>{const o={};for(const k in ((cur&&cur.rows)||{}))if(keep.has(k))o[k]=cur.rows[k];return {rows:o,at:Date.now()};});
}

/* ---------- 影の保存（IndexedDB）と読み込み ---------- */
async function clLoadShadow(uid){
  CL.uid=uid;CL.shadowFor=uid;CL.shadow={};CL.seq=0;CL.shadowOk=false;CL.full=null;CL.pushedDuring={};CL.bad={};
  const rec=await clStore.get('shadow:'+uid);
  if(rec&&rec.ver===CL_SHVER&&rec.uid===uid&&rec.map&&typeof rec.map==='object'&&Number(rec.seq)>0){CL.shadow=rec.map;CL.seq=Number(rec.seq);CL.shadowOk=true;}
  CL.shadowLoadedAt=Date.now();
  if(CL.shadowOk){
    /* 影にあって端末に無い項目＝受信した中身を本文に保存できなかった → 全件受信で取り直す */
    const have=new Set();for(const it of clItems(state))have.add(clKey(it));
    let miss=0;for(const k in CL.shadow){if(!have.has(k)&&CL_COLLS.has(k.slice(0,k.indexOf('\u0000'))))miss++;}
    if(miss){clNote('shadow','影にあって端末に無い '+miss+'件 → 全件受信で取り直す');CL.full={since:0,nsh:{},rebuild:true};}
  }
  clSaveSync();
}
function clPersistSoon(){clearTimeout(CL.persistT);CL.persistT=setTimeout(()=>{clPersist();},2000);}
async function clPersist(){
  if(!CL.uid||!CL.shadowOk||CL.seq<=0)return false;
  if(typeof localSaveFail!=='undefined'&&localSaveFail){   /* 本文が置けていない＝受信位置を進めて保存すると、その行を二度と取りに来ない */
    if(!CL.persistWarned){CL.persistWarned=1;clNote('shadow','端末保存に失敗中のため、影と受信位置は保存しない');}return false;}
  CL.persistWarned=0;
  const uid=CL.uid,map=CL.shadow,seq=CL.seq,loaded=CL.shadowLoadedAt,me=CL.tabId;
  return clStore.upd('shadow:'+uid,cur=>{
    let m=map,s=seq;
    /* 別タブが後から書いていた：両方で一致する所だけ残す（影は「クラウドにある」と確かな物だけ＝足りない分は送り直すだけで安全） */
    if(cur&&cur.ver===CL_SHVER&&cur.writer&&cur.writer!==me&&(cur.savedAt||0)>loaded&&cur.map){m={};for(const k in map)if(cur.map[k]===map[k])m[k]=map[k];s=Math.min(seq,Number(cur.seq)||0);}
    return {ver:CL_SHVER,uid,seq:s,map:m,writer:me,savedAt:Date.now()};
  });
}

/* ---------- 送信 ---------- */
function clApplyPushed(keys,hs){
  keys.forEach((k,j)=>{CL.shadow[k]=hs[j];if(CL.full)CL.pushedDuring[k]=hs[j];if(CL.hot[k]&&CL.curSig[k]===hs[j])delete CL.hot[k];});
  clRecomputeKeys(keys);clSaveSync();clPersistSoon();clOutboxPrune();
}
/* 1束を送る。行の形が悪くて拒否されたら半分ずつに割って犯人の行だけ隔離し、残りは流す */
async function clPutSafe(part,rs,hs,ep,sig){
  let n;
  const body='{"rows":['+rs.join(',')+']}';
  try{n=await clRpcJson('put_items',body,sig,clPutMs(body.length));}
  catch(e){
    if(e.kind!=='row')throw e;
    if(ep!==CLQ.epoch)return false;
    if(part.length===1){const k=clKey(part[0]);CL.bad[k]={h:hs[0],msg:e.message,at:Date.now()};delete CL.dirty[k];
      clNote('quarantine','送れない行：'+k.replace('\u0000','/')+'（'+e.message+'）');return 0;}
    const m=part.length>>1;
    const a=await clPutSafe(part.slice(0,m),rs.slice(0,m),hs.slice(0,m),ep,sig);if(a===false)return false;
    const b=await clPutSafe(part.slice(m),rs.slice(m),hs.slice(m),ep,sig);if(b===false)return false;
    return a+b;
  }
  if(ep!==CLQ.epoch)return false;
  clApplyPushed(part.map(clKey),hs);
  return Number(n)||0;
}
async function clPushStep(ep,sig){
  const keys=Object.keys(CL.dirty);if(!keys.length)return 0;
  const want=new Set(keys),items=[];
  for(const it of clItems(state)){if(want.has(clKey(it)))items.push(it);}
  items.sort((a,b)=>(CL.hot[clKey(b)]||0)-(CL.hot[clKey(a)]||0));   /* いま書いた物から先に */
  let i=0,sent=0,wrote=0,shrink=0;
  while(i<items.length){
    /* 束：件数 chunkN 以内・本文 chunkBytes 以内。本文と署名はここで同時に確定（送信中の編集は次の回で送る） */
    const part=[],rs=[],hs=[];let bytes=0;
    while(i+part.length<items.length&&part.length<CL.chunkN){
      const it=items[i+part.length],s=JSON.stringify(clRowOf(it));
      if(part.length&&bytes+s.length>CL.chunkBytes)break;
      part.push(it);rs.push(s);hs.push(clSigOf(it,true));bytes+=s.length;}
    let n;
    try{n=await clPutSafe(part,rs,hs,ep,sig);}
    catch(e){
      if(e.kind==='timeout'&&part.length>25&&shrink<2&&ep===CLQ.epoch){shrink++;CL.chunkN=Math.max(25,part.length>>1);CL.chunkBytes=Math.max(30000,CL.chunkBytes>>1);
        clNote('push','時間切れ → 束を '+CL.chunkN+' 件に縮めて再挑戦');continue;}
      throw e;}
    if(n===false)return false;
    i+=part.length;sent+=part.length;wrote+=n;CLQ.beat=Date.now();
  }
  if(!shrink){CL.chunkN=Math.min(400,CL.chunkN*2);CL.chunkBytes=Math.min(200000,CL.chunkBytes*2);}
  CL.lastPush=Date.now();
  clNote('push','送信 '+sent+'件（新しく書いた '+wrote+'件）');
  return sent;
}

/* ---------- 受信 ---------- */
/* 受け取った行を影に入れて state へ合流。端末の中身が変わったかを返す（JSON.stringify(state) の前後比較はしない） */
function clMergeRows(rows,full){
  const tgt=full?CL.full.nsh:CL.shadow,use=[],echo={};
  for(const r of rows){if(!r||!r.coll||!clRowUsable(r))continue;const k=clKey(r),sg=clSigOf({ts:r.ts,data:r.data},true);
    if(CL.shadowOk&&CL.shadow[k]===sg)echo[k]=1;   /* クラウドの中身は知っている通り（自分の送信のこだま等）＝新しい事は何も無い */
    tgt[k]=sg;use.push(r);}
  if(!use.length)return false;
  const part=clRowsToState(use);
  const refs=use.map(r=>clLocalRef(r.coll,r.k));
  state=mergeStates(state,part);
  /* mergeStates が知らない上位項目（_cfg など）は「端末が常に勝つ」ので、ts で新しい方を採る */
  const tsOf=v=>(v&&typeof v==='object')?(Number(v.ts)||0):0;
  for(const k in part){if(CL_KNOWN_TOP[k])continue;const c=part[k],l=state[k];if(l===undefined||tsOf(c)>tsOf(l))state[k]=c;}
  let changed=false,tie=0;
  use.forEach((r,i)=>{
    const now=clLocalRef(r.coll,r.k);if(now!==refs[i])changed=true;
    /* 同じ ts で中身が違う（払った印などの合流が要る pays・steps 以外）＝送り合いにしない。端末の中身を影とみなす */
    if(r.coll!=='pays'&&r.coll!=='steps'){const k=clKey(r),it=clItemByKey(k);
      if(it&&clTsOf(it.ts)===clTsOf(r.ts)&&!echo[k]){const h=clSigOf(it,false);if(h!==tgt[k]){tgt[k]=h;tie++;}}}   /* こだまの時は端末の書き換えを未送信のまま残す */
  });
  if(tie)CL.tieN=(CL.tieN||0)+tie;
  return changed;
}
async function clPullStep(ep,sig,ms){
  const full=!!CL.full;let since=full?CL.full.since:CL.seq,changed=false,got=0,guard=0;
  while(guard++<1000){
    let rows;
    try{rows=await clRpcJson('pull_items',{since_seq:since,lim:CL.pullLim},sig,ms);if(CL.pullLim<500)CL.pullLim=Math.min(500,CL.pullLim*2);}   /* 通ったら次は大きく取る（縮んだままにしない） */
    catch(e){if(e.kind==='timeout'&&CL.pullLim>100)CL.pullLim=Math.max(100,CL.pullLim>>1);   /* 時間切れ＝次は小さく取る */
      clPullFlush();throw e;}   /* 途中で失敗しても、合流済みの行は画面と端末に出してから抜ける */
    if(ep!==CLQ.epoch){clPullFlush();return false;}
    if(!Array.isArray(rows)){clPullFlush();throw clErr('受信の形が違う',0,'parse','server');}
    if(!rows.length)break;   /* 0件が返るまで回す（返った件数 < lim で終わりと決めない） */
    CLQ.beat=Date.now();
    if(clMergeRows(rows,full)){changed=true;CL.pendingChanged=true;}   /* 合流した事実は失敗をまたいで持つ */
    for(const r of rows){const s=Number(r&&r.seq)||0;if(s>since)since=s;}
    if(full)CL.full.since=since;else CL.seq=Math.max(CL.seq,since);
    got+=rows.length;
  }
  let fullDone=false;
  if(full){   /* 最後まで読めた時だけ影を差し替える（途中で失敗したら続きから） */
    CL.shadow=Object.assign(CL.full.nsh,CL.pushedDuring);CL.pushedDuring={};CL.seq=Math.max(CL.seq,since);
    const rb=CL.full.rebuild;CL.full=null;CL.shadowOk=true;fullDone=true;
    clNote('pull','全件受信 完了 '+got+'件'+(rb?'（照合し直し）':''));
  }else if(got)clNote('pull','受信 '+got+'件');
  CL.lastPull=Date.now();
  if(CL.kaCheck)clKaVerify();
  if(changed||CL.pendingChanged){changed=true;try{cfgApply();}catch(e){}}
  clRecomputeDirty(fullDone);
  if(changed){CL.pendingChanged=false;
    CL.quietSave=true;
    try{saveLocal(clDirtyCount()===0);}catch(e){clNote('save','端末保存で例外：'+e.message);}finally{CL.quietSave=false;}
    try{render();}catch(e){clNote('render','描画で例外：'+e.message);}
  }else{try{renderSync();}catch(e){}}
  clPersistSoon();
  if(!CL.firstPull&&CL.shadowOk){CL.firstPull=true;try{afterCloudReady();}catch(e){clNote('ready','起動後の修復で例外：'+e.message);}}
  return {got,fullDone};
}

/* 受信の途中で失敗した時：state に合流済みの行があれば、描画と端末保存だけ先にやる（受信位置は進んでいる＝取り直しに来ない） */
function clPullFlush(){
  if(!CL.pendingChanged)return;
  CL.pendingChanged=false;
  try{cfgApply();}catch(e){}
  try{clRecomputeDirty(false);}catch(e){}
  CL.quietSave=true;
  try{saveLocal(clDirtyCount()===0);}catch(e){clNote('save','端末保存で例外：'+e.message);}finally{CL.quietSave=false;}
  try{render();}catch(e){clNote('render','描画で例外：'+e.message);}
  clNote('pull','受信の途中で失敗。合流済みの分は画面と端末に保存した');
}
/* 前回の離脱時の keepalive が届いていたかを、起動後の最初の受信で確かめて記録に残す（iPhone 実機で効いているかの実測） */
function clKaVerify(){
  const ka=CL.kaCheck;CL.kaCheck=null;try{localStorage.removeItem(CL_KA);}catch(e){}
  const ks=Array.isArray(ka.keys)?ka.keys:[];if(!ks.length)return;
  let got=0;for(const k of ks){const it=clItemByKey(k);const tgt=CL.full?CL.full.nsh:CL.shadow;if(it&&tgt[k]===clSigOf(it,true))got++;}
  clNote('keepalive','前回の離脱時の kA '+ka.n+'件 → クラウドに届いていた '+got+'/'+ks.length+'件');
}
/* ---------- 整合の点検（件数と ts の合計を、クラウドと端末で比べる） ---------- */
async function clIntegrity(ep,sig){
  if(clDirtyCount()>0||CL.full)return 'skip';
  const mut=CL.mutSeq;
  const txt=await clRpcText('integrity','{}',sig);
  if(ep!==CLQ.epoch)return 'skip';
  if(CL.mutSeq!==mut||clDirtyCount()>0)return 'skip';   /* 比べている間に書いた＝今回は比べない */
  /* tsum は 2^53 を超える＝文字列のまま BigInt で読む */
  const srv={};for(const m of String(txt).match(/\{[^{}]*\}/g)||[]){const c=/"coll"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m),n=/"n"\s*:\s*(\d+)/.exec(m),t=/"tsum"\s*:\s*(-?\d+)/.exec(m);
    if(c&&n&&t){let name;try{name=JSON.parse('"'+c[1]+'"');}catch(e){name=c[1];}srv[name]={n:Number(n[1]),t:BigInt(t[1])};}}
  const lim=Date.now()+3600000,loc={};
  for(const it of clItems(state)){const k=clKey(it);if(CL.bad[k])continue;const c=loc[it.coll]||(loc[it.coll]={n:0,t:0n});c.n++;c.t+=BigInt(Math.min(clTsOf(it.ts),lim));}
  const bad=[];
  for(const c of new Set(Object.keys(srv).concat(Object.keys(loc)))){if(!CL_COLLS.has(c))continue;const a=srv[c]||{n:0,t:0n},b=loc[c]||{n:0,t:0n};
    if(a.n!==b.n||a.t!==b.t)bad.push(c+'(雲'+a.n+'/端'+b.n+')');}
  CL.integ.at=Date.now();CL.integ.due=false;
  if(!bad.length){CL.integ.res='OK';CL.integ.sig='';CL.integ.pend='';clNote('integrity','整合 OK');return 'ok';}
  const s=bad.join(' ');
  if(CL.integ.sig===s){CL.integ.res='NG（保留）'+s;return 'hold';}
  if(CL.integ.pend===s){CL.integ.sig=s;CL.integ.res='NG（保留）'+s;clNote('integrity','照合し直しても一致しない：'+s+'（同じ食い違いの間は再実行しない）');return 'hold';}
  if(Date.now()-CL.integ.rebuildAt<600000){CL.integ.res='NG（10分待ち）'+s;clNote('integrity','整合NG（保留・10分に1回まで）：'+s);return 'wait';}
  CL.integ.rebuildAt=Date.now();CL.integ.pend=s;CL.integ.res='NG → 照合し直し';CL.integ.due=true;
  clNote('integrity','整合NG：'+s+' → 全件受信で照合し直し');
  CL.full={since:0,nsh:{},rebuild:true};
  return 'rebuild';
}
function clIntegDue(){
  if(typeof document!=='undefined'&&document.hidden)return false;
  return CL.integ.due||(Date.now()-CL.integ.at>600000);
}

/* ---------- 同期の1周：[全件受信が要るなら先にいま書いた物を送る] → 受信 → 送信 → 整合 ---------- */
async function clOnce(ep,sig){
  CL.lastTry=Date.now();
  if(!CL.shadowOk&&!CL.full)CL.full={since:0,nsh:{}};
  if(CL.full){
    /* 影を作る全件受信の前に、いま書いた物（影が無い時は hot だけ）を送る＝受信の成否に関係なく届く */
    if(clDirtyCount()){const r=await clPushStep(ep,sig);if(r===false)return false;}
    const p=await clPullStep(ep,sig);if(p===false)return false;
    if(clDirtyCount()){const r=await clPushStep(ep,sig);if(r===false)return false;}
  }else{
    const dirty=clDirtyCount()>0;
    let pre=false;
    if(dirty&&CL.seq>0){   /* 先に増分を軽く受信（払った印などを合流してから送る）。遅い・失敗しても送信は止めない */
      try{const p=await clPullStep(ep,sig,CL.T.pre);if(p===false)return false;pre=true;}
      catch(e){if(ep!==CLQ.epoch)return false;clNote('pull','先読み失敗（'+e.message+'）→ 送信を先に');}}
    if(clDirtyCount()){const r=await clPushStep(ep,sig);if(r===false)return false;}
    if(!pre){const p=await clPullStep(ep,sig);if(p===false)return false;}
  }
  if(ep!==CLQ.epoch)return false;
  if(clIntegDue()&&!clDirtyCount()){
    try{const r=await clIntegrity(ep,sig);if(r==='rebuild')CLQ.again=true;}
    catch(e){if(ep!==CLQ.epoch)return false;clNote('integrity','整合の確認に失敗（'+e.message+'）');}
  }
  return true;
}
/* 同期の入口（これ1本）。実行中なら「もう1周」の印を立てて、その回の結果を待つ */
function cloudSync(force){
  if(!cloudConfigured()||!cloudLoggedIn()||!CL.ready)return Promise.resolve(false);
  if(force){CLQ.fails=0;CL.authDead=false;}
  if(typeof document!=='undefined'&&document.hidden){CLQ.wake=true;clKeepalive('隠れている間');return Promise.resolve(false);}   /* 隠れている間は始めない（止められて宙に浮くだけ） */
  if(CLQ.run){CLQ.again=true;return CLQ.run;}
  clearTimeout(CLQ.t);CLQ.t=null;CLQ.due=0;
  const ep=++CLQ.epoch,ctl=CLQ.ctl=new AbortController(),sig=ctl.signal;
  CLQ.beat=Date.now();CLQ.startedAt=Date.now();
  const dead=new Promise(r=>sig.addEventListener('abort',()=>r('abort')));
  CLQ.run=(async()=>{
    let ok=false,err=null;
    try{renderSync();}catch(e){}
    try{
      do{CLQ.again=false;const r=await Promise.race([clOnce(ep,sig),dead]);
        if(r==='abort'){err=clErr('中断（見張り・復帰）',0,'aborted','aborted');ok=false;break;}
        ok=(r===true);
      }while(ok&&CLQ.again&&ep===CLQ.epoch);
    }catch(e){ok=false;err=e;}
    finally{if(CLQ.ctl===ctl){CLQ.run=null;CLQ.ctl=null;}}
    if(ep!==CLQ.epoch)return false;   /* 打ち切られた古い回：結果を使わない（打ち切った側がやり直しを予約済み） */
    if(ok)clOk();else clFail(err);
    return ok;
  })();
  return CLQ.run;
}
/* 動いている回を打ち切る（見張り・画面復帰・ログイン） */
function clAbortRun(){
  CLQ.epoch++;const c=CLQ.ctl;CLQ.run=null;CLQ.ctl=null;
  try{if(c)c.abort();}catch(e){}
}
function clOk(){
  if(CLQ.fails)clNote('sync','再送で通った');
  CLQ.fails=0;CLQ.firstFailAt=0;CL.retryAt=0;CL.lastErr='';CL.err='';
  try{renderSync();}catch(e){}
}
function clFail(e){
  const msg=String((e&&e.message)||'同期失敗').slice(0,80);
  CL.lastErr=msg;CL.err=msg;
  clNote((e&&e.kind)==='timeout'?'timeout':'sync','失敗：'+msg);
  if(!cloudLoggedIn()){try{renderSync();}catch(x){}return;}   /* 合言葉が本当に無効＝ログインし直しが要る（叩き続けない） */
  clRetry(e);
  try{renderSync();}catch(x){}
}
/* 再挑戦：5秒→10→20→40→最大120秒（ゆらぎ付き）。成功で戻る */
function clRetry(e){
  CLQ.fails++;if(!CLQ.firstFailAt)CLQ.firstFailAt=Date.now();
  let ms=Math.round(Math.min(120000,CL.retryMs*Math.pow(2,CLQ.fails-1))*(0.8+Math.random()*0.4));
  const k=e&&e.kind;if((k==='timeout'||k==='aborted')&&CLQ.fails===1)ms=Math.round(500+Math.random()*500);   /* 宙に浮いた通信の後はすぐやり直す（500系は間隔をあける） */
  CL.retryAt=Date.now()+ms;
  clNote('retry',Math.round(ms/1000)+'秒後に再送（'+CLQ.fails+'回目）');
  clearTimeout(CLQ.t);CLQ.t=null;CLQ.due=0;clKick(ms);
}
/* 予約タイマーは1本だけ（早い方が勝つ）。隠れている時に来たら、戻った時に起こす */
function clKick(ms){
  if(!cloudConfigured()||!cloudLoggedIn())return;
  ms=Math.max(0,Number(ms)||0);const at=Date.now()+ms;
  if(CLQ.t&&CLQ.due<=at)return;
  clearTimeout(CLQ.t);CLQ.due=at;
  CLQ.t=setTimeout(()=>{CLQ.t=null;CLQ.due=0;if(typeof document!=='undefined'&&document.hidden){CLQ.wake=true;return;}cloudSync();},ms);
}
function scheduleSync(ms){clKick(ms||1500);}   /* 旧版と同じ名前 */

/* ---------- 画面を離れる瞬間の送信（keepalive。返事を待たない） ---------- */
function clBytes(s){try{return new TextEncoder().encode(s).length;}catch(e){return s.length*3;}}
function clKeepalive(why){
  try{
    if(!cloudConfigured()||!cloudLoggedIn()||!CL.ready||CL.authDead)return false;
    if(Date.now()-CL.kaAt<3000)return false;   /* hidden と pagehide の二重発火を間引く */
    if(CL.sess.expires_at&&Date.now()>CL.sess.expires_at-20000){clNote('keepalive','合言葉の期限が近いので送らない（次の起動で送る）');return false;}
    const keys=Object.keys(CL.dirty);if(!keys.length)return false;
    const want=new Set(keys),list=[];
    for(const it of clItems(state)){if(want.has(clKey(it)))list.push(it);}
    list.sort((a,b)=>((CL.hot[clKey(b)]||0)-(CL.hot[clKey(a)]||0))||(clTsOf(b.ts)-clTsOf(a.ts)));   /* いま書いた物・新しい物から */
    const rs=[],ks=[],hs=[];let size=12;
    for(const it of list){const s=JSON.stringify(clRowOf(it)),b=clBytes(s);if(b+12>CL_KA_MAX)continue;if(size+b+1>CL_KA_MAX)break;rs.push(s);ks.push(clKey(it));hs.push(clSigOf(it,true));size+=b+1;}
    if(!rs.length)return false;
    CL.kaAt=Date.now();
    clNote('keepalive','kA送信 '+rs.length+'件（'+why+'）');
    try{localStorage.setItem(CL_KA,JSON.stringify({n:rs.length,at:CL.kaAt,keys:ks.slice(0,50)}));}catch(e){}
    const h=clHdr();h['x-client-info']='hibiki-ka';
    fetch(CLOUD.url+'/rest/v1/rpc/put_items',{method:'POST',keepalive:true,headers:h,body:'{"rows":['+rs.join(',')+']}'})
      .then(r=>{if(r.ok){clApplyPushed(ks,hs);clPersist();try{renderSync();}catch(e){}clNote('keepalive','kA 届いた '+ks.length+'件');try{localStorage.removeItem(CL_KA);}catch(e){}}else clNote('keepalive','kA 失敗 HTTP '+r.status);})
      .catch(()=>{});
    return true;
  }catch(e){return false;}
}
function clOnHidden(){
  CL.hiddenAt=Date.now();
  if(CL.ready&&CL.persistT){clearTimeout(CL.persistT);CL.persistT=null;clPersist();}   /* 予約中の影の保存を今すぐ（凍結・終了の前に） */
  if(cloudLoggedIn()&&clDirtyCount())clKeepalive('離脱');
}
function clOnVisible(src){
  const hidFor=CL.hiddenAt?Date.now()-CL.hiddenAt:0;
  if(!cloudLoggedIn())return;
  /* 裏に回る前に始まった通信は iOS が殺している事がある＝待たずに打ち切ってやり直す（put_items は何度送っても同じ結果） */
  if(CLQ.run&&CLQ.startedAt<=CL.hiddenAt&&hidFor>=3000){clNote('resume','裏に回る前の通信を打ち切ってやり直す（'+src+'）');clAbortRun();}
  if(hidFor>600000)CL.integ.due=true;
  CLQ.fails=0;CLQ.wake=false;
  clKick(300);
}

/* ---------- 旧版の関数を差し替え ---------- */
schedulePublish=function(ms){if(CLQ.fails>1)CLQ.fails=1;clKick(ms||1500);};   /* 旧版からの依頼も待たせない */
doPublish=function(force){
  if(typeof document!=='undefined'&&document.hidden){clKeepalive('離脱');return Promise.resolve(false);}   /* 離れた瞬間：keepalive だけ（受信は始めない） */
  if(force)return cloudSync(true);
  if(CLQ.fails)return Promise.resolve(false);
  return cloudSync();
};
/* 写真の置き場（旧版の assets 機能の代わり）。upload(blob)→{id} の形を合わせる */
function clNewAssetId(){const a=new Uint8Array(16);(window.crypto&&crypto.getRandomValues)?crypto.getRandomValues(a):a.forEach((_,i)=>a[i]=Math.floor(Math.random()*256));return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function cloudPhotoUpload(blob){
  if(!cloudLoggedIn())throw Object.assign(new Error('not_logged_in'),{code:'not_granted'});
  await clEnsureFresh();
  const id=clNewAssetId(),path='/storage/v1/object/'+CLOUD.bucket+'/'+CL.sess.user.id+'/'+id;
  const r=await clTimed(CL.T.photo,s=>fetch(CLOUD.url+path,{method:'POST',headers:{'apikey':CLOUD.key,'Authorization':'Bearer '+CL.sess.access_token,'Content-Type':blob.type||'image/jpeg','x-upsert':'false'},body:blob,signal:s})
    .then(async x=>({ok:x.ok,status:x.status,text:x.ok?'':await x.text()})));
  if(!r.ok){let j=null;try{j=JSON.parse(r.text);}catch(e){}const e=new Error((j&&(j.message||j.error))||('HTTP '+r.status));e.code=(r.status===429)?'rate_limited':(r.status===401||r.status===403)?'not_granted':'ERR';throw e;}
  return {id};
}
async function cloudPhotoFetch(assetId){
  if(!cloudLoggedIn())return null;
  await clEnsureFresh();
  let b=null;
  try{b=await clTimed(CL.T.photo,s=>fetch(CLOUD.url+'/storage/v1/object/authenticated/'+CLOUD.bucket+'/'+CL.sess.user.id+'/'+assetId,{headers:{'apikey':CLOUD.key,'Authorization':'Bearer '+CL.sess.access_token},signal:s})
    .then(r=>r.ok?r.blob():null));}catch(e){return null;}
  if(!b||!b.size)return null;
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
/* ログインの後：同じユーザーなら影はそのまま（全件受信をやり直さない）。違うユーザーならそのユーザーの影を読む */
async function clAfterLogin(){
  if(!cloudLoggedIn())return;
  CLQ.fails=0;CL.authDead=false;CL.auth401=0;
  const uid=CL.sess.user.id;
  if(uid!==CL.shadowFor){clAbortRun();await clLoadShadow(uid);clRecomputeDirty(true);}
  else clRecomputeDirty(false);
  try{renderSync();}catch(e){}
  clKick(0);
}
function openLoginSheet(opt){
  opt=opt||{};
  const u=cloudLoggedIn()?CL.sess.user:null;
  const daily=!!(u&&(opt.daily||clDailyDue()));   /* ログイン済みだが「今日のパスワード確認」がまだ */
  const remEmail=clGet(CL_EMAIL,'')||(u&&u.email)||(CL.sess&&CL.sess.dead&&CL.sess.user&&CL.sess.user.email)||'';
  const loginForm=(title,note)=>
      '<div class="sh-note" style="text-align:left;margin-bottom:6px">'+note+'</div>'+
      '<div><div class="sh-label">メールアドレス</div><input type="email" id="clEmail" autocomplete="username" inputmode="email" placeholder="登録したメールアドレス" value="'+esc(remEmail)+'" style="width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 13px;outline:none'+(daily?';background:#f1f3f8;color:#6a7080'+'" readonly':'"')+'></div>'+
      '<label style="display:flex;align-items:center;gap:8px;margin:6px 2px 0;font-size:12.5px;font-weight:700;color:#6a7080"><input type="checkbox" id="clRem" '+(clGet(CL_EMAIL,'')||!u?'checked':'')+' style="width:18px;height:18px">メールアドレスを覚える（次から表示したまま）</label>'+
      '<div style="margin-top:10px"><div class="sh-label">パスワード</div><div style="display:flex;gap:6px"><input type="password" id="clPass" autocomplete="current-password" style="flex:1;min-width:0" autofocus><button class="chip" id="clEye" style="flex-shrink:0">表示</button></div></div>'+
      '<label style="display:flex;align-items:center;gap:8px;margin:8px 2px 0;font-size:12.5px;font-weight:700;color:#6a7080"><input type="checkbox" id="clAuto" '+(clGet(CL_AUTO,'0')==='1'?'checked':'')+' style="width:18px;height:18px">自動ログイン（1日1回のパスワード入力も省く）</label>'+
      '<div class="sh-note" id="clMsg" style="color:#e0405a;display:none"></div>'+
      '<div class="sh-btns"><button class="savebtn" id="clIn">'+title+'</button></div>';
  $('sheet').innerHTML='<div class="grab"></div><div class="sh-time" style="justify-content:center"><span><span class="hb-logo"><b>HIBIKI</b><i>日々記</i></span></span></div>'+
    (!cloudConfigured()?'<div class="sh-note">このアプリはまだクラウドの設定が入っていない（配信前の状態）。記録は端末に保存されている</div>':
    (daily?(loginForm('ログイン',opt.ver?('🆕 <b>新しい版（'+esc(CL_APPVER)+'）になった</b>。パスワードを入れて続ける（記録はそのまま）'):'🔑 <b>今日のパスワード確認</b>（忘れないように1日1回）。記録はこのまま続けられる')+
            '<div class="sh-note"><button class="chip" id="clLater" style="background:#f1f3f8;color:#8a90a0">あとで</button></div>'):
    (u?('<div class="sh-note" style="text-align:left">ログイン中：<b>'+esc(u.email||'')+'</b><br>クラウド '+esc(cloudStatusText())+'</div>'+
        '<div class="sh-btns"><button class="delbtn" id="clOut">ログアウト</button><button class="savebtn" id="clSyncNow">今すぐ同期</button></div>'+
        '<div class="sh-label" style="margin-top:14px">引っ越し（旧アプリから）</div>'+
        '<button class="bkbtn" id="clImpJsonBtn">📥 バックアップ JSON を取り込む（消さずに合流）</button>'+
        '<button class="bkbtn" id="clImpPhBtn" style="margin-top:6px">📦 写真をクラウドへ（ファイルを選ぶ）</button>'+
        '<div class="sh-note" id="clImpMsg" style="text-align:left"></div>'):
      (loginForm('ログイン',(CL.sess&&CL.sess.dead)?'ログインが切れた。記録はこの端末に残っている。ログインし直すと続きから送る':'ログインすると、どの端末でも同じ記録が出る。しなくても記録はできる（この端末に保存）')))));
  const inB=$('clIn');
  const wasIn=!!u;   /* 画面を開いた時点でログインしていたか（送信の時点では判定しない） */
  if(inB)inB.onclick=async()=>{
    const em=$('clEmail').value.trim(),pw=$('clPass').value;
    if(!em||!pw){toast('メールとパスワードを入れてくれ');return;}
    inB.disabled=true;inB.textContent='ログイン中…';
    try{
      await clLogin(em,pw);
      clSet(CL_EMAIL,($('clRem')&&$('clRem').checked)?em:null);
      clSet(CL_AUTO,($('clAuto')&&$('clAuto').checked)?'1':'0');
      clSet(CL_PWDAY,todayStr());
      closeSheet();
      if(wasIn){toast('✓ 今日のパスワード確認 OK');}
      else{toast('✓ ログインした。同期を始める');}
      clAfterLogin();
    }
    catch(e){const m=$('clMsg');m.style.display='';m.textContent='ログインできない：'+String((e&&e.message)||e).slice(0,80);inB.disabled=false;inB.textContent='ログイン';}
  };
  const lt=$('clLater');if(lt)lt.onclick=()=>{closeSheet();toast('あとで。次に開いた時にまた聞く');};
  {const _cs=closeSheet;if(!window.__clCsWrapped){window.__clCsWrapped=1;closeSheet=function(){try{$('ovl').classList.remove('cl-first');}catch(e){}return _cs.apply(this,arguments);};}}
  if($('clRem'))$('clRem').onchange=()=>{if(!$('clRem').checked)clSet(CL_EMAIL,null);};
  if($('clAuto'))$('clAuto').onchange=()=>{clSet(CL_AUTO,$('clAuto').checked?'1':'0');};
  const eye=$('clEye');if(eye)eye.onclick=()=>{const p=$('clPass');p.type=(p.type==='password')?'text':'password';eye.textContent=(p.type==='password')?'表示':'隠す';};
  const out=$('clOut');if(out)out.onclick=async()=>{if(clDirtyCount()){toast('まだ送っていない記録がある（'+clDirtyCount()+'件）。先に同期してくれ');return;}await clLogout();closeSheet();toast('ログアウトした');};
  const sn=$('clSyncNow');if(sn)sn.onclick=async()=>{sn.disabled=true;CL.integ.due=true;await cloudSync(true);sn.disabled=false;openLoginSheet();};
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
    CLQ.fails=0;clKick(300);
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
      const r=await clTimed(CL.T.photo,s=>fetch(CLOUD.url+'/storage/v1/object/'+CLOUD.bucket+'/'+uid+'/'+x.aid,{method:'POST',headers:{'apikey':CLOUD.key,'Authorization':'Bearer '+CL.sess.access_token,'Content-Type':x.f.type||'image/jpeg','x-upsert':'false'},body:x.f,signal:s})
        .then(async y=>({ok:y.ok,status:y.status,text:y.ok?'':await y.text()})));
      if(r.ok)ok++;else{let j=null;try{j=JSON.parse(r.text);}catch(e){}if(r.status===400&&j&&/exists/i.test(String(j.message||j.error||'')))dup++;else ng++;}
    }catch(e){ng++;}
    i++;if(i%10===0||i===todo.length)clImpSay('📦 写真 '+i+'/'+todo.length+'（新規 '+ok+'・既にあった '+dup+'・失敗 '+ng+'）');
  };
  /* 4枚ずつ並行 */
  for(let p=0;p<todo.length;p+=4)await Promise.all(todo.slice(p,p+4).map(one));
  clImpSay('📦 写真の引っ越し：新規 '+ok+'・既にあった '+dup+'・失敗 '+ng+(skip?'・番号が合わず飛ばした '+skip:'')+'（全 '+todo.length+'）');
  PH.mem={};render();
}
const clHM=t=>t?new Date(t).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):'—';
function cloudStatusText(){
  const n=clDirtyCount();
  return (CL.lastErr?('⚠ '+CL.lastErr+'｜'):'')+(n?('未送信 '+n+'件'):'送信済み')+(CL.lastPull?('｜最終受信 '+clHM(CL.lastPull)):'')+(CL.retryAt>Date.now()?('｜再送 '+Math.ceil((CL.retryAt-Date.now())/1000)+'秒後'):'');
}
/* 「保存ランプの意味」の画面に出す、同期の状態1行と記録（旧HTML側の openSyncSheet から呼ばれる） */
function clSyncDiagHtml(){
  try{
    if(!cloudConfigured())return '';
    const now=Date.now(),n=clDirtyCount(),nb=Object.keys(CL.bad).length;
    const fmt=t=>{const d=new Date(t);return (d.getMonth()+1)+'/'+d.getDate()+' '+d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});};
    const line='状態：'+(cloudLoggedIn()?'ログイン中':((CL.sess&&CL.sess.dead)?'ログイン切れ':'未ログイン'))+'｜未送信 '+n+'件｜最後の送信 '+clHM(CL.lastPush)+'｜最後の受信 '+clHM(CL.lastPull)+
      '｜次の再送 '+(CL.retryAt>now?Math.ceil((CL.retryAt-now)/1000)+'秒後':'—')+'｜整合 '+(CL.integ.res||'未確認')+'｜影 '+(CL.shadowOk?(CL.full?'照合し直し中':'あり'):'作成中（クラウドと照合待ち）')+
      '｜控え '+(CL.storeOk===false?'メモリのみ':'IndexedDB')+(CLQ.run?'｜同期中':'')+(CL.lastErr?'｜エラー '+CL.lastErr:'')+
      (nb?'｜送れない行 '+nb+'件：'+Object.keys(CL.bad).slice(0,5).map(k=>k.replace('\u0000','/')).join('、'):'');
    const rows=CL.log.slice().reverse().map(e=>'<div>'+esc(fmt(e.t))+' 〔'+esc(e.ev)+'〕'+esc(e.msg)+'</div>').join('');
    return '<div class="sh-label" style="margin-top:12px">同期の記録</div>'+
      '<div class="sh-note" id="clDiag" style="text-align:left;word-break:break-all">'+esc(line)+'</div>'+
      '<div class="sh-note" id="clLog" style="text-align:left;font-size:11.5px;line-height:1.5;max-height:220px;overflow:auto;word-break:break-all">'+(rows||'（まだ記録なし）')+'</div>';
  }catch(e){return '';}
}
/* ランプと診断帯：旧版の renderSync を包む（未ログイン＝灰色・タップでログイン） */
function clNoShadow(){return cloudConfigured()&&cloudLoggedIn()&&CL.ready&&!CL.shadowOk;}   /* 影が無い＝クラウドとの突き合わせが済んでいない */
function clStripText(){
  const now=Date.now(),n=clDirtyCount();
  const showErr=CL.lastErr&&(CLQ.fails>=2||(CLQ.firstFailAt&&now-CLQ.firstFailAt>20000));   /* 復帰直後の1回の失敗では騒がない */
  return ((typeof localSaveFail!=='undefined'&&localSaveFail)?'🔴 端末保存に失敗｜':'🟠 ')+(clNoShadow()?'照合中（クラウドと突き合わせ待ち）'+(n?'｜いま書いた '+n+'件':''):'未送信 '+n+'件')+(CL.lastPush?'｜最後の送信 '+clHM(CL.lastPush):'')+
    (showErr?'｜'+CL.lastErr:'')+(CL.retryAt>now?'｜再送 '+Math.ceil((CL.retryAt-now)/1000)+'秒後':(CLQ.run?'｜送信中':''));
}
{
  const _rs=renderSync;
  renderSync=function(){
    const noSh=clNoShadow();   /* 影が無い間（全件受信が終わるまで）は緑にしない＝端末だけの記録が残っているかもしれない */
    unsynced=clDirtyCount()>0||noSh;
    localOnly=!(cloudConfigured()&&cloudLoggedIn());
    _rs();
    const d=$('syncdot');if(d){d.onclick=openLoginSheet;if(localOnly&&cloudConfigured())d.title='未ログイン（タップでログイン）';}
    const s=$('diagstrip');
    if(s&&cloudConfigured()&&!cloudLoggedIn()){s.style.display='';s.className='diagstrip';
      s.textContent=(CL.sess&&CL.sess.dead)?'⚪ ログインが切れた：記録はこの端末に保存中（タップしてログインし直す）':'⚪ 未ログイン：この端末だけに保存中（タップしてログインすると全端末で同期）';s.onclick=openLoginSheet;}
    else if(s&&cloudLoggedIn()){
      const showErr=CL.lastErr&&(CLQ.fails>=2||(CLQ.firstFailAt&&Date.now()-CLQ.firstFailAt>20000));
      if(clDirtyCount()||showErr||noSh||(typeof localSaveFail!=='undefined'&&localSaveFail)){s.style.display='';s.className='diagstrip'+((typeof localSaveFail!=='undefined'&&localSaveFail)?' bad':'');s.textContent=clStripText();s.onclick=openSyncSheet;}
    }
  };
}
/* 「保存ランプの意味」：☁ボタンを新しい同期に（失敗の間隔をリセットして今すぐ） */
{
  const _os=openSyncSheet;
  openSyncSheet=function(){
    _os.apply(this,arguments);
    const b=$('syncNow');if(b){b.textContent='☁ いまクラウドに保存';b.onclick=()=>{closeSheet();CL.integ.due=true;cloudSync(true);toast('☁ クラウドへ保存中…少し待て');};}
  };
}
/* 保存のたびに dirty を更新して、1.5秒後に送る（早い方の予約が勝つ＝書き続けても送信が後ろへずれない） */
{
  const _sl=saveLocal;
  saveLocal=function(synced){
    _sl(synced);
    if(CL.quietSave)return;
    let n=0;try{n=clMarkDirty();}catch(e){clNote('dirty','差の計算で例外：'+e.message);}
    if(CL.ready){try{renderSync();}catch(e){}if(n){if(CLQ.fails>1)CLQ.fails=1;clKick(1500);}}   /* 本人が保存したら、失敗の待ち時間を待たずに1.5秒で送る */
  };
}
/* きっかけ：画面を離れる（capture＝旧版の処理より先に keepalive を撃つ）・戻る・ネット復帰・別タブの合言葉 */
document.addEventListener('visibilitychange',()=>{if(document.hidden)clOnHidden();else{clOnVisible('visible');clCheckUpdate();}},true);
/* ---------- 新しい版があるか（index.html の CL_APPVER を見る）。あれば上に出す：押すと送り切ってから最新を読み込む ---------- */
let clUpAt=0;
async function clCheckUpdate(){try{if(!cloudConfigured()||Date.now()-clUpAt<20000)return;clUpAt=Date.now();
  const r=await fetch('./index.html?up='+Date.now(),{cache:'no-store'});if(!r.ok)return;const t=await r.text();
  const m=/const CL_APPVER="([^"]+)"/.exec(t);if(!m||m[1]===CL_APPVER)return;if(typeof appVerCheck==='function')appVerCheck(true);}catch(e){}}   /* c10.8：［更新する］の帯は出さない。自動で入れ替える（本人指示 2026-10-07「しつこい」） */
function clShowUpdate(v){if(document.getElementById('clUp'))return;const d=document.createElement('div');d.id='clUp';
  d.style.cssText='position:fixed;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top,0px));z-index:250;max-width:420px;margin:0 auto;background:#1f2430;color:#fff;border-radius:16px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;font:800 13.5px -apple-system,BlinkMacSystemFont,sans-serif';
  d.innerHTML='<span style="flex:1">🆕 新しい版（'+esc(v)+'）があります</span><button id="clUpGo" style="background:#0bc167;color:#fff;border:0;border-radius:12px;padding:9px 14px;font-weight:800">更新する</button>';
  document.body.appendChild(d);
  document.getElementById('clUpGo').onclick=async()=>{const b=document.getElementById('clUpGo');b.disabled=true;b.textContent='送っています…';
    try{if(cloudLoggedIn())await cloudSync(true);}catch(e){}
    try{const ks=await caches.keys();await Promise.all(ks.map(k=>caches.delete(k)));}catch(e){}
    try{const rs=await navigator.serviceWorker.getRegistrations();await Promise.all(rs.map(x=>x.update().catch(()=>{})));}catch(e){}
    location.reload();};}
setInterval(()=>{if(typeof document==='undefined'||!document.hidden)clCheckUpdate();},15*60000);
setTimeout(()=>{clCheckUpdate();},3000);   /* 開いた時 */
window.addEventListener('pagehide',()=>{clOnHidden();},true);
window.addEventListener('pageshow',e=>{if(e&&e.persisted)clOnVisible('pageshow');});
document.addEventListener('resume',()=>{clOnVisible('resume');});
window.addEventListener('online',()=>{if(cloudLoggedIn()){CLQ.fails=0;clKick(500);}});
window.addEventListener('storage',e=>{
  if(!e||e.key!==CL_SESS||!e.newValue)return;
  try{const s=JSON.parse(e.newValue);if(s&&s.user&&s.access_token&&CL.sess&&CL.sess.user&&s.user.id===CL.sess.user.id&&(s.expires_at||0)>(CL.sess.expires_at||0)){CL.sess=s;clNote('refresh','別タブの新しい合言葉を採用');}}catch(x){}
});
/* 見張りと定期処理（10秒ごと）：止まった同期を打ち切る／未送信があれば20秒、無くても60秒ごとに同期（受信） */
setInterval(()=>{
  if(CLQ.run&&Date.now()-CLQ.beat>CL.T.watch){clNote('watchdog','無進捗 '+Math.round((Date.now()-CLQ.beat)/1000)+'秒 → 打ち切ってやり直す');clAbortRun();clKick(500);return;}
  if(!cloudLoggedIn()||!CL.ready||CLQ.run||CLQ.fails||(typeof document!=='undefined'&&document.hidden))return;
  if(Date.now()-(CL.freshAt||0)>60000){CL.freshAt=Date.now();try{clRecomputeDirty(true);}catch(e){}if(clDirtyCount()){clKick(1000);return;}}   /* 1分に1回は署名を全部計算し直す＝指紋に出ないその場の書き換えも拾う */
  const idle=Date.now()-Math.max(CL.lastTry,CL.lastPull);
  if((clDirtyCount()>0&&idle>20000)||idle>60000)clKick(0);
},10000);
/* 再送までの秒数を帯に出す（帯が出ている間だけ） */
setInterval(()=>{try{const s=$('diagstrip');if(s&&s.style.display!=='none'&&cloudLoggedIn()&&(CL.retryAt>Date.now()||clDirtyCount()||clNoShadow()))s.textContent=clStripText();}catch(e){}},1000);
/* 起動：端末のデータで先に画面を出し、ログイン済みなら裏で 受信→送信 */
let afterCloudReady=function(){};
async function cloudBoot(){
  clBaseSigs();CL.trackHot=true;   /* ここから先の保存は「書いた項目」として追う */
  const verUp=clGet('hibiki-ver','')!==CL_APPVER&&!!clGet('hibiki-ver','');   /* 版が上がった（初めての起動は除く） */
  if(clGet('hibiki-ver','')!==CL_APPVER){clSet('hibiki-ver',CL_APPVER);clSet(CL_PWDAY,null);}   /* 版が上がった＝パスワード確認をやり直す */
  if(!cloudConfigured()){CL.ready=true;renderSync();return;}
  try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().then(p=>(navigator.storage.estimate?navigator.storage.estimate():Promise.resolve({})).then(es=>{
    const mb=x=>x?(x/1048576).toFixed(1):'?';clNote('storage','永続保存 '+(p?'許可':'未許可')+'・使用 '+mb(es.usage)+'/'+mb(es.quota)+'MB');})).catch(()=>{});}catch(e){}
  /* セッション：localStorage に無い・古い時は IndexedDB の控えを使う */
  try{const is=await clStore.get('session');
    if(is&&is.user&&is.access_token&&(!CL.sess||(CL.sess.user&&CL.sess.user.id===is.user.id&&(is.expires_at||0)>(CL.sess.expires_at||0)))){CL.sess=is;try{localStorage.setItem(CL_SESS,JSON.stringify(is));}catch(e){}clNote('sess','IndexedDB の控えから合言葉を戻した');}}catch(e){}
  try{const ka=JSON.parse(localStorage.getItem(CL_KA)||'null');if(ka&&ka.n)CL.kaCheck=ka;}catch(e){}
  if(CL.sess&&CL.sess.user&&CL.sess.user.id){await clLoadShadow(CL.sess.user.id);await clOutboxRestore();}
  CL.ready=true;
  clRecomputeDirty(false);
  unsynced=clDirtyCount()>0||clNoShadow();renderSync();
  /* 起動した最初の画面：未ログインならログイン画面、ログイン済みでも今日まだならパスワード確認（自動ログインなら出さない）。
     起動フラッシュ（毎日のルールの画面）が出ている間は、閉じられてから出す */
  /* 本人の決め事（2026-10-03）：ログインは「毎日のルールの画面より前の、本当の最初」。起動フラッシュの上に重ねて出す */
  if(!cloudLoggedIn()||clDailyDue()||verUp){try{$('ovl').classList.add('cl-first');openLoginSheet({daily:cloudLoggedIn(),ver:verUp});}catch(e){}}   /* 版が上がった最初の起動は、自動ログインでもログイン画面（本人指示 2026-10-06） */
  if(!cloudLoggedIn()){return;}
  clNote('boot','起動 '+CL_APPVER+'｜影 '+(CL.shadowOk?'あり（受信位置 '+CL.seq+'）':'なし → 全件受信')+'｜未送信 '+clDirtyCount()+'件｜署名 '+CL.perf.baseSigs+'ms');
  CL.integ.due=true;   /* 起動ごとに1回は整合を確かめる */
  await cloudSync();
}
