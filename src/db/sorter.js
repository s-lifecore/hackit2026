import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';

import { compileConfig, resolveDest } from './rules.js';
import { resolveDestDir, isTempName, TEMP_EXT_RE } from './paths.js';
import { moveFile, withRetry, isStable } from './mover.js';
import { Journal } from './journal.js';

/**
 * 振り分け本体。Electron に載せるときはこのクラスを main プロセスで new して、
 * emit されるイベントを webContents.send で renderer に流すだけでよい。
 *
 * events: 'moved' | 'skipped' | 'failed' | 'ready' | 'log'
 */
export class Sorter extends EventEmitter {
  constructor(config, { dryRun = false, journalPath } = {}) {
    super();
    this.config = config;
    this.compiled = compileConfig(config);
    this.watchDir = path.resolve(config.watchDir);
    this.dryRun = dryRun;
    this.journal = journalPath ? new Journal(journalPath) : null;

    this.watcher = null;
    this.inFlight = new Set(); // 同一パスの多重処理を防ぐ
    this.queue = Promise.resolve(); // 直列化。並列だと採番が競合する
    this.stats = { moved: 0, skipped: 0, errors: 0 };
  }

  async start() {
    await fs.access(this.watchDir); // 無ければここで落として原因を明示する

    const s = this.config.settings;
    this.watcher = chokidar.watch(this.watchDir, {
      // 直下のみ。振り分け先サブフォルダを見ない = 無限ループが原理的に起きない
      depth: 0,
      ignoreInitial: true, // 起動時の既存ファイルは触らない（整理は `once` で明示的に）
      awaitWriteFinish: {
        stabilityThreshold: s.stabilityThreshold,
        pollInterval: s.pollInterval,
      },
      // chokidar v4+ は glob 不可。関数で弾く
      ignored: (p, stats) => {
        if (p === this.watchDir) return false;
        if (stats?.isDirectory()) return true;
        return isTempName(path.basename(p));
      },
    });

    this.watcher
      .on('add', (p) => this.enqueue(p))
      // change も拾う。chokidar の atomic 判定により、
      // 「振り分け直後に同名を再ダウンロード」すると unlink+add が change に化ける。
      // 二重処理は inFlight と「移動後は元パスが消える」ことで防げる。
      .on('change', (p) => this.enqueue(p))
      .on('error', (e) => {
        this.stats.errors++;
        this.emit('failed', e);
      })
      .on('ready', () => this.emit('ready', { watchDir: this.watchDir, dryRun: this.dryRun }));

    return this;
  }

  async stop() {
    await this.watcher?.close();
    await this.queue; // 処理中のものを取りこぼさない
    this.watcher = null;
  }

  enqueue(filePath) {
    if (this.inFlight.has(filePath)) return;
    this.inFlight.add(filePath);
    this.queue = this.queue
      .then(() => this.handle(filePath))
      .catch((e) => {
        this.stats.errors++;
        this.emit('failed', e);
      })
      .finally(() => this.inFlight.delete(filePath));
    return this.queue;
  }

  /** 1 ファイルを処理する。既存ファイルの一括整理（once）からも呼ぶ。 */
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

  /** 既存ファイルの一括整理。監視とは独立に、ユーザーが明示的に叩く用。 */
  async sortExisting() {
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
