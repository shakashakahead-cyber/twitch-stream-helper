# プライバシーポリシー（Twitch Stream Helper）

最終更新日: 2025-09-12

本拡張機能「Twitch Stream Helper」（以下「本拡張」）は、配信者が Twitch の配信タイトル・カテゴリ・タグの管理や X（旧Twitter）への投稿を補助するためのツールです。

## 取得する情報
- **Twitch アクセストークン**: ユーザーが明示的にログイン操作を行ったとき、Twitch の OAuth（`chrome.identity.launchWebAuthFlow`）を通じてアクセストークンを取得し、**ブラウザのローカルストレージ（chrome.storage.local）にのみ保存**します。
- **配信情報（タイトル、カテゴリ、タグ）**: Twitch API（`https://api.twitch.tv/helix/`）からユーザー自身のチャンネル情報を取得・更新します。

## 送信・共有
- 本拡張は**開発者の自前サーバー等にデータを送信しません**。通信先は Twitch のみです（`https://id.twitch.tv/` および `https://api.twitch.tv/`）。
- 取得したアクセストークンおよび配信情報は**端末内（ブラウザ）に保存**され、第三者へ共有しません。

## 利用目的
- 配信タイトル・カテゴリ・タグの取得/更新
- X（旧Twitter）投稿画面の呼び出し（テキスト組み立てのみ。X への投稿そのものはユーザーが最終確認して実行）

## 保管と削除
- アクセストークンはユーザーがログアウト操作を行うと削除されます（`chrome.storage.local.remove`）。
- ユーザーは、ブラウザの拡張機能のデータ消去や本拡張のアンインストールにより、ローカルに保存されたデータを削除できます。

## 権限
- `identity` と `storage` のみを使用します。ホスト権限は `https://id.twitch.tv/*` と `https://api.twitch.tv/*` に限定しています。

## 第三者サービス
- 本拡張は Twitch の非公式ツールです。**Twitch とは提携・承認・スポンサー関係にありません。** Twitch のロゴや商標は Twitch Interactive, Inc. のものです。

## お問い合わせ
- 開発者連絡先: （shakashakahead@gmail.com）
