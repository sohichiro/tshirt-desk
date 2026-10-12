# Tシャツ受付ページ

当日、受付でスピーカー・スタッフの Luma の QR を読み、Tシャツのサイズを大きく出すページ。
2026-10-09 に読み取りだけの試作、2026-10-12 にサイズを引く本実装。同日、**ページ本体を GitHub Pages に置く構成**に変えた
（GAS の iframe の中ではカメラが使えないため。下記）。

- ページ（GitHub Pages）: `https://sohichiro.github.io/tshirt-desk/#t=<API_TOKEN>`（リポジトリ: https://github.com/sohichiro/tshirt-desk）
  FlutterKaigi org に置くと `flutterkaigi.jp/tshirt-desk/` になり、`flutterkaigi.jp` は Cloudflare で `2026.flutterkaigi.jp` へ全部リダイレクトされるので開けない（2026-10-12 に org で作って個人へ移管）
- GAS（JSON API。ページを直接開くこともできる予備）: https://script.google.com/macros/s/AKfycbzXS_GxHw1p9fvZYJzxxqvR_IPkKsDz2Z3rb4qsOV7aNckFWERaZwZtBlyY6SQX6gH7/exec
  （匿名アクセス用なので **`/macros/s/` の素の形**。`/a/macros/flutterkaigi.jp/` 付きだとログインに飛ばされて fetch できない）
- スクリプトの ID は `.clasp.json`（git には入れない）と運営の社内メモにある。このリポジトリは公開なので、社内のスプレッドシート ID・スクリプト ID は書かない
- GAS の更新: `clasp --user flutterkaigi push -f` → `clasp --user flutterkaigi update-deployment AKfycbzXS_GxHw1p9fvZYJzxxqvR_IPkKsDz2Z3rb4qsOV7aNckFWERaZwZtBlyY6SQX6gH7`
- ページの更新: `git push`（Pages が 1 分ほどで反映）

## 仕組み

```
来場者の QR ─→ GitHub Pages の index.html（トップレベル HTTPS → カメラが使える）
                 │ fetch（開いたときに 1 回。?q=table&token=…）
                 ▼
          GAS ウェブアプリ（匿名アクセス + API_TOKEN 必須）
                 │ Luma guests/list（check_in_qr_code = QR の pk）
                 │ 参加者名簿「参加者」タブ（A 名前 / C GitHub / E チケット / F 表示名 / I Tシャツ。ID はスクリプト プロパティ）をメールで結ぶ
                 │ 登壇者一覧「名簿」タブ（メールアドレス / アイコン URL = Sessionize の写真。ID はスクリプト プロパティ、任意）
                 ▼
          { pk → 名前・チケット・サイズ・写真 } の JSON（配布対象だけ・メールは伏せ字）
```

- 読み取りはブラウザの中で引くだけ（1 人ごとに通信しない）。対応表は GAS 側で `CacheService` に 10 分置く。「再読み込み」で Luma から取り直す
- 対応表に無い pk は `?q=lookup&pk=g-…` で 1 件引き直す（`guests/get` の `id` に g-… を渡せる）。当日登録した人・キャンセル済みの人もここで分かる。
  **対象外の人は名前・メールを返さず「対象外」とだけ答える**（全参加者の名簿を配らない）
- サイズの元は参加者名簿の I 列（`speaker-team/tshirt-reconcile` の「作り直す」が書く）。**この仕組みは何も書き込まない**
- 写真: **Speaker Pass の人は登壇者一覧の Sessionize の写真**（`SPEAKER_SPREADSHEET_ID`。メール → 「ネームカード画像比較」タブのネームプレート表示名 → 名前の順で突合）、
  それ以外と見つからない人は **GitHub のアイコン**（Luma の登録回答 → 参加者名簿の C 列。`https://github.com/<user>.png`）。どちらも無ければ出ない
- `index.html` は 1 つで両方に対応。`google.script.run` があれば GAS の中（トークンは `?token=…` から）、無ければ Pages（`fetch`）
- QR の pk は 1 人 1 つの固定値（Apple Wallet とチケット画面で同じ）。`g-…` は Luma の guest key

## 守り（トークン）

- GAS は `ANYONE_ANONYMOUS`。**Google ログインの代わりに `API_TOKEN` を知っているかで守る。** `getTable` / `lookupOne` / `doGet` の JSON すべてで照合
- トークンはページの URL の `#t=…` に入れて Slack で配る。`#` 以降はサーバーにも GitHub にも送られない。ページは端末（localStorage）に保存して URL から消す
- 配る対応表は配布対象（サイズあり、または Staff Pass / Speaker Pass）だけ。メールは `t***@example.com` の形
- イベント後に `setupToken(true)` で作り直す（か、プロパティを消す）と古い URL は使えなくなる
- `diagnose` などエディタ用の関数は URL からは呼べない（`q` は `table` と `lookup` だけ）

## 表示

| 状態 | 色 | 条件 |
|---|---|---|
| サイズ（巨大表示） | 緑 | I 列にサイズがある |
| サイズ 未回答 | 黄 | サイズが無く、Staff Pass / Speaker Pass を持つ → 在庫から渡す |
| 対象外 | 灰 | サイズが無く、対象チケットでもない（名前は出ない） |
| 承認済みではありません | 赤 | approval_status が approved 以外（キャンセル・保留） |

名前の横に写真（Speaker Pass は Sessionize、それ以外は GitHub）。読めるたびに枠が光り、読み取り時刻と回数が出る（同じ QR を読み直したときも分かる）
| 名簿にありません | 赤 | Luma にも無い pk、または別イベントの QR |

読み取りは ① カメラ（Pages のみ） ② 写真 ③ バーコードリーダー／手入力。QR を出せない人は名前・表示名・メールで検索。

## セットアップ手順（順番どおりに）

GAS 側は **clasp の `flutterkaigi` アカウント（ウェブアプリの実行者）で行う。** `executeAs: USER_DEPLOYING` なので、
別のアカウントで権限を承認してもウェブアプリには効かない。

1. `clasp --user flutterkaigi login`（1〜2 日で切れる）→ 別ディレクトリに `clasp pull` して手元と diff（本番に手元に無い変更が無いか）
2. `clasp --user flutterkaigi push -f` → `update-deployment …`（上の「GAS の更新」）。これで匿名アクセス + JSON API になる
3. エディタで **`setupToken`** を実行 → ログに出たトークンを控える。「プロジェクトの設定 → スクリプト プロパティ」に
   **`LUMA_API_KEY`**（luma-guest-sheet と同じ値）と **`ROSTER_SPREADSHEET_ID`**（参加者名簿のスプレッドシート ID）を入れる。
   スピーカーの写真を出すなら **`SPEAKER_SPREADSHEET_ID`**（登壇者一覧のスプレッドシート ID）も入れる（無くても動く）
4. エディタで **`diagnose`** を実行 → 権限を承認（スプレッドシート読み取り・外部接続）→ ログに ❌ が無く、`check_in_qr_code の形: … → pk=OK` と出れば OK。
   `pk=取り出せない` でもページは動く（毎回 `guests/get` に g-… で聞きにいくので 1 人ごとに 1〜2 秒かかる）
5. 匿名アクセスになったことを確かめる（HEAD は GAS が素直に答えないので GET で）:
   ```
   curl -s -o /dev/null -w '%{redirect_url}\n' 'https://script.google.com/macros/s/AKfycbzXS_GxHw1p9fvZYJzxxqvR_IPkKsDz2Z3rb4qsOV7aNckFWERaZwZtBlyY6SQX6gH7/exec?q=table'
   curl -sL 'https://script.google.com/macros/s/AKfycbzXS_GxHw1p9fvZYJzxxqvR_IPkKsDz2Z3rb4qsOV7aNckFWERaZwZtBlyY6SQX6gH7/exec?q=table'
   ```
   1 行目が `script.googleusercontent.com` へのリダイレクトなら OK（`accounts.google.com` なら「デプロイを管理 → アクセス」が組織内限定のまま）。
   2 行目の本文が `{"error":"unauthorized"}` か `{"error":"スクリプト プロパティ API_TOKEN…"}` の JSON なら OK（HTML が返るなら切り替わっていない）
6. （済）`gh repo create sohichiro/tshirt-desk --public --source=. --push` → Pages を有効化:
   `gh api -X POST repos/sohichiro/tshirt-desk/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'` → `-X PUT … -F https_enforced=true`
7. `https://sohichiro.github.io/tshirt-desk/#t=<トークン>` を開き、右上に「NN 人（サイズあり NN）」と出て、①カメラが起動することを確認。
   Pages からの fetch（CORS）はここで初めて確かめられる。URL を Slack の受付担当に配る

## 分かっていること

- **GAS のウェブアプリの中ではカメラ（getUserMedia）が使えない。** Google 側の iframe に `allow="camera"` が無く、
  Permissions Policy で弾かれる（2026-10-12、10-09 の試作で動かなかった記憶と一致。Google Developers forum にも同じ報告）。
  `<input type=file capture>` の「写真を撮って読む」は対象外なので iframe の中でも動く
- Luma のチェックイン QR は `https://luma.com/check-in/evt-qUO00SlCqL95v5b?pk=g-…`。`guests/get` の `id` は「guest ID (gst-)・ticket key・guest key (g-)・メール」を受ける（openapi.json）。
  レスポンスは `{ guest: {...} }`（本番の scholarship-reimburse / luma-speaker-family で確認）
- Luma の公開 API にチェックインする機能は無い（`checked_in_at` を読めるだけ）
- ダークモードのチケット画面は QR が白黒反転している。jsQR は `inversionAttempts: 'attemptBoth'` で読める。OpenCV は読めなかった
- `guests/list` は 1 ページ 50 件が上限（luma-guest-sheet で確認）。約 400 人で 8 回なので作り直しは 10〜20 秒
- GAS の JSON 応答（`ContentService`）は `script.googleusercontent.com` への 302 の先で `Access-Control-Allow-Origin: *` が付くので、
  GET ならどのドメインからでも `fetch` できる。カスタムヘッダは付けない（preflight になる）

## ファイル

| ファイル | 役割 | GAS に push | Pages に出る |
|---|---|---|---|
| `Code.gs` | JSON API・対応表づくり・診断 | ○ | ○（ソースとして見えるだけ） |
| `index.html` | ページ本体（両対応） | ○ | ○ |
| `jsqr.js` | jsQR 1.4.0 の同梱コピー（CDN が落ちたときの予備。Pages だけ） | × | ○ |
| `appsscript.json` | V8 / 読み取り専用スコープ / 匿名アクセス | ○ | ○ |
| `.clasp.json` | スクリプト ID（git には入れない） | - | × |

公開リポジトリに入れないもの: スクリプト ID、参加者名簿のスプレッドシート ID、`API_TOKEN`、`LUMA_API_KEY`、名簿そのもの。
GAS の API の URL は index.html に要るので公開だが、トークン無しでは `{"error":"unauthorized"}` しか返さない。

## やらないと決めたこと・未定

- 渡した記録と二重渡しの警告: 要否未定のまま入れていない。入れるなら pk をキーにした追記ログ（別スプレッドシート）が要る。
  同じ人が Luma に 2 回登録している（Staff Pass と Speaker Pass を別アドレスで）場合は pk が 2 つあるので、名前でも見る必要がある
