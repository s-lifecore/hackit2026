#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as config from './config.js';
import { Sorter } from './sorter.js';
import { Journal } from './journal.js';
import { compileConfig, resolveDest } from './rules.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const USAGE = `
${C.bold('downloads-sorter')} — ファイル名ルールでダウンロードフォルダを自動振り分け

  ${C.cyan('watch')}            フォルダを監視して、新しく来たファイルを振り分ける
  ${C.cyan('once')}             今フォルダにある既存ファイルを一括で振り分ける
  ${C.cyan('test')} <ファイル名>  そのファイル名がどのルールに当たるか確認する（ファイルは不要）
  ${C.cyan('undo')} [件数]       直近の移動を取り消す（既定 1 件）
  ${C.cyan('init')}             初期設定ファイルを作る
  ${C.cyan('log')} [件数]        移動履歴を表示する

オプション
  --dry-run, -n     実際には移動せず、何が起きるかだけ表示
  --config <path>   設定ファイルのパス
  --dir <path>      監視フォルダを一時的に上書き
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', short: 'n', default: false },
    config: { type: 'string' },
    dir: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0];
const configPath = flags.config ?? config.defaultConfigPath();
const journalPath = config.defaultJournalPath();

const ts = () => C.dim(new Date().toTimeString().slice(0, 8));
const rel = (p) => path.basename(path.dirname(p)) + '/' + path.basename(p);

async function loadConfig() {
  const { created, file } = await config.ensureInit(configPath);
  if (created) {
    console.log(C.green(`初期設定を作成しました: ${file}`));
    console.log(C.dim('ルールを編集してから実行してください。\n'));
  }
  const cfg = await config.load(file);
  if (flags.dir) cfg.watchDir = path.resolve(flags.dir);
  return cfg;
}

function attach(sorter) {
  const tag = sorter.dryRun ? C.yellow('[DRY]') : C.green('[MOVE]');
  sorter.on('moved', (r) =>
    console.log(`${ts()} ${tag} ${path.basename(r.src)} ${C.dim('→')} ${rel(r.dest)}  ${C.dim(r.ruleName)}`),
  );
  sorter.on('skipped', (r) => console.log(`${ts()} ${C.dim(`[skip] ${path.basename(r.src)} — ${r.reason}`)}`));
  sorter.on('log', (m) => console.log(`${ts()} ${C.dim(m)}`));
  sorter.on('failed', (e) => console.error(`${ts()} ${C.red('[ERR]')} ${e.file ?? ''} ${e.message}`));
}

async function cmdWatch() {
  const cfg = await loadConfig();
  const sorter = new Sorter(cfg, { dryRun: flags['dry-run'], journalPath });
  attach(sorter);
  sorter.on('ready', (i) =>
    console.log(
      `${C.bold('監視中')} ${i.watchDir}${i.dryRun ? C.yellow('  (dry-run: 移動しません)') : ''}\n` +
        C.dim(`ルール ${cfg.rules.length} 件 / Ctrl+C で終了\n`),
    ),
  );
  await sorter.start();

  const shutdown = async () => {
    console.log(`\n${C.dim('終了中…')}`);
    await sorter.stop();
    const s = sorter.stats;
    console.log(C.dim(`移動 ${s.moved} / スキップ ${s.skipped} / エラー ${s.errors}`));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdOnce() {
  const cfg = await loadConfig();
  const sorter = new Sorter(cfg, { dryRun: flags['dry-run'], journalPath });
  attach(sorter);
  console.log(`${C.bold('一括整理')} ${sorter.watchDir}${sorter.dryRun ? C.yellow('  (dry-run)') : ''}\n`);
  await sorter.sortExisting();
  const s = sorter.stats;
  console.log(`\n移動 ${C.green(s.moved)} / スキップ ${s.skipped} / エラー ${s.errors ? C.red(s.errors) : 0}`);
}

async function cmdTest() {
  const cfg = await loadConfig();
  const compiled = compileConfig(cfg);
  const names = positionals.slice(1);
  if (!names.length) return console.log('ファイル名を指定してください。例: downloads-sorter test 請求書_8月.pdf');
  for (const n of names) {
    const hit = resolveDest(n, compiled);
    console.log(
      hit
        ? `${n}\n  ${C.green('→')} ${hit.dest}/  ${C.dim(`(ルール: ${hit.ruleName})`)}`
        : `${n}\n  ${C.dim('→ マッチなし（移動しません）')}`,
    );
  }
}

async function cmdUndo() {
  const n = Number(positionals[1] ?? 1);
  const results = await new Journal(journalPath).undoLast(n);
  if (!results.length) return console.log('取り消せる移動がありません。');
  for (const r of results) {
    console.log(
      r.ok
        ? `${C.green('戻しました')} ${path.basename(r.dest)} → ${rel(r.src)}`
        : `${C.yellow('スキップ')} ${path.basename(r.dest)} — ${r.reason}`,
    );
  }
}

async function cmdLog() {
  const n = Number(positionals[1] ?? 20);
  const all = await new Journal(journalPath).readAll();
  for (const e of all.slice(-n)) {
    const t = C.dim(e.ts.slice(0, 19).replace('T', ' '));
    if (e.action === 'move') console.log(`${t} ${e.dryRun ? C.yellow('DRY ') : ''}${path.basename(e.src)} → ${rel(e.dest)}`);
    else if (e.action === 'undo') console.log(`${t} ${C.cyan('UNDO')} ${path.basename(e.src)} → ${rel(e.dest)}`);
    else console.log(`${t} ${C.red('ERR ')} ${path.basename(e.src)} — ${e.reason}`);
  }
  if (!all.length) console.log('履歴がありません。');
}

async function cmdInit() {
  const { created, file } = await config.ensureInit(configPath);
  console.log(created ? C.green(`作成しました: ${file}`) : `既にあります: ${file}`);
}

const commands = { watch: cmdWatch, once: cmdOnce, test: cmdTest, undo: cmdUndo, log: cmdLog, init: cmdInit };

if (flags.help || !cmd || !commands[cmd]) {
  console.log(USAGE);
  process.exit(cmd && !commands[cmd] ? 1 : 0);
}

try {
  await commands[cmd]();
} catch (e) {
  console.error(C.red(`エラー: ${e.message}`));
  process.exit(1);
}
