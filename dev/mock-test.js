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
const PORT = 8788;
const TTL = 2;
const BASE = (urlArg || 'http://localhost:' + PORT).replace(/\/+$/, '');
const DATA_DIR = path.join(__dirname, 'mock-data-test'); // 自前起動のときだけ使う使い捨て置き場
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
    try { const r = await fetch(BASE + '/_mock/health'); if (r.ok) return; } catch (e) { /* まだ */ }
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

main().then(() => finish(), (e) => { console.log('\n  [NG] 予期しないエラー: ' + (e && e.stack || e)); fail++; return finish(); });

async function finish() {
  await killChild();
  if (SPAWN) { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 残っても害は無い */ } }
  console.log('\n結果: ' + pass + ' 件 OK / ' + fail + ' 件 NG');
  process.exit(fail ? 1 : 0);
}
