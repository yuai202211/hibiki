# HIBIKI 日々記（ヒビキ）

日記・支払い・ルーティンを1つの画面で記録するアプリ。どの端末でも同じ記録が出て、続きが書ける。

- アプリ：https://yuai202211.github.io/hibiki/ （PWA。スマホは「ホーム画面に追加」）
- 単一の HTML（`index.html`）＋ Service Worker（`sw.js`）＋ `manifest.webmanifest`
- データとログイン：Supabase（Auth・Postgres・Storage）。アプリに入っているのは公開前提のキーだけ

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（生成物。直接編集しない） |
| `sw.js` | オフライン起動用。更新したら `VER` を上げる |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | PWA の名前とアイコン |
| `dev/cloud-layer.js` | クラウド同期（ログイン・1項目1行の送受信・写真・引っ越し） |
| `dev/setup.sql` / `dev/setup-test.sql` / `dev/SETUP.md` | Supabase の表・関数・権限・写真置き場 |
| `dev/mock-supabase.js` / `dev/mock-test.js` | 手元テスト用の擬似サーバー（`node dev/mock-supabase.js`） |
| `dev/scan-public.js` | 公開前の検査（個人情報・鍵・埋め込みデータが無いこと） |

## 同期の考え方

- 記録は 1 項目 1 行（`items` 表）。各項目は `ts`（ミリ秒）を持ち、**新しい方が勝つ**。削除は `del:1` の墓石で、行は物理削除しない（削除権限そのものを付けていない）
- 端末は先に localStorage へ保存し、変わった項目だけを 1.5 秒後にまとめて送る。受信は `seq` の差分
- 写真は Storage の非公開バケット（`photos/<uid>/<id>`）。端末には取り寄せて控える

## 配信

`main` ブランチの `/` を GitHub Pages で配信。push 前に必ず `node dev/scan-public.js index.html` を通す。
