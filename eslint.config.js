// @ts-check
import tseslint from 'typescript-eslint';

/**
 * A9 / A5 的静态护栏:
 *  - 文件系统:`node:fs` 系列只许出现在 src/io/safe-fs.ts(写)与 src/io/read-fs.ts(读)。
 *  - HOME / 环境变量 / cwd:`node:os`、`process.env`、`process.cwd` 只许出现在 src/io/paths.ts。
 *  - 子进程:`child_process` 只许出现在 src/io/exec.ts(git 白名单)与 src/io/llm-exec.ts(受控 LLM 出口,R0)。
 *  - LLM 出口:除 src/reflect/backends/** 外,任何文件不得 import / re-export / 动态 import `llm-exec`
 *    (命令层、reflect 干跑路径、judge 都经依赖注入拿后端);测试里只有 llm-exec / backends 的测试可以。
 *  - S0(sync / doctor / update,contracts §19)预写的三道授权闸,对应文件 S1/S6/S7 才建,规则先就位:
 *      · HOME 写出口 `src/io/home-fs.ts`:只许 `src/sync/apply.ts`、`src/update/install.ts` 及其测试引用;
 *      · 网络出口 `src/io/net.ts`:只许 `src/update/**`(launcher 除外)、`src/commands/update.ts` 及其测试引用;
 *        只有它自己可以 import 网络模块 / 用全局 fetch;
 *      · 启动器 `src/update/launcher.ts`:只许 `cli.ts`、`src/cli.ts`、`src/update/**`、`src/commands/update.ts` 及其测试引用;
 *        `io/exec.ts` 将新增的 `runSelf`(S7,唯一能 spawn process.execPath 的入口)只许 launcher.ts 引用。
 *  - 另外禁网络模块与全局 fetch(A8 的运行期垫片是主判据,这里是便宜的第二道)、eval、动态 import、require。
 * 范围:cli.ts、src/、adapters/、test/、vitest.config.ts。ops/ 下的验收工具脚本(B17/B18)不在此列,
 * 它们本来就要读真实 HOME 做快照。
 *
 * 已知绕不过 lint 的洞(靠评审兜):借道第三方包间接写文件;process.stdout.write 重定向到文件;
 * 子进程里的命令自己写盘(exec 默认不继承 HOME,但不拦命令本身)。见 docs/architecture-p0.md。
 */

const NODE_MODULES_FS = ['fs', 'fs/promises'];
const NODE_MODULES_CP = ['child_process', 'worker_threads', 'cluster', 'vm', 'inspector'];
const NODE_MODULES_ENV = ['os', 'process'];
const NODE_MODULES_NET = ['net', 'tls', 'http', 'https', 'http2', 'dns', 'dns/promises', 'dgram'];
const NODE_MODULES_LOADER = ['module'];

/** @param {string[]} names */
const withNodePrefix = (names) => names.flatMap((n) => [n, `node:${n}`]);

const MESSAGES = {
  fs: '文件系统只经 src/io/safe-fs.ts(写)与 src/io/read-fs.ts(读)。',
  cp: '子进程只经 src/io/exec.ts(runSync,git)与 src/io/llm-exec.ts(runLlm,受控 LLM 出口)。',
  llm: 'LLM 出口 src/io/llm-exec.ts 只许 src/reflect/backends/** 引用;其余代码经依赖注入拿后端。',
  homeFs:
    'HOME 写出口 src/io/home-fs.ts 只许 src/sync/apply.ts 与 src/update/install.ts(及其测试)引用。',
  netOut:
    '网络出口 src/io/net.ts 只许 src/update/**(launcher.ts 除外)与 src/commands/update.ts(及其测试)引用。',
  launcher:
    '启动器 src/update/launcher.ts 只许 cli.ts / src/cli.ts / src/update/** / src/commands/update.ts(及其测试)引用。',
  runSelf: 'runSelf(spawn process.execPath)只许 src/update/launcher.ts 引用。',
  sigstore: '`sigstore` 包(来源证明验签)只许 src/update/provenance.ts 引用。',
  env: 'HOME/环境/cwd 只经 src/io/paths.ts 的 IoContext。',
  net: 'P0 运行期零网络(A8)。',
  loader: '不得用 module/createRequire 绕开导入限制。',
};

/**
 * allowFs/allowCp/allowEnv/allowNet:该文件**自己**可以 import 对应的 node 模块(出口实现文件);
 * allowLlm/allowHomeFs/allowNetOut/allowLauncher/allowRunSelf:该文件可以 import 对应出口模块(授权使用方)。
 * @param {{ allowFs?: boolean; allowCp?: boolean; allowCpOnly?: boolean; allowEnv?: boolean; allowNet?: boolean; allowLlm?: boolean; allowHomeFs?: boolean; allowNetOut?: boolean; allowLauncher?: boolean; allowRunSelf?: boolean; allowSigstore?: boolean }} allow
 */
function restrictions(allow = {}) {
  /** @type {{name: string; message: string}[]} */
  const paths = [];
  /** @type {string[]} */
  const dynamicBanned = [];
  const add = (names, message, allowed) => {
    if (allowed) return;
    for (const name of withNodePrefix(names)) paths.push({ name, message });
    dynamicBanned.push(...names);
  };
  add(NODE_MODULES_FS, MESSAGES.fs, allow.allowFs);
  // allowCpOnly:只放开 child_process;vm / worker_threads / cluster / inspector 照旧禁,动态 import child_process 也照旧禁
  add(
    allow.allowCpOnly ? NODE_MODULES_CP.filter((n) => n !== 'child_process') : NODE_MODULES_CP,
    MESSAGES.cp,
    allow.allowCp,
  );
  if (allow.allowCpOnly) dynamicBanned.push('child_process');
  add(NODE_MODULES_ENV, MESSAGES.env, allow.allowEnv);
  add(NODE_MODULES_NET, MESSAGES.net, allow.allowNet);
  add(NODE_MODULES_LOADER, MESSAGES.loader, false);

  const dynamicRe = `^(node:)?(${dynamicBanned.map((n) => n.replace('/', '\\/')).join('|')})$`;
  /** llm-exec 的各种写法:`../io/llm-exec.js`、`./llm-exec`、`src/io/llm-exec.ts` */
  const LLM_EXEC_GROUP = ['**/llm-exec', '**/llm-exec.js', '**/llm-exec.ts', '**/llm-exec.*'];

  /** S0 出口模块的各种写法(import / export-from / 动态 import 共用同一组文件名模式) */
  const HOME_FS_GROUP = ['**/home-fs', '**/home-fs.*'];
  const NET_OUT_GROUP = ['**/io/net', '**/io/net.*', './net', './net.*'];
  const LAUNCHER_GROUP = ['**/launcher', '**/launcher.*'];
  const EXEC_GROUP = ['**/io/exec', '**/io/exec.*', './exec', './exec.*'];

  /** @type {{selector: string; message: string}[]} */
  const syntax = [
    ...(allow.allowHomeFs
      ? []
      : [
          {
            selector: 'ImportExpression[source.value=/home-fs/]',
            message: `动态 import 也不得绕开 HOME 写出口限制。${MESSAGES.homeFs}`,
          },
        ]),
    ...(allow.allowNetOut
      ? []
      : [
          {
            // 来源以 net / net.js / net.ts 结尾,且 net 前一个字符不是字母(不误伤 magnet 之类)
            selector: 'ImportExpression[source.value=/(^|[^a-z])net(\\.js|\\.ts)?$/]',
            message: `动态 import 也不得绕开网络出口限制。${MESSAGES.netOut}`,
          },
        ]),
    ...(allow.allowRunSelf
      ? []
      : [
          {
            // 动态 import 整个 exec 模块可以绕过 importNames 限制;非 launcher 文件一律禁(静态命名导入 runSync 不受影响)。
            // 前一字符不得是字母或连字符,所以不误伤 llm-exec(它有自己的闸)。
            selector: 'ImportExpression[source.value=/(^|[^a-z-])exec(\\.js|\\.ts)?$/]',
            message: `动态 import 也不得绕开 runSelf 限制。${MESSAGES.runSelf}`,
          },
        ]),
    ...(allow.allowSigstore
      ? []
      : [
          {
            selector: 'ImportExpression[source.value=/^@?sigstore(\\/|$)/]',
            message: `动态 import 也不得绕开 sigstore 限制。${MESSAGES.sigstore}`,
          },
        ]),
    ...(allow.allowLauncher
      ? []
      : [
          {
            selector: 'ImportExpression[source.value=/launcher/]',
            message: `动态 import 也不得绕开启动器限制。${MESSAGES.launcher}`,
          },
        ]),
    ...(allow.allowLlm
      ? []
      : [
          {
            selector: 'ImportExpression[source.value=/llm-exec/]',
            message: `动态 import 也不得绕开 LLM 出口限制。${MESSAGES.llm}`,
          },
        ]),
    {
      selector: `ImportExpression[source.value=/${dynamicRe}/]`,
      message: '动态 import 也不得绕开 io 出口。',
    },
    {
      selector: 'ImportExpression[source.value=/%/]',
      message: '动态 import 的来源不得含 % 编码(可借 %2D 之类绕开路径匹配)。',
    },
    {
      selector: 'ImportExpression[source.value=/^(data|http|https|file):/]',
      message: '不得动态 import data:/http(s):/file: URL(静态分析看不到其内容)。',
    },
    {
      selector: "ImportExpression:not([source.type='Literal'])",
      message: '动态 import 的来源必须是字面量(否则无法静态审计)。',
    },
    {
      selector: "CallExpression[callee.name='require']",
      message: '本仓是 ESM,不得使用 require。',
    },
    { selector: "CallExpression[callee.name='eval']", message: '禁止 eval。' },
    {
      selector: "MemberExpression[property.name='constructor']",
      message: '禁止 .constructor(可借 constructor.constructor 造出 Function)。',
    },
    {
      selector: "Property[shorthand=true][key.name='process']",
      message: '不得把 process 放进对象简写属性。',
    },
    { selector: "NewExpression[callee.name='Function']", message: '禁止 new Function。' },
    {
      selector: 'Identifier[name=/^(globalThis|global)$/]',
      message: '不得经 globalThis/global 取 process 等全局绕开限制。',
    },
    {
      // process 只能以 process.<成员> 的形式出现,不能赋给变量、解构、当参数传递
      selector:
        "*:not(MemberExpression):not(Property):not(TSTypeQuery) > Identifier[name='process']",
      message: 'process 只能以 process.<成员> 的形式使用,不得赋值/解构/传递。',
    },
    {
      selector:
        "MemberExpression[object.name='process'][computed=true]:not([property.type='Literal'])",
      message: '不得用动态键访问 process。',
    },
  ];

  /** @type {{object: string; property: string; message: string}[]} */
  const props = [];
  if (!allow.allowEnv) {
    for (const property of ['env', 'cwd', 'chdir', 'umask']) {
      props.push({ object: 'process', property, message: MESSAGES.env });
    }
  }
  for (const property of [
    'binding',
    '_linkedBinding',
    'dlopen',
    'getBuiltinModule',
    'mainModule',
  ]) {
    props.push({ object: 'process', property, message: '不得用 process 的底层入口绕开限制。' });
  }

  return {
    'no-restricted-imports': [
      'error',
      {
        paths,
        patterns: [
          {
            group: ['**/ops/**', 'ops/**'],
            message: 'ops/ 是验收工具脚本,不属于产品代码;src/ adapters/ test/ 不得 import 它。',
          },
          ...(allow.allowLlm ? [] : [{ group: LLM_EXEC_GROUP, message: MESSAGES.llm }]),
          ...(allow.allowSigstore
            ? []
            : [{ group: ['sigstore', 'sigstore/**', '@sigstore/**'], message: MESSAGES.sigstore }]),
          ...(allow.allowHomeFs ? [] : [{ group: HOME_FS_GROUP, message: MESSAGES.homeFs }]),
          ...(allow.allowNetOut ? [] : [{ group: NET_OUT_GROUP, message: MESSAGES.netOut }]),
          ...(allow.allowLauncher ? [] : [{ group: LAUNCHER_GROUP, message: MESSAGES.launcher }]),
          // importNames:命名导入、`import *`、`export {…} from` 都会被它拦下
          ...(allow.allowRunSelf
            ? []
            : [{ group: EXEC_GROUP, importNames: ['runSelf'], message: MESSAGES.runSelf }]),
        ],
      },
    ],
    'no-restricted-syntax': ['error', ...syntax],
    'no-restricted-properties': ['error', ...props],
    'no-restricted-globals': allow.allowNet
      ? 'off'
      : [
          'error',
          { name: 'fetch', message: MESSAGES.net },
          { name: 'XMLHttpRequest', message: MESSAGES.net },
          { name: 'WebSocket', message: MESSAGES.net },
          { name: 'EventSource', message: MESSAGES.net },
        ],
    'no-console': 'error',
  };
}

const EXT = '{ts,mts,cts,js,mjs,cjs}';
const GUARDED = [
  'cli.ts',
  `src/**/*.${EXT}`,
  `adapters/**/*.${EXT}`,
  `test/**/*.${EXT}`,
  'vitest.config.ts',
];

/** 必须起子进程的黑盒测试(验收脚本 ops/、打包产物冒烟、子进程内真 schema 校验)。 */
const SUBPROCESS_TESTS = [
  'test/accept/helpers.ts',
  'test/accept/a3.test.ts',
  'test/accept/a15.test.ts',
  'test/accept/p1-ops.test.ts',
  'test/accept/p1-lifecycle-ops.test.ts',
  'test/accept/p1-sync-update-ops.test.ts',
  'test/ops/helpers.ts',
  'test/build/bundle-artifact.test.ts',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '.state/**',
      // 故意违规的反向对照样本:正常 lint 跳过,test/lint 用 ESLint API 以 ignore:false 单独检查
      'test/fixtures/lint-violations/**',
    ],
  },
  ...tseslint.configs.recommended,
  { files: GUARDED, rules: restrictions() },
  { files: ['src/io/safe-fs.ts', 'src/io/read-fs.ts'], rules: restrictions({ allowFs: true }) },
  { files: ['src/io/paths.ts'], rules: restrictions({ allowEnv: true }) },
  { files: ['src/io/exec.ts'], rules: restrictions({ allowCp: true }) },
  // R0:受控 LLM 出口。llm-exec.ts 自己可用 child_process;能引用它的只有 reflect 后端目录与它们的测试。
  // 注意:flat config 里后面的同名规则会**整条替换**前面的,所以放行必须走 restrictions({...}) 生成,不能另写一块只含局部规则的 override。
  { files: ['src/io/llm-exec.ts'], rules: restrictions({ allowCp: true }) },
  {
    files: [
      `src/reflect/backends/**/*.${EXT}`,
      'test/io/llm-exec.test.ts',
      'test/io/llm-exec-host-env.test.ts',
      `test/reflect/backends/**/*.${EXT}`,
    ],
    rules: restrictions({ allowLlm: true }),
  },
  // S0:HOME 写出口。home-fs.ts 自己可用 fs(它是第三个写出口);能引用它的只有下面这几个文件与对应测试。
  // 同样注意:每块都必须由 restrictions({...}) 生成完整规则,后面同名规则会整条替换前面的。
  { files: ['src/io/home-fs.ts'], rules: restrictions({ allowFs: true }) },
  { files: ['src/sync/apply.ts'], rules: restrictions({ allowHomeFs: true }) },
  { files: ['test/io/home-fs*.test.ts'], rules: restrictions({ allowHomeFs: true }) },
  { files: ['test/sync/apply*.test.ts'], rules: restrictions({ allowHomeFs: true }) },
  // S0:网络出口。net.ts 自己可用网络模块与全局 fetch;使用方是 update 模块(launcher 除外)。
  { files: ['src/io/net.ts'], rules: restrictions({ allowNet: true }) },
  { files: ['test/io/net*.test.ts'], rules: restrictions({ allowNetOut: true }) },
  {
    files: [`src/update/**/*.${EXT}`],
    rules: restrictions({ allowNetOut: true, allowLauncher: true }),
  },
  {
    files: ['src/commands/update.ts'],
    rules: restrictions({ allowNetOut: true, allowLauncher: true }),
  },
  {
    // update 测试(安装器测试另可引用 home-fs;不能把 test/update/** 整体放开 home-fs)
    files: [`test/update/**/*.${EXT}`],
    rules: restrictions({ allowNetOut: true, allowLauncher: true }),
  },
  // S0:启动器。launcher.ts 本身不得引用 net.ts / home-fs(最小权限),只它能引用 runSelf。
  // 以下三块排在上面 src/update/** 之后,对 launcher.ts / install.ts 的更窄(或更宽)规则整条覆盖。
  { files: ['src/update/launcher.ts'], rules: restrictions({ allowRunSelf: true }) },
  // S7a:来源证明验签。provenance.ts 是唯一可 import `sigstore` 的文件(其余权限同 src/update/**)。
  {
    files: ['src/update/provenance.ts'],
    rules: restrictions({ allowNetOut: true, allowLauncher: true, allowSigstore: true }),
  },
  {
    files: ['src/update/install.ts'],
    rules: restrictions({ allowNetOut: true, allowLauncher: true, allowHomeFs: true }),
  },
  {
    files: ['test/update/install*.test.ts'],
    rules: restrictions({ allowNetOut: true, allowLauncher: true, allowHomeFs: true }),
  },
  {
    files: ['test/update/launcher*.test.ts'],
    rules: restrictions({ allowLauncher: true, allowRunSelf: true }),
  },
  { files: ['cli.ts', 'src/cli.ts'], rules: restrictions({ allowLauncher: true }) },
  // K6:以子进程方式跑 CLI / 验收脚本的黑盒测试(原先各自行内 eslint-disable)。只放开 child_process,fs/os/env 等照旧禁;
  // 范围是下面这几个具体文件,不放开 test/accept/**、test/ops/** 整个目录(新增的此类测试要显式登记在这里)。
  {
    files: SUBPROCESS_TESTS,
    rules: restrictions({ allowCpOnly: true }),
  },
  {
    // 本机口径:vitest 配置文件里允许 console 以外的一切照旧;eqeqeq 全局
    rules: { eqeqeq: ['error', 'always'] },
  },
);
