/* HIBIKI Service Worker：オフラインでも開けるようにする。
   index.html は「まずネット、だめならキャッシュ」（新しい版をすぐ拾う）。アイコン類は「キャッシュ優先」。
   データ（Supabase の API）と写真はここでは触らない（アプリが自分で端末に控える）。 */
const VER='hibiki-c24.4';
const CORE=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-512-maskable.png','./apple-touch-icon.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(VER).then(c=>c.addAll(CORE).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VER).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;   /* API・写真・フォントは素通し */
  const isPage=(req.mode==='navigate')||/\/index\.html$/.test(url.pathname)||url.pathname.endsWith('/');
  if(isPage){
    e.respondWith((async()=>{
      const net=fetch(req,{cache:'no-store'}).then(r=>{if(r.ok&&String(r.headers.get('content-type')||'').toLowerCase().indexOf('text/html')>=0){const cp=r.clone();caches.open(VER).then(c=>c.put('./index.html',cp)).catch(()=>{});}return r;});   /* 壊れた応答（404・中継ページ）で控えを上書きしない */
      const hit=await caches.match('./index.html');
      if(!hit)return net.catch(()=>caches.match('./index.html'));
      /* 控えがある時はネットを4秒だけ待つ（電波はあるのに通らない時、白い画面で止めない）。ネットの取得は裏で続けて次回に備える */
      const r=await Promise.race([net.catch(()=>null),new Promise(ok=>setTimeout(()=>ok(null),4000))]);
      if(r)return r;
      try{e.waitUntil(net.catch(()=>{}));}catch(x){}
      return hit;
    })());
    return;
  }
  e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{const cp=r.clone();caches.open(VER).then(c=>c.put(req,cp)).catch(()=>{});return r;})));
});
/* c20.6：🔔 閉じていても鳴る通知（Web Push）。iOS は「受けた Push には必ず通知を出す」が約束＝出さないと3回で購読が消える。
   どの経路でも（中身が空でも JSON が壊れていても）必ず showNotification を waitUntil に渡す。アプリを開いている最中でも出す（早期 return しない） */
self.addEventListener('push',e=>{
  let d={};
  try{d=e.data?e.data.json():{};}catch(x){try{d={body:e.data.text()};}catch(y){}}
  if(!d||typeof d!=='object')d={};
  const title=String(d.title||'HIBIKI').slice(0,120),tag=String(d.tag||'').replace(/^tb\|play\|.*$/,'tb|play');   /* 遊び枠は日付入りで積む（毎日別の行）→ 画面の通知は アプリ内の 'tb|play' と同じ tag で置き換える */
  const opt={body:String(d.body||'').slice(0,300),icon:'icon-192.png',badge:'icon-192.png',data:{url:String(d.url||'./')}};
  if(tag)opt.tag=tag;
  /* c23.8：📳 バイブの ON/OFF。読めない・1秒過ぎた時はオン。どの経路でも必ず showNotification を出す（バイブ付きで断られたらバイブ無しで出し直す） */
  e.waitUntil(swVib().catch(()=>1).then(v=>{opt.vibrate=v?[200,100,200]:[];return self.registration.showNotification(title,opt);})
    .catch(()=>{delete opt.vibrate;return self.registration.showNotification(title,opt);})
    .catch(()=>self.registration.showNotification('HIBIKI')));
});
/* c23.8：ページが IndexedDB 'hibiki-sw' の 'cfg' に 'vib'＝0/1 を書く（無ければ1）。例外・1秒のタイムアウトでも必ず1か0で終わる */
function swVib(){return new Promise(ok=>{let done=false;const fin=v=>{if(!done){done=true;ok(v);}};setTimeout(()=>fin(1),1000);
  try{const rq=indexedDB.open('hibiki-sw',1);
    rq.onupgradeneeded=()=>{try{const db=rq.result;if(!db.objectStoreNames.contains('cfg'))db.createObjectStore('cfg');}catch(x){}};
    rq.onerror=()=>fin(1);
    rq.onsuccess=()=>{let db=null;try{db=rq.result;const g=db.transaction('cfg','readonly').objectStore('cfg').get('vib');
      g.onsuccess=()=>{fin(g.result===0?0:1);try{db.close();}catch(x){}};g.onerror=()=>{fin(1);try{db.close();}catch(x){}};}catch(x){fin(1);try{db&&db.close();}catch(y){}}};
  }catch(x){fin(1);}});}
/* c17.9：🚩 出発予定の通知を押したら、アプリを前面に出す（開いていなければ開く）。c20.6：通知の data.url があればそこを開く（同じ場所の相対だけ・無ければ './'） */
self.addEventListener('notificationclick',e=>{e.notification.close();
  let u='./';try{const w=e.notification.data&&e.notification.data.url;if(w){const x=new URL(w,self.registration.scope);if(x.origin===self.location.origin)u=x.href;}}catch(z){}
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if('focus' in c)return Promise.resolve().then(()=>c.focus()).catch(()=>self.clients.openWindow&&self.clients.openWindow(u));}   /* c20.6：focus() が拒まれたら開き直す（ホーム画面のアプリで前面に出せない時） */
    if(self.clients.openWindow)return self.clients.openWindow(u);}));});
/* ページからの「新しい版に入れ替えて」 */
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting();});
