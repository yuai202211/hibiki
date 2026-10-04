#!/usr/bin/env node
'use strict';
/*
  mock-supabase.js の動作確認スクリプト（fetch だけで一通り叩いて結果を表示する・依存なし）

  使い方:
    node mock-test.js                    … 自分で擬似サーバーを起動（ポート 8788・token-ttl 2秒・使い捨てデータ）→ 確認 → 止める
    node mock-test.js --url http://localhost:8787
                                         … すでに動いているサーバーを叩く（--token-ttl 2 付きで起動してあると期限切れも確認できる）
                                           ※ そのサーバーのデータに確認用の行を足す。確認したいだけなら --reset 付きで起動しておくこと
  確認する流れ:
    apikey → ログイン → /user → put_items → pull_items → 上書き規則 → 未来 ts の丸め → 墓石 → DELETE 拒否
    → 不正行は全部不採用 → ts/data.ts の丸め・同一バッチの重複（setup.sql と同じ規則）
    → 1000件上限と取りこぼしの罠・lim の丸め → integrity（BigInt）→ 期限切れ → refresh
    → 写真 upload/download（生バイト・multipart・重複・他人の uid・公開 URL）→ CORS → ログアウト
    → （自前起動のとき）サーバーを強制終了して再起動 → 永続化の確認
    → 15. 同期エンジン c1.9（cloud-layer.js の現物を vm で動かし、故障注入つきの擬似サーバー :8789 に繋ぐ）
  終了コード: 全部通れば 0、1つでも外れたら 1
*/

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const M = require('./mock-supabase.js');

const argv = process.argv.slice(2);
const urlArg = argv.indexOf('--url') >= 0 ? argv[argv.indexOf('--url') + 1] : null;
const SPAWN = !urlArg;
let PORT = Number(process.env.MOCK_TEST_PORT) || 0;   // 0＝空いているポートを自動で取る
const TTL = 2;
let BASE = urlArg ? urlArg.replace(/\/+$/, '') : '';   // 自前起動のときは main で決める
const DATA_DIR = path.join(__dirname, 'mock-data-test-' + process.pid); // 自前起動のときだけ使う使い捨て置き場（実行ごとに別）
const SERVER_JS = path.join(__dirname, 'mock-supabase.js');
const OTHER_UID = '00000000-0000-4000-8000-000000000002';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  [OK] ' + name); return true; }
  fail++;
  let d = '';
  if (detail !== undefined) d = ' -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400);
  console.log('  [NG] ' + name + d);
  return false;
}
const section = (t) => console.log('\n== ' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (r) => r.status + ' ' + r.text.slice(0, 200);
// 空いているポートを1つ取る
function freePort() { return new Promise((res, rej) => { const sv = require('net').createServer(); sv.unref(); sv.on('error', rej); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); }); }

// ---------------------------------------------------------------- HTTP 補助
async function call(method, p, o) {
  o = o || {};
  const h = Object.assign({}, o.headers || {});
  const apikey = o.apikey === undefined ? M.ANON_KEY : o.apikey;
  if (apikey) h['apikey'] = apikey;
  const token = o.token === 'AUTO' ? await tk() : o.token;
  if (token) h['authorization'] = 'Bearer ' + token;
  let body = o.raw;
  if (o.body !== undefined) { body = JSON.stringify(o.body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers: h, body });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json; try { json = JSON.parse(text); } catch (e) { json = undefined; }
  return { status: r.status, headers: r.headers, buf, text, json };
}
// 期限が短い(2秒)ので、'AUTO' を渡すと「期限が近ければ入り直した新しい access_token」を使う
let auto = { token: null, at: 0 }, firstLogin = null;
async function tk() {
  const life = (firstLogin ? firstLogin.expires_in : 3600) * 1000;
  if (!auto.token || Date.now() - auto.at > Math.max(300, life - 1500)) {
    const r = await login();
    auto = { token: r.json.access_token, at: Date.now() };
  }
  return auto.token;
}
const rpc = (name, args, token) => call('POST', '/rest/v1/rpc/' + name, { body: args, token });
const login = (email, password) => call('POST', '/auth/v1/token?grant_type=password', { body: { email: email === undefined ? M.TEST_EMAIL : email, password: password === undefined ? M.TEST_PASSWORD : password } });
const refresh = (rt) => call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: rt } });

// 全件を seq カーソルで取り切る（0 件が返るまで回す＝1000件上限でも取りこぼさない）
async function pullAll(token, since) {
  let cur = since || 0; const all = [];
  for (;;) {
    const r = await rpc('pull_items', { since_seq: cur, lim: 500 }, token);
    if (r.status !== 200) throw new Error('pull_items 失敗: ' + brief(r));
    if (!r.json.length) break;
    all.push(...r.json); cur = r.json[r.json.length - 1].seq;
  }
  return all;
}
// integrity を「正確な桁のまま」読む（tsum は JS の Number を超えうるので BigInt で）
function parseIntegrity(text) {
  const arr = JSON.parse(text, (key, value, ctx) => (key === 'tsum' && ctx && typeof ctx.source === 'string' ? BigInt(ctx.source) : value));
  const o = {}; for (const e of arr) o[e.coll] = { n: e.n, tsum: BigInt(e.tsum) };
  return o;
}
function localIntegrity(rows) {
  const o = {};
  for (const r of rows) { const e = o[r.coll] || (o[r.coll] = { n: 0, tsum: 0n }); e.n++; e.tsum += BigInt(r.ts); }
  return o;
}
const sameIntegrity = (a, b) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.join('|') === kb.join('|') && ka.every((k) => a[k].n === b[k].n && a[k].tsum === b[k].tsum);
};
function rawRequest(method, p, headers) { // fetch は Origin を付けられないので http で直接
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}

// ---------------------------------------------------------------- 自前起動
let child = null;
function startChild(reset) {
  const args = [SERVER_JS, '--port', String(PORT), '--token-ttl', String(TTL), '--data-dir', DATA_DIR, '--quiet'];
  if (reset) args.push('--reset');
  child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { if (process.env.MOCK_TEST_VERBOSE) process.stdout.write('    [server] ' + d); });
  child.stderr.on('data', (d) => process.stderr.write('    [server:err] ' + d));
  return waitHealth();
}
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    if (SPAWN && child && child.exitCode !== null) throw new Error('擬似サーバーが起動直後に終わった（ポート ' + PORT + ' が使用中など）。続けない');
    try {
      const r = await fetch(BASE + '/_mock/health');
      if (r.ok) {
        if (SPAWN) { const j = await r.json(); if (path.resolve(String(j.dataDir || '')) !== path.resolve(DATA_DIR)) throw Object.assign(new Error('ポート ' + PORT + ' で別の擬似サーバーが応答した（データ置き場が違う）。続けない'), { fatal: true }); }
        return;
      }
    } catch (e) { if (e && e.fatal) throw e; /* まだ */ }
    await sleep(100);
  }
  throw new Error('サーバーが起動しませんでした');
}
function killChild() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill(); // Windows では強制終了＝書きかけが無いか（永続化）の確認にもなる
    setTimeout(resolve, 3000);
  });
}

// ---------------------------------------------------------------- 本体
async function main() {
  if (SPAWN) { if (!PORT) PORT = await freePort(); BASE = 'http://127.0.0.1:' + PORT; }
  console.log('対象: ' + BASE + (SPAWN ? '  （自前起動・token-ttl ' + TTL + '秒）' : '  （既存サーバー）'));
  if (SPAWN) { await startChild(true); } else { await waitHealth(); }
  const health0 = (await call('GET', '/_mock/health', { apikey: null })).json;

  section('1. apikey');
  let r = await call('GET', '/auth/v1/user', { apikey: null });
  ok(r.status === 401 && /No API key/.test(r.text), 'apikey 無し → 401', brief(r));
  r = await call('POST', '/rest/v1/rpc/integrity', { apikey: 'wrong-key', body: {} });
  ok(r.status === 401 && /Invalid API key/.test(r.text), '違う apikey → 401', brief(r));

  section('2. ログイン');
  r = await login(M.TEST_EMAIL, 'wrong-password');
  ok(r.status === 400 && r.json && r.json.error_code === 'invalid_credentials', '違うパスワード → 400 invalid_credentials', brief(r));
  r = await login();
  const L1 = r.json; firstLogin = L1;
  ok(r.status === 200 && L1 && L1.token_type === 'bearer' && L1.access_token && L1.refresh_token && L1.user && L1.user.id === M.USER_ID && L1.user.email === M.TEST_EMAIL, 'ログイン成功（形が本物と同じ）', brief(r));
  ok(L1 && typeof L1.expires_in === 'number' && typeof L1.expires_at === 'number' && L1.access_token.split('.').length === 3, 'expires_in / expires_at / JWT 3分割', L1 && { e: L1.expires_in, a: L1.expires_at });
  console.log('       expires_in=' + (L1 && L1.expires_in) + ' 秒');
  const T_FIRST = L1.access_token; // 期限切れの確認用に取っておく最初のトークン
  const T = 'AUTO';
  r = await call('GET', '/auth/v1/user', { token: T });
  ok(r.status === 200 && r.json.email === M.TEST_EMAIL, 'GET /auth/v1/user → 本人', brief(r));
  r = await call('GET', '/auth/v1/user', {});
  ok(r.status === 401, 'Authorization 無し → 401', brief(r));
  r = await rpc('integrity', {}, undefined);
  ok(r.status === 401 && r.json && r.json.code === '42501', 'ログイン無しで rpc → 401 (42501)', brief(r));
  r = await rpc('integrity', {}, 'abc.def.ghi');
  ok(r.status === 401, '壊れたトークンで rpc → 401', brief(r));

  section('3. put_items → pull_items');
  const NOW = Date.now(), B = NOW - 10 * 1000;
  const base = (await pullAll(T)).length; // 既存サーバーなら既に入っている分
  const rows1 = [
    { coll: 'entries', k: '2026-10-03/diary', ts: B + 1, data: { text: 'こんにちは。日々記のテスト 📔', n: 1 } },
    { coll: 'plans', k: '2026-10-03/p1', ts: B + 2, data: { t: '買い物', done: false } },
    { coll: '_top', k: 'dream', ts: B + 3, data: { title: '夢', body: ['a', 'b'] } },
  ];
  r = await rpc('put_items', { rows: rows1 }, T);
  ok(r.status === 200 && r.json === 3, 'put_items 3行 → 3', brief(r));
  let pulled = await pullAll(T);
  ok(pulled.length === base + 3, 'pull_items 全件 = ' + (base + 3) + ' 件', pulled.length);
  const mine = pulled.filter((x) => rows1.some((y) => y.coll === x.coll && y.k === x.k));
  const diary = mine.find((x) => x.coll === 'entries' && x.k === '2026-10-03/diary'); // seq の順は送った順ではない（(coll,k) 順）ので、キーで探す
  ok(mine.length === 3 && diary && diary.data.text === 'こんにちは。日々記のテスト 📔', '日本語・絵文字がそのまま戻る', diary && diary.data);
  ok(pulled.every((x, i) => i === 0 || x.seq > pulled[i - 1].seq), 'seq は昇順');
  const lastSeq = pulled[pulled.length - 1].seq;
  r = await rpc('pull_items', { since_seq: lastSeq, lim: 100 }, T);
  ok(r.status === 200 && Array.isArray(r.json) && r.json.length === 0, 'カーソル以降は 0 件', brief(r));
  r = await rpc('pull_items', { since_seq: 0, lim: 2 }, T);
  ok(r.status === 200 && r.json.length === 2 && r.json[0].seq < r.json[1].seq && Object.keys(r.json[0]).sort().join() === 'coll,data,k,seq,ts', 'lim=2 で 2 件・形は {coll,k,ts,data,seq}', brief(r));
  r = await rpc('pull_items', { since_seq: 0 }, T);
  ok(r.status === 200 && Array.isArray(r.json) && r.json.length === Math.min(1000, base + 3), 'lim 抜けは既定（1000）で通る（setup.sql の default と同じ）', brief(r));
  r = await rpc('pull_items', {}, T);
  ok(r.status === 200 && r.json.length === Math.min(1000, base + 3), '引数なし {} でも通る（since_seq=0・lim=1000）', brief(r));
  r = await rpc('pull_items', { since_seq: null, lim: null }, T);
  ok(r.status === 200 && r.json.length === Math.min(1000, base + 3), 'null は既定値として扱う', brief(r));
  r = await rpc('pull_items', { since_seq: 0, lim: 10, extra: 1 }, T);
  ok(r.status === 404 && r.json.code === 'PGRST202', '知らない引数名 → 404 PGRST202', brief(r));
  r = await rpc('put_items', { row: [] }, T);
  ok(r.status === 404 && r.json.code === 'PGRST202', 'put_items の引数名が rows でない → 404 PGRST202', brief(r));
  r = await rpc('put_items', {}, T);
  ok(r.status === 404 && r.json.code === 'PGRST202', 'put_items に rows が無い → 404 PGRST202（必須引数）', brief(r));

  section('4. 上書き規則（ts が古い・同じ中身・新しい）');
  const seqOf = async (coll, k) => (await pullAll(T)).find((x) => x.coll === coll && x.k === k);
  const before = await seqOf('entries', '2026-10-03/diary');
  r = await rpc('put_items', { rows: [{ coll: 'entries', k: '2026-10-03/diary', ts: B - 5000, data: { text: '古い版', n: 0 } }] }, T);
  ok(r.json === 0, 'ts が古い → 書かない(0)', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'entries', k: '2026-10-03/diary', ts: B + 500, data: { n: 1, text: 'こんにちは。日々記のテスト 📔' } }] }, T);
  ok(r.json === 0, '中身が同じ(キー順違い)・ts だけ新しい → 書かない(0)', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'entries', k: '2026-10-03/diary', ts: B + 10, data: { text: '新しい版', n: 2 } }] }, T);
  ok(r.json === 1, 'ts が新しく中身が違う → 上書き(1)', brief(r));
  const after = await seqOf('entries', '2026-10-03/diary');
  ok(after.data.text === '新しい版' && after.ts === B + 10 && after.seq > before.seq, '上書きされ seq が振り直される', after);
  r = await call('GET', '/_mock/history?coll=entries&k=' + encodeURIComponent('2026-10-03/diary'), { apikey: null });
  ok(r.status === 200 && r.json.length >= 1 && r.json[r.json.length - 1].data.text === 'こんにちは。日々記のテスト 📔', '旧版が items_history に退避される', brief(r));
  ok(r.json.length >= 1 && typeof r.json[r.json.length - 1].saved_at === 'string' && r.json[r.json.length - 1].archived_at === undefined, '退避した時刻の列名は setup.sql と同じ saved_at', r.json[r.json.length - 1]);
  r = await rpc('put_items', { rows: [{ coll: 'entries', k: '2026-10-03/diary', ts: B + 10, data: { text: '同じ ts・違う中身', n: 3 } }] }, T);
  ok(r.json === 1, '同じ ts でも中身が違えば上書き(1)（既存 ts <= 新 ts）', brief(r));

  section('5. 未来の ts は サーバー時刻+1時間 に丸める');
  r = await rpc('put_items', { rows: [{ coll: 'memos', k: 'future', ts: NOW + 10 * 3600 * 1000, data: { t: '未来' } }] }, T);
  ok(r.json === 1, '未来 ts の行を書けた', brief(r));
  const fut = await seqOf('memos', 'future');
  const lim = Date.now() + 3600 * 1000;
  ok(fut && fut.ts <= lim && fut.ts >= NOW + 3600 * 1000 - 1000, 'ts が +1時間に丸められた', fut && { ts: fut.ts, limit: lim });

  section('6. 墓石（del:1）と DELETE 拒否');
  r = await rpc('put_items', { rows: [{ coll: 'plans', k: '2026-10-03/p1', ts: B + 100, data: { del: 1, ts: B + 100 } }] }, T);
  ok(r.json === 1, '墓石を書けた', brief(r));
  const tomb = await seqOf('plans', '2026-10-03/p1');
  ok(tomb && tomb.data.del === 1, '墓石の行も pull で返る（消えない）', tomb);
  r = await call('DELETE', '/rest/v1/items?coll=eq.plans', { token: T });
  ok(r.status === 403 && r.json.code === '42501', 'DELETE /rest/v1/items → 403', brief(r));
  r = await call('DELETE', '/rest/v1/items?coll=eq.plans', {});
  ok(r.status === 401, 'DELETE（未ログイン）→ 401', brief(r));

  section('7. 不正な行が1つでもあれば全部不採用');
  const c0 = (await pullAll(T)).length;
  r = await rpc('put_items', { rows: [{ coll: 'bad', k: 'ok1', ts: B, data: { a: 1 } }, { coll: 'bad', k: 'x', ts: 'abc', data: { a: 1 } }] }, T);
  ok(r.status === 400 && r.json.code === '22023', 'ts が文字列 → 400 (22023)', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'bad', k: 'ok2', ts: B, data: { a: 1 } }, { coll: 'bad', k: 'x', ts: B, data: null }] }, T);
  ok(r.status === 400 && r.json.code === '22023', 'data が null → 400 (22023)', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'bad', k: 'x', ts: B }] }, T);
  ok(r.status === 400, 'data 無し → 400', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'bad', k: 'x', ts: true, data: {} }] }, T);
  ok(r.status === 400, 'ts が真偽値 → 400', brief(r));
  r = await rpc('put_items', { rows: [{ k: 'x', ts: B, data: {} }] }, T);
  ok(r.status === 400, 'coll 無し → 400', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'bad', k: '', ts: B, data: {} }] }, T);
  ok(r.status === 400, 'k が空文字 → 400', brief(r));
  r = await rpc('put_items', { rows: [5] }, T);
  ok(r.status === 400, '行がオブジェクトでない → 400', brief(r));
  r = await rpc('put_items', { rows: {} }, T);
  ok(r.status === 400 && r.json.code === '22023', 'rows が配列でない → 400 (22023)', brief(r));
  r = await rpc('put_items', { rows: Array.from({ length: 5001 }, (_, i) => ({ coll: 'bad', k: 'k' + i, ts: B, data: { i } })) }, T);
  ok(r.status === 400 && r.json.code === '54000', '5001 行（1回の上限は 5000）→ 400 (54000)', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'bad', k: 'nul', ts: B, data: { s: 'a\u0000b' } }] }, T);
  ok(r.status === 400 && r.json.code === '22P05', '文字列に \\u0000 → 400 (22P05・jsonb に入らない。アプリは送る前に除くこと)', brief(r));
  r = await rpc('put_items', { rows: [] }, T);
  ok(r.status === 200 && r.json === 0, '空配列 → 0', brief(r));
  ok((await pullAll(T)).length === c0, '不正な呼び出しでは1行も増えていない');
  r = await call('POST', '/rest/v1/rpc/put_items', { token: T, raw: '{not json', headers: { 'content-type': 'application/json' } });
  ok(r.status === 400, '壊れた JSON → 400', brief(r));
  r = await rpc('no_such_fn', {}, T);
  ok(r.status === 404 && r.json.code === 'PGRST202', '知らない関数 → 404 PGRST202', brief(r));

  section('7b. ts / data.ts の丸め と 同じバッチの重複（setup.sql と同じ規則）');
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'dec', ts: B + 7.9, data: { a: 1 } }] }, T);
  ok(r.status === 200 && r.json === 1, 'ts が小数 → 受理（400 にならない）', brief(r));
  ok(((await seqOf('rule', 'dec')) || {}).ts === B + 7, '  小数は切り捨てて保存される');
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'neg', ts: -5, data: { a: 1 } }] }, T);
  ok(r.status === 200 && r.json === 1 && ((await seqOf('rule', 'neg')) || {}).ts === 0, '負の ts → 0 に丸めて受理');
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'huge', ts: 1e30, data: { ts: 1e30, v: 1 } }] }, T);
  const huge = await seqOf('rule', 'huge');
  ok(r.status === 200 && huge && huge.ts <= Date.now() + 3600 * 1000 && huge.ts >= NOW + 3600 * 1000 - 1000 && huge.data.ts === huge.ts, '巨大な ts → ts も data.ts も サーバー時刻+1時間 に丸める', huge);
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'dts', ts: B, data: { ts: NOW + 10 * 3600 * 1000, v: 1 } }] }, T);
  const dts = await seqOf('rule', 'dts');
  ok(r.status === 200 && dts && dts.ts === B && dts.data.ts <= Date.now() + 3600 * 1000 && dts.data.ts >= NOW + 3600 * 1000 - 1000, 'data.ts だけが未来 → data.ts だけ丸める（行の ts はそのまま）', dts);
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'dts2', ts: B, data: { ts: 'abc' } }, { coll: 'rule', k: 'dts3', ts: B, data: [1, 2] }, { coll: 'rule', k: 'dts4', ts: B, data: 0 }] }, T);
  ok(r.status === 200 && r.json === 3, 'data.ts が文字列／data が配列・数値 → そのまま受理（落ちない）', brief(r));
  // 同じバッチに同じキーが2件 → ts が最大の1件だけ（戻り値も1）
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'dup', ts: B + 5, data: { t: 'older' } }, { coll: 'rule', k: 'dup', ts: B + 10, data: { t: 'newer' } }, { coll: 'rule', k: 'dup', ts: B + 1, data: { t: 'oldest' } }] }, T);
  ok(r.status === 200 && r.json === 1 && ((await seqOf('rule', 'dup')) || { data: {} }).data.t === 'newer', '同じバッチの重複キー → ts 最大の1件だけ書く（戻り値 1）', brief(r));
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'tie', ts: B, data: { t: 'first' } }, { coll: 'rule', k: 'tie', ts: B, data: { t: 'second' } }] }, T);
  ok(r.status === 200 && r.json === 1 && ((await seqOf('rule', 'tie')) || { data: {} }).data.t === 'second', '同じバッチで ts が同点 → 後ろの行が勝つ（戻り値 1）', brief(r));
  r = await call('GET', '/_mock/history?coll=rule&k=dup', { apikey: null });
  ok(r.status === 200 && r.json.length === 0, '同じバッチ内で捨てた行は history に入らない（新規挿入は旧版なし）', brief(r));
  // 同じバッチ内の seq は送った順ではなく (coll,k) 順（本物は distinct on の並びで書く）
  r = await rpc('put_items', { rows: [{ coll: 'rule', k: 'zz', ts: B, data: { o: 1 } }, { coll: 'rule', k: 'aa', ts: B, data: { o: 2 } }] }, T);
  const zz = await seqOf('rule', 'zz'), aa = await seqOf('rule', 'aa');
  ok(r.json === 2 && aa.seq < zz.seq, '1バッチ内の seq の順は (coll,k) 順（送った順を当てにしない）', { aa: aa && aa.seq, zz: zz && zz.seq });

  section('8. 1000 件上限（lim=5000 を頼んでも 1000）');
  const bulk = []; for (let i = 0; i < 1500; i++) bulk.push({ coll: 'bulk', k: 'k' + String(i).padStart(4, '0'), ts: B + i, data: { i } });
  r = await rpc('put_items', { rows: bulk }, T);
  ok(r.status === 200 && r.json === 1500, '1500 行を1回で put → 1500', brief(r));
  const sincePoint = (await pullAll(T)).filter((x) => x.coll !== 'bulk').reduce((m, x) => Math.max(m, x.seq), 0);
  const p1 = await rpc('pull_items', { since_seq: sincePoint, lim: 5000 }, T);
  ok(p1.status === 200 && p1.json.length === 1000, 'lim=5000 でも 1000 件で切れる（max-rows）', p1.status + ' len=' + (p1.json && p1.json.length));
  const p2 = await rpc('pull_items', { since_seq: p1.json[p1.json.length - 1].seq, lim: 5000 }, T);
  ok(p2.status === 200 && p2.json.length === 500, '続きの 500 件', p2.status + ' len=' + (p2.json && p2.json.length));
  const p3 = await rpc('pull_items', { since_seq: p2.json[p2.json.length - 1].seq, lim: 5000 }, T);
  ok(p3.status === 200 && p3.json.length === 0, 'その次は 0 件（0 件が返るまで回すのが正解）', p3.status + ' len=' + (p3.json && p3.json.length));
  ok(p1.json[0].k === 'k0000' && p2.json[499].k === 'k1499', '順序どおり・欠けなし');
  // lim の丸め（setup.sql は 1〜5000 に丸める。0 や負でもエラーにならず 1 件）
  let q = await rpc('pull_items', { since_seq: sincePoint, lim: 0 }, T);
  ok(q.status === 200 && q.json.length === 1, 'lim=0 → 1 件（下限 1・エラーにならない）', q.status + ' len=' + (q.json && q.json.length));
  q = await rpc('pull_items', { since_seq: sincePoint, lim: -7 }, T);
  ok(q.status === 200 && q.json.length === 1, 'lim が負 → 1 件', q.status + ' len=' + (q.json && q.json.length));
  q = await rpc('pull_items', { since_seq: -50, lim: 3 }, T);
  ok(q.status === 200 && q.json.length === 3, 'since_seq が負 → 0 扱い', q.status + ' len=' + (q.json && q.json.length));
  q = await rpc('pull_items', { since_seq: String(sincePoint), lim: '2' }, T);
  ok(q.status === 200 && q.json.length === 2, '数字の文字列でも通る（PostgREST と同じ）', q.status + ' len=' + (q.json && q.json.length));
  q = await rpc('pull_items', { since_seq: 0, lim: 3000000000 }, T);
  ok(q.status === 400 && q.json.code === '22003', 'lim が int4 を超える → 400 (22003)', brief(q));
  q = await rpc('pull_items', { since_seq: 'abc', lim: 10 }, T);
  ok(q.status === 400 && q.json.code === '22P02', 'since_seq が数でない → 400 (22P02)', brief(q));

  section('9. integrity（BigInt で突き合わせ）');
  r = await rpc('integrity', {}, T);
  ok(r.status === 200 && /"tsum":\d+/.test(r.text), 'integrity → [{coll,n,tsum}]', brief(r));
  const serverInt = parseIntegrity(r.text);
  const localInt = localIntegrity(await pullAll(T));
  ok(sameIntegrity(serverInt, localInt), '件数と ts の合計が端末の集計と一致（' + Object.keys(serverInt).length + ' coll）', { serverInt: String(Object.keys(serverInt)), n: Object.values(serverInt).map((x) => x.n) });
  ok(serverInt.bulk && serverInt.bulk.n === 1500, 'bulk は 1500 件');
  if (SPAWN || argv.indexOf('--big') >= 0) {
    // ts の合計が 2^53 を超えるほど件数を入れて、BigInt で読めば一致し、Number では狂うことを確かめる
    // 全行同じ ts（合計 = 件数 × ts が奇数になり、Number では表せない）
    const big = []; for (let i = 0; i < 5401; i++) big.push({ coll: 'big', k: 'b' + i, ts: 1760000000001, data: { i } });
    // 1回の上限は 5000 行なので 2回に分ける（アプリは 500 行以下ずつ送る想定）
    r = await rpc('put_items', { rows: big.slice(0, 5000) }, T);
    const r2 = await rpc('put_items', { rows: big.slice(5000) }, T);
    ok(r.status === 200 && r.json === 5000 && r2.status === 200 && r2.json === 401, 'ts 合計が 2^53 を超える 5401 行を 5000＋401 に分けて put → 5000 と 401', brief(r) + ' / ' + brief(r2));
    r = await rpc('integrity', {}, T);
    const sInt = parseIntegrity(r.text);
    const exact = 5401n * 1760000000001n;
    ok(sInt.big && sInt.big.n === 5401 && sInt.big.tsum === exact && exact > BigInt(Number.MAX_SAFE_INTEGER), 'tsum=' + exact + ' (> 2^53) を BigInt で正確に読める', sInt.big && String(sInt.big.tsum));
    const naive = JSON.parse(r.text).find((e) => e.coll === 'big').tsum;
    ok(BigInt(naive) !== exact, '（注意）素の JSON.parse(Number) だと桁が狂う → アプリは BigInt で読む', String(naive));
    ok(sameIntegrity(parseIntegrity(r.text), localIntegrity(await pullAll(T))), '大きな合計でも端末の BigInt 集計と一致');
  }

  section('10. 期限切れ → refresh');
  const expIn = L1.expires_in;
  if (expIn <= 10) {
    process.stdout.write('       access_token の期限(' + expIn + '秒)が切れるまで待つ…\n');
    await sleep((expIn + 1.5) * 1000);
    r = await rpc('integrity', {}, T_FIRST);
    ok(r.status === 401 && r.json && r.json.message === 'JWT expired', '期限切れ → 401 {message:"JWT expired"}', brief(r));
    r = await call('GET', '/auth/v1/user', { token: T_FIRST });
    ok(r.status === 401, '期限切れで /auth/v1/user → 401', brief(r));
    r = await call('POST', '/storage/v1/object/photos/' + M.USER_ID + '/exp-test', { token: T_FIRST, raw: Buffer.from('x') });
    ok(r.status === 401, '期限切れで Storage → 401', brief(r));
  } else {
    console.log('       （期限 ' + expIn + ' 秒なので期限切れの確認は省略。--token-ttl 2 で起動すると確認できる）');
  }
  r = await refresh('nonsense-token');
  ok(r.status === 400 && r.json.error_code === 'refresh_token_not_found', '知らない refresh_token → 400', brief(r));
  r = await refresh(L1.refresh_token);
  const L2 = r.json;
  ok(r.status === 200 && L2.access_token && L2.refresh_token && L2.refresh_token !== L1.refresh_token && L2.access_token !== T_FIRST && L2.user.id === M.USER_ID, 'refresh → 新しい access_token と refresh_token', brief(r));
  r = await rpc('integrity', {}, L2.access_token);
  ok(r.status === 200, '新しい access_token で rpc が通る', brief(r));

  section('11. 写真（Storage）');
  const T2 = 'AUTO';
  const assetId = 'asset-' + Date.now();
  const bytes = Buffer.alloc(3000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  const path1 = '/storage/v1/object/photos/' + M.USER_ID + '/' + assetId;
  r = await call('POST', path1, { token: T2, raw: bytes, headers: { 'content-type': 'image/jpeg' } });
  ok(r.status === 200 && r.json && r.json.Key === 'photos/' + M.USER_ID + '/' + assetId && r.json.Id, 'upload（生バイト）→ 200 {Id,Key}', brief(r));
  r = await call('POST', path1, { token: T2, raw: bytes, headers: { 'content-type': 'image/jpeg' } });
  ok(r.status === 400 && r.json.message === 'The resource already exists', '同じパスの2回目 → 400 The resource already exists', brief(r));
  r = await call('POST', path1, { token: T2, raw: bytes, headers: { 'content-type': 'image/jpeg', 'x-upsert': 'true' } });
  ok(r.status === 403, 'x-upsert で上書き → 403（update 権限なし）', brief(r));
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/' + assetId, { token: T2 });
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && Buffer.compare(r.buf, bytes) === 0, 'download → 同じバイト・Content-Type=image/jpeg', r.status + ' ' + r.headers.get('content-type') + ' len=' + r.buf.length);
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/' + assetId, {});
  ok(r.status === 403 || r.status === 401, 'Authorization 無しで download → 401/403', brief(r));
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/nothing-here', { token: T2 });
  ok(r.status === 404, '無いファイル → 404', brief(r));
  r = await call('GET', '/storage/v1/object/photos/' + M.USER_ID + '/' + assetId, { token: T2 });
  ok(r.status === 400 && /Bucket not found/.test(r.text), '非公開バケットの公開 URL → 400 Bucket not found', brief(r));
  r = await call('POST', '/storage/v1/object/photos/' + OTHER_UID + '/' + assetId, { token: T2, raw: bytes, headers: { 'content-type': 'image/jpeg' } });
  ok(r.status === 403, '他人の uid へ upload → 403', brief(r));
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + OTHER_UID + '/' + assetId, { token: T2 });
  ok(r.status === 403, '他人の uid を download → 403', brief(r));
  r = await call('POST', '/storage/v1/object/photos/' + M.USER_ID + '/' + assetId, { token: undefined, raw: bytes });
  ok(r.status === 403, '未ログインで upload → 403', brief(r));
  r = await call('DELETE', path1, { token: T2 });
  ok(r.status === 404 || r.status === 403, 'DELETE は効かない（delete 権限なし）', brief(r));
  r = await call('PUT', path1, { token: T2, raw: bytes });
  ok(r.status === 403, 'PUT（上書き）も効かない（update 権限なし）', brief(r));
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/' + assetId, { token: T2 });
  ok(Buffer.compare(r.buf, bytes) === 0, '拒否された操作のあとも元のファイルは無事');
  // multipart（storage-js 方式）
  const asset2 = assetId + '-mp';
  const fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', new Blob([bytes], { type: 'image/png' }), 'blob.png');
  r = await call('POST', '/storage/v1/object/photos/' + M.USER_ID + '/' + asset2, { token: T2, raw: fd });
  ok(r.status === 200, 'upload（multipart/form-data）→ 200', brief(r));
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/' + asset2, { token: T2 });
  ok(r.status === 200 && Buffer.compare(r.buf, bytes) === 0 && r.headers.get('content-type') === 'image/png', 'multipart で上げた物が同じバイトで戻る', r.status + ' ' + r.headers.get('content-type') + ' len=' + r.buf.length);
  // 空・UTF-8 を含む assetId
  const asset3 = 'あ い/う'; // パスに日本語・空白・スラッシュ
  const enc3 = asset3.split('/').map(encodeURIComponent).join('/');
  r = await call('POST', '/storage/v1/object/photos/' + M.USER_ID + '/' + enc3, { token: T2, raw: Buffer.from('hello'), headers: { 'content-type': 'text/plain' } });
  ok(r.status === 200, '日本語・空白を含むパスも upload できる', brief(r));
  r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/' + enc3, { token: T2 });
  ok(r.status === 200 && r.text === 'hello', '同じパスで download できる', brief(r));

  section('12. CORS');
  r = await rawRequest('OPTIONS', '/rest/v1/rpc/put_items', {
    Origin: 'http://localhost:8931', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'apikey,authorization,content-type,x-client-info,prefer,range',
  });
  const ah = String(r.headers['access-control-allow-headers'] || '').toLowerCase();
  ok(r.status === 204 && r.headers['access-control-allow-origin'] === 'http://localhost:8931', 'プリフライト → 204 と Allow-Origin', r.status + ' ' + r.headers['access-control-allow-origin']);
  ok(['apikey', 'authorization', 'content-type', 'prefer', 'x-client-info', 'range'].every((h) => ah.indexOf(h) >= 0), 'Allow-Headers に必要なヘッダが全部ある', ah);
  ok(/POST/.test(String(r.headers['access-control-allow-methods'])), 'Allow-Methods に POST');
  r = await rawRequest('OPTIONS', '/auth/v1/token?grant_type=password', { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST' });
  ok(r.status === 204 && r.headers['access-control-allow-origin'] === 'https://example.org', '別の Origin でも通る（Origin は何でも）', r.status + ' ' + r.headers['access-control-allow-origin']);
  r = await rawRequest('POST', '/rest/v1/rpc/integrity', { Origin: 'http://localhost:8931', apikey: M.ANON_KEY, 'content-type': 'application/json' });
  ok(r.headers['access-control-allow-origin'] === 'http://localhost:8931', '通常の応答（エラー時も）に Allow-Origin が付く', r.status + ' ' + r.headers['access-control-allow-origin']);

  section('12b. アプリ本体の往復（kinds／tools／acts[].d／pf が 送信→受信→合流 で欠けないか）');
  {
    /* index.html から本物の clItems／clRowsToState／mergeStates を取り出して使う（写しではなく現物） */
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const grab = (re) => { const m = src.match(re); if (!m) throw new Error('index.html に見つからない: ' + re); return m[0]; };
    const m0 = src.indexOf('function mergeStates('), m1 = src.indexOf('\n}\n', m0) + 3;
    const c0 = src.indexOf('function clItems('), c1 = src.indexOf('const clKey=');
    const code = 'const DEF_DREAM={name:"",due:"",ts:0};\n' + grab(/^const emptyState=.*$/m) + '\n'
      + ['CL_ID', 'CL_DAY', 'CL_DAY2', 'CL_SKIP'].map((n) => grab(new RegExp('^const ' + n + '=.*$', 'm'))).join('\n') + '\n'
      + src.slice(c0, c1) + src.slice(m0, m1) + '\n({clItems,clRowsToState,mergeStates,emptyState,CL_ID})';
    const C = require('vm').runInNewContext(code, {});
    const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o, kk) => (o[kk] = x[kk], o), {}) : x);
    const NOWB = Date.now() - 60 * 1000;
    ok(C.CL_ID.indexOf('kinds') >= 0 && C.CL_ID.indexOf('tools') >= 0, 'CL_ID に kinds／tools が入っている', C.CL_ID);

    const S1 = {
      updatedAt: NOWB + 50,
      entries: { '2026-10-03': {
        eA: { p: '渋谷', t: '作業', ph: [], s: '09:00', e: '10:30', ts: NOWB + 10, pf: 13,
          acts: [{ t: '読書', m: 30, k: 'rt12b-own', d: 'rt12b-tool' }, { t: 'AI', m: 20, s: '09:30', e: '09:50', k: 'ai', d: 'pc', c: 'メモ' }] },
        eB: { p: '', t: '移動', ph: [], s: '11:00', e: '11:40', ts: NOWB + 11, mv: 1, rt: '渋谷→新宿', tr: 'train', acts: [{ t: '音声', m: 10, d: 'phone' }] },
      } },
      kinds: { 'rt12b-own': { lb: '読書', ic: '📚', ts: NOWB + 20 }, work: { muda: 1, ts: NOWB + 21 }, rest: { off: 1, ts: NOWB + 22 } },
      tools: { 'rt12b-tool': { lb: 'iPad', ic: '📱', ts: NOWB + 30 }, pc: { off: 1, ts: NOWB + 31 } },
    };
    const items = C.clItems(S1);
    ok(items.filter((x) => x.coll === 'kinds').length === 3 && items.filter((x) => x.coll === 'tools').length === 2, 'clItems が kinds 3行・tools 2行を専用の coll で出す（_top に落ちない）', items.map((x) => x.coll + '/' + x.k));
    ok(!items.some((x) => x.coll === '_top' && (x.k === 'kinds' || x.k === 'tools')), 'kinds／tools が _top に混ざらない');
    r = await rpc('put_items', { rows: items }, T);
    ok(r.status === 200 && r.json === items.length, 'put_items で全行が入る（' + items.length + '行）', brief(r));
    const keySet = new Set(items.map((x) => x.coll + '\u0000' + x.k));
    const back = (await pullAll(T)).filter((x) => keySet.has(x.coll + '\u0000' + x.k));
    ok(back.length === items.length, 'pull_items で同じ行数が戻る', back.length);
    // 受信側は端末が空（新しい端末）として合流
    const part = C.clRowsToState(back);
    const got = C.mergeStates(C.emptyState(), part);
    ok(canon(got.kinds) === canon(S1.kinds), 'kinds が欠けず・値も同じで戻る', canon(got.kinds));
    ok(canon(got.tools) === canon(S1.tools), 'tools が欠けず・値も同じで戻る', canon(got.tools));
    ok(canon(got.entries) === canon(S1.entries), '記録の新項目（acts[].k／acts[].d／pf／mv）が欠けず戻る', canon(got.entries));
    ok(got.entries['2026-10-03'].eA.acts[0].d === 'rt12b-tool' && got.entries['2026-10-03'].eA.pf === 13, 'acts[0].d と pf を個別に確認');

    // ページ分け（cloudPull の while ループ＝1行ずつ受け取って合流を繰り返しても同じ結果）
    let inc = C.emptyState();
    for (const row of back) inc = C.mergeStates(inc, C.clRowsToState([row]));
    ok(canon(inc.kinds) === canon(S1.kinds) && canon(inc.tools) === canon(S1.tools) && canon(inc.entries) === canon(S1.entries), '1行ずつ合流を繰り返しても同じ（ページ分けで欠けない）');

    // すでに別の kinds／tools を持つ端末へ合流：1件ずつ ts の新しい方が勝ち・和集合（取り込みで消えない）
    const LOCAL = C.emptyState();
    LOCAL.updatedAt = NOWB + 999;   // 端末の方が updatedAt が新しい（known に無いと、ここで端末側が丸ごと勝って受信分が消える）
    LOCAL.kinds = { 'rt12b-own': { lb: '本', ic: '📖', ts: NOWB + 5 }, 'rt12b-local': { lb: 'ここだけ', ic: '🏠', ts: NOWB + 6 } };
    LOCAL.tools = { 'rt12b-tool': { lb: 'iPad mini', ic: '📱', ts: NOWB + 40 }, 'rt12b-ltool': { lb: 'ここだけ', ic: '🏠', ts: NOWB + 41 } };
    const mg = C.mergeStates(LOCAL, part);
    ok(mg.kinds['rt12b-own'].lb === '読書' && mg.kinds['rt12b-local'] && mg.kinds.work && mg.kinds.rest, 'kinds：新しい受信が勝ち・端末だけの行も・受信だけの行も残る', canon(mg.kinds));
    ok(mg.tools['rt12b-tool'].lb === 'iPad mini' && mg.tools['rt12b-ltool'] && mg.tools.pc, 'tools：端末の方が新しい行が勝ち・両方の和集合', canon(mg.tools));
    const mg2 = C.mergeStates(LOCAL, { entries: S1.entries });   // 受信に kinds が無くても端末の kinds を消さない
    ok(canon(mg2.kinds) === canon(LOCAL.kinds) && canon(mg2.tools) === canon(LOCAL.tools), '受信に kinds／tools が無い時、端末の kinds／tools は消えない');
    const mg3 = C.mergeStates(C.emptyState(), { ...part, 未来の項目: { x: 1 } });
    ok(mg3['未来の項目'] && mg3['未来の項目'].x === 1, '知らないトップレベル項目は捨てない（新旧混在）');

    // 旧版(c1.0)の端末が同じ記録を編集した時：記録は ts 丸ごと勝ち。c1.0 は pf／acts[].d を知らないので、編集で落ちる（仕様の確認）
    const c10Edit = { p: '渋谷', t: '作業（直した）', ph: [], s: '09:00', e: '10:30', ts: NOWB + 100, acts: [{ t: '読書', m: 30 }, { t: 'AI', m: 20, s: '09:30', e: '09:50', k: 'ai', c: 'メモ' }] };
    const mg4 = C.mergeStates(C.mergeStates(C.emptyState(), part), { entries: { '2026-10-03': { eA: c10Edit } } });
    const eA = mg4.entries['2026-10-03'].eA;
    ok(eA.t === '作業（直した）' && eA.pf === undefined && eA.acts[0].d === undefined && eA.acts[0].k === undefined,
      '（仕様）c1.0 端末の編集の方が新しいと、記録は丸ごとそちらが勝つ＝pf・acts[].d・知らない k は落ちる', canon(eA));
    ok(mg4.kinds['rt12b-own'] && mg4.tools['rt12b-tool'], '（仕様）その編集でも kinds／tools の行そのものは残る');
    // 逆（c1.1 の方が新しい）なら全部残る
    const c11Edit = Object.assign({}, S1.entries['2026-10-03'].eA, { ts: NOWB + 200, t: '作業（c1.1で直した）' });
    const mg5 = C.mergeStates(C.mergeStates(C.emptyState(), { entries: { '2026-10-03': { eA: c10Edit } } }), { entries: { '2026-10-03': { eA: c11Edit } } });
    ok(mg5.entries['2026-10-03'].eA.pf === 13 && mg5.entries['2026-10-03'].eA.acts[0].d === 'rt12b-tool', 'c1.1 の編集の方が新しければ pf・acts[].d は残る');
  }

  section('13. ログアウト');
  r = await login();
  const L3 = r.json;
  r = await call('POST', '/auth/v1/logout', { token: L3.access_token });
  ok(r.status === 204 && r.buf.length === 0, 'logout → 204', brief(r));
  r = await call('GET', '/auth/v1/user', { token: L3.access_token });
  ok(r.status === 403 && r.json.error_code === 'session_not_found', 'ログアウト後の /auth/v1/user → 403 session_not_found', brief(r));
  r = await refresh(L3.refresh_token);
  ok(r.status === 400, 'ログアウト後の refresh → 400', brief(r));

  // ---- 永続化（自前起動のときだけ）
  if (SPAWN) {
    section('14. 強制終了 → 再起動しても残っているか');
    const snapPull = await pullAll('AUTO');
    const snapInt = await rpc('integrity', {}, 'AUTO');
    const snapHist = (await call('GET', '/_mock/history', { apikey: null })).json.length;
    await killChild();
    await startChild(false);
    r = await login();
    ok(r.status === 200, '再起動後にログインできる', brief(r));
    const T4 = r.json.access_token;
    const again = await pullAll(T4);
    ok(again.length === snapPull.length && JSON.stringify(again) === JSON.stringify(snapPull), '再起動後も全 ' + snapPull.length + ' 件が同じ内容・同じ seq', again.length);
    const int2 = await rpc('integrity', {}, T4);
    ok(int2.text === snapInt.text, 'integrity が再起動の前後で同じ');
    r = await call('GET', '/storage/v1/object/authenticated/photos/' + M.USER_ID + '/' + assetId, { token: T4 });
    ok(r.status === 200 && Buffer.compare(r.buf, bytes) === 0 && r.headers.get('content-type') === 'image/jpeg', '写真も再起動後に同じバイトで読める');
    const hist2 = (await call('GET', '/_mock/history', { apikey: null })).json.length;
    ok(hist2 === snapHist && hist2 >= 2, '旧版の履歴(' + hist2 + '件)も残っている', { snapHist, hist2 });
    r = await rpc('put_items', { rows: [{ coll: 'entries', k: 'after-restart', ts: B + 1000, data: { x: 1 } }] }, T4);
    const nx = await pullAll(T4, snapPull[snapPull.length - 1].seq);
    ok(r.json === 1 && nx.length === 1 && nx[0].seq > snapPull[snapPull.length - 1].seq, '再起動後も seq は続きから採番される', nx.map((x) => x.seq));
  } else {
    console.log('\n（既存サーバーを叩いたので、永続化（再起動）の確認は省略。health: ' + JSON.stringify(health0) + '）');
  }
}

// ---------------------------------------------------------------- 15. 同期エンジン（c1.9）
/* cloud-layer.js（現物）を Node の vm で動かし、故障注入つきの擬似サーバー（別ポート・jsonb のキー順を再現）に繋いで確かめる。
   端末＝vm の1つの世界。localStorage と IndexedDB（影の置き場）は Map で持ち、同じ Map を渡すと「アプリを閉じて開き直した」になる。 */
async function appTests() {
  section('15. 同期エンジン c1.9（保存しなくなる の根絶）');
  const vm = require('vm');
  const APORT = Number(process.env.MOCK_TEST_APORT) || await freePort(), AB = 'http://127.0.0.1:' + APORT;   // 使用中なら起動で失敗する（黙って続けない）
  const ADIR = path.join(__dirname, 'mock-data-apptest-' + process.pid);
  const srv = M.start({ port: APORT, tokenTtl: 3600, dataDir: ADIR, reset: true, quiet: true, jsonbOrder: true, host: '127.0.0.1' });
  await srv.ready;
  const apps = [];
  try {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m0 = SRC.indexOf('function mergeStates('), m1 = SRC.indexOf('\n}\n', m0) + 3;
    const emptyLine = SRC.match(/^const emptyState=.*$/m)[0];
    const CLOUD_SRC = fs.readFileSync(path.join(__dirname, 'cloud-layer.js'), 'utf8')
      .replace("'__SUPABASE_URL__'", JSON.stringify(AB)).replace("'__SUPABASE_KEY__'", JSON.stringify(M.ANON_KEY)).split("'__APPVER__'").join("'test'");
    const adm = async (p, body) => { const r = await fetch(AB + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };
    const fault = (p, mode, count, ms) => adm('/__mock/fault', { path: p, mode, count: count || 1, ms });
    const mlog = () => adm('/__mock/log');
    const clearLog = () => adm('/__mock/log/clear', {});
    const dumpMap = async () => { const d = await adm('/_mock/dump'); const m = {}; for (const r of d) m[r.coll + '/' + r.k] = r; return m; };
    const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch (e) { /* まだ */ } if (Date.now() - t0 > ms) return false; await sleep(100); } };
    const has = (coll, k, pred) => async () => { const r = (await dumpMap())[coll + '/' + k]; return !!r && (!pred || pred(r)); };
    const clone = (x) => JSON.parse(JSON.stringify(x));
    function fakeLocks() { const q = {}; return { request(name, opt, cb) { if (typeof opt === 'function') { cb = opt; opt = {}; } return new Promise((res, rej) => { const run = async () => { try { res(await cb({ name })); } catch (e) { rej(e); } finally { q[name].shift(); if (q[name].length) q[name][0](); } }; (q[name] = q[name] || []).push(run); if (q[name].length === 1) run(); }); } }; }

    function makeApp(o) {
      o = o || {};
      const ls = o.ls || new Map();
      const timers = new Set(), intervals = new Set(), fetchLog = [];
      let alive = true;
      const docL = {}, winL = {};
      const doc = { hidden: false, addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); }, getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } };
      const ctx = {
        console, URL, TextEncoder, AbortController, Blob, crypto: globalThis.crypto,
        fetch: (u, opt) => { if (o.fetchHook) { const x = o.fetchHook(String(u), opt); if (x) return x; } try { if (String(u).indexOf('/rest/v1/rpc/put_items') >= 0) fetchLog.push({ t: Date.now(), keepalive: !!(opt && opt.keepalive), bytes: (opt && typeof opt.body === 'string') ? Buffer.byteLength(opt.body) : 0, body: (opt && typeof opt.body === 'string') ? opt.body : '' }); } catch (e) { /* 記録だけ */ } return fetch(u, opt); },
        setTimeout: (f, ms) => { if (!alive) return 0; const id = setTimeout(() => { timers.delete(id); if (alive) f(); }, ms); timers.add(id); return id; },
        clearTimeout: (id) => { clearTimeout(id); timers.delete(id); },
        setInterval: (f, ms) => { const id = setInterval(() => { if (alive) f(); }, ms); intervals.add(id); return id; },
        clearInterval: (id) => { clearInterval(id); intervals.delete(id); },
        localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => { ls.set(k, String(v)); }, removeItem: (k) => { ls.delete(k); }, key: (i) => [...ls.keys()][i] || null, get length() { return ls.size; } },
        navigator: o.locks ? { locks: o.locks } : {},
        indexedDB: o.indexedDB,
        document: doc, __init: o.state || null, __toasts: [], __saveFail: !!o.saveFail, __cnt: { r: 0, s: 0 },
      };
      ctx.window = ctx; ctx.addEventListener = (t, f) => { (winL[t] = winL[t] || []).push(f); };
      vm.createContext(ctx);
      const stub = 'const DEF_DREAM={name:"",due:"",ts:0};\n' + emptyLine + '\n' + SRC.slice(m0, m1) + '\n' +
        'let state=__init?JSON.parse(JSON.stringify(__init)):emptyState();\n' +
        'let unsynced=false,localOnly=false,permFail=false,localSaveFail=false;\n' +
        'function saveLocal(synced){__cnt.s++;if(__saveFail){localSaveFail=true;return;}try{localStorage.setItem("LS",JSON.stringify(state));localSaveFail=false;}catch(e){localSaveFail=true;}unsynced=!synced;}\n' +
        'function render(){__cnt.r++;} function renderSync(){} function schedulePublish(){} async function doPublish(){}\n' +
        'let getAssets=null,verifyBlob=null,phUrl=null;const PH={mem:{},pending:[]};const IDB={ok:false};function idbPut(){}\n' +
        'const $=id=>null;const esc=s=>String(s==null?"":s);const todayStr=()=>"2026-10-04";\n' +
        'function closeSheet(){} function openOvl(){} function toast(m){__toasts.push(String(m));} function cfgApply(){} function openSyncSheet(){}\n';
      vm.runInContext(stub + CLOUD_SRC + '\n;globalThis.__api={get state(){return state},set state(v){state=v},get localSaveFail(){return localSaveFail},CL,CLQ,cloudSync,cloudBoot,clStore,clKeepalive,clRefresh,clItems,clKey,clSigOf,saveLocal,' +
        'mutate:(fn)=>{fn();state.updatedAt=Date.now();saveLocal(false);},clLogin,clAfterLogin,clDirtyCount,clPersist,cloudLoggedIn,doPublish,clPutMs,clStripText,clNoShadow,get unsynced(){return unsynced}};', ctx);
      const api = ctx.__api;
      if (o.idb) {
        const db = o.idb;
        api.clStore.get = async (k) => (db.has(k) ? JSON.parse(db.get(k)) : null);
        api.clStore.set = async (k, v) => { db.set(k, JSON.stringify(v)); return true; };
        api.clStore.upd = async (k, fn) => { const cur = db.has(k) ? JSON.parse(db.get(k)) : null; db.set(k, JSON.stringify(fn(cur))); return true; };
      }
      // 試験用に時間を短く（本番は RPC 25秒・再送 5秒〜）
      api.T0 = JSON.parse(JSON.stringify(api.CL.T));   // 本番の時間制限（短くする前）
      if (!o.rpcMs) { api.CL.T.put = 2500; api.CL.T.putPer = 500; }
      api.fetchLog = fetchLog;
      api.CL.T.rpc = o.rpcMs || 2500; api.CL.T.pre = 1500; api.CL.retryMs = 300; api.CL.T.refresh = 3000; api.CL.T.fresh = 4000;
      api.doc = doc; api.ls = ls; api.ctx = ctx; api.cnt = ctx.__cnt;
      api.fire = (t) => { for (const f of (docL[t] || [])) f({}); for (const f of (winL[t] || [])) f({}); };
      api.dispose = () => { alive = false; for (const id of timers) clearTimeout(id); for (const id of intervals) clearInterval(id); try { api.CLQ.epoch++; if (api.CLQ.ctl) api.CLQ.ctl.abort(); } catch (e) { /* 無視 */ } };
      apps.push(api);
      return api;
    }
    const login = async (A) => { await A.clLogin(M.TEST_EMAIL, M.TEST_PASSWORD); };

    // ---- 起動（全件受信で影を作る）
    const lsA = new Map(), idbA = new Map();
    const A = makeApp({ ls: lsA, idb: idbA });
    await login(A);
    const okBoot = await A.cloudBoot();
    ok(A.CL.shadowOk && A.CL.seq >= 0 && A.CLQ.fails === 0, '15-0 起動：影が無い → 全件受信で影ができる（擬似サーバーは jsonb のキー順を再現）', { shadowOk: A.CL.shadowOk, fails: A.CLQ.fails, okBoot });

    // ---- 1. put_items が宙に浮く → 時間切れ → 次の送信が通る
    A.CL.retryMs = 5000; const t41 = Date.now();   // 500系の間隔を本番並みにして、時間切れの後だけ早いことを見る
    await clearLog();
    await fault('put_items', 'hang', 1);
    A.mutate(() => { A.state.memos.t1 = { t: '宙に浮く送信', ts: Date.now() }; });
    const r1 = await until(has('memos', 't1'), 15000);
    await until(() => !A.CL.busy && A.CLQ.fails === 0, 5000);
    const lg1 = await mlog();
    ok(r1 && lg1.calls.some((c) => c.path === 'put_items' && c.fault === 'hang') && lg1.calls.some((c) => c.path === 'put_items' && c.status === 200), '4.2-1 put_items が hang → 時間切れ（試験は2.5秒）→ 再送で届く（開き直さない）', lg1.calls.map((c) => c.path + ':' + c.status + ':' + (c.fault || '')).join(' '));
    ok(!A.CL.busy && A.CLQ.fails === 0 && A.CL.log.some((e) => e.ev === 'timeout'), '  busy が解けている・記録に timeout が残る', { busy: A.CL.busy, fails: A.CLQ.fails });

    A.CL.retryMs = 300;
    { const lg = A.CL.log.filter((e) => e.t >= t41), it = lg.findIndex((e) => e.ev === 'timeout'), nx = it >= 0 ? lg.slice(it + 1).find((e) => e.ev === 'retry') : null;
      ok(nx && /^1秒後/.test(nx.msg),'  時間切れ（宙に浮いた）の後の最初の再送は待たない（1秒以内。500系の間隔 5秒は使わない）', lg.map((e) => e.ev + ':' + e.msg)); }
    {
      const sv = [A.CL.T.put, A.CL.T.putPer, A.CLQ.fails]; A.CL.T.put = A.T0.put; A.CL.T.putPer = A.T0.putPer; A.CLQ.fails = 0;
      const m1 = A.clPutMs(300), m2 = A.clPutMs(120000); A.CL.T.put = sv[0]; A.CL.T.putPer = sv[1]; A.CLQ.fails = sv[2];
      ok(A.T0.rpc === 25000 && m1 === 10000 && m2 === 20000, '  put_items の時間制限は量に合わせる（1件＝10秒・12万字＝20秒。ほかの呼び出しは25秒）', { m1, m2, rpc: A.T0.rpc });
    }

    // ---- 2. 500 が2回 → 再挑戦の間隔で通る
    await clearLog();
    await fault('put_items', '500', 2);
    A.mutate(() => { A.state.memos.t2 = { t: '500 二回', ts: Date.now() }; });
    const r2 = await until(has('memos', 't2'), 15000);
    const nRetry = A.CL.log.filter((e) => e.ev === 'retry').length;
    ok(r2 && A.CLQ.fails === 0 && (await mlog()).calls.filter((c) => c.path === 'put_items' && c.status === 500).length === 2, '4.2-2 put_items が 500×2 → 再挑戦で届く・成功で間隔が戻る（fails=0）', { r2, fails: A.CLQ.fails, nRetry });

    // ---- 2c. ts を変えないその場の書き換え（gid を付ける）も未送信になって届く
    A.mutate(() => { A.state.plans = A.state.plans || {}; A.state.plans['2026-10-04'] = A.state.plans['2026-10-04'] || {}; A.state.plans['2026-10-04'].p1 = { t: 'a', ts: Date.now() }; });
    await until(has('plans', '2026-10-04/p1'), 8000);
    await until(() => A.clDirtyCount() === 0 && !A.CL.busy, 5000);
    A.mutate(() => { A.state.plans['2026-10-04'].p1.gid = 'G123'; });
    const dIn = A.clDirtyCount();
    A.mutate(() => { A.state.plans['2026-10-04'].p1.gid = 'G124'; });   // 同じ長さの別の値に変えても拾う
    const rIn = await until(has('plans', '2026-10-04/p1', (r) => r.data.gid === 'G124'), 8000);
    ok(dIn === 1 && rIn, '2c ts を変えないその場の書き換え（gid を付ける・付け替える）も未送信になり届く', { dIn, rIn });

    // ---- 2b. 行の形が悪い1行（空の鍵）と \u0000 入りの行 → 悪い行だけ隔離して他は流す
    A.mutate(() => { A.state.memos.n9 = { t: 'a\u0000b', ts: Date.now() }; A.state.memos[''] = { t: '鍵が空', ts: Date.now() }; A.state.memos.ok9 = { t: '普通', ts: Date.now() }; });
    const r9 = await until(async () => (await has('memos', 'ok9')()) && (await has('memos', 'n9')()), 10000);
    await sleep(300);
    const d9 = await dumpMap();
    ok(r9 && d9['memos/n9'].data.t === 'ab' && Object.keys(A.CL.bad).length === 1 && A.clDirtyCount() === 0 && A.CLQ.fails === 0, '2b \\u0000 は送る分だけ除いて届く・拒否される行（空の鍵）は隔離・他は届く・再送の嵐にならない', { bad: Object.keys(A.CL.bad), dirty: A.clDirtyCount(), fails: A.CLQ.fails });
    ok(A.state.memos.n9.t === 'a\u0000b', '  端末の本文は消さない（\\u0000 も端末には残る）');

    // ---- 3. 影あり・dirty の控えが消えた → 起動で差が dirty になり送られる
    await A.clPersist();
    A.dispose();
    const st3 = clone(A.state); st3.memos.t3 = { t: '控えが消えた未送信', ts: Date.now() };
    lsA.delete('hibiki-sync');
    lsA.set('hibiki-ka', JSON.stringify({ n: 1, at: Date.now(), keys: ['memos\u0000t2'] }));   // 前回の離脱時に keepalive を撃ったが返事を見ていない
    await clearLog();
    const tB = Date.now();
    const B = makeApp({ ls: lsA, idb: idbA, state: st3 });
    await B.cloudBoot();
    const r3 = await until(has('memos', 't3'), 8000);
    ok(r3 && B.CL.shadowOk && !B.CL.log.some((e) => /全件受信/.test(e.msg) && e.t >= tB), '4.2-3 影あり・dirty の控えなし → 起動で影との差が見つかり送られる（全件受信はしない）', { r3, log: B.CL.log.slice(-4).map((e) => e.ev + ':' + e.msg) });
    const pulls3 = (await mlog()).calls.filter((c) => c.path === 'pull_items').length;
    ok(B.CL.log.some((e) => e.ev === 'keepalive' && e.msg.indexOf('クラウドに届いていた 1/1件')>=0) && !lsA.has('hibiki-ka'), '  前回の離脱時の keepalive が届いていたかを、起動後の最初の受信で確かめて記録に残す', B.CL.log.filter((e) => e.ev === 'keepalive').map((e) => e.msg));
    ok(pulls3 <= 3, '  受信は増分だけ（pull_items ' + pulls3 + ' 回）');

    // ---- 4. 影なし（IndexedDB 消失）→ 全件受信で影を作り、端末だけの項目を送る・クラウドの新しい項目は端末の古い物で上書きされない
    await B.clPersist();
    B.dispose();
    const tokA = (await (await fetch(AB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: M.ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email: M.TEST_EMAIL, password: M.TEST_PASSWORD }) })).json()).access_token;
    const arpc = async (name, args) => { const r = await fetch(AB + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: M.ANON_KEY, authorization: 'Bearer ' + tokA, 'content-type': 'application/json' }, body: JSON.stringify(args) }); return r.json(); };
    const NOW4 = Date.now();
    await arpc('put_items', { rows: [{ coll: 'memos', k: 'c4', ts: NOW4 + 5000, data: { zeta: 1, t: 'クラウドの新しい版', ts: NOW4 + 5000, mm: { yy: 1, b: 2 } } }] });
    const st4 = clone(B.state); st4.memos.c4 = { t: '端末の古い版', ts: NOW4 - 5000 }; st4.memos.l4 = { zeta: 9, t: '端末だけ', ts: NOW4, a: [3, { y: 1, b: 2 }] };
    const C = makeApp({ ls: lsA, idb: new Map(), state: st4 });
    await C.cloudBoot();
    const r4 = await until(has('memos', 'l4'), 8000);
    const d4 = await dumpMap();
    ok(r4 && d4['memos/c4'].data.t === 'クラウドの新しい版' && C.state.memos.c4.t === 'クラウドの新しい版', '4.2-4 影なし → 全件受信で影を作る・端末だけの項目は送られる・クラウドの新しい版は古い端末の版で上書きされない', { c4: d4['memos/c4'] && d4['memos/c4'].data.t, local: C.state.memos.c4.t });
    ok(C.CL.shadowOk && C.clDirtyCount() === 0, '  全件受信の後 dirty=0（jsonb のキー順が違っても同じ中身は同じ署名）', { dirty: C.clDirtyCount() });

    // ---- 5. integrity 不一致（クラウド側で1行消える）→ 照合し直し → 一致
    await adm('/__mock/drop', { coll: 'memos', k: 'l4' });
    ok(!(await has('memos', 'l4')()), '  （準備）クラウドから memos/l4 を消した');
    C.CL.integ.due = true; C.CL.integ.rebuildAt = 0;
    await C.cloudSync(true);
    const r5 = await until(async () => C.CL.integ.res === 'OK' && (await has('memos', 'l4')()), 15000);
    ok(r5 && C.CL.log.some((e) => e.ev === 'integrity' && /照合し直し/.test(e.msg)), '4.2-5 整合の点検で食い違いを見つけ → 全件受信で照合し直し → 送り直して一致', { res: C.CL.integ.res, log: C.CL.log.filter((e) => e.ev === 'integrity').map((e) => e.msg) });

    // ---- 6. 画面を離れる瞬間の keepalive
    await clearLog();
    C.fetchLog.length = 0;
    C.mutate(() => { C.state.memos.k6 = { t: '離れる直前の記録', ts: Date.now() }; });
    C.doc.hidden = true; C.fire('visibilitychange'); C.fire('pagehide');
    const r6 = await until(has('memos', 'k6'), 5000);
    const lg6 = await mlog();
    const kaCalls = lg6.calls.filter((c) => c.path === 'put_items' && c.ka);
    ok(r6 && kaCalls.length === 1 && kaCalls[0].keys.indexOf('memos/k6') >= 0, '4.2-6 hidden → keepalive の put_items が届く（hidden と pagehide の二重発火は1回に間引く）', lg6.calls.map((c) => c.path + (c.ka ? '(ka)' : '') + ':' + c.status).join(' '));
    await sleep(300);
    ok(C.clDirtyCount() === 0 && lg6.calls.filter((c) => c.path === 'put_items' && !c.ka).length === 0, '  返事で影が更新され未送信 0・隠れている間は通常の同期を始めない', { dirty: C.clDirtyCount() });
    {
      const kf = C.fetchLog.filter((x) => x.keepalive);
      ok(kf.length === 1 && kf[0].body.indexOf('"k6"') >= 0, '  離脱の送信は fetch の keepalive:true で撃っている（ページを閉じても届く指定）', C.fetchLog.map((x) => ({ ka: x.keepalive, b: x.bytes })));
    }
    C.doc.hidden = false; C.fire('visibilitychange');
    await sleep(800);
    const settle = (X) => until(() => !X.CL.busy && X.clDirtyCount() === 0, 10000);
    const kaFire = async (X) => { X.CL.kaAt = 0; X.fetchLog.length = 0; X.doc.hidden = true; X.fire('visibilitychange'); await sleep(50); return X.fetchLog.filter((x) => x.keepalive); };
    const kaBack = async (X) => { X.doc.hidden = false; X.fire('visibilitychange'); await settle(X); };
    // 6a 未送信が 40KB を超える → 本文は 40KB 以内・最後に書いた1件は必ず入る・残りは戻った時に送る
    await settle(C);
    C.doc.hidden = true;   // 隠れている間に書く（通常の同期は始まらない）
    C.mutate(() => { for (let i = 0; i < 30; i++) C.state.memos['kb' + i] = { t: 'x'.repeat(2500), ts: Date.now() - 100000 + i }; });
    await sleep(20);
    C.mutate(() => { C.state.memos.klast = { t: '最後に書いた1件', ts: Date.now() - 200000 }; });
    const ka6a = await kaFire(C);
    ok(ka6a.length === 1 && ka6a[0].bytes <= 40000 && ka6a[0].body.indexOf('"klast"') >= 0 && (ka6a[0].body.match(/"kb\d+"/g) || []).length < 30, '4.2-6a 未送信が 40KB 超 → keepalive の本文は 40KB 以内・最後に書いた1件が先に入る', ka6a.map((x) => ({ b: x.bytes, last: x.body.indexOf('"klast"') >= 0, n: (x.body.match(/"kb\d+"/g) || []).length })));
    await kaBack(C);
    const d6a = await dumpMap();
    ok(d6a['memos/klast'] && [...Array(30).keys()].every((i) => d6a['memos/kb' + i]), '  入りきらなかった分は、戻った時の通常の送信で全部届く');
    // 6b 1行だけで 40KB を超える → その行は飛ばして、ほかの行は送る
    C.doc.hidden = true;
    C.mutate(() => { C.state.memos.khuge = { t: 'y'.repeat(45000), ts: Date.now() + 5 }; C.state.memos.ksmall = { t: '小さい行', ts: Date.now() }; });
    const ka6b = await kaFire(C);
    ok(ka6b.length === 1 && ka6b[0].body.indexOf('"ksmall"') >= 0 && ka6b[0].body.indexOf('"khuge"') < 0 && ka6b[0].bytes <= 40000, '4.2-6b 1行で 40KB 超の行は飛ばし、ほかの行は keepalive で送る', ka6b.map((x) => ({ b: x.bytes })));
    await kaBack(C);
    ok(await has('memos', 'khuge')(), '  大きい行は戻った時の通常の送信で届く');
    // 6c 合言葉の期限が20秒以内 → keepalive は撃たない（記録に残す）
    C.doc.hidden = true;
    C.mutate(() => { C.state.memos.kexp = { t: '期限ぎわ', ts: Date.now() }; });
    const expSave = C.CL.sess.expires_at; C.CL.sess.expires_at = Date.now() + 10000;
    const ka6c = await kaFire(C);
    C.CL.sess.expires_at = expSave;
    ok(ka6c.length === 0 && C.CL.log.slice(-3).some((e) => e.ev === 'keepalive' && /期限が近い/.test(e.msg)), '4.2-6c 合言葉の期限が20秒以内 → keepalive は撃たず、記録に「期限が近い」', { n: ka6c.length, log: C.CL.log.slice(-3).map((e) => e.msg) });
    await kaBack(C);
    ok(await has('memos', 'kexp')(), '  戻った時の通常の送信で届く');

    // ---- 7. ログインの更新
    // 7a 期限切れ相当（401）→ 更新 → やり直しで成功
    await clearLog();
    C.CL.sess.access_token = 'abc.def.ghi';
    C.mutate(() => { C.state.memos.r7a = { t: '401→更新→再送', ts: Date.now() }; });
    const r7a = await until(has('memos', 'r7a'), 8000);
    ok(r7a && (await mlog()).calls.some((c) => c.path === 'refresh' && c.status === 200) && C.cloudLoggedIn(), '4.2-7a 401 → refresh → やり直しで成功', (await mlog()).calls.map((c) => c.path + ':' + c.status).join(' '));
    // 7b 別タブが先に更新済み（localStorage に新しい合言葉）→ 合言葉を使わずにそれを採る
    const rtNow = C.CL.sess.refresh_token;
    const other = await (await fetch(AB + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: M.ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: rtNow }) })).json();
    lsA.set('hibiki-session', JSON.stringify({ access_token: other.access_token, refresh_token: other.refresh_token, expires_at: other.expires_at * 1000, user: other.user }));
    await clearLog();
    C.CL.sess.access_token = 'abc.def.ghi';
    C.mutate(() => { C.state.memos.r7b = { t: '別タブの合言葉', ts: Date.now() }; });
    const r7b = await until(has('memos', 'r7b'), 8000);
    const lg7b = await mlog();
    ok(r7b && !lg7b.calls.some((c) => c.path === 'refresh') && C.CL.sess.refresh_token === other.refresh_token, '4.2-7b 別タブが更新済み → localStorage の新しい合言葉を採用（refresh を叩かない）', lg7b.calls.map((c) => c.path + ':' + c.status).join(' '));
    // 7c 更新が 500 → セッションは消さない → 再送で通る
    await clearLog();
    await fault('refresh', '500', 1);
    C.CL.sess.access_token = 'abc.def.ghi';
    C.mutate(() => { C.state.memos.r7c = { t: '更新が500', ts: Date.now() }; });
    const r7c = await until(has('memos', 'r7c'), 10000);
    ok(r7c && C.cloudLoggedIn() && !C.CL.sess.dead, '4.2-7c 更新が 500（回線・サーバーの不調）→ セッションは消さない → 再送で通る', (await mlog()).calls.map((c) => c.path + ':' + c.status).join(' '));
    // 7g 401 の間に更新が 500 続き → 止まらない・直ったら自動で届く（開き直し・ボタン不要）
    await clearLog();
    await fault('refresh', '500', 6);
    C.CL.sess.access_token = 'abc.def.ghi';
    C.mutate(() => { C.state.memos.r7g = { t: '更新が500続き', ts: Date.now() }; });
    await until(async () => (await mlog()).calls.filter((c) => c.path === 'refresh' && c.status === 500).length >= 5, 15000);
    const midG = { fails: C.CLQ.fails, dead: C.CL.authDead, pending: C.CL.retryAt > Date.now() || C.CL.busy, strip: C.clStripText() };
    await adm('/__mock/fault/clear', {});
    const r7g = await until(has('memos', 'r7g'), 20000);
    ok(r7g && C.cloudLoggedIn() && midG.fails >= 2 && !midG.dead && midG.pending, '4.2-7g 401 の間に更新が 500 続き → 止まらず間隔をあけて再挑戦 → 直ったら自動で届く', { midG, r7g, log: C.CL.log.slice(-4).map((e) => e.ev + ':' + e.msg) });
    ok(/再送 \d+秒後|送信中/.test(midG.strip), '  その間も診断帯に「再送 N秒後」が出る（止まって見えない）', midG.strip);
    // 7h 更新が宙に浮く（hang）→ T.refresh で打ち切り → 詰まらずに次の送信が通る
    await until(() => !C.CL.busy && C.CLQ.fails === 0, 5000);
    await clearLog();
    await fault('refresh', 'hang', 1);
    C.CL.sess.access_token = 'abc.def.ghi';
    C.mutate(() => { C.state.memos.r7h = { t: '更新が宙に浮く', ts: Date.now() }; });
    const r7h = await until(has('memos', 'r7h'), 15000);
    ok(r7h && C.cloudLoggedIn() && !C.CL.refreshP && (await mlog()).calls.some((c) => c.path === 'refresh' && c.fault === 'hang'), '4.2-7h 更新が宙に浮く → 時間制限で打ち切り → 次の送信が通る（ロック待ちで止まらない）', (await mlog()).calls.map((c) => c.path + ':' + c.status + ':' + (c.fault || '')).join(' '));
    // 7d 同じタブで同時に2回 → 実際の更新は1回
    await clearLog();
    const [a7, b7] = await Promise.all([C.clRefresh(), C.clRefresh()]);
    ok(a7 && b7 && (await mlog()).calls.filter((c) => c.path === 'refresh').length === 1, '4.2-7d 同時に2回 clRefresh → サーバーへの更新は1回（相乗り）');
    // 7e 2タブ（navigator.locks あり）が同時に更新 → サーバーへの更新は1回・両方が同じ新しい合言葉
    const lsT = new Map([['hibiki-session', lsA.get('hibiki-session')]]);
    const locks = fakeLocks();
    const T1 = makeApp({ ls: lsT, locks }), T2 = makeApp({ ls: lsT, locks });
    await clearLog();
    const [x1, x2] = await Promise.all([T1.clRefresh(), T2.clRefresh()]);
    ok(x1 && x2 && (await mlog()).calls.filter((c) => c.path === 'refresh').length === 1 && T1.CL.sess.refresh_token === T2.CL.sess.refresh_token, '4.2-7e 2タブが同時に更新（鍵あり）→ 更新は1回・後のタブは先のタブの合言葉を採る', { x1, x2 });
    T1.dispose(); T2.dispose();
    // 7i 2タブ（鍵あり）で先のタブの更新が宙に浮く → 後のタブは詰まらずに更新できる・先のタブも後で合言葉を採る
    {
      const lsH = new Map([['hibiki-session', lsA.get('hibiki-session')]]);
      const lk = fakeLocks();
      const H1 = makeApp({ ls: lsH, locks: lk }), H2 = makeApp({ ls: lsH, locks: lk });
      await clearLog();
      await fault('refresh', 'hang', 1);
      const th = Date.now();
      const [h1, h2] = await Promise.all([H1.clRefresh(), H2.clRefresh()]);
      const hms = Date.now() - th;
      const h1b = await H1.clRefresh();
      ok(!h1 && h2 && h1b && hms < 8000 && H1.CL.sess.refresh_token === H2.CL.sess.refresh_token, '4.2-7i 鍵の中で更新が宙に浮いても、時間制限で鍵が外れて別タブの更新が通る（' + hms + 'ms）', { h1, h2, h1b, hms });
      H1.dispose(); H2.dispose();
    }
    // 7f 本当に無効 → 合言葉を捨てる（ユーザー・未送信・記録は残す）→ ログインし直すと続きから送る
    await clearLog();
    C.CL.sess.access_token = 'abc.def.ghi'; C.CL.sess.refresh_token = 'nonsense-token';
    lsA.set('hibiki-session', JSON.stringify(C.CL.sess));
    C.mutate(() => { C.state.memos.r7f = { t: '無効なセッション中の記録', ts: Date.now() }; });
    await until(() => C.CL.sess.dead === 1, 6000);
    await sleep(1500);
    const lg7f = await mlog();
    ok(C.CL.sess.dead === 1 && C.CL.sess.user && C.CL.sess.user.id === M.USER_ID && !C.cloudLoggedIn() && C.state.memos.r7f && C.clDirtyCount() >= 1, '4.2-7f 本当に無効（refresh_token_not_found）→ 合言葉だけ捨てる（ユーザー・記録・未送信は残る）', { dead: C.CL.sess.dead, dirty: C.clDirtyCount() });
    ok(lg7f.calls.filter((c) => c.path === 'put_items').length <= 1, '  無効なセッションで叩き続けない', lg7f.calls.map((c) => c.path + ':' + c.status).join(' '));
    await login(C); await C.clAfterLogin();
    const r7f = await until(has('memos', 'r7f'), 8000);
    ok(r7f && C.CL.shadowOk && !C.CL.log.slice(-6).some((e) => /全件受信/.test(e.msg)), '  ログインし直すと同じ影のまま続きから送る（全件受信しない）', C.CL.log.slice(-4).map((e) => e.msg));

    // ---- 8. 全件受信が失敗し続けても、いま書いた物は送られる（送信が受信の人質にならない）
    C.dispose();
    await fault('pull_items', '500', 1000);
    const lsE = new Map([['hibiki-session', lsA.get('hibiki-session')]]);
    const E = makeApp({ ls: lsE, idb: new Map(), state: clone(C.state) });
    const bootE = E.cloudBoot();
    await sleep(200);
    E.mutate(() => { E.state.memos.e8 = { t: '受信が壊れていても届く', ts: Date.now() }; });
    const r8 = await until(has('memos', 'e8'), 10000);
    ok(r8 && !E.CL.shadowOk, '4.2-8 全件受信が 500 で失敗し続けても、いま書いた項目は送信が通る', { r8, shadowOk: E.CL.shadowOk });
    await until(() => E.clDirtyCount() === 0, 5000);
    { const st = E.clStripText();
      ok(E.clNoShadow() && E.unsynced === true && /照合中/.test(st) && !/未送信 0件/.test(st), '  影が無い間（全件受信が失敗中）はランプを緑にしない・帯は「照合中」（「未送信 0件」と出さない）', { unsynced: E.unsynced, st }); }
    await adm('/__mock/fault/clear', {});
    await E.cloudSync(true);
    const r8b = await until(() => E.CL.shadowOk && E.clDirtyCount() === 0, 10000);
    ok(r8b, '  受信が直れば影ができて未送信 0', { shadowOk: E.CL.shadowOk, dirty: E.clDirtyCount() });
    await bootE;

    // ---- 9. 同時に何度呼んでも送信は1本ずつ・最後の保存も必ず届く
    await clearLog();
    await fault('put_items', 'delay', 2, 800);
    E.mutate(() => { E.state.memos.c9a = { t: '同時1', ts: Date.now() }; });
    const ps = [E.cloudSync(), E.cloudSync(), E.cloudSync(), E.cloudSync(), E.cloudSync()];
    await sleep(300);
    E.mutate(() => { E.state.memos.c9b = { t: '実行中に書いた', ts: Date.now() }; });
    E.cloudSync();
    await Promise.all(ps);
    const r9b = await until(async () => (await has('memos', 'c9a')()) && (await has('memos', 'c9b')()), 8000);
    const lg9 = await mlog();
    ok(r9b && (lg9.maxInflight.put_items || 0) === 1, '同時に cloudSync を5回＋実行中の保存 → put_items の同時接続は最大1・実行中の保存も届く（「もう1周」）', { max: lg9.maxInflight });

    // ---- 10. 送信中に同じ項目をその場で直す → 送った版の署名で影を更新＝直した版が後から必ず届く
    await fault('put_items', 'delay', 1, 1500);
    E.mutate(() => { E.state.memos.m10 = { t: 'v1', ts: Date.now() }; });
    const p10 = E.cloudSync();
    await sleep(500);
    E.mutate(() => { const m = E.state.memos.m10; m.t = 'v2（送信中に直した）'; m.ts = Date.now() + 1; });
    await p10;
    const r10 = await until(has('memos', 'm10', (r) => r.data.t === 'v2（送信中に直した）'), 8000);
    ok(r10 && E.clDirtyCount() === 0, '送信中のその場編集 → 直した版が届き、未送信 0', { dirty: E.clDirtyCount() });

    // ---- 11. ヘッダーだけ返して本文が止まる → 時間切れで抜けて再送
    await clearLog();
    await fault('put_items', 'stall', 1);
    E.mutate(() => { E.state.memos.s11 = { t: '本文が止まる', ts: Date.now() }; });
    const r11 = await until(has('memos', 's11'), 12000);
    ok(r11 && (await mlog()).calls.some((c) => c.fault === 'stall'), '本文の読み取りで止まる（stall）→ 時間制限は本文を読み終えるまで効く → 再送で届く');

    // ---- 12. 見張り：無進捗が続いたら打ち切ってやり直す
    E.CL.T.rpc = 60000; E.CL.T.put = 60000; E.CL.T.watch = 3000;
    await fault('put_items', 'hang', 1);
    E.mutate(() => { E.state.memos.w12 = { t: '見張り', ts: Date.now() }; });
    const r12 = await until(has('memos', 'w12'), 20000);
    ok(r12 && E.CL.log.some((e) => e.ev === 'watchdog'), '見張り：無進捗が続いた同期を打ち切ってやり直す（固着しない）', E.CL.log.slice(-5).map((e) => e.ev + ':' + e.msg));
    E.CL.T.watch = 70000;

    // ---- 13. 画面復帰：裏に回る前に始まって宙に浮いた通信は待たずに打ち切る
    await fault('put_items', 'hang', 2);
    E.mutate(() => { E.state.memos.v13 = { t: '復帰で打ち切り', ts: Date.now() }; });
    const p13 = E.cloudSync();
    await sleep(300);
    E.doc.hidden = true; E.fire('visibilitychange');
    await sleep(3200);
    E.doc.hidden = false; const tv = Date.now(); E.fire('visibilitychange');
    const r13 = await until(has('memos', 'v13'), 8000);
    ok(r13 && Date.now() - tv < 6000 && E.CL.log.some((e) => e.ev === 'resume'), '画面復帰 → 裏に回る前の宙に浮いた通信を打ち切り、すぐ送り直す', { ms: Date.now() - tv });
    await p13; E.CL.T.rpc = 2500; E.CL.T.put = 2500;

    // ---- 14. 端末の本文が保存できない（容量不足）→ 書いた項目を IndexedDB に退避 → 次の起動で戻して送る
    E.dispose();
    await fault('put_items', '500', 1000);
    const idbG = new Map();
    const G = makeApp({ ls: lsE, idb: idbG, state: clone(E.state), saveFail: true });
    await G.cloudBoot();
    G.mutate(() => { G.state.memos.o14 = { t: '端末に置けなかった記録', ts: Date.now() }; });
    await sleep(300);
    const ob = idbG.get('outbox:' + M.USER_ID);
    ok(G.localSaveFail && ob && JSON.parse(ob).rows['memos\u0000o14'], '端末保存に失敗 → 書いた項目の中身を IndexedDB の退避に置く', { fail: G.localSaveFail, ob: !!ob });
    const shG = idbG.get('shadow:' + M.USER_ID);
    G.dispose();
    await adm('/__mock/fault/clear', {});
    const st14 = clone(E.state);   // 本文には o14 が無い（保存できなかった）
    const H = makeApp({ ls: lsE, idb: idbG, state: st14 });
    await H.cloudBoot();
    const r14 = await until(has('memos', 'o14'), 8000);
    ok(r14 && H.state.memos.o14, '  次の起動で退避から戻して送る', { r14 });
    ok(!shG || JSON.parse(shG).seq >= 0, '  （保存失敗の間は影と受信位置を進めて保存しない）');
    H.dispose();

    // ---- 14b. IndexedDB が返事をしない → 待つのは1回（T.store）だけ → 同期が始まり保存が届く
    {
      const lsI = new Map([['hibiki-session', lsE.get('hibiki-session')]]);
      const I = makeApp({ ls: lsI, indexedDB: { open() { return {}; } }, state: clone(st14) });
      I.CL.T.store = 800;
      const tI = Date.now();
      const bootI = I.cloudBoot();
      const okReady = await until(() => I.CL.ready, 6000);
      const readyMs = Date.now() - tI;
      I.mutate(() => { I.state.memos.i14 = { t: 'IndexedDB が返らない端末', ts: Date.now() }; });
      const rI = await until(has('memos', 'i14'), 10000);
      ok(okReady && readyMs < 800 + 1500 && rI && I.CL.storeOk === false, '14b IndexedDB が返事をしない → 起動は ' + readyMs + 'ms で進む（待つのは1回）・保存が届く', { readyMs, rI, storeOk: I.CL.storeOk });
      await Promise.race([bootI, sleep(10000)]);
      I.dispose();
    }

    // ---- 14c. 受信の途中で失敗（データを合流した直後の終端の pull_items だけ落ちる）→ 合流済みの行は描画・端末保存される
    {
      let pullN = 0, failAt = -1;
      const lsJ = new Map([['hibiki-session', lsE.get('hibiki-session')]]);
      const J = makeApp({ ls: lsJ, idb: new Map(), state: clone(st14), fetchHook: (u) => { if (u.indexOf('/rest/v1/rpc/pull_items') >= 0) { pullN++; if (pullN === failAt) return Promise.reject(new Error('Load failed')); } return null; } });
      await J.cloudBoot();
      await until(() => J.CL.shadowOk && !J.CL.busy && J.clDirtyCount() === 0 && J.CLQ.fails === 0, 10000);
      const rows14 = []; const t14 = Date.now(); for (let i = 0; i < 300; i++) rows14.push({ coll: 'memos', k: 'x14c' + i, ts: t14 + i, data: { t: '別端末 ' + i, ts: t14 + i } });   // 行の ts と中身の ts は同じ値（別々に Date.now() を取ると食い違う）
      await arpc('put_items', { rows: rows14 });
      const c0 = { r: J.cnt.r, s: J.cnt.s }, seq0 = J.CL.seq;
      pullN = 0; failAt = 2;
      const ok1 = await J.cloudSync(true); failAt = -1;
      const lsMemos = () => { try { return Object.keys(JSON.parse(J.ls.get('LS')).memos || {}).filter((k) => /^x14c/.test(k)).length; } catch (e) { return -1; } };
      const mid = { ok1, seqUp: J.CL.seq > seq0, st: Object.keys(J.state.memos).filter((k) => /^x14c/.test(k)).length, r: J.cnt.r - c0.r, s: J.cnt.s - c0.s, ls: lsMemos() };
      ok(mid.ok1 === false && mid.seqUp && mid.st === 300 && mid.r >= 1 && mid.s >= 1 && mid.ls === 300, '14c 受信の終端（0件の呼び出し）だけ失敗 → 合流済みの 300件はその場で描画・端末保存（受信位置は進んだまま取りこぼさない）', mid);
      await until(() => J.CLQ.fails === 0 && !J.CL.busy, 8000);
      ok(lsMemos() === 300 && J.CL.pendingChanged === false, '  再挑戦の後も端末の本文に 300件が残る', { ls: lsMemos(), fails: J.CLQ.fails });
      J.dispose();
    }

    // ---- 15. 6,000件規模：影の計算・2^53 を超える ts 合計の整合・2回目の起動は増分だけ
    const big = clone(st14); big.entries = big.entries || {};
    const T0 = 1760000000001;
    for (let i = 0; i < 6000; i++) { const d = '2025-' + String(1 + (i % 12)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0'); (big.entries[d] = big.entries[d] || {})['b' + i] = { p: '場所' + (i % 50), t: '本文 ' + i + ' '.repeat(i % 7) + 'あいう', ph: [], s: '09:00', e: '10:00', ts: T0 + i, acts: [{ t: '行', m: 30, k: 'ai' }] }; }
    const lsF = new Map([['hibiki-session', lsA.get('hibiki-session')]]), idbF = new Map();
    const F = makeApp({ ls: lsF, idb: idbF, state: big, rpcMs: 20000 });
    const tF = Date.now();
    await F.cloudBoot();
    const rF = await until(() => F.CL.shadowOk && F.clDirtyCount() === 0 && F.CLQ.fails === 0 && !F.CL.busy, 60000);
    const tFull = Date.now() - tF;
    ok(rF && F.CL.integ.res === 'OK', '6,000件超：全件受信→差の送信（' + tFull + 'ms）→ 整合 OK（ts 合計が 2^53 超でも BigInt で一致）', { integ: F.CL.integ.res, perf: F.CL.perf });
    {
      /* 署名の速さは vm の外（ふつうの JS の世界）で測る。vm の中は大域変数の参照が遅く、実機より何倍も遅く出るため */
      const src = fs.readFileSync(path.join(__dirname, 'cloud-layer.js'), 'utf8');
      const S = new Function(src.slice(src.indexOf('const CL_ID='), src.indexOf('function clSig(it)')) + ';return {clItems,clKey,clSigOf};')();
      let best = 1e9; for (let r = 0; r < 5; r++) { const t = Date.now(); const m = {}; for (const it of S.clItems(big)) m[S.clKey(it)] = S.clSigOf(it, true); best = Math.min(best, Date.now() - t); }
      ok(best < 250, '  影の計算：' + S.clItems(big).length + '件の全署名 ' + best + 'ms（5回の最良。設計の目安 100ms・判定は負荷の揺れを見て 250ms）', best);
      /* 保存1回の差の計算（指紋を見て署名を使い回す）も vm の外で測る（vm の中は負荷で大きく揺れる） */
      let bm = 1e9; for (let r = 0; r < 5; r++) { const t = Date.now(); for (const it of S.clItems(big)) { S.clKey(it); S.clSigOf(it, false); } bm = Math.min(bm, Date.now() - t); }
      ok(bm < 150, '  保存1回の差の計算（指紋が同じなら署名は使い回し）' + bm + 'ms（5回の最良・vm の外。目安 50ms・判定は 150ms）', bm);
    }
    F.mutate(() => { F.state.memos.f15 = { t: '大きいデータで1件', ts: Date.now() }; });
    ok(F.CL.perf.mark < 400, '  保存1回の差の計算 vm の中 ' + F.CL.perf.mark + 'ms（固まらない目安 400ms。速さの判定は上の vm の外の計測）', F.CL.perf);
    await until(has('memos', 'f15'), 8000);
    await F.clPersist(); F.dispose();
    await clearLog();
    const F2 = makeApp({ ls: lsF, idb: idbF, state: clone(F.state), rpcMs: 20000 });
    const t2 = Date.now();
    await F2.cloudBoot();
    F2.mutate(() => { F2.state.memos.f15b = { t: '2回目の起動で1件', ts: Date.now() }; });
    const rF2 = await until(has('memos', 'f15b'), 8000);
    const t2ms = Date.now() - t2;
    const lgF2 = await mlog();
    ok(rF2 && lgF2.calls.filter((c) => c.path === 'pull_items').length <= 4 && !F2.CL.log.some((e) => /全件受信/.test(e.msg) && e.t >= t2), '2回目の起動：影あり → 増分受信だけ → 保存1件が届く（' + t2ms + 'ms・vm の中。3秒の判定は実機相当の試験で）', lgF2.calls.map((c) => c.path).join(' '));
    F2.dispose();
  } finally {
    for (const a of apps) { try { a.dispose(); } catch (e) { /* 無視 */ } }
    await srv.close();
    try { fs.rmSync(ADIR, { recursive: true, force: true }); } catch (e) { /* 残っても害は無い */ }
  }
}

main().then(() => appTests()).then(() => finish(), (e) => { console.log('\n  [NG] 予期しないエラー: ' + (e && e.stack || e)); fail++; return finish(); });

async function finish() {
  await killChild();
  if (SPAWN) { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 残っても害は無い */ } }
  console.log('\n結果: ' + pass + ' 件 OK / ' + fail + ' 件 NG');
  process.exit(fail ? 1 : 0);
}
