/**
 * startup-scan.js — PC起動時の一括スキャン（常時監視の置き換え）
 * =============================================================================
 * 【方針転換】
 * chokidar による常時監視をやめ、「起動した瞬間に1回だけ見る」方式にした。
 *
 * 常時監視で必要だったものが、まるごと不要になる:
 *   - chokidar の常駐（メモリ・CPU）
 *   - ダウンロード完了判定の三重防御（.crdownload監視 / awaitWriteFinish / 安定性チェック）
 *     → 起動時にはダウンロードはとっくに終わっているため
 *   - 振り分け先を再検知してしまう無限ループ対策
 *
 * ただし「書きかけのファイル」だけは依然としてあり得るので、
 * 中間ファイル（.crdownload/.part 等）はスキップする。
 * =============================================================================
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { extractWithCache, SUPPORTED_EXT } from './extract.js';

/** ダウンロード中の中間ファイル。移動してはいけない */
const TEMP_RE = /\.(crdownload|part|partial|download|opdownload|!ut|aria2|tmp|temp|filepart)$/i;
const isTempName = (name) => TEMP_RE.test(name) || name.startsWith('.') || name.startsWith('~$');

/** 走査対象フォルダを決める（scan_folder → watch_folder → OSのDownloads の順） */
export function resolveScanFolder(db) {
  const explicit = db.settings.get('scan_folder') || db.settings.get('watch_folder');
  if (explicit) return explicit;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, 'Downloads') : null;
}

/**
 * 一括スキャンを実行する。
 *
 * @param {object} db  back/db.js
 * @param {object} [opts]
 * @param {string} [opts.folder]                走査対象。省略時は設定から解決
 * @param {'startup'|'manual'|'setup'} [opts.trigger]
 * @param {(src:string, destDir:string)=>Promise<string>} [opts.moveFn]
 *   実ファイルを移動する関数（ファイル操作担当の mover.js を想定）。
 *   省略した場合はファイルを一切動かさず、判定結果だけをDBに記録する（dry-run相当）。
 * @param {(p:{index:number,total:number,fileName:string})=>void} [opts.onProgress]
 * @returns {Promise<{runId:number, folder:string, scanned:number, moved:number,
 *                    unmatched:number, failed:number, results:Array}>}
 */
export async function runScan(db, opts = {}) {
  const folder = opts.folder || resolveScanFolder(db);
  const trigger = opts.trigger || 'startup';
  const moveFn = opts.moveFn || null;

  const runId = db.getDb()
    .prepare('INSERT INTO scan_runs(trigger) VALUES(?)')
    .run(trigger).lastInsertRowid;

  const summary = { runId, folder, scanned: 0, moved: 0, unmatched: 0, failed: 0, results: [] };

  if (!folder) {
    finishRun(db, runId, summary, 'スキャン対象フォルダが未設定です');
    return summary;
  }

  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (e) {
    finishRun(db, runId, summary, `フォルダを開けません: ${e.message}`);
    return summary;
  }

  const files = entries.filter((e) => e.isFile() && !isTempName(e.name));
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const sourcePath = path.join(folder, entry.name);
    opts.onProgress?.({ index: i + 1, total, fileName: entry.name });
    summary.scanned++;

    try {
      const stat = await fs.stat(sourcePath);
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();

      // 未処理ファイルとしてキューに載せる（UIの一覧はここを見る）
      const queueId = db.queue.add({
        sourcePath, fileName: entry.name, ext, sizeBytes: stat.size,
      });

      // 本文抽出（対応形式のみ・ハッシュでキャッシュ）
      let text = null, fileHash = null;
      if (db.settings.getBool('content_scan_enabled', true) && SUPPORTED_EXT.has(ext)) {
        const r = await extractWithCache(db, sourcePath, {
          maxChars: db.settings.getNumber('content_scan_max_chars', 20000),
        });
        text = r.text;
        fileHash = r.fileHash;
      }

      const hit = db.classify({ fileName: entry.name, ext, sizeBytes: stat.size, text });

      if (!hit.matched) {
        summary.unmatched++;
        db.queue.setStatus(queueId, 'unmatched', { suggested: hit.suggestions });
        summary.results.push({ queueId, fileName: entry.name, matched: false, suggestions: hit.suggestions });
        continue;
      }

      const destDir = hit.subfolder ? path.join(hit.folderPath, hit.subfolder) : hit.folderPath;
      let destPath = path.join(destDir, entry.name);

      if (moveFn) {
        await fs.mkdir(destDir, { recursive: true });
        destPath = await moveFn(sourcePath, destDir);
      }

      db.history.add({
        fileName: entry.name, sourcePath, destPath, ext, sizeBytes: stat.size, fileHash,
        subjectId: hit.subjectId, ruleId: hit.ruleId, matchedBy: hit.matchedBy,
        score: hit.confidence, action: moveFn ? 'move' : 'skip', status: 'success',
      });
      db.queue.setStatus(queueId, 'done', {
        subjectId: hit.subjectId, ruleId: hit.ruleId, score: hit.confidence,
      });

      summary.moved++;
      summary.results.push({
        queueId, fileName: entry.name, matched: true, moved: !!moveFn,
        subjectId: hit.subjectId, subjectName: hit.subjectName, destPath,
        matchedBy: hit.matchedBy, confidence: hit.confidence,
      });
    } catch (e) {
      summary.failed++;
      db.history.add({
        fileName: entry.name, sourcePath, action: 'move', status: 'failed',
        errorMessage: `${e.code ?? ''} ${e.message}`.trim(),
      });
      summary.results.push({ fileName: entry.name, matched: false, error: e.message });
    }
  }

  finishRun(db, runId, summary, null);
  return summary;
}

function finishRun(db, runId, s, error) {
  db.getDb().prepare(
    `UPDATE scan_runs SET finished_at = datetime('now','localtime'),
       scanned = ?, moved = ?, unmatched = ?, failed = ?, error = ?
     WHERE id = ?`
  ).run(s.scanned, s.moved, s.unmatched, s.failed, error, runId);

  db.settings.setMany({
    last_scan_at: new Date().toISOString(),
    last_scan_result: JSON.stringify({
      scanned: s.scanned, moved: s.moved, unmatched: s.unmatched, failed: s.failed, error,
    }),
  });
}

/** 直近のスキャン結果（UIの「前回：◯件」表示用） */
export function getLastScan(db) {
  const row = db.getDb()
    .prepare('SELECT * FROM scan_runs ORDER BY started_at DESC, id DESC LIMIT 1')
    .get();
  return row || null;
}

export function listScanRuns(db, limit = 20) {
  return db.getDb()
    .prepare('SELECT * FROM scan_runs ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(limit);
}
