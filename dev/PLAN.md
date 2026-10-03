# ヒビキ（日々記）／HIBIKI 自前クラウド版 — 実装計画（2026-10-03）

本人の決定：A（claude.ai ログインで全端末）＝完了。B（自前クラウド）＝作る。AI機能・Google カレンダーは後回し。独自ドメイン不要。
置き場：GitHub `yuai202211/hibiki`（公開・本人が作る）→ GitHub Pages `https://yuai202211.github.io/hibiki/`
データ：Supabase（本人がプロジェクトを作る。受け取るのは Project URL と anon/publishable キーだけ）

## 作る物（ファイル）
- `hibiki/index.html` … 旧 `10nen-nippo-home.html` から派生した単一HTML（CSTATE なし・個人データなし）
- `hibiki/sw.js` … Service Worker（index.html と写真のキャッシュ・オフライン起動）
- `hibiki/manifest.webmanifest` … PWA（名前 HIBIKI／ヒビキ、アイコン、standalone）
- `hibiki/icon-192.png` `icon-512.png` `apple-touch-icon.png` … 📔＋HIBIKI
- `hibiki/dev/setup.sql` … Supabase の表・関数・RLS・Storage（本人が SQL Editor に貼る）
- `hibiki/dev/mock-supabase.js` … 手元テスト用の擬似サーバー（node、8787）
- `hibiki/dev/scan-public.js` … 公開前の個人情報検査（push 前に必ず通す）
- `hibiki/dev/build.js` … 旧HTML → index.html を作る変換（CSTATE/SEED/DSEED 等を外し、クラウド版の差分を当てる）

## アプリ側の作り替え（旧の関数との対応）
| 旧 | 新 |
|---|---|
| `doPublish()`＝HTML全体を再公開→画面読み直し | `cloudPush()`＝変わった項目だけ RPC put_items。読み直し無し |
| `schedulePublish(ms)` | `scheduleSync(ms)`（デバウンス 1.5秒）。中身は push→pull |
| 起動 `boot()` の CSTATE 合流 | `cloudPullAll()`＝初回は全件（1000件×ページ）、以後は seq カーソルで差分。受信は mergeStates(state, 受信分) |
| `getAssets()/A.upload` | `cloudPhotoUpload(blob, assetId)`＝Storage `photos/<uid>/<assetId>` |
| `phUrl(id)` の `/_blob/<asset>` | 認証付き GET → blob → IndexedDB にキャッシュ → objectURL |
| `renderSync()` のランプ | 同じ。灰＝未ログイン／橙＝未送信あり／緑＝送信済み。タップでログイン画面 |
| `stashState/writeDraft/conflictHeal/maybePendingReload/payReopenMark` | 読み直しが無いので conflict 系は不要。writeDraft（書きかけ退避）は残す |

## 同期の規則（唯一の合流＝既存 mergeStates）
- 項目の単位＝`coll` と `k`：entries→`日付/キー`、plans→`日付/id`、ai・rules→`日付`、dreams/memos/pays/aims/moves/pins/steps/payrep/rtn/rlog/payppl/pha→id、dream/life/その他最上位→coll `_top`
- 送信：`dirty`（coll/k の集合・localStorage に永続化）。mutate/saveLocal で「直前の写し」と比べて変わった項目を dirty へ。1.5秒後に put_items。成功した分だけ dirty から外す
- 受信：`pull_items(since_seq)`。起動時／画面に戻った時／ネット復帰時／60秒ごと。受信行→ state の形へ戻して mergeStates
- 整合：起動時と設定画面で `integrity()`（coll ごとの件数・ts 合計）を端末と照合。ずれたら全件取り直し
- 空の端末の初回：全件 pull が終わるまで push しない（シードを新しい ts で書かない）。DSEED/DEF_DREAM/RTN_SEED 等のシードは ts:0 以下にするか、クラウドのデータに移す
- 端末時計：サーバー時刻より1時間以上先の ts は丸める（put_items 側）
- 写真：state.photos（dataURL）は端末だけ。pha[id]=assetId はクラウドへ

## ログイン（Supabase Auth・メール＋パスワード）
- 新規登録はアプリからは出さない（本人がダッシュボードの Authentication → Users → Add user で作る。Allow new users to sign up を OFF）
- ログイン画面：メール・パスワード・「表示」・ログイン。autocomplete=username/current-password
- セッションは localStorage に保存。access_token 期限切れ→refresh_token で自動更新。再ログインは端末ごとに1回
- パスワード忘れ：後回し（最終手段＝本人がダッシュボードで再設定）
- 未ログインでも記録はできる（端末に保存）。ランプ灰色

## 移行（記録を途切れさせない）
1. 旧アプリは切替まで無傷。本人は旧アプリで記録を続ける
2. 私：旧 Artifact の最新版を read → CSTATE から `state-baseline.json`（私の手元・公開しない）
3. 本人：新アプリにログイン → 設定「📥 JSON を取り込む」→ 送信（put_items を500件ずつ）→「クラウド N／端末 N ✓」
4. 写真：私が Artifact のアセットを `nippo10/photos-export/<assetId>` に保存（本人の許可）→ 本人が新アプリの「📦 写真をクラウドへ」でフォルダごと選ぶ → 本人のログインで Storage へ
5. 切替判定（全部✓）：件数一致／写真全枚読める／iPhone と PC で同じ／iPhone→PC 60秒で反映／機内モード→復帰で自動送信
6. 切替後：旧 Artifact に「新しい場所へ」の帯を1回だけ公開（本人承認後）。旧は消さない

## 公開前チェック（毎回）
- `node dev/scan-public.js index.html` が 0 で終わる（CSTATE 無し・禁止語無し・700KB 未満・鍵無し）
- push は本人の承認後

## 後回し
- AI機能（Edge Function に Anthropic キー・CORS 要）・Google カレンダー・パスワード再設定メール・外部バックアップ（GitHub Actions の pg_dump）・Cloudflare Pages への引っ越し
