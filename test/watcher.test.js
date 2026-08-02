'use strict';
/**
 * watcher.test.js — フォルダ監視の割り込み制御
 *   実行: node test/watcher.test.js
 *
 * レビューで指摘された2点の再発防止：
 *   1. デバウンスのタイマーを仕掛けたあとに pause() されても、
 *      タイマーは paused を見ずに onChange を実行してしまっていた。
 *      → アプリ自身がファイルを移動している最中に同期が割り込む恐れがあった。
 *   2. onChange が DEBOUNCE_MS より長くかかると、前回が終わる前に次が始まり
 *      二重に走る余地があった。
 */
const { createWatcher, DEBOUNCE_MS } = require('../src/main/watcher');

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ---------------------------------------------------------- */
  console.log('\n[1] タイマーを仕掛けたあとに pause() されたら実行しない');
  {
    const calls = [];
    const w = createWatcher(r => { calls.push(r); });

    w.touch();                      // デバウンスのタイマーが動き出す
    await sleep(DEBOUNCE_MS / 3);   // 発火前に…
    w.pause();                      // アプリ自身の移動が始まった想定
    await sleep(DEBOUNCE_MS * 2);

    check('停止中は onChange が呼ばれない', calls.length === 0, JSON.stringify(calls));

    w.resume();                     // 移動が終わった
    await sleep(DEBOUNCE_MS * 2);
    check('再開すると見送った分が1回だけ実行される', calls.length === 1, JSON.stringify(calls));
    w.stop();
  }

  /* ---------------------------------------------------------- */
  console.log('\n[2] pause 中に何度変更があっても、再開時の実行は1回だけ');
  {
    const calls = [];
    const w = createWatcher(r => { calls.push(r); });

    w.pause();
    w.touch(); w.touch(); w.touch();
    await sleep(DEBOUNCE_MS * 2);
    check('停止中は0回', calls.length === 0);

    w.resume();
    await sleep(DEBOUNCE_MS * 2);
    check('再開後は1回にまとまる', calls.length === 1, JSON.stringify(calls));
    w.stop();
  }

  /* ---------------------------------------------------------- */
  console.log('\n[3] onChange が長引いても二重に走らない');
  {
    let concurrent = 0, maxConcurrent = 0, calls = 0;
    const SLOW = 600;
    const w = createWatcher(async () => {
      calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(SLOW);
      concurrent--;
    });

    w.touch();
    await sleep(DEBOUNCE_MS + 100);   // 1回目が走り出している
    w.touch();                        // 実行中に変更が来た
    w.touch();
    await sleep(SLOW + DEBOUNCE_MS * 3);

    check('同時に2本走らない', maxConcurrent === 1, 'maxConcurrent=' + maxConcurrent);
    check('実行中の変更はまとめて1回だけ拾い直す', calls === 2, 'calls=' + calls);
    w.stop();
  }

  /* ---------------------------------------------------------- */
  console.log('\n[4] onChange が例外を投げても止まらない');
  {
    let calls = 0;
    const w = createWatcher(() => { calls++; throw new Error('意図的な失敗'); });

    w.touch();
    await sleep(DEBOUNCE_MS * 2);
    check('1回目は実行される', calls === 1);

    w.touch();
    await sleep(DEBOUNCE_MS * 2);
    check('例外のあとも次を受け付ける', calls === 2, 'calls=' + calls);
    w.stop();
  }

  /* ---------------------------------------------------------- */
  console.log('\n[5] stop() したら実行されない');
  {
    const calls = [];
    const w = createWatcher(r => { calls.push(r); });
    w.touch();
    w.stop();
    await sleep(DEBOUNCE_MS * 2);
    check('停止後は呼ばれない', calls.length === 0, JSON.stringify(calls));
  }

  console.log(`\n結果: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
