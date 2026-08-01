import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  version: 1,
  watchDir: path.join(os.homedir(), 'Downloads'),
  settings: {
    stabilityThreshold: 2000, // awaitWriteFinish: 書き込み停止と見なすまでの待ち(ms)
    pollInterval: 100,
    settleMs: 300, // 移動直前の追加チェック間隔(ms)
    retries: 4,
    notifyDebounceMs: 3000,
  },
  rules: [],
  fallback: { enabled: false, dest: '未分類' },
};

/** 何も設定していない人がそのまま使える初期ルール。 */
export const STARTER_RULES = [
  {
    id: 'screenshots',
    name: 'スクリーンショット',
    enabled: true,
    match: { kind: 'regex', pattern: '^(Screenshot|スクリーンショット|Screen Shot|CleanShot)' },
    dest: '画像/スクリーンショット',
  },
  {
    id: 'invoice',
    name: '請求書・領収書',
    enabled: true,
    match: { kind: 'glob', pattern: '*{請求書,領収書,invoice,receipt}*' },
    dest: '書類/請求書/{yyyy}/{MM}',
  },
  {
    id: 'images',
    name: '画像',
    enabled: true,
    match: { kind: 'ext', pattern: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp'] },
    dest: '画像',
  },
  {
    id: 'docs',
    name: '書類',
    enabled: true,
    match: { kind: 'ext', pattern: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'csv'] },
    dest: '書類',
  },
  {
    id: 'archives',
    name: '圧縮ファイル',
    enabled: true,
    match: { kind: 'ext', pattern: ['zip', 'rar', '7z', 'gz', 'tar', 'dmg', 'pkg', 'iso'] },
    dest: 'アーカイブ',
  },
  {
    id: 'media',
    name: '動画・音声',
    enabled: true,
    match: { kind: 'ext', pattern: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'm4a'] },
    dest: 'メディア',
  },
  {
    id: 'installers',
    name: 'インストーラ',
    enabled: true,
    match: { kind: 'ext', pattern: ['exe', 'msi', 'deb', 'rpm', 'appimage'] },
    dest: 'インストーラ',
  },
];

/** アプリのデータ置き場（設定・ジャーナル）。Electron に載せたら app.getPath('userData') に差し替える。 */
export function dataDir() {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'downloads-sorter');
}

export const defaultConfigPath = () => path.join(dataDir(), 'config.json');
export const defaultJournalPath = () => path.join(dataDir(), 'journal.jsonl');

export function validate(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['config がオブジェクトではありません'];
  if (typeof config.watchDir !== 'string' || !config.watchDir) errors.push('watchDir が未設定です');
  if (!Array.isArray(config.rules)) errors.push('rules が配列ではありません');
  else
    config.rules.forEach((r, i) => {
      if (!r.match?.kind) errors.push(`rules[${i}]: match.kind がありません`);
      if (!r.dest) errors.push(`rules[${i}]: dest がありません`);
      if (r.match?.kind !== 'ext' && typeof r.match?.pattern !== 'string')
        errors.push(`rules[${i}]: pattern が文字列ではありません`);
    });
  return errors;
}

export async function load(file = defaultConfigPath()) {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  const merged = {
    ...DEFAULT_CONFIG,
    ...parsed,
    settings: { ...DEFAULT_CONFIG.settings, ...(parsed.settings ?? {}) },
  };
  const errors = validate(merged);
  if (errors.length) throw new Error(`設定エラー:\n  - ${errors.join('\n  - ')}`);
  return merged;
}

/** tmp へ書いて rename。保存中に落ちても設定が飛ばない。 */
export async function save(config, file = defaultConfigPath()) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

export async function ensureInit(file = defaultConfigPath()) {
  try {
    await fs.access(file);
    return { created: false, file };
  } catch {
    await save({ ...DEFAULT_CONFIG, rules: STARTER_RULES }, file);
    return { created: true, file };
  }
}
