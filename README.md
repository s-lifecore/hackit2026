# ファイルオート振り分け（仮）

配布資料を自動で振り分けられるようにするデスクトップアプリです。アプリの概要・開発背景・技術スタック・機能一覧などの詳細は [`docs/仕様書.md`](docs/仕様書.md) を参照してください。

## セットアップ

```bash
npm install
```

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `npm run lint` | ESLintを実行する。CIでもこのコマンドが走ります |
| `npm run test:db` | DB層（`src/db`）の動作確認スクリプトを実行する |

## ブランチ運用

- `main` が本流のブランチです。直接pushはせず、必ず作業用ブランチを切ってPRを出してください
- ブランチは作業内容がわかる名前で作成してください（例: `feature/xxx`, `docs/xxx`）
- 作業の流れ:
  1. `main` から新しいブランチを作る
     ```bash
     git checkout -b <ブランチ名> main
     ```
  2. 変更をコミットする
     ```bash
     git add <ファイル>
     git commit -m "<変更内容がわかるメッセージ>"
     ```
  3. リモートにpushする
     ```bash
     git push -u origin <ブランチ名>
     ```
  4. GitHub上で `main` 向けのプルリクエスト（PR）を作成する

## PR・Issueの書き方

- PRを作成すると [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) の内容が自動で入ります。初めての人向けに各項目に書き方の説明を入れているので、そのまま埋めればOKです
- Issueを作成するときは [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) 以下から「🐛 バグ報告」「✨ 機能提案・タスク」のテンプレートを選べます
- わからない項目は空欄のままで大丈夫です。レビュワーと一緒に確認します

## CI（自動チェック）

- PRを作成・更新すると [`.github/workflows/lint.yml`](.github/workflows/lint.yml) によって自動でESLintが実行されます
- PRの「Checks」タブで結果を確認できます。赤くなっていたら `npm run lint` をローカルでも実行して直してください

## ディレクトリ構成

```
docs/       設計・技術選定などのドキュメント（仕様書.md 含む）
src/db/     ファイル振り分けのDB層（SQLite・ルール判定・自動学習）
.github/    PR/Issueテンプレート、CI設定
```
