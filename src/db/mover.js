import fs from 'node:fs/promises';
import path from 'node:path';
import { reserveUniquePath } from './paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OS/AV がファイルを掴んでいるときに出るコード。時間を置けば直る類い。 */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENFILE', 'EMFILE']);

/**
 * 書き込みが本当に終わっているかの最終確認。
 * chokidar の awaitWriteFinish をすり抜けたケースを拾う。
 *  - サイズが settleMs 空けて 2 回一致するか
 *  - 追記モードで開けるか（Windows のロック検出）
 */
export async function isStable(file, { settleMs = 300 } = {}) {
  try {
    const a = await fs.stat(file);
    await sleep(settleMs);
    const b = await fs.stat(file);
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false;

    const fh = await fs.open(file, 'r+'); // ロック中なら EBUSY/EPERM
    await fh.close();
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false; // 既に消えた/リネームされた
    if (RETRYABLE.has(e.code)) return false;
    throw e;
  }
}

/**
 * src を destDir へ移動する。
 *  - 同名があれば "name (1).ext" へ採番（Explorer/Finder と同じ流儀）
 *  - 別ボリューム（EXDEV）では copy → rename → unlink にフォールバック
 * @returns {Promise<string>} 実際の移動先パス
 */
export async function moveFile(src, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const target = await reserveUniquePath(path.join(destDir, path.basename(src)));

  try {
    await fs.rename(src, target); // プレースホルダを上書きして確定
    return target;
  } catch (e) {
    if (e.code !== 'EXDEV') {
      await fs.rm(target, { force: true }); // 予約したプレースホルダを片付ける
      throw e;
    }
  }

  // 別ボリューム: 途中で落ちても中途半端な本名ファイルが残らないよう .part 経由
  const staging = `${target}.part`;
  try {
    await fs.copyFile(src, staging);
    await fs.rename(staging, target);
    await fs.unlink(src);
    return target;
  } catch (e) {
    await fs.rm(staging, { force: true });
    await fs.rm(target, { force: true });
    throw e;
  }
}

/** 一時的なエラーだけ指数バックオフでリトライする。 */
export async function withRetry(fn, { retries = 4, baseMs = 500, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.has(e.code) || attempt === retries) throw e;
      const wait = baseMs * 2 ** attempt;
      onRetry?.({ attempt: attempt + 1, retries, waitMs: wait, error: e });
      await sleep(wait);
    }
  }
  throw lastErr;
}
