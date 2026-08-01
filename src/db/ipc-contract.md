# IPC契約書 — `file-auto-sort.html` ↔ DB層

`file-auto-sort.html`（UI担当の仮UI）を読んで、必要な操作を洗い出したもの。
UIは今すべてクライアント側の偽データで動いている（フォルダは名前だけで実パスなし、
ファイルもJS内で仮生成、監視も9秒タイマーで偽ファイルを流しているだけ）。

これを本物にするには、UI側の「偽データを作る関数」を `window.api.◯◯()` の呼び出しに
差し替えるだけでよい設計にした。API の形は Electron でもブラウザのモックでも同じ。

```
UI (renderer, contextIsolation)
   │  window.api.xxx()
   ▼
preload.js  ── contextBridge で ipcRenderer を安全に橋渡し
   │  ipcRenderer.invoke('channel', ...)
   ▼
main-ipc.js ── ipcMain.handle で back/db.js・db-resolver.js を呼ぶ
   │
   ▼
back/db.js（better-sqlite3）／ sorter（chokidar・fs）
```

イベント（main → renderer）は `window.api.on(name, cb)` で受ける。

---

## 1. セットアップ（フォルダ個数・名前入力 → 作成）

UIの `createWorkspace(names)` に対応。**実パスが要る**ので、フォルダ選択ダイアログが先に必要。

| UI操作 | API |
|---|---|
| （セットアップ開始時）保存先を選ぶ | `await window.api.dialog.chooseFolder()` → `{path}` |
| 「フォルダを作る」 | `await window.api.subjects.createMany(names, baseFolder)` |

`createMany` は内部で `fs.mkdir` して `db.subjects.create({name, folderPath})` を人数分呼ぶ。
戻り値は `[{id, name, folderPath}]`。

既存の科目フォルダから始めたい場合（デモの「①インポート」導線）:

```js
await window.api.subjects.importFromFolder(rootPath)
// → { created:[{id,name,folderPath}], skipped:[...] }
```

## 2. フォルダ一覧・件数

| UI操作 | API |
|---|---|
| 起動時にフォルダ一覧を描画 | `await window.api.subjects.list()` → `[{id,name,folderPath,color,...}]` |
| フォルダごとの件数バッジ | `await window.api.history.countBySubject()` → `{[subjectId]: number}` |

## 3. 振り分けルールの変更（`ruleModal`）

UIは**科目ごとに1つのキーワード**しか持たない簡略UI。DBの `rules` は複数条件・優先度を持てるが、
ここでは「1科目1キーワード」を1条件のルールとして保存する薄いラッパーにする。

| UI操作 | API |
|---|---|
| モーダルを開く時の初期値 | `await window.api.rules.getKeywords()` → `{[subjectId]: keyword}` |
| 「ルールを保存」 | `await window.api.rules.setKeyword(subjectId, keyword)` |

`setKeyword` の内部: 対象科目の `origin='user'` ルールが無ければ
`db.rules.create({subjectId, name:'キーワード', conditions:[{target:'filename',operator:'contains',value:keyword}]})`、
あれば `db.rules.update(ruleId, {conditions:[...]})`。keyword が空文字ならルールを無効化 (`setEnabled(false)`)。

将来、複数条件・本文条件のUIを足すときは `window.api.rules.list/create/update` を直接使う
（`db.js` の該当APIをそのまま素通ししているので、いつでも拡張できる）。

## 4. スキャン対象フォルダ（`pathModal` / 上部バー）

> **【方針転換】常時監視を廃止しました。** PC起動時に1回だけスキャンする方式です。
> chokidar の常駐、ダウンロード完了判定、無限ループ対策がまるごと不要になり、
> 常駐メモリもCPUも使いません。

| UI操作 | API |
|---|---|
| フォルダを選ぶ | `await window.api.dialog.chooseFolder()` → OSのダイアログ |
| 「このフォルダにする」 | `await window.api.scan.setFolder(path)` |
| 起動時に自動確認するか | `await window.api.scan.setOnStartup(bool)` |
| 状態の復元 | `await window.api.scan.getStatus()` → `{folder, scanOnStartup, lastScan}` |
| 「今すぐ確認」ボタン | `await window.api.scan.runNow()` → 集計結果 |
| 実行履歴 | `await window.api.scan.history(limit)` |

PC起動時のスキャンは main.js が `runStartupScan()` を呼ぶ（UIからは呼ばない）。

## 5. ファイル一覧・手動振り分け

> **自動振り分けボタンは削除しました。** 自動処理は起動時スキャンが担当し、
> UIに残るのは「ドラッグでの手動振り分け」と「今すぐ確認」だけです。

| UI操作 | API |
|---|---|
| ファイル一覧 | `await window.api.queue.list()` |
| ファイルをフォルダへドラッグ | `await window.api.queue.moveManually(fileId, subjectId)` |
| 「元に戻す」 | `await window.api.history.undoLast(n)` |
| フォルダのバッジ件数 | `await window.api.history.countBySubject()` → `{[subjectId]: number}` |

`moveManually` は移動に加えて **`db.learn.record()` を必ず呼ぶ**
（= 「手動配置による自動学習」の入口そのもの）。このアプリの学習機能の核なので、
移動処理だけで終わらせないこと。

## 5.5 フォルダを開く / 自動起動 / 初回判定

| UI操作 | API |
|---|---|
| 左カラムのフォルダをクリック | `await window.api.shell.openFolder(folderPath)` → エクスプローラーで開く |
| ログイン時の自動起動 | `await window.api.startup.get()` / `set(bool)` |
| 2回目以降はセットアップを飛ばす | `await window.api.app.getState()` → `{setupCompleted, subjectCount}` |
| セットアップ完了を記録 | `await window.api.app.completeSetup()` |

`startup.set(true)` は `app.setLoginItemSettings({openAtLogin:true, args:['--hidden']})` を呼ぶ。
`--hidden` 付きで起動されたときは**ウィンドウを一切出さず**、スキャンだけして終了する（main-example.js 参照）。

## 6. イベント（main → renderer）

常時監視を廃止したので、イベントが飛ぶのは**起動時スキャンと「今すぐ確認」のときだけ**。

| イベント名 | ペイロード | 発生タイミング |
|---|---|---|
| `scan:start` | `{folder}` | スキャン開始 |
| `scan:progress` | `{index, total, fileName}` | 1ファイル処理するごと |
| `scan:done` | `{scanned, moved, unmatched, failed, results[]}` | スキャン完了 |
| `file:unmatched` | `{id, fileName, suggestions}` | 判定できなかった |
| `file:failed` | `{fileName, error}` | 移動でエラー（EPERM等） |

```js
window.api.on('scan:done', (summary) => { /* results を順にアニメーションさせる */ });
```

## 7. 設定

| UI操作 | API |
|---|---|
| 動きの種類（ふわっと／ひきよせ等） | UI内の状態のみ。DBに保存する場合は `window.api.settings.set('anim_mode', 'fly')` |
| 学習・本文判定のON/OFF（設定画面で足す場合） | `window.api.settings.get/set(key, value)` |

---

## window.api の全体像（preload が公開するもの）

```ts
window.api = {
  subjects: {
    list(), get(id), createMany(names, baseFolder), importFromFolder(root),
    update(id, patch), remove(id),
  },
  rules: {
    getKeywords(), setKeyword(subjectId, keyword),
    list(opts), create(p), update(id, patch), remove(id),
  },
  aliases: { list(subjectId), add(subjectId, alias) },
  scan:    { getStatus(), setFolder(path), setOnStartup(bool), runNow(), history(limit) },
  startup: { get(), set(bool) },
  shell:   { openFolder(path), revealFile(path) },
  app:     { getState(), completeSetup() },
  queue:   { list(status), moveManually(fileId, subjectId), countByStatus() },
  history: { list(opts), stats(days), undo(id), undoLast(n), countBySubject() },
  settings:{ get(key, def), set(key, value), getAll() },
  dialog:  { chooseFolder() },
  on(eventName, callback),   // scan:start / scan:progress / scan:done / file:unmatched / file:failed
  off(eventName, callback),
};
```

すべて `Promise` を返す（`ipcRenderer.invoke` ベース）。UIは全部 `await` で受ける。

---

## モックモードとの関係

`mock-api.js` は上と全く同じ `window.api` を、Electronなしで再現する
（`localStorage` は使わず、ページを開いている間だけ有効なメモリ上の擬似DB）。
`file-auto-sort.wired.html` はこの `window.api` を叩くように書き換えた版で、
`mock-api.js` を読み込めばブラウザで直接動作確認でき、
`preload.js`（Electron版）に差し替えれば本物のDBに繋がる。**UI側のコードは一切変えなくてよい。**
