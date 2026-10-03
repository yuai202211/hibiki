-- =====================================================================
-- ヒビキ（日々記）／HIBIKI  Supabase セットアップ SQL
-- ---------------------------------------------------------------------
-- 使い方: Supabase ダッシュボード → SQL Editor → New query に、このファイルを
--         全部貼って Run（1回でよい。何度流しても壊れない）。
--         「破壊的な操作を含む」と警告が出るのは drop policy / drop trigger のため。
--         表のデータは消さないので Run this query でよい。
-- 対象  : Supabase（Postgres 15 系）。SQL Editor は postgres ロールで実行される。
--
-- 設計（決定済み）
--   * データは state 丸ごとではなく「1項目1行」で items 表に持つ。
--       items(user_id, coll, k, ts, data jsonb, seq)  主キー (user_id, coll, k)
--       coll/k の例  entries -> k='日付/キー'  plans -> k='日付/id'
--                    ai・rules -> k='日付'     dreams 等 -> k='id'
--                    dream・life・その他の最上位 -> coll='_top', k=項目名
--   * 削除は data に del:1 を入れた「墓石」を上書きで書く。行は消さない。
--   * DELETE / TRUNCATE は anon・authenticated・service_role の誰にも付けない。
--     （消せるのは SQL Editor の postgres＝オーナーだけ。事故防止の最後の砦）
--   * 上書き前の旧版は items_history に trigger で自動退避する。
--   * seq は全行共通のシーケンス。行が書かれるたびに trigger が振り直す。
--     端末は「seq > カーソル」で差分だけ取る。
--   * 書き込みは RPC put_items 経由だけ（表への直接 insert/update は RLS で自分の行に限る）。
--
-- アプリから呼ぶ関数（PostgREST: POST /rest/v1/rpc/<name>、本文は JSON）
--   put_items  {"rows":[{"coll":"entries","k":"2026-10-03/mood","ts":1790000000000,"data":{...}}, ...]}
--                -> 整数。実際に書いた行数（新規＋上書き）。
--                1回の最大は 5000 行（500 行ずつを推奨）。形が壊れた行が1つでもあれば全体を拒否。
--                既存の ts <= 新しい ts かつ中身が違う時だけ上書き。古い ts は黙って無視（戻り値に数えない）。
--                ts がサーバー時刻 +1時間 を超える物は丸める（data.ts が数値で同様に超えていれば data.ts も丸める）。
--                ts は小数なら切り捨て、負なら 0 に丸めて受け付ける（拒否はしない）。
--                同じバッチに同じ (coll,k) が複数あれば ts が最大の1件だけを使う（同点なら後ろの行）。戻り値もその上での数。
--                エラー: rows が配列でない・行の形が壊れている → 22023 ／ 5000 行超 → 54000 ／ 未ログイン → 28000。
--                文字列（キー名も）に \u0000 を含むと jsonb に入らず 22P05 でバッチ全体が失敗する。
--                  → クライアントは送る前に \u0000 を除くこと（残すと同じバッチを永久に再送して詰まる）。
--                1バッチ内の seq の順は送った順ではなく (coll,k) の並び順（DB の照合順）。順序を当てにしない。
--   pull_items {"since_seq":0,"lim":1000}
--                -> [{coll,k,ts,data,seq}, ...] を seq 昇順。lim は 1〜5000 に丸める（0 や負は 1、null は 1000）。
--                since_seq・lim とも省略可（既定 0 と 1000）。since_seq が null や負なら 0 扱い。
--                次のカーソル = 受け取った最後の行の seq。0件ならカーソルはそのまま。
--                注意: Supabase の API は既定で 1回の応答を 1000 行で切る（Dashboard → Settings → API の Max rows）。
--                  lim=5000 を頼んでも 1000 行しか返らないことがある。「返った件数 < lim なら終わり」と判定せず、
--                  「0 件が返るまで回す」か「lim を 1000 以下にして、返った件数 < lim で終わり」とすること。
--                seq は欠番が出る（insert の試行と update でそれぞれ番号を消費する）。連番を仮定しないこと。
--   integrity  {}
--                -> [{coll,n,tsum}, ...]。coll ごとの行数（墓石を含む）と ts の合計。coll の並びはコード順（collate "C"）。
--                注意: tsum は numeric。ts は約 1.8e12 なので約 5000 行を超えると合計が
--                JavaScript の Number の安全範囲（2^53 約 9.0e15）を超える。
--                クライアントは応答を文字列のまま読み、BigInt で足して比べること。
--                サーバーは ts を 0 以上・整数・+1時間以内に丸めて持つので、端末側の ts がそれを外れる項目
--                （負・小数・未来すぎ）があると、端末の合計とずれ続ける。比べる前に同じ丸めを端末側にも当てること。
--
-- 想定外の事態への備え
--   * seq の取りこぼし防止: put_items は利用者ごとの advisory lock を取って書くので、
--     同じ利用者の書き込みは直列になり、seq の大小順 = コミット順になる。
--     （それでもクライアントは受信時に重複を許す＝mergeStates は冪等なので安全）
--   * 履歴 items_history は SQL Editor から見る（アプリには出さない）。
--     溜まりすぎたら SQL Editor で古い物を消せる（例は末尾のコメント）。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. items（本体）と seq 用シーケンス
-- ---------------------------------------------------------------------
create sequence if not exists public.items_seq as bigint;

create table if not exists public.items (
  -- auth.users への外部キーは張らない。ダッシュボードで利用者を誤って消しても
  -- データが道連れで消えないようにするため（行は残る）。
  user_id uuid   not null default auth.uid(),
  coll    text   not null,
  k       text   not null,
  ts      bigint not null,                -- 項目の更新時刻（ミリ秒）。合流の勝ち負けはこれで決める
  data    jsonb  not null,                -- 項目の中身。削除は {"del":1, ...} の墓石
  seq     bigint not null,                -- trigger が必ず振り直す（default は置かない）
  constraint items_pkey            primary key (user_id, coll, k),
  constraint items_coll_k_nonempty check (coll <> '' and k <> ''),
  constraint items_ts_nonneg       check (ts >= 0)
);

-- 差分取得（seq > カーソル）用
create index if not exists items_user_seq_idx on public.items (user_id, seq);

comment on table public.items is 'HIBIKI 本体。1項目1行。user_id×coll×k が主キー。削除は墓石（del:1）で表す';


-- ---------------------------------------------------------------------
-- 2. items_history（上書き前の旧版を退避する）
-- ---------------------------------------------------------------------
create table if not exists public.items_history (
  id       bigint generated always as identity primary key,
  user_id  uuid        not null,
  coll     text        not null,
  k        text        not null,
  ts       bigint      not null,
  data     jsonb       not null,
  seq      bigint      not null,
  saved_at timestamptz not null default now()    -- 退避した時刻
);

create index if not exists items_history_key_idx
  on public.items_history (user_id, coll, k, saved_at desc);

comment on table public.items_history is 'items を上書きする直前の旧版。SQL Editor から復元に使う。アプリからは見えない';


-- ---------------------------------------------------------------------
-- 3. trigger（seq の振り直し／旧版の退避）
--    どちらも security definer: 呼び出した利用者にシーケンスや履歴表の権限を
--    渡さずに済ませるため。search_path は固定する。
-- ---------------------------------------------------------------------
create or replace function public.items_set_seq()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.seq := nextval('public.items_seq');   -- 利用者が seq を偽装できないよう、常に上書き
  return new;
end;
$$;

create or replace function public.items_save_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.items_history (user_id, coll, k, ts, data, seq)
  values (old.user_id, old.coll, old.k, old.ts, old.data, old.seq);
  return null;   -- AFTER trigger なので戻り値は使われない
end;
$$;

-- trigger 関数は trigger からしか呼ばない（RPC として公開しない）
revoke all on function public.items_set_seq()       from public, anon, authenticated;
revoke all on function public.items_save_history()  from public, anon, authenticated;

-- create trigger には if not exists が無い（PG15）ので drop してから作る
drop trigger if exists items_set_seq_trg on public.items;
create trigger items_set_seq_trg
  before insert or update on public.items
  for each row execute function public.items_set_seq();

drop trigger if exists items_save_history_trg on public.items;
create trigger items_save_history_trg
  after update on public.items
  for each row
  when (old.data is distinct from new.data or old.ts is distinct from new.ts)
  execute function public.items_save_history();


-- ---------------------------------------------------------------------
-- 4. 権限と RLS
--    * authenticated: items は select / insert、update は ts と data の列だけ。
--      （user_id・coll・k・seq を直接書き換えさせない）
--    * DELETE / TRUNCATE は誰にも付けない（service_role からも外す）
--    * items_history / backups は利用者から一切見えない（RLS 有効＋ポリシー無し＋権限無し）
-- ---------------------------------------------------------------------
revoke all on table public.items from public, anon, authenticated;
grant select on table public.items to authenticated;
grant insert (user_id, coll, k, ts, data) on table public.items to authenticated;
grant update (ts, data) on table public.items to authenticated;

-- 明示（上の revoke all で消えているが、読む人に意図が伝わるよう残す）
revoke delete, truncate on table public.items from public, anon, authenticated, service_role;

revoke all on table public.items_history from public, anon, authenticated;
revoke delete, truncate on table public.items_history from service_role;

revoke all on sequence public.items_seq from public, anon, authenticated;

alter table public.items         enable row level security;
alter table public.items_history enable row level security;

-- create policy には if not exists が無い（PG15）ので drop してから作る
drop policy if exists items_select_own on public.items;
create policy items_select_own on public.items
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists items_insert_own on public.items;
create policy items_insert_own on public.items
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists items_update_own on public.items;
create policy items_update_own on public.items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- delete 用のポリシーは作らない（作らない＝誰も消せない）
-- items_history にもポリシーは作らない（SQL Editor の postgres だけが読める）


-- ---------------------------------------------------------------------
-- 5. RPC: put_items（書き込み）
--    security invoker（呼んだ人の権限＋RLS で動く）。auth.uid() が null なら例外。
-- ---------------------------------------------------------------------
create or replace function public.put_items(rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  uid    uuid   := auth.uid();
  max_ts bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint + 3600000; -- サーバー時刻 +1時間
  n      integer;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if rows is null or jsonb_typeof(rows) <> 'array' then
    raise exception 'rows must be a JSON array' using errcode = '22023';
  end if;

  if jsonb_array_length(rows) = 0 then
    return 0;
  end if;

  if jsonb_array_length(rows) > 5000 then
    raise exception 'too many rows (max 5000 per call)' using errcode = '54000';
  end if;

  -- 形の検査: 1行でも壊れていれば全体を拒否（黙って一部だけ落とさない）
  if exists (
    select 1
    from jsonb_array_elements(rows) as e(r)
    where jsonb_typeof(e.r)          is distinct from 'object'
       or jsonb_typeof(e.r->'coll')  is distinct from 'string'
       or jsonb_typeof(e.r->'k')     is distinct from 'string'
       or coalesce(e.r->>'coll', '') = ''
       or coalesce(e.r->>'k', '')    = ''
       or jsonb_typeof(e.r->'ts')    is distinct from 'number'
       or e.r->'data' is null
       or jsonb_typeof(e.r->'data')  = 'null'
  ) then
    raise exception 'invalid row: each row needs string coll, string k, numeric ts, non-null data'
      using errcode = '22023';
  end if;

  -- 同じ利用者の書き込みを直列にする（seq の大小順 = コミット順にして取りこぼしを防ぐ）
  perform pg_advisory_xact_lock(hashtextextended('hibiki:' || uid::text, 0));

  with parsed as (
    select
      e.ord,
      e.r->>'coll' as coll,
      e.r->>'k'    as k,
      -- 0 以上、サーバー時刻 +1時間 以下に丸める。小数が来ても切り捨てて整数にする
      greatest(0, least(floor((e.r->>'ts')::numeric), max_ts::numeric))::bigint as ts,
      -- data 自身が数値の ts を持ち、それが上限超えなら data.ts も上限に丸める
      case
        when jsonb_typeof(e.r->'data') = 'object'
         and jsonb_typeof(e.r->'data'->'ts') = 'number'
         and (e.r->'data'->>'ts')::numeric > max_ts
        then jsonb_set(e.r->'data', '{ts}', to_jsonb(max_ts))
        else e.r->'data'
      end as data
    from jsonb_array_elements(rows) with ordinality as e(r, ord)
  ),
  dedup as (
    -- 同じバッチ内の重複は ts が最大の1件（同点なら後ろの行）。
    -- ON CONFLICT は同じ行を1文で2回触れないため、ここで1件に絞る
    select distinct on (p.coll, p.k) p.coll, p.k, p.ts, p.data
    from parsed p
    order by p.coll, p.k, p.ts desc, p.ord desc
  )
  insert into public.items as t (user_id, coll, k, ts, data)
  select uid, d.coll, d.k, d.ts, d.data
  from dedup d
  on conflict (user_id, coll, k) do update
    set ts   = excluded.ts,
        data = excluded.data
    where t.ts <= excluded.ts                      -- 古い版では上書きしない
      and t.data is distinct from excluded.data;   -- 中身が同じなら何もしない（seq を無駄に進めない）

  get diagnostics n = row_count;
  return n;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. RPC: pull_items（差分読み取り）／ integrity（整合確認）
--    返す列を変える再実行でも通るよう、drop してから作る
-- ---------------------------------------------------------------------
drop function if exists public.pull_items(bigint, integer);
create function public.pull_items(since_seq bigint default 0, lim integer default 1000)
returns table (coll text, k text, ts bigint, data jsonb, seq bigint)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  return query
    select i.coll, i.k, i.ts, i.data, i.seq
    from public.items i
    where i.user_id = uid
      and i.seq > coalesce(since_seq, 0)
    order by i.seq
    limit least(greatest(coalesce(lim, 1000), 1), 5000);
end;
$$;

drop function if exists public.integrity();
create function public.integrity()
returns table (coll text, n bigint, tsum numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  return query
    select i.coll, count(*)::bigint, coalesce(sum(i.ts), 0)::numeric
    from public.items i
    where i.user_id = uid
    group by i.coll
    order by i.coll collate "C";   -- DB の照合順（en_US では '_top' が末尾近くに来る）に左右されないようコード順に固定
end;
$$;

-- 公開範囲: ログイン済み（authenticated）だけが呼べる。anon（未ログイン）には出さない
revoke all on function public.put_items(jsonb)            from public, anon;
revoke all on function public.pull_items(bigint, integer) from public, anon;
revoke all on function public.integrity()                 from public, anon;
grant execute on function public.put_items(jsonb)            to authenticated;
grant execute on function public.pull_items(bigint, integer) to authenticated;
grant execute on function public.integrity()                 to authenticated;


-- ---------------------------------------------------------------------
-- 7. backups（毎日の全件スナップショット）
--    利用者からは見えない。SQL Editor（postgres）から読む。
--    直近 14 件だけ残す（無料枠の容量を食いつぶさないため）。
-- ---------------------------------------------------------------------
create table if not exists public.backups (
  id       bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  n_items  bigint      not null,
  snapshot jsonb       not null      -- items の全行（全利用者分）を to_jsonb した配列
);

alter table public.backups enable row level security;
revoke all on table public.backups from public, anon, authenticated;
-- 古い世代の掃除（delete）は下の take_backup が postgres 権限で行う。
-- backups は items と違い「消えても毎日作り直せる」ので、service_role の delete は外さない。

comment on table public.backups is 'items の毎日の全件スナップショット（pg_cron が使える時だけ自動）。復元は末尾のコメント参照';

create or replace function public.take_backup()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_id bigint;
begin
  insert into public.backups (n_items, snapshot)
  select count(*), coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
  from public.items i
  returning id into new_id;

  -- 直近 14 件より古い世代を消す
  delete from public.backups b
  where b.id not in (select x.id from public.backups x order by x.id desc limit 14);

  return new_id;
end;
$$;

-- 利用者（anon/authenticated）からは呼べない。cron と SQL Editor だけが呼ぶ
revoke all on function public.take_backup() from public, anon, authenticated;

-- pg_cron が使える時だけ毎日 03:00 JST（= 18:00 UTC）に実行する。
-- 使えない環境では失敗せず、お知らせを出して飛ばす。
-- あとで Dashboard → Integrations → Cron で pg_cron を有効にして、この SQL をもう一度流せば設定される。
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when others then
      raise notice '[HIBIKI] pg_cron を有効にできなかったので、毎日のスナップショットは飛ばします（理由: %）', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      -- 同名ジョブは上書きされる（何度流しても1本だけ）。cron スキーマが無い環境でも静的に解決しないよう execute にする
      execute $cmd$select cron.schedule('hibiki-daily-backup', '0 18 * * *', 'select public.take_backup()')$cmd$;
      raise notice '[HIBIKI] 毎日 03:00 JST のスナップショットを設定しました（hibiki-daily-backup）';
    exception when others then
      raise notice '[HIBIKI] pg_cron のジョブ登録に失敗したので飛ばします（理由: %）', sqlerrm;
    end;
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. Storage: 写真の非公開バケット photos
--    置き場所は <uid>/<assetId>。select と insert だけ許す（update・delete は無し＝上書き・削除不可）。
--    同じ assetId をもう一度アップロードすると 409（重複）になる。クライアントは「済み」として扱ってよい。
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do update set public = false;

-- storage.objects は Supabase 側で RLS 有効済み。ポリシーだけ置く
drop policy if exists hibiki_photos_select on storage.objects;
create policy hibiki_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists hibiki_photos_insert on storage.objects;
create policy hibiki_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- update / delete のポリシーは作らない


-- ---------------------------------------------------------------------
-- 9. 仕上げ: API のスキーマキャッシュを更新し、結果を1行返す
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';

select
  'HIBIKI setup 完了' as result,
  (select count(*) from public.items) as items_rows,
  exists (select 1 from pg_extension where extname = 'pg_cron') as pg_cron_enabled,
  (select count(*) from storage.buckets where id = 'photos' and public = false) as photos_bucket_private;


-- =====================================================================
-- 運用メモ（コメント。必要になった時に SQL Editor へ貼る）
-- ---------------------------------------------------------------------
-- ■ 1項目を旧版へ戻す（例）
--   select ts, data, saved_at from public.items_history
--    where user_id = '<uid>' and coll = 'entries' and k = '2026-10-03/mood'
--    order by saved_at desc;
--   -- 戻したい版の data を items.data に update する（ts は今の ts より大きくしないと端末が採用しない）
--
-- ■ 履歴が溜まりすぎた時（90日より古い履歴を掃除）
--   delete from public.items_history where saved_at < now() - interval '90 days';
--
-- ■ スナップショットから items を丸ごと戻す（最悪の時だけ。items を空にしてから）
--   insert into public.items (user_id, coll, k, ts, data, seq)
--   select (x->>'user_id')::uuid, x->>'coll', x->>'k', (x->>'ts')::bigint, x->'data', 0
--   from public.backups b, jsonb_array_elements(b.snapshot) x
--   where b.id = (select max(id) from public.backups);
--   -- seq は trigger が振り直すので 0 でよい（端末は全件取り直す）
-- =====================================================================
