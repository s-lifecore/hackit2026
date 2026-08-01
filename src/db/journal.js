import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 追記のみの移動履歴（JSONL）。
 * 「勝手に動いてファイルが消えた」を潰すのがこのアプリの信頼性の要なので、
 * 成功も失敗もスキップも全部ここに残す。Undo もここから作る。
 */
export class Journal {
  constructor(file) {
    this.file = file;
  }

  async append(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, line, 'utf8');
  }

  async readAll() {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // 壊れた行は捨てる（追記途中で落ちた場合）
        }
      })
      .filter(Boolean);
  }

  /**
   * 直近 n 件の move を巻き戻す。
   * 宛先が人の手で動かされている可能性があるので、戻す前に必ず実在を確認する。
   */
  async undoLast(n = 1) {
    const all = await this.readAll();
    const moves = all.filter((e) => e.action === 'move' && !e.undone).slice(-n).reverse();
    const results = [];

    for (const m of moves) {
      try {
        await fs.access(m.dest);
      } catch {
        results.push({ ...m, ok: false, reason: '移動先にファイルがありません' });
        continue;
      }
      try {
        await fs.access(m.src);
        results.push({ ...m, ok: false, reason: '元の場所に同名ファイルが既にあります' });
        continue;
      } catch {
        /* 元の場所が空いている = 戻せる */
      }

      try {
        await fs.mkdir(path.dirname(m.src), { recursive: true });
        await fs.rename(m.dest, m.src);
        await this.append({ action: 'undo', src: m.dest, dest: m.src, ofTs: m.ts });
        results.push({ ...m, ok: true });
      } catch (e) {
        results.push({ ...m, ok: false, reason: e.message });
      }
    }
    return results;
  }
}
