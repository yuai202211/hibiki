/* Multiple work categories use the existing k/kx and d/dd fields for readers.
   wm records each selected hierarchy path; no diary rows or minutes are cloned. */
function wmUnique(xs){return [...new Set(xs.filter(x=>typeof x==='string'&&x))];}
function wmPrefix(a,b){return a.length<=b.length&&a.every((v,i)=>v===b[i]);}
function wmPaths(a){
  const raw=Array.isArray(a&&a.wm)?a.wm:(a&&Array.isArray(a.wc)&&a.wc.length?[a.wc]:[]),out=[];
  for(const p of raw){if(!Array.isArray(p)||!p.length||p.some(x=>typeof x!=='string'||!x))continue;
    if(!out.some(q=>q.length===p.length&&wmPrefix(q,p)))out.push(p.slice());}
  return out.filter(p=>!out.some(q=>q.length>p.length&&wmPrefix(p,q)));
}
function wmKinds(a){return wmUnique(wmPaths(a).map(wkKind));}
function wmCopy(to,from){
  if(Array.isArray(from.wm))to.wm=wmPaths(from);
  for(const f of ['wsx','hwx','bzx'])if(Array.isArray(from[f])&&from[f].length)to[f]=wmUnique(from[f]);
  return to;
}
function wmJson(a){return JSON.stringify(wmCopy({},a||{}));}
function wmRead(to,s){if(!s)return to;try{wmCopy(to,JSON.parse(s));}catch(e){}return to;}
function wmValues(a,f){
  const extra={d:'dd',ws:'wsx',hw:'hwx',bz:'bzx'}[f];
  return wmUnique((Array.isArray(a[f])?a[f]:typeof a[f]==='string'?(f==='bz'?[a[f]]:a[f].split(',')):[]).concat(extra&&Array.isArray(a[extra])?a[extra]:[]));
}
function wmSetValues(a,f,vs){
  const values=wmUnique(vs),extra={d:'dd',ws:'wsx',hw:'hwx',bz:'bzx'}[f];
  if(extra){if(values.length)a[f]=values[0];else delete a[f];if(values.length>1)a[extra]=values.slice(1);else delete a[extra];}
  else if(values.length||f==='ai')a[f]=values;else delete a[f];
}
function wmModel(a){
  const paths=wmPaths(a),nodes=[],fields=new Map();
  const addField=st=>{
    if(!st)return;
    if(st.f==='wc')return;
    const old=fields.get(st.f),opts=wkOpts(st)||[];
    if(old){for(const o of opts)if(!old.options.some(x=>x[0]===o[0]))old.options.push(o);}
    else fields.set(st.f,{key:'f~'+st.f,st,options:opts.slice(),selected:wmValues(a,st.f),prefix:[]});
    if(st.nx){const vs=wmValues(a,st.f),v=vs[0]||(opts[0]||[])[0];if(v)addField(st.nx(v));}
  };
  const walk=(st,prefix,label)=>{
    if(!st)return;if(st.f!=='wc'){addField(st);return;}
    const options=wkOpts(st)||[],selected=wmUnique(paths.filter(p=>wmPrefix(prefix,p)&&p.length>prefix.length).map(p=>p[prefix.length]));
    nodes.push({key:'p~'+prefix.join('~'),st,options,selected,prefix,label});
    for(const v of selected)if(st.nx&&options.some(o=>o[0]===v))walk(st.nx(v),prefix.concat(v),wkOptLb(st,v));
  };
  walk(WK_ROOT,[],'');return nodes.concat([...fields.values()]);
}
function wmSync(a,oldKinds){
  const selected=wmKinds(a),prior=wmUnique([a.k].concat(a.kx||[])),keep=prior.filter(k=>!oldKinds.includes(k)),ks=wmUnique(keep.concat(selected));
  const primary=ks.includes(a.k)?a.k:ks[0];a.k=primary||'';
  const other=ks.filter(k=>k!==primary);if(other.length)a.kx=other;else delete a.kx;
  const p=wmPaths(a);a.wm=p;if(p.length)a.wc=p[0].slice();else delete a.wc;
  const oldLabels=oldKinds.map(k=>(kindOf(k)||{}).lb),t=String(a.t||'').trim();
  if(!t||oldLabels.includes(t)||kindList().some(k=>k.lb===t))a.t=(kindOf(a.k)||{}).lb||'';
}
function wmApply(a,key,v,site){
  let nodes=wmModel(a),node=nodes.find(n=>n.key===key);
  if(!node)return;
  if(!node.options.some(o=>o[0]===v))return;
  const oldKinds=wmKinds(a),selected=node.selected.includes(v);
  if(node.st.f==='wc'){
    const target=node.prefix.concat(v);let paths=wmPaths(a);
    if(selected){paths=paths.filter(p=>!wmPrefix(target,p));if(node.prefix.length&&!paths.some(p=>wmPrefix(node.prefix,p)))paths.push(node.prefix);}
    else{paths=paths.filter(p=>!(p.length===node.prefix.length&&wmPrefix(p,node.prefix)));paths.push(target);}
    a.wm=paths;wmSync(a,oldKinds);
  }else{
    wmSetValues(a,node.st.f,selected?node.selected.filter(x=>x!==v):node.selected.concat(v));
    if(node.st.last){try{localStorage.setItem('hibiki-wkwhy',wmValues(a,node.st.f).join(','));}catch(e){}}
  }
  // Keep the clicked group in view: selecting a second button must not jump away.
  WK_SCR=site+':'+key;
  if(!wmPaths(a).length&&!a.k)return 'del';
}
function wmLegacyApply(a,i,v,site){
  const L=wkChain(a),st=L[i];if(!st)return;
  const key=st.f==='wc'?'p~'+(a.wc||[]).slice(0,wkWcIdx(L,i)).join('~'):'f~'+st.f;
  return wmApply(a,key,v,site);
}
function wmHtml(a,site,open){
  const b=a||{},paths=wmPaths(b);if(!paths.length&&!open)return '';
  return '<div class="wk-steps wk-multi" data-wksite="'+esc(site)+'"><div class="wm-note">いくつでも選べます。もう一度押すと外せます。</div>'+wmModel(b).map(n=>{
    const title=wkQ(n.st).replace(/（いくつでも）/g,'');
    return '<div class="wk-st" data-wkst="'+esc(n.key)+'" style="--c:'+WK_CO[n.st.c]+'"><div class="wk-h"><i></i>'+esc(title)+(n.selected.length?' <span class="ok">✓ '+n.selected.length+'</span>':'')+(n.label?'<small>'+esc(n.label)+'</small>':'')+(n.st.tip?'<small>'+esc(n.st.tip)+'</small>':'')+'</div><div class="wk-o">'+n.options.map(o=>{
      const on=n.selected.includes(o[0]);return '<button type="button" aria-pressed="'+on+'" class="'+(on?'sel':'')+'" data-wks="'+esc(n.key)+'" data-wv="'+esc(o[0])+'">'+esc(o[1])+'</button>';
    }).join('')+'</div></div>';
  }).join('')+(paths.length?'<div class="wk-end" data-wkst="end">✓ 選んだ内容を「記録」で保存</div>':'')+'</div>';
}
function wmTags(a){
  if(!wmPaths(a).length)return '';const out=[],seen=new Set(),ks=wmKinds(a);
  const put=(st,v)=>{const key=st.f+':'+v;if(seen.has(key))return;seen.add(key);
    if(st.f==='ai'||st.f==='ap'||(st.f==='wc'&&ks.includes(v)))return;
    out.push('<i class="wkt" style="--c:'+WK_CO[st.c]+'">'+(st.f==='wy'?'🎯 ':'')+esc(wkOptLb(st,v))+'</i>');};
  for(const n of wmModel(a)){if(n.key==='p~')continue;for(const v of n.selected)put(n.st,v);}
  if(wmPaths(a).some(p=>p[0]==='tel'&&p[1]==='car'))put(WK_HW,'tel');
  // Preserve legacy metadata even if its category is currently unselected.
  for(const st of [WK_TL3,WK_PL,WK_HW,WK_WHY])for(const v of wmValues(a,st.f))put(st,v);
  return out.length?'<span class="a-ap a-wk">'+out.join('')+'</span>':'';
}
function wmChip(){const roots=wmUnique(wmPaths(WK_CUR).map(p=>p[0]));return '<button type="button" class="chip ac-q wk-b'+(roots.length?' sel':'')+'" data-wkb="'+esc(WK_SITE)+'">💼 仕事'+(roots.length?'：'+roots.map(r=>esc(wkOptLb(WK_ROOT,r))).join('・'):'')+'</button>';}
function wmExpand(A){
  if(!Array.isArray(A))return [];const out=[];
  A.forEach((a,i)=>{if(!a)return;const ks=wmUnique([a.k].concat(a.kx||[])),ds=wmUnique([a.d].concat(a.dd||[]));
    const base=Object.assign({},a,{_wmGroup:i});delete base.kx;delete base.dd;out.push(base);
    for(const k of ks.filter(k=>k!==a.k)){const c=Object.assign({},base,{k});delete c.d;out.push(c);}
    for(const d of ds.filter(d=>d!==a.d)){const c=Object.assign({},base,{d});delete c.k;delete c.n;out.push(c);}
  });return out;
}
function wmToolTotals(items,P,limit,NT,own,movingOnly){
  const masks={},len=Math.max(0,limit);
  const mark=(id,s,e,ix)=>{if(!id)return;const mask=masks[id]||(masks[id]=new Uint8Array(len));for(let m=Math.max(P,s);m<Math.min(P+limit,e,NT);m++)if(own[m]===ix)mask[m-P]=1;};
  items.forEach((it,ix)=>{if(movingOnly&&!it.mv)return;
    const A=Math.max(0,it.a),B=Math.min(NT,it.b),used=new Uint8Array(Math.max(0,B-A)),groups=new Map();
    for(const a of it.acts){if(!a)continue;const key=a._wmGroup;let g=groups.get(key);if(!g){g={a,devices:[]};groups.set(key,g);}if(a.d&&!g.devices.includes(a.d))g.devices.push(a.d);}
    const span=a=>{let s=it.off+hmMin(a.s),e=it.off+hmMin(a.e);if(s<it.a)s+=1440;if(e<=s)e+=1440;return [Math.max(A,s),Math.min(B,e)];};
    for(const {a,devices} of groups.values())if(a.s&&a.e){const [s,e]=span(a);for(let m=s;m<e;m++)used[m-A]=1;for(const d of devices)mark(d,s,e,ix);}
    for(const {a,devices} of groups.values()){if(a.s&&a.e)continue;
      if(Number(a.m)>0){let left=Number(a.m);for(let m=A;m<B&&left>0;m++)if(it.mv||!used[m-A]){used[m-A]=1;left--;for(const d of devices)mark(d,m,m+1,ix);}}
      else for(const d of devices)mark(d,A,B,ix);
    }
    if(it.entryTool)mark(it.entryTool,it.a,it.b,ix);
  });const out={};for(const id in masks){const n=masks[id].reduce((a,b)=>a+b,0);if(n)out[id]=n;}return out;
}
function wmBizToggle(a,v){const vs=wmValues(a,'bz');wmSetValues(a,'bz',vs.includes(v)?vs.filter(x=>x!==v):vs.concat(v));}
function wmMealAsk(go,selected){const vs=selected||[];openSub('<div class="sh-time"><span>🍚 食事（いくつでも）</span></div><div class="sh-note">両方選べます。同じボタンをもう一度押すと外れます。</div><div class="sr-r big">'+[['meal','🍽️ 店内で食べた'],['mealto','🥡 持ち帰り']].map(([id,lb])=>'<button type="button" class="chip'+(vs.includes(id)?' sel':'')+'" aria-pressed="'+vs.includes(id)+'" data-mq="'+id+'">'+lb+'</button>').join('')+'</div>',null);$('sheet2').querySelectorAll('[data-mq]').forEach(b=>b.onclick=()=>{const id=b.dataset.mq;closeSub();go(id);});}
function wmBizBox(a,attr){const vs=wmValues(a,'bz'),rc=wmUnique(vs.concat(bzRecent()));return '<div class="ac-ai ac-bz"><span>🏷 何の事業（いくつでも）</span><input type="text" class="bz-in" '+attr+'="1" placeholder="自由に（例：中古車・新しい事業の名前）" value="'+esc(a.bz||'')+'">'+rc.map(x=>'<button type="button" aria-pressed="'+vs.includes(x)+'" class="chip'+(vs.includes(x)?' sel':'')+'" '+attr+'c="'+esc(x)+'">'+esc(x)+'</button>').join('')+'</div>';}
