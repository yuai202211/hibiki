'use strict';
const fs=require('fs'),path=require('path');
module.exports=function(h){
  const rep=(a,b)=>{if(h.split(a).length!==2)throw Error('diary-layout anchor: '+a.slice(0,100));h=h.replace(a,b);};
  const start=h.indexOf('function actsHtml(en){'),end=h.indexOf("let topView='diary';",start);
  if(start<0||end<start)throw Error('diary-layout renderer missing');
  let f=h.slice(start,end);
  const change=(a,b)=>{if(f.split(a).length!==2)throw Error('diary-layout activity anchor: '+a.slice(0,80));f=f.replace(a,b);};
  const hs=f.indexOf('const hh='),he=f.indexOf('const tx=',hs);
  if(hs<0||he<hs)throw Error('diary-layout heading missing');
  f=f.slice(0,hs)+`const hh=[x.k].concat(x.kx||[]).filter((id,i,a)=>id&&a.indexOf(id)===i).map(id=>{const q=kindOf(id);return '<em class="a-kl">'+esc(q?(q.ic+' '+q.lb):id)+'</em>';}).join('');
`+f.slice(he);
  change("const asw=actSwHtml(en,x);","const asw=dlSettings(actSwHtml(en,x),x,en);");
  change("+'\">'+(kk?'<i class=\"a-k\">'","+'\">'+dlTimeHtml(en,x)+(kk?'<i class=\"a-k\">'");
  change("(m?'<span class=\"a-m\">'+esc(durText(m))+'</span>':'')+",'');
  change("hitoHtml(tx)","dlText(hitoHtml(tx),tx)");
  change('const wkt=wkTagHtml(x);','const wkt=wkTagHtml(x)||dlDevices(x);');
  change("'<span class=\"a-tg\">'+wkt+ai+ap+mp+bz+bt+'</span>'","dlMeta('<span class=\"a-tg\">'+wkt+ai+ap+mp+bz+bt+'</span>')");
  change("txtHtml(x.c)","dlText(txtHtml(x.c),x.c)");
  // A remainder is not a located activity; retain its duration without inventing times.
  change('そのほか</span>','そのほか（時刻未記入）</span>');
  h=h.slice(0,start)+f+h.slice(end);
  rep("+qFixIds().map(id=>mk(id,false).replace('class=\"chip','class=\"chip qfx')).join('')+top.map(x=>x.h).join('')+'</div>';",
      "+'<div class=\"dl-favorites\">'+qFixIds().map(id=>mk(id,false).replace('class=\"chip','class=\"chip qfx')).join('')+'</div><div class=\"dl-categories\"><span class=\"dl-category-label\">カテゴリーから選ぶ</span>'+top.map(x=>x.h).join('')+'</div></div>';");
  rep('</style>',fs.readFileSync(path.join(__dirname,'diary-layout.css'),'utf8')+'\n</style>');
  rep('\nboot();','\n'+fs.readFileSync(path.join(__dirname,'diary-layout.js'),'utf8')+'\nboot();');
  return h;
};
