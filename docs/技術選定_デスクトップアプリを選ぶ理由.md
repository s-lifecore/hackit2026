# 技術選定: なぜWebアプリではなくデスクトップアプリなのか

作成日: 2026-08-01
対象: ファイルオート振り分け（仮）

---

## 結論

**このアプリの必須機能は、現在のWeb標準では実装できない。** 妥協案でもない、原理的な制約である。

最優先要件である「ダウンロードしたら自動でフォルダに入れる」は、次の3つを同時に満たす必要がある。

1. ユーザーが操作していない間もダウンロードフォルダを監視し続ける
2. 検知したファイルを、別の場所にある科目フォルダへ移動する
3. アプリを閉じても、次回起動時に設定・履歴・学習結果が残っている

ブラウザはこの3つすべてを、セキュリティ設計上の理由で意図的に禁止または制限している。
したがって **Electron によるデスクトップアプリが唯一の現実解** である。

---

## 1. 要件と実現可否

| # | 要件（READMEの優先順位） | Webアプリ | デスクトップ（Electron） |
|---|---|---|---|
| 1 | ダウンロードしたらフォルダに入れる | **不可**（後述 2-1, 2-3） | 可 |
| 2 | ファイル移動アニメーション | 可 | 可（同じHTML/CSSが使える） |
| 3 | 提出日ごとの振り分け | 可 | 可 |
| 4 | 新しいファイルの自動検知 | **不可**（後述 2-1） | 可（chokidar） |
| 5 | アニメーションを選べる | 可 | 可 |
| 6 | おすすめ振り分け（学習） | 条件付き（後述 2-4） | 可 |

最優先の2項目が実装不能である時点で、Web版は「別のアプリ」になる。

---

## 2. Webアプリで実現できない理由

### 2-1. バックグラウンドで監視し続けられない

ブラウザでバックグラウンド処理を担うのは Service Worker だが、
**Chrome はアイドル状態が30秒続いた Service Worker を終了させる。**
長時間動き続けるワーカーも同様に検出して停止する。これはバッテリーとプライバシー保護のための意図的な設計であり、回避手段は用意されていない。

つまりWeb版は「ブラウザのタブを開いている間だけ」しか動けない。
ダウンロードフォルダは、ユーザーがブラウザで別の作業をしている最中に増えていくものなので、
**監視すべきタイミングでアプリが動いていない。**

代替の Periodic Background Sync も、実行間隔はブラウザ側が決めるため（最短でも数時間単位）、
「ダウンロードした直後に振り分ける」という体験には使えない。

> 参考: 本アプリはダウンロード完了を `.crdownload` → 本名への rename で検知する設計になっている。
> この瞬間を捉えるには常時監視が必須で、定期実行では取りこぼす。

### 2-2. フォルダへのアクセス権が毎回消える

ローカルフォルダを扱うには File System Access API（`showDirectoryPicker()`）が必要だが、

- **対応ブラウザは Chrome / Edge / Opera のみ。** Firefox と Safari は非対応
- **そのオリジンのタブを全部閉じた時点で、権限は自動的に取り消される。** 次回は再度ユーザーに許可を求める
- 呼び出しにはユーザーの明示的な操作（ボタンクリック等）が必要。自動では開けない

Chrome 122 以降で永続的な権限が導入されたが、**自動で永続化されるのはインストール済みPWAの場合のみ**で、
通常のタブで開いたWebアプリでは三択のプロンプト（今回のみ許可／毎回許可／拒否）が毎回表示される。

「起動したら黙って動いていてほしい」という常駐ツールの性質と真っ向から対立する。

### 2-3. ファイルを安全に移動できない ← 最も深刻

`FileSystemHandle.move()` は OPFS（ブラウザ専用の隔離領域）内のファイルには使えるが、
**通常のローカルファイルに対しては実験フラグの裏にあり、正式提供されていない。ディレクトリの移動は未対応。**

したがってWeb版でファイルを「移動」するには、次の手順を踏むしかない。

```
1. 元ファイルを読む
2. 移動先に新しいファイルを作って全バイト書き込む
3. 元ファイルを削除する
```

これが引き起こす問題:

- **原子性がない。** 手順2と3の間でタブが閉じられたりPCが落ちたりすると、
  ファイルが二重に存在するか、最悪どちらも壊れた状態で残る
- **全バイトのコピーが発生する。** OSの `rename` は同一ドライブ内なら瞬時に終わるが、
  ブラウザは必ず実体をコピーする。2GBのISOファイルなら実時間で数十秒かかる
- **既存の安全策が使えない。** 現在のファイル操作担当の実装は、
  `fs.open(target, 'wx')` による原子的な採番、EXDEV フォールバック、
  `EBUSY`/`EPERM` の指数バックオフ再試行で信頼性を確保している。
  これらはすべて Node.js の API に依存しており、ブラウザには対応物が存在しない

**「勝手に動いてファイルが消えた」が絶対に起きてはいけないツールで、原子性を捨てるのは受け入れられない。**

### 2-4. データベースの制約

`better-sqlite3` はネイティブモジュールなのでブラウザでは動かない。代替は次のとおりだが、いずれも制約が重い。

| 選択肢 | 問題点 |
|---|---|
| `sql.js` | **メモリ上でしか動かない。** リロードするとデータが消える。別途保存処理が必要 |
| SQLite Wasm + OPFS | 同期I/O（`createSyncAccessHandle`）は **Web Worker 内でしか使えず**、構成が複雑になる |
| IndexedDB | SQLではないので、現在のスキーマとクエリを全面的に書き直し |

さらに OPFS 版には固有の問題がある。

- **同時接続不可。** ファイルハンドルが排他ロックを取るため、**2つ目のタブでDBを開くと失敗する**
- **データが消える可能性がある。** ブラウザのストレージは既定で「ベストエフォート」扱いで、
  ディスク残量が減ると削除されうる。`navigator.storage.persist()` を呼んで永続化を要求する必要があるが、
  許可されるかはブラウザの判断

学習データと移動履歴は、**消えたら復旧できない資産**である。
「ブラウザがストレージを整理したので学習結果が消えました」は、このアプリでは許容できない。

### 2-5. 対応ブラウザが限られる

上記のAPIが揃っているのは Chrome 系のみ。Firefox と Safari のユーザーは使えない。
「インストール不要で誰でも使える」というWebアプリ最大の利点が、この時点でほぼ失われる。

---

## 3. デスクトップアプリで得られるもの

Web版で失われる機能の裏返しとして、Electron では次が普通に実現できる。

| 機能 | 実現方法 |
|---|---|
| 常時フォルダ監視 | `chokidar`（OSのファイルシステムイベントを直接購読） |
| PC起動時に自動で立ち上がる | `app.setLoginItemSettings({ openAtLogin: true })` |
| ウィンドウを閉じても常駐 | `Tray`（タスクトレイ常駐） |
| 原子的なファイル移動 | `fs.rename` / `fs.open(path, 'wx')` |
| 永続的なデータ保存 | `better-sqlite3` + `app.getPath('userData')` |
| 権限の再要求が不要 | OSのユーザー権限で動くため、フォルダ選択は初回のみ |
| PDF/Word本文の抽出 | Node の各種ライブラリがそのまま使える |
| Windows向け配布 | `electron-builder` でインストーラを生成 |

**UI部分（HTML/CSS/JS、アニメーション）はWebアプリと完全に同じものが使える。**
Electron を選んでも、Web技術で作るという方針は何も変わらない。失うものがない。

---

## 4. 検討したが採用しない案

### 案A: PWA（インストール型Webアプリ）

Chrome 122以降、インストール済みPWAならフォルダ権限が永続化される。
しかし **2-1（バックグラウンド監視）と 2-3（原子的な移動）は解決しない。**
最優先要件が満たせないため却下。

### 案B: ローカルサーバー方式（Node.jsサーバー + ブラウザUI）

技術的には成立する。`chokidar`・`fs`・`better-sqlite3` がそのまま使え、既存コードが100%活きる。

ただし、これは **「Electronの中身をそのままに、ガワだけブラウザにした」もの** である。
利用者には「サーバーを起動する」という手順が増え、
起動用のバッチファイルやサービス登録が別途必要になる。
Electron はまさにその起動と配布を肩代わりする仕組みなので、
**わざわざ手作業で再実装する理由がない。**

なお、この案が成立するという事実自体が「Web技術が悪いのではなく、
ブラウザのサンドボックスが制約の正体である」ことを示している。

### 案C: クラウド型（サーバーにデプロイ）

ユーザーがファイルをアップロードして仕分けてもらう形。
**ダウンロードフォルダには一切触れないため、解決したい課題そのものが変わる。**
「整理されないまま溜まる」という開発背景に対する答えになっていないため却下。

（ただしハッカソンの見せ方としては、審査員がURLを開くだけで試せる利点がある。
デモ用として別途用意する価値はあるかもしれない。）

---

## 5. まとめ

- ブラウザがローカルファイルを扱えないのは、機能不足ではなく **セキュリティ上の意図的な設計**
- 「常時監視」「原子的なファイル移動」「消えないローカルDB」は、その設計と本質的に両立しない
- この3つはいずれも、本アプリの信頼性の根幹をなす部分である
- Electron を選んでも UI は Web技術のまま。**Web技術を捨てるわけではない**

したがって、**Electron によるデスクトップアプリ**という当初の技術選定を維持する。

---

## 出典

- [Window: showDirectoryPicker() method — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
- [The File System Access API: simplifying access to local files — Chrome for Developers](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Persistent permissions for the File System Access API — Chrome for Developers](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)
- [FileSystemDirectoryHandle — MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle)
- [Chrome removes idle service worker after 30-40 seconds — mswjs/msw #367](https://github.com/mswjs/msw/issues/367)
- [Offline and background operation — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
- [Persistent Storage Options — SQLite Wasm 公式ドキュメント](https://sqlite.org/wasm/doc/trunk/persistence.md)
- [SQLite Wasm in the browser backed by the Origin Private File System — Chrome for Developers](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system)
- [SQLite 3.40 to support browser API, including OPFS — wa-sqlite Discussion #63](https://github.com/rhashimoto/wa-sqlite/discussions/63)
- [The Current State Of SQLite Persistence On The Web (2026)](https://powersync.com/blog/sqlite-persistence-on-the-web)
- [How to Keep Your Electron App Running in Background](https://blog.stackademic.com/how-to-keep-your-electron-app-running-in-background-373f9df8418d)
