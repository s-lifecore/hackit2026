import fs from 'node:fs/promises';
import path from 'node:path';
import { extOf, stemOf } from './rules.js';

/**
 * ルールの dest（相対パス）を絶対パスへ解決する。
 * 既定では watchDir の外へ出ることを禁止（"../.." のようなテンプレート事故を防ぐ）。
 */
export function resolveDestDir(watchDir, dest, { allowOutside = false } = {}) {
  const base = path.resolve(watchDir);
  const abs = path.resolve(base, dest);
  if (!allowOutside && abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`宛先が監視フォルダの外を指しています: ${dest}`);
  }
  return abs;
}

/**
 * 衝突しないパスを「予約」する。
 *
 * 存在チェック → rename は TOCTOU になるので、fs.open(..., 'wx') で
 * 0 バイトのプレースホルダを原子的に作って番号を確定させる。
 * 返ったパスには必ず空ファイルが存在するので、rename で被せて使う。
 */
export async function reserveUniquePath(target, { max = 1000 } = {}) {
  const dir = path.dirname(target);
  const name = path.basename(target);
  const stem = stemOf(name);
  const ext = extOf(name);

  for (let i = 0; i <= max; i++) {
    const candidate = i === 0 ? target : path.join(dir, `${stem} (${i})${ext}`);
    try {
      const fh = await fs.open(candidate, 'wx');
      await fh.close();
      return candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`空き番号が見つかりません（${max} まで試行）: ${target}`);
}

/** ダウンロード中の中間ファイル。ブラウザ/DLマネージャごとに異なる。 */
export const TEMP_EXT_RE =
  /\.(crdownload|part|partial|download|opdownload|!ut|aria2|tmp|temp|filepart)$/i;

export function isTempName(filename) {
  return TEMP_EXT_RE.test(filename) || filename.startsWith('.') || filename.startsWith('~$');
}
