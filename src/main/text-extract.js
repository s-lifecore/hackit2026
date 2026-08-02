'use strict';
/**
 * text-extract.js — ファイル内容からテキストを取り出す
 *
 * 対応：PDF（重点）／ Office（docx, pptx, xlsx）／ テキスト系（UTF-8・Shift_JIS）
 * 非対応の形式は空文字を返し、その場合はファイル名だけで判定される。
 */
const fsp = require('fs/promises');
const path = require('path');

const MAX_CHARS = 120000;   // 抽出テキストの上限
const MAX_PDF_PAGES = 15;   // PDFは先頭ページに科目名が載っていることが多い
const MAX_FILE_BYTES = 80 * 1024 * 1024;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.rb',
  '.go', '.rs', '.php', '.sql', '.sh', '.bat', '.ini', '.cfg', '.yml', '.yaml',
  '.ipynb', '.tex', '.r', '.m', '.swift', '.kt'
]);
const OOXML = { '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx', '.docm': 'docx', '.pptm': 'pptx', '.xlsm': 'xlsx' };

function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
}

/* ---------------- PDF ---------------- */
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdfjs-dist 3.x の legacy ビルドは CommonJS で Electron の main プロセスから直接使える。
      // 4.x 以降は ESM のみになるため、package.json でバージョンを固定している。
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
      try {
        pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
      } catch {
        // ワーカーが見つからなくても、メインプロセス側の fake worker で動作する
      }
      return pdfjs;
    })().catch(err => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

async function extractPdf(file) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(file));
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  }).promise;
  try {
    const parts = [];
    const n = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map(it => (it && it.str) || '').join(' '));
      page.cleanup();
      if (parts.join(' ').length > MAX_CHARS) break;
    }
    return clip(parts.join('\n'));
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

/* ---------------- Office (OOXML) ---------------- */
function xmlText(xml, tagRe) {
  const out = [];
  let m;
  while ((m = tagRe.exec(xml)) !== null) out.push(m[1]);
  return out.join(' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractOoxml(file, kind) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  const read = (name) => {
    const e = entries.find(x => x.entryName === name);
    return e ? e.getData().toString('utf8') : '';
  };
  const parts = [];

  // コア プロパティ（タイトル・作成者・件名）はどの形式にもある
  const core = read('docProps/core.xml');
  if (core) parts.push(xmlText(core, /<dc:(?:title|subject|description)>([^<]*)<\/dc:(?:title|subject|description)>/g));

  if (kind === 'docx') {
    parts.push(xmlText(read('word/document.xml'), /<w:t[^>]*>([^<]*)<\/w:t>/g));
  } else if (kind === 'pptx') {
    const slides = entries
      .filter(e => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(e.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
    for (const s of slides) {
      parts.push(xmlText(s.getData().toString('utf8'), /<a:t>([^<]*)<\/a:t>/g));
      if (parts.join(' ').length > MAX_CHARS) break;
    }
  } else if (kind === 'xlsx') {
    parts.push(xmlText(read('xl/sharedStrings.xml'), /<t[^>]*>([^<]*)<\/t>/g));
    const sheets = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName)).slice(0, 5);
    for (const s of sheets) {
      parts.push(xmlText(s.getData().toString('utf8'), /<is><t[^>]*>([^<]*)<\/t><\/is>/g));
      if (parts.join(' ').length > MAX_CHARS) break;
    }
  }
  return clip(parts.join('\n'));
}

/* ---------------- テキスト系 ---------------- */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / Math.max(1, n) > 0.1;
}

function decode(buf) {
  // BOM
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le');
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0 || bad / Math.max(1, utf8.length) < 0.002) return utf8;
  // 日本語のレポートは Shift_JIS のことがある
  try {
    const iconv = require('iconv-lite');
    return iconv.decode(buf, 'Shift_JIS');
  } catch { return utf8; }
}

async function extractText(file) {
  const buf = await fsp.readFile(file);
  return clip(looksBinary(buf) ? '' : decode(buf));
}

/* ---------------- エントリポイント ---------------- */
/**
 * @returns {Promise<{text:string, kind:string, ok:boolean, error?:string}>}
 */
async function extract(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    const st = await fsp.stat(file);
    if (st.size > MAX_FILE_BYTES) return { text: '', kind: 'too-large', ok: false };
    if (ext === '.pdf') return { text: await extractPdf(file), kind: 'pdf', ok: true };
    if (OOXML[ext]) return { text: extractOoxml(file, OOXML[ext]), kind: OOXML[ext], ok: true };
    if (TEXT_EXT.has(ext)) return { text: await extractText(file), kind: 'text', ok: true };
    // 拡張子が未知でも、小さいファイルならテキストとして読めるか試す
    if (st.size <= 2 * 1024 * 1024) {
      const t = await extractText(file);
      if (t.length > 20) return { text: t, kind: 'text?', ok: true };
    }
    return { text: '', kind: 'binary', ok: true };
  } catch (e) {
    return { text: '', kind: ext || 'unknown', ok: false, error: e.message };
  }
}

module.exports = { extract, TEXT_EXT, OOXML };
