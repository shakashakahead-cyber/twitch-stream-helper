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
この拡張は `chrome.identity.launchWebAuthFlow` を使ってTwitch認証します。Twitch開発者コンソールでアプリを作成し、Client IDを `background.js` に設定してください。

1. Twitch開発者コンソールでアプリを作成
2. リダイレクトURLを `chrome.identity.getRedirectURL()` の値に設定
   - 例: `https://<EXTENSION_ID>.chromiumapp.org/`
3. **Client ID** を `background.js` に設定

```js
const clientId = "YOUR_TWITCH_CLIENT_ID";
```

4. 必要スコープは `channel:manage:broadcast`

注: 現状は implicit flow（`response_type=token`）を使用しています。公開運用ではPKCE対応の認可コードフロー移行を推奨します。

### 手動インストール
1. `chrome://extensions` を開き、デベロッパーモードをON
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
3. 拡張機能アイコンからログイン

### 設定メモ
- トークンや設定は `chrome.storage.local` に保存されます
- Twitch Client Secretはこのリポジトリにコミットしないでください

---

## Features
- Update stream title and category
- Manage saved tags per category
- Compose an X post with optional category hashtag

## Requirements
- Chrome/Chromium
- Twitch account with permission to manage broadcast settings

## OAuth setup (required)
This extension uses Twitch OAuth via `chrome.identity.launchWebAuthFlow`. You must register your own Twitch application and set the Client ID in `background.js`.

1. Create a Twitch application in the Twitch developer console.
2. Set the OAuth redirect URL to the value returned by `chrome.identity.getRedirectURL()`.
   - For an installed extension, this looks like `https://<EXTENSION_ID>.chromiumapp.org/`.
3. Copy the **Client ID** into `background.js`:

```js
const clientId = "YOUR_TWITCH_CLIENT_ID";
```

4. The required scope is `channel:manage:broadcast`.

Note: This project currently uses the implicit flow (`response_type=token`). For production, consider migrating to the authorization code flow with PKCE.

## Run (unpacked)
1. Open `chrome://extensions` and enable Developer mode.
2. Click "Load unpacked" and select this folder.
3. Click the extension icon and log in.

## Configuration notes
- Tokens and preferences are stored in `chrome.storage.local` on your device.
- Do not commit a Twitch Client Secret to this repository.
