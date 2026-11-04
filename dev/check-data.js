#!/usr/bin/env node
'use strict';
/* 公開前の機械検査①：二重記録ゼロ（控えの state で見る）。同じ日に、開始・終わり・場所（移動はルート）・種類が同じ記録が2つ以上あれば NG。
   使い方: node dev/check-data.js <state.json> ／ 落ちたら公開しない（scan-public.js と同列）。古い重複は --since YYYY-MM-DD で除ける */
const fs = require('fs');
const argv = process.argv.slice(2);
const si = argv.indexOf('--since');
const since = si >= 0 ? argv[si + 1] : '0000-00-00';
const file = argv.find((a, i) => a !== '--since' && argv[i - 1] !== '--since');
if (!file) { console.log('使い方: node dev/check-data.js <state.json> [--since YYYY-MM-DD]'); process.exit(2); }
const J = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = ((J.state || J).entries) || {};
let n = 0, ng = [];
for (const d in entries) {
  if (d < since) continue;
  const seen = {};
  for (const k in entries[d]) {
    const e = entries[d][k];
    if (!e || e.del || e.noT || !e.s) continue;
    n++;
    const key = [e.s, e.e || '', e.mv ? (e.rt || '') : (e.p || ''), e.k || '', e.mv ? 1 : 0].join('|');
    if (seen[key]) ng.push(d + ' ' + key + ' ＝ ' + seen[key] + ' ／ ' + k); else seen[key] = k;
  }
}
console.log('記録 ' + n + ' 件を確認。二重記録 ' + ng.length + ' 件');
ng.slice(0, 40).forEach(x => console.log('  [NG] ' + x));
process.exit(ng.length ? 1 : 0);
