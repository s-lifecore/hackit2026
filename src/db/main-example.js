/**
 * main-example.js — Electron メインプロセスの雛形（Electron担当への提案）
 * =============================================================================
 * このファイルはそのまま `main.js` として使えます。既に main.js がある場合は
 * 「★」の付いた部分だけ取り込んでください。
 *
 * 【重要な仕様】
 * PC起動時（ログイン時の自動起動）は **ウィンドウを一切表示しません**。
 * 静かにスキャンして振り分け、終わったらプロセスを終了します。
 * ユーザーがアイコンから起動したときだけ画面が出ます。
 *
 *   自動起動:  app.exe --hidden  → ウィンドウなし → スキャン → 終了
 *   手動起動:  app.exe           → ウィンドウ表示 → スキャン → 結果を画面に反映
 * =============================================================================
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './back/db.js';
import { registerIpcHandlers } from './back/main-ipc.js';

// ★ ファイル操作担当の mover.js が用意できたら差し替える。
//    渡さない間は「判定してDBに記録するだけ」で、実ファイルは動かない（安全側）。
// import { moveFile, withRetry } from '../sorter/src/mover.js';
// const moveFn = (src, destDir) => withRetry(() => moveFile(src, destDir), { retries: 4 });
const moveFn = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** ★ --hidden 付きで起動された = OSのログイン時に自動起動された */
const isHiddenLaunch = process.argv.includes('--hidden');

/** 多重起動の防止（自動起動と手動起動がぶつかるのを防ぐ） */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false, // ready-to-show まで白い画面を見せない
    webPreferences: {
      preload: path.join(__dirname, 'back', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'front', 'file-auto-sort.html'));
  return win;
}

app.whenReady().then(async () => {
  db.init();

  // ★ 初回起動時に「ログイン時の自動起動」を登録する
  if (db.settings.getBool('launch_at_login', true) && !app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  if (isHiddenLaunch) {
    // ================= 自動起動：画面を出さずに処理して終了 =================
    const { runStartupScan } = registerIpcHandlers({
      ipcMain, dialog, shell, app, win: null, db, moveFn,
    });

    try {
      const summary = await runStartupScan();
      if (summary && summary.moved > 0 && Notification.isSupported()) {
        new Notification({
          title: 'ファイルオート振り分け',
          body: `${summary.moved}件のファイルを振り分けました`,
        }).show();
        // 通知が消えるまで少し待つ
        await new Promise((r) => setTimeout(r, 4000));
      }
    } catch (e) {
      console.error('[startup-scan] 失敗:', e);
    } finally {
      db.close();
      app.quit();
    }
    return;
  }

  // ================= 手動起動：画面を出す =================
  createWindow();
  const { runStartupScan } = registerIpcHandlers({
    ipcMain, dialog, shell, app, win, db, moveFn,
  });

  // 画面の準備ができてからスキャン（結果がイベントでUIに流れる）
  win.webContents.once('did-finish-load', () => {
    runStartupScan().catch((e) => console.error('[startup-scan] 失敗:', e));
  });
});

/** 2つ目のインスタンスが起動されたら、既存のウィンドウを前面に出す */
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  db.close();
  app.quit(); // macOSでも終了させる（常駐しない方針のため）
});

app.on('before-quit', () => {
  try { db.close(); } catch { /* 二重closeは無視 */ }
});
