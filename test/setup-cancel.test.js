'use strict';
/**
 * setup-cancel.test.js — 「フォルダ作成をキャンセルしたのに作られる」不具合の再発防止
 *   実行: node test/setup-cancel.test.js
 *
 * 起きていたこと：
 *   セットアップで科目名を入れる → フォルダ選択ダイアログでキャンセル
 *   → それでも既定の場所（書類/授業フォルダ）にフォルダが作られ、メイン画面へ進む
 *   → 振り分けが走ってダウンロードフォルダのファイルがそこへ移動
 *   → ユーザーは「作らなかった」と思っているのでそのフォルダを削除
 *   → 移動済みのファイルごと消える
 *
 * 直したこと：
 *   置き場所が渡されていない（空／未選択）ときは、フォルダを1つも作らずエラーにする。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filefly-cancel-test-'));
const documents = path.join(root, 'Documents');
const downloads = path.join(root, 'Downloads');
fs.mkdirSync(documents, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });

/* ---- electron を差し替えて ipc.js を読み込めるようにする ---- */
const handlers = new Map();
const electronStub = {
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { trashItem: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
  app: {
    getPath: (k) => (k === 'documents' ? documents : k === 'downloads' ? downloads : root)
  }
};
const STUB_ID = path.join(root, 'electron-stub.js');
require.cache[STUB_ID] = {
  id: STUB_ID, filename: STUB_ID, loaded: true, children: [], paths: [], exports: electronStub
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...args);
};

const { createStore } = require('../src/main/store');
const { register } = require('../src/main/ipc');

const store = createStore(path.join(root, 'userData'));
register({
  store,
  emit: () => {},
  getWindow: () => null,
  state: {},
  setScanFolder: (f) => store.set('scanFolder', f)
});

const call = (channel, ...args) => handlers.get(channel)({}, ...args);

(async () => {
  console.log('\n[1] 置き場所が未選択（キャンセル）ならフォルダを作らない');
  {
    const before = fs.readdirSync(documents);

    let threw = false;
    try { await call('subjects:createMany', ['線形代数', '英語IIA'], null); }
    catch (_) { threw = true; }

    check('エラーになる（黙って進まない）', threw);
    check('書類フォルダに何も作られていない',
      JSON.stringify(fs.readdirSync(documents)) === JSON.stringify(before),
      fs.readdirSync(documents).join(','));
    check('科目も登録されていない', store.listSubjects().length === 0);
  }

  console.log('\n[2] "~" 付きの既定パスも受け付けない');
  {
    let threw = false;
    try { await call('subjects:createMany', ['線形代数'], '~/Documents/授業フォルダ'); }
    catch (_) { threw = true; }
    check('エラーになる', threw);
    check('科目は0件のまま', store.listSubjects().length === 0);
  }

  console.log('\n[3] 空文字も受け付けない');
  {
    let threw = false;
    try { await call('subjects:createMany', ['線形代数'], '   '); }
    catch (_) { threw = true; }
    check('エラーになる', threw);
    check('科目は0件のまま', store.listSubjects().length === 0);
  }

  console.log('\n[4] きちんとフォルダを選んだ場合はこれまでどおり作られる');
  {
    const base = path.join(root, '授業フォルダ');
    const rows = await call('subjects:createMany', ['線形代数', '英語IIA'], base);
    check('2科目が返る', rows.length === 2, JSON.stringify(rows));
    check('フォルダが実際に作られる',
      fs.existsSync(path.join(base, '線形代数')) && fs.existsSync(path.join(base, '英語IIA')));
    check('科目が2件登録される', store.listSubjects().length === 2);
  }

  console.log('\n[5] 科目名が空ならこれまでどおりエラー');
  {
    let threw = false;
    try { await call('subjects:createMany', [], path.join(root, '授業フォルダ')); }
    catch (_) { threw = true; }
    check('エラーになる', threw);
  }

  Module._resolveFilename = origResolve;
  console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
