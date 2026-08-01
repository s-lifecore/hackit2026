/**
 * extract.js — PDF / Word などから本文テキストを取り出す（ESM）
 * =============================================================================
 * 依存はすべて純JS。ネイティブモジュールを使わないので exe 化しても壊れない。
 *
 *   npm i pdfjs-dist mammoth
 *
 * どちらも動的 import しているため、未インストールでもアプリは落ちず、
 * 「本文なし」として扱われる（ファイル名だけで判定できる）。
 * =============================================================================
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 本文として保持する最大文字数。先頭だけで科目判定には十分 */
export const DEFAULT_MAX_CHARS = 20000;

/** 本文抽出に対応している拡張子 */
export const SUPPORTED_EXT = new Set(['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'htm']);

const cleanExt = (p) => path.extname(p).replace(/^\./, '').toLowerCase();

/** 連続する空白・改行を潰す（PDFは無駄な空白が多い） */
function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================================================================
 * ファイルハッシュ（content_cache のキー / 重複検出に使う）
 * ==========================================================================*/

/**
 * ファイルの SHA-1 を計算する。ストリームで読むので巨大ファイルでもメモリを食わない。
 * @returns {Promise<string>}
 */
export function hashFile(filePath, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/* ============================================================================
 * 形式ごとの抽出
 * ==========================================================================*/

async function extractPdf(filePath, maxChars) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  let text = '';
  const pages = doc.numPages;
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // items[].str を連結。行の区切りが失われるので hasEOL を見て改行を入れる
    let line = '';
    for (const it of tc.items) {
      line += it.str;
      if (it.hasEOL) { text += line + '\n'; line = ''; }
    }
    if (line) text += line + '\n';
    text += '\n';
    if (text.length >= maxChars) break;
  }
  await doc.destroy?.();
  return { text, pages, extractor: 'pdfjs-dist' };
}

async function extractDocx(filePath) {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const { value } = await mammoth.extractRawText({ path: filePath });
  return { text: value, extractor: 'mammoth' };
}

async function extractPlain(filePath) {
  return { text: await fs.readFile(filePath, 'utf8'), extractor: 'utf8' };
}

/* ============================================================================
 * 入口
 * ==========================================================================*/

/**
 * ファイルから本文を取り出す。失敗しても例外は投げない。
 *
 * @param {string} filePath
 * @param {{maxChars?:number}} [opts]
 * @returns {Promise<{
 *   text: string|null, extractor: string|null, truncated: boolean,
 *   pages: number|null, ext: string, error: string|null
 * }>}
 */
export async function extractText(filePath, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const ext = cleanExt(filePath);
  const base = { text: null, extractor: null, truncated: false, pages: null, ext, error: null };

  if (!SUPPORTED_EXT.has(ext)) {
    return { ...base, error: `未対応の拡張子: ${ext || '(なし)'}` };
  }

  try {
    let r;
    if (ext === 'pdf') r = await extractPdf(filePath, maxChars);
    else if (ext === 'docx') r = await extractDocx(filePath);
    else r = await extractPlain(filePath);

    const tidied = tidy(r.text);
    const truncated = tidied.length > maxChars;
    return {
      ...base,
      text: truncated ? tidied.slice(0, maxChars) : tidied,
      extractor: r.extractor,
      truncated,
      pages: r.pages ?? null,
    };
  } catch (e) {
    // ライブラリ未インストール / 破損PDF / パスワード付き など
    const missing = e?.code === 'ERR_MODULE_NOT_FOUND';
    return {
      ...base,
      error: missing
        ? `ライブラリ未インストール（npm i pdfjs-dist mammoth）: ${e.message}`
        : `${e.code ?? ''} ${e.message}`.trim(),
    };
  }
}

/**
 * DBのキャッシュを使って本文を取り出す。同じファイルの再解析を防ぐ。
 *
 * @param {object} db   db.js のモジュール
 * @param {string} filePath
 * @returns {Promise<{text:string|null, fileHash:string|null, cached:boolean, error:string|null}>}
 */
export async function extractWithCache(db, filePath, opts = {}) {
  let fileHash = null;
  try {
    fileHash = await hashFile(filePath);
  } catch (e) {
    return { text: null, fileHash: null, cached: false, error: `ハッシュ計算に失敗: ${e.message}` };
  }

  const hit = db.content.get(fileHash);
  if (hit) return { text: hit.text, fileHash, cached: true, error: null };

  const r = await extractText(filePath, opts);
  if (r.text != null) {
    db.content.put({
      fileHash, text: r.text, extractor: r.extractor, truncated: r.truncated,
    });
  }
  return { text: r.text, fileHash, cached: false, error: r.error };
}
