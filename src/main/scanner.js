'use strict';
/**
 * scanner.js — 監視フォルダを1回スキャンして振り分ける
 *
 * 方針（ユーザー要件どおり）
 *   ・判定できたファイルだけを科目フォルダへ移動する
 *   ・迷った／関係なさそうなファイルはダウンロードフォルダに置いたままにする
 */
const fsp = require('fs/promises');
const path = require('path');

const { extract } = require('./text-extract');
const { buildModel, classify } = require('./classifier');

/** 判定対象から常に外すもの */
const IGNORE_EXT = new Set([
  '.tmp', '.crdownload', '.part', '.partial', '.download', '.!ut', '.lnk', '.url',
  '.exe', '.msi', '.dll', '.sys', '.iso', '.dmg', '.appx'
]);
const IGNORE_NAME = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;
const MIN_AGE_MS = 5000;   // ダウンロード中のファイルを掴まないための猶予

function isCandidate(name, st) {
  if (name.startsWith('.') || name.startsWith('~$')) return false;
  if (IGNORE_NAME.test(name)) return false;
  if (IGNORE_EXT.has(path.extname(name).toLowerCase())) return false;
  if (!st.isFile()) return false;
  if (st.size === 0) return false;
  if (Date.now() - st.mtimeMs < MIN_AGE_MS) return false;
  return true;
}

/** 同名ファイルがある場合に "資料 (2).pdf" のような名前を作る */
async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  let i = 2;
  while (true) {
    try { await fsp.access(candidate); } catch { return candidate; }
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
}

/** rename が失敗する（ドライブ跨ぎ）場合に copy+unlink へフォールバック */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

/** キャッシュ付きのテキスト抽出 */
async function getText(store, file) {
  let st;
  try { st = await fsp.stat(file); } catch { return ''; }
  const key = Math.floor(st.mtimeMs);
  const cached = store.getCachedText(file, key, st.size);
  if (cached !== null && cached !== undefined) return cached;
  const r = await extract(file);
  store.putCachedText(file, key, st.size, r.text || '');
  return r.text || '';
}

/** 件数に数えない OS の管理ファイル */
const NOT_COUNTED = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;
const COUNT_MAX_DEPTH = 4;   // 科目フォルダの中で自分でさらに整理している人向け

/**
 * フォルダの中の実ファイル数を数える。
 * 以前はアプリの移動履歴の件数を表示していたため、エクスプローラーで消したり
 * 手で足したりすると表示がずれ続けていた。毎回ディスクを見に行くことで、
 * 「エクスプローラーで見える数」と必ず一致するようにする。
 */
async function countFilesIn(dir, depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (_) { return 0; }   // フォルダごと消されていた等

  let n = 0;
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    if (e.isDirectory()) {
      if (depth < COUNT_MAX_DEPTH) n += await countFilesIn(path.join(dir, e.name), depth + 1);
    } else if (e.isFile() && !NOT_COUNTED.test(e.name)) {
      n++;
    }
  }
  return n;
}

/** 全科目の件数をまとめて数える */
async function countAllSubjects(store) {
  const out = {};
  for (const s of store.listSubjects()) out[s.id] = await countFilesIn(s.folder_path);
  return out;
}

/**
 * 監視フォルダを読み、ファイル一覧（キュー）を今の状態に合わせる。
 * ★ ファイルの移動はしない。「画面の表示をエクスプローラーに追従させる」だけの処理。
 *   スキャン本体の前半としても、フォルダ監視からの同期としても使う。
 *
 * @param {object} store
 * @returns {Promise<{added:number, removed:number, present:Set<string>, error:string|null}>}
 */
async function syncQueue(store) {
  const folder = store.get('scanFolder', null);
  const out = { added: 0, removed: 0, present: new Set(), error: null };
  if (!folder) return out;

  let names = [];
  try { names = await fsp.readdir(folder); }
  catch (e) { out.error = e.message; return out; }

  for (const name of names) {
    const full = path.join(folder, name);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    if (!isCandidate(name, st)) continue;
    out.present.add(full);

    if (!store.findQueueBySource(full)) {
      try {
        store.insertQueue({
          file_name: name,
          source_path: full,
          current_path: full,
          size: st.size,
          detected_at: new Date().toISOString()
     
        out.added++;
      } catch { /* 同時実行での重複挿入は無視してよい */ }

    }
  }

  // 監視フォルダから消えた「未処理」項目はキューから外す（ユーザーが自分で動かした・消した等）
  for (const q of store.listQueue()) {
    if (q.status === 'waiting' && !out.present.has(q.source_path)) {
      store.deleteQueue(q.id);
      out.removed++;
    }
  }

  return out;
}

/**
 * スキャン本体
 * @param {object} ctx {store, emit(channel,payload)}
 * @param {string} trigger 'boot'（PC起動時）| 'manual'（全ファイル移動ボタン）
 */
async function runScan(ctx, trigger = 'manual') {
  const { store, emit } = ctx;
  const folder = store.get('scanFolder', null);
  const subjects = store.listSubjects();

  const summary = { scanned: 0, moved: 0, unmatched: 0, failed: 0, folder, results: [] };
  if (!folder || !subjects.length) {
    emit('scan:done', summary);
    return summary;
  }

  const scanId = store.startScan(trigger);
  emit('scan:start', { folder, trigger });

  const model = buildModel(subjects, store.listTokens());
  const subjectById = new Map(subjects.map(s => [s.id, s]));

  // --- 1. フォルダを読み、キューを最新化する ---
  const synced = await syncQueue(store);
  if (synced.error) {
    emit('file:failed', { fileName: folder, error: synced.error });
    store.finishScan(scanId, summary);
    emit('scan:done', summary);
    return summary;
  }

  // --- 2. 未処理のものを判定して移動する ---
  const pending = store.listQueue().filter(q => q.status === 'waiting');
  summary.scanned = pending.length;

  let index = 0;
  for (const q of pending) {
    index++;
    emit('scan:progress', { index, total: pending.length, fileName: q.file_name });

    let content = '';
    try { content = await getText(store, q.source_path); }
    catch { /* 内容が読めなくてもファイル名だけで判定を続ける */ }

    const verdict = classify({ fileName: q.file_name, content }, model);

    if (!verdict.matched) {
      // ★ 迷ったら動かさない。ダウンロードフォルダに残したままにする
      store.updateQueue(q.id, { score: verdict.score, reason: verdict.reason, subject_id: null });
      summary.unmatched++;
      summary.results.push({
        queueId: String(q.id), fileName: q.file_name, matched: false,
        score: +verdict.score.toFixed(3), reason: verdict.reason
      });
      emit('file:unmatched', { queueId: String(q.id), fileName: q.file_name, reason: verdict.reason });
      continue;
    }

    const subject = subjectById.get(verdict.subjectId);
    try {
      await fsp.mkdir(subject.folder_path, { recursive: true });
      const dest = await uniquePath(subject.folder_path, q.file_name);
      await moveFile(q.source_path, dest);

      // source_path も移動先へ更新する。
      // こうしないと、同じ名前のファイルを次にダウンロードしたとき
      // 「処理済みの行がある」と見なされて新しいファイルがキューに入らない。
      store.updateQueue(q.id, {
        status: 'done', subject_id: subject.id, current_path: dest, source_path: dest,
        score: verdict.score, reason: verdict.reason
      });
      store.insertHistory({
        queue_id: q.id, subject_id: subject.id, file_name: q.file_name,
        from_path: q.source_path, to_path: dest,
        moved_at: new Date().toISOString(), origin: 'auto'
      });

      summary.moved++;
      summary.results.push({
        queueId: String(q.id), fileName: q.file_name, matched: true,
        subjectId: subject.id, subjectName: subject.name,
        score: +verdict.score.toFixed(3), reason: verdict.reason
      });
    } catch (e) {
      summary.failed++;
      store.updateQueue(q.id, { reason: '移動に失敗: ' + e.message });
      summary.results.push({ queueId: String(q.id), fileName: q.file_name, matched: false, reason: e.message });
      emit('file:failed', { queueId: String(q.id), fileName: q.file_name, error: e.message });
    }
  }

  store.finishScan(scanId, summary);
  emit('scan:done', summary);
  return summary;
}

module.exports = {
  runScan, syncQueue, countFilesIn, countAllSubjects,
  uniquePath, moveFile, getText, isCandidate
};
