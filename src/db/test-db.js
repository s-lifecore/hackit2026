'use strict';
/**
 * test-db.js — DB層の動作確認スクリプト
 * 実行:  node test-db.js
 * （メモリ上のDBを使うのでファイルは作られません）
 */

const db = require('./db');

let pass = 0, fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

db.init({ dbPath: ':memory:' });

/* -------------------------------------------------- 設定 */
section('settings');
check('初期値が入っている', db.settings.get('watch_extensions') !== null);
db.settings.set('watch_folder', 'C:\\Users\\test\\Downloads');
check('保存できる', db.settings.get('watch_folder') === 'C:\\Users\\test\\Downloads');
check('booleanが読める', db.settings.getBool('auto_move_enabled') === true);
check('numberが読める', db.settings.getNumber('content_scan_max_chars') === 20000);

/* -------------------------------------------------- 科目 */
section('subjects');
const sMath = db.subjects.create({ name: '線形代数', folderPath: 'D:\\大学\\線形代数', color: '#3b82f6' });
const sProg = db.subjects.create({ name: 'プログラミング演習', folderPath: 'D:\\大学\\プログラミング演習' });
const sEng = db.subjects.create({ name: '英語', folderPath: 'D:\\大学\\英語' });
check('3件作成できた', db.subjects.list().length === 3);
check('名前で引ける', db.subjects.getByName('線形代数').id === sMath);
db.subjects.update(sEng, { color: '#ef4444' });
check('更新できる', db.subjects.get(sEng).color === '#ef4444');
check('重複名は弾かれる', (() => {
  try { db.subjects.create({ name: '英語', folderPath: 'X' }); return false; } catch { return true; }
})());

/* -------------------------------------------------- ルール */
section('rules');
const rMath = db.rules.create({
  subjectId: sMath,
  name: '線形代数（ファイル名）',
  priority: 200,
  conditions: [
    { target: 'filename', operator: 'contains', value: '線形代数' },
    { target: 'extension', operator: 'in', value: 'pdf,docx' },
  ],
});
const rProg = db.rules.create({
  subjectId: sProg,
  name: 'プログラミング（本文キーワード）',
  matchMode: 'any',
  priority: 100,
  subfolder: '課題',
  conditions: [
    { target: 'content', operator: 'contains', value: 'アルゴリズム' },
    { target: 'content', operator: 'contains', value: 'コンパイル' },
    { target: 'filename', operator: 'regex', value: '^ex\\d+_' },
  ],
});
check('conditions付きで取得できる', db.rules.get(rMath).conditions.length === 2);
check('有効ルール一覧', db.rules.getActive().length === 2);

/* -------------------------------------------------- 判定（ファイル名） */
section('classify: ファイル名で判定');
let r = db.classify({ fileName: '線形代数_第3回課題.pdf', ext: 'pdf' });
check('線形代数にマッチ', r.matched && r.subjectId === sMath, JSON.stringify(r));
check('source=rule', r.source === 'rule');
check('matchedBy=filename', r.matchedBy === 'filename', r.matchedBy);
check('フォルダパスが返る', r.folderPath === 'D:\\大学\\線形代数');

r = db.classify({ fileName: '線形代数_まとめ.txt', ext: 'txt' });
check('拡張子条件(AND)で外れる', !r.matched);

/* -------------------------------------------------- 判定（ファイル内容） */
section('classify: ファイル内容で判定');
r = db.classify({
  fileName: '20260415_shiryou.pdf', ext: 'pdf',
  text: '本日はソート アルゴリズム の計算量について扱う。',
});
check('本文キーワードでマッチ', r.matched && r.subjectId === sProg, JSON.stringify(r));
check('matchedBy=content', r.matchedBy === 'content', r.matchedBy);
check('subfolderが返る', r.subfolder === '課題');

r = db.classify({ fileName: 'ex03_report.docx', ext: 'docx' });
check('正規表現条件でマッチ', r.matched && r.subjectId === sProg);

/* -------------------------------------------------- 優先度 */
section('優先度');
const rLow = db.rules.create({
  subjectId: sEng, name: '低優先: pdf全部', priority: 1,
  conditions: [{ target: 'extension', operator: 'equals', value: 'pdf' }],
});
r = db.classify({ fileName: '線形代数_第4回.pdf', ext: 'pdf' });
check('priorityが高い方が勝つ', r.subjectId === sMath, `got ${r.subjectId}`);
db.rules.setEnabled(rLow, false);
check('無効化が反映される', db.rules.getActive().length === 2);

/* -------------------------------------------------- 学習 */
section('learn: 手動配置による自動学習');
check('学習前は候補なし', db.learn.suggest({ fileName: 'なにか.pdf' }).length === 0);

// 英語フォルダに手で入れたファイル群
const engFiles = [
  ['English_Communication_week1.pdf', 'Today we practice listening and speaking about daily life.'],
  ['English_Communication_week2.pdf', 'Reading comprehension exercise. Vocabulary list attached.'],
  ['eibunpou_kadai_01.docx', 'grammar exercise: present perfect tense practice'],
  ['TOEIC_taisaku_part5.pdf', 'TOEIC part5 grammar questions and vocabulary'],
];
for (const [f, t] of engFiles) db.learn.record({ subjectId: sEng, fileName: f, text: t, source: 'manual_move' });

// プログラミング演習フォルダに手で入れたファイル群
const progFiles = [
  ['ensyu_week1_python.pdf', 'Python の基礎。変数とループ、関数の定義について。'],
  ['ensyu_week2_python.pdf', 'リスト内包表記と例外処理。デバッグの方法。'],
  ['kadai_program_03.docx', 'ソート アルゴリズム を実装しなさい。計算量を示すこと。'],
];
for (const [f, t] of progFiles) db.learn.record({ subjectId: sProg, fileName: f, text: t, source: 'manual_move' });

const st = db.learn.stats();
check('サンプル件数', st.totalSamples === 7, String(st.totalSamples));
check('語彙が作られている', st.vocabFilename > 0 && st.vocabContent > 0);

const sug = db.learn.suggest({
  fileName: 'English_Communication_week3.pdf',
  text: 'Listening practice and vocabulary review for daily conversation.',
});
check('英語が第1候補', sug.length > 0 && sug[0].subjectId === sEng,
  JSON.stringify(sug.map((x) => [x.subjectName, x.probability.toFixed(3)])));
check('確率が0-1', sug.every((x) => x.probability >= 0 && x.probability <= 1));

const sug2 = db.learn.suggest({ fileName: 'ensyu_week3_python.pdf', text: 'Python の辞書型とファイル入出力。' });
check('プログラミングが第1候補', sug2[0].subjectId === sProg,
  JSON.stringify(sug2.map((x) => [x.subjectName, x.probability.toFixed(3)])));

// ルールに当たらないファイルは学習で振り分けられる
r = db.classify({ fileName: 'English_Communication_week4.pdf', ext: 'pdf', text: 'vocabulary and listening' }, { minConfidence: 0.5 });
check('classifyが学習にフォールバック', r.matched && r.source === 'learning' && r.subjectId === sEng, JSON.stringify(r));
check('confidenceが入る', r.confidence > 0.5);

// 自信が無いときは suggestions だけ返す（自動移動せずUIで確認させる）
r = db.classify({ fileName: 'python_english_week1.pdf', ext: 'pdf' }, { minConfidence: 0.999 });
check('低確信なら未確定＋候補提示', !r.matched && r.suggestions.length > 0, JSON.stringify(r.suggestions));

// 既知語がまったく無いファイルは推定しない（「サンプルが多い科目」に引っ張られない）
check('未知ファイルは推定しない',
  db.learn.suggest({ fileName: 'zzzqqq_xxyy.pdf' }).length === 0);

/* -------------------------------------------------- 学習→ルール昇格 */
section('learn: ルールへの昇格');
const terms = db.learn.distinctiveTerms(sEng, { target: 'filename', minCount: 2, minRatio: 0.6 });
check('特徴語が抽出できる', terms.length > 0, JSON.stringify(terms.map((t) => t.term)));
const newRuleId = db.learn.promoteToRule(sEng, { target: 'filename', minCount: 2, minRatio: 0.6, topN: 5 });
check('学習ルールが作られる', !!newRuleId);
const learned = db.rules.get(newRuleId);
check('origin=learned', learned.origin === 'learned');
check('match_mode=any', learned.match_mode === 'any');
check('confidenceが0-1', learned.confidence > 0 && learned.confidence <= 1);

/* -------------------------------------------------- 誤判定の修正 */
section('learn: 誤判定の修正（重み2倍）');
const before = db.learn.samples({ subjectId: sMath }).length;
db.learn.record({ subjectId: sMath, fileName: 'gyouretsu_kadai.pdf', text: '行列式と固有値', source: 'correction' });
const after = db.learn.samples({ subjectId: sMath });
check('サンプルが増える', after.length === before + 1);
check('weight=2.0', after[0].weight === 2.0, String(after[0].weight));

/* -------------------------------------------------- キュー */
section('queue');
const qid = db.queue.add({ sourcePath: 'C:\\Downloads\\test1.pdf', sizeBytes: 1000 });
db.queue.add({ sourcePath: 'C:\\Downloads\\test1.pdf', sizeBytes: 2000 }); // 重複
check('重複パスは1件', db.queue.list().length === 1);
check('サイズが更新される', db.queue.get(qid).size_bytes === 2000);
db.queue.setStatus(qid, 'matched', { subjectId: sMath, ruleId: rMath, score: 0.9 });
check('ステータス更新', db.queue.get(qid).status === 'matched');
db.queue.setStatus(qid, 'done');
check('done件数', db.queue.clearDone() === 1);

/* -------------------------------------------------- 本文キャッシュ */
section('content_cache');
db.content.put({ fileHash: 'abc123', text: 'これは本文です', extractor: 'pdf-parse' });
check('保存＆取得', db.content.get('abc123').text === 'これは本文です');
check('文字数が入る', db.content.get('abc123').char_count === 7);
db.content.put({ fileHash: 'abc123', text: '更新後', extractor: 'pdf-parse' });
check('上書きできる', db.content.get('abc123').text === '更新後');
check('件数', db.content.count() === 1);

/* -------------------------------------------------- 履歴 */
section('history');
const h1 = db.history.add({
  fileName: '線形代数_第3回課題.pdf', sourcePath: 'C:\\Downloads\\線形代数_第3回課題.pdf',
  destPath: 'D:\\大学\\線形代数\\線形代数_第3回課題.pdf', ext: 'pdf', sizeBytes: 55000,
  fileHash: 'hash-a', subjectId: sMath, ruleId: rMath, matchedBy: 'filename',
});
db.history.add({
  fileName: 'ex03_report.docx', sourcePath: 'C:\\Downloads\\ex03_report.docx',
  destPath: 'D:\\大学\\プログラミング演習\\課題\\ex03_report.docx', ext: 'docx',
  subjectId: sProg, ruleId: rProg, matchedBy: 'content',
});
db.history.add({
  fileName: 'broken.pdf', sourcePath: 'C:\\Downloads\\broken.pdf',
  status: 'failed', errorMessage: 'EPERM: 権限がありません',
});
check('3件記録', db.history.list().length === 3);
check('科目名がスナップされる', db.history.get(h1).subject_name === '線形代数');
check('ルールのhit_countが増える', db.rules.get(rMath).hit_count === 1);
check('ハッシュで既存を検索', db.history.findByHash('hash-a').id === h1);
db.history.markUndone(h1);
check('元に戻す記録', db.history.get(h1).status === 'undone');
check('科目で絞込', db.history.list({ subjectId: sProg }).length === 1);
check('キーワード検索', db.history.list({ keyword: 'ex03' }).length === 1);

const stats = db.history.stats(30);
check('統計: total', stats.total === 3);
check('統計: failed', stats.failed === 1);
check('統計: 科目別', stats.bySubject.length >= 1, JSON.stringify(stats.bySubject));

/* -------------------------------------------------- 削除の連鎖 */
section('削除とCASCADE');
const rulesBefore = db.rules.list().length;
db.subjects.remove(sEng);
check('科目が消える', db.subjects.get(sEng) === null);
check('紐づくルールも消える', db.rules.list().length < rulesBefore);
check('学習データも消える', db.learn.samples({ subjectId: sEng }).length === 0);

/* -------------------------------------------------- 再構築 */
section('learn.rebuild');
const n = db.learn.rebuild();
check('残っているサンプルから再構築', n === db.learn.stats().totalSamples, `${n}`);
const sug3 = db.learn.suggest({ fileName: 'ensyu_week9_python.pdf', text: 'Python の関数' });
check('再構築後も推定できる', sug3.length > 0 && sug3[0].subjectId === sProg);

/* -------------------------------------------------- メンテナンス */
section('maintenance');
const m = db.maintenance();
check('メンテが動く', typeof m.removedHistory === 'number');

/* -------------------------------------------------- 結果 */
console.log(`\n----------------------------------------`);
console.log(`結果: ${pass} 件成功 / ${fail} 件失敗`);
console.log(`----------------------------------------`);
db.close();
process.exit(fail === 0 ? 0 : 1);
