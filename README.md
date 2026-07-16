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
- 必要スコープ: `channel:manage:broadcast`

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
- Required scope: `channel:manage:broadcast`

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
