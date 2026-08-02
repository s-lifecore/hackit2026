'use strict';
/**
 * scan.test.js — スキャン〜移動〜学習〜取り消しの通し確認（Electron不要）
 *   実行: node test/scan.test.js
 *
 * 一時フォルダに「ダウンロードフォルダ」と「科目フォルダ」を作り、
 * 実際にファイルを置いてスキャンを走らせ、正しい場所へ移動するかを確かめる。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../src/main/store');
const { runScan } = require('../src/main/scanner');
const { learn } = require('../src/main/classifier');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filefly-test-'));
const downloads = path.join(root, 'Downloads');
const base = path.join(root, '授業フォルダ');
const userData = path.join(root, 'userData');
fs.mkdirSync(downloads, { recursive: true });

const SUBJECT_NAMES = [
  'コンピュータシステム基礎', 'プロジェクト演習入門', '技術者の数理1.2',
  '就学基礎A', '知能情報プログラミング１', '知能情報入門とキャリア'
];

const store = createStore(userData);
store.set('scanFolder', downloads);
store.set('setupCompleted', true);
store.replaceSubjects(SUBJECT_NAMES.map((name, i) => {
  const folder = path.join(base, name);
  fs.mkdirSync(folder, { recursive: true });
  return { id: `s${i + 1}`, name, folder_path: folder, keyword: '' };
}));

const events = [];
const emit = (ch, payload) => events.push([ch, payload]);

/** 更新時刻を過去にずらす（スキャンは5秒以内の新しいファイルを掴まない） */
function put(name, content) {
  const p = path.join(downloads, name);
  fs.writeFileSync(p, content, 'utf8');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(p, old, old);
  return p;
}

const inDownloads = () => fs.readdirSync(downloads).sort();
const inSubject = (name) => {
  const d = path.join(base, name);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

(async () => {
  console.log('\n[1] スキャンして振り分ける');
  put('コンピュータシステム基礎_第3回メモ.txt', 'CPUとメモリの階層について');
  put('就学基礎A_レポート下書き.md', '# 就学基礎A\n提出用の下書き');
  put('買い物メモ.txt', '牛乳 卵 パン 洗剤 ティッシュ');
  put('prg1_202604_w13p_演習_関数2.txt', 'プログラミングI 知能情報プログラミングI 第13週 演習 関数 引数 戻り値');

  const s1 = await runScan({ store, emit }, 'manual');
  check('4件を検出した', s1.scanned === 4, `scanned=${s1.scanned}`);
  check('コンピュータシステム基礎へ移動', inSubject('コンピュータシステム基礎').length === 1, JSON.stringify(inSubject('コンピュータシステム基礎')));
  check('就学基礎Aへ移動', inSubject('就学基礎A').length === 1, JSON.stringify(inSubject('就学基礎A')));
  check('内容から 知能情報プログラミング１ へ移動', inSubject('知能情報プログラミング１').length === 1, JSON.stringify(inSubject('知能情報プログラミング１')));
  check('買い物メモはダウンロードに残る', inDownloads().includes('買い物メモ.txt'), JSON.stringify(inDownloads()));
  check('残ったのは買い物メモだけ', inDownloads().length === 1, JSON.stringify(inDownloads()));
  check('scan:done が飛んだ', events.some(e => e[0] === 'scan:done'));
  check('file:unmatched が飛んだ', events.some(e => e[0] === 'file:unmatched'));

  console.log('\n[2] 同じ名前のファイルを再ダウンロードしても処理される');
  put('コンピュータシステム基礎_第3回メモ.txt', 'CPUとメモリの階層について（改訂版）');
  const s2 = await runScan({ store, emit }, 'manual');
  // 前回振り分けられなかった「買い物メモ」も毎回もう一度判定される（ルールを直したら拾えるように）
  check('新しい1件＋未分類の1件を判定した', s2.scanned === 2, `scanned=${s2.scanned}`);
  check('新しい方だけ移動した', s2.moved === 1, `moved=${s2.moved}`);
  check('上書きせず2件になっている', inSubject('コンピュータシステム基礎').length === 2, JSON.stringify(inSubject('コンピュータシステム基礎')));
  check('別名で保存されている', inSubject('コンピュータシステム基礎').some(f => f.includes('(2)')), JSON.stringify(inSubject('コンピュータシステム基礎')));

  console.log('\n[3] 履歴とカウント');
  const counts = store.countBySubject();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  check('移動件数の合計が4件', total === 4, JSON.stringify(counts));

  console.log('\n[4] 手動振り分けの学習が次のスキャンに効く');
  // ユーザーが「レポート_A班.txt」を プロジェクト演習入門 へ手動で入れた、を3回学習
  for (let i = 0; i < 3; i++) {
    learn(store, 's2', { fileName: `hanA_report_v${i}.txt`, content: 'A班 試作 発表' }, +1);
  }
  put('hanA_report_v9.txt', '試作の写真を貼る');   // 中身は判定の手がかりにならない
  const s4 = await runScan({ store, emit }, 'manual');
  check('学習した名前パターンで自動振り分け', inSubject('プロジェクト演習入門').includes('hanA_report_v9.txt'),
    JSON.stringify({ moved: s4.moved, folder: inSubject('プロジェクト演習入門'), left: inDownloads() }));

  console.log('\n[5] 保存と読み直し');
  store.flush();
  const store2 = createStore(userData);
  check('科目が復元される', store2.listSubjects().length === SUBJECT_NAMES.length);
  check('履歴が復元される', Object.values(store2.countBySubject()).reduce((a, b) => a + b, 0) === 5);
  check('学習した語が復元される', store2.listTokens().length > 0, `tokens=${store2.listTokens().length}`);
  check('キャッシュが別ファイルになっている', fs.existsSync(path.join(userData, 'text-cache.json')));

  console.log('\n[6] 壊れたJSONから復旧する');
  fs.writeFileSync(path.join(userData, 'filefly.json'), '{壊れている', 'utf8');
  const store3 = createStore(userData);
  check('例外を投げずに初期状態で起動する', store3.listSubjects().length === 0);
  check('壊れたファイルは退避される', fs.readdirSync(userData).some(f => f.includes('.broken-')));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
