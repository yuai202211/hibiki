-- =====================================================================
-- HIBIKI setup.sql の動作確認（SQL Editor に貼って Run するだけ）
-- ---------------------------------------------------------------------
-- * ロールは切り替えない。SQL Editor では auth.uid() が null なので、
--   JWT の claims を一時的に差し込んで「ログイン中の利用者」を真似る。
-- * 試験用の行はすべて「巻き戻し用の内側ブロック」で作り、最後に必ず巻き戻す。
--   本物のデータには触れない（backups の件数も増えない）。
-- * 結果は最後の表に出る。ok がすべて true なら成功。false の行の detail を見る。
-- * RLS そのもの（authenticated で他人の行が見えないこと）は、この方法では
--   postgres が RLS を素通りするので確かめられない。そこは関数の where user_id = auth.uid()
--   で分離している点と、下の権限・ポリシーの検査で見る。
-- =====================================================================

-- 利用者を真似る道具（未ログインにしたい時は null を渡す）。pg_temp なのでこの接続の間だけ存在する
create or replace function pg_temp.hb_login(uid text)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    case when uid is null then '' else json_build_object('sub', uid, 'role', 'authenticated')::text end,
    true   -- true = この取引の間だけ
  );
$$;

-- 結果を1件足す道具
create or replace function pg_temp.hb_add(res jsonb, nm text, passed boolean, note text default null)
returns jsonb
language sql
as $$
  select res || jsonb_build_array(
    jsonb_build_object('name', nm, 'ok', coalesce(passed, false), 'detail', note)
  );
$$;

create or replace function pg_temp.hb_run_tests()
returns table (step integer, check_name text, ok boolean, detail text)
language plpgsql
as $$
#variable_conflict use_column
declare
  ua     constant text := '00000000-0000-4000-8000-00000000000a';   -- 試験用の利用者A（実在しなくてよい）
  ub     constant text := '00000000-0000-4000-8000-00000000000b';   -- 試験用の利用者B
  base   constant bigint := 1700000000000;                          -- 2023-11 ごろ。過去なので丸められない
  res    jsonb := '[]'::jsonb;
  n_w    integer;
  v_ts   bigint;
  v_seq1 bigint;
  v_seq2 bigint;
  v_data jsonb;
  v_cnt  bigint;
  v_txt  text;
  v_id   bigint;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  raised boolean;
begin
  begin   -- ここから「巻き戻し用ブロック」。最後に必ず例外で巻き戻す

    -- 1. 未ログイン（auth.uid() が null）では3つの関数とも例外になる
    perform pg_temp.hb_login(null);
    raised := false;
    begin perform public.put_items('[]'::jsonb);   exception when sqlstate '28000' then raised := true; end;
    v_txt := case when raised then 'put_items:拒否' else 'put_items:通ってしまった' end;
    raised := false;
    begin perform * from public.pull_items(0, 10); exception when sqlstate '28000' then raised := true; end;
    v_txt := v_txt || ' / ' || case when raised then 'pull_items:拒否' else 'pull_items:通ってしまった' end;
    raised := false;
    begin perform * from public.integrity();       exception when sqlstate '28000' then raised := true; end;
    v_txt := v_txt || ' / ' || case when raised then 'integrity:拒否' else 'integrity:通ってしまった' end;
    res := pg_temp.hb_add(res, '未ログインは3関数とも拒否される', v_txt not like '%通ってしまった%', v_txt);

    -- 2. 利用者Aで4項目を書く
    perform pg_temp.hb_login(ua);
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','entries','k','2026-10-03/mood','ts',base,   'data',jsonb_build_object('v','good','ts',base)),
      jsonb_build_object('coll','plans',  'k','2026-10-03/p1',  'ts',base+1, 'data',jsonb_build_object('t','散歩','ts',base+1)),
      jsonb_build_object('coll','ai',     'k','2026-10-03',     'ts',base+2, 'data',jsonb_build_object('x',1,'ts',base+2)),
      jsonb_build_object('coll','_top',   'k','dream',          'ts',base+3, 'data',jsonb_build_object('title','夢','ts',base+3))
    ));
    res := pg_temp.hb_add(res, 'put_items: 4項目を新規で書くと 4 が返る', n_w = 4, '戻り値=' || coalesce(n_w::text, 'null'));

    -- 3. integrity: coll ごとの件数と ts 合計
    select count(*) into v_cnt from public.integrity();
    select i.tsum::bigint into v_ts from public.integrity() i where i.coll = 'entries';
    res := pg_temp.hb_add(res, 'integrity: 4つの coll が各1件で、entries の ts 合計が一致',
      v_cnt = 4 and v_ts = base, 'coll数=' || v_cnt || ' entries.tsum=' || coalesce(v_ts::text, 'null'));

    -- 4. pull_items: 全件・seq 昇順・カーソルで差分
    select count(*), max(p.seq) into v_cnt, v_seq1 from public.pull_items(0, 100) p;
    select count(distinct p.seq) into n_w from public.pull_items(0, 100) p;
    res := pg_temp.hb_add(res, 'pull_items: 全4件が返り、seq は全部ちがう', v_cnt = 4 and n_w = 4,
      '件数=' || v_cnt || ' seq種類=' || n_w);

    select count(*) into v_cnt from public.pull_items(v_seq1, 100);
    res := pg_temp.hb_add(res, 'pull_items: 最大 seq をカーソルにすると 0 件', v_cnt = 0, '件数=' || v_cnt);

    select count(*) into v_cnt from public.pull_items(0, 2);
    res := pg_temp.hb_add(res, 'pull_items: lim=2 なら 2 件で止まる', v_cnt = 2, '件数=' || v_cnt);

    -- 5. 古い ts では上書きされない
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','entries','k','2026-10-03/mood','ts',base-1,'data',jsonb_build_object('v','OLD','ts',base-1))
    ));
    select d.data into v_data from public.pull_items(0, 100) d where d.coll = 'entries' and d.k = '2026-10-03/mood';
    res := pg_temp.hb_add(res, '古い ts では上書きされない（0 が返り、中身は元のまま）',
      n_w = 0 and v_data->>'v' = 'good', '戻り値=' || n_w || ' v=' || coalesce(v_data->>'v', 'null'));

    -- 6. 新しい ts なら上書き。seq が進み、旧版が items_history に退避される
    select d.seq into v_seq1 from public.pull_items(0, 100) d where d.coll = 'entries' and d.k = '2026-10-03/mood';
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','entries','k','2026-10-03/mood','ts',base+100,'data',jsonb_build_object('v','new','ts',base+100))
    ));
    select d.seq, d.data into v_seq2, v_data from public.pull_items(0, 100) d where d.coll = 'entries' and d.k = '2026-10-03/mood';
    res := pg_temp.hb_add(res, '新しい ts なら上書きされ（1）、seq が進む',
      n_w = 1 and v_data->>'v' = 'new' and v_seq2 > v_seq1, '戻り値=' || n_w || ' seq ' || v_seq1 || ' -> ' || v_seq2);

    select count(*) into v_cnt from public.items_history h
     where h.user_id = ua::uuid and h.coll = 'entries' and h.k = '2026-10-03/mood' and h.data->>'v' = 'good';
    res := pg_temp.hb_add(res, '上書き前の旧版が items_history に1件退避された', v_cnt = 1, '件数=' || v_cnt);

    -- 7. 同じ ts・同じ中身は何もしない／同じ ts・違う中身は上書き（既存の ts <= 新しい ts）
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','entries','k','2026-10-03/mood','ts',base+100,'data',jsonb_build_object('ts',base+100,'v','new'))  -- キー順だけ違う同じ中身
    ));
    res := pg_temp.hb_add(res, '同じ ts・同じ中身（キー順だけ違う）は書かない（0）', n_w = 0, '戻り値=' || n_w);

    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','entries','k','2026-10-03/mood','ts',base+100,'data',jsonb_build_object('v','same-ts-diff','ts',base+100))
    ));
    res := pg_temp.hb_add(res, '同じ ts・違う中身は上書きする（1）', n_w = 1, '戻り値=' || n_w);

    -- 8. 未来の ts（+10時間）はサーバー時刻 +1時間 に丸められ、data.ts も同じ値になる
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','_top','k','clocktest','ts',now_ms + 36000000,
                         'data',jsonb_build_object('ts',now_ms + 36000000))
    ));
    select d.ts, d.data into v_ts, v_data from public.pull_items(0, 100) d where d.coll = '_top' and d.k = 'clocktest';
    res := pg_temp.hb_add(res, '未来の ts は サーバー時刻+1時間 に丸められる（data.ts も）',
      abs(v_ts - (now_ms + 3600000)) < 60000 and (v_data->>'ts')::bigint = v_ts,
      'ts-(now+1h)=' || (v_ts - (now_ms + 3600000)) || 'ms');

    -- 9. 同じバッチに同じキーが2件あっても落ちず、ts の新しい方が残る
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','memos','k','m1','ts',base+10,'data',jsonb_build_object('t','newer','ts',base+10)),
      jsonb_build_object('coll','memos','k','m1','ts',base+5, 'data',jsonb_build_object('t','older','ts',base+5))
    ));
    select d.data->>'t' into v_txt from public.pull_items(0, 100) d where d.coll = 'memos' and d.k = 'm1';
    res := pg_temp.hb_add(res, '同じバッチの重複キーは新しい方が残る', n_w = 1 and v_txt = 'newer',
      '戻り値=' || n_w || ' t=' || coalesce(v_txt, 'null'));

    -- 10. 墓石（del:1）も普通の行として書ける
    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','memos','k','m1','ts',base+20,'data',jsonb_build_object('del',1,'ts',base+20))
    ));
    select (d.data->>'del') into v_txt from public.pull_items(0, 100) d where d.coll = 'memos' and d.k = 'm1';
    res := pg_temp.hb_add(res, '墓石（del:1）で削除を表せる（行は残る）', n_w = 1 and v_txt = '1', '戻り値=' || n_w || ' del=' || coalesce(v_txt, 'null'));

    -- 11. 壊れた行（coll が無い／data が無い／ts が文字列）は全体を拒否する
    raised := false;
    begin
      perform public.put_items(jsonb_build_array(
        jsonb_build_object('coll','entries','k','ok-row','ts',base,'data',jsonb_build_object('a',1)),
        jsonb_build_object('k','no-coll','ts',base,'data',jsonb_build_object('a',1))
      ));
    exception when sqlstate '22023' then raised := true; end;
    select count(*) into v_cnt from public.pull_items(0, 100) d where d.k = 'ok-row';
    res := pg_temp.hb_add(res, '壊れた行が混じると全体を拒否（良い行も書かれない）', raised and v_cnt = 0,
      '拒否=' || raised || ' 良い行の件数=' || v_cnt);

    raised := false;
    begin
      perform public.put_items(jsonb_build_array(
        jsonb_build_object('coll','entries','k','str-ts','ts','1700000000000','data',jsonb_build_object('a',1))
      ));
    exception when sqlstate '22023' then raised := true; end;
    res := pg_temp.hb_add(res, 'ts が文字列の行は拒否される', raised, null);

    -- 12. 利用者の分離: Bには Aの行が見えず、Bが同じキーを書いてもAは変わらない
    perform pg_temp.hb_login(ub);
    select count(*) into v_cnt from public.pull_items(0, 100);
    select count(*) into n_w from public.integrity();
    res := pg_temp.hb_add(res, '利用者B には A の行が見えない（pull も integrity も 0）', v_cnt = 0 and n_w = 0,
      'pull=' || v_cnt || ' integrity行=' || n_w);

    n_w := public.put_items(jsonb_build_array(
      jsonb_build_object('coll','entries','k','2026-10-03/mood','ts',base+999,'data',jsonb_build_object('v','B-data','ts',base+999))
    ));
    perform pg_temp.hb_login(ua);
    select d.data->>'v' into v_txt from public.pull_items(0, 100) d where d.coll = 'entries' and d.k = '2026-10-03/mood';
    res := pg_temp.hb_add(res, 'B が同じキーを書いても A の中身は変わらない', n_w = 1 and v_txt = 'same-ts-diff',
      'B書込=' || n_w || ' Aの中身=' || coalesce(v_txt, 'null'));

    -- 13. 権限: 誰にも DELETE / TRUNCATE が無い。anon は items を読めない。authenticated は読み書きできる
    res := pg_temp.hb_add(res, '権限: authenticated / anon / service_role に DELETE も TRUNCATE も無い',
      not has_table_privilege('authenticated', 'public.items', 'DELETE')
      and not has_table_privilege('anon',          'public.items', 'DELETE')
      and not has_table_privilege('service_role',  'public.items', 'DELETE')
      and not has_table_privilege('authenticated', 'public.items', 'TRUNCATE')
      and not has_table_privilege('anon',          'public.items', 'TRUNCATE')
      and not has_table_privilege('service_role',  'public.items', 'TRUNCATE'), null);
    res := pg_temp.hb_add(res, '権限: anon は items を読めない／authenticated は読めて、書けるのは ts と data の列だけ',
      not has_table_privilege('anon', 'public.items', 'SELECT')
      and has_table_privilege('authenticated', 'public.items', 'SELECT')
      and has_column_privilege('authenticated', 'public.items', 'data', 'INSERT')
      and has_column_privilege('authenticated', 'public.items', 'data', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.items', 'user_id', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.items', 'seq', 'UPDATE'), null);
    res := pg_temp.hb_add(res, '権限: anon は RPC を呼べず、authenticated は呼べる',
      not has_function_privilege('anon', 'public.put_items(jsonb)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.put_items(jsonb)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.pull_items(bigint, integer)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.integrity()', 'EXECUTE'), null);
    res := pg_temp.hb_add(res, '権限: items_history と backups は利用者から見えない',
      not has_table_privilege('authenticated', 'public.items_history', 'SELECT')
      and not has_table_privilege('anon', 'public.items_history', 'SELECT')
      and not has_table_privilege('authenticated', 'public.backups', 'SELECT')
      and not has_table_privilege('anon', 'public.backups', 'SELECT'), null);

    -- 14. RLS が有効、delete ポリシーが無い
    select count(*) into v_cnt from pg_class c join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relname in ('items','items_history','backups') and c.relrowsecurity;
    select count(*) into n_w from pg_policies where schemaname = 'public' and tablename = 'items' and cmd in ('DELETE','ALL');
    res := pg_temp.hb_add(res, 'RLS: 3表とも有効で、items に DELETE/ALL のポリシーが無い', v_cnt = 3 and n_w = 0,
      'RLS有効=' || v_cnt || '/3 delete系ポリシー=' || n_w);

    -- 15. Storage: バケット photos が非公開で、ポリシーは select と insert だけ
    select count(*) into v_cnt from storage.buckets where id = 'photos' and public = false;
    select string_agg(p.cmd, ',' order by p.cmd) into v_txt
      from pg_policies p
     where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname like 'hibiki_photos_%';
    res := pg_temp.hb_add(res, 'Storage: photos は非公開で、HIBIKI のポリシーは INSERT と SELECT だけ',
      v_cnt = 1 and v_txt = 'INSERT,SELECT', 'bucket非公開=' || v_cnt || ' ポリシー=' || coalesce(v_txt, 'なし'));

    -- 16. バックアップ: take_backup が動き、件数が items と一致する（この試験の行も含む。後で巻き戻る）
    v_id := public.take_backup();
    select b.n_items into v_cnt from public.backups b where b.id = v_id;
    res := pg_temp.hb_add(res, 'take_backup: スナップショットの件数が items の全件と一致',
      v_cnt = (select count(*) from public.items), '件数=' || coalesce(v_cnt::text, 'null'));

    -- 17. （参考）pg_cron の日次ジョブ。無くても失敗にはしない
    if to_regclass('cron.job') is not null then
      execute 'select count(*) from cron.job where jobname = $1' into v_cnt using 'hibiki-daily-backup';
      res := pg_temp.hb_add(res, '（参考）pg_cron の日次ジョブ', true,
        case when v_cnt = 1 then '設定済み（毎日 03:00 JST）' else '未設定。pg_cron を有効にして setup.sql をもう一度流す' end);
    else
      res := pg_temp.hb_add(res, '（参考）pg_cron の日次ジョブ', true, 'pg_cron が無効なので自動バックアップは未設定（手動なら select public.take_backup();）');
    end if;

    -- ここで必ず巻き戻す（試験用の行・履歴・スナップショットをすべて消す）
    raise exception 'hibiki_test_rollback' using errcode = 'HB001';

  exception
    when sqlstate 'HB001' then
      null;   -- 期待どおりの巻き戻し
    when others then
      res := pg_temp.hb_add(res, '予期しないエラー（試験が途中で止まった）', false, sqlstate || ' ' || sqlerrm);
  end;

  return query
    select e.o::integer, e.x->>'name', (e.x->>'ok')::boolean, e.x->>'detail'
    from jsonb_array_elements(res) with ordinality as e(x, o)
    order by e.o;
end;
$$;

-- 結果表（最後の select だけが SQL Editor に表示される）
select * from pg_temp.hb_run_tests();
