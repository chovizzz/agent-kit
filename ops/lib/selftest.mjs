// 检测器自检(防"检测器坏死所以永远通过"):全部在临时目录里的合成 HOME 上进行,不碰真实 HOME。
//   - 往假 HOME 写一个文件 => 主判据必须报;往受管路径写 => 副判据必须报;只写 volatile => 必须不报;
//   - 什么都不写 => 必须通过(正向对照);
//   - managed 被挪进 volatile / 被删 => 必须被拒;
//   - 给比对器喂已知差异必须报出,喂相同快照必须无差异。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attribute, EXIT, runZeroWrite } from './zero-write.mjs';
import { diffSnapshots, takeSnapshot } from './snapshot.mjs';
import { compareWithBase } from './lists.mjs';

const MANAGED = `# 合成清单
~/.claude/CLAUDE.md
~/.claude/settings.json
~/.claude/hooks/*.sh
~/.claude/skills/
~/.config/agent-kit/
~/.local/state/agent-kit/
`;
const VOLATILE = `~/.claude/projects/**
**/.DS_Store
`;

function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture(tmpBase) {
  const root = fs.mkdtempSync(path.join(tmpBase, 'zw-selftest-'));
  const home = path.join(root, 'realhome');
  const repo = path.join(root, 'repo');
  w(path.join(home, '.claude/CLAUDE.md'), 'a\n');
  w(path.join(home, '.claude/settings.json'), '{}\n');
  w(path.join(home, '.claude/hooks/a.sh'), 'echo\n');
  w(path.join(home, '.claude/skills/s1/SKILL.md'), '# s1\n');
  w(path.join(home, '.claude/projects/p/session.jsonl'), '{}\n');
  w(path.join(repo, 'ops/managed-paths.txt'), MANAGED);
  w(path.join(repo, 'ops/volatile-paths.txt'), VOLATILE);
  w(path.join(repo, 'cmds.txt'), '');
  return { root, home, repo };
}

export function runSelfTest(base, log) {
  const tmpBase = base.tmp ?? process.env.KIT_TMP ?? os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  const fx = fixture(tmpBase);
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
  };
  const run = (name, cmd, expectExit, expectCode, extra = {}) => {
    w(path.join(fx.repo, 'cmds.txt'), cmd + '\n');
    const o = {
      ...base,
      repo: fx.repo,
      home: fx.home,
      managed: undefined,
      volatile: undefined,
      commandsFile: path.join(fx.repo, 'cmds.txt'),
      outRoot: path.join(fx.root, 'out'),
      tmp: fx.root,
      baseRef: '',
      allowKitPaths: false,
      requireSuccess: true,
      selftest: false,
      ...extra,
    };
    const { exit, report } = runZeroWrite(o);
    const codes = report.findings.map((f) => f.code);
    const ok = exit === expectExit && (expectCode === null || codes.includes(expectCode));
    check(name, ok, `exit=${exit} findings=${codes.join(',')}`);
  };

  // 正向对照:什么都不写 => 通过
  run('positive-control: no writes passes', `${process.execPath} -e "0"`, EXIT.OK, null);
  // 主判据:写假 HOME
  run(
    'main: write into fake HOME is caught',
    `/bin/sh -c "echo x > {HOME}/leak"`,
    EXIT.FAIL,
    'FAKE_HOME_NOT_EMPTY',
  );
  run(
    'main: nested write into fake HOME is caught',
    `/bin/sh -c "mkdir -p {HOME}/.cache/x && echo x > {HOME}/.cache/x/y"`,
    EXIT.FAIL,
    'FAKE_HOME_NOT_EMPTY',
  );
  // 副判据:写受管路径
  run(
    'secondary: rewrite managed file is caught',
    `/bin/sh -c "echo $$ > {REALHOME}/.claude/CLAUDE.md"`,
    EXIT.FAIL,
    'MANAGED_PATH_WRITTEN_DURING_RUN',
  );
  run(
    'secondary: new file under managed dir is caught',
    `/bin/sh -c "echo $$ > {REALHOME}/.claude/skills/s1/extra.md"`,
    EXIT.FAIL,
    'MANAGED_PATH_WRITTEN_DURING_RUN',
  );
  run(
    'secondary: new glob match is caught',
    `/bin/sh -c "echo $$ > {REALHOME}/.claude/hooks/b.sh"`,
    EXIT.FAIL,
    'MANAGED_PATH_WRITTEN_DURING_RUN',
  );
  run(
    'secondary: create-once write is not silently passed',
    `/bin/sh -c "[ -e {REALHOME}/.claude/hooks/c.sh ] || echo x > {REALHOME}/.claude/hooks/c.sh"`,
    EXIT.ATTRIBUTE,
    'ATTRIBUTION_REQUIRED',
  );
  run(
    'secondary: kit own state path creation is caught',
    `/bin/sh -c "mkdir -p {REALHOME}/.config/agent-kit && echo $$ > {REALHOME}/.config/agent-kit/x"`,
    EXIT.FAIL,
    'MANAGED_PATH_WRITTEN_DURING_RUN',
  );
  fs.rmSync(path.join(fx.home, '.config'), { recursive: true, force: true });
  run(
    'secondary: appending to a deeply nested file under a managed dir is caught',
    `/bin/sh -c "mkdir -p {REALHOME}/.claude/skills/s1/scripts/deep && echo $$ >> {REALHOME}/.claude/skills/s1/scripts/deep/x.sh"`,
    EXIT.FAIL,
    'MANAGED_PATH_WRITTEN_DURING_RUN',
  );
  fs.rmSync(path.join(fx.home, '.claude/skills/s1/scripts'), { recursive: true, force: true });
  run(
    'home-watch: new entry directly under HOME is not silently passed',
    `/bin/sh -c "echo $$ >> {REALHOME}/.agent-kit-stray"`,
    EXIT.ATTRIBUTE,
    'ATTRIBUTION_REQUIRED',
  );
  fs.rmSync(path.join(fx.home, '.agent-kit-stray'), { force: true });
  run(
    'secondary: touch without content change is caught',
    `/bin/sh -c "touch {REALHOME}/.claude/CLAUDE.md"`,
    EXIT.FAIL,
    'MANAGED_PATH_WRITTEN_DURING_RUN',
  );
  // 把一个"很久以前创建"的文件 mv 进受管路径:mtime 是旧的,但 rename 会更新 ctime
  fs.writeFileSync(path.join(fx.repo, 'old.txt'), 'old\n');
  fs.utimesSync(path.join(fx.repo, 'old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  run(
    'secondary: mv of an old file into a managed path is not silently passed',
    `/bin/sh -c "if [ -e {REPO}/old.txt ]; then mv {REPO}/old.txt {REALHOME}/.claude/CLAUDE.md; fi"`,
    EXIT.ATTRIBUTE,
    'ATTRIBUTION_REQUIRED',
  );
  // 只在第二次调用才写的命令:--two-rounds 才抓得到
  run(
    'secondary: write that only happens on the 2nd invocation is caught with --two-rounds',
    `/bin/sh -c "if [ -e {REPO}/marker ]; then echo $$ >> {REALHOME}/.claude/CLAUDE.md; else touch {REPO}/marker; fi"`,
    EXIT.ATTRIBUTE,
    'ATTRIBUTION_REQUIRED',
    { twoRounds: true },
  );
  fs.rmSync(path.join(fx.repo, 'marker'), { force: true });
  // volatile 只剔除:写 volatile 不应报
  run(
    'volatile: writes under volatile paths are ignored',
    `/bin/sh -c "echo $$ >> {REALHOME}/.claude/projects/p/session.jsonl; echo x > {REALHOME}/.claude/skills/.DS_Store"`,
    EXIT.OK,
    null,
  );
  // kit 路径事先存在
  fs.mkdirSync(path.join(fx.home, '.config/agent-kit'), { recursive: true });
  run(
    'kit paths must not pre-exist in P0',
    `${process.execPath} -e "0"`,
    EXIT.FAIL,
    'KIT_PATH_PRESENT_BEFORE',
  );
  fs.rmSync(path.join(fx.home, '.config/agent-kit'), { recursive: true });
  // 命令非正常退出
  run(
    'command abnormal exit is flagged (not silently passed)',
    `/bin/sh -c "exit 3"`,
    EXIT.FAIL,
    'COMMAND_ABNORMAL_EXIT',
  );

  // 清单卫生:managed 挪进 volatile 被拒
  const lists = (managed, vol) => {
    w(path.join(fx.repo, 'ops/managed-paths.txt'), managed);
    w(path.join(fx.repo, 'ops/volatile-paths.txt'), vol);
  };
  lists(MANAGED, VOLATILE + '~/.claude/CLAUDE.md\n');
  run(
    'lists: volatile covering a managed file is rejected',
    `${process.execPath} -e "0"`,
    EXIT.LISTS_REJECTED,
    'MANAGED_COVERED_BY_VOLATILE',
  );
  lists(MANAGED, VOLATILE + '~/.claude/skills/\n');
  run(
    'lists: volatile covering a managed dir is rejected',
    `${process.execPath} -e "0"`,
    EXIT.LISTS_REJECTED,
    'MANAGED_COVERED_BY_VOLATILE',
  );
  lists(MANAGED, VOLATILE + '~/.claude/**\n');
  run(
    'lists: broad volatile glob swallowing managed is rejected',
    `${process.execPath} -e "0"`,
    EXIT.LISTS_REJECTED,
    'MANAGED_COVERED_BY_VOLATILE',
  );
  lists(MANAGED, VOLATILE);

  // 基线比较(纯函数):managed 行被删并出现在 volatile => MOVED;单纯删除 => REMOVED
  const moved = compareWithBase(
    MANAGED,
    MANAGED.replace('~/.claude/settings.json\n', ''),
    VOLATILE + '~/.claude/settings.json\n',
    fx.home,
  );
  check(
    'lists: managed->volatile move detected against base',
    moved.some((p) => p.code === 'MANAGED_MOVED_TO_VOLATILE'),
    JSON.stringify(moved),
  );
  const removed = compareWithBase(
    MANAGED,
    MANAGED.replace('~/.claude/settings.json\n', ''),
    VOLATILE,
    fx.home,
  );
  check(
    'lists: plain managed removal detected against base',
    removed.some((p) => p.code === 'MANAGED_REMOVED'),
    JSON.stringify(removed),
  );
  check(
    'lists: unchanged managed vs base is clean',
    compareWithBase(MANAGED, MANAGED, VOLATILE, fx.home).length === 0,
    '',
  );

  // 比对器喂已知差异
  const snap = () => takeSnapshot({ home: fx.home, managedText: MANAGED, volatileText: VOLATILE });
  const s1 = snap();
  const s1b = snap();
  check('differ: identical snapshots have no diff', diffSnapshots(s1, s1b).count === 0, '');
  fs.appendFileSync(path.join(fx.home, '.claude/settings.json'), ' ');
  const s2 = snap();
  const d = diffSnapshots(s1, s2);
  check(
    'differ: known change is reported',
    d.count === 1 && d.changed[0]?.path === '~/.claude/settings.json',
    JSON.stringify(d),
  );
  fs.rmSync(path.join(fx.home, '.claude/hooks/a.sh'));
  const d2 = diffSnapshots(s2, snap());
  check(
    'differ: known deletion is reported',
    d2.removed.some((x) => x.path === '~/.claude/hooks/a.sh'),
    JSON.stringify(d2),
  );

  // 归因函数:窗口外 + 单次 => transient;窗口外 + 重现 => external-reproduced;窗口内两轮 => ours
  const mk = (diffPaths, ctime, win) => ({
    diff: { added: [], removed: [], changed: diffPaths.map((p) => ({ path: p })) },
    after: { meta: Object.fromEntries(diffPaths.map((p) => [p, { ctime_ms: ctime }])), dirs: {} },
    window: win,
  });
  const W = { start: 1_000_000, end: 1_005_000 };
  const out1 = attribute(mk(['~/x'], 10, W), {
    ...mk([], 10, W),
    diff: { added: [], removed: [], changed: [] },
  });
  check(
    'attribute: outside-window single appearance is transient',
    out1[0]?.verdict === 'external-transient',
    JSON.stringify(out1),
  );
  const out2 = attribute(mk(['~/x'], 10, W), mk(['~/x'], 10, W));
  check(
    'attribute: outside-window reproduced needs attribution',
    out2[0]?.verdict === 'external-reproduced',
    JSON.stringify(out2),
  );
  const out3 = attribute(mk(['~/x'], 1_002_000, W), mk(['~/x'], 1_002_000, W));
  check(
    'attribute: inside-window both rounds is ours',
    out3[0]?.verdict === 'ours',
    JSON.stringify(out3),
  );

  fs.rmSync(fx.root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  log(`selftest: ${results.length - failed.length}/${results.length} 符合预期`);
  return failed.length === 0 ? EXIT.OK : EXIT.FAIL;
}
