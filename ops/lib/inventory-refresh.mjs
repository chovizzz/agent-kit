// A7 基线刷新(inventory-refresh)的逻辑层。入口见 ops/inventory-refresh.mjs。
// 原则:
//  - 只重跑 inventory/commands.sh 里的只读命令(先过 a7 的 lintCommand),不读取别的任何文件;
//  - dry-run 完全不写;apply 先在内存算出全部新内容,改写后重新校验,再备份、临时文件 + rename、失败回滚;
//  - md 里只改「能无歧义绑定到 [#编号] 的位置」,其余列入「需人工核对」,绝不硬改。
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { lintCommand, parseCommands, compare, missingInputs } from '../accept/lib/a7.mjs';
import { run, EXIT } from '../accept/lib/common.mjs';

// ---------------------------------------------------------------- 期望值分类

/** 期望值的形状:ge(>=N) int hash(单个≥16位十六进制) list(≥2个整数/十六进制) kv(a=1 b=2) text。 */
export function kindOf(v) {
  if (/^>=\d+$/.test(v)) return 'ge';
  if (/^\d+$/.test(v)) return 'int';
  if (/^[0-9a-f]{16,}$/.test(v)) return 'hash';
  const toks = v.split(' ');
  if (toks.length > 1 && toks.every((t) => /^\d+$/.test(t) || /^[0-9a-f]{8,}$/.test(t)))
    return 'list';
  if (v !== '' && toks.every((t) => /^[A-Za-z][A-Za-z0-9]*=\d+$/.test(t))) return 'kv';
  return 'text';
}

/** 列表元素是否全为整数或全为 64 位哈希(只有这两类允许自动替换;8 位短哈希是「标识」,不自动改)。 */
function autoListKind(tokens) {
  if (tokens.every((t) => /^\d+$/.test(t))) return 'int';
  if (tokens.every((t) => /^[0-9a-f]{64}$/.test(t))) return 'hash64';
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function isoSeconds(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------- 重跑命令

/**
 * 逐条重跑,返回 results[]:{ row, status: same|changed|manual|notrun, actual, newExpected, note }。
 * 未通过 lint 的命令不会被执行(problems 里给出)。
 */
export function recount(rows, { home, cwd, timeoutMs = 120_000 }) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8' };
  const results = [];
  for (const row of rows) {
    const miss = missingInputs(row.cmd, home);
    if (miss.length) {
      results.push({ row, status: 'notrun', note: `输入不存在(${miss.join(', ')})` });
      continue;
    }
    const res = run('bash', ['-o', 'pipefail', '-c', row.cmd], { cwd, env, timeoutMs });
    if (res.spawnFailed || res.status === null) {
      results.push({ row, status: 'notrun', note: '命令未能正常结束(超时/信号)' });
      continue;
    }
    if (res.status !== 0) {
      results.push({ row, status: 'notrun', note: `命令退出 ${res.status}` });
      continue;
    }
    const actual = res.stdout.replace(/\n$/, '');
    const c = compare(row.expected, actual);
    if (c.ok) {
      results.push({ row, status: 'same', actual, note: c.note });
      continue;
    }
    if (/[\t\n\r|`]|\[#/.test(actual) || /^>=/.test(actual)) {
      results.push({
        row,
        status: 'manual',
        actual,
        note: '新输出含制表符/换行/竖线/反引号/[#,或以 >= 开头,写进 TSV 或 md 会破坏格式',
      });
      continue;
    }
    const oldKind = kindOf(row.expected);
    if (oldKind !== 'ge') {
      // 新值必须与旧值同形状,且只接受数值/哈希/k=v;文本型一律不自动写入(命令输出可能含文件内容,既不打印也不落盘)
      const nk = kindOf(actual);
      const numeric = new Set(['int', 'list']);
      const same = nk === oldKind || (numeric.has(nk) && numeric.has(oldKind));
      if (!same || nk === 'text' || nk === 'ge') {
        const h8 = createHash('sha256').update(actual).digest('hex').slice(0, 8);
        results.push({
          row,
          status: 'manual',
          actual: undefined,
          note: `新值形状(${oldKind} -> ${nk})不能自动写入,值已省略(长度 ${actual.length},sha256 前8位 ${h8});请人工核对后手改`,
        });
        continue;
      }
    }
    if (/^>=/.test(row.expected)) {
      // 只增项:仅在新值 < 阈值时才改(compare 判错且是整数 => 必然是 < 阈值)
      if (!/^\d+$/.test(actual)) {
        results.push({ row, status: 'manual', actual, note: '只增项的新输出不是整数' });
        continue;
      }
      results.push({
        row,
        status: 'changed',
        actual,
        newExpected: `>=${actual}`,
        note: `阈值下调(${row.expected} -> >=${actual}):单调增项变小了,请确认不是误删`,
        warn: true,
      });
      continue;
    }
    results.push({ row, status: 'changed', actual, newExpected: actual, note: '' });
  }
  return results;
}

/** 改写 commands.sh:只动变了的行的第 3、4 列,行序/行尾/其它行原样保留。 */
export function rewriteCommands(text, results, newTime) {
  const lines = text.split('\n');
  for (const r of results) {
    // 重测一致的精确型行也记本次时点(「最近一次确认」);只增项只有阈值被改时才动
    const bump = r.status === 'same' && !/^>=/.test(r.row.expected);
    if (r.status !== 'changed' && !bump) continue;
    const idx = r.row.line - 1;
    const raw = lines[idx];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const cols = raw.replace(/\r$/, '').split('\t');
    if (cols.length !== 4 || cols[0] !== r.row.id)
      throw new Error(`commands.sh 第 ${r.row.line} 行与解析结果不符`);
    if (r.status === 'changed') cols[2] = r.newExpected;
    cols[3] = newTime;
    lines[idx] = cols.join('\t') + cr;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- md 同步

const TAG_RE = /\[#([A-Za-z0-9][A-Za-z0-9_.-]*)\]/g;
const SEP_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LABEL_KEY = [
  [/符号链接/, 'sym'],
  [/内容哈希一致/, 'same'],
  [/内容漂移/, 'drift'],
];

function splitCells(line) {
  // 返回每个单元格的 [s,e)(原始文本,含两侧空格);反引号内的 | 与 \| 不算分隔
  const bars = [];
  let tick = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') tick = !tick;
    else if (c === '|' && !tick) bars.push(i);
  }
  const cells = [];
  for (let k = 0; k + 1 < bars.length; k++) cells.push({ s: bars[k] + 1, e: bars[k + 1] });
  // 没有结尾 | 的行:最后一段也算一格
  const lastBar = bars[bars.length - 1];
  if (lastBar !== undefined && line.slice(lastBar + 1).trim() !== '')
    cells.push({ s: lastBar + 1, e: line.length });
  return cells;
}

function tagsOf(line, from, to) {
  const out = [];
  TAG_RE.lastIndex = 0;
  const seg = line.slice(from, to);
  for (const m of seg.matchAll(TAG_RE))
    out.push({ id: m[1], s: from + m.index, e: from + m.index + m[0].length });
  return out;
}

/** 单元格里「去掉反引号后恰好是一个 token」时返回该 token 及其在行内的 [s,e)。 */
function pureToken(line, cell) {
  const raw = line.slice(cell.s, cell.e);
  const m = /^(\s*`?)([^`\s|]+)(`?\s*)$/.exec(raw);
  if (!m) return null;
  return { text: m[2], s: cell.s + m[1].length, e: cell.s + m[1].length + m[2].length };
}

/**
 * @param files  { [name]: text }
 * @param exp    Map<id, 期望值(应用后)>
 * @param changed Set<id>   本次值变了的编号(只有它们允许被改)
 * @param opts   { oldTimes:Set<string>, newTime:string|null }
 * @returns { files, edits[], manual[], advisories[] }
 */
export function syncMd(files, exp, changed, opts = {}) {
  const oldExp = opts.oldExp ?? new Map();
  const touched = opts.touched ?? new Set(); // 值变了但没被自动写入的编号(人工项),也算「变了」
  const outFiles = {};
  const edits = [];
  const manual = [];
  const advisories = [];
  const boundIds = new Set(); // 至少有一处成功绑定(已同步或已核对一致)的编号
  const bareList = []; // 列表型编号的「无值提及」,最后统一裁决
  const unbound = []; // 有值/无值但绑不上的引用(只对 changed 编号才报)

  for (const [name, text] of Object.entries(files)) {
    const lines = text.split('\n');
    const lineEdits = new Map(); // line -> [{s,e,text,id}]
    const addEdit = (line, s, e, t, id, oldText) => {
      if (!lineEdits.has(line)) lineEdits.set(line, []);
      lineEdits.get(line).push({ s, e, text: t, id, old: oldText });
    };
    const note = (line, id, reason) => manual.push({ file: name, line: line + 1, id, reason });

    // ---- 表格分组
    const tables = [];
    let cur = null;
    const tableLine = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\|/.test(lines[i])) {
        if (!cur) {
          cur = { rows: [] };
          tables.push(cur);
        }
        cur.rows.push({ line: i, cells: splitCells(lines[i]) });
        tableLine.add(i);
      } else cur = null;
    }
    const handled = new Set(); // `${line}:${tagStart}`
    const mark = (line, t) => handled.add(`${line}:${t.s}`);

    const checkToken = (id, line, tok, want, shapeOk, cellDesc, oldWant) => {
      // 返回 true=一致或已排入修改;false=无法处理(已记人工)
      if (tok.text === want) return true;
      if (!changed.has(id)) {
        note(line, id, `${cellDesc}与期望值不一致(文档已漂移;非本次变更的编号,未改)`);
        return false;
      }
      if (!shapeOk) {
        note(line, id, `${cellDesc}形状与新期望值不兼容,未改`);
        return false;
      }
      // 先比旧值:文档现值不等于旧期望值说明文档早就漂了,不能凭绑定位置就覆盖
      if (oldWant === undefined || tok.text !== oldWant) {
        note(line, id, `${cellDesc}现值与旧期望值不符(文档已漂移),未改`);
        return false;
      }
      addEdit(line, tok.s, tok.e, want, id, tok.text);
      return true;
    };
    const oldTokens = (id, n) => {
      // 旧期望值按「表格数据行数 n」对齐后的元素;对不上返回 null
      const o = oldExp.get(id);
      if (o === undefined) return null;
      const t = o.split(' ');
      if (t.length === n) return t;
      if (t.length === n + 1 && t[0] === '0') return t.slice(1);
      return null;
    };

    // ---- Pass A:表头单元格里的标注 => 整列有序列表
    for (const tb of tables) {
      if (tb.rows.length < 2 || !SEP_ROW.test(lines[tb.rows[1].line])) continue;
      const header = tb.rows[0];
      const body = tb.rows.slice(2);
      const listCols = []; // { col, id, tokens, skip, lineCol:boolean }
      header.cells.forEach((cell, col) => {
        for (const t of tagsOf(lines[header.line], cell.s, cell.e)) {
          if (!exp.has(t.id)) continue;
          mark(header.line, t);
          const val = exp.get(t.id);
          const k = kindOf(val);
          const toks = k === 'int' || k === 'hash' || k === 'list' ? val.split(' ') : null;
          if (!toks) {
            if (changed.has(t.id))
              note(header.line, t.id, '表头引用的期望值不是有序列表,未同步该列');
            continue;
          }
          const n = body.length;
          let skip = 0;
          if (toks.length === n + 1 && toks[0] === '0') skip = 1;
          else if (toks.length !== n) {
            if (changed.has(t.id))
              note(
                header.line,
                t.id,
                `有序列表 ${toks.length} 项,表格数据行 ${n} 行,对不上,未同步该列`,
              );
            continue;
          }
          const ak = autoListKind(toks.slice(skip));
          const allowEdit = changed.has(t.id) && ak !== null;
          let ok = true;
          body.forEach((row, i) => {
            const cell2 = row.cells[col];
            const tok = cell2 && pureToken(lines[row.line], cell2);
            if (!tok) {
              note(row.line, t.id, '该列单元格不是单个值,未同步');
              ok = false;
              return;
            }
            const want = toks[i + skip];
            if (tok.text === want) return;
            const ot = oldTokens(t.id, n);
            if (allowEdit && (ot === null || ot[i] !== tok.text)) {
              note(row.line, t.id, '该列现值与旧期望值不符(文档已漂移)或旧列表对不上,未改');
              ok = false;
              return;
            }
            if (!allowEdit) {
              note(
                row.line,
                t.id,
                changed.has(t.id)
                  ? '标识列(非整数/非64位哈希),不自动替换'
                  : '该列与期望值不一致(非本次变更的编号,未改)',
              );
              ok = false;
              return;
            }
            const shapeOk = ak === 'int' ? /^\d+$/.test(tok.text) : /^[0-9a-f]{64}$/.test(tok.text);
            if (!shapeOk) {
              note(row.line, t.id, '该列现有值形状与新值不兼容,未改');
              ok = false;
              return;
            }
            addEdit(row.line, tok.s, tok.e, want, t.id, tok.text);
          });
          if (ok) boundIds.add(t.id);
          listCols.push({
            col,
            id: t.id,
            toks: toks.slice(skip),
            skip,
            ak,
            headerText: lines[header.line].slice(cell.s, cell.e),
          });
        }
      });
      // 派生列:「起止行」由「行数」列累计得到
      const rangeCol = header.cells.findIndex(
        (c) => lines[header.line].slice(c.s, c.e).replace(TAG_RE, '').trim() === '起止行',
      );
      const lineCol = listCols.find((c) => c.ak === 'int' && /行数/.test(c.headerText));
      if (rangeCol !== -1 && lineCol && changed.has(lineCol.id)) {
        const ranges = (arr) => {
          let acc = 0;
          return arr.map((x) => `${acc + 1}-${(acc += Number(x))}`);
        };
        const ot = oldTokens(lineCol.id, body.length);
        const oldR = ot ? ranges(ot) : null;
        const newR = lineCol.skip === 1 ? ranges(lineCol.toks) : null;
        if (!newR || !oldR) {
          note(header.line, lineCol.id, '行数列表带序言段或新旧长度对不上,「起止行」未重算');
        } else {
          body.forEach((row, i) => {
            const cell2 = row.cells[rangeCol];
            const tok = cell2 && pureToken(lines[row.line], cell2);
            if (!tok || !/^\d+-\d+$/.test(tok.text)) {
              note(row.line, lineCol.id, '「起止行」单元格格式不是 a-b,未重算');
              return;
            }
            if (tok.text === newR[i]) return;
            if (tok.text !== oldR[i]) {
              note(row.line, lineCol.id, '「起止行」现值与旧行数推出的区间不符(文档已漂移),未改');
              return;
            }
            addEdit(row.line, tok.s, tok.e, newR[i], lineCol.id, tok.text);
          });
        }
      }
      if (listCols.some((c) => changed.has(c.id)) && header.cells.length) {
        const other = header.cells
          .map((c, i) => ({ i, t: lines[header.line].slice(c.s, c.e).replace(TAG_RE, '').trim() }))
          .filter(
            (c) => c.i !== rangeCol && !listCols.some((l) => l.col === c.i) && /层级/.test(c.t),
          );
        for (const o of other)
          advisories.push({
            file: name,
            line: header.line + 1,
            reason: `「${o.t}」列不由清单派生,若节结构变了请核对`,
          });
      }
    }

    // ---- Pass K4:表体各行各一个标注的有序列表(如每个脚本的字节数)
    for (const tb of tables) {
      const hasHeader = tb.rows.length >= 2 && SEP_ROW.test(lines[tb.rows[1].line]);
      const body = hasHeader ? tb.rows.slice(2) : tb.rows;
      const perId = new Map(); // id -> [{row, tag}]
      for (const row of body)
        row.cells.forEach((cell) => {
          for (const t of tagsOf(lines[row.line], cell.s, cell.e)) {
            if (!exp.has(t.id) || handled.has(`${row.line}:${t.s}`)) continue;
            const k = kindOf(exp.get(t.id));
            if (k !== 'list') continue;
            if (!perId.has(t.id)) perId.set(t.id, []);
            perId.get(t.id).push({ row, tag: t });
          }
        });
      for (const [id, occ] of perId) {
        const toks = exp.get(id).split(' ');
        const ak = autoListKind(toks);
        if (!ak || occ.length < 2) continue; // 只出现一次:不是逐行列表,交给后面的通用规则
        for (const o of occ) mark(o.row.line, o.tag);
        if (occ.length !== toks.length) {
          if (changed.has(id))
            note(
              occ[0].row.line,
              id,
              `有序列表 ${toks.length} 项,逐行引用 ${occ.length} 处,对不上,未同步`,
            );
          continue;
        }
        const sibling = new Set();
        for (const o of occ)
          for (const c of o.row.cells)
            for (const t of tagsOf(lines[o.row.line], c.s, c.e))
              if (t.id !== id && exp.has(t.id)) sibling.add(t.id);
        const movedSibling = [...sibling].filter((x) => changed.has(x) || touched.has(x));
        if (changed.has(id) && movedSibling.length) {
          note(
            occ[0].row.line,
            id,
            `同表按行配对的 ${movedSibling.join('/')} 也变了(可能换序),逐行数值不自动同步`,
          );
          continue;
        }
        const oldList = oldExp.get(id)?.split(' ');
        const oldOk = oldList && oldList.length === toks.length;
        if (!oldOk && changed.has(id)) {
          note(occ[0].row.line, id, '旧列表长度与新列表不同,逐行数值未同步');
          continue;
        }
        let ok = true;
        occ.forEach((o, i) => {
          const cands = o.row.cells
            .map((c) => pureToken(lines[o.row.line], c))
            .filter(
              (t) => t && (ak === 'int' ? /^\d+$/.test(t.text) : /^[0-9a-f]{64}$/.test(t.text)),
            );
          if (cands.length !== 1) {
            if (changed.has(id)) note(o.row.line, id, '该行找不到唯一的同形状数值单元格,未同步');
            ok = false;
            return;
          }
          if (!checkToken(id, o.row.line, cands[0], toks[i], true, '逐行数值', oldList?.[i]))
            ok = false;
        });
        if (ok) boundIds.add(id);
      }
    }

    // ---- Pass C:其余标注(值紧邻标注 / 表格行里的唯一整数单元格)
    const rowOf = new Map(); // line -> {row, table}
    for (const tb of tables) for (const row of tb.rows) rowOf.set(row.line, row);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const row = rowOf.get(li);
      const isSep = row && SEP_ROW.test(line);
      if (isSep) continue;
      const tagList = tagsOf(line, 0, line.length);
      let prevEnd = 0;
      let prevCellS = -1;
      for (const t of tagList) {
        const cell = row ? row.cells.find((c) => t.s >= c.s && t.e <= c.e) : null;
        const cs = cell ? cell.s : 0;
        if (cs !== prevCellS) {
          prevEnd = cs;
          prevCellS = cs;
        }
        const from = Math.max(cs, prevEnd);
        const segment = line.slice(from, t.s);
        prevEnd = t.e;
        if (!exp.has(t.id) || handled.has(`${li}:${t.s}`)) continue;
        const val = exp.get(t.id);
        const k = kindOf(val);
        // C1-kv
        let m =
          /((?:[A-Za-z][A-Za-z0-9]*=\d+(?:\s*[,，]\s*|\s+))*[A-Za-z][A-Za-z0-9]*=\d+)\s*$/.exec(
            segment,
          );
        if (m) {
          if (k !== 'kv') {
            unbound.push({
              file: name,
              line: li,
              id: t.id,
              why: '紧邻值是 k=v 形式,与新期望值形状不兼容',
            });
            continue;
          }
          const want = Object.fromEntries(val.split(' ').map((p) => p.split('=')));
          const base = from + m.index;
          const found = [...m[1].matchAll(/([A-Za-z][A-Za-z0-9]*)=(\d+)/g)];
          const keys = found
            .map((f) => f[1])
            .sort()
            .join(',');
          if (keys !== Object.keys(want).sort().join(',')) {
            unbound.push({ file: name, line: li, id: t.id, why: 'k=v 的键集合与新期望值不同' });
            continue;
          }
          let ok = true;
          for (const f of found) {
            if (f[2] === want[f[1]]) continue;
            if (!changed.has(t.id)) {
              note(li, t.id, 'k=v 与期望值不一致(非本次变更的编号,未改)');
              ok = false;
              continue;
            }
            const oldKv = oldExp.has(t.id)
              ? Object.fromEntries(
                  oldExp
                    .get(t.id)
                    .split(' ')
                    .map((p) => p.split('=')),
                )
              : {};
            if (oldKv[f[1]] !== f[2]) {
              note(li, t.id, 'k=v 现值与旧期望值不符(文档已漂移),未改');
              ok = false;
              continue;
            }
            const vs = base + f.index + f[1].length + 1;
            addEdit(li, vs, vs + f[2].length, want[f[1]], t.id, f[2]);
          }
          mark(li, t);
          if (ok) boundIds.add(t.id);
          continue;
        }
        // C1-hash
        m = /`([0-9a-f]{16,})`\s*$/.exec(segment);
        if (m) {
          if (k !== 'hash') {
            unbound.push({
              file: name,
              line: li,
              id: t.id,
              why: '紧邻值是哈希,与新期望值形状不兼容',
            });
            continue;
          }
          const s = from + m.index + 1;
          mark(li, t);
          if (
            checkToken(
              t.id,
              li,
              { text: m[1], s, e: s + m[1].length },
              val,
              true,
              '哈希',
              oldExp.get(t.id),
            )
          )
            boundIds.add(t.id);
          continue;
        }
        // C1-int(可带单位后缀;前一字符不能是字母数字,避免把 sha256 的 256 当成值)
        m = /(?:^|[^A-Za-z0-9_.\-])(\d+)(\s*[条个项节行种])?\s*$/.exec(segment);
        if (m) {
          if (k !== 'int' && k !== 'ge') {
            unbound.push({
              file: name,
              line: li,
              id: t.id,
              why: '紧邻值是整数,与新期望值形状不兼容',
            });
            continue;
          }
          const want = k === 'ge' ? val.slice(2) : val;
          // 精确定位数字:m[0] 里最后一个等于 m[1] 的位置(前缀至多一个分隔字符)
          const s = from + m.index + m[0].lastIndexOf(m[1]);
          const oldV = oldExp.get(t.id)?.replace(/^>=/, '');
          mark(li, t);
          if (checkToken(t.id, li, { text: m[1], s, e: s + m[1].length }, want, true, '整数', oldV))
            boundIds.add(t.id);
          continue;
        }
        // C2:表格行里标注所在单元格没有值 => 同行唯一的纯整数单元格
        if (row && cell) {
          const ints = row.cells
            .filter((c) => c !== cell)
            .map((c) => pureToken(line, c))
            .filter((x) => x && /^\d+$/.test(x.text));
          if (ints.length === 1 && (k === 'int' || k === 'ge')) {
            mark(li, t);
            if (
              checkToken(
                t.id,
                li,
                ints[0],
                k === 'ge' ? val.slice(2) : val,
                true,
                '同行整数',
                oldExp.get(t.id)?.replace(/^>=/, ''),
              )
            )
              boundIds.add(t.id);
            continue;
          }
          if (ints.length === 1 && k === 'kv') {
            const label = line.slice(row.cells[0].s, row.cells[0].e);
            const hit = LABEL_KEY.filter(([re]) => re.test(label));
            const want = Object.fromEntries(val.split(' ').map((p) => p.split('=')));
            if (hit.length === 1 && want[hit[0][1]] !== undefined) {
              mark(li, t);
              const oldKv = oldExp.has(t.id)
                ? Object.fromEntries(
                    oldExp
                      .get(t.id)
                      .split(' ')
                      .map((p) => p.split('=')),
                  )
                : {};
              if (
                checkToken(t.id, li, ints[0], want[hit[0][1]], true, '同行整数', oldKv[hit[0][1]])
              )
                boundIds.add(t.id);
              continue;
            }
          }
        }
        if (k === 'list') bareList.push({ file: name, line: li, id: t.id });
        else unbound.push({ file: name, line: li, id: t.id, why: '引用旁没有可绑定的值' });
      }
    }

    // ---- 套用本文件的修改
    const out = lines.slice();
    for (const [li, es] of lineEdits) {
      // 同一位置的重复编辑去重,冲突记人工
      const uniq = new Map();
      for (const e of es) {
        const key = `${e.s}:${e.e}`;
        const prev = uniq.get(key);
        if (prev && prev.text !== e.text) {
          note(li, e.id, `同一位置有两个不同的新值(${prev.id} 与 ${e.id}),未改`);
          uniq.set(key, { ...prev, conflict: true });
        } else if (!prev) uniq.set(key, e);
      }
      const list = [...uniq.values()].filter((e) => !e.conflict).sort((a, b) => b.s - a.s);
      for (let i = 1; i < list.length; i++)
        if (list[i].e > list[i - 1].s) throw new Error(`${name}:${li + 1} 编辑区间重叠`);
      let l = out[li];
      const trow = rowOf.get(li);
      const shifts = new Map(); // 单元格起点 -> 该格右端已累计的净位移(由右向左处理,左侧偏移不受影响)
      for (const e of list) {
        l = l.slice(0, e.s) + e.text + l.slice(e.e);
        edits.push({ file: name, line: li + 1, id: e.id, old: e.old, new: e.text });
        // 表格行:尽量保持列宽(新值变短就补空格,变长就吃掉单元格尾部多余的空格,至少留 1 个)
        const cell = trow?.cells.find((c) => e.s >= c.s && e.e <= c.e);
        if (!cell) continue;
        const delta = e.text.length - (e.e - e.s);
        const sh = shifts.get(cell.s) ?? 0;
        const end = cell.e + sh + delta; // 替换后该格右端(闭合竖线)的下标
        if (delta < 0) l = l.slice(0, end) + ' '.repeat(-delta) + l.slice(end);
        else if (delta > 0) {
          const trail = /( +)$/.exec(l.slice(cell.s, end));
          const take = Math.min(delta, trail ? trail[1].length - 1 : 0);
          if (take > 0) l = l.slice(0, end - take) + l.slice(end);
          shifts.set(cell.s, sh + delta - take);
        }
      }
      out[li] = l;
    }
    outFiles[name] = out.join('\n');
  }

  // ---- 无值/绑不上的引用裁决(只对变了的编号)
  for (const u of unbound)
    if (changed.has(u.id)) manual.push({ file: u.file, line: u.line + 1, id: u.id, reason: u.why });
  for (const b of bareList)
    if (changed.has(b.id) && !boundIds.has(b.id))
      manual.push({
        file: b.file,
        line: b.line + 1,
        id: b.id,
        reason: '有序列表只被无值提及,没有可同步的列',
      });

  // ---- 旧值残留扫描 + 时点行
  if (opts.oldValues) {
    for (const [name, text] of Object.entries(outFiles)) {
      const ls = text.split('\n');
      const fileIds = new Set([...text.matchAll(TAG_RE)].map((m) => m[1]));
      for (const tok of opts.oldValues) {
        if (!fileIds.has(tok.id)) continue; // 只扫引用了该编号的文件
        const re = new RegExp(
          `(?<![0-9A-Za-z])${tok.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`,
        );
        ls.forEach((l, i) => {
          if (re.test(l))
            manual.push({
              file: name,
              line: i + 1,
              id: tok.id,
              reason: `旧值 ${tok.text} 仍出现在此行,请核对`,
            });
        });
      }
    }
  }
  if (opts.oldTimes && opts.newTime) {
    const refIds = (text) => new Set([...text.matchAll(TAG_RE)].map((m) => m[1]));
    for (const [name, text] of Object.entries(files)) {
      const ids = [...refIds(text)].filter((x) => exp.has(x));
      const hasChangedId = ids.some((x) => changed.has(x));
      if (!hasChangedId) continue;
      const fileManual = manual.some((m) => m.file === name);
      const allExact = ids.every((x) => kindOf(exp.get(x)) !== 'ge');
      const ls = outFiles[name].split('\n');
      ls.forEach((l, i) => {
        const hm = /^(\s*[-*]\s*时点[::])(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/.exec(l);
        if (hm && opts.oldTimes.has(hm[2])) {
          if (!fileManual && allExact) {
            ls[i] = l.replace(hm[2], opts.newTime);
            edits.push({ file: name, line: i + 1, id: '(时点行)', old: hm[2], new: opts.newTime });
          } else if (hasChangedId)
            manual.push({
              file: name,
              line: i + 1,
              id: '(时点行)',
              reason: '本文件有人工项或含只增项,时点行未改,请人工决定',
            });
        } else if (hasChangedId) {
          for (const t of opts.oldTimes)
            if (l.includes(t))
              manual.push({
                file: name,
                line: i + 1,
                id: '(时点)',
                reason: `仍含旧时点 ${t},请核对`,
              });
        }
      });
      outFiles[name] = ls.join('\n');
    }
  }
  return { files: outFiles, edits, manual, advisories };
}

// ---------------------------------------------------------------- 写盘(备份 + 临时文件 + rename + 回滚)

export function assertInside(root, file) {
  const base = fs.realpathSync(path.join(root, 'inventory'));
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new Error(`拒绝写符号链接:${file}`);
  if (st.nlink > 1) throw new Error(`拒绝写硬链接文件:${file}`);
  const real = fs.realpathSync(file);
  if (!real.startsWith(base + path.sep)) throw new Error(`写入目标不在 inventory/ 内:${file}`);
}

/**
 * @param writes { abs, content }[]
 * @param opts { backupDir, rename? } rename 可注入(测试用,模拟中途失败)
 */
export function applyWrites(root, writes, { backupDir, rename = fs.renameSync }) {
  for (const w of writes) assertInside(root, w.abs);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const w of writes) fs.copyFileSync(w.abs, path.join(backupDir, path.basename(w.abs)));
  const tmps = [];
  try {
    for (const w of writes) {
      const tmp = path.join(
        path.dirname(w.abs),
        `.${path.basename(w.abs)}.refresh-${process.pid}.tmp`,
      );
      const mode = fs.statSync(w.abs).mode & 0o777;
      const fd = fs.openSync(tmp, 'wx', mode);
      tmps.push(tmp);
      try {
        fs.writeSync(fd, w.content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    for (const t of tmps) fs.rmSync(t, { force: true });
    throw e;
  }
  // rename 之前再核对一次:期间被别人改过就放弃,不覆盖
  for (const w of writes) {
    if (w.expect !== undefined && fs.readFileSync(w.abs, 'utf8') !== w.expect) {
      for (const t of tmps) fs.rmSync(t, { force: true });
      throw new Error(`${path.basename(w.abs)} 在计算期间被修改,放弃写入`);
    }
  }
  const done = [];
  try {
    writes.forEach((w, i) => {
      rename(tmps[i], w.abs);
      done.push(w);
    });
  } catch (e) {
    const failed = [];
    for (const w of done) {
      try {
        fs.copyFileSync(path.join(backupDir, path.basename(w.abs)), w.abs);
      } catch (e2) {
        failed.push(`${path.basename(w.abs)}(${e2.message})`);
      }
    }
    for (const t of tmps) fs.rmSync(t, { force: true });
    throw new Error(
      `写入中途失败:${e.message};` +
        (failed.length
          ? `回滚也失败了,请从备份目录 ${backupDir} 手动恢复:${failed.join(', ')}`
          : '已按备份回滚'),
    );
  }
}

// ---------------------------------------------------------------- 总流程

export function readInventory(root) {
  const dir = path.join(root, 'inventory');
  const cmdFile = path.join(dir, 'commands.sh');
  const md = {};
  const plain = (f) => {
    // 符号链接 / 多重硬链接一律拒绝:既不读也不写,避免跟着链接读写 inventory/ 之外的文件
    const st = fs.lstatSync(f);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)
      throw new Error(`inventory 里的文件必须是普通单链接文件:${path.basename(f)}`);
    return f;
  };
  for (const f of fs.readdirSync(dir).sort())
    if (f.endsWith('.md')) md[f] = fs.readFileSync(plain(path.join(dir, f)), 'utf8');
  return { cmdFile, commands: fs.readFileSync(plain(cmdFile), 'utf8'), md };
}

function lineDiffCount(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

/**
 * 计算完整刷新计划(不写盘)。返回 { code, plan }:code 非 0 表示在计划阶段就该退出。
 */
export function buildPlan({ root, home, now }) {
  let inv;
  try {
    inv = readInventory(root);
  } catch (e) {
    return { code: EXIT.REJECTED, rejected: [e.message] };
  }
  const { rows, problems } = parseCommands(inv.commands);
  if (problems.length || rows.length === 0)
    return {
      code: EXIT.REJECTED,
      rejected: [...problems, ...(rows.length ? [] : ['commands.sh 没有任何命令'])],
    };
  const rejected = [];
  for (const r of rows) {
    const lp = lintCommand(r.cmd);
    if (lp.length) rejected.push(`${r.id}: 命令未通过只读检查:${lp.join('; ')}`);
  }
  if (rejected.length) return { code: EXIT.REJECTED, rejected };

  const results = recount(rows, { home, cwd: root });
  const notrun = results.filter((r) => r.status === 'notrun');
  const changedRes = results.filter((r) => r.status === 'changed');
  const manualRows = results.filter((r) => r.status === 'manual');
  const newTime = isoSeconds(now);

  const exp = new Map(rows.map((r) => [r.id, r.expected]));
  const changed = new Set();
  const oldValues = [];
  for (const r of changedRes) {
    exp.set(r.row.id, r.newExpected);
    changed.add(r.row.id);
    const oldK = kindOf(r.row.expected);
    const olds = oldK === 'list' ? r.row.expected.split(' ') : [r.row.expected.replace(/^>=/, '')];
    const newSet = new Set(r.newExpected.split(' '));
    // 残留扫描的最小长度:单值 >=2 位,列表元素 >=3 位(短数字在别处巧合出现太多,会淹没真问题)
    const minDigits = oldK === 'list' ? 3 : 2;
    for (const o of olds)
      if (
        (new RegExp(`^\\d{${minDigits},}$`).test(o) || /^[0-9a-f]{16,}$/.test(o)) &&
        !newSet.has(o) &&
        oldK !== 'text'
      )
        oldValues.push({ id: r.row.id, text: o });
  }
  const uniqOld = [...new Map(oldValues.map((o) => [o.text, o])).values()];
  const oldTimes = new Set(rows.map((r) => r.at));

  const sync = syncMd(inv.md, exp, changed, {
    oldValues: uniqOld,
    oldTimes,
    oldExp: new Map(rows.map((r) => [r.id, r.expected])),
    touched: new Set(manualRows.map((r) => r.row.id)),
    newTime: changedRes.length ? newTime : null,
  });

  // 引用清单:哪些 md 的哪几行引用了变了的编号
  const refs = [];
  for (const [name, text] of Object.entries(inv.md))
    text.split('\n').forEach((l, i) => {
      const ids = [...l.matchAll(TAG_RE)].map((m) => m[1]).filter((x) => changed.has(x));
      if (ids.length) refs.push({ file: name, line: i + 1, ids: [...new Set(ids)] });
    });

  const newCommands =
    notrun.length || changedRes.length === 0
      ? inv.commands
      : rewriteCommands(inv.commands, results, newTime);

  const rowManual = [
    ...manualRows.map((r) => ({
      file: 'commands.sh',
      line: r.row.line,
      id: r.row.id,
      reason: r.note,
    })),
    ...changedRes
      .filter((r) => r.warn)
      .map((r) => ({ file: 'commands.sh', line: r.row.line, id: r.row.id, reason: r.note })),
  ];
  const advisories = [...sync.advisories];
  if (changedRes.length)
    advisories.push({
      file: '.state/inventory/*',
      line: 0,
      reason: '若存在 .state/inventory/ 下的旁路文件(如各节边界表),它们不会被本工具重生成',
    });

  // 改写后复验:已改的行必须能被重新解析为「与期望一致」
  const verify = syncMd(sync.files, exp, new Set(), {});
  const editedLines = new Set(sync.edits.map((e) => `${e.file}:${e.line}`));
  const inconsistent = verify.manual.filter((m) => editedLines.has(`${m.file}:${m.line}`));

  return {
    code: EXIT.OK,
    plan: {
      root,
      rows,
      results,
      notrun,
      changedRes,
      manualRows,
      newTime,
      exp,
      changed,
      inv,
      newCommands,
      sync,
      refs,
      inconsistent,
      advisories,
      manual: [...sync.manual, ...rowManual],
      hasChanges: changedRes.length > 0 || manualRows.length > 0,
    },
  };
}

export function fileStats(plan) {
  const stats = [];
  const c = lineDiffCount(plan.inv.commands, plan.newCommands);
  if (c) stats.push({ file: 'commands.sh', lines: c });
  for (const [name, text] of Object.entries(plan.sync.files)) {
    const n = lineDiffCount(plan.inv.md[name], text);
    if (n) stats.push({ file: name, lines: n });
  }
  return stats;
}

export function planWrites(plan) {
  const dir = path.join(plan.root, 'inventory');
  const writes = [];
  if (plan.newCommands !== plan.inv.commands)
    writes.push({
      abs: path.join(dir, 'commands.sh'),
      content: plan.newCommands,
      expect: plan.inv.commands,
    });
  for (const [name, text] of Object.entries(plan.sync.files))
    if (text !== plan.inv.md[name])
      writes.push({ abs: path.join(dir, name), content: text, expect: plan.inv.md[name] });
  return writes;
}

export function defaultBackupDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'inventory-refresh-'));
}
