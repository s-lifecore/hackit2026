/**
 * main-ipc.js — ipcMain ハンドラ一式。preload.js の window.api と1対1対応。
 * =============================================================================
 * Electron担当の main.js から呼ぶ。詳しい雛形は main-example.js を参照:
 *
 *   import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
 *   import * as db from './back/db.js';
 *   import { registerIpcHandlers } from './back/main-ipc.js';
 *
 *   db.init();
 *   const { runStartupScan } = registerIpcHandlers({ ipcMain, dialog, shell, app, win, db, moveFn });
 *   await runStartupScan();   // ← PC起動時の一括処理。常時監視はしない
 *
 * チャンネル名の一覧・戻り値の形は ipc-contract.md を正とする。
 * =============================================================================
 */

import { runScan, resolveScanFolder, getLastScan, listScanRuns } from './startup-scan.js';

/** 「1科目1キーワード」の簡易ルールに使う目印 */
const SIMPLE_RULE_MARK = '__simple__';

function findSimpleRule(db, subjectId) {
  return db.rules
    .list({ subjectId, includeDisabled: true })
    .find((r) => r.description === SIMPLE_RULE_MARK);
}

/**
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').Dialog} deps.dialog
 * @param {import('electron').BrowserWindow} deps.win
 * @param {object} deps.db  back/db.js（init済みであること）
 * @param {{new(...a:any[]):any}|null} [deps.SorterClass] sorter/src/sorter.js の Sorter
 * @param {(src:string, destDir:string)=>Promise<string>} [deps.moveFn]
 *   実ファイルを動かす関数（ファイル操作担当のmover.jsを想定）。無ければDB記録のみ行う。
 */
export function registerIpcHandlers({ ipcMain, dialog, shell, app, win, db, moveFn = null }) {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => fn(...args));
  const send = (channel, payload) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  /* ---------------------------------------------------------- subjects */
  handle('subjects:list', () => db.subjects.list());
  handle('subjects:get', (id) => db.subjects.get(id));

  handle('subjects:createMany', async (names, baseFolder) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = [];
    for (const name of names) {
      const folderPath = path.join(baseFolder, name);
      await fs.mkdir(folderPath, { recursive: true });
      const id = db.subjects.create({ name, folderPath });
      out.push({ id, name, folderPath });
    }
    return out;
  });

  handle('subjects:importFromFolder', (root) => db.subjects.importFromFolder(root));
  handle('subjects:update', (id, patch) => db.subjects.update(id, patch));
  handle('subjects:remove', (id) => db.subjects.remove(id));

  /* ---------------------------------------------------------- rules（簡易キーワード） */
  handle('rules:getKeywords', () => {
    const out = {};
    for (const s of db.subjects.list()) {
      const r = findSimpleRule(db, s.id);
      out[s.id] = r?.enabled ? (r.conditions?.[0]?.value ?? '') : '';
    }
    return out;
  });

  handle('rules:setKeyword', (subjectId, keyword) => {
    const existing = findSimpleRule(db, subjectId);
    const kw = String(keyword || '').trim();

    if (!kw) {
      if (existing) db.rules.setEnabled(existing.id, false);
      return { ok: true, ruleId: existing?.id ?? null, enabled: false };
    }

    const conditions = [{ target: 'filename', operator: 'contains', value: kw, caseSensitive: false }];
    if (existing) {
      db.rules.update(existing.id, { conditions, enabled: true });
      return { ok: true, ruleId: existing.id, enabled: true };
    }
    const ruleId = db.rules.create({
      subjectId, name: 'キーワード', description: SIMPLE_RULE_MARK,
      matchMode: 'all', priority: 100, conditions,
    });
    return { ok: true, ruleId, enabled: true };
  });

  handle('rules:list', (opts) => db.rules.list(opts));
  handle('rules:create', (p) => db.rules.create(p));
  handle('rules:update', (id, patch) => db.rules.update(id, patch));
  handle('rules:remove', (id) => db.rules.remove(id));

  /* ---------------------------------------------------------- aliases */
  handle('aliases:list', (subjectId) => db.aliases.list(subjectId));
  handle('aliases:add', (subjectId, alias) => db.aliases.add(subjectId, alias));

  /* ---------------------------------------------------------- scan（常時監視の置き換え） */
  handle('scan:getStatus', () => ({
    folder: resolveScanFolder(db),
    scanOnStartup: db.settings.getBool('scan_on_startup', true),
    lastScan: getLastScan(db),
  }));

  handle('scan:setFolder', (folderPath) => {
    db.settings.set('scan_folder', folderPath);
    return { folder: folderPath };
  });

  handle('scan:setOnStartup', (bool) => {
    db.settings.set('scan_on_startup', !!bool);
    return db.settings.getBool('scan_on_startup');
  });

  handle('scan:history', (limit) => listScanRuns(db, limit ?? 20));

  handle('scan:runNow', async () => {
    send('scan:start', { folder: resolveScanFolder(db) });
    const summary = await runScan(db, {
      trigger: 'manual',
      moveFn,
      onProgress: (p) => send('scan:progress', p),
    });
    send('scan:done', summary);
    return summary;
  });

  /* ---------------------------------------------------------- shell */
  handle('shell:openFolder', async (folderPath) => {
    if (!folderPath) return { ok: false, error: 'パスが空です' };
    const err = await shell.openPath(folderPath);   // 成功時は空文字を返す仕様
    return err ? { ok: false, error: err } : { ok: true };
  });

  handle('shell:revealFile', (filePath) => {
    if (!filePath) return { ok: false, error: 'パスが空です' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  /* ---------------------------------------------------------- startup（ログイン時の自動起動） */
  handle('startup:get', () => {
    const s = app.getLoginItemSettings();
    return { openAtLogin: s.openAtLogin, saved: db.settings.getBool('launch_at_login', true) };
  });

  handle('startup:set', (enabled) => {
    // --hidden 付きで登録する。この引数があるときはウィンドウを出さずスキャンだけ行う
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      args: ['--hidden'],
    });
    db.settings.set('launch_at_login', !!enabled);
    return { openAtLogin: !!enabled };
  });

  /* ---------------------------------------------------------- app（初回判定） */
  handle('app:getState', () => ({
    setupCompleted: db.settings.getBool('setup_completed', false),
    subjectCount: db.subjects.list().length,
  }));

  handle('app:completeSetup', () => {
    db.settings.set('setup_completed', true);
    return true;
  });

  /* ---------------------------------------------------------- queue */
  handle('queue:list', (status) => db.queue.list(status));
  handle('queue:countByStatus', () => db.queue.countByStatus());

  handle('queue:processAll', async (ids) => {
    const path = await import('node:path');
    const items = ids?.length
      ? ids.map((id) => db.queue.get(id)).filter(Boolean)
      : db.queue.list('pending');

    const results = [];
    for (const item of items) {
      const cached = item.file_hash ? db.content.get(item.file_hash) : null;
      const r = db.classify({
        fileName: item.file_name, ext: item.ext, sizeBytes: item.size_bytes,
        text: cached?.text ?? null,
      });

      if (!r.matched) {
        db.queue.setStatus(item.id, 'unmatched', { suggested: r.suggestions });
        results.push({ id: item.id, matched: false, suggestions: r.suggestions });
        continue;
      }

      let destPath = path.join(r.folderPath, r.subfolder || '', item.file_name);
      if (moveFn) {
        try {
          destPath = await moveFn(item.source_path, path.dirname(destPath));
        } catch (e) {
          db.queue.setStatus(item.id, 'error', { errorMessage: e.message });
          results.push({ id: item.id, matched: true, moved: false, error: e.message });
          continue;
        }
      }

      db.history.add({
        fileName: item.file_name, sourcePath: item.source_path, destPath,
        ext: item.ext, sizeBytes: item.size_bytes, fileHash: item.file_hash,
        subjectId: r.subjectId, ruleId: r.ruleId, matchedBy: r.matchedBy, score: r.confidence,
        action: moveFn ? 'move' : 'skip', // moveFn 無しなら「判定のみ」を明示
      });
      db.queue.setStatus(item.id, 'done', { subjectId: r.subjectId, ruleId: r.ruleId, score: r.confidence });
      results.push({
        id: item.id, matched: true, moved: !!moveFn, subjectId: r.subjectId,
        subjectName: r.subjectName, destPath, matchedBy: r.matchedBy, confidence: r.confidence,
      });
    }
    return results;
  });

  handle('queue:moveManually', async (fileId, subjectId) => {
    const path = await import('node:path');
    const item = db.queue.get(fileId);
    if (!item) throw new Error('ファイルが見つかりません（キューから消えています）');
    const subject = db.subjects.get(subjectId);
    if (!subject) throw new Error('科目が見つかりません');

    let destPath = path.join(subject.folder_path, item.file_name);
    if (moveFn) destPath = await moveFn(item.source_path, subject.folder_path);

    // ここが「手動配置による自動学習」の入口。移動記録だけで終わらせないこと。
    const cached = item.file_hash ? db.content.get(item.file_hash) : null;
    db.learn.record({
      subjectId, fileName: item.file_name, ext: item.ext,
      text: cached?.text ?? null, fileHash: item.file_hash, source: 'manual_move',
    });

    db.history.add({
      fileName: item.file_name, sourcePath: item.source_path, destPath,
      ext: item.ext, sizeBytes: item.size_bytes, fileHash: item.file_hash,
      subjectId, matchedBy: 'manual', action: moveFn ? 'move' : 'manual',
    });
    db.queue.setStatus(item.id, 'done', { subjectId });
    return { id: fileId, subjectId, subjectName: subject.name, destPath, moved: !!moveFn };
  });

  /* ---------------------------------------------------------- history */
  // 「元に戻す」で対応するキュー項目を pending に戻す（ベストエフォート。
  // 実ファイルの物理的な巻き戻しは journal.jsonl 側の Journal.undoLast が担当する）
  function revertQueueBySourcePath(sourcePath) {
    const item = db.queue.list().find((q) => q.source_path === sourcePath && q.status === 'done');
    if (item) db.queue.setStatus(item.id, 'pending', {});
  }

  handle('history:list', (opts) => db.history.list(opts));
  handle('history:stats', (days) => db.history.stats(days));
  handle('history:undo', (id) => {
    const row = db.history.get(id);
    db.history.markUndone(id);
    if (row) revertQueueBySourcePath(row.source_path);
    return true;
  });
  handle('history:undoLast', (n) => {
    const rows = db.history.list({ limit: n ?? 1, status: 'success' });
    for (const r of rows) { db.history.markUndone(r.id); revertQueueBySourcePath(r.source_path); }
    return rows.map((r) => r.id);
  });
  // UIは subjectId でバッジを引くので、科目名ではなくIDをキーにして返す
  handle('history:countBySubject', () => {
    const rows = db.getDb().prepare(
      `SELECT subject_id, COUNT(*) AS n FROM history
       WHERE status = 'success' AND subject_id IS NOT NULL
       GROUP BY subject_id`
    ).all();
    const out = {};
    for (const r of rows) out[r.subject_id] = r.n;
    return out;
  });

  /* ---------------------------------------------------------- settings */
  handle('settings:get', (key, def) => db.settings.get(key, def));
  handle('settings:set', (key, value) => db.settings.set(key, value));
  handle('settings:getAll', () => db.settings.getAll());

  /* ---------------------------------------------------------- dialog */
  handle('dialog:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return { path: r.filePaths[0] };
  });

  /**
   * PC起動時のスキャン。main.js から「ウィンドウを出す前」に呼ぶ。
   * ウィンドウが無い（--hidden 起動）場合はイベント送信が握りつぶされるだけで問題ない。
   */
  async function runStartupScan() {
    if (!db.settings.getBool('scan_on_startup', true)) return null;
    send('scan:start', { folder: resolveScanFolder(db) });
    const summary = await runScan(db, {
      trigger: 'startup',
      moveFn,
      onProgress: (p) => send('scan:progress', p),
    });
    send('scan:done', summary);
    return summary;
  }

  return { runStartupScan };
}
