# Twitch Stream Helper

Chrome extension to manage your Twitch stream title, category, tags, and open an X post.

---

## 日本語

Twitch配信のタイトル・カテゴリ・タグの管理と、X投稿画面の起動を行うChrome拡張です。

### 機能
- 配信タイトルとカテゴリの更新
- カテゴリごとのタグ保存・適用
- カテゴリハッシュタグ付きのX投稿文作成

### 動作要件
- Chrome/Chromium
- 配信管理権限のあるTwitchアカウント

### OAuth設定（必須）
この拡張は `chrome.identity.launchWebAuthFlow` を使ってTwitch認証します。Twitch Client IDは`src/config.js`に同梱されています。

同梱するClient IDを変更する場合は、Twitch開発者コンソールでこの拡張用のアプリを作成し、リダイレクトURLを`chrome.identity.getRedirectURL()`の値に設定してから`src/config.js`を更新してください。

- リダイレクトURL例: `https://<EXTENSION_ID>.chromiumapp.org/`
- 配信情報管理のスコープ: `channel:manage:broadcast`
- チャット用のスコープ: `user:write:chat`（投稿）、`moderator:manage:chat_messages`（固定）。通常のログイン時に、配信情報管理と合わせて一度に取得します。

注: 本プロジェクトは現在 **Implicit Grant Flow** (`response_type=token`) を使用しています。これはクライアントサイド拡張機能にとってシンプルですが、アクセストークンの有効期限が比較的短く、リフレッシュトークンは提供されません。「invalid client credentials」エラーを回避するため、PKCEロジックは削除されました。

### 手動インストール
1. `chrome://extensions` を開き、デベロッパーモードをON
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
3. 拡張機能アイコンからログイン

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

## Requirements
- Chrome/Chromium
- Twitch account with permission to manage broadcast settings

## OAuth setup (required)
This extension uses Twitch OAuth via `chrome.identity.launchWebAuthFlow`. The Twitch Client ID is bundled in `src/config.js`.

To replace the bundled Client ID, register an app specifically for this extension in the Twitch developer console, set its OAuth redirect URL to the value returned by `chrome.identity.getRedirectURL()`, and then update `src/config.js`.

- Redirect URL example: `https://<EXTENSION_ID>.chromiumapp.org/`
- Stream management scope: `channel:manage:broadcast`
- Chat scopes: `user:write:chat` (posting), `moderator:manage:chat_messages` (pinning). All three scopes are requested together during the normal login.

Note: This project uses the **Implicit Grant Flow** (`response_type=token`). This is simpler for client-side extensions but means access tokens are short-lived and no refresh token is provided. PKCE logic has been removed to simplify the authentication process and avoid "invalid client credentials" errors.

## Run (unpacked)
1. Open `chrome://extensions` and enable Developer mode.
2. Click "Load unpacked" and select this folder.
3. Click the extension icon and log in.

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

## 開発時の確認 / Development checks

依存パッケージを追加せず、Node.js の標準テスト機能で認証・定期確認・投稿・固定と再起動時の挙動をモック検証できます。実際のチャットには投稿しません。

Run the mocked integration tests with Node.js (no dependencies and no live chat posts):

```powershell
node --experimental-vm-modules --test tests/pinned-comments.test.mjs
```
