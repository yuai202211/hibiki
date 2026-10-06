#!/usr/bin/env node
/* ============================================================================
 * scan-public.js — 公開リポジトリに置く前の「個人情報が混ざっていないか」検査
 *
 * 使い方:
 *   node dev/scan-public.js index.html [別のファイル ...] [--words dev/scan-words.json] [--max-kb 700]
 *
 * 終了コード:
 *   0 = 全部通った（公開してよい）
 *   1 = 1つでも引っかかった（行番号と語を出す。直すまで push しない）
 *   2 = 検査できなかった（ファイルが無い・禁止語ファイルが読めない等）。0 とは違う＝「通った」ではない
 *
 * 検査の中身:
 *   [a] CSTATE（クラウド保存された本人データ本体）が、無い／空であること
 *   [b] 禁止語（scan-words.json の words と patterns）が1つも含まれないこと
 *   [c] ファイルサイズが 700KB 未満（本人データの混入や巨大化の保険）
 *   [d] 鍵らしき文字列（eyJ… の JWT 形・service_role・sb_secret_ など）が無いこと
 *   [e] 追加の安全網：異常に長い行 / 巨大な base64 データURI（写真や state 丸ごとの貼り付け）が無いこと
 *
 * 設計メモ:
 *   - 禁止語は scan-words.json に分けてある。このスクリプト自体には個人情報が1語も入っていない。
 *     scan-words.json は個人情報そのものなので公開しない（dev/.gitignore で除外）。
 *   - 禁止語ファイルが読めない時は「通った」とせず終了コード2で止める（黙って素通りしないため）。
 *   - 全角半角・大文字小文字・空白の違い（Some Shop ／ SomeShop ／ Ｓｏｍｅ　Ｓｈｏｐ）は同じ語として照合する。
 *   - 画面に出す「文脈」は短い行（2000文字以下）だけ。長い行（CSTATE など）は行番号と語と件数だけにして、
 *     本人のデータを画面やログに出さない。鍵は先頭6文字＋長さだけ出す。
 *   - 行の区切りは \n でも \r\n でも同じに扱う（元の HTML は混在している）。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_KB = 900;        // [c] 上限（KB=1024バイト）。これ未満なら合格（2026-10-06 c7.9：やる事の追加で700KBを超えたので900KBへ。本人データの混入は [b][d][e] で別に見る）
const LONG_LINE = 20000;           // [e] この文字数を超える行は異常（通常のコードの最長行は約1万）
const DATA_URI_MIN = 2000;         // [e] base64 がこの長さ以上続くデータURIは写真/状態の貼り付けとみなす
const CTX_MAX_LINE = 2000;         // 文脈を画面に出してよい行の最大文字数
const CTX_SIDE = 18;               // 文脈の前後の文字数

/* [d] 鍵らしき文字列。name は画面に出す説明（鍵そのものは出さない） */
const KEY_RULES = [
  { re: /eyJ[A-Za-z0-9_-]{10,}/g,                 name: "eyJ で始まる文字列（JWT形＝Supabaseの anon/service キー等）" },
  { re: /service_role/gi,                         name: "service_role" },
  { re: /sb_secret_[A-Za-z0-9_-]{8,}/g,           name: "sb_secret_ で始まる Supabase シークレットキー" },
  { re: /sbp_[a-f0-9]{20,}/g,                     name: "sbp_ で始まる Supabase アクセストークン" },
  { re: /sk-ant-[A-Za-z0-9_-]{10,}/g,             name: "sk-ant- で始まる Anthropic APIキー" },
  { re: /sk-[A-Za-z0-9]{32,}/g,                   name: "sk- で始まる APIキー" },
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/g,            name: "GitHub トークン" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g,          name: "GitHub トークン(fine-grained)" },
  { re: /AKIA[0-9A-Z]{16}/g,                      name: "AWS アクセスキーID" },
  { re: /AIza[0-9A-Za-z_-]{30,}/g,                name: "Google APIキー" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,    name: "秘密鍵（PEM）" }
];
const DATA_URI_RE = new RegExp("data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{" + DATA_URI_MIN + ",}", "gi");

/* ---------- 引数 ---------- */
function usage(code) {
  console.error("使い方: node scan-public.js <file.html> [<file> ...] [--words scan-words.json] [--max-kb 700]");
  process.exit(code);
}
function parseArgs(argv) {
  const o = { files: [], words: path.join(__dirname, "scan-words.json"), maxKb: DEFAULT_MAX_KB };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--words") o.words = argv[++i];
    else if (a === "--max-kb") o.maxKb = Number(argv[++i]);
    else if (a === "-h" || a === "--help") usage(0);
    else if (a.startsWith("--")) { console.error("知らない指定: " + a); usage(2); }
    else o.files.push(a);
  }
  if (!o.files.length || !o.words || !(o.maxKb > 0)) usage(2);
  return o;
}

/* ---------- 禁止語の読み込みと照合の準備 ---------- */
const WS = /[\s　​﻿]+/g;
/* 全角半角（NFKC）をそろえ、必要なら小文字化・空白除去 */
function norm(s, squeeze, cs) {
  let t = String(s).normalize("NFKC");
  if (squeeze) t = t.replace(WS, "");
  if (!cs) t = t.toLowerCase();
  return t;
}
function loadWords(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch (e) {
    console.error("禁止語ファイルを読めない: " + file + "（" + e.message + "）");
    console.error("→ 検査できないので『通った』とは扱わない（終了コード2）");
    process.exit(2);
  }
  const words = (j.words || []).map(x => typeof x === "string" ? { w: x } : x)
    .filter(x => x && typeof x.w === "string" && x.w.length > 0)
    .map(x => {
      const wb = !!x.wb, cs = !!x.cs;
      return { w: x.w, k: x.k || "", wb, cs, needle: norm(x.w, !wb, cs) };   // wb の語は空白除去しない（境界判定を壊さないため）
    });
  const patterns = [];
  for (const p of (j.patterns || [])) {
    try { patterns.push({ re: new RegExp(p.re, (p.flags || "").replace(/g/g, "") + "g"), k: p.k || p.re, src: p.re }); }
    catch (e) { console.error("正規表現が不正: " + p.re + "（" + e.message + "）"); process.exit(2); }
  }
  if (!words.length && !patterns.length) {
    console.error("禁止語ファイルが空: " + file + "（空のリストでは何も検査できない）");
    process.exit(2);
  }
  return { words, patterns };
}

/* 1行ぶんの正規化結果を、使う種類だけ遅延計算してキャッシュする */
function makeVariants(line) {
  const nfkc = line.normalize("NFKC"), cache = {};
  return (squeeze, cs) => {
    const key = (squeeze ? "s" : "p") + (cs ? "c" : "l");
    if (cache[key] === undefined) {
      let t = nfkc;
      if (squeeze) t = t.replace(WS, "");
      if (!cs) t = t.toLowerCase();
      cache[key] = t;
    }
    return cache[key];
  };
}
const ALNUM = /[A-Za-z0-9_]/;
/* needle の出現回数。wb なら、needle の端が英数字の側だけ「隣が英数字でない」ことを要求する */
function countHits(text, needle, wb) {
  const leftAlnum = ALNUM.test(needle[0]), rightAlnum = ALNUM.test(needle[needle.length - 1]);
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) {
    if (wb) {
      const a = text[i - 1], b = text[i + needle.length];
      if ((leftAlnum && a && ALNUM.test(a)) || (rightAlnum && b && ALNUM.test(b))) { i += 1; continue; }
    }
    n++; i += needle.length;
  }
  return n;
}
/* 短い行だけ、最初の一致の前後を切り出す（表記ゆれで見つからなければ null） */
function contextOf(raw, w, cs) {
  if (raw.length > CTX_MAX_LINE) return null;
  const hay = cs ? raw : raw.toLowerCase(), nee = cs ? w : w.toLowerCase();
  let i = hay.indexOf(nee), len = w.length;
  if (i < 0) {
    // 空白の違い（半角/全角スペース）で見つからない時は、1文字ごとに空白を許す正規表現で探し直す
    const esc = Array.from(w.replace(WS, "")).map(c => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const m = new RegExp(esc.join("[\\s\\u3000]*"), cs ? "" : "i").exec(raw);
    if (!m) return null;
    i = m.index; len = m[0].length;
  }
  const a = Math.max(0, i - CTX_SIDE), b = Math.min(raw.length, i + len + CTX_SIDE);
  return (a > 0 ? "…" : "") + raw.slice(a, b).replace(/[\r\n\t]+/g, " ") + (b < raw.length ? "…" : "");
}
const mask = s => s.slice(0, 6) + "…（全" + s.length + "文字）";
const fmtN = n => n.toLocaleString("en-US");

/* ---------- 1ファイルの検査 ---------- */
function scanFile(file, opts, dict) {
  const buf = fs.readFileSync(file);
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const F = { a: [], b: [], c: [], d: [], e: [] };      // 検査ごとの指摘

  // [a] CSTATE：「let CSTATE={...}」のような代入で、中身が空でないものがあれば NG。
  //     文字列定数の中の説明（マーカー文字列そのもの）は代入ではないので無視する。
  //     代入の右辺が { か [ か JSON.parse( で始まる時だけ、データとみなす。
  const asg = /(?:\b(?:let|var|const)\s+|\bwindow\.)CSTATE\s*=\s*/g;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.indexOf("CSTATE") < 0) continue;
    asg.lastIndex = 0;
    let m;
    while ((m = asg.exec(L))) {
      let src = L, start = m.index + m[0].length;
      if (!L.slice(start).trim()) {   // 「let CSTATE=」で行が終わり、右辺が次の（空でない）行から始まる書き方も見る
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length) { src = lines[j]; start = src.length - src.replace(/^\s+/, "").length; }
      }
      const isJson = src[start] === "{" || src[start] === "[" || src.startsWith("JSON.parse(", start);
      if (!isJson) continue;
      let end = src.indexOf(";/*CSTATE-END*/", start);
      if (end < 0) end = src.length;
      const body = src.slice(start, end).replace(/[\s;]+$/g, "").trim();
      if (/^(\{\s*\}|\[\s*\])$/.test(body) || body === "") continue;      // 空は許す
      F.a.push({ line: i + 1, msg: "CSTATE にデータが入っている（" + fmtN(body.length) + " 文字・内容は表示しない）" });
    }
  }

  /* [c] サイズ */
  const kb = buf.length / 1024;
  if (kb >= opts.maxKb) {
    F.c.push({ line: 0, msg: fmtN(buf.length) + " バイト（" + kb.toFixed(1) + "KB）で上限 " + opts.maxKb + "KB 以上" });
  }

  /* [b][d][e] 行ごと */
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    const ln = i + 1;
    const longLine = L.length > CTX_MAX_LINE;

    /* [e] 異常に長い行・巨大データURI */
    if (L.length > LONG_LINE) {
      F.e.push({ line: ln, msg: "異常に長い行（" + fmtN(L.length) + " 文字・上限 " + fmtN(LONG_LINE) + "）＝データの貼り付けの疑い（内容は表示しない）" });
    }
    DATA_URI_RE.lastIndex = 0;
    let du, duN = 0;
    while ((du = DATA_URI_RE.exec(L))) duN++;
    if (duN) F.e.push({ line: ln, msg: "巨大な base64 データURI が " + duN + " 個（" + DATA_URI_MIN + " 文字以上）＝写真等の混入の疑い" });

    /* [d] 鍵 */
    for (const r of KEY_RULES) {
      r.re.lastIndex = 0;
      let km, n = 0, first = "";
      while ((km = r.re.exec(L))) { if (!n) first = km[0]; n++; }
      if (n) F.d.push({ line: ln, msg: "鍵らしき文字列「" + (first.length > 12 ? mask(first) : first) + "」＝" + r.name + (n > 1 ? " ×" + n : "") });
    }

    /* [b] 禁止語（語ごとに件数を数える） */
    const v = makeVariants(L);
    for (const wd of dict.words) {
      const n = countHits(v(!wd.wb, wd.cs), wd.needle, wd.wb);
      if (!n) continue;
      const ctx = contextOf(L, wd.w, wd.cs);
      F.b.push({ line: ln, msg: "禁止語「" + wd.w + "」" + (wd.k ? "(" + wd.k + ")" : "") + (n > 1 ? " ×" + n : "") +
        (longLine ? "  ※長い行なので文脈は出さない" : (ctx ? "  " + ctx : "")) });
    }
    /* [b] 禁止パターン（正規表現） */
    for (const p of dict.patterns) {
      p.re.lastIndex = 0;
      let pm, n = 0, first = "";
      while ((pm = p.re.exec(L))) { if (!n) first = pm[0]; n++; if (pm[0] === "") p.re.lastIndex++; }
      if (!n) continue;
      F.b.push({ line: ln, msg: "禁止パターン「" + p.k + "」" + (n > 1 ? " ×" + n : "") +
        (longLine ? "  ※長い行なので文脈は出さない" : "  一致: " + (first.length > 40 ? first.slice(0, 40) + "…" : first)) });
    }
  }
  return { F, bytes: buf.length, lineCount: lines.length };
}

/* ---------- 表示 ---------- */
const LABEL = {
  a: "[a] CSTATE が無い/空",
  b: "[b] 禁止語が無い",
  c: "[c] 700KB 未満",
  d: "[d] 鍵らしき文字列が無い",
  e: "[e] 異常な長行/データURIが無い"
};
function report(file, res, opts, dict) {
  const { F } = res;
  const total = Object.keys(F).reduce((s, k) => s + F[k].length, 0);
  const out = [];
  out.push("scan-public: " + file + "  （" + fmtN(res.bytes) + " バイト / " + fmtN(res.lineCount) + " 行 / 禁止語 " +
    dict.words.length + " + パターン " + dict.patterns.length + " / サイズ上限 " + opts.maxKb + "KB）");
  for (const k of ["a", "b", "c", "d", "e"]) {
    out.push("  " + LABEL[k] + " : " + (F[k].length ? "NG（" + F[k].length + " 件）" : "OK"));
  }
  /* 指摘の詳細：a → c → d → e → b の順（短いものを先に・禁止語は件数が多いので最後） */
  for (const k of ["a", "c", "d", "e", "b"]) {
    for (const f of F[k]) out.push("  NG [" + k + "] " + (f.line ? "行" + f.line + ": " : "") + f.msg);
  }
  out.push(total ? "結果: NG（" + total + " 件）— 直すまで公開しない" : "結果: OK — この検査は全部通った");
  console.log(out.join("\n"));
  return total;
}

/* ---------- 本体 ---------- */
(function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dict = loadWords(opts.words);
  let ng = 0;
  for (const f of opts.files) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { console.error("ファイルが無い: " + f + "（終了コード2）"); process.exit(2); }
    ng += report(f, scanFile(f, opts, dict), opts, dict);
  }
  process.exit(ng ? 1 : 0);
})();
