'use strict';
/**
 * sync.test.js — エクスプローラー追従まわりのテスト
 *   実行: node test/sync.test.js
 *
 * 確認すること：
 *   1. countFilesIn()  … 件数がフォルダの実物と一致する（履歴ではなく実ファイルを数える）
 *   2. syncQueue()     … 監視フォルダの増減にファイル一覧が追従する。ファイルは移動しない
 *   3. countAllSubjects() … 科目ごとの件数をまとめて返す
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { countFilesIn, countAllSubjects, syncQueue } = require('../src/main/scanner');
const { createStore } = require('../src/main/store');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filefly-sync-test-'));
const userData = path.join(root, 'userData');
const downloads = path.join(root, 'ダウンロード');
const subjA = path.join(root, '線形代数');
const subjB = path.join(root, '英語IIA');
for (const d of [downloads, subjA, subjB]) fs.mkdirSync(d, { recursive: true });

/** isCandidate の MIN_AGE_MS（5秒）を避けるため、作成直後に更新時刻を過去へずらす */
function makeFile(dir, name, body = 'dummy content') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(p, old, old);
  return p;
}

/* ================================================================== */
(async () => {
  /* ---- 1. countFilesIn ---- */
  console.log('\n[1] countFilesIn：フォルダの中の実ファイルを数える');
  check('空のフォルダは0件', await countFilesIn(subjA) === 0);

  makeFile(subjA, '第1回_行列.pdf');
  makeFile(subjA, '第2回_行列式.pdf');
  check('2件入れたら2件', await countFilesIn(subjA) === 2);

  // OS の管理ファイルと隠しファイルは数えない
  fs.writeFileSync(path.join(subjA, 'desktop.ini'), '');
  fs.writeFileSync(path.join(subjA, '.hidden'), '');
  check('desktop.ini と隠しファイルは数えない', await countFilesIn(subjA) === 2);

  // エクスプローラーで1件消した状態
  fs.unlinkSync(path.join(subjA, '第1回_行列.pdf'));
  check('エクスプローラーで消したら件数も減る', await countFilesIn(subjA) === 1);

  // 中でさらに自分で整理している場合も数える
  const inner = path.join(subjA, '課題');
  fs.mkdirSync(inner);
  makeFile(inner, 'レポート.docx');
  check('サブフォルダの中も数える', await countFilesIn(subjA) === 2);

  check('存在しないフォルダは0件（例外を投げない）',
    await countFilesIn(path.join(root, 'ないフォルダ')) === 0);

  /* ---- 2. countAllSubjects ---- */
  console.log('\n[2] countAllSubjects：科目ごとの件数をまとめて返す');
  const store = createStore(userData);
  store.set('scanFolder', downloads);
  store.replaceSubjects([
    { id: 's1', name: '線形代数', folder_path: subjA, keyword: '' },
    { id: 's2', name: '英語IIA', folder_path: subjB, keyword: '' }
  ]);

  let counts = await countAllSubjects(store);
  check('線形代数は2件', counts.s1 === 2, JSON.stringify(counts));
  check('英語IIAは0件', counts.s2 === 0, JSON.stringify(counts));

  makeFile(subjB, 'unit3_vocab.pdf');
  counts = await countAllSubjects(store);
  check('あとから足した分も反映される', counts.s2 === 1, JSON.stringify(counts));

  /* ---- 3. syncQueue ---- */
  console.log('\n[3] syncQueue：監視フォルダの増減に一覧が追従する');
  check('最初は一覧が空', store.listQueue().length === 0);

  makeFile(downloads, '第3回_資料.pdf');
  makeFile(downloads, 'メモ.txt');
  let r = await syncQueue(store);
  check('新しい2件を検出する', r.added === 2, JSON.stringify(r));
  check('一覧が2件になる', store.listQueue().length === 2);

  const before = fs.readdirSync(downloads).sort();
  await syncQueue(store);
  check('ファイルは移動していない（表示を合わせるだけ）',
    JSON.stringify(fs.readdirSync(downloads).sort()) === JSON.stringify(before));

  r = await syncQueue(store);
  check('2回目は重複して増えない', r.added === 0 && store.listQueue().length === 2);

  // エクスプローラーでダウンロードフォルダから1件削除
  fs.unlinkSync(path.join(downloads, 'メモ.txt'));
  r = await syncQueue(store);
  check('消えた未処理ファイルは一覧から外れる', r.removed === 1, JSON.stringify(r));
  check('一覧が1件になる', store.listQueue().length === 1);

  // 振り分け済み（status: done）の項目は、監視フォルダに無くても消さない
  const q = store.listQueue()[0];
  const moved = path.join(subjA, '第3回_資料.pdf');
  fs.renameSync(q.source_path, moved);
  store.updateQueue(q.id, { status: 'done', subject_id: 's1', current_path: moved, source_path: moved });
  r = await syncQueue(store);
  check('振り分け済みの項目は勝手に消さない', store.listQueue().length === 1, JSON.stringify(r));

  // 監視フォルダが未設定でも落ちない
  const store2 = createStore(path.join(root, 'userData2'));
  const r2 = await syncQueue(store2);
  check('監視フォルダ未設定でも例外にならない', r2.added === 0 && r2.error === null);

  console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
