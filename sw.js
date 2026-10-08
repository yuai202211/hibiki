/* HIBIKI Service Worker：オフラインでも開けるようにする。
   index.html は「まずネット、だめならキャッシュ」（新しい版をすぐ拾う）。アイコン類は「キャッシュ優先」。
   データ（Supabase の API）と写真はここでは触らない（アプリが自分で端末に控える）。 */
const VER='hibiki-c13.8';
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
/* ページからの「新しい版に入れ替えて」 */
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting();});
