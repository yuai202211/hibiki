'use strict';
const fs=require('fs'),path=require('path');
module.exports=function(h){
 const rep=(a,b)=>{if(h.split(a).length!==2)throw Error('todo-flow anchor: '+a.slice(0,100));h=h.replace(a,b);};
 const start=h.indexOf('function renderTodoPage(){'),end=h.indexOf("let QG_OPEN='';",start);
 if(start<0||end<start)throw Error('todo renderer missing');
 h=h.slice(0,start)+'function renderTodoPage(){return tfRender();}\n'+h.slice(end);
 rep("if(!pb||pb.querySelector('.pln-wrap'))return;","if(!pb||pb.querySelector('.tf-root')||pb.querySelector('.pln-wrap'))return;");
 rep('function closePage(){','function closePage(){try{tfSaveDraft();}catch(e){}');
 rep("function taGrow(ta){if(!ta||ta._grow||ta.tagName!=='TEXTAREA')return;","function taGrow(ta){if(!ta||ta._grow||ta.tagName!=='TEXTAREA'||ta.closest('.tf-root'))return;");
 rep("if(host.id==='page'&&pageMode==='srch')return;","if(host.id==='page'&&(pageMode==='srch'||host.querySelector('.tf-root')))return;");
 rep('function keepVisible(el){if(!kvTxt(el))return;','function keepVisible(el){if(!kvTxt(el))return;if(el.closest(".tf-root"))return tfKeepVisible(el);');
 rep("a.closest('#scr,#pane,#sheet,#sheet2')","a.closest('#scr,#pane,#sheet,#sheet2,#page .tf-root')");
 rep('function openTodoPage(){closeSheet();',"function openTodoPage(){TF.search=false;TF.confirm='';closeSheet();");
 rep("$('teDone').onclick=()=>{save();closeSub();tdComplete(id);if(after)after();};","$('teDone').onclick=()=>{save();closeSub();if(pageMode==='todo'&&$('page').querySelector('.tf-root')){tfComplete(id,false);return;}tdComplete(id);if(after)after();};");
 rep("t.closest('input,textarea,select,[contenteditable=\"true\"],.scrub,.mg-ghost')","t.closest('input,textarea,select,[contenteditable=\"true\"],.scrub,.mg-ghost,.tf-grip')");
 rep("filter(id=>!m[id].del&&!m[id].idea)","filter(id=>!m[id].del&&!m[id].idea&&!m[id].tfDraft)");
 rep("const op=tdOpen().filter(x=>!tdHib(x)).length+plnOpen(todayStr()).length+plnLate().length,dn=tdDoneToday().length;","const op=tfToday(false).length,dn=tfToday(true).length;");
 const nav=/(<button[^>]*id="navTodo"[\s\S]*?<span>)予定(<\/span>)/;if(!nav.test(h))throw Error('todo nav missing');h=h.replace(nav,'$1ToDo$2');
 // Replace the old renderer instead of retaining two full list implementations.
 fs.writeFileSync(path.join(__dirname,'../todo-flow.css'),fs.readFileSync(path.join(__dirname,'todo-flow.css')));
 rep('</style>','</style>\n<link rel="stylesheet" href="./todo-flow.css?v=c50.35">');
 rep('\nboot();','\n'+fs.readFileSync(path.join(__dirname,'todo-flow.js'),'utf8')+'\nboot();');
 return h;
};
