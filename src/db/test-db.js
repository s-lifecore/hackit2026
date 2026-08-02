/**
 * test-db.js — DB層の動作確認スクリプト（ESM）
 * 実行:  node back/test-db.js
 * メモリ上のDBを使うのでファイルは作られません。
 */

import * as db from './db.js';
import { parseFileName, normalizeText, normalizeSubjectKey } from './learner.js';

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

db.init({ dbPath: ':memory:' });

/* -------------------------------------------------- 正規化 */
section('NFKC正規化（実ファイルで見つかったバグ）');
check('丸数字 ⑧ → 8', normalizeText('ICT入門⑧') === 'ict入門8', normalizeText('ICT入門⑧'));
check('全角数字 １ → 1', normalizeText('イングリッシュトピックス１') === 'イングリッシュトピックス1');
check('全角英字 Ａ → a', normalizeText('就学基礎Ａ') === '就学基礎a');
check('半角カナ ｱ → ア', normalizeText('ｱｲｳ') === 'アイウ');
check('全角と半角が同一視される',
  normalizeText('プログラミング１') === normalizeText('プログラミング1'));

/* -------------------------------------------------- ファイル名解析 */
section('ファイル名の構造解析（実ファイル3種）');
const p1 = parseFileName('PD入門_2026_w13_おもちゃ開発3.pdf');
check('先頭トークン = PD入門', p1.head === 'pd入門', p1.head);
check('週番号 w13 → 13', p1.week === 13, String(p1.week));
check('年 2026', p1.date?.year === 2026, JSON.stringify(p1.date));
check('週番号は語彙に混ざらない', !p1.tokens.includes('w13'), JSON.stringify(p1.tokens));

const p2 = parseFileName('prg1_202604_w11p_演習.pdf');
check('先頭トークン = prg1', p2.head === 'prg1', p2.head);
check('数字を除いた形 = prg', p2.headStem === 'prg', p2.headStem);
check('週番号 w11p → 11', p2.week === 11, String(p2.week));
check('年月 202604 → 2026-04', p2.date?.year === 2026 && p2.date?.month === 4, JSON.stringify(p2.date));
check('演習が語として残る', p2.tokens.includes('演習'), JSON.stringify(p2.tokens));

const p3 = parseFileName('ICT入門⑧.pdf');
check('丸数字が展開される', p3.normalized === 'ict入門8', p3.normalized);
check('先頭から科目名が取れる', p3.headStem === 'ict入門', p3.headStem);

/* -------------------------------------------------- 設定 */
section('settings');
check('初期値が入っている', db.settings.get('watch_extensions') !== null);
db.settings.set('watch_folder', 'C:\\Users\\test\\Downloads');
check('保存できる', db.settings.get('watch_folder') === 'C:\\Users\\test\\Downloads');
check('v2の設定が追加されている', db.settings.get('subject_root') !== null);

/* -------------------------------------------------- 科目 */
section('subjects');
const sPD = db.subjects.create({ name: 'プロジェクト演習入門', folderPath: 'D:\\大学\\プロジェクト演習入門' });
const sPRG = db.subjects.create({ name: '知能情報プログラミング１', folderPath: 'D:\\大学\\知能情報プログラミング１' });
const sICT = db.subjects.create({ name: 'ICT入門', folderPath: 'D:\\大学\\ICT入門,データサイエンス入門' });
const sDS = db.subjects.create({ name: 'データサイエンス入門', folderPath: 'D:\\大学\\ICT入門,データサイエンス入門' });
check('4件作成できた', db.subjects.list().length === 4);
check('同じフォルダを2科目が指せる', db.subjects.getByFolder('D:\\大学\\ICT入門,データサイエンス入門').length === 2);
check('重複名は弾かれる', (() => {
  try { db.subjects.create({ name: 'ICT入門', folderPath: 'X' }); return false; } catch { return true; }
})());

section('フォルダ名の分割');
check('カンマ区切りが2つに割れる',
  db.splitFolderName('ICT入門,データサイエンス入門').length === 2);
check('読点でも割れる', db.splitFolderName('数学、物理').length === 2);
check('区切りなしは1つ', db.splitFolderName('健康・体力づくり').length === 1);

/* -------------------------------------------------- 別名 */
section('aliases（科目名では当たらない問題への対策）');
check('科目名が自動で別名になる', db.aliases.list(sICT).some((a) => a.alias === 'ict入門'));

// ICT入門 は科目名がそのまま入っているので、別名登録なしで当たる
let r = db.classify({ fileName: 'ICT入門⑧.pdf', ext: 'pdf' });
check('ICT入門は登録不要で当たる', r.matched && r.subjectId === sICT, JSON.stringify(r));
check('先頭一致として判定される', r.source === 'alias' && r.confidence >= 0.9, `${r.source}/${r.confidence}`);
check('週番号も一緒に返る', r.week === 8, String(r.week));

// prg1 / PD入門 は共通文字がほぼ無いので別名が必須
check('prg1は別名なしでは当たらない', !db.classify({ fileName: 'prg1_202604_w11p_演習.pdf' }).matched);

db.aliases.add(sPRG, 'prg1');
db.aliases.add(sPRG, 'prg');
db.aliases.add(sPD, 'PD入門');

r = db.classify({ fileName: 'prg1_202604_w11p_演習.pdf', ext: 'pdf' });
check('別名登録で prg1 が当たる', r.matched && r.subjectId === sPRG, JSON.stringify(r));

r = db.classify({ fileName: 'PD入門_2026_w13_おもちゃ開発3.pdf', ext: 'pdf' });
check('別名登録で PD入門 が当たる', r.matched && r.subjectId === sPD, JSON.stringify(r));
check('長い別名が優先される（PD入門 > 入門）', r.subjectId === sPD);

check('別名も全角半角を吸収する',
  db.classify({ fileName: 'ＰＲＧ1_2026_w2_課題.pdf' }).subjectId === sPRG);

// 本文に科目名があれば、ファイル名が無意味でも当たる
r = db.classify({
  fileName: '20260415_shiryou.pdf', ext: 'pdf',
  text: '知能情報プログラミング１　第11回　演習課題について',
});
check('本文の科目名で当たる', r.matched && r.subjectId === sPRG, JSON.stringify(r));
check('matchedBy=content', r.matchedBy === 'content', r.matchedBy);

/* -------------------------------------------------- 実PDFで判明した問題 */
section('実PDFの調査から見つかった問題');

// 問題1: フォルダは全角「１」、資料本文はラテン文字「I」（ローマ数字）
check('ローマ数字Iと全角１が同一視される',
  normalizeSubjectKey('知能情報プログラミングI') === normalizeSubjectKey('知能情報プログラミング１'),
  `${normalizeSubjectKey('知能情報プログラミングI')} vs ${normalizeSubjectKey('知能情報プログラミング１')}`);
check('II → 2', normalizeSubjectKey('プログラミングII') === 'プログラミング2');
check('英単語は壊さない', normalizeSubjectKey('データサイエンス入門') === 'データサイエンス入門');
check('記号と空白を無視する',
  normalizeSubjectKey('Ｉ ＣＴ入門') === normalizeSubjectKey('ICT入門'),
  normalizeSubjectKey('Ｉ ＣＴ入門'));

// 問題2: 授業スライドは全ページのフッターに科目名が入るが、他科目にも言及する。
//        「含まれるか」で判定すると、より長い他科目名に負けて誤爆する。
const ictBody = [
  'ＩＣＴ入門 ⑧ 第8回 第6週 PowerPoint',
  ...Array(12).fill('2026/3/4  ICT入門  ページ'),          // 全ページのフッター
  '次回より、データサイエンス入門（ＤＳ入門）が始まります。',  // 他科目への言及
  '提出期限は次々回（データサイエンス入門の第2回）の授業前日とします。',
  'データサイエンス入門の小テストに着手可能となっています。',
].join('\n');

r = db.classify({ fileName: '20260304_shiryou.pdf', ext: 'pdf', text: ictBody });
check('出現回数で正しい科目が勝つ（ICT入門 > データサイエンス入門）',
  r.matched && r.subjectId === sICT, JSON.stringify({ s: r.subjectName, occ: r.occurrences }));
check('繰り返し出現なら確信度が高い', r.confidence >= 0.9, String(r.confidence));

// 問題3: prg1 の資料は本文フッターに正式名称がある
const prgBody = [
  'プログラミングI 知能情報プログラミングI 第11週 (6/30) 演習（複雑な繰り返し）',
  ...Array(5).fill('プログラミングI・知能情報プログラミングI 第11週'),
].join('\n');

r = db.classify({ fileName: 'zzz_unknown_20260630.pdf', ext: 'pdf', text: prgBody });
check('ファイル名が無意味でも本文で特定できる',
  r.matched && r.subjectId === sPRG, JSON.stringify({ s: r.subjectName, occ: r.occurrences }));

/* -------------------------------------------------- ルール */
section('rules');
db.rules.create({
  subjectId: sPD, name: 'PD入門の課題', priority: 200, subfolder: '課題',
  conditions: [
    { target: 'filename', operator: 'contains', value: 'pd入門' },
    { target: 'extension', operator: 'in', value: 'pdf,docx' },
  ],
});
r = db.classify({ fileName: 'PD入門_2026_w13_おもちゃ開発3.pdf', ext: 'pdf' });
check('ルールが別名より優先される', r.source === 'rule', r.source);
check('subfolderが返る', r.subfolder === '課題');

const rLow = db.rules.create({
  subjectId: sDS, name: '低優先: pdf全部', priority: 1,
  conditions: [{ target: 'extension', operator: 'equals', value: 'pdf' }],
});
r = db.classify({ fileName: 'PD入門_2026_w13.pdf', ext: 'pdf' });
check('priorityが高い方が勝つ', r.subjectId === sPD, String(r.subjectId));
db.rules.setEnabled(rLow, false);

check('丸数字のファイルも判定できる', db.classify({ fileName: 'ICT入門⑧.pdf' }).matched);

/* -------------------------------------------------- 学習 */
section('learn: 手動配置による自動学習');
const engFiles = [
  ['eng_w01_listening.pdf', 'Today we practice listening and speaking about daily life.'],
  ['eng_w02_reading.pdf', 'Reading comprehension exercise. Vocabulary list attached.'],
  ['eng_w03_grammar.docx', 'grammar exercise: present perfect tense practice'],
];
const sEng = db.subjects.create({ name: 'イングリッシュトピックス１', folderPath: 'D:\\大学\\イングリッシュトピックス１' });
for (const [f, t] of engFiles) db.learn.record({ subjectId: sEng, fileName: f, text: t });

const dsFiles = [
  ['ds_w01_toukei.pdf', '記述統計と平均・分散について学ぶ'],
  ['ds_w02_kaiki.pdf', '回帰分析の基礎。最小二乗法を扱う'],
  ['ds_w03_bunrui.pdf', '分類問題と評価指標について'],
];
for (const [f, t] of dsFiles) db.learn.record({ subjectId: sDS, fileName: f, text: t });

const st = db.learn.stats();
check('サンプル件数', st.totalSamples === 6, String(st.totalSamples));
check('語彙が作られている', st.vocabFilename > 0 && st.vocabContent > 0);
check('先頭トークンが別名として自動登録される',
  db.aliases.list(sEng).some((a) => a.alias === 'eng'), JSON.stringify(db.aliases.list(sEng).map((a) => a.alias)));

const sug = db.learn.suggest({ fileName: 'zzz_w04_speaking.pdf', text: 'listening and vocabulary practice' });
check('英語が第1候補', sug.length > 0 && sug[0].subjectId === sEng,
  JSON.stringify(sug.map((x) => [x.subjectName, x.probability.toFixed(3)])));

const sug2 = db.learn.suggest({ fileName: 'zzz_w04_kentei.pdf', text: '回帰分析と統計の演習' });
check('データサイエンスが第1候補', sug2[0].subjectId === sDS,
  JSON.stringify(sug2.map((x) => [x.subjectName, x.probability.toFixed(3)])));

check('未知ファイルは推定しない', db.learn.suggest({ fileName: 'qqqxxx_zzzyyy.pdf' }).length === 0);

// 学習1回で先頭トークンが効くか（HEAD_BOOST の検証）
const sHealth = db.subjects.create({ name: '健康・体力づくり', folderPath: 'D:\\大学\\健康・体力づくり' });
db.learn.record({ subjectId: sHealth, fileName: 'kenkou_w01_guidance.pdf', text: '運動習慣とストレッチ' });
r = db.classify({ fileName: 'kenkou_w05_stretch.pdf', ext: 'pdf' }, { minConfidence: 0.5 });
check('1回の手動配置で次から当たる', r.matched && r.subjectId === sHealth, JSON.stringify(r));

/* -------------------------------------------------- 誤判定の修正 */
section('learn: 誤判定の修正');
db.learn.record({ subjectId: sPRG, fileName: 'kadai_program.pdf', text: 'C言語の課題', source: 'correction' });
check('weight=2.0', db.learn.samples({ subjectId: sPRG })[0].weight === 2.0);

/* -------------------------------------------------- 学習→ルール昇格 */
section('learn: ルールへの昇格');
const newRuleId = db.learn.promoteToRule(sEng, { minCount: 2, minRatio: 0.6, topN: 5 });
check('学習ルールが作られる', !!newRuleId);
if (newRuleId) {
  const learned = db.rules.get(newRuleId);
  check('origin=learned', learned.origin === 'learned');
  check('match_mode=any', learned.match_mode === 'any');
}

/* -------------------------------------------------- キュー・キャッシュ */
section('queue / content_cache');
const qid = db.queue.add({ sourcePath: 'C:\\Downloads\\test1.pdf', sizeBytes: 1000 });
db.queue.add({ sourcePath: 'C:\\Downloads\\test1.pdf', sizeBytes: 2000 });
check('重複パスは1件', db.queue.list().length === 1);
check('サイズが更新される', db.queue.get(qid).size_bytes === 2000);
db.queue.setStatus(qid, 'done');
check('done削除', db.queue.clearDone() === 1);

db.content.put({ fileHash: 'abc123', text: 'これは本文です', extractor: 'pdfjs-dist' });
check('保存＆取得', db.content.get('abc123').text === 'これは本文です');
check('文字数', db.content.get('abc123').char_count === 7);

/* -------------------------------------------------- 履歴 */
section('history');
const h1 = db.history.add({
  fileName: 'prg1_202604_w11p_演習.pdf', sourcePath: 'C:\\Downloads\\prg1_202604_w11p_演習.pdf',
  destPath: 'D:\\大学\\知能情報プログラミング１\\prg1_202604_w11p_演習.pdf',
  ext: 'pdf', fileHash: 'hash-a', subjectId: sPRG, matchedBy: 'filename',
});
db.history.add({ fileName: 'broken.pdf', sourcePath: 'C:\\Downloads\\broken.pdf', status: 'failed', errorMessage: 'EPERM' });
check('2件記録', db.history.list().length === 2);
check('科目名がスナップされる', db.history.get(h1).subject_name === '知能情報プログラミング１');
check('ハッシュで既存を検索', db.history.findByHash('hash-a').id === h1);
db.history.markUndone(h1);
check('元に戻す記録', db.history.get(h1).status === 'undone');
const stats = db.history.stats(30);
check('統計: total', stats.total === 2);
check('統計: failed', stats.failed === 1);

/* -------------------------------------------------- 削除の連鎖 */
section('削除とCASCADE');
const aliasBefore = db.aliases.list().length;
db.subjects.remove(sEng);
check('科目が消える', db.subjects.get(sEng) === null);
check('別名も消える', db.aliases.list().length < aliasBefore);
check('学習データも消える', db.learn.samples({ subjectId: sEng }).length === 0);

section('learn.rebuild');
const n = db.learn.rebuild();
check('残ったサンプルから再構築', n === db.learn.stats().totalSamples, String(n));

section('maintenance');
check('メンテが動く', typeof db.maintenance().removedHistory === 'number');

/* -------------------------------------------------- 結果 */
console.log('\n----------------------------------------');
console.log(`結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log('----------------------------------------');
db.close();
process.exit(fail === 0 ? 0 : 1);
