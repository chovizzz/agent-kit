/**
 * R20-16.28(A4 订正 #8)必杀变异:路径中和与单条证据丢弃。格式、执行方式同 `a4-mutation-table.ts`
 * (javis 私有检出里 cp 备份 → 按锚点替换,每个锚点在对应文件里恰好出现一次 → 跑 `tests` → 失败集合非空且全部命中 `expectRed`、`mustKill` 每项至少命中一个、
 * 没有 skipped → cp 还原并逐文件 sha256 核对;不用 git checkout / stash 还原)。结果记进 `A4_NEUTRALIZE_RESULTS`。
 */
import type { A4Mutation, A4Result } from './a4-mutation-table.js';

const NZ = 'rsi/a4-digest-neutralize.test.ts';
const DIGEST = 'rsi/a4-digest.test.ts';

export const A4_NEUTRALIZE_MUTATIONS: readonly A4Mutation[] = [
  {
    id: 'nz-no-neutralize',
    clause: '去掉路径中和(摘录原样进单条闸)',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'const excerpt = neutralizePaths(s.excerpt_redacted, pathRoots);',
        replacement: 'const excerpt = s.excerpt_redacted;',
      },
    ],
    tests: [NZ],
    expectRed: ['① 摘录含 HOME 路径', '① 状态目录 → <state>', '② 前缀冒充', '被丢的证据不占'],
    mustKill: ['① 摘录含 HOME 路径', '① 状态目录 → <state>'],
  },
  {
    id: 'nz-no-evidence-drop',
    clause: '去掉单条丢弃(中和后仍命中的证据照常进输出,交给整份闸)',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'return evidencePassesLeakGate(excerpt, forbidden)',
        replacement: 'return true',
      },
    ],
    tests: [NZ],
    expectRed: ['② 前缀冒充', '③ 某簇证据全丢', '被丢的证据不占'],
    mustKill: ['② 前缀冒充', '③ 某簇证据全丢'],
  },
  {
    id: 'nz-boundary-after-prefix',
    clause: '段边界(根之后)改成字符串前缀匹配',
    edits: [
      {
        file: 'src/rsi/digest-paths.ts',
        anchor: "if (next === undefined || next === '/' || !SEG_CHAR.test(next)) {",
        replacement: 'if (true) {',
      },
    ],
    tests: [NZ],
    expectRed: [
      '段边界:同段延伸',
      '单条闸:中和后',
      '② 前缀冒充',
      '③ 某簇证据全丢',
      '被丢的证据不占',
    ],
    mustKill: ['段边界:同段延伸', '② 前缀冒充'],
  },
  {
    id: 'nz-boundary-before-removed',
    clause: '段边界(根之前)检查去掉',
    edits: [
      {
        file: 'src/rsi/digest-paths.ts',
        anchor: "if (text[i] === '/' && !(prev !== '' && SEG_CHAR.test(prev))) {",
        replacement: "if (text[i] === '/') {",
      },
    ],
    tests: [NZ],
    expectRed: ['段边界:同段延伸'],
    mustKill: ['段边界:同段延伸'],
  },
  {
    id: 'nz-empty-cluster-uncounted',
    clause: '整簇证据全丢不计入 clusters_dropped',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'if (mine.length >= 1 && current.length === 0) clustersEmptied++;',
        replacement: 'if (false) clustersEmptied++;',
      },
    ],
    tests: [NZ],
    expectRed: ['③ 某簇证据全丢'],
    mustKill: ['③ 某簇证据全丢'],
  },
  {
    id: 'nz-no-fallback-gate',
    clause: '去掉整份输出的兜底泄漏闸',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'if (emitLines(leakSink, lines, forbidden) !== ExitCode.OK) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [NZ, DIGEST],
    expectRed: ['④ 兜底', '植入 HOME 路径'],
    mustKill: ['④ 兜底', '植入 HOME 路径'],
  },
];

/** javis 实测结果(执行变异后填);形状同 A4_RESULTS */
export const A4_NEUTRALIZE_RESULTS: readonly A4Result[] = [
  // 2026-11-04 javis 私有检出(基线 e163a01 + 本补丁):基线 a4-digest-neutralize + a4-digest 共 56 例全绿、0 skipped;6 条变异全部被杀、无 skipped、每条还原后 cmp 一致。
  // 另核:改动后 a4-mutation-table 的 xu-after-cluster 锚点随重构更新,该变异仍红('仅靠 X 或 U 证据才过门槛的簇不入选')。
  {
    id: 'nz-no-neutralize',
    killedBy: ['① 摘录含 HOME 路径', '① 状态目录 → <state>', '② 前缀冒充', '被丢的证据不占'],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'nz-no-evidence-drop',
    killedBy: ['② 前缀冒充', '③ 某簇证据全丢', '被丢的证据不占'],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'nz-boundary-after-prefix',
    killedBy: [
      '段边界:同段延伸',
      '单条闸:中和后',
      '② 前缀冒充',
      '③ 某簇证据全丢',
      '被丢的证据不占',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'nz-boundary-before-removed',
    killedBy: ['段边界:同段延伸'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'nz-empty-cluster-uncounted',
    killedBy: ['③ 某簇证据全丢'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'nz-no-fallback-gate',
    killedBy: ['④ 兜底', '植入 HOME 路径'],
    failed: 2,
    skipped: 0,
    restored: true,
  },
];
