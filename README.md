# ファイルオート振り分け（仮）

## 作品概要

**作品名：** ファイルオート振り分け（仮）

**制作目的と理由（背景を含む）**

- 自分の雑さをツールで緩和させたい
- ダウンロードフォルダに配布資料が溜まり続け、整理されないまま放置されてしまう課題を解決したい

**技術スタック：**

| 項目 | 技術 | 用途 |
| --- | --- | --- |
| アプリ基盤 | Electron | デスクトップアプリ化 |
| UI | HTML + CSS + JavaScript（Vanilla JS） | 画面作成 |
| ファイル操作 | Node.js（`fs/promises`） | ファイルの移動・コピー・削除 |
| データベース | SQLite（better-sqlite3） | ルール・履歴・設定の保存 |
| Lint | ESLint | コード品質チェック（CIで自動実行） |
| 配布 | electron-builder | Windows向けインストーラー作成 |

技術選定の詳しい経緯や機能一覧・優先順位は [`docs/仕様書.md`](docs/仕様書.md) を参照してください。

**ターゲット：**

- 配られたものをまとめられない人
- ダウンロードしたファイルをダウンロードフォルダに入れっぱなしにしがちな人

---

## チーム構成

<!-- 自己紹介は各自追記してください。書き方は下の例を参考にしてください -->

| GitHub | 学年・役割 | 自己紹介 |
| --- | --- | --- |
| [@s-lifecore](https://github.com/s-lifecore) | | |
| [@ikeda1457](https://github.com/ikeda1457) | | |
| [@atoji486](https://github.com/atoji486) | | |

<details>
<summary>自己紹介の書き方の例</summary>

```markdown
#### @your-github-id （学年・役割）
- 出身：
- 興味：
- 経験言語：
- ハッカソンでの意気込み：
```

</details>

---

## 機能一覧

優先順位や詳細は [`docs/仕様書.md`](docs/仕様書.md) を参照してください。ここでは概要のみ。

1. ダウンロードしたらフォルダに入れる（必須）
2. ファイル移動時のアニメーション
3. 提出日ごとの振り分け
4. 新しいファイルの自動検知
5. アニメーションを選べる
6. おすすめ振り分け（過去の実績から提案）

---

## 開発セットアップ

```bash
npm install
```

### よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `npm run lint` | ESLintを実行する。CIでもこのコマンドが走ります |
| `npm run test:db` | DB層（`src/db`）の動作確認スクリプトを実行する |

---

## 開発フロー（重要）

**直接 `main` ブランチで作業しないでください。** 必ず作業用ブランチを切ってPRを出してください。

### 1. ブランチを作成する

```bash
git checkout main
git pull origin main
git checkout -b feature/自分の名前-機能名
```

### ブランチ名の命名規則

- `feature/名前-機能名`（新機能）例: `feature/ikeda-db-schema`
- `fix/名前-修正内容`（バグ修正）例: `fix/atoji-sorter-crash`
- `docs/名前-ドキュメント名`（ドキュメント更新）例: `docs/sudo-readme-update`

### 2. コードを書いてコミットする

```bash
git add <ファイル>
git commit -m "<変更内容がわかるメッセージ>"
```

### 3. リモートにpushしてPRを作成する

```bash
git push -u origin <ブランチ名>
```

GitHub上で `main` 向けのプルリクエストを作成してください。作成すると [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) の内容が自動で入ります。初めての人向けに各項目へ書き方の説明を入れているので、そのまま埋めればOKです。わからない項目は空欄のままで大丈夫です。

Issueを作成するときは [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) から「🐛 バグ報告」「✨ 機能提案・タスク」を選べます。

---

## チーム開発のルール

### コミットメッセージ

- 日本語でOK。何をしたかが明確にわかるように書く

良い例：

- `ログイン画面のHTMLとCSSを作成`
- `ユーザー登録機能のバグを修正`

悪い例：

- `修正`
- `とりあえず`

### プルリクエスト

1. 必ずレビューを受けてからマージする
2. 機能ごとに小さく分割する
3. 説明・動作確認方法を詳しく書く

### CI（自動チェック）

- PRを作成・更新すると [`.github/workflows/lint.yml`](.github/workflows/lint.yml) によって自動でESLintが実行されます
- PRの「Checks」タブで結果を確認できます。赤くなっていたら `npm run lint` をローカルでも実行して直してください

---

## プロジェクト構成

```text
.
├── README.md               本ファイル
├── docs/                    設計・技術選定・仕様のドキュメント
│   └── 仕様書.md            アプリの概要・技術スタック・機能一覧
├── src/db/                  ファイル振り分けのDB層（SQLite・ルール判定・自動学習）
├── .github/
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── ISSUE_TEMPLATE/
│   └── workflows/lint.yml   CI（ESLint）
├── eslint.config.js
└── package.json
```

---

## 困ったときは

### `git push` でエラーが出る場合

```bash
git pull origin main
git push origin <ブランチ名>
```

### 間違ったブランチで作業してしまった場合

```bash
git branch                # 現在のブランチを確認
git checkout <正しいブランチ名>
```

### コンフリクト（競合）が発生した場合

- 一人で解決しようとせず、チームメンバーに相談する

### その他

- わからないことがあったら、すぐにチームメンバーに相談してください
- 画面共有でサポートし合いましょう

---

## ライセンス

MIT License. 詳細は [`LICENSE`](LICENSE) を参照してください。
