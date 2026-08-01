/**
 * ルールエンジン: 「ファイル名 → 宛先の相対パス」を決める純関数群。
 * fs には一切触らない。ここが純粋なので dry-run とテストがそのまま書ける。
 */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * glob を正規表現へ。ファイル名だけが対象なので `/` は扱わない。
 * 対応: `*` `?` `[abc]` `[!abc]` `{a,b,c}`
 * （chokidar は v4 で glob を捨てたので、必要な分だけ自前で持つ）
 */
export function globToRegExp(pattern, { caseSensitive = false } = {}) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) re += '\\{';
      else {
        const alts = pattern.slice(i + 1, end).split(',').map(esc);
        re += `(?:${alts.join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      // 文字クラスはそのまま通す（閉じ括弧が無ければリテラル扱い）
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = end;
      }
    } else re += esc(c);
  }
  return new RegExp(`^${re}$`, caseSensitive ? 'u' : 'iu');
}

const REGEX_MAX_LEN = 500;

/** ユーザー入力の正規表現を安全側で作る。長すぎるものは弾く（ReDoS 対策の一次防御）。 */
export function compileUserRegExp(pattern, { caseSensitive = false } = {}) {
  if (typeof pattern !== 'string' || pattern.length > REGEX_MAX_LEN) {
    throw new Error(`正規表現が長すぎます（上限 ${REGEX_MAX_LEN} 文字）`);
  }
  return new RegExp(pattern, caseSensitive ? 'u' : 'iu');
}

/** match 定義をコンパイルして述語関数にする。ルール読み込み時に一度だけ呼ぶ。 */
export function compileMatch(match) {
  const cs = match.caseSensitive === true;
  switch (match.kind) {
    case 'glob': {
      const re = globToRegExp(match.pattern, { caseSensitive: cs });
      return (name) => re.test(name);
    }
    case 'regex': {
      const re = compileUserRegExp(match.pattern, { caseSensitive: cs });
      return (name) => re.test(name);
    }
    case 'contains': {
      const needle = cs ? match.pattern : match.pattern.toLowerCase();
      return (name) => (cs ? name : name.toLowerCase()).includes(needle);
    }
    case 'ext': {
      // ".pdf" / "pdf" / ["pdf","png"] のいずれも受ける
      const list = (Array.isArray(match.pattern) ? match.pattern : [match.pattern])
        .map((e) => String(e).replace(/^\./, '').toLowerCase());
      return (name) => {
        // "archive.tar.gz" は "tar.gz" と "gz" の両方で照合する
        const full = extOf(name).replace(/^\./, '').toLowerCase();
        if (full === '') return false;
        const last = full.slice(full.lastIndexOf('.') + 1);
        return list.includes(full) || list.includes(last);
      };
    }
    default:
      throw new Error(`未知の match.kind: ${match.kind}`);
  }
}

/** ".tar.gz" のような二段拡張子も 1 つとして扱う */
const DOUBLE_EXT = /\.(tar|user)\.[a-z0-9]+$/i;
export function extOf(filename) {
  const d = filename.match(DOUBLE_EXT);
  if (d) return d[0];
  const i = filename.lastIndexOf('.');
  return i <= 0 ? '' : filename.slice(i);
}
export function stemOf(filename) {
  const ext = extOf(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

const p2 = (n) => String(n).padStart(2, '0');

/**
 * 宛先テンプレートのトークン展開。
 * {yyyy} {yy} {MM} {dd} {HH} {mm} {ext} {EXT} {name} {stem}
 */
export function expandTokens(template, filename, date = new Date()) {
  const map = {
    yyyy: String(date.getFullYear()),
    yy: p2(date.getFullYear() % 100),
    MM: p2(date.getMonth() + 1),
    dd: p2(date.getDate()),
    HH: p2(date.getHours()),
    mm: p2(date.getMinutes()),
    ext: extOf(filename).replace(/^\./, '').toLowerCase(),
    EXT: extOf(filename).replace(/^\./, '').toUpperCase(),
    name: filename,
    stem: stemOf(filename),
  };
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(map, key) ? map[key] : whole,
  );
}

/** config.rules をコンパイル済みの形にする。無効なルールはここで例外になる。 */
export function compileConfig(config) {
  const rules = (config.rules ?? [])
    .filter((r) => r.enabled !== false)
    .map((r) => {
      if (!r.dest) throw new Error(`ルール "${r.name ?? r.id}" に dest がありません`);
      return { ...r, test: compileMatch(r.match) };
    });
  return { ...config, rules };
}

/**
 * ファイル名から宛先を決める。上から順に first-match-wins。
 * @returns {{ruleId: string|null, ruleName: string, dest: string} | null}
 *          null は「どのルールにも当たらず、何もしない」
 */
export function resolveDest(filename, compiled, now = new Date()) {
  for (const r of compiled.rules) {
    if (r.test(filename)) {
      return {
        ruleId: r.id ?? null,
        ruleName: r.name ?? r.id ?? '(無名)',
        dest: expandTokens(r.dest, filename, now),
      };
    }
  }
  const fb = compiled.fallback;
  if (fb?.enabled && fb.dest) {
    return { ruleId: null, ruleName: '(フォールバック)', dest: expandTokens(fb.dest, filename, now) };
  }
  return null;
}
