'use strict';
/**
 * main.js — Electron メインプロセス
 *
 *  ・PC起動と同時に起動（ログイン項目に登録）→ ウィンドウを出さずに1回スキャン
 *  ・通常起動 → ウィンドウを表示し、起動時に1回スキャン
 *  ・タスクトレイに常駐し、いつでも画面を開ける
 */
const path = require('path');
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell } = require('electron');

const { createStore } = require('./store');
const { register } = require('./ipc');
const { runScan } = require('./scanner');
const { createWatcher } = require('./watcher');

const AUTOSTART = process.argv.includes('--autostart');

// GPUシェーダーキャッシュの書き込みに失敗する環境（フォルダを移動した直後、
// クラウド同期フォルダ内で実行している等）があり、そのまま起動すると初回描画が
// 乱れることがある。ディスクキャッシュを使わない設定にして安定させる。
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.commandLine.appendSwitch('disk-cache-size', '0');

let win = null;
let tray = null;
let store = null;
let watcher = null;
let ctx = null;
const state = { scanning: false, bootScanDone: false, lastScanAt: 0 };

/* ---------- 多重起動を防ぐ ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

/* ---------- 送信ヘルパ ---------- */
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- ウィンドウ ---------- */
function createWindow(show) {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#E8EBF2',
    title: 'FileFly',
    icon: path.join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  win.once('ready-to-show', () => {
    if (!show) return;
    win.show();
    // GPUキャッシュの書き込み失敗などで初回描画が乱れることがあるため、
    // 表示直後にもう一度リサイズと同じ効果（強制再描画）をかけて安定させる。
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.invalidate(); }, 150);
  });

  // 外部リンクは既定のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // エクスプローラーで操作してからアプリに戻ってきた瞬間に必ず最新にする。
  // OS の通知を取りこぼしていても、ここで確実に追いつく。
  win.on('focus', () => { if (!state.scanning) onFsChange('focus'); });

  // × を押しても終了せずトレイに残す（次回のPC起動を待つ必要がないように）
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(true); return; }
  win.show();
  win.focus();
  maybeScanOnShow();
}

/* ---------- トレイ ---------- */
function createTray() {
  const iconPath = path.join(__dirname, '../../build/icon.ico');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('FileFly');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '画面を開く', click: showWindow },
    { label: '今すぐ確認する', click: () => triggerScan('manual') },
    { type: 'separator' },
    {
      label: 'PC起動時に自動で実行する',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => setAutoLaunch(item.checked)
    },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
}

/* ---------- 自動起動 ---------- */

/**
 * 自動起動に登録すべき exe のパスを返す。登録すべきでなければ null。
 *
 * ポータブル版は起動のたびに自分自身を %TEMP% の使い捨てフォルダへ展開して動く。
 * そのため process.execPath は毎回変わる一時パスになる。
 * これをそのまま登録すると、次回のPC起動時には
 *   ・フォルダごと消えていて起動しない
 *   ・中途半端に残っていて、Chromiumのリソースが読めず画面が壊れる
 * といったことが起きる。実際にレジストリへ Temp 配下のパスが残っていた。
 *
 * electron-builder のポータブル版は、展開前の本来の exe パスを
 * 環境変数 PORTABLE_EXECUTABLE_FILE に入れてくれるので、あればそれを使う。
 */
function launchPath() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) return portable;

  const exe = process.execPath;
  const tmp = [process.env.TEMP, process.env.TMP, app.getPath('temp')].filter(Boolean);
  const inTemp = tmp.some(d => exe.toLowerCase().startsWith(path.resolve(d).toLowerCase()));
  if (inTemp) return null;   // 使い捨てのパスなので登録しない

  return exe;
}

function setAutoLaunch(enabled) {
  store.set('autoLaunch', !!enabled);
  if (process.platform === 'linux') return;   // Linux は環境依存なので触らない

  const exe = enabled ? launchPath() : null;
  if (enabled && !exe) {
    // 一時フォルダから動いている＝登録しても次回は使えないので、何もしない
    console.warn('[autoLaunch] 一時フォルダから起動しているため、自動起動は登録しません:', process.execPath);
    app.setLoginItemSettings({ openAtLogin: false });
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: exe || process.execPath,
    args: ['--autostart']
  });
}

/* ---------- スキャン ---------- */
async function triggerScan(trigger) {
  if (state.scanning) return null;
  state.scanning = true;
  // 自分でファイルを動かしている間は監視の通知を止める（自分の操作で二重に更新しないため）
  if (watcher) watcher.pause();
  try {
    const summary = await runScan({ store, emit }, trigger);
    if (trigger !== 'manual' && (summary.moved > 0 || summary.unmatched > 0) && Notification.isSupported()) {
      const body = summary.unmatched
        ? `${summary.moved}件を振り分けました。${summary.unmatched}件は判断できなかったのでそのままです。`
        : `${summary.moved}件を振り分けました。`;
      const n = new Notification({ title: 'FileFly', body });
      n.on('click', showWindow);
      n.show();
    }
    return summary;
  } catch (e) {
    console.error('[scan]', e);
    // ここで黙って抜けると、画面が「確認しています…」のまま止まってしまう。
    // 必ず終了を知らせる。
    emit('scan:done', { scanned: 0, moved: 0, unmatched: 0, failed: 0, results: [], error: e.message });
    emit('file:failed', { fileName: '確認処理', error: e.message });
    return null;
  } finally {
    state.lastScanAt = Date.now();
    state.scanning = false;
    if (watcher) watcher.resume();
  }
}

/**
 * 画面を開いたときのスキャン。
 * トレイに常駐したままだと「起動時スキャン」は最初の1回しか走らないため、
 * 画面を開き直したのに何も振り分けられない、という状態になっていた。
 * ただし開くたびに走ると重いので、前回から一定時間空いているときだけにする。
 */
const RESCAN_AFTER_MS = 3 * 60 * 1000;
function maybeScanOnShow() {
  if (state.scanning) return;
  if (!store || !store.get('setupCompleted', false) || !store.listSubjects().length) return;
  if (state.lastScanAt && Date.now() - state.lastScanAt < RESCAN_AFTER_MS) return;
  setTimeout(() => triggerScan('show'), 400);
}

/**
 * スキャン対象フォルダ（既定はダウンロードフォルダ）を設定する。
 * ※ ここでの「監視」は表示を合わせるためのもので、勝手にファイルを移動はしない。
 *   自動の振り分けスキャンは従来どおり「PC起動時に1回」と「今すぐ確認する」のときだけ走る。
 */
function setScanFolder(folder) {
  store.set('scanFolder', folder);
  refreshWatch();
}

/* ---------- エクスプローラーの変更に追従する ---------- */

/**
 * 監視するフォルダを決め直す。
 * 親フォルダを再帰監視すれば、その下の科目フォルダの追加・削除・リネームも
 * まとめて拾えるので、親の下にある科目フォルダは個別に監視しない。
 */
function refreshWatch() {
  if (!watcher || !store) return;
  const targets = [];
  const base = store.get('baseFolder', null);
  if (base) targets.push({ dir: base, recursive: true });

  for (const s of store.listSubjects()) {
    const inside = base && s.folder_path.startsWith(base + path.sep);
    if (!inside) targets.push({ dir: s.folder_path, recursive: true });
  }

  // ダウンロードフォルダは中身だけ見れば十分（再帰にすると無関係な更新を拾いすぎる）
  const scan = store.get('scanFolder', null);
  if (scan) targets.push({ dir: scan, recursive: false });

  watcher.setTargets(targets);
}

/** 変更を検知したら、アプリの状態を合わせ直して画面へ知らせる */
async function onFsChange(reason) {
  if (!ctx || typeof ctx.runSync !== 'function') return;
  try {
    const result = await ctx.runSync();
    emit('fs:changed', Object.assign({ reason }, result));
  } catch (e) {
    console.error('[watch]', e);
  }
}

/* ---------- 起動 ---------- */
app.whenReady().then(async () => {
  store = createStore(app.getPath('userData'));

  // 起動時に1回だけ：エクスプローラー側で消された科目フォルダをアプリからも取り除く
  // （無ければ作り直す、ということはしない＝エクスプローラーでの削除を尊重する）
  state.removedSubjects = store.pruneMissingSubjects();

  ctx = { store, emit, getWindow: () => win, state, setScanFolder, refreshWatch, watcher: null };
  register(ctx);

  // エクスプローラー側の変更を監視して、表示を自動で合わせる
  watcher = createWatcher(onFsChange);
  ctx.watcher = watcher;
  refreshWatch();
  watcher.start();

  // 初回は OS のダウンロードフォルダをスキャン対象にしておく
  if (!store.get('scanFolder', null)) store.set('scanFolder', app.getPath('downloads'));
  // 初回起動時に自動起動を登録する
  if (store.get('autoLaunch', null) === null) setAutoLaunch(true);

  // PC起動時（--autostart）はウィンドウを作らない。
  // 起動直後はディスクもCPUも混み合っていて、この時間帯に画面を描かせると
  // ブラウザ標準スタイルの読み込みに失敗し、CSSが文字のまま表示されることがあった。
  // 画面はトレイから開かれた時点で作れば十分で、常駐時のメモリも減る。
  if (!AUTOSTART) createWindow(true);
  createTray();

  // 起動時スキャン：画面の描画が終わってから走らせる
  const kick = () => {
    if (state.bootScanDone) return;
    state.bootScanDone = true;
    if (store.get('setupCompleted', false) && store.listSubjects().length) {
      setTimeout(() => triggerScan('boot'), 1200);
    }
  };
  if (win) {
    win.webContents.once('did-finish-load', kick);
    setTimeout(kick, 8000);   // 念のためのフォールバック
  } else {
    // PC起動時は画面を作らないので、描画完了を待たずに走らせる。
    // ログイン直後の混雑を避けるため少しだけ待つ。
    setTimeout(kick, 5000);
  }

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(true); });
});

app.on('window-all-closed', () => { /* トレイに常駐するので終了しない */ });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('quit', () => {
  if (watcher) watcher.stop();
  if (store) store.close();
});
