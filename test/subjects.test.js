'use strict';
/**
 * subjects.test.js — 科目の削除・実在チェックのテスト
 *   実行: node test/subjects.test.js
 *
 * 今回追加した2つの機能を確認する：
 *   1. pruneMissingSubjects() … 起動時、エクスプローラーで削除された科目フォルダをアプリからも取り除く
 *      （逆に、無いフォルダを自動で作り直すことはしない）
 *   2. removeSubject()        … アプリの「削除」操作で科目をアプリの一覧から取り除く
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../src/main/store');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filefly-subj-test-'));
const userData = path.join(root, 'userData');
const folderA = path.join(root, '科目A');
const folderB = path.join(root, '科目B');
fs.mkdirSync(folderA, { recursive: true });
fs.mkdirSync(folderB, { recursive: true });

const store = createStore(userData);
store.replaceSubjects([
  { id: 's1', name: '科目A', folder_path: folderA, keyword: '' },
  { id: 's2', name: '科目B', folder_path: folderB, keyword: '' }
]);
store.bumpToken('s1', 'てすと', 'name', 2);
store.bumpToken('s2', 'てすと2', 'name', 2);

console.log('\n[1] pruneMissingSubjects：フォルダが両方とも存在する場合は何も起きない');
{
  const removed = store.pruneMissingSubjects();
  check('削除された科目は0件', removed.length === 0, JSON.stringify(removed));
  check('科目は2件のまま', store.listSubjects().length === 2);
}

console.log('\n[2] pruneMissingSubjects：エクスプローラーでフォルダAを削除した状態を再現');
{
  fs.rmSync(folderA, { recursive: true, force: true });   // エクスプローラーでの削除を模擬
  const removed = store.pruneMissingSubjects();
  check('科目Aが削除対象として返る', removed.length === 1 && removed[0].name === '科目A', JSON.stringify(removed));
  check('アプリの一覧からも科目Aが消える', store.listSubjects().length === 1 && store.listSubjects()[0].id === 's2');
  check('科目Aの学習データも消える', store.listTokens().every(t => t.subject_id !== 's1'));
  check('科目Bはそのまま残る', store.listSubjects().some(s => s.id === 's2'));
}

console.log('\n[3] pruneMissingSubjects：無くなったフォルダを自動で作り直したりしない');
{
  check('科目Aのフォルダは復活していない', !fs.existsSync(folderA));
}

console.log('\n[4] removeSubject：アプリ操作での削除');
{
  const ok = store.removeSubject('s2');
  check('削除に成功する', ok === true);
  check('科目一覧が空になる', store.listSubjects().length === 0);
  check('科目Bの学習データも消える', store.listTokens().length === 0);
  const ok2 = store.removeSubject('s2');
  check('存在しないIDの削除はfalseを返す', ok2 === false);
}

console.log('\n[5] 保存 → 読み直しでも整合性が保たれる');
{
  store.flush();
  const store2 = createStore(userData);
  check('科目0件のまま復元される', store2.listSubjects().length === 0);
  check('学習データも0件のまま復元される', store2.listTokens().length === 0);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
