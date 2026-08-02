'use strict';
/**
 * ipc.js — レンダラー(window.api) からの呼び出しを受ける
 * チャンネル名と戻り値の形は file-auto-sort.wired.html の実装に合わせてある。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ipcMain, dialog, shell } = require('electron');

const { runScan, syncQueue, countAllSubjects, uniquePath, moveFile, getText } = require('./scanner');
const { buildModel, learn } = require('./classifier');

/** Windows で使えない文字を落とす */
function safeFolderName(name) {
  // eslint-disable-next-line no-control-regex -- Windowsで使えない制御文字(\x00-\x1f)を意図的に対象にしている
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || 'フォルダ';
}

function register(ctx) {
  const { store, emit, getWindow, setScanFolder } = ctx;
  const H = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  /* ---------------- app ---------------- */
  H('app:getState', () => {
    // removedSubjects は「起動直後に1回だけ知らせる」通知なので、読んだらその場でクリアする
    const removedSubjects = ctx.state.removedSubjects || [];
    ctx.state.removedSubjects = [];
    return {
      setupCompleted: !!store.get('setupCompleted', false),
      subjectCount: store.listSubjects().length,
      scanFolder: store.get('scanFolder', null),
      storeKind: store.kind,
      removedSubjects,
      tutorialShown: !!store.get('tutorialShown', false)
    };
  });

  H('app:completeSetup', () => { store.set('setupCompleted', true); return { ok: true }; });
  H('app:completeTutorial', () => { store.set('tutorialShown', true); return { ok: true }; });

  /* ---------------- subjects ---------------- */
  H('subjects:list', () => store.listSubjects().map(s => ({
    id: s.id, name: s.name, folderPath: s.folder_path, folder_path: s.folder_path, keyword: s.keyword || ''
  })));

  /** 科目ごとのファイル数（実際にフォルダを読んで数える） */
  H('subjects:counts', () => countAllSubjects(store));

  /**
   * エクスプローラー側の状態にアプリを合わせ直す。
   *  ・フォルダごと消された科目を登録から外す
   *  ・実体が無くなったファイルを一覧から外す
   *  ・件数を数え直す
   * 手動同期ボタンから呼ばれるほか、フォルダ監視が変更を検知したときにも呼ばれる。
   */
  H('sync:now', () => runSync());

  async function runSync() {
    // 1. フォルダごと消された科目を登録から外す
    const removedSubjects = store.pruneMissingSubjects();

    // 2. 監視フォルダの中身に一覧を合わせる（新しく増えたファイルもここで拾う）
    //    ※ 判定・移動はしない。表示を合わせるだけ。
    const queued = await syncQueue(store);

    // 3. 振り分け済みなのに実体が消えているものも一覧から外す
    //    （科目フォルダの中でユーザーが削除・移動した場合）
    let removedFiles = queued.removed;
    for (const q of store.listQueue()) {
      if (q.status !== 'done') continue;
      const p = q.current_path || q.source_path;
      if (!p) continue;
      try {
        await fsp.access(p);
      } catch (_) {
        store.deleteQueue(q.id);
        removedFiles++;
      }
    }

    if (removedSubjects.length && typeof ctx.refreshWatch === 'function') ctx.refreshWatch();

    return {
      ok: true,
      removedSubjects,
      removedFiles,
      addedFiles: queued.added,
      subjects: store.listSubjects().map(s => ({
        id: s.id, name: s.name, folderPath: s.folder_path, folder_path: s.folder_path, keyword: s.keyword || ''
      })),
      counts: await countAllSubjects(store),
      syncedAt: new Date().toISOString()
    };
  }
  ctx.runSync = runSync;

  /**
   * 科目フォルダをまとめて作る。
   * 既存の科目は「同じ名前」なら id と学習データを引き継ぐ（設定のやり直しで学習が消えないように）。
   */
  H('subjects:createMany', async (names, baseFolder) => {
    const list = (names || []).map(n => String(n).trim()).filter(Boolean);
    if (!list.length) throw new Error('科目名が入力されていません');

    // ★ 置き場所が決まっていないのに勝手な場所へ作らない。
    //   以前はここで既定の場所（書類/授業フォルダ）へ黙って作っていたため、
    //   フォルダ選択をキャンセルしたのに作成が進み、その後ユーザーがそのフォルダを
    //   削除すると、すでに振り分けられていたファイルごと消えてしまっていた。
    const base = String(baseFolder || '').trim();
    if (!base || base.startsWith('~')) {
      throw new Error('フォルダの置き場所が選ばれていません');
    }
    await fsp.mkdir(base, { recursive: true });

    const prev = store.listSubjects();
    const byName = new Map(prev.map(s => [s.name, s]));
    let seq = store.get('subjectSeq', 0);

    const rows = [];
    for (const name of list) {
      const old = byName.get(name);
      const id = old ? old.id : `s${++seq}`;
      const folder = path.join(base, safeFolderName(name));
      await fsp.mkdir(folder, { recursive: true });
      rows.push({ id, name, folder_path: folder, keyword: old ? old.keyword : '' });
    }
    store.set('subjectSeq', seq);
    store.set('baseFolder', base);
    store.replaceSubjects(rows);

    // 消えた科目の学習データは掃除する
    const keep = new Set(rows.map(r => r.id));
    for (const s of prev) if (!keep.has(s.id)) store.clearTokensForSubject(s.id);

    // スキャン対象フォルダが未設定なら OS のダウンロードフォルダを既定にする
    if (!store.get('scanFolder', null)) {
      setScanFolder(require('electron').app.getPath('downloads'));
    }
    // 監視対象のフォルダが変わったので張り直す
    if (typeof ctx.refreshWatch === 'function') ctx.refreshWatch();
    return rows.map(r => ({ id: r.id, name: r.name, folderPath: r.folder_path }));
  });

  /**
   * 科目を削除する。フォルダは完全消去ではなく「ごみ箱へ移動」する（取り消せるように）。
   * フォルダがすでに存在しない場合（エクスプローラーで先に消されていた等）は、
   * アプリ側の登録だけ削除する。
   */
  H('subjects:remove', async (subjectId) => {
    const subject = store.listSubjects().find(s => s.id === String(subjectId));
    if (!subject) throw new Error('対象の科目が見つかりません');

    let trashed = false;
    try {
      await fsp.access(subject.folder_path);
      await shell.trashItem(subject.folder_path);
      trashed = true;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        throw new Error('フォルダを削除できませんでした: ' + (e && e.message ? e.message : e));
      }
      // ENOENT＝フォルダがそもそも無かった。アプリ側の登録だけ消せばよい。
    }

    store.removeSubject(subject.id);
    if (typeof ctx.refreshWatch === 'function') ctx.refreshWatch();
    return { ok: true, trashed };
  });

  /* ---------------- rules ---------------- */
  H('rules:getKeywords', () => {
    const out = {};
    for (const s of store.listSubjects()) out[s.id] = s.keyword || '';
    return out;
  });
  H('rules:setKeyword', (subjectId, keyword) => {
    store.setKeyword(String(subjectId), String(keyword || '').trim());
    return { ok: true };
  });

  /* ---------------- queue ---------------- */
  H('queue:list', () => store.listQueue().map(q => ({
    id: String(q.id),
    fileName: q.file_name, file_name: q.file_name,
    detectedAt: q.detected_at, detected_at: q.detected_at,
    status: q.status,
    subjectId: q.subject_id,
    score: q.score,
    reason: q.reason,
    path: q.current_path
  })));

  /**
   * ドラッグでの手動振り分け。実ファイルを移動し、同時に学習する。
   */
  H('queue:moveManually', async (queueId, subjectId) => {
    const q = store.getQueue(queueId);
    if (!q) throw new Error('対象のファイルが見つかりません');
    const subject = store.listSubjects().find(s => s.id === String(subjectId));
    if (!subject) throw new Error('振り分け先の科目が見つかりません');
    if (q.status === 'done') return { ok: true, subjectName: subject.name, alreadyDone: true };

    let content = '';
    try { content = await getText(store, q.source_path); } catch { /* ignore */ }

    // アプリ自身の移動なので、監視の通知でアニメーション中に再描画されないよう止める
    if (ctx.watcher) ctx.watcher.pause();
    let dest;
    try {
      await fsp.mkdir(subject.folder_path, { recursive: true });
      dest = await uniquePath(subject.folder_path, q.file_name);
      await moveFile(q.source_path, dest);
    } finally {
      if (ctx.watcher) setTimeout(() => ctx.watcher.resume(), 600);
    }

    // source_path も移動先へ更新する（同名ファイルを再ダウンロードしたときに拾えるようにするため）
    store.updateQueue(q.id, {
      status: 'done', subject_id: subject.id,
      current_path: dest, source_path: dest, reason: '手動で振り分け'
    });
    store.insertHistory({
      queue_id: q.id, subject_id: subject.id, file_name: q.file_name,
      from_path: q.source_path, to_path: dest,
      moved_at: new Date().toISOString(), origin: 'manual'
    });

    // ★ 学習：次回から同じような名前・内容のファイルは自動で振り分けられる
    learn(store, subject.id, { fileName: q.file_name, content }, +1);

    return { ok: true, subjectId: subject.id, subjectName: subject.name };
  });

  /**
   * ファイルを削除する（ごみ箱へ移動）。振り分け待ち・振り分け済みのどちらでもよい。
   */
  H('queue:removeFile', async (queueId) => {
    const q = store.getQueue(queueId);
    if (!q) throw new Error('対象のファイルが見つかりません');

    const target = q.current_path || q.source_path;
    let trashed = false;
    try {
      await fsp.access(target);
      await shell.trashItem(target);
      trashed = true;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        throw new Error('ファイルを削除できませんでした: ' + (e && e.message ? e.message : e));
      }
      // ENOENT＝ファイルがそもそも無かった。アプリ側の登録だけ消せばよい。
    }

    store.deleteQueue(q.id);
    return { ok: true, trashed };
  });

  /**
   * デバッグ用：ファイル一覧（キュー）に出ているものをまとめて削除する。
   * 振り分け待ち・振り分け済みを問わず対象にする。実ファイルは1件ずつごみ箱へ移動し、
   * アプリ側の登録も削除する（1件の queue:removeFile を全件分まとめて行うイメージ）。
   */
  H('queue:clearAll', async () => {
    const rows = store.listQueue();
    if (ctx.watcher) ctx.watcher.pause();
    let trashed = 0, failed = 0;
    try {
      for (const q of rows) {
        const target = q.current_path || q.source_path;
        try {
          await fsp.access(target);
          await shell.trashItem(target);
          trashed++;
        } catch (e) {
          if (e && e.code !== 'ENOENT') failed++;
          // ENOENT＝ファイルがそもそも無かった。アプリ側の登録だけ消せばよい。
        }
        store.deleteQueue(q.id);
      }
    } finally {
      if (ctx.watcher) setTimeout(() => ctx.watcher.resume(), 600);
    }
    return { ok: true, removed: rows.length, trashed, failed };
  });

  /* ---------------- history ---------------- */
  H('history:countBySubject', () => store.countBySubject());

  /**
   * 振り分けた履歴（新しい順）。アプリを再起動しても残る。
   * exists は「移動先にいまも実物があるか」。エクスプローラーで消された場合に false になる。
   */
  H('history:list', (limit) => {
    const nameById = new Map(store.listSubjects().map(s => [s.id, s.name]));
    return store.recentHistory(Math.max(1, Number(limit) || 200)).map(h => ({
      id: String(h.id),
      fileName: h.file_name,
      subjectId: h.subject_id,
      subjectName: nameById.get(h.subject_id) || '削除された科目',
      toPath: h.to_path,
      fromPath: h.from_path,
      movedAt: h.moved_at,
      origin: h.origin,
      exists: (() => { try { return fs.existsSync(h.to_path); } catch (_) { return false; } })()
    }));
  });

  /** 直近 n 件の移動を取り消す（ファイルを元の場所へ戻し、学習も巻き戻す） */
  H('history:undoLast', async (n) => {
    const rows = store.recentHistory(Math.max(1, Number(n) || 1));
    let undone = 0;
    for (const h of rows) {
      try {
        let content = '';
        if (h.origin === 'manual') { try { content = await getText(store, h.to_path); } catch { /* ignore */ } }
        await fsp.mkdir(path.dirname(h.from_path), { recursive: true });
        const back = await uniquePath(path.dirname(h.from_path), h.file_name);
        await moveFile(h.to_path, back);
        store.markUndone(h.id);
        store.updateQueue(h.queue_id, { status: 'waiting', subject_id: null, current_path: back, source_path: back, reason: '取り消し済み' });
        if (h.origin === 'manual') learn(store, h.subject_id, { fileName: h.file_name, content }, -1);
        undone++;
      } catch (e) {
        emit('file:failed', { fileName: h.file_name, error: '戻せませんでした: ' + e.message });
      }
    }
    return { ok: true, undone };
  });

  /* ---------------- scan ---------------- */
  H('scan:getStatus', () => ({
    folder: store.get('scanFolder', null),
    lastScan: store.lastScan(),
    running: !!ctx.state.scanning
  }));

  H('scan:setFolder', (folder) => {
    if (!folder) throw new Error('フォルダが指定されていません');
    setScanFolder(String(folder));
    return { ok: true, folder: String(folder) };
  });

  H('scan:runNow', async () => {
    if (ctx.state.scanning) throw new Error('すでに確認中です');
    ctx.state.scanning = true;
    // 自分でファイルを動かしている間は監視の通知を止める（二重更新を防ぐ）
    if (ctx.watcher) ctx.watcher.pause();
    try { return await runScan({ store, emit }, 'manual'); }
    finally {
      ctx.state.scanning = false;
      if (ctx.watcher) ctx.watcher.resume();
    }
  });

  /* ---------------- dialog / shell ---------------- */
  H('dialog:chooseFolder', async () => {
    const win = getWindow();
    const r = await dialog.showOpenDialog(win, {
      title: 'フォルダを選んでください',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.get('baseFolder', null) || require('electron').app.getPath('documents')
    });
    if (r.canceled || !r.filePaths.length) return null;
    return { path: r.filePaths[0] };
  });

  /**
   * エクスプローラーを開いて、そのファイルを選択した状態で表示する。
   * 「アプリの一覧に出ている現物がどこにあるか」をすぐ確認できるようにするため。
   */
  H('shell:showInFolder', async (target) => {
    const p = String(target || '');
    if (!p) return { ok: false, error: '場所が分かりません' };
    try {
      await fsp.access(p);
    } catch (_) {
      return { ok: false, error: 'ファイルが見つかりませんでした（移動または削除された可能性があります）' };
    }
    shell.showItemInFolder(p);
    return { ok: true };
  });

  H('shell:openFolder', async (folderPath) => {
    try {
      await fsp.mkdir(folderPath, { recursive: true });
      const err = await shell.openPath(folderPath);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---------------- 開発用：判定の内訳を見る ---------------- */
  H('debug:explain', async (queueId) => {
    const q = store.getQueue(queueId);
    if (!q) throw new Error('not found');
    const content = await getText(store, q.current_path || q.source_path);
    const model = buildModel(store.listSubjects(), store.listTokens());
    return require('./classifier').classify({ fileName: q.file_name, content }, model);
  });
}

module.exports = { register, safeFolderName };
