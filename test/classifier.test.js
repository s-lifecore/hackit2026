'use strict';
/**
 * classifier.test.js — 振り分けロジックの動作確認
 *   実行: node test/classifier.test.js
 * 実際の科目フォルダ名と授業資料のテキストを使って、
 * 「正しく振り分かるか」「迷ったときに動かさずに済むか」を確かめる。
 */
const { buildModel, classify, learn } = require('../src/main/classifier');

/* 実際の科目フォルダ名 */
const SUBJECTS = [
  'ICT入門,データサイエンス入門',
  'イングリッシュトピックス１',
  'コンピュータシステム基礎',
  'プロジェクト演習入門',
  '技術者の数理1.2',
  '健康・体力づくり',
  '実践ウェルビーイング',
  '就学基礎A',
  '知能情報プログラミング１',
  '知能情報入門とキャリア'
].map((name, i) => ({ id: `s${i + 1}`, name, folder_path: `/dummy/${name}`, keyword: '' }));

/* 学習データを溜めるだけの最小ストア */
function memStore() {
  const rows = new Map();
  return {
    bumpToken(sid, token, field, delta) {
      const k = `${sid} ${token} ${field}`;
      const cur = rows.get(k) || { subject_id: sid, token, field, weight: 0 };
      cur.weight = Math.max(0, cur.weight + delta);
      rows.set(k, cur);
    },
    listTokens() { return [...rows.values()].filter(r => r.weight > 0.01); }
  };
}

const store = memStore();
const model = () => buildModel(SUBJECTS, store.listTokens());

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
}
function show(r) {
  return r.matched
    ? `${r.subjectName} (${r.score.toFixed(3)}) ${r.reason}`
    : `振り分けなし (${r.score.toFixed(3)}) ${r.reason}`;
}

/* ------------------------------------------------------------------ */
console.log('\n[1] ファイル名だけで判定できるケース');
{
  const m = model();
  const cases = [
    ['コンピュータシステム基礎_第3回.pdf', 'コンピュータシステム基礎'],
    ['知能情報入門とキャリア_レポート.docx', '知能情報入門とキャリア'],
    ['技術者の数理1.2 演習問題.pdf', '技術者の数理1.2'],
    ['就学基礎A_課題提出.docx', '就学基礎A'],
    ['実践ウェルビーイング第5回資料.pptx', '実践ウェルビーイング']
  ];
  for (const [fileName, want] of cases) {
    const r = classify({ fileName, content: '' }, m);
    check(`${fileName} → ${want}`, r.matched && r.subjectName === want, show(r));
  }
}

console.log('\n[2] 内容から判定できるケース（ファイル名は無関係）');
{
  const m = model();
  const r = classify({
    fileName: 'prg1_202604_w13p_演習_関数2.pdf',
    content: 'プログラミングI 知能情報プログラミングI 第13週 演習（関数②） 戻り値のある関数の練習 引数 戻り値 文字列を返すように変更'
  }, m);
  check('prg1_... → 知能情報プログラミング１', r.matched && r.subjectName === '知能情報プログラミング１', show(r));
}

console.log('\n[3] 関係ないファイルは動かさない');
{
  const m = model();
  const cases = [
    ['請求書_2026年7月分.pdf', 'アルバイトの請求書 支払い 振込先 口座 金額 消費税'],
    ['setup_guide.pdf', 'インストール手順 ライセンス条項に同意 次へ 完了'],
    ['IMG_20260731_142233.jpg', ''],
    ['旅行のしおり.pdf', '集合場所 東京駅 新幹線 宿泊 温泉 夕食 自由行動']
  ];
  for (const [fileName, content] of cases) {
    const r = classify({ fileName, content }, m);
    check(`${fileName} → 残す`, !r.matched, show(r));
  }
}

console.log('\n[4] 似た科目で迷ったときは動かさない');
{
  const m = model();
  // 「知能情報」だけでは プログラミング１ か 入門とキャリア か決められない
  const r = classify({ fileName: '知能情報_第5回.pdf', content: '' }, m);
  check('知能情報_第5回.pdf → 残す（曖昧）', !r.matched, show(r));
}

console.log('\n[5] 手動振り分けから学習する');
{
  // 1回目：prg1 という名前だけでは判定できない
  const before = classify({ fileName: 'prg1_202605_w14p_演習_配列.pdf', content: '' }, model());
  check('学習前は判定できない', !before.matched, show(before));

  // ユーザーが「知能情報プログラミング１」へドラッグした、を3回学習
  for (let i = 0; i < 3; i++) {
    learn(store, 's9', {
      fileName: `prg1_20260${i}_w1${i}p_演習_関数.pdf`,
      content: 'プログラミングI 知能情報プログラミングI 演習 関数 引数 戻り値'
    }, +1);
  }

  const after = classify({ fileName: 'prg1_202605_w14p_演習_配列.pdf', content: '' }, model());
  check('学習後は自動で振り分く', after.matched && after.subjectName === '知能情報プログラミング１', show(after));

  // 取り消すと学習も巻き戻る
  for (let i = 0; i < 3; i++) {
    learn(store, 's9', {
      fileName: `prg1_20260${i}_w1${i}p_演習_関数.pdf`,
      content: 'プログラミングI 知能情報プログラミングI 演習 関数 引数 戻り値'
    }, -1);
  }
  const undone = classify({ fileName: 'prg1_202605_w14p_演習_配列.pdf', content: '' }, model());
  check('取り消すと学習前に戻る', !undone.matched, show(undone));
}

console.log('\n[6] キーワード指定が最優先で効く');
{
  const withKw = SUBJECTS.map(s => s.id === 's4' ? { ...s, keyword: 'PD入門' } : s);
  const m = buildModel(withKw, []);
  const r = classify({ fileName: 'PD入門_2026_w13_おもちゃ開発3.pdf', content: '' }, m);
  check('キーワード「PD入門」で プロジェクト演習入門 へ', r.matched && r.subjectName === 'プロジェクト演習入門', show(r));
}

console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
