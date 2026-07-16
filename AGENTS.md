# AGENTS.md

## プロジェクト概要

- Twitch の配信タイトル、カテゴリ、タグを管理し、X の投稿画面を開く Chrome 拡張です。
- Manifest V3 と Vanilla JavaScript（ES Modules）で構成されています。
- ビルド工程、パッケージマネージャー、自動テストはありません。リポジトリのルートを Chrome で「パッケージ化されていない拡張機能」として読み込みます。
- `default_locale` は英語です。ユーザー向け文言は `_locales/en/messages.json` と `_locales/ja/messages.json` で管理します。

## 主なファイル

- `manifest.json`: 権限、ホスト権限、ポップアップ、バックグラウンド Service Worker の定義。
- `popup.html` / `styles.css` / `popup.js`: ポップアップの表示と操作。`popup.js` はバックグラウンドへメッセージを送ります。
- `background.js`: メッセージルーターと機能全体の調整を担う MV3 Service Worker。
- `src/auth.js`: Twitch OAuth とトークン管理。
- `src/api.js`: Twitch API 呼び出し。
- `src/storage.js`: `chrome.storage.local` と実行時の配信状態の管理。
- `src/utils.js`: タグの正規化、テンプレート変数の展開、X投稿文の組み立てなど、Chrome API に依存しない共通処理。
- `src/config.js`: Twitch公式で公開情報とされているClient IDを保持する、Git管理対象の設定ファイル。

## 変更時のルール

- 既存の ES Modules 構成を維持し、依頼がない限りバンドラーや依存パッケージを追加しないでください。
- ポップアップ固有の DOM 処理は `popup.js` に置き、バックグラウンド処理と Twitch API 処理はそれぞれ `background.js` と `src/api.js` に分けてください。
- `background.js` の非同期メッセージ応答では、すべての経路で一度だけ `sendResponse` を呼び、リスナーの `return true` を維持してください。
- 新しいユーザー向け文言を追加する場合は、英語と日本語の両方に同じキーを追加し、プレースホルダー定義も一致させてください。
- テンプレート変数を追加・変更する場合は、`src/utils.js` の変数一覧と展開値、ポップアップのプレビュー、バックグラウンドでの最終展開、READMEの変数表を一致させてください。
- 1回の操作でカテゴリ、タグ、タイトルを更新する場合は、`updateChannelInfo` の1回のPATCHにまとめてください。同じチャンネルへの連続PATCHはTwitchの「updating too fast」制限を招きます。
- HTTP 429になった書き込みを即時に自動再送しないでください。ユーザーへ待機を案内し、必要なら `Ratelimit-Reset` を参照してください。
- 権限、`host_permissions`、OAuth スコープは必要最小限にし、追加や拡大の理由を明確にしてください。
- `src/config.js`のClient IDは公開可能ですが、この拡張用に登録したTwitchアプリの値だけを使用してください。
- Client IDとClient Secretを混同しないでください。Client Secretはソースファイルへ追加しないでください。
- Client Secret、アクセストークン、リフレッシュトークンなどの秘密情報は、どのファイルにもコミットしないでください。
- 認証情報をログへ出さないでください。保存が必要な設定は既存どおり `chrome.storage.local` を使用してください。
- 設定場所や利用手順を変更した場合は `README.md` も同時に更新してください。
- ユーザーの未コミット変更を保持し、依頼と無関係な整形や書き換えは避けてください。

## 確認方法

変更範囲に応じて、最低限以下を確認してください。

1. JavaScript の構文を確認します。

   ```powershell
   node --check background.js
   node --check popup.js
   Get-ChildItem src\*.js | ForEach-Object { node --check $_.FullName }
   ```

2. 変更した JSON ファイルが有効な JSON であることを確認します。ロケールを変更した場合は英語版と日本語版のキーも比較してください。
3. `chrome://extensions` で拡張機能を再読み込みし、ポップアップと Service Worker のコンソールにエラーがないことを確認します。
4. UI またはメッセージ処理を変更した場合は、ログイン状態と未ログイン状態の両方で関連操作を手動確認します。
5. 認証、配信情報更新、カテゴリ、タグを変更した場合は、実際の Twitch API との連携を可能な範囲で確認し、未実施の確認項目を報告してください。
