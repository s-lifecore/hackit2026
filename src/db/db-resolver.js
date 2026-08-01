/**
 * db-resolver.js — sorter（ファイル監視・移動）と DB層をつなぐアダプタ
 * =============================================================================
 * sorter.js は今 `resolveDest(name, this.compiled)` で config.json のルールを見ている。
 * これを DB のルール・別名・学習に差し替えるための橋渡し。
 *
 * ■ sorter.js への変更は3か所だけ
 *
 *   1) constructor に resolver を受け取る
 *        constructor(config, { dryRun = false, journalPath, resolver = null } = {}) {
 *          ...
 *          this.resolver = resolver;                       // ← 追加
 *          this.allowOutside = config.allowOutside ?? true; // ← 追加（科目フォルダは Downloads の外）
 *        }
 *
 *   2) handle() のルール判定を差し替え
 *        // const hit = resolveDest(name, this.compiled);
 *        const hit = this.resolver
 *          ? await this.resolver(name, filePath)
 *          : resolveDest(name, this.compiled);
 *        if (!hit) return this.skip(filePath, 'マッチするルールなし');
 *
 *   3) 宛先の解決（科目フォルダは監視フォルダの外にあるため）
 *        destDir = hit.absolute
 *          ? hit.dest
 *          : resolveDestDir(this.watchDir, hit.dest, { allowOutside: this.allowOutside });
 *
 * ■ 使い方（Electron main）
 *
 *   import * as db from './back/db.js';
 *   import { createResolver, recordMove } from './back/db-resolver.js';
 *   import { Sorter } from './sorter/src/sorter.js';
 *
 *   db.init();
 *   const sorter = new Sorter(config, {
 *     journalPath, resolver: createResolver(db),
 *   });
 *   sorter.on('moved', (rec) => recordMove(db, rec));
 *   await sorter.start();
 * =============================================================================
 */

import path from 'node:path';
import fs from 'node:fs';
import { extractWithCache, SUPPORTED_EXT } from './extract.js';

/**
 * DBを参照して振り分け先を決める関数を作る。
 * 戻り値は sorter が期待する形（{ruleId, ruleName, dest}）に
 * `absolute` などの追加情報を足したもの。
 *
 * @param {object} db  db.js のモジュール
 * @param {{scanContent?:boolean, minConfidence?:number, onUnmatched?:Function}} [opts]
 * @returns {(fileName:string, filePath:string) => Promise<object|null>}
 */
export function createResolver(db, opts = {}) {
  return async function resolve(fileName, filePath) {
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();

    let sizeBytes = null;
    try { sizeBytes = fs.statSync(filePath).size; } catch { /* 消えた等 */ }

    // --- 本文の抽出（キャッシュ付き）---
    let text = null, fileHash = null;
    const scanContent = opts.scanContent ?? db.settings.getBool('content_scan_enabled', true);
    if (scanContent && SUPPORTED_EXT.has(ext)) {
      const r = await extractWithCache(db, filePath, {
        maxChars: db.settings.getNumber('content_scan_max_chars', 20000),
      });
      text = r.text;
      fileHash = r.fileHash;
    }

    // --- 判定（ルール → 別名 → 学習）---
    const hit = db.classify({ fileName, ext, sizeBytes, text }, {
      minConfidence: opts.minConfidence,
    });

    if (!hit.matched) {
      opts.onUnmatched?.({ fileName, filePath, ext, sizeBytes, fileHash, suggestions: hit.suggestions });
      return null; // sorter 側で「マッチするルールなし」としてスキップされる
    }

    // 科目フォルダ配下のサブフォルダ（ルールで指定された場合）
    const dest = hit.subfolder ? path.join(hit.folderPath, hit.subfolder) : hit.folderPath;

    return {
      // --- sorter が使うフィールド ---
      ruleId: hit.ruleId ?? null,
      ruleName: hit.subjectName ?? '(不明)',
      dest,
      absolute: true,
      // --- DB側で使う追加情報（journal にもそのまま載る）---
      subjectId: hit.subjectId,
      subjectName: hit.subjectName,
      source: hit.source,          // 'rule' | 'alias' | 'learning'
      matchedBy: hit.matchedBy,    // 'filename' | 'content' | 'both'
      confidence: hit.confidence,
      week: hit.week,
      date: hit.date,
      ext, sizeBytes, fileHash,
    };
  };
}

/**
 * sorter の 'moved' イベントを履歴テーブルに記録する。
 * @param {object} db
 * @param {object} rec sorter が emit する {src, dest, ruleId, ruleName, ...}
 */
export function recordMove(db, rec) {
  if (rec?.dryRun) return null;
  return db.history.add({
    fileName: path.basename(rec.src),
    sourcePath: rec.src,
    destPath: rec.dest,
    ext: rec.ext ?? path.extname(rec.src).replace(/^\./, '').toLowerCase(),
    sizeBytes: rec.sizeBytes ?? null,
    fileHash: rec.fileHash ?? null,
    subjectId: rec.subjectId ?? null,
    ruleId: rec.ruleId ?? null,
    action: 'move',
    status: 'success',
    matchedBy: rec.matchedBy ?? null,
    score: rec.confidence ?? null,
  });
}

/** 失敗も残す（'failed' イベント用） */
export function recordFailure(db, err, filePath) {
  return db.history.add({
    fileName: path.basename(filePath ?? err?.file ?? ''),
    sourcePath: filePath ?? err?.file ?? '',
    action: 'move',
    status: 'failed',
    errorMessage: `${err?.code ?? ''} ${err?.message ?? err}`.trim(),
  });
}

/**
 * ユーザーが手でファイルを科目フォルダへ入れた／判定を修正したときに呼ぶ。
 * これが「手動配置による自動学習」の入口。
 *
 * @param {object} db
 * @param {{filePath:string, subjectId:number, source?:string}} p
 */
export async function learnFromManualPlacement(db, { filePath, subjectId, source = 'manual_move' }) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();

  let text = null, fileHash = null;
  if (SUPPORTED_EXT.has(ext)) {
    try {
      const r = await extractWithCache(db, filePath);
      text = r.text; fileHash = r.fileHash;
    } catch { /* 本文が取れなくてもファイル名だけで学習する */ }
  }

  return db.learn.record({ subjectId, fileName, ext, text, fileHash, source });
}

/**
 * 振り分け済みの科目フォルダを走査して、既存ファイルから一括学習する。
 * 初回セットアップで「もう手で整理済みの資料」を教師データにできる。
 *
 * @param {object} db
 * @param {{maxPerSubject?:number, scanContent?:boolean}} [opts]
 * @returns {Promise<{learned:number, perSubject:object[]}>}
 */
export async function bootstrapLearningFromFolders(db, opts = {}) {
  const maxPerSubject = opts.maxPerSubject ?? 30;
  const scanContent = opts.scanContent ?? true;
  const perSubject = [];
  let learned = 0;

  for (const s of db.subjects.list()) {
    let count = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(s.folder_path, { withFileTypes: true });
    } catch { perSubject.push({ subject: s.name, learned: 0, error: 'フォルダを開けません' }); continue; }

    for (const e of entries) {
      if (!e.isFile() || count >= maxPerSubject) continue;
      const ext = path.extname(e.name).replace(/^\./, '').toLowerCase();
      if (!SUPPORTED_EXT.has(ext)) continue;

      let text = null;
      if (scanContent) {
        try {
          const r = await extractWithCache(db, path.join(s.folder_path, e.name));
          text = r.text;
        } catch { /* 無視 */ }
      }
      db.learn.record({ subjectId: s.id, fileName: e.name, ext, text, source: 'import' });
      count++; learned++;
    }
    perSubject.push({ subject: s.name, learned: count });
  }
  return { learned, perSubject };
}
