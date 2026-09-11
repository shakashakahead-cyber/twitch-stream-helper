# Twitch Stream Helper

Chrome extension to manage your Twitch stream title, category, tags, and open an X post.

---

## 日本語

Twitch配信のタイトル・カテゴリ・タグの管理と、X投稿画面の起動を行うChrome拡張です。

### 機能
- 配信タイトルとカテゴリの更新
- カテゴリごとのタグ保存・適用
- カテゴリハッシュタグ付きのX投稿文作成
- 保存コメントの投稿・配信開始時の自動投稿と固定
- 配信ごとのAnalytics、前後の配信への切り替え、Twitch履歴同期、CSV出力

### 動作要件
- Chrome/Chromium 116以降
- 配信管理権限のあるTwitchアカウント

### OAuth設定（必須）
この拡張は `chrome.identity.launchWebAuthFlow` を使ってTwitch認証します。Twitch Client IDは`src/config.js`に同梱されています。

同梱するClient IDを変更する場合は、Twitch開発者コンソールでこの拡張用のアプリを作成し、リダイレクトURLを`chrome.identity.getRedirectURL()`の値に設定してから`src/config.js`を更新してください。

- リダイレクトURL例: `https://<EXTENSION_ID>.chromiumapp.org/`
- 配信情報管理のスコープ: `channel:manage:broadcast`
- チャット用のスコープ: `user:write:chat`（投稿）、`moderator:manage:chat_messages`（固定）。通常のログイン時に、配信情報管理と合わせて一度に取得します。

注: 本プロジェクトは現在 **Implicit Grant Flow** (`response_type=token`) を使用しています。これはクライアントサイド拡張機能にとってシンプルですが、アクセストークンの有効期限が比較的短く、リフレッシュトークンは提供されません。「invalid client credentials」エラーを回避するため、PKCEロジックは削除されました。

### 手動インストール
最新版のZIPは [GitHub Releases](https://github.com/shakashakahead-cyber/twitch-stream-helper/releases/latest) からダウンロードし、展開してください。

1. `chrome://extensions` を開き、デベロッパーモードをON
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
3. 拡張機能アイコンからログイン

更新する場合は、Analyticsタブを閉じ、現在読み込んでいるフォルダに新しいファイルを上書きしてから、`chrome://extensions` で拡張機能を再読み込みしてください。Analyticsはポップアップから開き直します。保存済みの履歴を保持するため、拡張機能を削除せず、同じフォルダを使って更新してください。

### 設定メモ
- Twitch公式ではClient IDは公開情報とされているため、`src/config.js`をGitで管理します
- アクセストークンや設定は`chrome.storage.local`に保存されます
- Client Secret、アクセストークン、リフレッシュトークンは公開情報ではありません
- Twitch Client Secretはこのリポジトリにコミットしないでください

### テンプレート変数

配信タイトルとX投稿の追加テキストでは、次の変数を使用できます。変数ボタンを押すとカーソル位置に挿入され、展開結果が画面にプレビューされます。

| 変数 | 展開される値 |
| --- | --- |
| `{category}` | 選択中のカテゴリ名 |
| `{category_hashtag}` | カテゴリ名から作ったハッシュタグ |
| `{channel}` | Twitchのチャンネル名 |
| `{stream_url}` | Twitch配信URL |
| `{tags}` | 選択中のタグ（カンマ区切り） |
| `{tag_hashtags}` | 選択中のタグをハッシュタグ化した文字列 |
| `{date}` | 現地日付（`YYYY-MM-DD`） |
| `{time}` | 現地時刻（`HH:mm`） |
| `{title}` | 現在の配信タイトル（X投稿欄のみ） |

タイトルテンプレートは `chrome.storage.local` に保存されます。カテゴリまたはタグの変数を含む場合、それらを変更した後にタイトルへ自動適用されます。140文字の上限は変数を展開した後のタイトルに対して判定されます。

タイトル欄を編集した場合は、入力欄からフォーカスを外すかEnterキーを押すと自動更新されます。画面には「未反映」「反映中」「反映済み」「反映失敗」の状態と、現在Twitch上にあるタイトルが常時表示されます。

X投稿には従来どおりタイトルと配信URLが自動で追加されます。`{title}` または `{stream_url}` を使用した場合は、指定位置にだけ追加されます。「配信URLを付けない」を有効にすると、自動追加と `{stream_url}` の両方が無効になります。

---

## Features
- Update stream title and category
- Manage saved tags per category
- Compose an X post with optional category hashtag
- Post saved comments, including automatic posting and pinning when a stream starts
- Review individual streams, navigate between broadcasts, sync Twitch history, and export Analytics CSVs

## Requirements
- Chrome/Chromium 116+
- Twitch account with permission to manage broadcast settings

## OAuth setup (required)
This extension uses Twitch OAuth via `chrome.identity.launchWebAuthFlow`. The Twitch Client ID is bundled in `src/config.js`.

To replace the bundled Client ID, register an app specifically for this extension in the Twitch developer console, set its OAuth redirect URL to the value returned by `chrome.identity.getRedirectURL()`, and then update `src/config.js`.

- Redirect URL example: `https://<EXTENSION_ID>.chromiumapp.org/`
- Stream management scope: `channel:manage:broadcast`
- Chat scopes: `user:write:chat` (posting), `moderator:manage:chat_messages` (pinning). All three scopes are requested together during the normal login.

Note: This project uses the **Implicit Grant Flow** (`response_type=token`). This is simpler for client-side extensions but means access tokens are short-lived and no refresh token is provided. PKCE logic has been removed to simplify the authentication process and avoid "invalid client credentials" errors.

## Run (unpacked)
Download the latest ZIP from [GitHub Releases](https://github.com/shakashakahead-cyber/twitch-stream-helper/releases/latest) and extract it first.

1. Open `chrome://extensions` and enable Developer mode.
2. Click "Load unpacked" and select this folder.
3. Click the extension icon and log in.

To update, close Analytics tabs, replace the files in the currently loaded extension folder, and reload the extension at `chrome://extensions`. Reopen Analytics from the popup. Keep the same folder and do not remove the extension, so existing local history is retained.

## Configuration notes
- Twitch considers Client IDs public, so `src/config.js` is tracked in Git.
- Access tokens and preferences are stored in `chrome.storage.local`.
- Client secrets, access tokens, and refresh tokens are not public.
- Do not commit a Twitch Client Secret to this repository.

## Template variables

The stream title and additional X post text support the following variables. Click a variable button to insert it at the cursor and preview the expanded result.

| Variable | Expanded value |
| --- | --- |
| `{category}` | Selected category name |
| `{category_hashtag}` | Hashtag generated from the category name |
| `{channel}` | Twitch channel name |
| `{stream_url}` | Twitch stream URL |
| `{tags}` | Selected tags, separated by commas |
| `{tag_hashtags}` | Selected tags converted to hashtags |
| `{date}` | Local date (`YYYY-MM-DD`) |
| `{time}` | Local time (`HH:mm`) |
| `{title}` | Current stream title (X post field only) |

The title template is stored in `chrome.storage.local`. Templates containing category or tag variables are reapplied automatically after those values change. The 140-character limit is checked after variables are expanded.

After editing the title field, leave the field or press Enter to apply it automatically. The popup keeps showing the current Twitch title and whether the edit is pending, applying, applied, or failed.

The title and stream URL are still added to X posts automatically. When `{title}` or `{stream_url}` is present, that value is inserted only at the specified position. Enabling **Do not include the stream URL** disables both the automatic URL and `{stream_url}`.

## 固定コメントの自動投稿

1. 拡張機能を再読み込みしてログインし、「固定コメント」に共通の文章を入力します（500文字以内）。
2. 「カテゴリ別のコメント」では、カテゴリ履歴からカテゴリを選んで別の文章を保存できます。空欄なら共通コメントを使います。投稿時に Twitch から取得したカテゴリで選び、配信途中のカテゴリ変更では再投稿しません。文章はそのまま投稿され、タイトル・X投稿用のテンプレート変数は展開しません。
3. 必要に応じて「コメントを固定する」と固定時間（配信終了まで／30分／10分）を選びます。チャット投稿・固定の権限は通常のログイン時にまとめて取得するため、コメント欄での追加認証は不要です。旧バージョンの権限でログイン済みの場合だけ、ログイン画面から一度再ログインしてください。保存済みの設定や投稿記録は引き継ぎます。
4. 「配信開始時に1回だけ自動投稿」を有効にして「設定を保存」を押します。自動投稿は初期状態ではオフです。保存にはログインが必要です。
5. Chrome が起動中で、PC がスリープしていない間、約1分ごとに配信状態を確認します。ポップアップを閉じても動作します。有効化時・Chrome 再起動時にすでに配信中で未投稿なら、その配信にも一度投稿します。Chrome を終了している間の配信開始は検知できません。

「今すぐ投稿・再試行」は、配信中のチャンネルにコメントを一度投稿します。既にこの配信で投稿済みなら再投稿しません。固定だけ失敗した場合は、保存したメッセージIDと元の固定時間で固定のみを再試行します。429の場合は少なくとも1分と `Ratelimit-Reset` の遅い方まで待ってから、手動で再試行してください。自動再送はしません。

送信前にアカウント・配信ID・配信開始日時と処理状況を `chrome.storage.local` に記録し、Service Worker が停止しても重複投稿を防ぎます。結果不明の送信は再送しないため、中断のタイミングによっては未投稿でもその配信での再送を抑止します。この場合は Twitch のチャットを確認して手動で投稿してください。記録はアカウントごとに直近100配信分を保持します。保存データの削除・拡張の再インストール・別PCとの重複実行には対応しません。

固定は既存の固定コメントを置き換えます。固定の期限切れや手動解除後にも、自動で再固定・再投稿しません。共有チャットに参加中の場合、ユーザーアクセストークンによる投稿は共有先のチャンネルにも表示されます。

追加するChrome権限は `alarms` のみで、配信確認を定期実行するために使います。ホスト権限は変更しません。ログアウトすると自動投稿をオフにし、定期確認を停止します。アカウントを切り替えた場合はコメントを確認して設定を保存し直してください。トークン失効時には再ログインが必要です。

API仕様: [Send Chat Message](https://dev.twitch.tv/docs/api/reference/#send-chat-message)、[Pin Chat Message](https://dev.twitch.tv/docs/api/reference/#pin-chat-message)、[Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams)。投稿は `POST /helix/chat/messages`、固定はクエリパラメーターを付けた `PUT /helix/chat/pins` を使用します。配信終了までの固定では `duration_seconds` を省略します。

## Automatic saved chat comments

Enter a default comment (up to 500 characters) in **Saved chat comment**, optionally add category-specific comments from category history, and choose whether to pin it until the stream ends, for 30 minutes, or for 10 minutes. Blank category comments fall back to the default. Comments are posted verbatim; title/X template variables are not expanded.

The normal login requests stream-management, chat-posting (`user:write:chat`), and pinning (`moderator:manage:chat_messages`) access together. There is no separate chat authorization button. Users with older tokens missing these scopes are directed to the normal login screen to log in again once; saved settings and delivery records are kept. Enable **Post once when a stream starts** and **Save settings** while logged in. Automatic posting is off by default.

The extension uses the Chrome `alarms` permission to check your own stream about once a minute while Chrome is running and the computer is awake, even with the popup closed. It also posts once if you enable it or restart Chrome during an already-live, unhandled stream. The actual Twitch category at posting time selects the comment. Category changes during that stream do not trigger another post.

**Post now / retry** sends once for the current live stream. If only pinning failed, it retries the saved message ID with the original duration without posting again. Rate-limited writes are never automatically retried; wait until the later of one minute or `Ratelimit-Reset`, then retry manually. A pin replaces the existing pinned comment. Expired or manually removed pins are not automatically restored. User-token messages in Shared Chat are also sent to shared channels.

Account, stream ID, start time, and delivery progress are saved locally before sending. This prevents duplicate posts across worker/browser restarts. Ambiguous deliveries are never resent, which can suppress a post after an interruption even if Twitch did not receive it; check chat and post manually in that case. The last 100 stream records are retained per account. Clearing storage, reinstalling, or running on multiple computers removes this protection. Logout disables automatic posting and stops polling; switching accounts requires reviewing and saving the settings again. Expired tokens require login again. Host permissions are unchanged.

## Analytics (v1.2)

Chrome **116以降**が必要です。ポップアップの「Analyticsを開く」から専用タブを開き、「Analyticsを有効化・認証」を選んでください。通常の配信設定用の権限を維持したまま、Analytics利用者にだけ `moderator:read:followers` と `user:read:chat` を追加要求します。Client Secretや外部サーバーは使用しません。既存の `alarms` とTwitch APIのホスト権限を再利用し、新しいChrome権限は追加しません。

有効化すると、現在取得可能なArchive VODと現在のフォロワー一覧を自動でページング取得します。1ページ最大100件、1回の定期取得で最大10ページを処理します。開始から5秒を超えたら次ページに進まず、途中でChromeが終了しても保存したカーソルから続行します。VODは日次・配信終了後、フォロワー全件は週次に再取得します。「Twitch履歴を同期」では両方を更新し、進行中のフォロワー取得はカーソルを維持します。画面には取得件数・同期開始・最終完了日時を表示します。VODが後から消えても保存済み配信は消しません。フォロワー一覧は全ページ取得完了後に新しいスナップショットへ切り替えます。

「収集を停止」またはログアウトで収集を停止します。保存済みの履歴は引き続き参照できます。アカウントを切り替えて有効化すると、そのアカウント専用のDBを使います。以前のアカウントのDBは保持します。認証が失効したときは「Analyticsを有効化・認証」から再認証してください。トークンはWorker起動時および稼働中は少なくとも1時間ごとに公式 `/validate` で確認し、実際の `expires_in` を保存します。

画面上部の「配信チェックの最終成功」で、配信の定期取得が動いているかと、その時点での配信中/オフライン判定を確認できます。直近3分以内に成功がなければ、配信・同接が記録されない可能性を別途警告します。EventSub再接続待ちはコメント・Follow・Raidなどの欠損を示し、その表示だけでは配信が一覧にない原因を断定できません。EventSubの接続開始失敗で配信チェックを中断せず、応答のない接続はcloseイベントを待ち続けずに再接続対象にします。警告が続く場合は認証・通信状態を確認し、Chromeの拡張機能管理画面でこの拡張を再読み込みしてください。未記録の過去配信は「Twitch履歴を同期」で取得可能なVODから補える場合がありますが、欠損した同接やコメント人数は復元できません。

**画面と出力**

- 画面上部の「配信ごとの記録」は、初回に最新の配信を表示します。「← 前の配信」「次の配信 →」で時系列順に移動でき、「最新の配信へ」で最新に戻れます。保存済みの全配信が対象で、下の期間フィルターとは独立しています。表示更新中も選択した配信を維持し、配信詳細から同接推移やメモを確認できます。
- 7日・30日・90日・1年・全期間で、KPI、グラフ、配信一覧、CSVの対象を切り替えます。日付・月はPCのタイムゾーンです。配信単位・月別活動は開始日時で分類します。
- 主要KPIは平均同接、最大同接、初コメント者、再訪コメント者、新規Followです。平均同接KPIは各配信平均の平均、コメント人数は各配信の人数の合計、Follow KPIは配信外も含む観測イベントの合計です。同じ長さの前期間と比較し、全期間では比較しません。
- 同接、総フォロワー、日別Follow、初コメント・再訪、月別時間・回数、現在のフォロワーの獲得時期をSVGで表示します。CDN・外部ライブラリ・ビルド工程はありません。総フォロワーはその日に取得した最後のスナップショットを表示します。
- 配信タイトルやグラフの点から詳細を開き、同接の生データ、タイトル・カテゴリ履歴、取得率、Raid、直前の最大10配信との比較を確認できます。メモと複数ラベルは「メモとラベルを保存」、タイトル履歴の評価は変更時に保存します。CSVの `title_rating` は最後のタイトルの評価です。
- カテゴリ別成績は「最初に観測したカテゴリ」で配信全体を分類します。途中でカテゴリを変えた配信の数値を、そのカテゴリだけの成績とは解釈しないでください。
- `streams.csv` は期間中に開始した配信を1配信1行、`viewer_samples.csv` は期間中に取得した同接サンプルのみを書き出します。UTF-8 BOM、CRLF、引用符エスケープ、表計算での数式実行対策を含みます。未計測は空欄です。視聴者IDは出力しません。CSV Importはありません。

**数値の定義と欠損**

- 同接は `Get Streams` の `viewer_count` を約1分ごとに取得し、配信開始からの同じ1分区間に最大1件保存します。平均は取得サンプルの算術平均、最大はサンプルの最大値です。欠損した数値は補間しません。
- 同接データ取得率は `sample_count / ceil(duration_ms / 60000)`（上限100%）。閾値は `src/analytics/aggregator.js` の `COVERAGE_THRESHOLDS` にあり、95%以上＝正常、80%以上95%未満＝一部欠損、80%未満＝参考値です。95%未満または取得率不明なら参考値として案内します。
- EventSubはChrome起動中、配信外も接続し、`channel.chat.message`、`channel.follow` v2、incoming `channel.raid`、`channel.update` v2を購読します。接続・keepalive・再接続URLでの引継ぎ・切断を処理し、再接続は待機後に行います。購読が全て成功した後の、最後に実際に受信したメッセージまでをcoverageに算入します。スリープや切断の空白時間を接続時間に含めません。コメント・Follow・Raidそれぞれの取得率を保存し、不完全なイベント数は観測できた分のみと表示します。
- 配信開始は `Get Streams.started_at`、終了はpollingで判定します。通常の終了は最後のライブ確認と最初のオフライン確認の間にあり、画面・CSVで観測時刻であることを区別します。最後のライブ確認から2.5分を超えていた場合は、終了日時・時間・取得率を不明のままにします。VODが得られても、観測済みの終了時刻や不明な配信時間を動画の長さで上書きしません。VODの開始・終了・長さは動画ごとに別保存し、詳細画面・CSVで動画時間と配信時間を区別します。複数の断片VODに空白がある場合、その空白を配信時間に加算しません。VODの情報は配信全体の完全な記録を保証するものではありません。
- 開始・終了確認が実際の開始・最後のライブ確認から2.5分以内の場合だけ、その時点の総フォロワー数を保存します。一時的な通信失敗は許容時間内の次の定期取得で再試行し、成功した実時刻を画面・CSVに残します。期限を過ぎた取得結果は境界スナップショットに使いません。遅れて検出した開始やスリープ後の終了に、現在の人数を遡って当てはめません。日次スナップショットも取得できた日だけ保存します。
- 「初コメント者」は計測開始後、配信中に初めてコメントを観測したユーザー。「再訪コメント者」は別の記録済み配信ですでにコメントしていたユーザーです。1配信につき同一ユーザーを1人と数え、配信者本人とShared Chatの相手チャンネル由来のコメントを除外します。除外対応前の記録には送信元がないため過去分を分離できず、該当配信の詳細に注意を表示します。視聴だけの人や、導入前のコメント歴は判定できません。
- コメント本文・ユーザー名は保存しません。ユーザーID、最初・最後のコメント時刻、初コメント配信ID、配信数、配信ごとの参加集合をトランザクションで保存します。配信境界のコメント・タイトル変更は最小限の情報で一時保留し、後続pollやVODで配信中と確認できた分を反映します。配信レコードがまだないだけでは破棄せず、未確定のまま7日を超えた保留分は破棄します。配信外のコメントは集計しません。Botの任意除外UIは未実装です。
- Followは日時と配信時間を照合し、配信中・配信外・境界未確定を区別します。終了境界の未確定イベントを推測で割り当てません。VODが確認できた場合は、その動画が記録している範囲と観測済み境界を照合して再分類します。専用のフォロー解除追跡は行いません。
- 「現在のフォロワーの獲得時期」は、最後に取得が完了した現在の一覧の `followed_at` を集計したものです。解除した人は含まれず、その月に発生した新規Follow総数ではありません。リアルタイムFollowと別に保持します。ページ取得中の増減により、Twitch側の瞬時の総数とは差が出る場合があります。
- `twitch_backfill` はVODの情報、`stream_helper` はこの拡張で計測した配信です。履歴レコードにもsourceを付けます。VODのタイトルは全タイトル変更履歴ではなく、過去の同接・カテゴリ・チャットは生成しません。

**保存場所**

`chrome.storage.local` にはON/OFF・選択期間・OAuthなどの軽量設定だけを保持します。Analyticsはアカウント別の `twitch-stream-helper-analytics-<broadcasterId>` IndexedDBへ保存します。`db.js` のバージョン付きmigrationはstore/indexを追加し、既存データを消しません。v3では、旧版でVODに上書きされた実測配信の終了時刻を保存済みの観測境界から修復し、関連集計を順次再計算します。元の観測記録がない数値や、既に破棄されたイベントは復元できません。配信・同接サンプル・履歴・コメント者・Follow/Raid・フォロワースナップショット・EventSub接続区間・一時保留イベント・メタデータに分けています。Chromeの拡張データ削除や拡張のアンインストールで失われるため、必要なサマリーはCSVで書き出してください。

## Analytics in English

Requires Chrome **116+**. Open **Analytics** from the popup, then choose **Enable Analytics / authorize**. Only Analytics users are asked for the additional `moderator:read:followers` and `user:read:chat` scopes; existing broadcast/chat-posting/pinning access is retained. No server, client secret, CDN, package manager, or new Chrome permissions are required.

Available archive VODs and the current follower list are imported automatically, up to ten 100-item pages per collection tick, stopping before another page once five seconds have elapsed. Checkpoints survive restarts. A full current-follower snapshot becomes visible only once all pages finish. VOD sync runs daily and after a stream; full follower snapshots run weekly. **Sync Twitch history** requests both without resetting an active follower cursor. Progress, sync start and last successful completion times are shown. Deleted Twitch VODs do not delete local history. Pause or logout stops collection and preserves data. Reauthorize after token expiry; token validation runs on worker startup and at least hourly.

**Last successful stream check** shows when polling last succeeded and whether the channel was live then. A separate warning appears after three minutes without a successful check. EventSub reconnect warnings concern events and do not alone explain a missing stream. EventSub startup errors do not stop polling; unresponsive sockets are retired without waiting indefinitely for a close event. Check authorization/connectivity and reload the extension from Chrome's extension manager if warnings persist. **Sync Twitch history** can recover missing stream entries from available archive VODs, but cannot recover missing viewer samples or commenter counts.

The **Stream by stream** panel appears above the overview and starts on the latest saved stream. Use **← Previous stream**, **Next stream →**, or **Back to latest** to browse all saved streams, independently of the overview's period filter. Refreshing data preserves the selected stream. Open **Stream details** for viewer history and notes.

The 7/30/90/365-day and all-time filters control KPIs, charts, history and CSV exports. Calendar grouping uses the computer's timezone, and streams/monthly activity are assigned by start date. Overview averages are means of per-stream averages; commenter counts sum across streams; follows include observed off-stream events. The comparison uses the preceding equal-length period; stream details compare against up to 10 preceding measured, completed streams. Category comparisons group whole streams by the first observed category, including any subsequent category changes.

Open a stream title or chart point for details, raw viewer samples, title/category history, coverage, raids, notes, labels and title ratings. Ratings save when changed; notes and labels have an explicit save button. The CSV title rating is the final title's rating. Additional columns distinguish VOD duration, timing sources, follower snapshot observation times and the chat-origin filter version. Exports are separate BOM-prefixed UTF-8 files with CSV escaping, CRLF and spreadsheet formula protection. Stream exports filter start times; sample exports filter sample times. Missing values stay blank and viewer identities are never exported.

Viewer counts are observed roughly once a minute; averages and peaks use only actual samples. Coverage is samples divided by expected one-minute samples: ≥95% healthy, 80–95% partial, <80% reference. Event coverage uses actual received WebSocket messages after subscriptions succeed, with sleep/disconnect gaps excluded. Unobserved events remain unknown; partially covered counts are observed minimums. Coverage and the disconnect watchdog share a 1.5-second heartbeat grace period; actual sleep/disconnect gaps remain excluded. Twitch reconnect URLs transfer subscriptions without duplicates. HTTP 429 waits for the later of at least one minute and `Ratelimit-Reset`; writes are not immediately retried.

Normal end times are bounded polling observations and are labeled approximate. After a gap over 2.5 minutes, live end time, duration and coverage remain unknown. VOD recording ranges and lengths are stored separately and never overwrite observed broadcast bounds. Multiple recording fragments do not turn intervening gaps into measured airtime. Start/end follower totals retry on subsequent ticks only within the 2.5-minute boundary window; their actual observation times are shown and exported. Missing days are not filled. Boundary follows remain unclassified until enough stream information is available. Pending chat/title events retain only necessary fields for up to seven days while awaiting boundary resolution, even if the stream record has not arrived yet; offline chat is excluded. Broadcasters and messages originating from other Shared Chat channels are excluded from commenter counts. Older records without channel-origin information cannot be separated retrospectively and display a warning. Custom bot exclusion is deferred.

First-time commenters means users first observed commenting in a stream since measurement began, not first-time viewers. Returning commenters have participated in a different recorded stream. Persistent per-stream user sets survive worker restarts; no chat text or chatter names are retained. Current-follower acquisition dates describe the last completed current-membership snapshot, exclude people who later unfollowed, and are distinct from newly observed follow events. Paginated lists may change while being read. Archive metadata cannot recover past audience, chat or category history.

Analytics data stays in separate, versioned per-account IndexedDB databases. Version 3 repairs legacy VOD-overwritten live bounds using saved polling observations and schedules summary recalculation; discarded events and missing chat origins cannot be recovered. Only lightweight preferences and OAuth settings use `chrome.storage.local`. Pause/account changes preserve history. Clearing extension data or uninstalling removes it, so export summaries when needed.

Official implementation references: [Get Videos / Get Channel Followers / Get Streams](https://dev.twitch.tv/docs/api/reference/), [EventSub subscriptions](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/), [WebSocket recovery](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/), [Token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/), [Chrome service worker WebSockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets).

### Analytics verification

確認環境はNode.js 24.11.1です。Node標準テスト37件と、ブラウザの実IndexedDBを使う統合テスト24件を確認しました。接続開始失敗時の配信記録、closeが完了しない接続の再試行、取得エラー後の最終成功記録の保持、予期しない収集エラーの表示対象への保存を含みます。日英253キー、JavaScript構文、取得停止/通信失敗の表示、空状態、390px表示、メモ・ラベル・評価の保存、既存ポップアップのログイン済み/未ログイン表示も確認しています。架空データの両CSVをブラウザから保存し、BOM・行数・未計測の空欄・保存した評価の反映を確認しました。実Chrome拡張の追加OAuth、実配信の受信・再接続は未検証です。

```powershell
node --test tests/analytics-smoke-test.mjs
node --experimental-vm-modules --test tests/pinned-comments.test.mjs
node tests/serve-analytics-tests.mjs
```

最後のコマンドは `http://127.0.0.1:4173/tests/analytics-browser.html` にローカル専用の確認ページを開けるようにします。実IndexedDBによるmigration・rollback・ページング・重複防止・配信終了・Shared Chat除外・境界スナップショット再試行・断片VOD・同期再開と件数/時間制限を検証し、日本語/英語の架空データ・空状態・390pxフレームも確認できます。テスト用の保存先はlocalhostで、実際の拡張データやTwitchのトークン・APIを使いません。

The browser harness tests real IndexedDB transactions/migration and collection with synthetic data and mocked Twitch requests. It also provides Japanese/English, empty and narrow-layout fixtures. It does not test a live Twitch account or the installed MV3 service worker.

実機での最終確認は、`chrome://extensions` で再読み込みし、popupとService Workerのコンソールを確認してください。未ログイン/ログイン、追加OAuth、初回履歴同期、ライブ中のchat/follow/raid/update、終了、切断・スリープ・Worker再起動と再接続、既存のタイトル/カテゴリ/タグ/テンプレート/X/固定コメントを確認します。チャット投稿や配信設定の更新を伴う操作は、自分のテスト配信で行ってください。

For final live verification, reload the unpacked extension at `chrome://extensions`, inspect popup/worker consoles, and check signed-out/signed-in flows, additional OAuth, real backfill, live chat/follow/raid/update events, end detection, sleep/worker restart/reconnect, and all existing stream-setting/template/X/saved-comment features on your own test stream.

## 開発時の確認 / Development checks

依存パッケージを追加せず、Node.js の標準テスト機能で認証・定期確認・投稿・固定と再起動時の挙動をモック検証できます。実際のチャットには投稿しません。

Run the mocked integration tests with Node.js (no dependencies and no live chat posts):

```powershell
node --experimental-vm-modules --test tests/pinned-comments.test.mjs
```
