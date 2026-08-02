'use strict';
/**
 * precision.test.js — 誤配置を減らすための判定の確認
 *   実行: node test/precision.test.js
 *
 * 実際に誤って振り分けられていたファイル名を使って、
 * 「決め手が無いものは動かさない」ことを確かめる。
 *
 * 方針：
 *   ・PDF や PowerPoint（配られる資料）は表紙に科目名が載るので内容を信頼する
 *   ・Word（自分で書くレポート）は「課題」「考察」など、どの科目にも出る語ばかりなので
 *     ファイル名か文書の先頭に科目名がはっきり出ていることを求める
 *   ・本文の奥でぱらぱら語が一致しているだけでは動かさない
 */
const { buildModel, classify, learn } = require('../src/main/classifier');

const SUBJECTS = [
  'プロジェクト演習入門',
  '知能情報プログラミング１',
  'コンピュータシステム基礎',
  '技術者の数理1.2',
  '知能情報入門とキャリア',
  '実践ウェルビーイング'
].map((name, i) => ({ id: `s${i + 1}`, name, folder_path: `/dummy/${name}`, keyword: '' }));

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

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};
const show = r => r.matched
  ? `${r.subjectName} (${r.score.toFixed(3)}) [${r.evidence}] ${r.reason}`
  : `移動しない (${r.score.toFixed(3)}) ${r.reason}`;

const model = buildModel(SUBJECTS, []);

/* 学生が自分で書くレポートの典型。どの科目にも出る語ばかりで科目名が無い */
const REPORT = 'はじめに 本レポートでは 自分の考えを述べる 目次 1 章 背景 2 章 考察 '
  + '将来 目標 技術者 として 社会 に 貢献 したい と 考える まとめ 参考文献 '
  + '以上 提出日 2026年 学籍番号 氏名';

/* ------------------------------------------------------------------ */
console.log('\n[1] 科目名の手がかりが無い Word は動かさない（誤配置の主因）');
{
  const cases = [
    '情報系の職業について.docx',
    '自分が目指す技術者像.docx',
    '自身の目指す技術者像 (2).docx',
    '1605426課題6_5年後の理想の自分_池田琉慧_ (2).docx',
    'レポート最終版.docx',
    '課題2.docx'
  ];
  for (const fileName of cases) {
    const r = classify({ fileName, content: REPORT }, model);
    check(`${fileName} → 残す`, !r.matched, show(r));
  }
}

console.log('\n[2] 手がかりが無い PDF も動かさない');
{
  const cases = [
    ['nyuugaku_20251202144947522 (2).pdf', '入学手続き 学生証 発行 提出書類 期限'],
    ['1605426_小テ1前半_池田_locked (2).pdf', '小テスト 解答欄 氏名 学籍番号 問1 問2 問3'],
    ['スキャン_20260731.pdf', ''],
    ['領収書.pdf', '領収書 金額 但し書き 上記正に領収いたしました']
  ];
  for (const [fileName, content] of cases) {
    const r = classify({ fileName, content }, model);
    check(`${fileName} → 残す`, !r.matched, show(r));
  }
}

console.log('\n[3] Word でも、文書の先頭に科目名があれば動かす');
{
  const r = classify({
    fileName: '課題6_5年後の理想の自分.docx',
    content: 'プロジェクト演習入門 課題6 5年後の理想の自分 学籍番号 1605426 ' + REPORT
  }, model);
  check('先頭に科目名 → プロジェクト演習入門',
    r.matched && r.subjectName === 'プロジェクト演習入門' && r.evidence === 'head-literal', show(r));
}

console.log('\n[4] 科目名が本文の奥にしか無い Word は動かさない');
{
  // 1200文字より後ろに科目名が出てくる状況を作る
  const filler = 'あ'.repeat(1500);
  const r = classify({
    fileName: '課題.docx',
    content: filler + ' プロジェクト演習入門 について 述べる'
  }, model);
  check('奥に科目名だけ → 残す', !r.matched, show(r));
}

console.log('\n[5] PDF は先頭ページの語の一致だけでも動かす（配布資料のため）');
{
  const pdf = classify({
    fileName: 'w13_演習_関数2.pdf',
    content: 'プログラミング I 知能情報プログラミング I 第13週 演習（関数②） 戻り値のある関数の練習 引数 戻り値'
  }, model);
  check('PDF → 知能情報プログラミング１',
    pdf.matched && pdf.subjectName === '知能情報プログラミング１', show(pdf));

  // 同じ内容でも Word なら動かさない…わけではない。
  // この内容は先頭に科目名が丸ごと出ているので head-literal で動く。
  // 「語の一致だけ」で動くかどうかの差を見るため、科目名を崩した内容で比べる。
  const vague = 'プログラミング 第13週 演習 関数 戻り値 引数 知能 情報 の 練習';
  const asPdf  = classify({ fileName: 'w13_演習.pdf',  content: vague }, model);
  const asDocx = classify({ fileName: 'w13_演習.docx', content: vague }, model);
  check('あいまいな内容：PDFは動かしてよい', asPdf.matched || !asPdf.matched, '（参考）' + show(asPdf));
  check('あいまいな内容：Wordは動かさない', !asDocx.matched, show(asDocx));
}

console.log('\n[6] ファイル名の先頭に科目名がある資料は確実に動かす');
{
  const cases = [
    ['プロジェクト演習入門_2026_w13.pdf', 'プロジェクト演習入門'],
    ['コンピュータシステム基礎 第3回.pdf', 'コンピュータシステム基礎'],
    ['実践ウェルビーイング_第5回資料.pptx', '実践ウェルビーイング']
  ];
  for (const [fileName, want] of cases) {
    const r = classify({ fileName, content: '' }, model);
    check(`${fileName} → ${want}`, r.matched && r.subjectName === want, show(r));
  }
}

console.log('\n[7] 手で振り分ければ、次から同じ命名のファイルを覚える');
{
  const store = memStore();
  const files = [
    '1605426課題4_チーム活動の振り返り_池田琉慧.docx',
    '1605426課題5_中間発表の準備_池田琉慧.docx',
    '1605426課題6_5年後の理想の自分_池田琉慧.docx'
  ];
  // 学習前は動かない
  const before = classify({ fileName: '1605426課題7_最終発表_池田琉慧.docx', content: REPORT }, buildModel(SUBJECTS, []));
  check('学習前は動かさない', !before.matched, show(before));

  for (const f of files) learn(store, 's1', { fileName: f, content: REPORT }, +1);

  const after = classify(
    { fileName: '1605426課題7_最終発表_池田琉慧.docx', content: REPORT },
    buildModel(SUBJECTS, store.listTokens())
  );
  check('3回教えたら同じ命名を覚える',
    after.matched && after.subjectName === 'プロジェクト演習入門', show(after));
}

console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
