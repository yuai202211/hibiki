# HIBIKI（ヒビキ）Supabase セットアップ（本人が貼る手順）

1. Supabase の SQL Editor → New query に `setup.sql` を全部貼って Run（「破壊的」警告は Run this query でOK・何度でも安全）
2. もう1つ New query に `setup-test.sql` を貼って Run → 表の `ok` が全部 `true` ならOK
3. Authentication → Users → Add user で自分のメール＋パスワードを作り（Auto Confirm にチェック）、Project Settings → API の Project URL と anon（publishable）キーだけを AI に渡す（秘密の方のキーは渡さない）

補足（任意）: 3 のあと Authentication → Sign In / Providers の Email で「Allow new users to sign up」を OFF にすると、知らない人が登録できなくなる。
