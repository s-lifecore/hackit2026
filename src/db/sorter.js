import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { compileConfig, resolveDest } from './rules.js';
import { resolveDestDir, isTempName, TEMP_EXT_RE } from './paths.js';
import { moveFile, withRetry, isStable } from './mover.js';
import { Journal } from './journal.js';

/**
 * 振り分け本体（常時監視なし版）。
 * =============================================================================
 * 【方針転換】chokidarによる常時監視は廃止しました。
 * ダウンロードは起動時にはとっくに終わっているため、`sortExisting()` による
 * 一括処理（PC起動時スキャン等から呼ぶ）だけで十分という判断です。
 * chokidar依存（watcher・awaitWriteFinish・add/changeイベント・多重処理防止の
 * inFlight/queue直列化）はまるごと不要になったため削除しています。
 *
 * events: 'moved' | 'skipped' | 'failed' | 'log'
 * =============================================================================
 */
export class Sorter extends EventEmitter {
  constructor(config, { dryRun = false, journalPath } = {}) {
    super();
    this.config = config;
    this.compiled = compileConfig(config);
    this.watchDir = path.resolve(config.watchDir);
    this.dryRun = dryRun;
    this.journal = journalPath ? new Journal(journalPath) : null;
    this.stats = { moved: 0, skipped: 0, errors: 0 };
  }

  /** 1 ファイルを処理する。既存ファイルの一括整理（sortExisting）から呼ぶ。 */
  async handle(filePath) {
    const name = path.basename(filePath);

    if (isTempName(name)) return this.skip(filePath, 'ダウンロード中の一時ファイル');

    const hit = resolveDest(name, this.compiled);
    if (!hit) return this.skip(filePath, 'マッチするルールなし');

    let destDir;
    try {
      destDir = resolveDestDir(this.watchDir, hit.dest);
    } catch (e) {
      return this.skip(filePath, e.message);
    }
    // 既に正しい場所にある（once での再実行時など）
    if (path.resolve(path.dirname(filePath)) === destDir) {
      return this.skip(filePath, '既に振り分け済み');
    }

    // awaitWriteFinish をすり抜けた直接書き込みへの保険
    if (!(await isStable(filePath, { settleMs: this.config.settings.settleMs }))) {
      return this.skip(filePath, '書き込み中またはロック中');
    }

    if (this.dryRun) {
      const planned = path.join(destDir, name);
      this.stats.moved++;
      const rec = { action: 'move', src: filePath, dest: planned, ruleId: hit.ruleId, ruleName: hit.ruleName, dryRun: true };
      await this.journal?.append(rec);
      this.emit('moved', rec);
      return rec;
    }

    try {
      const dest = await withRetry(() => moveFile(filePath, destDir), {
        retries: this.config.settings.retries,
        onRetry: (info) =>
          this.emit('log', `再試行 ${info.attempt}/${info.retries} (${info.error.code}) ${name}`),
      });
      this.stats.moved++;
      const rec = { action: 'move', src: filePath, dest, ruleId: hit.ruleId, ruleName: hit.ruleName };
      await this.journal?.append(rec);
      this.emit('moved', rec);
      return rec;
    } catch (e) {
      if (e.code === 'ENOENT') return this.skip(filePath, '処理前に消えました');
      this.stats.errors++;
      const rec = { action: 'error', src: filePath, dest: destDir, reason: `${e.code ?? ''} ${e.message}`.trim() };
      await this.journal?.append(rec);
      this.emit('failed', Object.assign(e, { file: filePath }));
      return rec;
    }
  }

  async skip(filePath, reason) {
    this.stats.skipped++;
    const rec = { action: 'skip', src: filePath, reason };
    // skip はノイズになるのでジャーナルには残さず、UI 表示のみ
    this.emit('skipped', rec);
    return rec;
  }

  /** 既存ファイルの一括整理。ユーザーが明示的に叩く／起動時スキャンから呼ぶ用。 */
  async sortExisting() {
    await fs.access(this.watchDir); // 無ければここで落として原因を明示する
    const entries = await fs.readdir(this.watchDir, { withFileTypes: true });
    const results = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (TEMP_EXT_RE.test(e.name)) continue;
      results.push(await this.handle(path.join(this.watchDir, e.name)));
    }
    return results;
  }
}
