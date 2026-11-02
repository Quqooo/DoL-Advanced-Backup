/**
 * SugarCube 2.37 起把 `JSON.stringify` / `JSON.parse` 换成了带 revive 标记的一对：
 * `undefined`、`NaN`、`±Infinity` 会被写成 `["(revive:eval)", "…"]`，
 * `Set` / `Map` / `Date` 也各有标记，解析时按标记还原成对应类型。
 *
 * 包要跨版本、跨设备读，标记数组不能进包，读写分区一律用原始实现。
 */
interface JsonApi {
  _real_stringify?: typeof JSON.stringify;
  _real_parse?: typeof JSON.parse;
}

const api = JSON as unknown as JsonApi;

export const stringifyJson: typeof JSON.stringify = api._real_stringify ?? JSON.stringify;
export const parseJson: typeof JSON.parse = api._real_parse ?? JSON.parse;

/**
 * 去掉尾逗号：`[1,2,]` → `[1,2]`、`{"a":1,}` → `{"a":1}`。
 *
 * 必须自己扫一遍，不能用正则：字符串里的 `",}"` 同样匹配 `,\s*}`，
 * 一次 replace 就会把值里的逗号删掉（`{"desc":"a,}"}` → `{"desc":"a}"}`）。
 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let quote = '';
  /** 待定的逗号在 out 里的位置；中间只有空白时才算尾逗号 */
  let commaAt = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index++;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      commaAt = -1;
      out += char;
      continue;
    }
    if (char === ',') {
      commaAt = out.length;
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      if (commaAt >= 0) out = out.slice(0, commaAt) + out.slice(commaAt + 1);
      commaAt = -1;
      out += char;
      continue;
    }
    // 空白不打断「逗号 + 空白 + 闭合」，其余字符一律作废候选
    if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n') commaAt = -1;
    out += char;
  }
  return out;
}

/**
 * 去掉 JSON5 允许、JSON 不允许的两样东西：注释与尾逗号。
 *
 * 只处理这两项，不做完整 JSON5 解析：常见的 `boot.json` 只用这两种语法。
 */
function stripJson5(text: string): string {
  let out = '';
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        index++;
      }
      continue;
    }
    if (quote) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index++;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      index++;
      continue;
    }
    out += char;
  }
  // 注释已经去掉，剩下的尾逗号交给能识别字符串的扫描
  return stripTrailingCommas(out);
}

/**
 * 宽松解析：先按严格 JSON 试，失败再去掉注释与尾逗号重试。
 *
 * ModLoader 用 `JSON5.parse` 读 `boot.json`，社区包常见 `["a",]` 这种尾逗号——
 * 包能装，但严格解析会让它读不出 name/version：树上没版本、打包时文件名退回
 * `unknown-<哈希>`。只在读 `boot.json` 这类纯配置时用，包内数据一律走 `parseJson`。
 */
export function parseLooseJson(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    // 严格解析失败，改用宽松解析
  }
  try {
    return parseJson(stripJson5(text));
  } catch {
    return null;
  }
}
