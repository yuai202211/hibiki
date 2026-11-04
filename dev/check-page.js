/* 公開前の機械検査②③：試験のタブ（幅360px）のコンソールで流す。戻り値の ok が false なら公開しない。
   ② 入力中に欄が戻らない：記録の画面で文字と時刻を入れ、裏で render() が走っても値が残るか
   ③ 360pxで切れない：トップ・日記で 横のはみ出し／「…」切れ／ボタンの文字の切れ が無いか */
(async function(){const W=ms=>new Promise(r=>setTimeout(r,ms)),out={w:innerWidth,input:[],clip:[]};
  const scan=nm=>{const root=document.getElementById('app');if(document.documentElement.scrollWidth>innerWidth+1)out.clip.push(nm+'：画面が横にはみ出す '+document.documentElement.scrollWidth);
    root.querySelectorAll('*').forEach(e=>{if(!e.offsetWidth||!e.childElementCount&&!String(e.textContent).trim())return;const c=getComputedStyle(e);if(e.closest('.sn-row,.rd-tabs,[style*="overflow"]'))return;
      if(c.textOverflow==='ellipsis'&&e.scrollWidth>e.clientWidth+1)out.clip.push(nm+'：…切れ '+String(e.textContent).trim().slice(0,24));
      if(c.overflowX==='visible'&&e.childElementCount===0&&e.scrollWidth>e.clientWidth+2&&e.getBoundingClientRect().right>innerWidth+1)out.clip.push(nm+'：はみ出し '+String(e.textContent).trim().slice(0,24));});};
  const d=todayStr();topView='top';ui.date=d;render();await W(500);scan('トップ');
  topView='diary';render();await W(500);scan('日記');
  openEntrySheet(d,{hour:new Date().getHours(),wr:true});await W(400);
  const t=document.getElementById('o1t')||document.querySelector('#acRows .ac-t'),s=document.querySelector('#acRows .ac-s');
  if(t){t.value='検査の文字';t.dispatchEvent(new Event('input',{bubbles:true}));}if(s){s.value='10:10';s.dispatchEvent(new Event('input',{bubbles:true}));}
  try{render();}catch(e){out.input.push('render で例外 '+e);}await W(300);
  const t2=document.getElementById('o1t')||document.querySelector('#acRows .ac-t'),s2=document.querySelector('#acRows .ac-s');
  if(t2&&t2.value!=='検査の文字')out.input.push('コメントが戻った：'+t2.value);if(s2&&s2.value!=='10:10')out.input.push('時刻が戻った：'+s2.value);
  try{closeSheet();}catch(e){}try{entDraft(d,null);}catch(e){}
  out.ok=!out.input.length&&!out.clip.length;return JSON.stringify(out);})()
