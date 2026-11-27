// Presentation only: never writes entries, timestamps, categories or totals.
var DL_OPEN=new Set();
function dlTimeHtml(en,x){
  const full=!!x.w&&!x.sk&&!x.s&&!x.e&&!Number(x.m)&&!en.noT;
  const s=x.s||(full?en.s:'')||'',e=x.e||(full?en.e:'')||'';
  const days=full?Number(en.ed)||0:(s&&e&&e<s?1:0);
  const offset=!full&&s&&en.s&&Number(en.ed)>0&&s<en.s?1:0;
  const dayLabel=n=>n?(n===1?'翌日 ':'+'+n+'日 '):'';
  const end=dayLabel(days+offset)+e;
  const range=s?(dayLabel(offset)+s+' → '+(e?end:'終了未記入')):(e?'開始未記入 → '+end:'時刻未記入');
  const m=s&&e?durMin(s,e,days):Number(x.m)||0;
  return '<span class="dl-clock"><strong>'+esc(range)+'</strong>'+(m>0?'<span class="dl-duration">'+esc(durText(m))+'</span>':'')+'</span>'+
    (x.sk?'<span class="dl-context">合間に行ったこと</span>':full?'<span class="dl-context">この記録の間ずっと</span>':'');
}
function dlFold(html,label,kind,identity){
  const source=identity||html;
  let hash=2166136261;for(let i=0;i<source.length;i++)hash=Math.imul(hash^source.charCodeAt(i),16777619);
  const key=kind+'-'+(hash>>>0),open=DL_OPEN.has(key);
  return '<span class="dl-fold '+kind+(open?' is-open':'')+'"><span class="dl-fold-body">'+html+'</span><span class="dl-toggle" role="button" tabindex="0" data-dl-toggle="'+key+'" aria-expanded="'+open+'" data-dl-label="'+esc(label)+'">'+esc(open?'閉じる':label)+' '+(open?'▴':'▾')+'</span></span>';
}
function dlText(html,text){return String(text).length>130||String(text).split('\n').length>4?dlFold(html,'本文をすべて見る','dl-prose'):html;}
function dlMeta(html){return dlFold(html,'分類・使ったものを見る','dl-meta');}
function dlDevices(x){return x.d?'<span class="a-ap">'+wmValues(x,'d').map(id=>{const d=toolOf(id);return '<i>'+esc(d?d.ic+' '+(id==='_other'&&x.dx?x.dx:d.lb):id)+'</i>';}).join('')+'</span>':'';}
function dlSettings(html,x,en){
  if(!html)return '';
  const md=actMdOn(x),m=md?(Number(x.mdm)||actShareMin(en,x)):0;
  const rows=(en._sgR&&en._sgR.acts)||en.acts||[];
  const identity=[typeof ui==='undefined'?'':ui.date,en.s,en.p,en.rt,rows.indexOf(x)].join('|');
  return dlFold(html,(md?'🕳️ ムダ'+(m?' '+durText(m):''):x.wk?'💼 仕事':'ムダ・仕事')+'の設定','dl-settings',identity);
}
function dlToggleEvent(ev){
  const t=ev.target&&ev.target.closest&&ev.target.closest('[data-dl-toggle]');if(!t)return;
  if(ev.type==='keydown'&&!['Enter',' '].includes(ev.key))return;
  ev.preventDefault();ev.stopPropagation();
  const p=t.closest('.dl-fold'),open=!p.classList.contains('is-open');
  p.classList.toggle('is-open',open);t.setAttribute('aria-expanded',String(open));
  t.textContent=(open?'閉じる':t.dataset.dlLabel)+' '+(open?'▴':'▾');
  if(open)DL_OPEN.add(t.dataset.dlToggle);else DL_OPEN.delete(t.dataset.dlToggle);
}
document.addEventListener('click',dlToggleEvent,true);
document.addEventListener('keydown',dlToggleEvent,true);
