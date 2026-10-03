#!/usr/bin/env node
'use strict';
/*
  ヒビキ（日々記）／HIBIKI — 手元テスト用の擬似 Supabase サーバー（Node・依存なし・単一ファイル）

  本物の Supabase と「同じパス・同じ形の JSON」を返す。アプリ（http://localhost:8931）から fetch だけで叩ける。
  起動:  node mock-supabase.js [--port 8787] [--token-ttl 60] [--reset]
         そのほか  --data-dir <dir>（既定 ./mock-data）  --host <addr>（既定 127.0.0.1 と ::1）
                   --max-rows <n>（pull_items の1回の上限・既定1000＝Supabase の既定 max-rows）  --quiet

  ■ 実装しているエンドポイント
    POST /auth/v1/token?grant_type=password        {email,password}
    POST /auth/v1/token?grant_type=refresh_token   {refresh_token}
    GET  /auth/v1/user
    POST /auth/v1/logout                           → 204
    POST /rest/v1/rpc/put_items                    {rows:[{coll,k,ts,data}]}      → 整数（実際に書いた行数）
    POST /rest/v1/rpc/pull_items                   {since_seq,lim}                → [{coll,k,ts,data,seq}]（seq 昇順）
    POST /rest/v1/rpc/integrity                    {}                             → [{coll,n,tsum}]
    POST /storage/v1/object/photos/<uid>/<assetId>               （生バイト or multipart。既存パスは 400）
    GET  /storage/v1/object/authenticated/photos/<uid>/<assetId> （保存した Content-Type で返す）
    ※ DELETE /rest/v1/items は 403（DELETE 権限は誰にも無い）。Storage の PUT/DELETE も不可（update/delete 権限なし）。

  ■ 固定の1ユーザー（コード内の定数）
    email: test@example.com / password: test-pass-1234 / id: 00000000-0000-4000-8000-000000000001

  ■ apikey
    全エンドポイントで必須（ヘッダ apikey か ?apikey=）。値は下の ANON_KEY（起動時に表示・GET /_mock/config でも取れる）。
    欠落 → 401 {message:'No API key found in request'} ／ 違う → 401 {message:'Invalid API key'}。

  ■ 本物と同じにしてある所（アプリの作りを試すため、わざと本物並みに厳しくしてある）
    - access_token は HS256 の JWT 形式（exp を持つ）。期限切れ → 401 {message:'JWT expired'}。
    - refresh_token は使い捨て（回すと古い方は10秒の再利用猶予のあと無効）。
    - ログアウトするとセッションが消え、/auth/v1/user は 403 session_not_found。refresh も不可。
    - pull_items は max-rows（既定1000）で切られる。lim=5000 を頼んでも1000件しか返らない。
      → 「返った件数 < lim なら終わり」と判定すると取りこぼす。「0件が返るまで」or「min(lim,1000)」で回すこと。
      setup.sql 側は lim を 1〜5000 に丸める（0 や負は 1、null は 1000、since_seq が null/負なら 0）。このモックも同じ。
    - integrity の tsum は bigint の合計を「正確な桁のまま JSON の数値」で返す（PostgREST と同じ）。
      件数×ts（約1.7e12）が 2^53(≒9.0e15) を超えると JS の Number では狂う（約5300件で超える）。
      → アプリ側は BigInt で読む（JSON.parse の reviver の context.source）か、剰余など小さい指標で比べること。
      coll の並びは setup.sql が collate "C"（コード順）で返す。このモックの sort() と同じ。
    - 引数名：put_items は rows が必須。pull_items は since_seq・lim とも省略可（setup.sql の default 0 / 1000 と同じ。
      null を渡しても既定値）。integrity は無し。知らない引数名・必須の欠落は 404 PGRST202（PostgREST と同じ）。
    - put_items は全行を先に検査し、1行でも不正なら 400（22023）で何も書かない（トランザクション相当）。
      coll/k は空でない文字列、ts は数値（文字列・真偽・null・欠落は不正）、data は JSON null 以外（欠落も不正）。
      rows が配列でない → 22023、5000 行超 → 54000、空配列 → 0。文字列に \u0000 を含むと 22P05（jsonb に入らない）。
    - put_items の ts の丸め：小数は切り捨て、負は 0、サーバー時刻+1時間 を超えたらその上限。
      data が数値の ts を持ち、それが上限超えなら data.ts も上限に丸める（setup.sql と同じ）。
    - put_items の上書き規則：既存が無ければ挿入。あれば「既存 ts <= 新 ts かつ 中身(jsonb)が違う」時だけ上書き。
      同じバッチに同じ (coll,k) が複数あれば、ts が最大の1件だけを使う（同点なら後ろの行）。戻り値はその上での書いた行数。
      書いた行は seq を採番し直す。1バッチ内の seq の順は (coll,k) の並びで、送った順ではない（本物は DB の照合順）。
      seq は欠番が出うる（本物は insert 試行と update でそれぞれ nextval を消費する）。連番を仮定しないこと。
      上書き前の旧版は history（items_history 相当・退避時刻は saved_at）へ退避。
    - RLS 相当：Authorization が無い／anon キーだけ → rpc は 401 42501、storage は 403。

  ■ 永続化（--data-dir、既定 ./mock-data/）
    items.jsonl（追記ログ・起動時に再生）／history.jsonl（旧版）／meta.json（ログインセッション）／photos/（写真＋index.json）
    mock-data/.gitignore（中身すべて除外）を自動で作る＝本人の実データを入れても公開リポジトリに載らない。

  ■ 確認用の補助（本物には無い）
    GET /_mock/health  GET /_mock/config  GET /_mock/history?coll=&k=  GET /_mock/dump  POST /_mock/reset
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- 定数
const USER_ID = '00000000-0000-4000-8000-000000000001';
const TEST_EMAIL = 'test@example.com';
const TEST_PASSWORD = 'test-pass-1234';
const JWT_SECRET = 'hibiki-mock-jwt-secret-not-for-production';
const BUCKET = 'photos';
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const REFRESH_REUSE_MS = 10 * 1000;          // 本物の既定（refresh token reuse interval = 10秒）
const TS_FUTURE_LIMIT_MS = 60 * 60 * 1000;   // サーバー時刻 + 1時間
const MAX_BODY_BYTES = 50 * 1024 * 1024;     // Supabase 無料枠のファイル上限 50MB
const CORS_ALLOW_HEADERS = 'apikey, authorization, content-type, prefer, x-client-info, range, x-upsert, accept-profile, content-profile, x-supabase-api-version';

// ---------------------------------------------------------------- JWT（HS256・本物と同じ形）
const b64u = (x) => Buffer.from(x).toString('base64url');
function signJwt(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + s;
}
// 戻り値: {payload} か {error:'invalid'|'expired', detail}
function verifyJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { error: 'invalid', detail: 'JWSError (CompactDecodeError Invalid number of parts: Expected 3 parts)' };
  const want = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest();
  let got;
  try { got = Buffer.from(parts[2], 'base64url'); } catch (e) { got = Buffer.alloc(0); }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { error: 'invalid', detail: 'JWSError JWSInvalidSignature' };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return { error: 'invalid', detail: 'JWT payload is not JSON' }; }
  if (typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp) return { error: 'expired', detail: 'JWT expired' };
  return { payload };
}
// 固定の anon キー（毎回同じ値。アプリ側の SB_KEY にそのまま入れる）
const ANON_KEY = signJwt({ iss: 'supabase-mock', ref: 'hibiki-mock', role: 'anon', iat: 1700000000, exp: 4102444800 });

// ---------------------------------------------------------------- 小道具
class HttpError extends Error {
  constructor(status, body) { super((body && (body.message || body.msg)) || 'error'); this.status = status; this.body = body; }
}
function deepEqual(a, b) { // jsonb の等価（オブジェクトはキー順無視・配列は順序あり）
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false; return true; }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false; }
  return true;
}
const rpcErr = (message, code) => new HttpError(400, { code: code || 'P0001', details: null, hint: null, message });
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { throw new HttpError(400, { statusCode: '400', error: 'InvalidKey', message: 'Invalid key' }); } }
function toInt(v, name, type) { // PostgREST は bigint/int 引数に数値でも数字文字列でも通す。type='integer' は int4 の範囲も見る
  type = type || 'bigint';
  let n = null;
  if (typeof v === 'number' && Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) n = Number(v);
  if (n === null) throw rpcErr('invalid input syntax for type ' + type + ': "' + String(v) + '" (' + name + ')', '22P02');
  if (type === 'integer' && (n > 2147483647 || n < -2147483648)) throw rpcErr('value "' + String(v) + '" is out of range for type integer (' + name + ')', '22003');
  return n;
}
// jsonb は \u0000 を含む文字列を保存できない（キー名も同じ）。本物は 22P05 で 400
function hasNul(v) {
  if (typeof v === 'string') return v.indexOf('\u0000') >= 0;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) { for (const x of v) if (hasNul(x)) return true; return false; }
  for (const k of Object.keys(v)) { if (k.indexOf('\u0000') >= 0 || hasNul(v[k])) return true; }
  return false;
}

function parseArgs(argv) {
  const o = { port: 8787, tokenTtl: 3600, reset: false, dataDir: path.join(__dirname, 'mock-data'), host: null, maxRows: 1000, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => { if (v !== undefined) return v; if (i + 1 >= argv.length) throw new Error(a + ' に値が要ります'); return argv[++i]; };
    switch (a) {
      case '--port': o.port = Number(next()); break;
      case '--token-ttl': o.tokenTtl = Number(next()); break;
      case '--reset': o.reset = true; break;
      case '--data-dir': o.dataDir = path.resolve(next()); break;
      case '--host': o.host = next(); break;
      case '--max-rows': o.maxRows = Number(next()); break;
      case '--quiet': o.quiet = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('不明なオプション: ' + a);
    }
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port は 1〜65535 の整数');
  if (!(o.tokenTtl >= 1)) throw new Error('--token-ttl は 1 以上の秒数');
  if (!Number.isInteger(o.maxRows) || o.maxRows < 1) throw new Error('--max-rows は 1 以上の整数');
  return o;
}

// ---------------------------------------------------------------- サーバー本体
function start(opts) {
  const cfg = Object.assign({ port: 8787, tokenTtl: 3600, reset: false, dataDir: path.join(__dirname, 'mock-data'), host: null, maxRows: 1000, quiet: false }, opts || {});
  const dir = cfg.dataDir;
  const F = {
    items: path.join(dir, 'items.jsonl'),
    history: path.join(dir, 'history.jsonl'),
    meta: path.join(dir, 'meta.json'),
    photosDir: path.join(dir, 'photos'),
    photosIndex: path.join(dir, 'photos', 'index.json'),
    gitignore: path.join(dir, '.gitignore'),
  };

  // ---- 永続データの準備（--reset は「このサーバーが作る既知のファイル」だけを消す）
  fs.mkdirSync(dir, { recursive: true });
  if (cfg.reset) wipe();
  fs.mkdirSync(F.photosDir, { recursive: true });
  if (!fs.existsSync(F.gitignore)) fs.writeFileSync(F.gitignore, '# 本人の実データが入りうるので、このフォルダの中身は一切コミットしない\n*\n!.gitignore\n');

  function wipe() {
    for (const f of [F.items, F.history, F.meta]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* 無ければ良い */ } }
    try { fs.rmSync(F.photosDir, { recursive: true, force: true }); } catch (e) { /* 無ければ良い */ }
    fs.mkdirSync(F.photosDir, { recursive: true });
  }

  // ---- items：Map の挿入順＝seq 昇順（更新時は delete→set で末尾へ動かす）
  let items = new Map();
  let history = [];
  let seqCounter = 0;
  const keyOf = (coll, k) => coll + '\u0000' + k;

  function loadJsonl(file, onRow) {
    if (!fs.existsSync(file)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { onRow(JSON.parse(line)); n++; } catch (e) { /* 書きかけの末尾行は捨てる */ }
    }
    return n;
  }
  function loadAll() {
    items = new Map(); history = []; seqCounter = 0;
    const lines = loadJsonl(F.items, (r) => {
      const key = keyOf(r.coll, r.k);
      items.delete(key); items.set(key, r);
      if (r.seq > seqCounter) seqCounter = r.seq;
    });
    loadJsonl(F.history, (r) => history.push(r));
    // 追記ログが膨らんだら圧縮（現在の行だけ書き直す）
    if (lines > items.size * 2 + 100) {
      fs.writeFileSync(F.items, [...items.values()].map((r) => JSON.stringify(r)).join('\n') + (items.size ? '\n' : ''));
    }
  }
  loadAll();

  // ---- 認証セッション（再起動後も有効）
  let sessions = new Map();   // sid -> {created}
  let refreshTokens = new Map(); // token -> {sid, usedAt|null, created}
  function loadMeta() {
    sessions = new Map(); refreshTokens = new Map();
    try {
      const m = JSON.parse(fs.readFileSync(F.meta, 'utf8'));
      for (const [sid, v] of Object.entries(m.sessions || {})) sessions.set(sid, v);
      for (const [t, v] of Object.entries(m.refresh || {})) refreshTokens.set(t, v);
    } catch (e) { /* 初回は無い */ }
  }
  function saveMeta() {
    const cutoff = Date.now() - 3600 * 1000; // 使用済みで1時間以上たったトークンは捨てる
    for (const [t, v] of refreshTokens) if (v.usedAt && v.usedAt < cutoff) refreshTokens.delete(t);
    fs.writeFileSync(F.meta, JSON.stringify({ sessions: Object.fromEntries(sessions), refresh: Object.fromEntries(refreshTokens) }));
  }
  loadMeta();

  // ---- 写真（Storage）
  let photoIndex = {};
  function loadPhotos() { try { photoIndex = JSON.parse(fs.readFileSync(F.photosIndex, 'utf8')); } catch (e) { photoIndex = {}; } }
  function savePhotos() { fs.writeFileSync(F.photosIndex, JSON.stringify(photoIndex)); }
  loadPhotos();
  const photoFile = (p) => path.join(F.photosDir, crypto.createHash('sha1').update(p).digest('hex') + '.bin');

  // ---------------------------------------------------------------- Auth
  const nowIso = () => new Date().toISOString();
  const userObj = () => ({
    id: USER_ID, aud: 'authenticated', role: 'authenticated', email: TEST_EMAIL, email_confirmed_at: CREATED_AT, phone: '',
    confirmed_at: CREATED_AT, last_sign_in_at: nowIso(), app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {}, identities: [], created_at: CREATED_AT, updated_at: nowIso(), is_anonymous: false,
  });
  function issueTokens(sid) {
    const now = Date.now();
    const exp = Math.ceil(now / 1000 + cfg.tokenTtl);
    const access = signJwt({
      aud: 'authenticated', exp, iat: Math.floor(now / 1000), iss: 'supabase-mock/auth/v1', sub: USER_ID, email: TEST_EMAIL, phone: '',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, role: 'authenticated', aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(now / 1000) }], session_id: sid, is_anonymous: false,
    });
    const refresh = crypto.randomBytes(9).toString('base64url'); // 本物と同じ12文字
    refreshTokens.set(refresh, { sid, usedAt: null, created: now });
    saveMeta();
    return { access_token: access, token_type: 'bearer', expires_in: Math.round(cfg.tokenTtl), expires_at: exp, refresh_token: refresh, user: userObj() };
  }
  const authFail = (status, error_code, msg) => new HttpError(status, { code: status, error_code, msg, message: msg });
  const jwtFail = (detail) => new HttpError(401, { code: 'PGRST301', details: null, hint: null, message: detail, msg: detail, error_code: 'bad_jwt' });

  // Authorization を調べる。戻り値 {role:'anon'} か {role:'user', payload}。期限切れ・不正は 401 を投げる。
  function authenticate(req) {
    const h = req.headers['authorization'];
    if (!h) return { role: 'anon' };
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw jwtFail('JWT invalid: Authorization header must be "Bearer <token>"');
    const tok = m[1].trim();
    if (tok === ANON_KEY) return { role: 'anon' };
    const v = verifyJwt(tok);
    if (v.error) throw jwtFail(v.error === 'expired' ? 'JWT expired' : v.detail);
    if (v.payload.role !== 'authenticated' || v.payload.sub !== USER_ID) throw jwtFail('JWT invalid: unknown subject');
    return { role: 'user', payload: v.payload };
  }

  async function authRoute(req, res, url) {
    const p = url.pathname, m = req.method;
    if (p === '/auth/v1/token') {
      if (m !== 'POST') throw new HttpError(405, { message: 'Method not allowed' });
      const gt = url.searchParams.get('grant_type');
      const body = await readJson(req);
      if (gt === 'password') {
        const email = String(body.email || '').trim().toLowerCase();
        if (email !== TEST_EMAIL || body.password !== TEST_PASSWORD) throw authFail(400, 'invalid_credentials', 'Invalid login credentials');
        const sid = crypto.randomUUID();
        sessions.set(sid, { created: Date.now() });
        return send(res, 200, issueTokens(sid));
      }
      if (gt === 'refresh_token') {
        const rec = refreshTokens.get(String(body.refresh_token || ''));
        if (!rec || !sessions.has(rec.sid)) throw authFail(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        if (rec.usedAt && Date.now() - rec.usedAt > REFRESH_REUSE_MS) throw authFail(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
        if (!rec.usedAt) rec.usedAt = Date.now();
        return send(res, 200, issueTokens(rec.sid));
      }
      throw authFail(400, 'validation_failed', 'unsupported_grant_type');
    }
    if (p === '/auth/v1/user') {
      if (m !== 'GET') throw new HttpError(405, { message: 'Method not allowed' });
      const a = authenticate(req);
      if (a.role !== 'user') {
        if (req.headers['authorization']) throw authFail(403, 'bad_jwt', 'invalid claim: missing sub claim');
        throw authFail(401, 'no_authorization', 'This endpoint requires a Bearer token');
      }
      if (!sessions.has(a.payload.session_id)) throw authFail(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
      return send(res, 200, userObj());
    }
    if (p === '/auth/v1/logout') {
      if (m !== 'POST') throw new HttpError(405, { message: 'Method not allowed' });
      const a = authenticate(req);
      if (a.role !== 'user') throw authFail(401, 'no_authorization', 'This endpoint requires a Bearer token');
      sessions.delete(a.payload.session_id);
      for (const [t, v] of refreshTokens) if (v.sid === a.payload.session_id) refreshTokens.delete(t);
      saveMeta();
      res.writeHead(204); return res.end();
    }
    if (p === '/auth/v1/signup') throw authFail(422, 'signup_disabled', 'Signups not allowed for this instance');
    if (p === '/auth/v1/health') return send(res, 200, { version: 'mock', name: 'GoTrue', description: 'HIBIKI mock auth' });
    throw authFail(404, 'not_found', 'Path not found (mock supports token / user / logout only)');
  }

  // ---------------------------------------------------------------- REST（RPC）
  // setup.sql の put_items と同じ振る舞い（形の検査 → ts/data.ts の丸め → 同一バッチの重複を1件に → 上書き規則）
  const PUT_MAX_ROWS = 5000;
  const PUT_ROW_MSG = 'invalid row: each row needs string coll, string k, numeric ts, non-null data';
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function putItems(rows) {
    if (hasNul(rows)) throw new HttpError(400, { code: '22P05', details: '\u0000 cannot be converted to text.', hint: null, message: 'unsupported Unicode escape sequence' });
    if (!Array.isArray(rows)) throw rpcErr('rows must be a JSON array', '22023');
    if (rows.length === 0) return 0;
    if (rows.length > PUT_MAX_ROWS) throw rpcErr('too many rows (max ' + PUT_MAX_ROWS + ' per call)', '54000');
    // 先に全行を検査（不正が1行でもあれば何も書かない）
    for (const r of rows) {
      if (r === null || typeof r !== 'object' || Array.isArray(r)
        || typeof r.coll !== 'string' || !r.coll || typeof r.k !== 'string' || !r.k
        || typeof r.ts !== 'number' || r.data === undefined || r.data === null) throw rpcErr(PUT_ROW_MSG, '22023');
    }
    const maxTs = Date.now() + TS_FUTURE_LIMIT_MS;
    // ts は 小数→切り捨て・負→0・サーバー時刻+1時間 超→上限。data が数値の ts を持ち上限超えなら data.ts も上限に丸める
    // 同じバッチに同じ (coll,k) が複数あれば、丸めた後の ts が最大の1件（同点なら後ろの行）だけを使う
    const best = new Map();
    for (const r of rows) {
      const ts = Math.max(0, Math.min(Math.floor(r.ts), maxTs));
      let data = r.data;
      if (data !== null && typeof data === 'object' && !Array.isArray(data) && typeof data.ts === 'number' && data.ts > maxTs) data = Object.assign({}, data, { ts: maxTs });
      const key = keyOf(r.coll, r.k), prev = best.get(key);
      if (!prev || ts >= prev.ts) best.set(key, { coll: r.coll, k: r.k, ts, data });
    }
    // 本物は distinct on の並び（coll, k 順）で書くので、seq の順も送った順ではなく (coll,k) 順になる
    const batch = [...best.values()].sort((a, b) => cmpStr(a.coll, b.coll) || cmpStr(a.k, b.k));
    let n = 0;
    for (const r of batch) {
      const key = keyOf(r.coll, r.k);
      const cur = items.get(key);
      if (cur) {
        if (!(cur.ts <= r.ts) || deepEqual(cur.data, r.data)) continue; // 古い or 中身が同じなら何もしない
        const old = Object.assign({ saved_at: nowIso() }, cur); // 旧版を items_history へ
        history.push(old); fs.appendFileSync(F.history, JSON.stringify(old) + '\n');
        items.delete(key);
      }
      const row = { coll: r.coll, k: r.k, ts: r.ts, data: r.data, seq: ++seqCounter };
      items.set(key, row);
      fs.appendFileSync(F.items, JSON.stringify(row) + '\n');
      n++;
    }
    return n;
  }
  // since_seq は null/負なら 0 扱い。lim は 1〜5000 に丸め（さらに本物の PostgREST の max-rows で切れる）
  const PULL_MAX_LIM = 5000;
  function pullItems(sinceSeq, lim) {
    if (sinceSeq < 0) sinceSeq = 0;
    const cap = Math.min(Math.max(lim, 1), PULL_MAX_LIM, cfg.maxRows);
    const out = [];
    for (const r of items.values()) { // Map の順＝seq 昇順
      if (r.seq > sinceSeq) { out.push({ coll: r.coll, k: r.k, ts: r.ts, data: r.data, seq: r.seq }); if (out.length >= cap) break; }
    }
    return out;
  }
  function integrity() {
    const g = new Map();
    for (const r of items.values()) { const e = g.get(r.coll) || { n: 0, tsum: 0n }; e.n++; e.tsum += BigInt(r.ts); g.set(r.coll, e); }
    return [...g.keys()].sort().map((coll) => ({ coll, n: g.get(coll).n, tsum: g.get(coll).tsum }));
  }
  // 引数名の検査（PostgREST は関数名＋引数名の集合で解決する。合わなければ 404 PGRST202）
  function fnNotFound(fn, args) {
    const names = Object.keys(args).sort().join(', ');
    return new HttpError(404, {
      code: 'PGRST202', details: 'Searched for the function public.' + fn + ' with parameter' + (names.indexOf(',') >= 0 ? 's ' : ' ') + (names || 'none') + ', but no matches were found in the schema cache.',
      hint: null, message: 'Could not find the function public.' + fn + '(' + names + ') in the schema cache',
    });
  }
  // params＝受け付ける引数名の全部、required＝default の無い引数（setup.sql の関数定義と同じ）
  const RPC = {
    put_items: { params: ['rows'], required: ['rows'], run: (a) => putItems(a.rows) },
    pull_items: { params: ['since_seq', 'lim'], required: [], // since_seq bigint default 0, lim integer default 1000。null も既定値
      run: (a) => pullItems(a.since_seq == null ? 0 : toInt(a.since_seq, 'since_seq'), a.lim == null ? 1000 : toInt(a.lim, 'lim', 'integer')) },
    integrity: { params: [], required: [], run: () => integrity() },
  };

  async function restRoute(req, res, url) {
    const p = url.pathname, m = req.method;
    const a = authenticate(req);
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = safeDecode(p.slice('/rest/v1/rpc/'.length));
      const def = Object.prototype.hasOwnProperty.call(RPC, fn) ? RPC[fn] : null;
      if (!def) throw fnNotFound(fn, {});
      if (m !== 'POST') throw new HttpError(405, { code: 'PGRST101', details: null, hint: null, message: 'Function ' + fn + ' cannot be invoked with ' + m + ' method (mock supports POST only)' });
      if (a.role !== 'user') throw new HttpError(401, { code: '42501', details: null, hint: null, message: 'permission denied for function ' + fn });
      const args = await readJson(req);
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, { code: 'PGRST102', details: null, hint: null, message: 'Empty or invalid json' });
      const have = Object.keys(args);
      if (have.some((n) => def.params.indexOf(n) < 0) || def.required.some((n) => have.indexOf(n) < 0)) throw fnNotFound(fn, args);
      const result = def.run(args);
      if (fn === 'integrity') { // tsum は桁を落とさず数値のまま出す（PostgREST と同じ）
        return sendRaw(res, 200, '[' + result.map((r) => '{"coll":' + JSON.stringify(r.coll) + ',"n":' + r.n + ',"tsum":' + r.tsum.toString() + '}').join(',') + ']', 'application/json; charset=utf-8');
      }
      return send(res, 200, result);
    }
    const table = /^\/rest\/v1\/(items|items_history)\/?$/.exec(p);
    if (table) {
      if (m === 'DELETE') {
        if (a.role !== 'user') throw new HttpError(401, { code: '42501', details: null, hint: null, message: 'permission denied for table ' + table[1] });
        throw new HttpError(403, { code: '42501', details: null, hint: null, message: 'permission denied for table ' + table[1] }); // DELETE 権限は誰にも付けない
      }
      throw new HttpError(404, { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public." + table[1] + "' in the schema cache (the mock supports RPC only)" });
    }
    throw new HttpError(404, { code: 'PGRST125', details: null, hint: null, message: 'Invalid path specified in request URL' });
  }

  // ---------------------------------------------------------------- Storage
  const stErr = (status, error, message) => new HttpError(status, { statusCode: String(status), error, message });
  const stBucketNotFound = () => new HttpError(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
  const stRls = () => new HttpError(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });

  function parseMultipart(buf, ctype) { // storage-js 流の FormData 送信にも耐える最小実装
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (!bm) return null;
    const boundary = Buffer.from('--' + (bm[1] || bm[2]).trim());
    const parts = [];
    let pos = buf.indexOf(boundary);
    while (pos !== -1) {
      const start = pos + boundary.length;
      if (buf.slice(start, start + 2).toString() === '--') break;
      const next = buf.indexOf(boundary, start);
      if (next === -1) break;
      parts.push(buf.slice(start + 2, next - 2)); // 先頭の CRLF と末尾の CRLF を除く
      pos = next;
    }
    const parsed = parts.map((pt) => {
      const he = pt.indexOf('\r\n\r\n');
      if (he < 0) return null;
      const head = pt.slice(0, he).toString('latin1');
      const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
      return { head, body: pt.slice(he + 4), contentType: ct ? ct[1].trim() : null };
    }).filter(Boolean);
    const pick = parsed.find((x) => /filename=/i.test(x.head)) || parsed.find((x) => /name=""/i.test(x.head)) || parsed[parsed.length - 1];
    return pick || null;
  }

  async function storageRoute(req, res, url) {
    const m = req.method;
    const segs = url.pathname.split('/').slice(1).map(safeDecode); // ['storage','v1','object',...]
    if (segs[2] !== 'object') throw stErr(404, 'not_found', 'Route not found');
    let rest = segs.slice(3);
    let authedRoute = false;
    if (rest[0] === 'authenticated') { authedRoute = true; rest = rest.slice(1); }
    const a = authenticate(req);
    const bucket = rest[0];
    const objParts = rest.slice(1);
    if (!bucket) throw stErr(404, 'not_found', 'Route not found');
    if (bucket !== BUCKET) throw new HttpError(404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });

    if (m === 'GET' || m === 'HEAD') {
      if (!authedRoute) throw stBucketNotFound(); // 非公開バケットを公開 URL で読もうとした
      if (a.role !== 'user') throw stRls();
      if (objParts.length < 2) throw new HttpError(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      if (objParts[0] !== USER_ID) throw stRls(); // 本人以外のフォルダ
      const key = objParts.join('/');
      const ent = photoIndex[key];
      let buf = null;
      if (ent) { try { buf = fs.readFileSync(photoFile(key)); } catch (e) { buf = null; } }
      if (!buf) throw new HttpError(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const headers = {
        'Content-Type': ent.contentType || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'max-age=3600',
        ETag: '"' + crypto.createHash('md5').update(buf).digest('hex') + '"', 'Last-Modified': new Date(ent.created_at).toUTCString(),
      };
      res.writeHead(200, headers);
      return res.end(m === 'HEAD' ? undefined : buf);
    }
    if (authedRoute) throw new HttpError(405, { message: 'Method not allowed' });

    if (m === 'POST') {
      if (a.role !== 'user') throw stRls();
      if (objParts.length < 2) throw stErr(400, 'InvalidKey', 'Invalid key');
      if (objParts[0] !== USER_ID) throw stRls(); // <uid> が本人以外 → 403
      const key = objParts.join('/');
      const body = await readBody(req, MAX_BODY_BYTES);
      const exists = Object.prototype.hasOwnProperty.call(photoIndex, key);
      if (exists && String(req.headers['x-upsert']).toLowerCase() === 'true') throw stRls(); // update 権限が無い＝上書き不可
      if (exists) throw new HttpError(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      let data = body, ctype = req.headers['content-type'] || 'application/octet-stream';
      if (/^multipart\/form-data/i.test(ctype)) {
        const part = parseMultipart(body, ctype);
        if (!part) throw stErr(400, 'InvalidRequest', 'Invalid multipart body');
        data = part.body; ctype = part.contentType || 'application/octet-stream';
      }
      fs.writeFileSync(photoFile(key), data);
      photoIndex[key] = { contentType: ctype, size: data.length, created_at: nowIso(), id: crypto.randomUUID() };
      savePhotos();
      return send(res, 200, { Id: photoIndex[key].id, Key: BUCKET + '/' + key });
    }
    if (m === 'PUT') throw stRls(); // update 権限なし
    if (m === 'DELETE') {
      if (a.role !== 'user') throw stRls();
      throw new HttpError(404, { statusCode: '404', error: 'not_found', message: 'Object not found' }); // delete 権限なし（RLS で見えない扱い）
    }
    throw new HttpError(405, { message: 'Method not allowed' });
  }

  // ---------------------------------------------------------------- 確認用 /_mock/*
  async function mockApi(req, res, url) {
    const p = url.pathname, m = req.method;
    if (p === '/_mock/health') return send(res, 200, { ok: true, items: items.size, seq: seqCounter, history: history.length, photos: Object.keys(photoIndex).length, tokenTtl: cfg.tokenTtl, maxRows: cfg.maxRows, dataDir: dir });
    if (p === '/_mock/config') return send(res, 200, { url: 'http://localhost:' + cfg.port, anonKey: ANON_KEY, email: TEST_EMAIL, userId: USER_ID });
    if (p === '/_mock/history') {
      const coll = url.searchParams.get('coll'), k = url.searchParams.get('k');
      return send(res, 200, history.filter((r) => (coll === null || r.coll === coll) && (k === null || r.k === k)));
    }
    if (p === '/_mock/dump') return send(res, 200, [...items.values()]);
    if (p === '/_mock/reset' && m === 'POST') { wipe(); loadAll(); loadMeta(); loadPhotos(); return send(res, 200, { ok: true }); }
    throw new HttpError(404, { message: 'no such mock endpoint' });
  }

  // ---------------------------------------------------------------- HTTP 共通
  function send(res, status, obj) { return sendRaw(res, status, JSON.stringify(obj), 'application/json; charset=utf-8'); }
  function sendRaw(res, status, text, type) {
    const b = Buffer.from(text, 'utf8');
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': b.length });
    res.end(b);
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > limit) { done = true; reject(new HttpError(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' })); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }
  async function readJson(req) {
    const buf = await readBody(req, MAX_BODY_BYTES);
    const t = buf.toString('utf8').trim();
    if (!t) return {};
    try { return JSON.parse(t); } catch (e) { throw new HttpError(400, { code: 'PGRST102', details: null, hint: null, message: 'Empty or invalid json' }); }
  }
  function setCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Type, Content-Length, ETag, Content-Location');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  async function handler(req, res) {
    const t0 = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
    if (!cfg.quiet) res.on('finish', () => console.log(new Date().toISOString().slice(11, 23) + ' ' + req.method + ' ' + url.pathname + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms'));
    setCors(req, res);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const p = url.pathname;
      if (p.startsWith('/_mock/')) return await mockApi(req, res, url);
      if (!(p.startsWith('/auth/v1/') || p.startsWith('/rest/v1/') || p.startsWith('/storage/v1/'))) {
        return send(res, 404, { message: 'no Route matched with those values' });
      }
      const apikey = req.headers['apikey'] || url.searchParams.get('apikey');
      if (!apikey) return send(res, 401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
      if (apikey !== ANON_KEY) return send(res, 401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
      if (p.startsWith('/auth/v1/')) return await authRoute(req, res, url);
      if (p.startsWith('/rest/v1/')) return await restRoute(req, res, url);
      return await storageRoute(req, res, url);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return send(res, e.status, e.body);
      console.error('内部エラー', e);
      return send(res, 500, { message: String((e && e.message) || e) });
    }
  }

  // ---------------------------------------------------------------- 待ち受け（既定は 127.0.0.1 と ::1 の両方）
  const servers = [];
  const hosts = cfg.host ? [cfg.host] : ['127.0.0.1', '::1'];
  const ready = Promise.all(hosts.map((h, idx) => new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => { handler(req, res); });
    s.on('error', (e) => {
      if (idx > 0 && !cfg.host) { console.warn('(' + h + ' は使えないのでスキップ: ' + e.code + ')'); resolve(false); return; }
      reject(e);
    });
    s.listen(cfg.port, h, () => { servers.push(s); resolve(true); });
  })));
  function close() { return Promise.all(servers.map((s) => new Promise((r) => { s.close(() => r()); if (s.closeAllConnections) s.closeAllConnections(); }))); }
  return { ready, close, cfg };
}

module.exports = { start, ANON_KEY, USER_ID, TEST_EMAIL, TEST_PASSWORD };

if (require.main === module) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error('引数エラー: ' + e.message); process.exit(2); }
  if (o.help) {
    console.log('使い方: node mock-supabase.js [--port 8787] [--token-ttl 60] [--reset] [--data-dir <dir>] [--host <addr>] [--max-rows 1000] [--quiet]');
    process.exit(0);
  }
  let srv;
  try { srv = start(o); } catch (e) { console.error('起動失敗: ' + e.message); process.exit(1); }
  srv.ready.then(() => {
    console.log('擬似 Supabase を起動: http://localhost:' + o.port + (o.reset ? '  (--reset: データを初期化)' : ''));
    console.log('  データ置き場 : ' + o.dataDir);
    console.log('  access_token 有効期限 : ' + o.tokenTtl + ' 秒 ／ pull_items 上限 : ' + o.maxRows + ' 行');
    console.log('  ログイン      : ' + TEST_EMAIL + ' / ' + TEST_PASSWORD);
    console.log('  anon key      : ' + ANON_KEY);
    console.log('  止めるには Ctrl+C');
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? 'ポート ' + o.port + ' は使用中です（別の擬似サーバーが動いていませんか）' : '起動失敗: ' + e.message);
    process.exit(1);
  });
  const bye = () => { srv.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
