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

const AUTOSTART = process.argv.includes('--autostart');

let win = null;
let tray = null;
let store = null;
const state = { scanning: false, bootScanDone: false };

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
    title: 'ファイフリ',
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

  win.once('ready-to-show', () => { if (show) win.show(); });

  // 外部リンクは既定のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // × を押しても終了せずトレイに残す（次回のPC起動を待つ必要がないように）
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow(true);
  else { win.show(); win.focus(); }
}

/* ---------- トレイ ---------- */
function createTray() {
  const iconPath = path.join(__dirname, '../../build/icon.ico');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('ファイフリ');
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
function setAutoLaunch(enabled) {
  store.set('autoLaunch', !!enabled);
  if (process.platform === 'linux') return;   // Linux は環境依存なので触らない
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    args: ['--autostart']
  });
}

/* ---------- スキャン ---------- */
async function triggerScan(trigger) {
  if (state.scanning) return null;
  state.scanning = true;
  try {
    const summary = await runScan({ store, emit }, trigger);
    if (trigger !== 'manual' && (summary.moved > 0 || summary.unmatched > 0) && Notification.isSupported()) {
      const body = summary.unmatched
        ? `${summary.moved}件を振り分けました。${summary.unmatched}件は判断できなかったのでそのままです。`
        : `${summary.moved}件を振り分けました。`;
      const n = new Notification({ title: 'ファイフリ', body });
      n.on('click', showWindow);
      n.show();
    }
    return summary;
  } catch (e) {
    console.error('[scan]', e);
    return null;
  } finally {
    state.scanning = false;
  }
}

/**
 * スキャン対象フォルダ（既定はダウンロードフォルダ）を設定する。
 * 常時監視（ファイル監視の常駐）は PC の負荷を上げるため行わない。
 * スキャンは「PC起動時に1回」と「全ファイル移動ボタン」のときだけ走る。
 */
function setScanFolder(folder) {
  store.set('scanFolder', folder);
}

/* ---------- 起動 ---------- */
app.whenReady().then(async () => {
  store = createStore(app.getPath('userData'));

  // 起動時に1回だけ：エクスプローラー側で消された科目フォルダをアプリからも取り除く
  // （無ければ作り直す、ということはしない＝エクスプローラーでの削除を尊重する）
  state.removedSubjects = store.pruneMissingSubjects();

  register({ store, emit, getWindow: () => win, state, setScanFolder });

  // 初回は OS のダウンロードフォルダをスキャン対象にしておく
  if (!store.get('scanFolder', null)) store.set('scanFolder', app.getPath('downloads'));
  // 初回起動時に自動起動を登録する
  if (store.get('autoLaunch', null) === null) setAutoLaunch(true);

  createWindow(!AUTOSTART);
  createTray();

  // 起動時スキャン：画面の描画が終わってから走らせる
  const kick = () => {
    if (state.bootScanDone) return;
    state.bootScanDone = true;
    if (store.get('setupCompleted', false) && store.listSubjects().length) {
      setTimeout(() => triggerScan('boot'), 1200);
    }
  };
  if (win) win.webContents.once('did-finish-load', kick);
  setTimeout(kick, 8000);   // 念のためのフォールバック

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(true); });
});

app.on('window-all-closed', () => { /* トレイに常駐するので終了しない */ });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('quit', () => { if (store) store.close(); });
