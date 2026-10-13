// @ts-check
import tseslint from 'typescript-eslint';

/**
 * A9 / A5 的静态护栏:
 *  - 文件系统:`node:fs` 系列只许出现在 src/io/safe-fs.ts(写)与 src/io/read-fs.ts(读)。
 *  - HOME / 环境变量 / cwd:`node:os`、`process.env`、`process.cwd` 只许出现在 src/io/paths.ts。
 *  - 子进程:`child_process` 只许出现在 src/io/exec.ts(git 白名单)与 src/io/llm-exec.ts(受控 LLM 出口,R0)。
 *  - LLM 出口:除 src/reflect/backends/** 外,任何文件不得 import / re-export / 动态 import `llm-exec`
 *    (命令层、reflect 干跑路径、judge 都经依赖注入拿后端);测试里只有 llm-exec / backends 的测试可以。
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
  env: 'HOME/环境/cwd 只经 src/io/paths.ts 的 IoContext。',
  net: 'P0 运行期零网络(A8)。',
  loader: '不得用 module/createRequire 绕开导入限制。',
};

/**
 * @param {{ allowFs?: boolean; allowCp?: boolean; allowEnv?: boolean; allowLlm?: boolean }} allow
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
  add(NODE_MODULES_CP, MESSAGES.cp, allow.allowCp);
  add(NODE_MODULES_ENV, MESSAGES.env, allow.allowEnv);
  add(NODE_MODULES_NET, MESSAGES.net, false);
  add(NODE_MODULES_LOADER, MESSAGES.loader, false);

  const dynamicRe = `^(node:)?(${dynamicBanned.map((n) => n.replace('/', '\\/')).join('|')})$`;
  /** llm-exec 的各种写法:`../io/llm-exec.js`、`./llm-exec`、`src/io/llm-exec.ts` */
  const LLM_EXEC_GROUP = ['**/llm-exec', '**/llm-exec.js', '**/llm-exec.ts', '**/llm-exec.*'];

  /** @type {{selector: string; message: string}[]} */
  const syntax = [
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
        ],
      },
    ],
    'no-restricted-syntax': ['error', ...syntax],
    'no-restricted-properties': ['error', ...props],
    'no-restricted-globals': [
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
      `test/reflect/backends/**/*.${EXT}`,
    ],
    rules: restrictions({ allowLlm: true }),
  },
  {
    // 本机口径:vitest 配置文件里允许 console 以外的一切照旧;eqeqeq 全局
    rules: { eqeqeq: ['error', 'always'] },
  },
);
