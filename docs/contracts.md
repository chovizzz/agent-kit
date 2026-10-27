# 契约(contracts-v1)

本文是 `src/contracts/**` 的人读版,也是契约测试的数据源:**文中带 `<!-- example:... -->` 标记的 JSON 块会被
`test/contracts/examples.test.ts` 逐个抽出,用对应的 zod schema 校验**(`valid` 必须通过,`invalid` 必须失败)。
改契约时文档、schema、示例三处同步,测试会拦住不同步。

契约只含**类型 + zod schema + JSON 示例**,没有业务逻辑。TS 类型一律 `z.infer` 自 schema,不手写第二份,以免漂移。

## 1. 变更规则

- `contracts-v1` tag 之后,契约只允许**追加可选字段**,不删、不改既有字段的名字/类型/含义。
- 任何契约变更 = 主代理评审 + 受影响块重新验收。块内发现契约缺项时,**不要自己改 `src/contracts/**`**,在汇报里列为「待主代理接线」。
- 所有 schema 用 `z.strictObject`:未知字段即错误。这是有意的——新字段必须先进契约,再进数据。
- 本契约不构成对任何 agent 的兼容性声明(Q-N14):P0 的 golden 快照只证明输出**确定**,不证明格式对该 agent **有效**。
  每个输出文件带 `confidence`(`documented` / `probed` / `assumed`),P1 探针通过前不得对外宣称「支持」。

## 2. 退出码

| 码  | 常量              | 含义                                                        |
| --- | ----------------- | ----------------------------------------------------------- |
| 0   | `OK`              | 成功                                                        |
| 1   | `CHECK_FAILED`    | 检查失败(lint / budget / guard 判不通过)                    |
| 2   | `USAGE`           | 用法错误(未知命令、缺参数、flag 非法)                       |
| 3   | `FAIL_CLOSED`     | fail-closed:脱敏异常/超时/残留、写出口拒绝、不变量破坏      |
| 4   | `NOT_RUN`         | 未执行(依赖缺失,如 audit 工具或网络不可用);**不得**当作通过 |
| 64  | `NOT_IMPLEMENTED` | 未实现(命令桩;P1+ 或本块尚未替换)                           |

多步命令(如 `check`)合并退出码的优先级:3 > 2 > 1 > 4 > 64 > 0。含命令桩时不会返回 0,所以半成品不会被误判为通过。

## 3. 诊断(Diagnostic)与诊断码

`{ code, severity: 'error'|'warn', path, message }`。`code` 稳定,fixture 的 `expect.json` 断言 code,不断言 message。
格式 `<DOMAIN>_<NAME>`,大写下划线。预留前缀:`SCHEMA_` `ATOM_` `SKILL_` `AGENT_` `MERGE_` `BUDGET_` `GUARD_` `REDACT_` `READER_` `CFG_` `IO_` `RENDER_`。
zod 校验失败统一映射为 `SCHEMA_INVALID`(`zodIssuesToDiagnostics`);各块在此之上追加自己的 lint 码。
排序确定:path → code → message,字节序(`sortDiagnostics`)。

### 3.1 schema 强制 vs lint 强制(原子 D §3.4)

| 约束                                                                                                                                           | 谁管                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 必填、枚举、类型、`id` kebab、`title` ≤60 字(码点)、`created`/`review_by` 为真实存在的 `YYYY-MM-DD`、`evidence` ≥1 且 `excerpt` ≤300 字        | **schema**               |
| `strength=must` ⇒ `verifier.type≠none`;`verifier.type≠none` ⇒ 有 `ref`;`status=active` ⇒ 有 `signature`;`signature.type≠always` ⇒ 有 `pattern` | **schema**(纯字段间关系) |
| `id` 等于文件名;`layer` 与目录一致;`why/做/怎么验` 三段齐全且非空                                                                              | lint(B03)                |
| `fact` ⇒ 有 `review_by`(`review_by` 已是必填,故实际由 schema 保证)                                                                             | schema                   |
| `volatile` ⇒ `review_by ≤ created+30d`;所有原子 `review_by ≤ created+180d`(日期算术,注意跨月/闰年)                                             | lint(B03)                |
| `evidence.excerpt` 过脱敏扫描(经 `Redactor.pass2` 注入)                                                                                        | lint(B03)                |
| `verifier.ref` 指向的文件存在;`owner` 在 CODEOWNERS;`origin/supersedes/merged_from` 的 id 存在                                                 | lint(B03)                |
| `bodyBytes ≤ atom_max_bytes`(默认 600;P0 为 warn,见 §6)                                                                                        | lint(B03)                |
| 技能 `name` 等于目录名、`description ≤1024`;子代理 `model_tier` 枚举                                                                           | schema + lint            |
| core(`rules/` `agents/`)内不得出现具体模型名                                                                                                   | lint(B03)                |
| 状态守卫 G1–G4、反思器路径守卫                                                                                                                 | B04                      |

## 4. 必须定死的四件事 + 一条声明

### 4.1 `inventory` 是命令桩

`agent-kit inventory` 在 P0 注册为**命令桩,退出 64**,提示「盘点是 P0 交付物(`inventory/*.md`),P1 才进 CLI」。
盘点由 haiku 一次性产出文件,不是 CLI 输出;零写入验收(A5)的命令集**不包含** `inventory`。

### 4.2 personal 层决策(a)

> **v3.1 修订(§21.18 第 1 条,V2 生效)**:本节只约束**包 payload**(npm 包与 `out/`);本机 payload(R21-8.1)渲染 `origin=auto_rsi` 的 personal 原子,A15 只针对包 payload。V2 之前本节照旧全部成立。

- 合并结果(`MergeResult`)里 `personal` 原子**照常出现**,但 `coreEligible=false`(P0 恒为 `layer==='personal'` 时 false)。
- 渲染器**只消费 `coreEligible=true` 的原子**;P0 对 personal 层输出为空,并在渲染报告 `skippedLayers` 里写
  `{ layer: 'personal', reason: 'P2 才在本机渲染' }`。真实渲染留 P2。
- `buildManifest` 对 `resolved` 里重复的原子 id 抛 `ManifestDuplicateAtomError`(build 退出 3,渲染前也先拦),不做「后者覆盖」;merge 无 error 时 id 本就唯一。
- `out/manifest.json`(`Manifest`)记录每个输出文件的来源原子 `{ id, layer }`;A15 脚本逐文件核对不存在 `layer=personal` 的来源。
- 预算口径里 personal 份额在 P0 为 0,并在报告说明。
- **personal 的 `overrides` / `disables` 不影响 core 输出**(B21/B2):`mergeAtoms` 默认 `view: 'core'`,personal 层发出的边照常做全部校验(`MERGE_MUST_LOCKED` / `MERGE_TARGET_MISSING` / `MERGE_OVERRIDE_DIRECTION` / `MERGE_OVERRIDE_CYCLE` 仍是 error,会阻断 build),
  也照常记入 `overridden`(`byLayer: 'personal'`,报告里表示「P2 本机才生效」),但**不把目标从结果里剔除**——被指向的 team / org 的 should 原子仍在,`coreEligible=true`,仍渲染进 `out/`。
  `mergeAtoms(atoms, { view: 'preview' })` 让 personal 的边也生效,留给 P2 的本机预览;P0 没有调用方。

### 4.3 `inventory/commands.sh` 格式契约

制表符分隔的行,每行 4 列:

```
<编号>\t<命令>\t<期望值>\t<时点ISO>
```

- 命令为**单行、只读**,可在仓库根直接 `bash -c '<命令>'` 执行。
- 期望值是字符串;单调增项写 `>=N`(例如会话文件数只增不减)。
- 时点为 UTC ISO 8601(如 `2026-10-08T12:00:00Z`)。
- 盘点报告里每个计数以 `[#编号]` 引用;`a7` 脚本按编号逐行重跑并比对。空行与 `#` 开头的行忽略。
- 期望值是时点快照:个人文件变化后用 `ops/inventory-refresh.mjs` 刷新(默认 dry-run,`--apply` 才写 `inventory/**`)。它只改值变了的行的第 3、4 列,并同步 md 里 `[#编号]` 紧邻的数值;`>=N` 行只在新值小于 N 时才下调;无法无歧义绑定的位置不改,列为「需人工核对」。

### 4.4 测试 harness 的 git 环境卫生

任何起 git 子进程的测试代码(`test/helpers/make-repo.ts` 等,B04/B17)统一:

- 环境变量:`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`HOME=$KIT_TMP/githome`(事先建好的空目录)。
- 每条命令加 `-c user.name=kit-test -c user.email=kit-test@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main`。
- 一律经 `src/io/exec.ts`(默认**不继承 HOME**,上述变量由调用方在 `opts.env` 里显式给),仓库建在 `$KIT_TMP` 下;
  禁止读写真实的全局 git 配置。

### 4.5 Q-N14:golden 不是兼容声明

见 §1 末条。

## 5. 路径与环境约定(io 层)

| 约定                | 落点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一写出口          | `src/io/safe-fs.ts`;每次写前校验目标(解析 symlink 后)落在 `IoContext.writeRoots` 内,违者 `WriteDeniedError`(`IO_WRITE_DENIED`),CLI 退出 3。拒绝:根外、`..` 逃逸、符号链接逃逸、悬空链接、硬链接(`nlink>1`)、写/删根本身。**`createExclusive(ctx, path, content, mode)`(R20-A0,§20.9 第 4 条)**:`O_CREAT\|O_EXCL\|O_NOFOLLOW` 独占创建并写入,已存在(含符号链接)→ 失败、不覆盖,同受 `writeRoots` 守卫;`mode` 必填,创建后显式 `fchmod`                                                                                                                                                                                                                                                                                                           |
| 唯一读 HOME/env/cwd | `src/io/paths.ts`(`os.homedir()` / `process.env` / `process.cwd()` 只许出现在这里)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 只读出口            | `src/io/read-fs.ts`(不导出任何写 API;读真实会话目录靠 `--source` 显式传入)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 唯一子进程          | `src/io/exec.ts`:无 shell;**二进制白名单(P0 只有 `git`)**;env 键白名单 `GIT_*`/`HOME`/`LANG`/`LC_*`/`TZ`,默认只有 `PATH` 加 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`(HOME 缺失时 git 会经 passwd 回退读真实 `~/.gitconfig`,所以默认屏蔽;调用方可覆盖)、**不继承 HOME**;显式传 `HOME` 时其值必须在 `KIT_TMP` 内。加二进制 = 契约变更                                                                                                                                                                                                                                                                                                                                                                                             |
| 受控 LLM 出口       | `src/io/llm-exec.ts`(R0,#28,见 §5.2):与 `exec.ts` 分开;`allowEgress:true` 才可用;env 名字白名单;固定 cwd;超时/stdout 32KiB/spawn 次数上限;不经 shell。eslint:`child_process` 只许 `exec.ts` 与 `llm-exec.ts`;`llm-exec` 只许 `src/reflect/backends/**` 引用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 写入根              | 默认 = `<repo>/out/`、`<state>`(默认 `<repo>/.state/`)、`$KIT_TMP`(若设)。`KIT_WRITE_ROOTS`(`path.delimiter` 分隔的绝对路径)**只能收窄**:每项必须落在默认根之内,越界、相对路径、`/`、HOME 及其上级一律 `PathsError`(退出 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| state 位置          | P0 只能在仓库内或 `KIT_TMP` 内(`KIT_STATE_DIR` 可改);`KIT_STATE_DIR` / `KIT_TMP` 不得等于或位于 `out/` 之下,字面路径与解析后的真实路径(含 `out` 或上级是符号链接、悬空链接)各判一遍,大小写不敏感比较,违者 `PathsError`(退出 3);`~/.local/state/<kit>/` 留到 P2(Q-N13),届时只改 `paths.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 写入根的真实位置    | 校验字面路径不够:`createIoContext` 与 safe-fs **每次写入**都对全部写入根按 realpath(含最长已存在前缀)再判一遍——真实位置必须位于真实的仓库根或 `KIT_TMP` 之内,且位于真实的 `out/`、state、`KIT_TMP` 之一之内(大小写精确比较 + 沿祖先链比 (dev,ino) 认出 NFD / firmlink / 大小写不敏感卷的同一目录)。违者 `PathsError`(退出 3)/ `WriteDeniedError`;悬空链接一律拒;`out/` 与 state 的最后一段本身是符号链接(哪怕指向仓库内)一律拒;`KIT_TMP`、写入根解析后落到 HOME 或其上级 / `/` 也拒。覆盖「链接在中间一段」「写入根或状态目录的链接事后改指向」「`out/` 或 state 本身是指向仓库外的链接」。已知残余:校验与 fs 调用之间的竞态(无 `openat`/`O_NOFOLLOW`)、仓库位于 `KIT_TMP` 之下时指向仓库的链接仍落在 `KIT_TMP` 内(与 `KIT_TMP` 范围同属未决) |
| 相对路径            | 写出口按 **repoRoot** 解析相对路径,不按 cwd                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `~`                 | P0 **不展开** `~/.config/<kit>`;覆盖层只经 `--overlay <path>`;`out/<agent>/home/…` 的 `home` 只是路径记号,任何代码不得把它展开成真实 HOME                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 复制来源            | `copyFile` 的来源限定在仓库或写入根内,不能把仓库外的内容(如 `~/.ssh`)吸进 `out/`;来源是硬链接(nlink>1)一律拒。`mkdtemp` 的 prefix 不得含路径分隔符或 `..`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 测试临时目录        | `safe-fs.mkdtemp(ctx, ctx.tmpDir ?? <state>/test-tmp, prefix)`;测试不得自己 `import node:fs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 确定性序列化        | `canonicalJson`(键序、2 空格、LF、末尾换行,拒 undefined/NaN/环/非纯对象)、`canonicalText`(LF,末尾恰一个换行)、`canonicalJsonLine`(R20-A0,§20.9 第 20 条:键序与拒绝规则同 `canonicalJson`,但单行、无缩进、恰一个末尾 `\n`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 5.2 受控 LLM 出口 `src/io/llm-exec.ts`(R0,#28)

`runLlm(ctx, req)`(异步)。**契约变更**:这是 `exec.ts` 之外第二个子进程出口,用于 reflect / judge 调用第三方 LLM CLI(摘录会离开本机)。

- **开关**:`req.allowEgress` 必须是布尔 `true`,否则 `IO_LLM_EGRESS_DENIED`,不 spawn、不消耗预算。命令层只在用户同时给 `--run-llm --allow-egress` 后置 true;**干跑路径不得 import 本模块**(eslint 强制,见下)。
- **二进制**:只能是 `claude` / `codex` / `pi`(裸名按 `envSource.PATH` 的绝对项解析,或同名绝对路径);解析结果落在仓库内且不在 `KIT_TMP` 内 → 拒(防仓库里埋假 `claude`)。`shell:false`,参数数组,≤64 个、每个 ≤8KiB、无 NUL;提示走 stdin(≤64KiB)。
- **env**:不继承。`LLM_ENV_ALLOW` 名字白名单(`PATH HOME USER LOGNAME LANG LC_* TZ TMPDIR XDG_*_HOME` 与代理变量)+ 固定 `NO_COLOR=1` 与 `KIT_RSI_CHILD=1`(后者 R20-A0,§20.9 第 5 条:让 kit 起的 LLM 子进程里钩子触发的 `rsi poke|hint` 空操作);key/token/secret、`*_BASE_URL`、`CODEX_HOME`、`NODE_OPTIONS`、`LD_*`、`TERM` 等一律不传。唯一例外 `passEnv`:调用方在代码里写死、形如 `<NAME>_API_KEY` 的名字。本模块不读进程环境(只许 `paths.ts`),`envSource` 由调用方给,`filterLlmEnv()` 负责挑选(`IoContext.hostEnv` 由 `paths.ts` 提供,见 §12.4 ④)。`HOME` 传**真实 HOME**(CLI 要读自己的登录态),必须绝对路径。
- **cwd**:固定 `<state>/reflect/cwd/`(0700,调用方不能指定);运行前必须为空(否则 `IO_LLM_CWD_DENIED`,不替用户删),运行后清掉子进程留下的条目并计数(`cwdResidue`)。目的:CLI 自动发现不到 CLAUDE.md / AGENTS.md。
- **限制**:超时 1..600000ms(SIGKILL 整个进程组,正常退出后也杀遗留组员);stdout ≤32KiB(超出即杀并标 `stdoutTruncated`,调用方须视为失败);stderr 只留 4KiB;`LlmSpawnBudget(max≤10)` 在每次 spawn 前消耗,耗尽 `IO_LLM_SPAWN_LIMIT`。被拒的请求不消耗预算,失败的 spawn 消耗。
- **eslint**:`child_process` 只许 `src/io/exec.ts`、`src/io/llm-exec.ts`;`llm-exec`(import / export-from / 动态 import)只许 `src/reflect/backends/**` 与 `test/io/llm-exec*.test.ts`、`test/reflect/backends/**`。命令层(`src/commands/{reflect,judge}.ts`)与 judge **经依赖注入**拿后端,不直接 import。放行走 `restrictions({allowLlm})` 生成(flat config 同名规则整条替换,不能另写局部 override)。**R3 须加传递依赖测试**:非 backends 的 `src/reflect/**` 不得经任何路径 import 到 llm-exec,backends 文件不得 re-export `runLlm`。
- **二进制**:名字叫 `claude` 却实际指向 `sh/bash/env/python…` 的符号链接拒;动态 import 来源含 `%` 一律拒(防 `%2D` 绕开路径匹配);测试放行只给 `test/io/llm-exec.test.ts` 与 `test/reflect/backends/**`。
- **R3 传参要求**:codex 每次显式传 `-m` 与 `-c model_provider=…`(用户 `~/.codex/config.toml` 可改默认 provider);claude 带 `--strict-mcp-config`、codex 带 `-c mcp_servers={}`(**不带引号**,见 §17.6)等无工具参数——R6 实测结论见 §17.6,未覆盖项仍「未核实」,拿不准 fail-closed。

### 5.1 lint 护栏的范围与已知洞(A9)

- **范围**:`cli.ts`、`src/`、`adapters/`、`test/`、`vitest.config.ts`。`ops/`(B17/B18 的验收工具脚本)**不在范围内**——它们本来就要读真实 HOME 做快照;
  反过来,范围内的代码**不得 import `ops/**`**(lint 规则`no-restricted-imports`的 pattern)。
- **规则**:`node:fs`/`fs/promises`、`child_process`/`worker_threads`/`cluster`/`vm`/`inspector`、`os`/`process`(模块导入)、`module`(createRequire)、网络模块、全局 `fetch` 等一律禁止,
  仅 `src/io/{safe-fs,read-fs,paths,exec}.ts` 按各自职责放行(见 `eslint.config.js` 的 override)。另禁:`require`、`eval`、`new Function`、`globalThis`/`global`、
  `process.env|cwd|chdir|umask|binding|getBuiltinModule|dlopen`、`process[动态键]`、把 `process` 赋值/解构/传递、动态 `import()` 的非字面量或 `data:`/`http(s):`/`file:` 来源。
- **证明**:`test/fixtures/lint-violations/*.ts` 是故意违规样本(正常 lint 忽略该目录),`test/lint/violations.test.ts` 用 ESLint API 逐个检查必须命中预期规则;
  同一段代码放进被授权文件则零报错(正向对照)。
- **新增 io 例外 = 契约变更**:例如 reader 要一个统一的 `O_RDONLY` 打开入口(plan M-5 的 `open-readonly`),应该做成 `src/io/read-fs.ts` 的一个导出,而不是新开 fs 例外文件;
  确需新文件时,由主代理改 `eslint.config.js`(它只由 B01/主代理改)。
- **lint 管不到的**(靠评审与运行期判据):`process.stdout` 重定向、第三方包间接写盘、被调子进程自己写盘、数据 URL 之类静态不可见的内容。
  **运行期兜底建议(给 B18 的 a9/a5 脚本)**:用 Node 权限模型跑 `dist/cli.js` 全部命令——`node --permission --allow-fs-read='*' --allow-fs-write=<out>,<.state>,<KIT_TMP> dist/cli.js …`
  (Node 22 的旗标名是 `--experimental-permission`,Node ≥24 是 `--permission`;B01 已在本机 Node 25 上验证命令桩可在该模式下运行)。校验与写入之间存在极短的 TOCTOU 窗口,本机单用户场景接受。

## 6. 预算口径(B05 实现,口径在此定死)

- **字节** = `Buffer.byteLength(content, 'utf8')`(中文 3 字节),**含托管块标记行**(agent 实际读到的是整个文件)。
- **行数** = 内容中 `\n` 的个数;末尾无换行时再 +1;空串为 0。(输出经 `canonicalText`,恒以 `\n` 结尾。)
- **按目标求和**:一个目标(agent)会同时加载的全部本套件产物相加;`conditional` 非空的文件**不计**。
- **按原子 id 去重**:同一原子出现在同一目标的多个文件时,其正文字节只计一份。依据 `OutFile.atomBytes`
  (见 §8「接口走查」第 1 条)。公式:目标总字节 = Σ 文件字节 − Σ_{原子 id 出现 k>1 次} (k−1)×该原子的 `atomBytes`。
- **level**:`over` = 超过任一 `max_*`(严格大于);`near` = 未超但 `bytes×100 ≥ max×threshold_percent`(默认 90,比较符 **≥**);否则 `ok`。
  `hard_limit` 为数字且被超过时,另出 `BUDGET_OVER_HARD_LIMIT`,阻断规则同下。
- **阻断规则**:`blocking = (level==='over') && (enforce==='block') && (limit_source !== 'assumed')`。
  `assumed` 目标不论 `enforce` 都只告警(设计 §3.6 硬规则)。blocking 的诊断 severity 为 `error`,否则为 `warn`;`check` 在存在 `error` 时退出 1。
- 决策 ②:`enforce` 默认 `block`(documented/probed 目标)。
  **P1 落地(2026-10-09)**:`BudgetConfigSchema.enforce` 缺省改为 `block`(assumed 目标恒只告警的 carve-out 不变,
  故缺省阻断实际只作用于 documented/probed)。
  **收口(用户拍板 D2)**:默认 block 已生效,真实仓库 `kit.toml` 的 `enforce` 已由 `warn` 改为 `block`(probe 定稿后收紧);
  验收 A2 同步订正为断言真实 `kit.toml` 为 `block` 且 `check` 退出 0(见 §17.5「A2 语义订正」)。

- **实现与上述口径的已知偏离(如实记录,B21/B5)**:
  1. 除 `conditional` 非空外,**纯技能/子代理文件**(有 `sourceRefs`、不含规则原子)也**不计入**预算(`countsTowardBudget`):技能/子代理按需加载、不常驻,这是实现里加的口径,各 agent 是否真如此未逐家核实。
  2. 去重公式实现为「目标总字节 = Σ 各处该原子的 `atomBytes` − 其中最大的一份」(同一原子各处字节相同时与上面的 `(k−1)×atomBytes` 等价;不同时实现更保守,即扣得少)。
  3. 预算报告 `targets[].files` 只记文件的 `relPath`(项目链为 `projectChain#i`),不含 `<agent>/<target>/` 前缀:同一目标下 home 与 project 都有 `AGENTS.md` / `CLAUDE.md` 时会出现两个同名项,报告里无法区分是哪一个。
  4. `budgetFailed` 用「诊断里有 error」判断,所以 `enforce=block` 下的 `BUDGET_ATOM_TOO_LARGE`(单原子正文超限,**不看** `limit_source`)也会让 build 退出 1;lint 的 `ATOM_BODY_TOO_LARGE` 通常更早拦下。
- **多维度目标**:逐维度判断(bytes↔`max_bytes`,lines↔`max_lines`),只配了一个维度的目标只看那一维;目标级 `level` = 任一维度 `over` 则 `over`,否则任一维度 `near` 则 `near`,否则 `ok`。
- **Codex 项目链**:`projectChain` 是根→cwd 各层 AGENTS.md 的**文本内容**数组,字节数按 UTF-8 计后与托管块产物相加。

A2 的 15 格矩阵(`limit_source` × `enforce` × 超/不超,外加「不写 `enforce`、走缺省 block」×超 3 格;退出码 / 是否出告警):

| limit_source | enforce | 超   | 退出码 | 告警      |
| ------------ | ------- | ---- | ------ | --------- |
| documented   | warn    | 超   | 0      | 有        |
| documented   | warn    | 不超 | 0      | 无        |
| documented   | block   | 超   | **1**  | 有(error) |
| documented   | block   | 不超 | 0      | 无        |
| probed       | warn    | 超   | 0      | 有        |
| probed       | warn    | 不超 | 0      | 无        |
| probed       | block   | 超   | **1**  | 有(error) |
| probed       | block   | 不超 | 0      | 无        |
| assumed      | warn    | 超   | 0      | 有        |
| assumed      | warn    | 不超 | 0      | 无        |
| assumed      | block   | 超   | **0**  | 有(warn)  |
| assumed      | block   | 不超 | 0      | 无        |
| documented   | 不写    | 超   | **1**  | 有(error) |
| probed       | 不写    | 超   | **1**  | 有(error) |
| assumed      | 不写    | 超   | **0**  | 有(warn)  |

「不超」指 level 为 `ok`;处于 `near` 时同样无阻断,但出一条 `warn` 级的 `BUDGET_NEAR_LIMIT`(提示一进一出)。

## 7. 命令面(`src/cli.ts` 注册表;命令桩的形状)

| 命令                                                  | 阶段   | 文件                              | 备注                                                                                                                                                |
| ----------------------------------------------------- | ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`                                               | P0     | `src/commands/build.ts`           | 合并+渲染到 `out/`;**B01 之后无块的边界覆盖它**,由 B19 接线                                                                                         |
| `check`                                               | P0     | `src/commands/check.ts`           | 组合 `lint-cmd.ts`(B03)、`check-budget.ts`(B05)、`guards-cmd.ts`(B04)                                                                               |
| `redact`                                              | P0     | `src/commands/redact-cmd.ts`      | `--selftest` / `--stdin`(B09)                                                                                                                       |
| `signals collect`                                     | P0     | `src/commands/signals-collect.ts` | `--source <路径> --dry`(B10b)                                                                                                                       |
| `inventory`                                           | P1(桩) | `src/commands/inventory.ts`       | 见 §4.1                                                                                                                                             |
| `probe` `reflect` `judge` `attest` `promote` `retire` | P1     | 各一个文件                        | `probe` `reflect` `judge` `attest` `promote` `retire` 均已实装(`reflect`/`judge` 见 §17;probe 见 §8 #12),本行已无桩;现存命令桩只剩 `inventory`      |
| `calibrate`                                           | P1     | `src/commands/calibrate.ts`       | 已实装(K5b:judge 校准账的只读报告,零写入零网络,契约见 §18.10「K5b」)                                                                                |
| `sync` `doctor`                                       | P2     | 各一个文件                        | 已实装(S4 / S5,契约见 §19.2 / §19.3)                                                                                                                |
| `update`                                              | P2     | `src/commands/update.ts`          | 已实装(S7c-A:检查 / 安装 / 回滚;S7c-B:启动器、后台 worker `__update --background`(内部入口,不在本表、不进 --help)、自动同步评估,契约见 §19.4–§19.7) |

- 全局选项(由 `cli.ts` 取走,命令不用管):`--root <dir>`、`--overlay <path>`、`-h/--help`、`-v/--version`。
- `check` 的完整 flag 集合在 B01 定死:`--guards`、`--base <ref>`、`--head <ref>`、`--label <name>`、`--report`;解析后以 `CheckOptions`
  交给三个子 runner(`export const run: CheckStep`)。`--guards` 必须同时给 `--base` 与 `--head`,否则退出 2。
- 命令桩一律 `stubExit`:往 stderr 打印原因,**退出 64**。后续块替换文件内容时保持 `export const command: CommandDef`(或 `export const run: CheckStep`),不改 `cli.ts`。

## 8. 接口走查:对设计文档的补缺与偏离

走查对象:设计 §3.4(原子字段表)、§6.2(信号结构)、§3.6(预算)。

1. **`OutFile.atomBytes`(补缺)**:§3.6 要求「按原子 id 去重、每个原子正文字节只计一次」,但仅凭 `content` 无法知道某原子占多少字节。
   `OutFile` 增加 `atomBytes: Record<atomId, number>`(键集合必须等于 `atomIds`),由渲染器填写。
2. **`do` 对 `how`(命名)**:§3.4 表里「做」字段叫 `how`,plan-P0 §2.2 的接口示意叫 `do`。本契约取 **`do`**;正文三段为
   `**做**:` `**为什么**:` `**怎么验**:`。
3. **`applies_to` 缺省**:§3.4 里不是必填;schema 里 `optional`,缺省语义为 `['all']`,由解析器(B03)补。
4. **`supersedes` / `merged_from` 是 id 数组**,`origin` 是自由串(提案编号如 `proposal/2026-10-08-003`),不是原子 id。设计只说「谱系」,此为取值决定。
5. **渠道成员表值**:设计只说「成员表」,未定义成员的值。取 `{ since?: 日期, note?: string }`(可全空),键为成员 handle。P0 只校验不使用。
6. **`NormEvent.ts` 必填**:A6 要求 `ts` 非空率 100%。事件源缺时间戳时,reader 必须回退(会话起始/文件 mtime),回退规则由 B10a 写明。
7. **`Hit` 不含命中文本**:诊断输出不得泄露它要拦的内容,`Hit` 只有 `type/rule/start/end`,`.strict()` 保证塞不进 `text`。
8. **`Signal.excerpt_redacted` 允许空串**:含外部内容的会话「摘录不进反思器,只保留结构化计数」(设计 §6.1)。
9. **`ResolvedAtom.coreEligible`**:承载 §3.5-5「personal 永不进 core 输出」,见 §4.2。
10. **预算输入是对象**:`computeBudget({ outputs, config, projectChain? })`,而不是 plan 示意的位置参数;`projectChain` 为 Codex 项目链(根→cwd 各层 AGENTS.md 的内容)。

11. **P1 口子 schema(plan-P0 §7 要求)**:`Proposal`(含 `JudgeRecord.hops` 兜底链前缀校验)、`JudgeOutput`、`Attest`、`Case`、`ReplayReport`,
    以及文件名构造函数 `attestFileName` / `reportFileName`。字段照设计 §5.5 / §6.5 / §6.6。设计未给取值档的地方是**本契约的假设**:
    `overfit_risk`/`generality` 取 `low|medium|high`;`Attest.member` 必须是 `@handle`;`ReplayReport` 要求 `ci_run_url` 与 `self_reported:true` 二选一;
    `Attest` 在设计示例之外多一个 `run_id`(设计说文件名带 `run_id`,载荷里也要有,CI 才能比对)。
12. **阈值探针写回结构(plan-P0 §7)**:`BudgetTarget` 增加可选 `probed_value` / `probed_agent_version` / `probed_at`;`limit_source=probed` 时三者必填。另有可选 `probed_lines`(PB5,§1 只追加):正整数,只允许 `limit_source=probed` 且同配 `max_lines` 时出现,否则校验失败(诊断前缀 `PROBED_LINES_REQUIRES_PROBED` / `PROBED_LINES_REQUIRES_MAX_LINES`)。
    **语义(D1 定稿)**:`probed_value` 是**外部观测到的上限**(人在真实 agent 上观察到的),**不是 kit 产物大小**;kit 只记录,不编造。
    `agent-kit probe` 实装——干跑打印各目标实测 bytes/lines 及相对上限的余量(仅供参考,不写入任何补丁);
    `--write` 对非 `documented` 目标必须同时给 `--agent-version <agent>=<x.y.z>` 与 `--observed`(写法见下),
    产出 kit.toml 目标补丁(`limit_source=probed`、`probed_value` + 三元组,max_bytes/max_lines 原值不动),**不直接写文件系统**;
    `documented` 目标永不改写。**单维度目标**(只配 max_bytes 或只配 max_lines)写 `--observed <agent>=<N>`,N 的单位 = 该维度;
    **双维度目标**(同一目标同时配 max_bytes 与 max_lines,PB4)必须写 `--observed <agent>=bytes:<N>,lines:<M>`(N、M 都是不带前导零、不超过 `Number.MAX_SAFE_INTEGER` 的正整数),两个维度各自与观测值比。
    写法与目标不符(双维度只给单值或只给一个维度;单维度给 `bytes:`/`lines:` 形式)→ `PROBE_OBSERVED_DIM_MISMATCH`。
    任一已配维度的原 max 大于对应观测值时本命令拒绝整批出补丁(`PROBE_LIMIT_ABOVE_OBSERVED`,信息里带维度);这只约束 probe 的输出,schema 不校验 max 与 probed_value 的关系(§1 只追加)。
    **落盘(PB5)**:单维度只写 `probed_value`(那个观测值,不写 `probed_lines`);双维度写 `probed_value` = bytes 观测值 + `probed_lines` = lines 观测值(两个维度都落盘并各自参与比较)。预算计算(budget/check)不读 `probed_value`/`probed_lines`,二者纯记录,不参与阈值比较。
    稳定错误码(均退出 2):`PROBE_BAD_OBSERVED` / `PROBE_DUPLICATE_OBSERVED` / `PROBE_OBSERVED_REQUIRED` / `PROBE_OBSERVED_DIM_MISMATCH` / `PROBE_LIMIT_ABOVE_OBSERVED`
    (另有 PB1 的 `PROBE_BAD_AGENT_VERSION` 等);缺 `--agent-version` 同样按 USAGE 拒绝(宁可报错不编造)。render 报告的 `pendingProbes`
    (有效性探针 P-Q*)由 probe 汇总列出,仍不作为事实;真实 agent 观察属主代理真实环境项。
13. **`ResolvedAtom`/`MergeResult` 在 B01 定稿**(plan-P0 B07 依赖「B05 的合并结果类型已在 B01 定」)。
14. **`Hop.result` 取值**:`ok | skipped:cooldown | skipped:same-vendor | error:<码>`;**不含** `skipped:known-unavailable`(Q-N16 未决,等设计者)。
15. **adapters 骨架桩**:`adapters/<agent>/index.ts`(`export const adapter: Adapter`)与 `managed-targets.json` 由 B01 预建,B06 的注册表静态 import 它们;
    B07/B08 只替换自己目录下的文件,不会在共享 `index.ts` 上冲突。

16. **`project_key` 形状**:schema 只要求非空;哈希形态 `p_`+16 位十六进制,明文形态仅限覆盖层允许名单,由 B10b 管线保证(schema 无法区分来源)。
17. **`Overlay.internal_domains` → 脱敏**:B09 把它与 `sensitive_words` 同等处理(命中即替换为 `[[REDACTED:domain]]`),与 `allowed_url_hosts`(放行名单)语义相反。
18. **`Proposal.reflector.vendor`** 必填(设计 §5.5 要按厂商比较);`Proposal` 上校验 `judge.vendor ≠ reflector.vendor`,且与反思器同厂商的跳必须记 `skipped:same-vendor`。
19. **`oversized_lines`**:`Counts` / `CollectReport` 的可选计数,单行超 `maxEventBytes` 被丢弃时累加(B10b)。
20. **Redactor 对「按名字读取变量」的处理(B09b)**:`NAME=` 之后跟的是引用(收尾引号 + 空白 / 终结符、占位符占了值的位置)而不是值时,`pass1` 不脱敏、`pass2` 不报残留;判据与取舍见 `docs/redaction.md` §3.1。接口 `Redactor` 本身不变;新增变异阶段 id `view_json_ws`(变异自检共 67 项)。
21. **Redactor 值类规则的召回修复(B09c,订正第 20 条)**:`cred_assign` / `cred_cli_flag` / `cred_authz` / `cred_cookie` 不再按前缀 / 形状放行(标识符后紧贴 `; , ) :`、`X(y)`、`env.` `vault` `...` `<` `%` `$` 开头等),改为**引用形态整词白名单**,不匹配就当口令;无引号的值先剥尾部标点再判,只脱敏核心。新增 `cred_assign_ext` 规则(反引号 / 三引号 / 类型标注 / 引号拼接 / `passphrase` 短语)与原视图补扫(口令里的字面 `\t` `\n` 不再截断值)。接口 `Redactor` 本身不变;新增变异阶段 id `view_orig_union` `ref_tail_punct` `ref_boundary` `ref_flag_strict` `placeholder_boundary` `ref_trailing_literal` 与规则 id `cred_assign_ext`(变异自检共 74 项);判据、取舍与剩余缺口见 `docs/redaction.md` §3.2、§7。第 20 条里「值本身像引用」指 §3.2 的引用形态。

22. **Signal 可选字段(R0)**:追加 `event_kind`(`user_message|tool_call|tool_result_failed`)、`event_index`(int≥0,与 `sigIdFor` 的序号相同)、`tool_name`(契约层只校验长度 1..96 与字符集 `[A-Za-z0-9_.:()<>+-]`,含字面量 `<unprintable>`;是否过脱敏由实现的 `safeKey` 负责)。全部可选,旧信号文件仍通过校验;`sig_id` 算法不变。存量行没有新字段,reflect 把它们当 unknown 排除或重采(R1 定)。
23. **会话计数库(R0)**:`.state/sessions/<agent>/<yyyymm>.jsonl`(目录 0700、文件 0600),每行 `SessionStat {session_ref, project_key, ts, external_content, counts}`;`counts` = `Counts` 的字段,但 `unknown_event_types` / `ignored_duplicate_kinds` 的**键**限定为安全字符且 ≤64 个(这是唯一可能带会话文本的位置,实现须先过 `safeKey`)。**只有计数,没有任何文本**:这是 #8「外部内容会话只进结构化计数」的落点——外部内容会话的信号摘录为空,但计数仍进本库。
24. **`Proposal.reflector` 可选字段(R0)**:`backend`(`claude|codex|pi`,CI 用它加 provider/model 重算 `deriveVendor()`,与 `vendor` 不一致即拒)、`prompt_id`、`prompt_sha256`、`input_digest`(`sha256:<hex>`)、`kit_version`(semver)、`stub`(只允许 `true`)。**`stub:true` 的提案 CI 必须拒收**(拒收逻辑属 CI 校验,不在 schema)。✅ 已落地:`kit:reflector` PR 新增的提案缺 `reflector.backend` → `GUARD_PROPOSAL_BACKEND_MISSING`,`stub: true` → `GUARD_PROPOSAL_STUB`(§12.3)。
25. **`Proposal.judge_attempts`(R0)**:`JudgeHop[]`,**只在 `judge` 缺省时允许**;必须记满整条兜底链(5 跳,顺序 = `JUDGE_HOP_CHAIN`);不允许 `ok`;结果枚举复用 `HopResultSchema`;与反思器同厂商的跳必须 `skipped:same-vendor`,反之厂商不同的跳不得贴这个标签(比较前 trim+小写)。未配置槽位记 `error:not_configured` 并用哨兵 `vendor:"unknown", model:"-"`;预算耗尽未尝试的跳记 `error:budget_exhausted`。之后补跑成功,judge 模块写 `judge` 并删除本字段。现有 `judge` 的 superRefine 不变。
26. **厂商表(R0)**:`src/contracts/vendor.ts` 冻结常量。`deriveVendor({backend, provider?, model?}, overrides?)`:claude→anthropic;codex 默认 provider 或 `openai`→openai,其它 provider 按模型族;pi 按模型族(第一方 provider 与模型族矛盾→unknown);推导不出→`unknown`。模型族按**整 token 相等**(`deepseekfoo` 不是 deepseek),`o<数字>` 为 openai;模型串含空白/非 ASCII 一律 unknown;路径段命中的厂商互相矛盾→unknown。`isCrossVendor(a,b)`:任一方 unknown、空、非规范形(`^[a-z][a-z0-9-]{0,31}$`),或**不是内置厂商**(覆盖层追加的家族可能把真实厂商的模型标成「新厂商」,不能当证据)→false(无法证明就不放行,不做归一化)。后端固定厂商(claude→anthropic、codex 默认 provider→openai)时,若给出的模型串明确属于另一厂商,推导为 unknown(配置与后端矛盾)。覆盖层 `vendor_overrides` 只能**追加新模型族 token**,不得覆盖内置族、不得映射到内置厂商或 `unknown`,违者 `CFG_VENDOR_OVERRIDE_DENIED`。**用户不能声明厂商**(绑定里没有 vendor 字段)。
27. **reflect 配置与输出契约(R0)**:`KitConfig.reflect`(仅 `max_proposals≤5 / max_calls≤3 默认 1 / timeout_ms`)与 `Overlay.reflect`(另含 `reset_tz` 默认 `UTC`、`backends:[{slot,cli,provider?,model?}]`、`vendor_overrides`、`egress` 默认 false),全部可选,旧 kit.toml 仍有效;core 不写死任何私人账号/渠道,未配置的槽位运行时记 `error:not_configured`。`ReflectorOutputSchema`(`makeReflectorOutputSchema({atomMaxBytes,maxProposals})`)全层 strictObject,`op` 只能 `add`,`signature.type` 不含 `always`,pattern 过 `checkPatternSafety`(旗标 `u`;拒回溯引用、lookaround、重复量词修饰的含量词/`|` 分组、`?`/有界量词也算分组内量词、未限界量词 >3、重复量词 >6、无任何字面量字符;使用方须限制被匹配串 ≤4KiB,并对 pattern 本身再过脱敏第二遍);`ReflectRunReportSchema` 只含计数与哈希。id 是否与仓库/暂存区冲突、证据别名是否为输入子集,schema 判不了,由校验器/合并器判。
28. **受控 LLM 出口(R0)**:见 §5.2。
29. **R5 追加的两个可选配置字段(覆盖层 `reflect`)**:`reflect.backends[].allow_unverified`(boolean,缺省视为 false;为 true 时命令层把**该槽位**所用 CLI 二进制的绝对路径加入后端的 `allowUnverified` 清单,放行 `verified:false` 的参数集真跑;**逐槽位生效**,同一个二进制被另一个没写的槽位使用时仍被拒;core 与 `kit.toml` 不得默认放行,只能由用户在覆盖层显式写)与 `reflect.team_project_keys`(字符串列表,缺省空;值取信号里的 `project_key`;**白名单**:缺省时所有项目一律按 personal 层处理(fail-closed),只有列在这里的项目才可能进团队层)。`runReflect` 的 `RunOpts.teamProjectKeys`(`ReadonlySet<string>`,S10-rc34 取代原黑名单 `personalProjectKeys` 与命令层补集代理)是**白名单**:只有名单内 project_key 的信号可进团队层、可计入跨项目/跨会话门槛,名单外一律按 personal;空集 = 全部 personal;名单含未知 key 无害;命令层总是传入 `new Set(team_project_keys)`(缺省即空集,fail-closed);库级直接调用 `runReflect` 不传(`undefined`)**同样等于空白名单**(S10-fc:全部按 personal、不进团队层、不计入跨项目/跨会话门槛),不存在「不设限」缺省;`MergeInput.teamProjectKeys` 与 `decideLayer` 的 `team` 参数为必填(类型层面不允许忘传),要放行必须显式列出 key。两项都只追加、旧覆盖层仍有效;`KitConfig`(core)里出现它们仍被拒。
30. **命令层的外发同意是三道门**:`--run-llm`、`--allow-egress`、覆盖层 `reflect.egress = true`(缺覆盖层按 false),缺任何一道退出 2、零构造零调用零写入(§17)。干跑路径不构造后端。

31. **L0 追加(attest / promote / retire 生命周期,全部只追加可选字段或新 schema)**:见 §18。

## 9. 标识符与哈希约定(Q-N7 的默认处理)

本机随机盐 `.state/salt`(32 字节随机数的十六进制,权限 0600,**不入仓**)。跨机器聚合不依赖这些哈希(attest 只用计数)。

| 标识符        | 形状                                | 计算                                                                          |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `session_ref` | `s_` + 16 位十六进制                | `sha256(salt ‖ "session" ‖ 会话文件绝对路径)` 前 16 位                        |
| `project_key` | `p_` + 16 位十六进制,或允许名单明文 | `sha256(salt ‖ "project" ‖ 工作目录)` 前 16 位;覆盖层允许名单内的项目可用明文 |
| `sig_id`      | `sig_` + 16 位十六进制              | `sha256(salt ‖ "sig" ‖ session_ref ‖ 事件序号)` 前 16 位                      |

`‖` 表示用 `\0` 连接。B10b 可在此基础上细化(先问 opus),但**形状**(前缀 + 16 位十六进制)已写进 schema,改形状 = 契约变更。

## 10. 示例

下面每个块都被测试抽取。`schema=` 取 `test/contracts/registry.ts` 里登记的名字。

### 10.1 原子 frontmatter(`AtomFrontmatter`)

<!-- example:valid schema=AtomFrontmatter -->

```json
{
  "id": "negative-assertion-needs-positive-control",
  "title": "负向断言旁边必须钉一个正向前提",
  "layer": "team",
  "strength": "should",
  "applies_to": ["all"],
  "paths": ["**/*.test.*", "**/*.spec.*"],
  "kind": "practice",
  "volatility": "stable",
  "status": "proposed",
  "owner": "@owner-handle",
  "created": "2026-10-08",
  "review_by": "2027-01-08",
  "evidence": [
    {
      "type": "memory",
      "ref": "sha256:0000000000000000000000000000000000000000000000000000000000000001",
      "excerpt": "变异后存量 13 条负向断言全绿,一条不红"
    }
  ],
  "verifier": { "type": "replay", "ref": "cases/negative-assertion-needs-positive-control/" },
  "signature": { "type": "path", "pattern": "**/*.{test,spec}.*" },
  "escalation_level": 1,
  "origin": "proposal/2026-10-08-003"
}
```

错误示例 1:`must` 没有可执行的 verifier。

<!-- example:invalid schema=AtomFrontmatter -->

```json
{
  "id": "must-without-verifier",
  "title": "must 必须有 verifier",
  "layer": "org",
  "strength": "must",
  "kind": "practice",
  "volatility": "stable",
  "status": "proposed",
  "owner": "@owner-handle",
  "created": "2026-10-08",
  "review_by": "2027-01-08",
  "evidence": [{ "type": "memory", "ref": "x", "excerpt": "e" }],
  "verifier": { "type": "none" }
}
```

错误示例 2:日期不是真实存在的日历日。

<!-- example:invalid schema=AtomFrontmatter -->

```json
{
  "id": "bad-calendar-date",
  "title": "二月没有 30 号",
  "layer": "team",
  "strength": "should",
  "kind": "practice",
  "volatility": "stable",
  "status": "proposed",
  "owner": "@owner-handle",
  "created": "2026-02-30",
  "review_by": "2027-01-08",
  "evidence": [{ "type": "memory", "ref": "x", "excerpt": "e" }],
  "verifier": { "type": "replay", "ref": "cases/x/" }
}
```

错误示例 3:出现契约外字段(计数器只存在本机,不得写进原子)。

<!-- example:invalid schema=AtomFrontmatter -->

```json
{
  "id": "has-counter-field",
  "title": "原子里不能带计数器",
  "layer": "team",
  "strength": "should",
  "kind": "practice",
  "volatility": "stable",
  "status": "proposed",
  "owner": "@owner-handle",
  "created": "2026-10-08",
  "review_by": "2027-01-08",
  "evidence": [{ "type": "memory", "ref": "x", "excerpt": "e" }],
  "verifier": { "type": "replay", "ref": "cases/x/" },
  "exposure_count": 12
}
```

错误示例 4:`active` 没有 `signature`。

<!-- example:invalid schema=AtomFrontmatter -->

```json
{
  "id": "active-without-signature",
  "title": "active 必须有触发签名",
  "layer": "team",
  "strength": "should",
  "kind": "practice",
  "volatility": "stable",
  "status": "active",
  "owner": "@owner-handle",
  "created": "2026-10-08",
  "review_by": "2027-01-08",
  "evidence": [{ "type": "memory", "ref": "x", "excerpt": "e" }],
  "verifier": { "type": "replay", "ref": "cases/x/" }
}
```

### 10.2 技能与子代理

<!-- example:valid schema=SkillFrontmatter -->

```json
{
  "name": "review-diff",
  "description": "对一份 diff 做只读评审,输出按严重度排序的问题清单。",
  "license": "UNLICENSED",
  "metadata": { "owner": "team" }
}
```

<!-- example:invalid schema=SkillFrontmatter -->

```json
{ "name": "Review_Diff", "description": "name 必须是 kebab-case" }
```

<!-- example:valid schema=NeutralAgent -->

```json
{
  "name": "diff-reviewer",
  "description": "只读评审者",
  "prompt": "你是只读的代码评审者。",
  "tools": ["read", "shell"],
  "model_tier": "judge"
}
```

错误示例:core 里写了具体模型名而不是档位。

<!-- example:invalid schema=NeutralAgent -->

```json
{
  "name": "diff-reviewer",
  "description": "只读评审者",
  "prompt": "你是只读的代码评审者。",
  "tools": ["read"],
  "model_tier": "some-concrete-model-name"
}
```

### 10.3 配置

<!-- example:valid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["claude", "codex", "pi", "kimi", "opencode"] },
  "budget": {
    "enforce": "warn",
    "codex": { "max_bytes": 16384, "hard_limit": 32768, "limit_source": "documented" },
    "pi": { "max_bytes": 16384, "hard_limit": "unknown", "limit_source": "assumed" }
  },
  "channels": {
    "canary": { "members": { "@alice": { "since": "2026-10-08" } } },
    "stable": { "members": {} }
  }
}
```

<!-- example:invalid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["claude"] },
  "budget": { "enforce": "warn", "claude": { "max_lines": 200 } },
  "channels": {}
}
```

<!-- example:invalid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["openclaw"] },
  "budget": { "enforce": "warn" },
  "channels": {}
}
```

<!-- example:invalid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["codex"] },
  "budget": {
    "enforce": "warn",
    "codex": { "max_bytes": 16384, "limit_source": "probed" }
  },
  "channels": {}
}
```

<!-- example:valid schema=Overlay -->

```json
{
  "model_tiers": { "claude": { "judge": "example-model-id", "implement": "example-model-id" } },
  "sensitive_words": ["ExampleCorp"],
  "channel": "canary",
  "enabled_agents": ["claude", "codex"],
  "exclude_dirs": ["/path/to/client-project"]
}
```

<!-- example:invalid schema=Overlay -->

```json
{ "model_tiers": { "claude": { "turbo": "example-model-id" } } }
```

### 10.4 渲染

<!-- example:valid schema=OutFile -->

```json
{
  "agent": "codex",
  "target": "home",
  "relPath": ".codex/AGENTS.md",
  "content": "<!-- agent-kit:begin id=org sha256=0000000000000000000000000000000000000000000000000000000000000002 -->\n- 负向断言旁边必须钉一个正向前提\n<!-- agent-kit:end -->\n",
  "mode": "managed-block",
  "atomIds": ["negative-assertion-needs-positive-control"],
  "atomBytes": { "negative-assertion-needs-positive-control": 52 },
  "confidence": "documented"
}
```

<!-- example:invalid schema=OutFile -->

```json
{
  "agent": "codex",
  "target": "home",
  "relPath": "../escape/AGENTS.md",
  "content": "x\n",
  "mode": "owned",
  "atomIds": [],
  "atomBytes": {},
  "confidence": "documented"
}
```

<!-- example:invalid schema=OutFile -->

```json
{
  "agent": "codex",
  "target": "home",
  "relPath": ".codex/AGENTS.md",
  "content": "x\n",
  "mode": "owned",
  "atomIds": ["a"],
  "atomBytes": { "b": 1 },
  "confidence": "documented"
}
```

<!-- example:invalid schema=OutFile -->

```json
{
  "agent": "codex",
  "target": "home",
  "relPath": ".codex/AGENTS.md",
  "content": "x\n",
  "mode": "owned",
  "atomIds": [],
  "atomBytes": {}
}
```

<!-- example:valid schema=Manifest -->

```json
{
  "schema_version": 1,
  "kit_version": "0.0.0",
  "channel": "canary",
  "files": [
    {
      "path": "codex/home/.codex/AGENTS.md",
      "agent": "codex",
      "target": "home",
      "mode": "managed-block",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "atoms": [{ "id": "negative-assertion-needs-positive-control", "layer": "team" }],
      "sourceRefs": []
    }
  ],
  "skippedLayers": [{ "layer": "personal", "reason": "P2 才在本机渲染" }]
}
```

<!-- example:invalid schema=Manifest -->

```json
{
  "schema_version": 2,
  "kit_version": "0.0.0",
  "channel": "canary",
  "files": [],
  "skippedLayers": []
}
```

<!-- example:valid schema=AdapterMeta -->

```json
{
  "agent": "codex",
  "tested_versions": ["0.161.0"],
  "managed_targets": ["~/.codex/AGENTS.md", "~/.agents/skills/"]
}
```

<!-- example:invalid schema=AdapterMeta -->

```json
{ "agent": "openclaw", "tested_versions": [], "managed_targets": [] }
```

<!-- example:valid schema=MergeResult -->

```json
{
  "atoms": [
    {
      "atom": {
        "fm": {
          "id": "personal-preference",
          "title": "个人偏好示例",
          "layer": "personal",
          "strength": "should",
          "kind": "preference",
          "volatility": "stable",
          "status": "proposed",
          "owner": "@owner-handle",
          "created": "2026-10-08",
          "review_by": "2027-01-08",
          "evidence": [{ "type": "memory", "ref": "x", "excerpt": "e" }],
          "verifier": { "type": "none" }
        },
        "body": { "do": "做某事。", "why": "因为某原因。", "verify": "这样验证。" },
        "bodyBytes": 33,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000004",
        "sourcePath": "rules/personal/personal-preference.md"
      },
      "layer": "personal",
      "coreEligible": false,
      "replaced": []
    }
  ],
  "overridden": [],
  "diagnostics": []
}
```

<!-- example:invalid schema=MergeResult -->

```json
{ "atoms": [], "diagnostics": [] }
```

### 10.5 预算

<!-- example:valid schema=BudgetReport -->

```json
{
  "enforce": "warn",
  "targets": [
    {
      "agent": "codex",
      "bytes": 120,
      "lines": 4,
      "max_bytes": 16384,
      "hard_limit": 32768,
      "limit_source": "documented",
      "level": "ok",
      "blocking": false,
      "files": [".codex/AGENTS.md"],
      "deduped_atom_ids": []
    }
  ],
  "diagnostics": []
}
```

<!-- example:invalid schema=BudgetReport -->

```json
{
  "enforce": "warn",
  "targets": [
    {
      "agent": "codex",
      "bytes": 1,
      "lines": 1,
      "limit_source": "documented",
      "level": "huge",
      "blocking": false,
      "files": [],
      "deduped_atom_ids": []
    }
  ],
  "diagnostics": []
}
```

### 10.6 信号与 reader

<!-- example:valid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "session_meta",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-08T12:00:00Z",
  "type": "event",
  "excerpt_redacted": "运行 [[REDACTED:secret]] 失败",
  "external_content": false,
  "confidence": 0.5,
  "loaded_rule_ids": []
}
```

<!-- example:invalid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "session_meta",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-08T12:00:00",
  "type": "event",
  "excerpt_redacted": "",
  "external_content": false,
  "confidence": 0.5,
  "loaded_rule_ids": []
}
```

<!-- example:invalid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "guess",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-08T12:00:00Z",
  "type": "event",
  "excerpt_redacted": "",
  "external_content": false,
  "confidence": 1.5,
  "loaded_rule_ids": []
}
```

<!-- example:valid schema=Counts -->

```json
{
  "user_messages": 3,
  "tool_calls": 5,
  "tool_failures": 1,
  "unknown_event_types": { "future_event": 2 }
}
```

<!-- example:invalid schema=Counts -->

```json
{ "user_messages": -1, "tool_calls": 0, "tool_failures": 0, "unknown_event_types": {} }
```

<!-- example:valid schema=NormEvent -->

```json
{
  "agent": "pi",
  "session_ref": "s_0123456789abcdef",
  "ts": "2026-10-08T12:00:00Z",
  "kind": "tool_result",
  "raw_type": "toolResult",
  "tool_name": "bash",
  "tool_failed": true
}
```

<!-- example:invalid schema=NormEvent -->

```json
{
  "agent": "pi",
  "session_ref": "s_0123456789abcdef",
  "ts": "2026-10-08T12:00:00Z",
  "kind": "weird",
  "raw_type": "toolResult"
}
```

<!-- example:valid schema=SessionMeta -->

```json
{
  "agent_version": null,
  "cwd_hint": null,
  "started_at": "2026-10-08T11:59:00Z",
  "external_content": false,
  "loaded_rule_paths": []
}
```

<!-- example:invalid schema=SessionMeta -->

```json
{
  "cwd_hint": null,
  "started_at": "2026-10-08T11:59:00Z",
  "external_content": false,
  "loaded_rule_paths": []
}
```

### 10.7 脱敏与诊断

<!-- example:valid schema=Hit -->

```json
{ "type": "api_key", "rule": "prefix-sk", "start": 4, "end": 40 }
```

错误示例:`Hit` 不得携带命中文本。

<!-- example:invalid schema=Hit -->

```json
{ "type": "api_key", "rule": "prefix-sk", "start": 4, "end": 40, "text": "must-not-be-here" }
```

<!-- example:valid schema=RedactionConfig -->

```json
{ "sensitive_words": ["ExampleCorp"], "timeout_ms": 50 }
```

<!-- example:invalid schema=RedactionConfig -->

```json
{ "timeout_ms": 0 }
```

<!-- example:valid schema=Diagnostic -->

```json
{
  "code": "ATOM_ID_FILENAME_MISMATCH",
  "severity": "error",
  "path": "rules/team/a.md#/id",
  "message": "id 必须等于文件名"
}
```

<!-- example:invalid schema=Diagnostic -->

```json
{ "code": "lowercase_code", "severity": "error", "path": "x", "message": "m" }
```

### 10.8 P1 的口子(只定义 schema,P0 不实现任何命令)

`proposals/<id>.yaml`(设计 §5.5)、裁判输出(§6.5)、`attest/**`(§6.6)、`cases/**/case.yaml` 与 `reports/**`(§6.5)。
P0 先把 schema 冻在这里,P1 的块直接消费,避免打 tag 之后再改契约。

<!-- example:valid schema=Proposal -->

```json
{
  "id": "2026-10-08-003",
  "op": "add",
  "targets": ["negative-assertion-needs-positive-control"],
  "layer": "team",
  "rationale": "两个项目三次出现同类假绿",
  "evidence": [
    { "sig": "sig_0123456789abcdef", "project_key": "p_fedcba9876543210", "excerpt": "变异后全绿" }
  ],
  "budget_delta_bytes": 212,
  "paired_retirements": [],
  "cases": ["cases/negative-assertion-needs-positive-control/"],
  "reflector": {
    "provider": "anthropic",
    "vendor": "anthropic",
    "model": "example-model-id",
    "run_id": "run-0001"
  },
  "judge": {
    "hops": [
      {
        "hop": "codex",
        "vendor": "openai",
        "model": "example-model-id",
        "result": "skipped:cooldown"
      },
      {
        "hop": "maas-deepseek",
        "vendor": "deepseek",
        "model": "example-model-id",
        "result": "error:403"
      },
      { "hop": "glm", "vendor": "zhipu", "model": "example-model-id", "result": "ok" }
    ],
    "provider": "glm",
    "vendor": "zhipu",
    "verdict": "accept",
    "overfit_risk": "low",
    "injection_suspected": false,
    "conflicts": []
  }
}
```

错误示例 1:`hops` 缺跳(第 1 跳 codex 不见了,直接从 glm 开始)。

<!-- example:invalid schema=Proposal -->

```json
{
  "id": "2026-10-08-003",
  "op": "add",
  "targets": ["a-rule"],
  "layer": "team",
  "rationale": "r",
  "evidence": [{ "sig": "s", "project_key": "p", "excerpt": "e" }],
  "budget_delta_bytes": 1,
  "paired_retirements": [],
  "cases": [],
  "reflector": { "provider": "anthropic", "vendor": "anthropic", "model": "m", "run_id": "r" },
  "judge": {
    "hops": [{ "hop": "glm", "vendor": "zhipu", "model": "m", "result": "ok" }],
    "provider": "glm",
    "vendor": "zhipu",
    "verdict": "accept",
    "overfit_risk": "low",
    "injection_suspected": false,
    "conflicts": []
  }
}
```

错误示例 2:没有内嵌脱敏摘录(CI 无法访问提案人的本地信号库)。

<!-- example:invalid schema=Proposal -->

```json
{
  "id": "2026-10-08-003",
  "op": "add",
  "targets": ["a-rule"],
  "layer": "team",
  "rationale": "r",
  "evidence": [],
  "budget_delta_bytes": 1,
  "paired_retirements": [],
  "cases": [],
  "reflector": { "provider": "anthropic", "vendor": "anthropic", "model": "m", "run_id": "r" }
}
```

错误示例 3:裁判与反思器同厂商。

<!-- example:invalid schema=Proposal -->

```json
{
  "id": "2026-10-08-003",
  "op": "add",
  "targets": ["a-rule"],
  "layer": "team",
  "rationale": "r",
  "evidence": [{ "sig": "s", "project_key": "p", "excerpt": "e" }],
  "budget_delta_bytes": 1,
  "paired_retirements": [],
  "cases": [],
  "reflector": { "provider": "anthropic", "vendor": "anthropic", "model": "m", "run_id": "r" },
  "judge": {
    "hops": [{ "hop": "codex", "vendor": "anthropic", "model": "m", "result": "ok" }],
    "provider": "codex",
    "vendor": "anthropic",
    "verdict": "accept",
    "overfit_risk": "low",
    "injection_suspected": false,
    "conflicts": []
  }
}
```

<!-- example:valid schema=JudgeOutput -->

```json
{
  "verdict": "revise",
  "overfit_risk": "medium",
  "generality": "high",
  "volatile": false,
  "conflicts": [],
  "injection_suspected": false,
  "notes": "措辞过窄"
}
```

<!-- example:invalid schema=JudgeOutput -->

```json
{
  "verdict": "maybe",
  "overfit_risk": "low",
  "generality": "high",
  "volatile": false,
  "conflicts": [],
  "injection_suspected": false,
  "notes": ""
}
```

<!-- example:valid schema=Attest -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "channel": "canary",
  "member": "@handle",
  "window_start": "2026-10-09",
  "window_end": "2026-10-23",
  "kit_version": "0.0.0",
  "collector_versions": { "claude": "2.1.280" },
  "sessions_total": 41,
  "exposure_sessions": 12,
  "exposure_projects": 3,
  "fired": 12,
  "harmful": 0,
  "recurrence": 0,
  "signal_ids_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006",
  "run_id": "run-0001"
}
```

错误示例:曝光会话数大于会话总数。

<!-- example:invalid schema=Attest -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "channel": "canary",
  "member": "@handle",
  "window_start": "2026-10-09",
  "window_end": "2026-10-23",
  "kit_version": "0.0.0",
  "collector_versions": {},
  "sessions_total": 3,
  "exposure_sessions": 12,
  "exposure_projects": 3,
  "fired": 12,
  "harmful": 0,
  "recurrence": 0,
  "signal_ids_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006",
  "run_id": "run-0001"
}
```

<!-- example:valid schema=Case -->

```json
{
  "id": "negative-assertion-needs-positive-control",
  "fixture": { "type": "dir", "path": "fixture/" },
  "prompt": "给这个函数补一个负向断言测试。",
  "agent": "claude",
  "check": "check.sh",
  "split": "train"
}
```

<!-- example:invalid schema=Case -->

```json
{
  "id": "negative-assertion-needs-positive-control",
  "fixture": { "type": "dir", "path": "fixture/" },
  "prompt": "p",
  "agent": "claude",
  "check": "check.sh",
  "split": "validation"
}
```

<!-- example:valid schema=ReplayReport -->

```json
{
  "case_id": "negative-assertion-needs-positive-control",
  "case_sha": "0000000000000000000000000000000000000000000000000000000000000007",
  "rule_set_sha": "0000000000000000000000000000000000000000000000000000000000000008",
  "harness_sha": "0000000000000000000000000000000000000000000000000000000000000009",
  "runner_id": "runner-1",
  "run_id": "run-0001",
  "ci_run_url": "https://example.invalid/runs/1",
  "runs": [
    {
      "agent": "claude",
      "agent_version": "2.1.280",
      "passed": true,
      "transcript_sha256": "000000000000000000000000000000000000000000000000000000000000000a"
    }
  ]
}
```

错误示例:既没有 CI 运行链接,也没有声明自报。

<!-- example:invalid schema=ReplayReport -->

```json
{
  "case_id": "negative-assertion-needs-positive-control",
  "case_sha": "0000000000000000000000000000000000000000000000000000000000000007",
  "rule_set_sha": "0000000000000000000000000000000000000000000000000000000000000008",
  "harness_sha": "0000000000000000000000000000000000000000000000000000000000000009",
  "runner_id": "runner-1",
  "run_id": "run-0001",
  "runs": [
    {
      "agent": "claude",
      "agent_version": "2.1.280",
      "passed": true,
      "transcript_sha256": "000000000000000000000000000000000000000000000000000000000000000a"
    }
  ]
}
```

文件名约定(`attestFileName` / `reportFileName`):`attest/<rule-id>/<member 去掉 @>-<window_end>-<run_id>.json`,
`reports/<case-id>/<rule_set_sha>-<run_id>.json`。`run_id` 限定为文件名安全字符 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`。
同一窗口重跑只新增文件;聚合取同 `(rule_id, member, window_start, window_end)` 里 `run_id` 最新的一份。

### 10.9 R0 追加的示例(#22–#28)

Signal 追加的可选字段(旧信号没有这些字段同样合法)。

<!-- example:valid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "session_meta",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-12T00:00:00Z",
  "type": "event",
  "excerpt_redacted": "",
  "external_content": false,
  "confidence": 1,
  "loaded_rule_ids": [],
  "event_kind": "tool_call",
  "event_index": 7,
  "tool_name": "Bash"
}
```

错误示例:未知事件种类、负序号、含空白的工具名。

<!-- example:invalid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "session_meta",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-12T00:00:00Z",
  "type": "event",
  "excerpt_redacted": "",
  "external_content": false,
  "confidence": 1,
  "loaded_rule_ids": [],
  "event_kind": "assistant_message",
  "event_index": -1,
  "tool_name": "rm -rf /"
}
```

会话计数库的一行(只有计数,没有文本)。

<!-- example:valid schema=SessionStat -->

```json
{
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-12T00:00:00Z",
  "external_content": true,
  "counts": {
    "user_messages": 3,
    "tool_calls": 5,
    "tool_failures": 1,
    "unknown_event_types": {
      "weird.type": 2
    }
  }
}
```

错误示例:计数键带文本、多出文本字段。

<!-- example:invalid schema=SessionStat -->

```json
{
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-12T00:00:00Z",
  "external_content": true,
  "counts": {
    "user_messages": 3,
    "tool_calls": 5,
    "tool_failures": 1,
    "unknown_event_types": {
      "has some text": 2
    }
  },
  "excerpt_redacted": "x"
}
```

全链都没成功的提案:无 `judge`,用 `judge_attempts` 记满整条链(同厂商的跳记 `skipped:same-vendor`,未配置槽位用哨兵 `unknown` / `-`)。`stub:true` 的提案 CI 必须拒收(此处仅为展示字段)。

<!-- example:valid schema=Proposal -->

```json
{
  "id": "2026-10-12-001",
  "op": "add",
  "targets": ["a-rule"],
  "layer": "personal",
  "rationale": "r",
  "evidence": [
    {
      "sig": "sig_0123456789abcdef",
      "project_key": "p_fedcba9876543210",
      "excerpt": "e"
    }
  ],
  "budget_delta_bytes": 10,
  "paired_retirements": [],
  "cases": [],
  "reflector": {
    "provider": "anthropic",
    "vendor": "anthropic",
    "model": "example-model-id",
    "run_id": "run-0001",
    "backend": "claude",
    "prompt_id": "reflect-v1",
    "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "input_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "kit_version": "0.1.0",
    "stub": true
  },
  "judge_attempts": [
    {
      "hop": "codex",
      "vendor": "anthropic",
      "model": "example-model-id",
      "result": "skipped:same-vendor"
    },
    {
      "hop": "maas-deepseek",
      "vendor": "unknown",
      "model": "-",
      "result": "error:not_configured"
    },
    {
      "hop": "glm",
      "vendor": "zhipu",
      "model": "example-model-id",
      "result": "skipped:cooldown"
    },
    {
      "hop": "kimi",
      "vendor": "moonshot",
      "model": "example-model-id",
      "result": "error:403"
    },
    {
      "hop": "official-deepseek",
      "vendor": "deepseek",
      "model": "example-model-id",
      "result": "error:402"
    }
  ]
}
```

错误示例:`judge_attempts` 没记满整条兜底链。

<!-- example:invalid schema=Proposal -->

```json
{
  "id": "2026-10-12-001",
  "op": "add",
  "targets": ["a-rule"],
  "layer": "personal",
  "rationale": "r",
  "evidence": [
    {
      "sig": "sig_0123456789abcdef",
      "project_key": "p_fedcba9876543210",
      "excerpt": "e"
    }
  ],
  "budget_delta_bytes": 10,
  "paired_retirements": [],
  "cases": [],
  "reflector": {
    "provider": "anthropic",
    "vendor": "anthropic",
    "model": "example-model-id",
    "run_id": "run-0001",
    "backend": "claude",
    "prompt_id": "reflect-v1",
    "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "input_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "kit_version": "0.1.0",
    "stub": true
  },
  "judge_attempts": [
    {
      "hop": "codex",
      "vendor": "anthropic",
      "model": "example-model-id",
      "result": "skipped:same-vendor"
    },
    {
      "hop": "maas-deepseek",
      "vendor": "unknown",
      "model": "-",
      "result": "error:not_configured"
    }
  ]
}
```

错误示例:`judge` 与 `judge_attempts` 同时出现。

<!-- example:invalid schema=Proposal -->

```json
{
  "id": "2026-10-12-001",
  "op": "add",
  "targets": ["a-rule"],
  "layer": "personal",
  "rationale": "r",
  "evidence": [
    {
      "sig": "sig_0123456789abcdef",
      "project_key": "p_fedcba9876543210",
      "excerpt": "e"
    }
  ],
  "budget_delta_bytes": 10,
  "paired_retirements": [],
  "cases": [],
  "reflector": {
    "provider": "anthropic",
    "vendor": "anthropic",
    "model": "example-model-id",
    "run_id": "run-0001",
    "backend": "claude",
    "prompt_id": "reflect-v1",
    "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "input_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "kit_version": "0.1.0",
    "stub": true
  },
  "judge": {
    "hops": [
      {
        "hop": "codex",
        "vendor": "openai",
        "model": "m",
        "result": "ok"
      }
    ],
    "provider": "codex",
    "vendor": "openai",
    "verdict": "accept",
    "overfit_risk": "low",
    "injection_suspected": false,
    "conflicts": []
  },
  "judge_attempts": [
    {
      "hop": "codex",
      "vendor": "anthropic",
      "model": "example-model-id",
      "result": "skipped:same-vendor"
    },
    {
      "hop": "maas-deepseek",
      "vendor": "unknown",
      "model": "-",
      "result": "error:not_configured"
    },
    {
      "hop": "glm",
      "vendor": "zhipu",
      "model": "example-model-id",
      "result": "skipped:cooldown"
    },
    {
      "hop": "kimi",
      "vendor": "moonshot",
      "model": "example-model-id",
      "result": "error:403"
    },
    {
      "hop": "official-deepseek",
      "vendor": "deepseek",
      "model": "example-model-id",
      "result": "error:402"
    }
  ]
}
```

反思器的 LLM 输出(唯一合法形状)。

<!-- example:valid schema=ReflectorOutput -->

```json
{
  "proposals": [
    {
      "op": "add",
      "id": "negative-assertion-needs-positive-control",
      "title": "负向断言要配正向控制组",
      "do": "在 not.toContain 旁边断言一个必然存在的对照值。",
      "why": "否则前提失效时断言静默变空。",
      "verify": "变异后至少一条断言变红。",
      "kind": "practice",
      "volatility": "stable",
      "applies_to": ["claude"],
      "signature": {
        "type": "phrase",
        "pattern": "not\\.toContain"
      },
      "evidence": ["e1", "e2"],
      "rationale": "两个项目三次出现同类假绿"
    }
  ],
  "observations": [
    {
      "kind": "retire",
      "target_id": "old-rule",
      "note": "已被取代"
    }
  ]
}
```

错误示例:带 `status` / `strength`(由合并器决定,不交给 LLM)。

<!-- example:invalid schema=ReflectorOutput -->

```json
{
  "proposals": [
    {
      "op": "add",
      "id": "negative-assertion-needs-positive-control",
      "title": "负向断言要配正向控制组",
      "do": "在 not.toContain 旁边断言一个必然存在的对照值。",
      "why": "否则前提失效时断言静默变空。",
      "verify": "变异后至少一条断言变红。",
      "kind": "practice",
      "volatility": "stable",
      "applies_to": ["claude"],
      "signature": {
        "type": "phrase",
        "pattern": "not\\.toContain"
      },
      "evidence": ["e1", "e2"],
      "rationale": "两个项目三次出现同类假绿",
      "status": "active",
      "strength": "must"
    }
  ]
}
```

错误示例:`op` 不是 `add`、pattern 含嵌套量词(ReDoS)。

<!-- example:invalid schema=ReflectorOutput -->

```json
{
  "proposals": [
    {
      "op": "retire",
      "id": "negative-assertion-needs-positive-control",
      "title": "负向断言要配正向控制组",
      "do": "在 not.toContain 旁边断言一个必然存在的对照值。",
      "why": "否则前提失效时断言静默变空。",
      "verify": "变异后至少一条断言变红。",
      "kind": "practice",
      "volatility": "stable",
      "applies_to": ["claude"],
      "signature": {
        "type": "phrase",
        "pattern": "(a+)+$"
      },
      "evidence": ["e1", "e2"],
      "rationale": "两个项目三次出现同类假绿"
    }
  ]
}
```

运行报告(只含计数与哈希)。

<!-- example:valid schema=ReflectRunReport -->

```json
{
  "run_id": "run-20261012-01",
  "mode": "dry",
  "signals_loaded": 10,
  "signals_dropped": {
    "schema": 1,
    "residual": 0,
    "external_excerpt_forced": 2
  },
  "clusters": 3,
  "evidence_sent": 7,
  "prompt_bytes": 4096,
  "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "input_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "backend": {
    "slot": "codex",
    "vendor": "openai",
    "model": "example-model-id"
  },
  "calls_made": 0,
  "calls_limit": 1,
  "outcome": "not_run",
  "rejected": {},
  "staged": [],
  "observations_n": 0
}
```

错误示例:干跑却有调用/暂存,且夹带文本字段。

<!-- example:invalid schema=ReflectRunReport -->

```json
{
  "run_id": "run-20261012-01",
  "mode": "dry",
  "signals_loaded": 10,
  "signals_dropped": {
    "schema": 1,
    "residual": 0,
    "external_excerpt_forced": 2
  },
  "clusters": 3,
  "evidence_sent": 7,
  "prompt_bytes": 4096,
  "prompt_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "input_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "backend": {
    "slot": "codex",
    "vendor": "openai",
    "model": "example-model-id"
  },
  "calls_made": 1,
  "calls_limit": 1,
  "outcome": "not_run",
  "rejected": {},
  "staged": ["2026-10-12-001"],
  "observations_n": 0,
  "prompt": "text"
}
```

覆盖层的 `reflect` 段。

<!-- example:valid schema=Overlay -->

```json
{
  "reflect": {
    "reset_tz": "Asia/Shanghai",
    "max_calls": 2,
    "backends": [
      {
        "slot": "glm",
        "cli": "pi",
        "provider": "zai",
        "model": "glm-5.3-flash"
      }
    ],
    "vendor_overrides": {
      "mistral": "mistral-ai"
    },
    "egress": false
  }
}
```

R5 追加字段(#29):`allow_unverified` 与 `team_project_keys`。

<!-- example:valid schema=Overlay -->

```json
{
  "reflect": {
    "egress": true,
    "team_project_keys": ["p_0123456789abcdef", "p_fedcba9876543210"],
    "backends": [
      {
        "slot": "codex",
        "cli": "codex",
        "model": "gpt-5.6-example",
        "allow_unverified": true
      }
    ]
  }
}
```

错误示例(#29):`allow_unverified` 不是布尔、`team_project_keys` 含空串。

<!-- example:invalid schema=Overlay -->

```json
{
  "reflect": {
    "team_project_keys": [""],
    "backends": [
      {
        "slot": "codex",
        "cli": "codex",
        "allow_unverified": "yes"
      }
    ]
  }
}
```

错误示例:`max_proposals>5`、绑定里自己声明 `vendor`、覆盖内置模型族。

<!-- example:invalid schema=Overlay -->

```json
{
  "reflect": {
    "max_proposals": 9,
    "backends": [
      {
        "slot": "glm",
        "cli": "pi",
        "vendor": "openai"
      }
    ],
    "vendor_overrides": {
      "claude": "openai"
    }
  }
}
```

## 9. 渲染核心须知(B06 → B07 / B08)

- 渲染器**不要自己加独占头**:`owned` 文件头由渲染核心(`src/render/core.ts`)统一加;`.json` 不加头,改记入 `sideEffects`。
- `mode: 'managed-block'` 的 `content` 必须恰好是**一个 intact 块**(由 `src/render/managed-block.ts` 生成)。
- 托管块只能落在带注释语法的文件上:md / mdx / yml / yaml / toml / jsonc;落在 `.json` 或 BOM 开头且无法处理的文件上渲染核心会报错。
- 块外内容(含 BOM、foreign-id 块)原样保留;块体被手改会被检测为 `drifted`,`onDrift` 必须由调用方显式选择(拒绝或覆盖)。形似标记但格式不严格的行一律判 corrupt 并拒绝,不追加。
- manifest 的 `sha` 对**最终落盘内容**(含独占头)计算。
- golden 更新:`pnpm run golden:update`(即 `vitest run test/golden -u`);更新模式的写根收窄到 golden 目录。该开关读的是 vitest 的非公开字段,升级 vitest 后需复核。

## 11. `build` 命令(B19a)

`agent-kit [--root <dir>] [--overlay <path>] build [--dry-run] [--report]`:读仓库、合并、渲染、检查预算,把结果写进 `<repo>/out/`。不碰 `out/` 与 `.state/` 之外的任何路径,不读真实 HOME。

**流程与退出码**(每一步失败即停,停在写盘之前时 `out/` 保持原样):

| 步骤                                                                                       | 失败时                                    | 退出码 |
| ------------------------------------------------------------------------------------------ | ----------------------------------------- | ------ |
| 参数解析(未知 flag、位置参数)                                                              | 打印用法                                  | 2      |
| 读 `kit.toml`(缺/语法错/校验失败);读 `--overlay`(读不到/校验失败)                          | 打印诊断                                  | 1      |
| `lintRepo`(error)                                                                          | 打印诊断                                  | 1      |
| lint 的脱敏复扫自身出错                                                                    | fail-closed                               | 3      |
| `mergeAtoms`(error)                                                                        | 打印诊断                                  | 1      |
| `renderAll`(只含 `kit.toml` 里 `enabled` 的 agent;覆盖层 `enabled_agents` 只取交集,不放大) | fail-closed                               | 3      |
| `computeBudget` 且 `budgetFailed`(`enforce=block` 且有非 `assumed` 目标超限)               | 打印诊断                                  | 1      |
| 写盘(写出口拒绝、`out/` 或其内部任一段路径是符号链接、IO 错误)                             | fail-closed                               | 3      |
| 全部通过(`enforce=warn` 下超限只告警)                                                      | 打印各目标预算行与 `build: 已写 N 个文件` | 0      |

不再是命令桩,任何路径都不退 64。lint 步骤带真实 `Redactor`(`createRedactor`,敏感词/内部域名取自 `--overlay`),所以 `ATOM_EVIDENCE_NOT_SCANNED` 告警在 `build` 里不出现。

**写盘顺序**(全部经 `safe-fs`,写入根只有 `<repo>/out/`;`--report` 另写 `<repo>/.state/reports/build.json`):

0. **写入根收窄(B21/B1)**:build 写 `out/` 只用 `out/` 之内的写入根(`.state/`、`KIT_TMP` 不在其中);`--report` 只用 `.state/` 之内的写入根。
   `out/` 内部的符号链接因此再也引不到 `.state/` 或 `KIT_TMP`。
1. `lstat out/`:是符号链接或不是目录 → 退出 3(否则 realpath 会把写入根悄悄换成仓库外的目录)。
   **逐段检查**:删/写 `out/` 下任一路径前,从 `out/` 往下逐段 `lstat`;**中间段**是符号链接(写时含叶子)→ 拒绝并退出 3。
   旧 manifest 登记的路径若有链接中间段,视为不可信(`BUILD_PREVIOUS_MANIFEST_UNTRUSTED`,不据此清理),随后写入阶段同样退出 3。
   `out/manifest.json` 不是普通文件(目录、链接、悬空链接)同样视为不可信;它是目录时不递归删除,写入失败退出 3。
   登记路径不是 `<agent>/<home|project>/<relPath>` 形状(如 `tmp/x`)也视为不可信,避免删到用户自己放在 `out/` 里的文件。
2. 读上一次的 `out/manifest.json`(必须是普通文件、过 `ManifestSchema`、每个 `path` 过 `OutRelPathSchema`)。不可信则**不据此清理**,打印 `warn BUILD_PREVIOUS_MANIFEST_UNTRUSTED`。
3. 删掉旧 manifest 登记过的文件、`manifest.json`,以及因此变空的目录。登记文件的内容与登记的 `sha256` 不符(被手改)时**不删**,打印 `warn BUILD_MODIFIED_MANAGED_FILE`;本轮还会写的同路径文件照常被覆盖。**不在 manifest 里的文件(含 `out/tmp/`)一律不动**,写完后以 `warn BUILD_UNMANAGED_FILE out/<path>` 列出。
4. 写新文件,**最后**写 `out/manifest.json`。manifest 存在 = 这一轮写完了;中途失败(退出 3)时 manifest 缺失,下次 build 因读不到旧 manifest 而不清理孤儿,只告警。
5. 文件权限 0644、目录 0755(文件每次写完显式 `chmod 0644`,旧文件的 0755 不会保留);内容与 manifest 都经 `canonicalText` / `canonicalJson`。
6. `--report` 写 `.state/reports/build.json` 前,`.state/` 与 `.state/reports` 若是符号链接 → 退出 3。
7. **已知局限(待 `safe-fs` 改动)**:登记文件是硬链接(nlink>1)时 `safe-fs` 的删除校验一律拒绝,build 会退出 3(例如做过 `cp -al out out.bak`);修法在 `src/io/safe-fs.ts`,不在本块范围。

`--dry-run`:不调用任何 `safe-fs` 写函数(不建 `out/`、不建 `.state/`),打印 `would write out/<path> (<字节> 字节, sha256=…)`、`would remove out/<path>`(旧 manifest 里有而新结果没有的)与 `would write out/manifest.json`。预算阻断(退出 1)时同样不列清单。`--report` 与 `--dry-run` 同用时只打印报告,不写 `.state/reports/build.json`。

**out/ 布局**:`out/<agent>/<home|project>/<relPath>` + `out/manifest.json`。`home` 只是路径记号,不展开为真实 HOME。`out/` 入 git。

**manifest 形状**:就是 `ManifestSchema`(`schema_version: 1`、`kit_version`、`channel`、`files[]`、`skippedLayers[]`),由渲染核心的 `buildManifest` 生成(它拒绝未知原子、`coreEligible=false` 的原子与路径碰撞):

- `files[].path` = `<agent>/<target>/<relPath>`,按 UTF-8 字节序;`sha256` 对最终落盘内容(含独占头)的 UTF-8 字节;`atoms[]` = `{ id, layer }`(按 id 字节序;技能/子代理文件为空,来源在 `sourceRefs`);`confidence` / `conditional` 原样来自 `OutFile`。
- `skippedLayers` 恒含 `{ layer: 'personal', reason: 'P2 才在本机渲染' }`(与适配器 `PERSONAL_SKIP` 同文;即使这次没有 personal 原子)。personal 原子仍出现在合并结果里(`coreEligible=false`),但不出现在 `out/` 任何文件和 manifest 的 `atoms` 里。
- `channel`:`--overlay` 的 `channel`,缺省 `canary`。
- 契约是 strict 的:`bytes` 与 `sideEffects` **不在** manifest 里。每个文件的字节数、渲染报告(`sideEffects` / `dropped` / `shadowChecks` / `pendingProbes` / `skippedLayers`)与预算统计只进 `--report` 写出的 `.state/reports/build.json`(同样无时间戳、无绝对路径)。

**确定性(A1)**:`out/` 内容只取决于仓库内容、`kit.toml` 与覆盖层;不含时间戳、绝对路径、用户名,排序一律字节序。换 `TZ` / `LANG` / `--root` / cwd 后树哈希不变。

**golden**:`test/build/golden/<用例>/tree.txt`(out/ 整树的单文件快照)。`pnpm run golden:update` 只覆盖 `test/golden`;build 的快照用 `vitest run test/build -u` 更新。

**空仓库**:没有任何规则/技能/子代理时 `out/` 只有 `manifest.json`(`files: []`),打印 `warn BUILD_EMPTY_OUTPUT`,退出 0。

## 12. 零写入验收与状态守卫的已知边界(B20 评审后订正)

### 12.1 零写入验收(A5,`ops/lib/**`)

- **整棵目录被删**:归因取不到被删路径自身的 ctime 时,沿祖先链向上取快照里最近记录过的祖先目录的 ctime;前后确实不同却完全取不到 ctime 的差异判「待人工归因」(退出 5),**不再**当作外部临时改动放行。
- **目录摘要到文件级**:受管目录条目的子树摘要含每个文件的「路径 + 大小 + 内容 sha256」(ctime **不**进摘要:别处的 git index 刷新之类无关写入会大面积误报;写后还原由「被碰过」判据在命令窗口内抓)(总哈希预算 1GiB、5 万项;超限或读不了的子目录 => `SNAPSHOT_TRUNCATED`,退出 5,不再静默)。「被碰过」判据对目录记录用子树内文件/链接的最大 ctime(不含目录自身,避免 volatile 子项增删误报)。
- **符号链接**:记 readlink,并跟随到目标——目标在(真实)HOME 内且不在凭据位置(`.ssh .gnupg .aws .kube .azure .docker .netrc .npmrc .pypirc .config/gcloud .config/gh`)时记目标文件 sha256 / 目录树摘要,目标 ctime 并入归因;目标在 HOME 之外、是 HOME 本身、或是凭据位置(`.ssh .gnupg .aws .kube .azure .docker .netrc .npmrc .pypirc .git-credentials .zshrc 等 shell rc、.config/{gcloud,gh,lark-cli}、.codex/auth.json、.pi/agent/auth.json、Library`)及其祖先时**不读内容**,只记目标 size/ctime,目录再记「路径 + 大小 + ctime」元数据树(原地改写文件会改文件 ctime,所以仍检出),报告里以 NOTE + `outside_links` 披露盲区(不单独判红,否则常见的「链到 /opt/…」布局会让验收永久红)。只读普通文件(FIFO/设备不读)。悬空链接记 `dangling`,目标被新建同样出差异。树内部的嵌套链接只记 readlink 与文件目标哈希。已知局限:链接目标的内容哈希与其它受管文件一样是明文 sha256 写进 `.state`。
- **全程比对与静置**:最后一轮之后静置 `--settle-ms`(默认 800)再取终态快照;「两轮之间」「最后一轮之后」「首轮开始 vs 终态」任何受管路径变化 => `CHANGE_OUTSIDE_COMMAND_WINDOW`(退出 5);静置后假 HOME 新增残留、git 工作树再变化 => 退出 1;带本次运行 nonce 环境变量的后代进程静置后仍存活 => `LEFTOVER_PROCESS_AFTER_RUN`(退出 1,并终止)。**已知局限**:延迟超过静置时间的后台写入仍漏;nonce 扫描依赖 `ps -E` 能看到环境(尽力而为)。
- **volatile 不得挖空受管目录之下**:volatile 条目的匹配空间与任一受管目录条目(含 adapter 落点)子树相交 => `VOLATILE_UNDER_MANAGED_DIR`(退出 3);基线比较里新增的这类行 => `VOLATILE_ADDED_UNDER_MANAGED`。唯一豁免:不以 `/` 结尾、末段为字面 `.DS_Store` 的条目,且它只剔除同名**普通文件**(同名目录不剔除)。已知局限:volatile 仍可挖空 `HOME_WATCH` 的名字表(现有清单有意如此,如 `~/.local/share/opencode/**`);被跟随的链接目标按**链接路径**判 volatile(对目标真实路径写 volatile 行挖空不了)。
- **评审后仍未处理(待主代理/后续)**:①`SNAPSHOT_TRUNCATED`(退出 5)没有带理由的放行参数,跟随到大仓库的链接会让验收长期为 5——主代理在真实 HOME 上先数 `~/.claude/skills`、`~/.agents/skills` 跟随链接后的文件数/字节数;②`linkTarget` 在判定 scope 之前对 realpath 做 `statSync`,目标在失效 NFS/SMB 挂载上会阻塞;③单目录上百万项时 5 万上限只在进入目录时检查;④沿祖先取 ctime 可能一路取到 `~`(其 ctime 常被 shell 历史刷新)导致误判 `ours`;⑤`ps` 不可用或不显示环境(Linux 的 `-e` 语义不同)时只出 NOTE;kill 前未再核验 pid(复用);⑥基线 volatile 对外置清单(`--volatile` 在仓库外)不比较;⑦`volatileCoversManagedSubtree` 对非目录形态的受管条目(自身是指向目录的链接)返回 false。
- 其它:零条命令 => 退出 4(`NO_COMMANDS`);第二轮的命令异常与 git 树变化同样计入;`main.mjs diff` 读不了快照 => 退出 4。
- **未处理(延后)**:默认仍接受命令桩退出 64(A5 自己改判为 4);命令桩掩盖同轮受管写入(ZW-7);gitignored 路径写入不可见;`--base-ref` 默认 HEAD;adapter `managed-targets.json` 解析失败仍被跳过;HOME 顶层「写了又删」不可见。

### 12.2 no-net 垫片(A8)

`ops/guards/no-net.cjs` 是 **API 级拦截,不是沙箱**。未覆盖:`process.binding` 取 tcp/udp/cares/spawn_sync、直接构造 `dgram.Socket`、`process.dlopen`、子进程丢掉垫片(改写 `NODE_OPTIONS`/`env`)、名单外联网二进制(`git fetch|clone|ls-remote`、`npm`、`pnpm`、`npx`、`gh`、`rsync`、`dig`、`nslookup`、`host`、`openssl s_client`)、「解释器 + 脚本文件」。A8 通过 = 「没有走被拦截的 API」,不是「没有联网」。更硬的方案(后续):macOS `sandbox-exec` deny network / Linux `unshare -n` 作为正向判据。

### 12.3 状态守卫 G1–G4 的语义订正

- **GD-1(边)**:~~`merge` 不看声明者的 status~~ 已订正:`merge` 只采纳 status 为 `active`/`advisory` 的声明者发出的 `disables`/`overrides`;`proposed`/`deprecated`/`retired` 声明者的边照常校验(诊断与环检测不变),但不剔除目标、不记 `replaced`、不进 `overridden`;同 id 的替换件若属此类,自身也不进结果(上层原子胜出)。注意:render/lint 不按 status 过滤,这类原子的正文仍会渲染,只是边不生效;把替换者改成 `retired` 会让被它压掉的原子复活进 `out/`。以下为引入该修复前的守卫层处置(仍然有效):守卫层的处置(`src/merge/**` 不在本块范围):G1 拒绝**新增**原子声明非空 `disables`/`overrides`(`GUARD_G1_NEW_ATOM_HAS_EDGES`);G2 拒绝**已有**原子对这两个字段的任何增、删、改(`GUARD_G2_FIELD_LOCKED`;删边会让被压掉的原子复活);`kit:retire` 不放开(退役靠改 status 即可)。**后果**:P0 里新边只能在守卫之外由人引入。**根治已完成**:`src/merge/merge.ts` 只采纳 status 为 active/advisory 的声明者发出的边(见本条开头)。(历史说明:修复前 retired/proposed 原子身上的存量边仍然生效;现已不生效。删掉持边原子会让目标恢复,这一步只受 G4 约束。)
- **GD-2(治理字段)**:内容 PR 不得改已有原子的 `status`、`id`、`layer`、`strength`、`applies_to`、`paths`、`overrides`、`disables`,`review_by` 不得延长或改写(只允许提前)。`id` 被锁是因为边按 id 解析;要改这些字段,新建新 id 的原子并走退役。例外:基线 status 仍是 `proposed`(尚未生效)的原子可以改 `id/layer/strength/applies_to/paths`,否则写错的 proposed 原子既改不了也删不掉;`overrides/disables` 不论状态一律锁定(缺省与 `[]` 视为相同)。`owner`/`volatility` 不锁。**策略层说明**:内容 PR 仍可改 active 原子的正文、`verifier`、`evidence`、`signature`——守卫不约束正文,这是已接受的策略选择,靠人工评审(仅对无标签内容 PR 成立;`kit:reflector` PR 自 D7 起对 `rules/` `skills/` `cases/` 只许新增,改既有文件一律 `GUARD_PATH_EXISTING_MODIFIED`,见 §12.3)。
- **GD-3(stable tag)**:只认**注解** `stable-*` tag,且其提交须是基线的**严格**祖先(指向基线本身的不算)。**已知缺口**:没有签名/创建者校验(tagger 可伪造,CODEOWNERS 的 handle 与 tagger 邮箱也无映射,故不做该匹配);任何能在本地打注解 tag 的人都能在基线祖先上补 tag。**P1 CI 必须使用服务端受保护 tag 或 `verify-tag` 验签,不得信任仓库内可写的 tag。**
- 发版说明:仓库里存量的轻量 `stable-*` tag 现在被忽略,原本能通过的删除会变红(收紧方向)。
- GD-4(`.kit/rules/` 子模块被 lint 读到而守卫看不到)、GD-5(merge-base 契约未强制,只会假阳性)、GD-6(晋升 PR 不能同时补 `signature`,须先走内容 PR 补)延后;GD-6 的两步流程以此处为准。
- **`GUARD_*` 稳定码表(非 G3;G3 判据码见 `src/guards/criteria.ts` 头部注释与 `g3.ts`,K6 补登)**:
  - 引用与通用:`GUARD_REF_UNRESOLVED`(`--base`/`--head` 解析不成提交)、`GUARD_GIT_FAILED`(git 不可用或命令意外失败)、`GUARD_LABEL_UNKNOWN`(标签不在 `kit:promotion|retire|attest|reflector`)、`GUARD_PATH_UNSAFE`(路径含空段 / `.` / `..` / 反斜杠 / NUL)、`GUARD_FRONTMATTER_UNPARSEABLE`(原子任一侧读不出 frontmatter 或不是普通文件,各守卫据此 fail-closed)。
  - 反思器路径守卫(`kit:reflector`,`src/guards/path-guard.ts`;比较的是 `--no-renames` 的 diff-tree,重命名 = 旧路径 D + 新路径 A):`GUARD_PATH_FORBIDDEN`(触碰 `hooks/ kit.toml codeowners .github/ adapters/ attest/`,不区分大小写)、`GUARD_PATH_OUTSIDE_ALLOWED`(不在 `rules/ skills/ cases/ proposals/`,区分大小写)、**`GUARD_PATH_PROPOSAL_DELETED`(K6)**、**`GUARD_PATH_PROPOSAL_MODIFIED`(K6)**、**`GUARD_PATH_EXISTING_DELETED`(D7)**、**`GUARD_PATH_EXISTING_MODIFIED`(D7)**;提案来源核验(contracts #24):**`GUARD_PROPOSAL_BACKEND_MISSING`**、**`GUARD_PROPOSAL_STUB`**、**`GUARD_PROPOSAL_UNPARSEABLE`**。无标签内容 PR:**`GUARD_PROPOSAL_DELETED_UNLABELED`(K6)**。
  - G1:`GUARD_G1_NEW_ATOM_NOT_PROPOSED`、`GUARD_G1_NEW_ATOM_HAS_EDGES`。G2:`GUARD_G2_STATUS_CHANGED`、`GUARD_G2_REVIEW_BY_EXTENDED`、`GUARD_G2_FIELD_LOCKED`。G4:`GUARD_G4_DELETE_NOT_RETIRED`、`GUARD_G4_NOT_IN_STABLE_TAG`。`kit:attest`:`GUARD_ATTEST_SCOPE`。
  - G3 外壳(`g3.ts` / `labels.ts`):`GUARD_G3_FORBIDDEN_CHANGE`、`GUARD_G3_FIELD_NOT_ALLOWED`、`GUARD_G3_DIRECTION_NOT_ALLOWED`、`GUARD_G3_REVIEW_BY_WITHOUT_TRANSITION`、`GUARD_G3_LIFECYCLE_ORPHAN`、`GUARD_G3_CRITERIA_NOT_IMPLEMENTED`。
- **提案账本只增(K6)**:
  - `kit:reflector` PR 对基线里已有的 `proposals/**` 文件:**删除、重命名(旧路径)、换成符号链接 / 子模块等非普通文件** → `GUARD_PATH_PROPOSAL_DELETED`;**任何修改**(追加、改内容、清空成空文件、仅改权限位)→ `GUARD_PATH_PROPOSAL_MODIFIED`。只许新增文件。前缀比较不区分大小写(与禁区同口径);两个码与 `FORBIDDEN` / `OUTSIDE_ALLOWED` 独立,可同时出现。
  - **D7(2026-10-22 用户定):`kit:reflector` 对 `rules/` `skills/` `cases/` 同样只许新增**(`src/guards/path-guard.ts`;前缀不区分大小写,`--no-renames` 口径同上):基线已有文件被**删除、重命名(旧路径)、换成符号链接 / 子模块等非普通文件** → `GUARD_PATH_EXISTING_DELETED`;**任何修改**(改正文、清空、仅改权限位)→ `GUARD_PATH_EXISTING_MODIFIED`。两码与 `FORBIDDEN` / `OUTSIDE_ALLOWED` / G1 / G2 / G4 独立、可同时出现(例:改已有 active 原子的 `status` = `GUARD_G2_STATUS_CHANGED` + `GUARD_PATH_EXISTING_MODIFIED`;删已有原子 = `GUARD_G4_DELETE_NOT_RETIRED` + `GUARD_PATH_EXISTING_DELETED`)。**只作用于带 `kit:reflector` 标签的 PR**;无标签内容 PR 与 `kit:promotion|retire|attest` 行为不变(无标签 PR 仍可改 active 原子正文,靠人工评审,见 GD-2)。`reflect` / `promote --run` 本来只产生新增文件,不受影响。A17 的 N1 因此由「放行」改为「被拒」。✅
  - **提案来源核验(contracts #24,CI 侧,仅 `kit:reflector`,仅看本 PR 新增的 `proposals/` 下任意深度、扩展名为 `.yaml` 或 `.yml`(不区分大小写)的文件)**:`reflector.backend` 必填且为 `claude|codex|pi`,缺 / 非法 → `GUARD_PROPOSAL_BACKEND_MISSING`(CI 才能用 provider / model 重算 `deriveVendor`;重算与 `vendor` 比对仍由 C5 在采纳 / 晋升时做);`reflector.stub: true` → `GUARD_PROPOSAL_STUB`;读不出(YAML 语法错 / 顶层非映射 / 非普通文件)→ `GUARD_PROPOSAL_UNPARSEABLE`(fail-closed)。stub 提案只在本地测试里由命令层产出,守卫是 CI 侧判据,不影响本地 `reflect` / `judge` / `promote` 的 stub 路径。✅
  - **合法修改场景核对(K6 第二轮)**:仓库内没有任何命令会生成「修改已有 `proposals/*.yaml`」的补丁——`judge` 只写 `.state/reflect/<run>/proposals/` 暂存区,`promote --run` 的采纳补丁只**新增** `proposals/<id>.yaml`(已存在即 `PROPOSAL_PATH_EXISTS` 丢弃);`kit:promotion` / `kit:retire` / `kit:attest` 的 G3 / 范围守卫本来就禁止改 `proposals/`。唯一的「手工改已入库提案」场景是重跑 judge 后重新冻结(`GUARD_G3_ACCEPTANCE_REFROZEN`),它只能走**无标签内容 PR**,不受本条影响。**假设**:该场景不会被作者贴上 `kit:reflector` 标签;若有人这样做会被拒,应改走无标签 PR(待主代理确认这一假设与流程文档一致)。
  - 无任何 `kit:*` 标签的内容 PR:基线里已有的 `proposals/**` 被**删除 / 重命名旧路径 / 换成非普通文件** → `GUARD_PROPOSAL_DELETED_UNLABELED`(`runGuards` 的无标签分支,与 G1 / G2 / G4 并列)。**不拦**无标签 PR 新增提案或修改提案内容。带 `kit:promotion` / `kit:retire` / `kit:attest` 标签的 PR 行为不变(各走自己的守卫),`kit:reflector` 走上一条的 DELETED 码,不重复出本码。
- **评审清单(retire / promote 类 PR)**:PR 描述必须写明「本 PR 使哪些被压住 / 生效的原子重新出现在、或退出 `out/`」。原因:`merge` 只采纳 `active`/`advisory` 声明者的边,而 render / lint 不按 status 过滤——把一个持有 `overrides`/`disables` 的原子改成 `retired`(或把 `proposed` 晋升为 `active`)会让它压住的原子复活进 `out/`(或反过来让既有原子从 `out/` 消失)。评审者对照 `out/` 的重新生成结果核对这份清单;同 id 的替换因声明者 status 不合格而被丢弃时,`merge` 会给 `MERGE_REPLACEMENT_INERT`(warn)。

### 12.4 真跑(`--run-llm --allow-egress`)不在 A5 零写入覆盖范围内(R0,如实记录)

> **v3.1 修订(§21.18 第 38 条)**:同理,`rsi isolation probe`、`rsi exec-run`(起容器 / 宿主脚本)与 `rsi contrib submit`(推送、开草稿 PR)不在 A5 零写入覆盖内;容器出口 `runIsolated` 只许 `src/rsi/exec/**` 引用(lint 闸,§21.18 第 11 条)。

- LLM CLI 用**真实 HOME** 里的登录态,并会写它自己的全局文件(会话日志、history、缓存);`llm-exec` 只管 env/cwd/超时/输出/次数,**不能**阻止这些写入,A5 零写入验收对真跑不成立。真跑前后的受管路径快照与「每个 CLI 实际写了哪些全局文件」清单属 R6(主代理、需用户当场同意)。干跑与 stub 路径零调用零写入,仍在 A5 覆盖内。
- 残余:①`ANTHROPIC_BASE_URL` 等写在 CLI 自己的 `settings.json` 里时能把请求导向别家,`deriveVendor` 看不到,只能靠 R3 每次显式传 provider/model 与 R6 实测;②子进程若 `setsid` 脱离进程组则杀不到;③校验与 spawn 之间的路径竞态;④`envSource` 的来源(宿主环境)✅ 由 `IoContext.hostEnv` 提供(S10-rc7):`paths.ts` 按 `HOST_ENV_NAMES`(与 `LLM_ENV_ALLOW` 逐项相同,测试钉住)+ `LC_*` 从 `createIoContext` 的 `env`(缺省真实环境)挑出的冻结副本,PATH 缺省 `/usr/bin:/bin`,**HOME 始终是 `getRealHome()`**(`KIT_REAL_HOME_OVERRIDE` 优先,环境里的 HOME 不覆盖;用户 2026-10-22 定);不含任何 `*_API_KEY` / `*_BASE_URL` / `AWS_*` / `NODE_OPTIONS` 等。命令层(`reflect`/`judge`)拼子进程环境:有注入的 `CommandContext.env`(测试 / `main(argv, env)`)用注入值,否则用 `ctx.io.hostEnv`;最终仍过 `filterLlmEnv`。`CommandContext.env` 已是 `src/commands/types.ts` 的正式字段(`EnvCommandContext` 已移除)。真实 CLI 路径上此前子进程环境只有 PATH/HOME,现在会带上白名单内的 LANG / LC_* / TZ / 代理 / XDG_* / USER / LOGNAME / TMPDIR(用户 2026-10-22 已接受这一变宽;白名单本身未扩大,最终仍过 `filterLlmEnv`)。注入 `ctx.env` 的测试路径不变(`ctx.env.HOME` 缺省才取 `getRealHome()`)。

## 13. reader 已知差异(B21 记录;口径正文见 `docs/reader-counting-spec.md` §8.3)

- **agent_version 形状(R1)**:只接受版本号形状(`X.Y.Z[-+后缀]`,总长 ≤ 64);其余值当取不到,走 `collector_fallback`。四家共用基类校验。
- **R8**:Claude reader 取 `version` 时跳过侧链行,§7.5 探针不跳过;首个带 `version` 的行恰是内联侧链行时两边版本可能不同。已知差异,未改。
- **单行硬上限 64 MiB(R3)**:超限的行记 `oversized_lines` 与 `unknown_event_types["<line-too-large>"]`,不使整个会话失败。`--max-event-bytes` 的上限等于该硬上限:超过时参数解析阶段报 USAGE(退出 2);`collect()` 库入口同样拒绝越界值(RangeError);reader 的 `read()` 同步抛错按该会话 `read_error` 处理(退出 1 + `SESSION_READ_FAILED count=N classes={"<类名>":n}`,只含异常类名计数,不含 message / 路径),不使进程崩溃。`signals collect` / `redact` 的 `--timeout-ms`、`--max-event-bytes` 与 zero-write 的 `--settle-ms` 一律只收十进制非负整数(共享解析 `src/commands/args.ts`;`ops/lib/zero-write.mjs` 就地同规则),否则 USAGE(退出 2)。
- **空白/BOM(R2)**:每一行按 jq 的空白集判空白、去行首一个 BOM(详见口径 C2 补充)。
- **单行 JSON 嵌套深度上限 256(R20-A0,§20.9 第 14 条 / Q16-A)**:共享基类在 `JSON.parse` 之前按括号计数预扫(字符串内的括号不计);超过 `RSI_MAX_JSON_DEPTH`(256,`src/contracts/rsi.ts`)的行不解析、不产出事件,记 `oversized_lines` 与 `unknown_event_types["<line-too-deep>"]`(已因字节数计过 `oversized_lines` 的行不重复计),会话其余行照常读取。四家 reader 与手动 `signals collect` 共用,口径见 `docs/reader-counting-spec.md` C8 补充。

## 14. 订正(B09e)

- **脱敏值区间不吞转义**:`src/redact/engine.ts` 在映射回原文坐标后,把区间尾部紧随 `n` `r` `t` 的反斜杠串留在区间外(转义引号不收缩)(阶段 `span_escape_tail`),避免输出出现 `占位符next` 式的行粘连。仅影响值类规则的区间终点,契约字段不变。
- **占位符后缀**(阶段 `placeholder_tight_head`):原视图补扫里,值紧贴占位符、且转义换行前的短头部只是闭合的短括号实参时,不再整值判为口令;`redact --selftest --mutate` 的规则/阶段总数由 76 变为 78。
- 已知缺口追加:`gap.neutral_ph_call`(见 `docs/redaction.md` §7)。

## 15. 订正(P1-A.3)

- **`redact --stdin` 预处理:** 应用路径先调用共享函数 `neutralizePlaceholderMarkers`(`src/redact/placeholder.ts`)拆开输入里的占位符标记,与 `signals collect` 的 `makeExcerpt` 同语义;`--check` 不拆。输入中原有的占位符在输出里变成 `[[ REDACTED:…]]`。契约 `Redactor` 接口不变。
- **占位符剥离更严:** 引擎只剥原文逐字节如此的占位符(全角 / 同形字 / `\u` 转义写成的不再豁免),并把 `[[ REDACTED:<已知类型>]]` 在视图里同样剥掉(但不占位,不豁免紧邻的值);`PH_WHOLE` 引用判据已删。
- 阶段增加四个(`placeholder_neutral_marker` `placeholder_raw_exact` `multiline_block` `ref_default_chain`),`redact --selftest --mutate` 的规则 / 阶段总数 78 → 82;pass2 增加残留探测器 `probe_cred`(不计入变异自检)。
- 已知缺口:移除 `gap.neutral_ph_call`(已收);追加 `gap.bare_literal_assert` `gap.neutral_open_type` `gap.call_then_quoted` `gap.triple_escaped_quotes` `gap.yaml_anchor_block` `gap.template_default_call`(见 `docs/redaction.md` §3.4、§7)。

## 16. 订正与待 R4(R0)

- **摘录机械复制**:提案/原子证据里的 `excerpt` 由合并器从信号的 `excerpt_redacted` 原样复制,不引用 sig_id 代替、不采用 LLM 改写过的文本(与 #11 一致);外部内容信号的摘录为 `''`。
- **冷却标记**位置为 `.state/llm-cooldown/<slot>-<YYYYMMDD>`(日期按 `reflect.reset_tz`),不是设计稿里的 `~/.local/state/…`(P1 不写全局,Q-N13);reflect 不读用户的私人限流标记文件。
- **`judge.provider` 与最后一跳的关系**:设计要求最后一跳的 provider 等于 `judge.provider`,schema **不收紧**;**待 R4** 在 judge 模块校验。
- **render 是否按 status 过滤 proposed 原子**:§12.3 说不过滤,其它记录说不渲染——两说不一致,**待主代理**确认(暂存方案不受影响)。
- **opus 对抗评审(非 Codex)后仍未处理,列待主代理 / R3**:①`llm-exec` 的固定 cwd 在 `<repo>/.state/reflect/cwd`,仍在仓库 git 树内——claude/codex 向上找 git 根时可能读到仓库的 CLAUDE.md / AGENTS.md / `.claude/settings.json`(hooks 可执行命令)。R0 受 `writeRoots` 限制放不到仓库外;R3 须靠 CLI 参数(忽略项目设置)并在 R6 实测,或由主代理允许 `KIT_STATE_DIR` 指向仓库外;②`LlmSpawnBudget` 由调用方创建,没有进程级全局上限,并发调用共用同一个 cwd(一方收尾清目录会删另一方文件)——R3 须单例化预算并串行化;③`HOME` / `XDG_*` 本身可改 CLI 的配置来源,`filterLlmEnv` 未断言其不在仓库内;④`reflector.backend` 缺省时 CI 无从重算厂商——P1 CI 须要求必填;⑤`applies_to` 目前允许 LLM 填 `all`(作用范围应由合并器决定);提案 `id` 与已有原子重名(add 变覆盖)由合并器拒;⑥`o<数字>` 之外的真实模型(`gemma`、`chatglm`、`codex-mini` 等)不在内置族表,推导为 unknown(fail-closed)。
- **既有 `judge` 比较未收紧(待主代理)**:现有 superRefine 对 `judge.vendor` / 跳的 vendor 用精确字符串比较(大小写、空白可绕),且 `vendor:"unknown"` 不被拒;`reflector.vendor` 为 `unknown` 时也不拦。收紧会改变已有字段的取值集合,按 §1 不在 R0 内做;`judge_attempts` 已按归一化比较。CI 另须用 `reflector.backend` 重算厂商。

## 17. `reflect` / `judge` 命令面与验收(R5)

### 17.1 CLI 形状

```
agent-kit reflect [--agent <id>]… [--since YYYY-MM-DD] [--max-proposals N(1..5)]
                  [--run-llm --allow-egress] [--backend <slot>] [--max-calls N(1..3,默认 1)]
                  [--timeout-ms N(1000..600000)] [--owner @handle] [--show-prompt] [--json]
agent-kit reflect --gc [--write] [--json]            (暂存区回收,见 §17.7;与上面所有模式互斥)
agent-kit judge   --run <run_id> [--run-llm --allow-egress] [--max-calls N(1..10,默认 5)] [--strict]
```

- **默认干跑**:装载/分类/聚类/构造提示并打印计划(聚类数、证据数、提示字节数与 sha256、预算状态、将用的后端槽位与 CLI);**不构造后端、不调用后端、不写任何文件**。`--show-prompt` 只在干跑下把提示打到 stdout(不落盘),与 `--json`、`--run-llm` 互斥(退出 2)。干跑不要求 `--owner`(占位 `@dry-run`,不落盘)。
- **真跑(三道门)**:`--run-llm` + `--allow-egress` + 覆盖层 `reflect.egress = true`(#30);`reflect` 另需 `--owner @handle`。后端经 `buildBackends`(覆盖层 `reflect.backends` → 固定兜底链槽位),只返回已绑定的槽位;`reflect` 已绑定多个槽位时必须 `--backend <slot>` 指定(不自动挑选,摘录会发给所选厂商);真跑前 stderr 打一行 `REFLECT_EGRESS slot=… vendor=…`。所有 CLI 参数集仍是 `verified:false`,没有 `allow_unverified`(#29)就不 spawn(R6 实测前)。
- 所有数字参数只收十进制非负整数(`parseDecimalUint`):`0x10`、`1e3`、`+5`、`-1`、带空白、小数一律退出 2。
- `run_id` 形如 `run-<UTC 时间戳>-<6 位十六进制>`(`RunIdSchema` 格式),时钟与随机源可注入。
- 预算:`prepareBudgetInputs` + `computeBudget`;任一目标 `level != ok` 即「预算已满」。真跑遇到预算已满**不调用后端**(摘录不白发),stderr `REFLECT_BUDGET_FULL`,退出 1、不写任何文件;干跑只在摘要里标 `budget: full`。预算算不出来:干跑标 `budget: unknown` 仍退 0;真跑 fail-closed 退 3。
- 上限(`max_calls` / `max_proposals` / `timeout_ms`)优先级:命令行 > 覆盖层 `[reflect]` 里**显式写的值**(schema 默认值不算) > `kit.toml` 的 `[reflect]` > 内置默认(1 / 5 / 180000)。
- **干跑的 `project_key` 计数(S10-rc34,供用户填 `reflect.team_project_keys`)**:干跑且至少装载到一条信号时,`--json` 摘要**只增加一个可选键** `project_key_counts`:`[{project_key, sessions, signals}]`,按 `project_key` 升序;`sessions` = 该 key 下不同 `session_ref` 数(同 key 多会话各计一次),`signals` = 装载通过的信号条数;**只有加盐哈希 id 与计数,不含路径/文本**;形状不是 `p_<16 位十六进制>` 的 key(被篡改的信号库)不列出。无信号或真跑时该键缺省,其余键与旧形状逐字节不变;文本输出在末尾新增一段 `project_keys(…)` 逐行列出同样内容。本契约与脱敏文档对计数小的 key 没有 k-匿名/合并显示的规定,故不设阈值(待定夺)。`signals collect --dry` 不加此输出:其盐可能是临时盐,算出的 `project_key` 与落盘信号不一致,填进白名单会失效。
- stdout:人类可读摘要;`--json` 为 canonical JSON(基础键集合固定,另含上条列出的可选键),**只含计数、枚举、id、哈希**,绝不含摘录/提示/任何文本。stderr 只含稳定码(`REFLECT_USAGE|NOT_RUN|FAIL_CLOSED reason=<码>`)或用法提示(用法错可能回显用户自己输入的参数名/值,如 `未知参数:--x`),不带异常消息、不带任何信号/提示/LLM 文本。

### 17.2 退出码

| 码  | `reflect`                                                                                                                     | `judge`                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 0   | 干跑完成;真跑已暂存/无提案(含全是与已有规则重复)                                                                              | 完成(含 `judge_pending = not_configured / same_vendor_only`,非 `--strict`)                 |
| 1   | 输出被拒(schema/话术/回显/守卫模拟红灯),整批不暂存;或真跑时预算已满(未调用后端)                                               | 有 `reject` / `injection_suspected` / 没评上且出现过评审输出校验失败                       |
| 2   | 用法错(含缺 `--allow-egress`、覆盖层未同意外发、缺 `--owner`、多槽位未指定 `--backend`、`--show-prompt` 互斥、覆盖层读取失败) | 同左(`--run` 不存在也是 2)                                                                 |
| 3   | `ReflectFailClosedError`(提示复扫残留、厂商 unknown…)、`SignalStoreError`、写出口拒绝、预算算不出来(真跑)、**任何未知异常**   | 状态损坏、提示复扫残留、厂商不可证明、写出口拒绝、未知异常                                 |
| 4   | 没有已配置/可用的后端、后端报错/限流/超时、`ReflectCallLimitError`(批数 > `--max-calls`,调用前中止)                           | 后端不可用/全部冷却/超出 `--max-calls`;`--strict` 下 `not_configured` / `same_vendor_only` |

多个结果合并走 `combineExitCodes`(优先级 3 > 2 > 1 > 4 > 64 > 0)。

**`judge` 没评上且无跨厂商可用的两个稳定码(P1 D4;取代原单码 `no_cross_vendor`)**:

| 码 / `judge_pending`                          | 含义                                | 判据(`judge_attempts` 里)                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JUDGE_NOT_CONFIGURED` / `not_configured`     | 评审后端未配置(配置问题)            | 没有任何 `skipped:same-vendor`、`error:vendor_unknown` 与失败跳,各跳只有 `error:not_configured`(含后端自报未配置);命令层真跑时一个后端都没有也报此码(`reason=no_backends`,退出 4) |
| `JUDGE_SAME_VENDOR_ONLY` / `same_vendor_only` | 已配置的后端存在,但都与反思器同厂商 | 至少一跳 `skipped:same-vendor`,其余为未配置/厂商不可证明,无真实失败、无冷却                                                                                                       |

- stderr 每条提案一行 `JUDGE_NOT_CONFIGURED proposal=<id> hint=…` / `JUDGE_SAME_VENDOR_ONLY proposal=<id> hint=…`(只含稳定码、提案 id 与固定提示);stdout 摘要里 `judge_pending` 取 `not_configured` / `same_vendor_only`。`cooldown` / `all_failed` 仍用 `JUDGE_PENDING proposal=<id> reason=…`。
- 默认退出 0(决策 ⑩A:单厂商环境照常出提案,晋升时机械拒绝)。`--strict`(布尔,不带值,走与其他参数同一套严格解析,`--strict=1` 之类退出 2)下,这两种情形退出 4(与「没评上」同属 4 的 NOT_RUN 语义,没有占用新含义);3(状态损坏/厂商不可证明)与 1 仍按优先级压过 4。干跑不产生 pending,`--strict` 对干跑无影响。含 `error:vendor_unknown` 的跳不归这两个码:`judge_pending = vendor_unknown`、stderr 走 `JUDGE_PENDING … reason=vendor_unknown`,退出 3。

### 17.3 R1 订正(三句)

- 会话计数库(`.state/sessions/<agent>/<yyyymm>.jsonl`)按 `session_ref` **upsert**,`ts` 在首次写入时**钉死**(之后同一会话的重采不改它)。
- **外部内容会话**的信号不带 `tool_name`(摘录为 `''`,计数仍进计数库)。
- 取不到会话时间的会话**不写计数行**(`signals collect` 报告的 `session_stats.skipped_no_ts` 计数)。

### 17.4 真跑不在 A5 零写入覆盖范围内

LLM CLI 用真实 HOME 的登录态并写它自己的全局文件,`llm-exec` 只管 env/cwd/超时/输出/次数(§12.4)。A5 与 A19 的零写入只对**干跑与 stub 路径**成立;A19 里的真跑只用来证明"假 codex 经 kit 确实可达"(正向对照),发生在最终快照之后。真跑前后的受管路径快照与「每个 CLI 实际写了哪些全局文件」清单属 R6。

### 17.4a 后端自带身份:`LlmBackend.cli` / `provider`(S10-rc2)

- **为什么**:此前命令层靠覆盖层按槽位反查 `backendCli` 写进 `reflector.backend`,只对默认接线成立;注入的后端拿不到 CLI,提案缺 `reflector.backend`,CI 无从复算厂商(#18 / §16 ④)。厂商证明的依据必须是**后端自己**,不能是调用方另给的旁证。
- **接口**:`LlmBackend` 新增必填 `cli`(`claude|codex|pi`,另有两个标记 `stub` 与 `unconfigured`)和 `provider`(`string | undefined`,键必须存在)。`CliBackend` 从绑定取值;`StubBackend` 默认 `cli: 'stub'`;未绑定槽位占位是 `unconfigured`。
- **厂商复算**:`provenVendorOf(b)` 只看 `cli` + `provider` + `model`(经 `deriveVendor` + codex 第一方 provider 矛盾规则),不看后端自报的 `vendor`。运行时再校验一遍(不信类型):`cli` 缺失/非真实 CLI(含 `stub`、`unconfigured`)、缺 `provider` 键、`provider`/`model` 非字符串 → `unknown`。
- **`reflect`**:`reflector.backend` 取自 `backend.cli`(真实 CLI 才写);`cli === 'stub'` 的后端无论 `--stub` 与否,提案一律 `reflector.stub: true`(CI 照旧以 `GUARD_PROPOSAL_STUB` 拒收,语义不变)。真实 CLI 的后端须满足 `provenVendorOf === vendor`,否则 `REFLECT_VENDOR_UNKNOWN`;复算为 unknown 且自报厂商非内置(覆盖层追加家族)时沿用原行为放行(它不可能与任何裁判构成可证明的跨厂商)。`cli` 缺失/非法同样 `REFLECT_VENDOR_UNKNOWN`,零调用。
- **`judge`**:一跳的厂商可证明须**同时**满足:①`provenVendorOf` 与自报(归一化后)一致;②模型族推导(与 CI 的 C5 `JUDGE_VENDOR_UNPROVEN` 同口径)与之一致。不再比以前宽:`claude` 后端若模型串推不出厂商(如 `opus`)仍是 `vendor_unknown`。`stub` 后端不能当裁判。不满足 → `error:vendor_unknown`,不调用。
- **判定优先级**:同厂商判断先于厂商证明。自报与反思器同厂商的后端,即便厂商不可证明,也记 `skipped:same-vendor` 而不是 `vendor_unknown`;两种结果都是零调用、不产出裁决。
- **不变量**:命令输出、稳定码、退出码不变;`reflector.provider` 仍记槽位 id(与 `judge.provider` 同义),不是 CLI 的 `--provider`。

### 17.5 验收 `ops/accept-p1.sh`(A16–A24;A1–A15 仍是 `ops/accept-p0.sh`,语义不变,仅 A2 按下文「A2 语义订正」调整)

| 项  | 内容                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A16 | `validateReflectorOutput` 夹具矩阵:合法 8 条全过;非法 32 条按**具体原因码**被拒(未知字段 / `status:'active'` / `op:'edit'` / 超长 / 坏 pattern / `[[REDACTED` / 证据别名越界 …)                                                                                                                                                  |
| A17 | 合成 git 仓库,`kit:reflector` 标签:改 `hooks/` 等禁区、改已有 active 原子的治理字段、新增 active / 带边原子、删 active 原子,均被路径守卫 / G1 / G2 / G4 按精确码拒绝                                                                                                                                                             |
| A18 | `runJudge` + stub 后端:同厂商的跳不调用、记 `skipped:same-vendor`;全链失败 `judge_attempts` 记满 5 跳且不含 `ok`(读盘核对)                                                                                                                                                                                                       |
| A19 | 假 HOME + `node --permission` + 金丝雀假 codex + 树哈希前后对比 + 真实 HOME 受管路径快照;含五个正向对照(快照能报差异、`--permission` 真拒写、金丝雀直接执行可见、kit 真跑可达)                                                                                                                                                   |
| A20 | 变异抽检(与 A13 同构的人工完成项,标记 `.state/accept/a20.done` 绑 HEAD);`a20.mjs --run --set a20 --write-marker` 可自动做,清单见 `ops/accept/a20-mutation.md`                                                                                                                                                                    |
| A21 | `src/lifecycle/checks.ts` 的 C1–C9 夹具矩阵:合法 23 条全过;非法 124 条按**精确原因码**(`reasons` 数组整体相等 + 字段路径)被拒;checks.js 里出现的每个原因码都必须有夹具(新增原因码没补夹具 → 红)                                                                                                                                  |
| A22 | `attest` / `promote` / `retire` 零网络 + 零写入:import 传递闭包不含 `llm-exec` / `reflect/backends/**`、`child_process` 只在 `exec.ts`(白名单恰为 `['git']`);合成仓库 + 假 HOME + `node --permission` 干跑,树哈希前后一致、金丝雀二进制未被调用、真实 HOME 受管路径无差异;`--write` 只落 `.state/<命令>/`                        |
| A23 | 端到端(合成仓库、进程内 stub):reflect→judge→`promote --run`→advisory→(attest 夹具)→active→`retire` deprecated→(stable tag)retired→G4 删除→再采纳同 id 被 C7 墓碑拒;每步 `git apply --check --whitespace=error` + 真 `check --guards --label <对应 label>`;含反向对照(无 attest 被拒、无 tag 不能退役 / 删除、拿走墓碑后不再被拒) |
| A24 | 生命周期变异抽检(人工完成项,标记 `.state/accept/a24.done` 绑 HEAD):核心 9 处 L1–L9 + 验收脚本自检 X1–X2;`a24.mjs --run --set a24 --write-marker`,清单见 `ops/accept/a24-mutation.md`                                                                                                                                             |

**A2 语义订正(决策 ② 收口,用户拍板 D2;A1–A15 其余项语义不变)**:原 A2 断言真实 `kit.toml` 的 `enforce = "warn"`,现订正为断言 `enforce = "block"`,且在真实仓库上 `check` 退出 0(没有原子超限);矩阵由 12 格扩为 15 格(加「不写 `enforce`、走缺省 block」× 三种 `limit_source` × 超)。`test/fixtures/budget/matrix.json` 与 `test/budget/matrix.test.ts` 同步,`ops/accept/lib/a2.mjs` 的 `EXPECTED` 是独立 oracle。

A16–A19、A21–A23 直接 import / 运行 `dist/`;dist 比 src 旧会按「未执行(4)」处理。A19 / A22 的真实 HOME 受管路径快照有差异时退出 5(待人工归因),汇总按未通过处理;它是「提示 + 归因」而不是硬判据(多半是别的进程在写)。`--with-p0` 先调用 `accept-p0.sh` 做 A1–A15 回归。

### 17.7 `reflect --gc`:暂存区回收(S10-rc5,决策 D6)

```
agent-kit reflect --gc [--write] [--json]
```

- **只清「已过期且无引用」的 run;默认干跑**:干跑只列将删除的 `run_id`、原因(`expired_unreferenced`)与字节数,另列每个被保留的 run 及保留原因;`--write` 才真删。`--gc` 与其它模式互斥(只允许 `--write` / `--json`,否则退出 2);`--write` 只能与 `--gc` 同用(孤立的 `--write` 退出 2);未知参数退出 2。不读覆盖层、不构造后端、不读信号库。
- **保留期固定 30 天**(`REFLECT_GC_RETENTION_DAYS`),不可配置(契约此前没有保留期;要可配置另行定夺)。「时间」取 `run_id` 里的 UTC 时间戳 `run-YYYYMMDDTHHMMSSZ-…`(`report.json` 没有时间字段);恰满 30 天算过期。
- **候选必须同时满足**(任何一项无法判定 → 保留,fail-closed):①目录名过 `RunIdSchema` 且不含 `..`,且是真实目录(`lstat`,非符号链接);②目录内容**恰好**是一个普通文件 `report.json`(非链接、`nlink=1`)——没有 `proposals/`、`rules/`、`apply.patch`,即没有暂存提案,也就没有 judge 状态(写在提案里)、没有尚未 apply 的提案、不占任何提案编号;③`report.json` 过 `ReflectRunReportSchema`、`run_id` 与目录名一致、`staged` 为空;④时间戳可解析、不晚于现在、距今 ≥ 30 天;⑤仓库 `proposals/**` 与 `lifecycle/**` 的文件名与文本都不含该 `run_id`。点开头目录(`.tmp-*`)与 `cwd` 不是 run,不扫不报。
- **已用编号不会被释放,不需要墓碑**:`loadUsedProposalIds` 只从仓库 `proposals/` 与各 run 的 `proposals/` 取编号;候选 run 按②不含 `proposals/`,删除它们不可能改变该集合;含 `proposals/` 的 run(无论多旧、是否已 apply)一律保留。测试钉死「gc 前后 `loadUsedProposalIds` 相同」(且前提断言集合非空、gc 确实删了东西)。
- **删除范围与守卫**:只删 `.state/reflect/<run_id>/` 这一个目录,经 safe-fs `remove`(写出口守卫 + `findWriteRootEscape`);删之前对每个候选复核(仍是真实目录、`realpath` 的父目录仍是暂存根的 `realpath`、内容仍恰好是 `report.json`)。暂存根自身是符号链接 → 退出 3、什么都不删;引用来源读不了(`proposals/`、`lifecycle/` 本身或其中有符号链接等非常规条目,或除 ENOENT 外的读错误)→ 退出 3、什么都不删;暂存根除 ENOENT 外读不了 → 退出 3(`GC_ROOT_UNREADABLE`)。`--write` 在删除前把引用、报告、过期整体重判一遍,只删两次都判为候选的 run。
- **输出**:文本 `reflect gc: mode=dry|write retention_days=30 scanned=N candidates=K kept=M deleted=D bytes=B`,随后 `would_delete|did_delete run=<id> reason=… bytes=<n>` 与 `keep run=<id> reason=<码>`;`--json` 为 canonical,键集合固定 `bytes, candidates, deleted, kept, mode, retention_days, scanned, write`。目录名不合法的条目只显示为 `run=-`,不回显磁盘上的名字。
- **保留原因码**:`not_expired`、`bad_run_id`、`not_real_dir`、`has_other_content`、`report_missing`、`report_invalid`、`report_run_id_mismatch`、`report_has_staged`、`stamp_unparseable`、`stamp_in_future`、`referenced`。
- **退出码**:0 完成(干跑或已删);2 用法错;3 fail-closed(stderr `REFLECT_FAIL_CLOSED reason=<码>`,码取 `GC_ROOT_NOT_REAL_DIR` / `GC_ROOT_UNREADABLE` / `GC_REFERENCE_SCAN_FAILED` / `GC_RECHECK_FAILED` / `GC_RUN_ID_INVALID` / `IO_WRITE_DENIED` / `internal`)。没有 1 与 4。
- **并发**:gc 不拿跨进程锁。候选都是 ≥30 天前写完、目录里只有 `report.json` 的 run,没有任何写入方会再往它里面写(`writeStage` 先写 `.tmp-` 再整体 rename,`writeReportOnly` 拒绝覆盖已存在的目录),judge / promote 也要求 `proposals/`;所以窗口只剩「删除前一刻有人为它新增引用文件」(引用靠人合并 PR,无自动写入方),已由删除前重判压到最小;要彻底消除需给 gc 与写入方加共享锁(待定夺)。
- **已知边界(待定夺)**:含暂存提案的 run(包括已 apply 或已被 judge/promote 用过的)本版不回收,所以它们仍使 `loadStagedAtoms` / `loadUsedProposalIds` 随时间变慢;要回收需先设计「已 apply 且仓库 `proposals/` 已含同编号」或高水位记录,见 `docs/p1-backlog.md`。

### 17.6 R6 真实环境实测结论(2026-10-13,合成提示,回复 `NOTOOLS` 表示零工具成立)

参数集的 `claims` 与新增只读字段 `globalWrites` 已按下表更新;**`verified` 整体门三者都仍为 `false`**(claude/codex 的 noProjectContext / noProjectSettings / noUserRouting 本次未测,仍 `unresolved`;pi 的 2026-10-23 补测见本节末尾「pi 补测」),用户放行仍靠 `allow_unverified`,gate 语义不变。`FlagClaim` 增 `verified`(实测成立)与 `not_met`(实测不成立)。

| CLI    | 参数(模型/provider 由调用方给)                                                                                                                                                                            | noTools  | noMcp   | noSession | inputViaStdin |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | --------- | ------------- |
| claude | `-p --model <m> --tools "" --strict-mcp-config --no-session-persistence`                                                                                                                                  | verified | claimed | verified  | verified      |
| codex  | `exec -m <m> -c model_provider=… -c mcp_servers={} -s read-only --skip-git-repo-check --ephemeral` + `--disable {shell_tool,unified_exec,js_repl,code_mode,view_image,multi_agent,apps,plugins,memories}` | verified | not_met | not_met   | verified      |
| pi     | `-p --no-session --no-context-files --no-skills --no-extensions --no-approve --provider <p> --model <m> --no-tools`(取代旧的 `--tools read`;`--no-approve` 为 2026-10-23 补测追加)                        | verified | claimed | verified  | verified      |

1. **codex 的 `-c mcp_servers` 必须写 `mcp_servers={}`**:原写法 `mcp_servers="{}"` 在 codex-cli 0.161 直接报错(`invalid type: string "{}", expected a map`)。测试断言参数里不得再出现带引号的形式。`model_reasoning_effort` 不在 `build()` 的参数里(现有语义不变):R6 人工实测时另传,当前后端接口未提供该入口。
2. **codex 仅靠只读沙箱 + 空 MCP 仍会执行 shell**(read-only 下 `echo` 照跑)。加上九个 `--disable` 后回 `NOTOOLS`;**是组合有效,不知道哪几项起决定作用**,codex 升级后须重测这组 `--disable`(新版本可能改名/新增工具特性)。
3. **codex 的 MCP 仍会尝试连接**:`mcp_servers={}` 没有阻止它去连 `localhost:8000` 的 MCP(连接报错,不影响结果),所以 noMcp 标 `not_met`,不得当作「已隔离」。
4. **codex 的 `--ephemeral` 只是不存会话文件**,仍写 sqlite,noSession 标 `not_met`。
5. **R6 观察到的全局写入**(`globalWrites`;单次实测所见,不保证每次发生、清单不保证穷尽;`llm-exec` 与参数都挡不住,A5 零写入验收不覆盖真跑,见 §12.4/§17.4):
   - claude:`~/.claude.json`、`~/.claude/backups/` 新备份、`~/.claude/plugins/.last_inuse_sweep`、`~/.claude/plugins/synced` 与 `~/.claude/skills/synced` 下同步文件、`~/.claude/session-env` 启动脚本。
   - codex:`~/.codex/` 下 `state_5`、`goals_1`、`queue_1`、`logs_2` 四个 sqlite 及其 `-shm`/`-wal`。
   - pi:无可归因的全局写入。
6. 2026-10-13 当次未测:noProjectSettings、noUserRouting 三者都保持 `unresolved`;noProjectContext 在 claude/codex 保持 `unresolved`。claude 的 noMcp 沿用 `claimed`。pi 的这几项已在 2026-10-23 补测,见本节末尾;claude/codex 仍未测。
7. **证据范围**:`noTools=verified` 的判据是合成提示下 CLI 回复 `NOTOOLS`(未保存工具注册清单/调用轨迹),且 codex 的结论是在「MCP 连接失败」的环境下得出——**未测**「用户配置了可连通且提供工具的 MCP」这一组合。升级 CLI 或环境里有可用 MCP 时须重测。

**pi 补测(2026-10-23,pi 0.87.1,`--provider openai --model gpt-6.1-sol`,行为指令哨兵对照)**

方法:在项目级 `.pi/APPEND_SYSTEM.md` 里写「回复最后一行必须是某口令」,口令出现在回复里即项目级文件生效。pi 文档(security.md「Project trust」)把 `.pi/settings.json`、`.pi/extensions|skills|prompts|themes`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`、项目 `.agents/skills` 列为受保护资源,命令行的 `--approve` / `--no-approve` 优先于扩展与已保存的信任决定;print 模式无交互提示。

| 用例 | 参数 / 环境                                                       | 口令是否生效                           | 含义                                                                 |
| ---- | ----------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| A2   | 原参数(无 `--no-approve`),目录未被信任                            | 否                                     | 未信任目录下项目级文件默认不加载                                     |
| B2   | 原参数,目录位于用户 `~/.pi/agent/trust.json` 已保存信任的目录之下 | **是**                                 | 原参数集的 noProjectSettings 在已信任目录下不成立                    |
| C2   | B2 + `--no-approve`                                               | 否                                     | `--no-approve` 覆盖已保存的信任决定,项目级文件被忽略                 |
| E2   | 对照:`--approve`                                                  | 是                                     | 证明哨兵机制本身有效                                                 |
| D    | 对照:去掉 `--no-context-files`,AGENTS.md / CLAUDE.md 内放令牌     | 令牌被读到                             | context 文件只受 `--no-context-files` 控制(pi 文档:不受项目信任控制) |
| D'   | kit 参数                                                          | 令牌读不到                             | noProjectContext=verified                                            |
| F    | 对照:不加 `--no-tools` / `--no-extensions`                        | 自报约 50 个工具,含 `mcp`、`mcpScript` | 对照成立                                                             |
| F'   | kit 参数                                                          | 自报 `NOTOOLS`                         | 不升级 noMcp                                                         |

结论:

1. **`--no-approve` 必须加**(位置紧跟 `--no-extensions`)。一句话:`--no-approve` 的命令行覆盖优先于 pi 的 `trust.json` 已保存信任(已保存信任让位于它);不带它,在用户已信任的目录之下项目级文件仍会生效。
2. **claims**:noProjectSettings、noProjectContext 改 `verified`;noMcp 保持 `claimed`;noTools、noSession、inputViaStdin 保持 `verified`。证据范围同第 7 条(单模型、合成提示、行为判据,未保存工具注册清单)。其中 noProjectSettings 的范围限定为受 pi 项目信任控制的项目级资源(以 `.pi/APPEND_SYSTEM.md` 实测,文档列出的其余受保护资源同机制),**hooks 与用户级设置未单测**。noMcp 不升级:证据只有模型自报的工具清单,没有可连通 MCP 的正负对照,故仍为 `claimed`(补强办法见 `docs/p1-backlog.md`)。
3. **最低 pi 版本**:`--no-approve` 在 0.87.1 实测可用;需 pi >= 0.87,未在更低版本(含 0.87.0)验证(旧版本可能不认该旗标而报错或忽略)。
4. **noUserRouting=`not_met`**:用户级 `models.json` 可改写 provider 的 `baseUrl`,实测 `--provider openai` 因此实际经中转,而不是该厂商的默认端点。kit 的厂商判定(#18)按 provider / 模型族推导,**不保证请求实际到达的端点**。影响:跨厂商判定只在「用户未改写路由」时才成立;本版不做运行时检测(见 `docs/p1-backlog.md`),整体门因此保持 `verified:false`,放行靠 `allow_unverified`。
5. **globalWrites 仍为空**:实测前后 `~/.pi` 文件快照无新增文件;期间仅另一个并行运行的交互 pi 会话改了它自己的会话与日志文件,不可归因于本次调用。

## 18. attest / promote / retire 生命周期契约(L0 追加字段;L1–L7 实装后订正)

> **v3.1 修订(§21.18 第 4 条)**:本节只服务框架仓库自己的原子(人工路径)。个人层(自主 RSI)不经本节状态机,用私有仓库里的 `PersonalLifecycleRecord`(R21-3.5 / R21-3.6),两套记录与理由码不混用;`attest` / `promote` / `retire` 对 personal 仍退出 2 `PERSONAL_LAYER_P2`。

本节的字段追加(`JudgeRecord.rule_sha256?`、`Signal.event_key?`、`Attest.method?`、`KitConfig.lifecycle?`、新 schema `LifecycleRecord`)都是可选/新增,缺省仍合法,旧文件与旧 `kit.toml` 照常通过。三条命令 `attest` / `promote` / `retire` 已全部实装(`src/commands/{attest,promote,retire}.ts`、`src/lifecycle/**`、真判据 `src/guards/criteria.ts`),下面的命令面、退出码与稳定码**以代码为准**(L7 逐条核对过)。

**状态机与分工**:契约里没有 `attested` 状态,状态只有 `proposed / advisory / active / deprecated / retired`。三条命令不改仓库:它们在本机生成「PR 的补丁」,人 `git apply` 后提 PR;CI 的 G3 用同一份判据(`lifecycleCriteria`)再验一遍。

| 转移                                 | 命令                                                | PR 标签         | 机械证据(本机生成前先跑,CI 复核)                                                         |
| ------------------------------------ | --------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| 暂存 → `proposed`(入库)              | `promote --run <run_id>`                            | `kit:reflector` | C1–C9(§18.4)                                                                             |
| `proposed → advisory`                | `promote --rule <id> --to advisory`                 | `kit:promotion` | judge 记录存在且 accept、本地重扫干净、跨厂商可证、`rule_sha256` 与当前规则一致、层=team |
| `advisory → active`                  | `promote --rule <id> --to active`                   | `kit:promotion` | 上一行全部 + `signature` 存在 + canary attest 达到 `[lifecycle]` 阈值 + 预算不超         |
| `advisory\|active → deprecated`      | `retire --rule <id> --to deprecated --reason <码>`  | `kit:retire`    | 理由码对应的证据(§18.5)                                                                  |
| `deprecated → retired`               | `retire --rule <id> --to retired --reason <码>`     | `kit:retire`    | deprecated 已出现在某个基线**严格祖先**的 stable tag 里(`COOLDOWN_NOT_MET` 否则)         |
| `proposed → retired`(被否决提案出口) | `retire --rule <id> --to retired --reason rejected` | `kit:retire`    | 基线 `status=proposed`                                                                   |
| `retired →` 删文件                   | 内容 PR(不是三条命令的职责)                         | (无)            | G4:retired 已在基线的严格祖先 stable tag 里                                              |

- 恢复不是转移:`deprecated/retired` 不回流,要恢复就建**新 id** 的原子(`supersedes: [旧 id]`)重走 T0→active。
- 一个 PR 只能有一个标签;`kit:promotion` 不能顺带退役(预算 ≥90% 时的配对退役必须先单独合一个 `kit:retire` PR)。
- 四眼(PR 作者 ≠ 审批人)、受保护 tag、签名提交仍是 P1-D 的缺口(GD-3,§12.3);本机只做结构检查(attest 成员里至少一名不是 owner)。

### 18.1 字段与格式

- `JudgeRecord.rule_sha256?`:64 位小写十六进制。评审时规则文本的哈希:先把 frontmatter 顶层的 `status:` 与 `review_by:` 两行的**值**换成占位符,再对 `canonicalText(全文)` 取 sha256(`src/lifecycle/checks.ts` 的 `ruleSha256`;C6、G3 判据、attest 三处是同一个实现)。`judge` 命令写入;晋升时必填且必须与当前文本一致。两行之外的任何改动(含这两行行尾追加注释)都会改哈希;`status`/`review_by` 不是恰好各一行、块标量、流式写法一律 `RULE_TEXT_UNHASHABLE`(fail-closed)。
- `JudgeRecord.prompt_id?` / `prompt_sha256?`(K6,可追溯):评审用的提示模板 id(`judge-v1`,或 kit 判定 `predicted` 时的 `judge-v2`)与模板哈希;`judge` 命令写入。`prompt_sha256` = sha256(`system` 段 + `\n--USER-SKELETON--\n` + user 段**固定骨架**),骨架由同一个 `buildJudgePrompt(V2)` 用固定占位符输入渲染得到(标签结构、属性、转义改了哈希就变,数据不进哈希)。取舍:旧常量 `JUDGE_PROMPT_SHA256` 只哈希 system、保持不动(历史可查),新字段用新常量 `JUDGE_PROMPT_TEMPLATE_SHA256`,字段名与 `reflector.prompt_sha256`(模板原文哈希)同口径。**纯留痕**:两字段不是 `acceptance`(`buildAcceptance` 不接收它们)与 `rule_sha256`(规则文本哈希)的输入,G3 不要求必填,旧记录没有它们仍合法(`test/judge/prompt-trace.test.ts` 钉住)。
- `Signal.event_key?`:跨文件去重键(D4,加盐 sha256 的产物)。契约只约束:非空、≤128 字符、仅 `[A-Za-z0-9_.:-]`。
- `Attest.method?`:枚举,目前只有 `signature_proxy_v1`(按原子签名匹配信号的代理口径)。
- `KitConfig.lifecycle?`(`kit.toml` 的 `[lifecycle]`):`canary_window_days`(≥14,默认 14)、`min_members`(≥2,默认 2)、`min_non_owner_members`(≥1 且 ≤ `min_members`,默认 1)、`min_exposure_sessions`(≥10,默认 10)、`max_harmful`(只能是 0)、`no_exposure_windows`(≥2,默认 2)。每项的下界就是默认值:core 只能调严。**覆盖层(`Overlay`)不接受 `lifecycle`**(strict,出现即错),所以覆盖层无法放宽;G3 读的是**基线**的 `kit.toml`,PR 改了它也放不宽。
- `LifecycleRecord`(`lifecycle/<rule-id>/<recorded_at>-<run_id>.json`,只增目录,兼作 id 墓碑):`schema_version`、`rule_id`、`kind=retire`、`reason`(`manual|expired|superseded|no_exposure|harmful|rejected`)、`from_status`/`to_status`(只允许 `advisory→deprecated`、`active→deprecated`、`deprecated→retired`、`proposed→retired`)、`by?`(仅 `superseded`,且必填)、`rule_sha256`、`attest_digests`、`kit_version`、`run_id`、`recorded_at`、`owner`(`@handle`)、`note?`(≤200 字,拒控制/格式/私用/未分配字符)。`rejected` 只配 `proposed→retired`;`no_exposure`/`harmful` 只配退到 `deprecated`。`lifecycle/` 在 `G3_ADD_ONLY_DIRS` 与反思器禁区里。

### 18.2 命令面

```
agent-kit attest  --rule <id> --member @handle --window-start YYYY-MM-DD --window-end YYYY-MM-DD
                  [--channel canary|stable] [--agent <id>]… [--write] [--json]
agent-kit promote --run <run_id> [--write] [--json]
agent-kit promote --rule <id> --to advisory|active [--today YYYY-MM-DD] [--write] [--json]
agent-kit retire  --rule <id> --to deprecated|retired --reason manual|expired|superseded|no_exposure|harmful|rejected
                  [--by <id>] [--today YYYY-MM-DD] [--write] [--json]
```

- **零网络**:三条命令的源码 import 闭包不含 `src/io/llm-exec.ts` 与 `src/reflect/backends/**`,唯一子进程是 `git`(经 `exec.ts`,白名单恰为 `['git']`;`attest` 不起任何子进程)。`--run-llm` / `--allow-egress` 出现即退出 2。A22 静态+动态地验证这一点。
- **默认干跑**:只算、只打印;`--write` 才写,且只写 `.state/<命令>/<id>/`(目录 0700、文件 0600,先写 `.tmp-<id>` 再整体 rename,一律经 safe-fs),**不写 `rules/` / `attest/` / `lifecycle/`**——落到仓库靠人 `git apply` + PR。产物:`attest` → `.state/attest/<run_id>/{attest.patch, report.json}`;`promote` → `.state/promote/<promo_id>/{promote.patch, pr-body.md, report.json}`;`retire` → `.state/retire/<retire_id>/{retire.patch, pr-body.md, report.json}`。
- **补丁**:`promote --rule` 只改 `status:` 一行(`--to active` 再改 `review_by:` 一行),`retire` 改 `status:` 一行并新增 `lifecycle/<rule-id>/<recorded_at>-<run_id>.json`,`attest` 只新增一个 `attest/<rule-id>/…json`;`index` 行写 HEAD 的 blob oid,必须能通过 `git apply --check --whitespace=error`。`promote --run` 用**当前**(已含 judge 记录的)提案与规则文件重新生成补丁,暂存区里 judge 之前生成的 `apply.patch` 作废(PR 描述里写明以 `promote.patch` 为准)。
- **前置**:`promote --rule` / `retire` 要求工作树里该规则文件与 HEAD 同路径 blob 逐字节相同,否则 `PROMOTE_WORKTREE_DIRTY`(补丁以 HEAD 为基线)。判据在内存里叠加新文本构造 head 视图后调用**真 `checkG3`**(`lifecycleCriteria`),再补跑 C1/C1b/C3(治理版)/C5/C6/C7/C8;红则不产出;`out/` 进出清单与预算由对 base / head 两份原子集各做一次 merge + render 算出(不写 `out/`)。
- **幂等**:`promo_id` / `retire_id` / `run_id`(retire)由输入内容决定(规则 id、方向、HEAD blob oid、attest 文件哈希;`promote` 另含目标 `review_by`,`retire` 另含理由、`--by`、`--today`,`retire_id` 还并入 `out/` 清单与 kit 版本),同输入同补丁同 id;目录已存在且文件逐字节一致 → 退出 0 不重写;不一致或多出/缺文件 → 退出 3 `PROMOTE_RUN_EXISTS` / `RETIRE_RUN_EXISTS`(`attest` 为 `run_exists`)。`retire` 的 `run_id` 是确定性的(形如 `run-<today>T000000Z-<输入哈希前 6 位>`),不是随机。
- **输出**:stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON、键集合固定);`pr-body.md` 与 `report.json` 同样不含摘录、正文、提示;stderr 只含稳定码 `<CMD>_USAGE|CHECK_FAILED|NOT_RUN|FAIL_CLOSED reason=<码>`,不回显异常消息与任何原子/提案文本。判据红时 stdout 另列 `fail <检查>:<原因码>` 行(`--json` 为 `failures` 数组)。
- 数字参数用十进制非负整数;日期一律 `IsoDateSchema`(真实日历日);时钟与随机源可注入;`--today` 缺省取时钟的 UTC 日期。
- 层:personal 层 P1 没有消费者,三条命令一律退出 2 `PERSONAL_LAYER_P2`;org 层(`ORG_LAYER_NOT_PROMOTABLE`,无 `origin=proposal`)与其它层(`LAYER_NOT_PROMOTABLE`)同样退出 2。

### 18.3 退出码

| 码  | attest                                                                                       | promote                                                                                                                                                                           | retire                                                                                                          |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0   | 干跑完成 / 已写出 / 同 run_id 已存在且一致                                                   | 干跑完成 / 已写出 / 已是目标状态(`already=1`)/ 同 id 已存在且一致                                                                                                                 | 同左                                                                                                            |
| 1   | 规则不可计数(状态不是 advisory/active、无签名、签名不安全)                                   | `--run`:有提案被丢(`proposals_dropped`,任一 C1–C9 不过)或运行里没有提案(`empty_run`);`--rule`:规则/提案找不到、工作树与 HEAD 不同、方向不允许、无 signature、模拟 G3 红、预算阻断 | 规则找不到、工作树与 HEAD 不同、方向 / 理由配对不允许、理由证据不满足、冷却未满足、模拟 G3 红、预算阻断         |
| 2   | 缺参数、member 不在成员表、窗口反了、规则不存在、personal 层、`--run-llm` / `--allow-egress` | 用法错(含 `--run` 与 `--rule` 同给或都不给)、`--run` 的 run 不存在、personal / org / 其它层、`--run-llm` / `--allow-egress`                                                       | 用法错(含 `superseded` 缺 `--by`、`--by` 配了别的理由)、personal / org / 其它层、`--run-llm` / `--allow-egress` |
| 3   | 信号库损坏、配置读取失败、写出口拒绝、同 run_id 目录已存在且不一致、补丁自检不过、未知异常   | fail-closed:暂存状态损坏、信号库损坏、脱敏扫描异常、git 不可用、HEAD 不可解析、配置不可读、`OUT_DIFF_*`、写出口拒绝、`PROMOTE_RUN_EXISTS`、补丁自检不过                           | fail-closed:git 不可用、配置不可读、`OUT_DIFF_*`、`RECORD_INVALID`、写出口拒绝、`RETIRE_RUN_EXISTS`             |
| 4   | 窗口内没有任何信号/会话数据(`no_window_data`)、`signature.type=path` 无数据源                | `--run`:证据信号在本机信号库里找不到(无法核对)且没有硬失败;`--rule`:`judge_pending:cooldown`(稍后重跑 judge)                                                                      | `no_exposure` 但没有任何计入口径的 attest(`NO_ATTEST_IN_WINDOW`)                                                |

多结果合并走 `combineExitCodes`(3 > 2 > 1 > 4 > 64 > 0)。`promote --run` 一批里既有 personal 又有 team 提案时,team 照常写出、整体退 2(是否改为整批不写,见 `docs/p1-backlog.md` 遗留项⑨)。

### 18.4 稳定码

`reason=` 后面只会是下列枚举(或 `OUT_DIFF_` / `PATCH_` 前缀 + 我方枚举)。判据红时 `fail` 行与 `--run` 的 `dropped_by_reason` 键形如 `<检查>:<原因码>`(`C1`–`C9`、`G3`、`RAW`)。

- **通用(promote --rule / retire)**:`PROMOTE_WORKTREE_DIRTY`、`RULE_NOT_FOUND`、`RULE_AMBIGUOUS`、`ATOM_UNREADABLE`、`ATOM_INVALID`、`PROPOSAL_MISSING`、`PROPOSAL_INVALID`(仅 promote)、`DIRECTION_NOT_ALLOWED`、`PERSONAL_LAYER_P2`、`ORG_LAYER_NOT_PROMOTABLE`、`LAYER_NOT_PROMOTABLE`、`HEAD_UNRESOLVED`、`CONFIG_UNREADABLE`、`BUDGET_BLOCKED`、`PATCH_RESULT_INVALID`、`criteria_failed`(模拟 G3 / C 检查红,逐条原因在 `fail` 行)。
- **`OUT_DIFF_*`**(退出 3,`out/` 进出清单算不出):`OUT_DIFF_MERGE_FAILED`、`OUT_DIFF_RENDER_FAILED`、`OUT_DIFF_ATOM_UNPARSABLE`。
- **`PATCH_*`**(补丁生成器拒绝构造不安全补丁,退出 1):`PATCH_BOM`、`PATCH_CR`、`PATCH_EMPTY`、`PATCH_FRONTMATTER_UNCLOSED`、`PATCH_LINE_COUNT_CHANGED`、`PATCH_NO_FINAL_NEWLINE`、`PATCH_NO_FRONTMATTER`、`PATCH_PATH_UNSAFE`、`PATCH_REVIEW_BY_LINE_COUNT`、`PATCH_TRAILING_WHITESPACE`、`PATCH_VALUE_UNSAFE`。
- **promote --rule 独有**:`SIGNATURE_MISSING`(升 active 但原子无 `signature`;stderr 另带 `hint=` 提示先走内容 PR 补 signature 并重跑 judge,再晋升)、`REVIEW_BY_UNREACHABLE`(T2 新 `review_by` 不晚于今天:受 lint 的 `created+180d`(volatile 为 `created+30d`)上限约束)、`judge_pending:cooldown`(退出 4)。
- **retire 独有**:`REASON_DIRECTION_MISMATCH`(理由与方向不配)、`REASON_NOT_EXPIRED`、`REASON_BY_INVALID`、`REASON_NO_EXPOSURE_UNMET`、`REASON_NOT_HARMFUL`、`COOLDOWN_NOT_MET`、`RULE_HASH_UNCOMPUTABLE`、`RECORD_INVALID`、`NO_ATTEST_IN_WINDOW`(退出 4)。证据码来自 L2 判据,其余判据红统一 `criteria_failed`。
- **幂等 / 写出**:`PROMOTE_RUN_EXISTS`、`RETIRE_RUN_EXISTS`、`tmp_exists`、`state_dir_unsafe`、`state_file_unsafe`、`state_perm_unsafe`(均退出 3)。
- **promote --run**:`run_not_found`(2)、`state_invalid`、`signal_store`、`redactor_init`、`git_failed`(3)、`proposals_dropped`(1)、`unverifiable`(4)、`empty_run`(1)。被丢提案按 `<检查>:<原因码>` 或 `RAW:<REDACTION_RESIDUAL|HIDDEN_CHARS|DANGEROUS_PHRASE|PROPOSAL_PATH_EXISTS>` 计数;fail-closed 的整批码:`REDACTION_SCAN_ERROR`、`SIGNAL_LOOKUP_ERROR`、`CHECK_INTERNAL_ERROR`、`FS_SYMLINK`、`FS_NOT_REGULAR`、`FS_HARDLINK`、`RUN_ID_INVALID`、`INPUT_MISSING`、`STATE_DIR_UNSAFE`、`PATCH_SELF_CHECK`。
- **attest(小写蛇形)**:用法 `missing:--rule` / `missing:--member` / `missing:--window-start` / `missing:--window-end`、`bad_member`、`bad_window_start`、`bad_window_end`、`window_reversed`、`bad_channel`、`bad_agent`、`unknown_arg`、`no_egress_flags`、`overlay_unreadable`、`member_not_in_channel`、`rule_not_found`、`PERSONAL_LAYER_P2`;检查 `rule_not_countable`、`signature_missing`、`signature_unsafe`(1);`signature_path_unsupported`、`no_window_data`(4);`state_dir_unsafe`、`state_file_unsafe`、`config`、`signal_store_schema`、`signal_store`、`patch_unsafe`、`patch_scope`、`run_exists`、`tmp_exists`(3)。

**C1–C9 采纳检查**(`src/lifecycle/checks.ts`,纯函数,采纳 / 晋升 / CI 三处共用;原因码不回显被扫描的文本):C1 本地重扫注入(judge 的 `injection_suspected=false` 只记录、不作放行依据)与 C1b 不可见字符补全集;C2 证据摘录与本机信号库逐字节相等(仅提案人本机,CI 只做原子↔提案一一对应);C3 固定字段(`status=proposed`、`strength=should`、`verifier=none`、无边、`origin`、`review_by`、owner,**无覆盖参数**;晋升用另一个函数 `checkC3Governance`);C4 层规则(`team_project_keys` 白名单、≥2 项目、≥2 会话);C5 评审记录(跨厂商可证、非 stub、最后一跳 ok、`provider`=最后一跳槽位、厂商可由模型串复算);C6 规则文本与评审绑定(`rule_sha256`);C7 id 与去重(仓库 / 暂存区 / 退役记录墓碑 / 近重复);C8 脱敏复扫;C9 路径与补丁安全。晋升 / 退役的 G3 判据见 `src/guards/criteria.ts` 头部注释(`GUARD_G3_*` 全表)。

### 18.5 退役理由码

| 理由          | 机械证据(不满足 → 退出 1)                                           | 允许的方向             |
| ------------- | ------------------------------------------------------------------- | ---------------------- |
| `manual`      | 无,只靠 PR 审批                                                     | → deprecated / retired |
| `expired`     | `review_by < --today`                                               | → deprecated / retired |
| `superseded`  | `--by` 指向的原子存在、`status=active`、其 `supersedes` 含本 id     | → deprecated / retired |
| `no_exposure` | 最近 `no_exposure_windows` 个 canary 窗口的有效 attest 曝光合计为 0 | → deprecated           |
| `harmful`     | 任一计入口径的 attest 的 `harmful > 0`                              | → deprecated           |
| `rejected`    | 基线 `status=proposed`                                              | proposed → retired     |

记录兼作 id 墓碑:原子文件被 G4 删掉后,`lifecycle/<rule-id>/` 仍在,C7 据此拒绝重用旧 id(`ID_TOMBSTONED`)。长期未命中只能提示、不自动退役。

### 18.6 验收与已知边界

- 验收 A21–A24(`ops/accept-p1.sh`,见 §17.5 表;A23 端到端只走了 `manual` 一条理由,`expired` / `superseded` / `no_exposure` / `harmful` / `rejected` 的证据路径由 A21 之外的 `test/guards/criteria.test.ts` 与 `test/commands/retire.test.ts` 逐条覆盖):A21 = C1–C9 夹具矩阵;A22 = 三条命令零网络(import 图)+ 零写入(干跑快照);A23 = 端到端 reflect→judge→采纳→advisory→active→deprecated→retired→G4 删除→墓碑;A24 = 变异抽检(人工完成项)。A5 的命令清单已含三条命令的干跑(合成仓库上,包装脚本比对前后树哈希)。
- 已知边界与遗留项统一登记在 `docs/p1-backlog.md`「attest / promote / retire 遗留项」;包括:无密码学保护的 judge / lifecycle / attest 文件(靠 CODEOWNERS 与 P1-D 四眼)、stable tag 可伪造(GD-3)、窗口日期与 `recorded_at` 是作者可写数据、`event_key` 目前是历史链哈希、`harmful` / `recurrence` 在真实信号库恒为 0。

### 18.7 示例

`JudgeRecord` 带 `rule_sha256`(不带该字段的旧记录同样合法,见 §10.8 / §10.9 的 `Proposal` 示例)。

<!-- example:valid schema=JudgeRecord -->

```json
{
  "hops": [{ "hop": "codex", "vendor": "openai", "model": "example-model-id", "result": "ok" }],
  "provider": "openai",
  "vendor": "openai",
  "verdict": "accept",
  "overfit_risk": "low",
  "injection_suspected": false,
  "conflicts": [],
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000007"
}
```

字段缺省仍合法(向后兼容)。

<!-- example:valid schema=JudgeRecord -->

```json
{
  "hops": [{ "hop": "codex", "vendor": "openai", "model": "example-model-id", "result": "ok" }],
  "provider": "openai",
  "vendor": "openai",
  "verdict": "accept",
  "overfit_risk": "low",
  "injection_suspected": false,
  "conflicts": []
}
```

错误示例:`rule_sha256` 不是 64 位小写十六进制。

<!-- example:invalid schema=JudgeRecord -->

```json
{
  "hops": [{ "hop": "codex", "vendor": "openai", "model": "example-model-id", "result": "ok" }],
  "provider": "openai",
  "vendor": "openai",
  "verdict": "accept",
  "overfit_risk": "low",
  "injection_suspected": false,
  "conflicts": [],
  "rule_sha256": "ABC"
}
```

`Signal` 带 `event_key`。

<!-- example:valid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "session_meta",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-12T00:00:00Z",
  "type": "event",
  "excerpt_redacted": "",
  "external_content": false,
  "confidence": 1,
  "loaded_rule_ids": [],
  "event_key": "ek_0123456789abcdef0123456789abcdef"
}
```

错误示例:`event_key` 含空格与斜杠。

<!-- example:invalid schema=Signal -->

```json
{
  "sig_id": "sig_0123456789abcdef",
  "agent": "claude",
  "agent_version": "2.1.280",
  "agent_version_source": "session_meta",
  "session_ref": "s_0123456789abcdef",
  "project_key": "p_fedcba9876543210",
  "ts": "2026-10-12T00:00:00Z",
  "type": "event",
  "excerpt_redacted": "",
  "external_content": false,
  "confidence": 1,
  "loaded_rule_ids": [],
  "event_key": "bad key/with space"
}
```

`Attest` 带 `method`(§10 里不带 `method` 的 `Attest` 示例仍合法)。

<!-- example:valid schema=Attest -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "channel": "canary",
  "member": "@handle",
  "window_start": "2026-10-09",
  "window_end": "2026-10-23",
  "kit_version": "0.0.0",
  "collector_versions": { "claude": "2.1.280" },
  "sessions_total": 41,
  "exposure_sessions": 12,
  "exposure_projects": 3,
  "fired": 12,
  "harmful": 0,
  "recurrence": 0,
  "signal_ids_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006",
  "method": "signature_proxy_v1",
  "run_id": "run-0001"
}
```

错误示例:`method` 不是已知枚举值。

<!-- example:invalid schema=Attest -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "channel": "canary",
  "member": "@handle",
  "window_start": "2026-10-09",
  "window_end": "2026-10-23",
  "kit_version": "0.0.0",
  "collector_versions": {},
  "sessions_total": 41,
  "exposure_sessions": 12,
  "exposure_projects": 3,
  "fired": 12,
  "harmful": 0,
  "recurrence": 0,
  "signal_ids_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006",
  "method": "signature_proxy_v2",
  "run_id": "run-0001"
}
```

`KitConfig` 带 `lifecycle`(不带该段的 §10.3 示例仍合法)。

<!-- example:valid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["claude"] },
  "budget": {},
  "channels": {},
  "lifecycle": {
    "canary_window_days": 21,
    "min_members": 3,
    "min_non_owner_members": 2,
    "min_exposure_sessions": 10,
    "max_harmful": 0,
    "no_exposure_windows": 2
  }
}
```

错误示例:`canary_window_days` 低于下界 14(只能调严,不能调松)。

<!-- example:invalid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["claude"] },
  "budget": {},
  "channels": {},
  "lifecycle": { "canary_window_days": 7 }
}
```

错误示例:覆盖层不接受 `lifecycle`。

<!-- example:invalid schema=Overlay -->

```json
{ "lifecycle": { "canary_window_days": 14 } }
```

<!-- example:valid schema=Overlay -->

```json
{ "channel": "canary" }
```

`LifecycleRecord`。

<!-- example:valid schema=LifecycleRecord -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "kind": "retire",
  "reason": "superseded",
  "from_status": "active",
  "to_status": "deprecated",
  "by": "positive-control-for-negative-assertions",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "attest_digests": [],
  "kit_version": "0.1.0",
  "run_id": "run-20261013T000000Z-0a1b2c",
  "recorded_at": "2026-10-13",
  "owner": "@handle",
  "note": "replaced by a sharper rule"
}
```

错误示例:`rejected` 理由配了 `active→deprecated`。

<!-- example:invalid schema=LifecycleRecord -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "kind": "retire",
  "reason": "rejected",
  "from_status": "active",
  "to_status": "deprecated",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "attest_digests": [],
  "kit_version": "0.1.0",
  "run_id": "run-0001",
  "recorded_at": "2026-10-13",
  "owner": "@handle"
}
```

### 18.8 预测账与验收协议冻结的契约(K1,契约先行;K2–K6 实装后订正)

设计依据:`rsi-borrow-design.md` §1.2、§1.6、§1.8、§2.2、§2.3、§2.5、§2.7;用户 2026-10-14 已定 ①B(晋升加严)、②A(无冻结记录一律不得晋升)、③A(judge 给不出合法预测 = 该跳无效)、④A(7 天 × 最多 4 块、不要求逐块连续)。**本节只定字段、常量、码表与兼容规则;本块(K1)不实现任何运行逻辑**,下列稳定码由 K2–K5 在各自模块里产出。新增字段全部可选且为 `strictObject`,缺省仍合法。

**字段(`src/contracts/{proposal,attest,config}.ts`)**

- `JudgeOutput.prediction?`:`{direction, ratio_lo, ratio_hi, confidence}` 四个值,LLM 只给这四个。
- `JudgeRecord.prediction?`:`{schema_version:1, metric:"exposure_rate", status, direction?, ratio_lo?, ratio_hi?, confidence?, acceptance_sha256}`。`status` 由 kit 决定:`predicted`(四值必填且形状合法)、`baseline_insufficient`(引导窗口 `sessions_total < 20` 或 `exposure_sessions < 3`)、`not_measurable`(`path` 型或 `always` 型签名);后两者四值**必须缺省**(LLM 给了也丢弃)。`acceptance_sha256` 恒必填。
- `JudgeRecord.acceptance?`:冻结的验收协议 `{schema_version:1, method:"signature_proxy_v1", rule_sha256, signature_sha256, guidance_until, baseline_sha256, judged_at_head, frozen_at, anchor_min, tile_days(≥7), max_tiles(2..8), sha256}`。`guidance_until` / `frozen_at` 是 ISO 时间戳,`anchor_min` 是 ISO 日期,`judged_at_head` 是 40 位小写 hex 的提交 oid,其余哈希为 64 位小写 hex。
- `Proposal.reflector.guidance?`:`{since: ISO 日期|null, until: ISO 时间戳, baseline:{sessions_total, exposure_sessions, fired}}`(非负整数,只有计数)。
- `Attest.acceptance_sha256?`:64 位小写 hex,该 attest 所遵守的冻结协议的 `sha256`。
- `KitConfig.lifecycle.acceptance_tile_days`(整数 ≥7,默认 7)、`acceptance_max_tiles`(整数 2..8,默认 4)。**refine**:`ceil(canary_window_days / acceptance_tile_days) + STRICT_EXTRA_TILES ≤ acceptance_max_tiles`(默认 `2+1 ≤ 4` 成立;`canary_window_days=28, tile=7, max=4` 得 `5 > 4`,`kit.toml` 直接不合法,不会出现「加严后永远凑不够块」的规则)。缺省不出现时旧 `kit.toml` 照常通过。

**常量**

- `RATIO_GRID = [0, 0.1, 0.25, 0.5, 0.8, 1.25, 2, 4, "inf"]`。JSON / YAML 没有 Infinity,所以 +∞ 用字符串 `"inf"`(不用 `null`:`null` 与可选字段的「缺省」语义冲突)。**位置与跨度一律按网格下标比较,不做数值比较**;进哈希的规范形里数字是 JS 数字(`4` 不是 `4.0`),+∞ 恒为 `"inf"`。
- `PREDICTION_CONFIDENCES = [0.5, 0.7, 0.9]`;`PREDICTION_DIRECTIONS = [down, flat, up]`(`flat` = r ∈ [0.8, 1.25]);`PREDICTION_STATUSES = [predicted, baseline_insufficient, not_measurable]`;`PREDICTION_METRICS = [exposure_rate]`;`PREDICTION_MAX_GRID_SPAN = 3`。
- `STRICT_EXTRA_TILES = 1`、`CALIBRATION_MIN_N = 10`、`CALIBRATION_GAP = 0.20`(`src/contracts/config.ts`):**代码常量,不进 `kit.toml`、覆盖层改不了**,避免配置放宽校准口径。数值是初始常量,没有统计依据。

**预测形状规则**(`validatePredictionShape`,纯函数,返回**全部**违反项;schema 层与后续块共用):`ratio_lo` / `ratio_hi` 必须是网格点;`ratio_lo` 不得为 `"inf"`;`lo < hi`(按下标);下标差 ≤ 3(锐度上限,防「永远报 [0,+inf] 必中」);方向一致:`down ⇒ lo < 0.8`、`up ⇒ hi > 1.25`、`flat ⇒` 闭区间 `[lo,hi]` 与 `[0.8,1.25]` 相交。原因码:`lo_off_grid`、`hi_off_grid`、`lo_inf`、`order`、`span`、`direction_down`、`direction_up`、`direction_flat`、`direction_unknown`(方向不在枚举也要报,不得整条放行)、`confidence_off_grid`(给了置信度才校验)。schema 层 `issue.path` 指向出错字段(`order` / `span` 同时涉及两端,约定记在 `ratio_hi`),消息形如 `prediction_invalid:<原因码>`。`direction=down` 只要求 `lo < 0.8`(设计 §1.2 的原文),所以 `[0.1, 1.25]` 这类跨越 flat 区的区间在形状层合法,不另加互斥约束。

**schema 层不判、留给 G3(K4)的跨字段规则**(这样各有自己的稳定码,不会都塌成 `PROPOSAL_INVALID`):`prediction.acceptance_sha256 == acceptance.sha256`、`acceptance.sha256` 自哈希、`acceptance.rule_sha256 == judge.rule_sha256 == 当前原子哈希`、`signature_sha256` / `baseline_sha256` 与当前值相等、基线自洽(`exposure_sessions ≤ sessions_total`、`exposure_sessions ≤ fired`)、`guidance_until ≤ frozen_at`、git 锚点。

**新稳定码**(**仓库没有集中登记点**:`criteria.ts` 头注释与 §18.4 是文字列表,没有注册表测试;K1 只在此登记,K4/K5 实现时再补 `criteria.ts` 头注释,K6 做一致性核对):

| 码                                                                    | 级别                              | 产出方         | 含义                                                                                                                                              |
| --------------------------------------------------------------------- | --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prediction_invalid`(细分见上「原因码」)                              | judge 该跳 `error:invalid_output` | K3 `output.ts` | 预测离网格、`lo ≥ hi`、跨度超限、方向矛盾、置信度不在枚举、`status=predicted` 缺字段、其余 status 带了值。不允许「verdict 收下、prediction 缺省」 |
| `ACCEPTANCE_MISSING`                                                  | G3 T2 error                       | K4             | 提案无 `judge.acceptance`(旧 judge 记录),重跑 judge 补                                                                                            |
| `ACCEPTANCE_HASH_MISMATCH`                                            | G3 T2 error                       | K4             | 自哈希、与 prediction / rule_sha256 / 签名 / 基线哈希对不上,或基线不自洽                                                                          |
| `ACCEPTANCE_CLOCK_INCONSISTENT`                                       | G3 T2 error                       | K4             | `guidance_until > frozen_at`、`frozen_at` 晚于冻结提交日期、`judged_at_head` 不是冻结提交的祖先                                                   |
| `ACCEPTANCE_CHANGED_AFTER_FREEZE` / `PREDICTION_CHANGED_AFTER_FREEZE` | G3 T2 error                       | K4             | 冻结提交之后 `judge.acceptance` / `judge.prediction` 被改                                                                                         |
| `ACCEPTANCE_WEAKER_THAN_CORE`                                         | G3 T2 error                       | K4             | 冻结值(tile 天数、块数)弱于基线 `kit.toml` 的现值                                                                                                 |
| `FREEZE_COMMIT_UNKNOWN` / `TEXT_SINCE_UNKNOWN`                        | G3 T2 error                       | K4             | 找不到冻结提交、冻结提交不是基线祖先、`rule_sha256` 首次入库提交查不出(与 `ADVISORY_SINCE_UNKNOWN` 同形,fail-closed)                              |
| `GUARD_G3_THRESHOLD_TILES`                                            | G3 T2 error                       | K5a            | 有效验收块不足(消息写明是否因加严)                                                                                                                |
| `JUDGE_OVERCONFIDENT` / `CALIBRATION_INSUFFICIENT`                    | G3 info                           | K5a            | 因 judge 过度自信而加严 / 样本不足、不加严                                                                                                        |
| `CALIBRATION_UNAVAILABLE` / `CALIBRATION_ITEM_UNREADABLE`             | G3 T2 fail-closed(加严)           | K5a            | 全局计算失败 / 同键条目损坏,一律按「过度自信」加严                                                                                                |
| `ATTEST_NOT_COUNTED`(既有码,新增原因)                                 | warn                              | K4             | attest 不对齐、早于 D0 / `textSince`、超出 `max_tiles`、`acceptance_sha256` 不符、早于冻结提交入库                                                |

**前向不兼容规则(硬规则)**:所有 schema 都是 `strictObject`,所以**旧版 kit 读到带新字段的提案 / attest 会按未知键拒收**(`PROPOSAL_INVALID` 一类的 fail-closed,不是静默错误,但会卡人)。因此:**CI 与全部 canary 成员升到新版之前,带新字段的提案(含 `judge.prediction` / `judge.acceptance` / `reflector.guidance`)和带 `acceptance_sha256` 的 attest 不得入库**。机制是:产出方(新版 `reflect` / `judge` / `attest`)先于消费方(旧版 CI / 其他成员的 kit)升级时,消费方的 strictObject 校验会拒收这些文件。`schema_version` 将来升到 2 同理:旧读者的 `z.literal(1)` 会拒收。具体用哪个版本字段做可执行的准入校验(设计 §5 的 `min_kit_version`)待核,不在 K1。向后兼容方向不受影响:不带新字段的旧文件继续合法。

**示例**。`JudgeRecord` 带 `prediction` 与 `acceptance`(`ratio_hi` 用 `"inf"`)。

<!-- example:valid schema=JudgeRecord -->

```json
{
  "hops": [{ "hop": "codex", "vendor": "openai", "model": "example-model-id", "result": "ok" }],
  "provider": "openai",
  "vendor": "openai",
  "verdict": "accept",
  "overfit_risk": "low",
  "injection_suspected": false,
  "conflicts": [],
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000007",
  "prediction": {
    "schema_version": 1,
    "metric": "exposure_rate",
    "status": "predicted",
    "direction": "up",
    "ratio_lo": 1.25,
    "ratio_hi": "inf",
    "confidence": 0.7,
    "acceptance_sha256": "0000000000000000000000000000000000000000000000000000000000000009"
  },
  "acceptance": {
    "schema_version": 1,
    "method": "signature_proxy_v1",
    "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000007",
    "signature_sha256": "0000000000000000000000000000000000000000000000000000000000000008",
    "guidance_until": "2026-10-14T03:12:00Z",
    "baseline_sha256": "000000000000000000000000000000000000000000000000000000000000000a",
    "judged_at_head": "0123456789abcdef0123456789abcdef01234567",
    "frozen_at": "2026-10-14T05:40:00Z",
    "anchor_min": "2026-10-15",
    "tile_days": 7,
    "max_tiles": 4,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000009"
  }
}
```

`status` 不是 `predicted` 时四个预测值必须缺省。

<!-- example:valid schema=JudgeRecord -->

```json
{
  "hops": [{ "hop": "codex", "vendor": "openai", "model": "example-model-id", "result": "ok" }],
  "provider": "openai",
  "vendor": "openai",
  "verdict": "accept",
  "overfit_risk": "low",
  "injection_suspected": false,
  "conflicts": [],
  "prediction": {
    "schema_version": 1,
    "metric": "exposure_rate",
    "status": "baseline_insufficient",
    "acceptance_sha256": "0000000000000000000000000000000000000000000000000000000000000009"
  }
}
```

错误示例:`ratio_lo` 与 `ratio_hi` 在网格上相差 4 格(超过锐度上限 3)。

<!-- example:invalid schema=JudgeRecord -->

```json
{
  "hops": [{ "hop": "codex", "vendor": "openai", "model": "example-model-id", "result": "ok" }],
  "provider": "openai",
  "vendor": "openai",
  "verdict": "accept",
  "overfit_risk": "low",
  "injection_suspected": false,
  "conflicts": [],
  "prediction": {
    "schema_version": 1,
    "metric": "exposure_rate",
    "status": "predicted",
    "direction": "down",
    "ratio_lo": 0,
    "ratio_hi": 0.8,
    "confidence": 0.9,
    "acceptance_sha256": "0000000000000000000000000000000000000000000000000000000000000009"
  }
}
```

`JudgeOutput` 带 `prediction`。

<!-- example:valid schema=JudgeOutput -->

```json
{
  "verdict": "accept",
  "overfit_risk": "low",
  "generality": "high",
  "volatile": false,
  "conflicts": [],
  "injection_suspected": false,
  "notes": "ok",
  "prediction": { "direction": "down", "ratio_lo": 0.25, "ratio_hi": 0.8, "confidence": 0.7 }
}
```

错误示例:`direction=up` 但 `ratio_hi` 不大于 1.25(方向与区间矛盾)。

<!-- example:invalid schema=JudgeOutput -->

```json
{
  "verdict": "accept",
  "overfit_risk": "low",
  "generality": "high",
  "volatile": false,
  "conflicts": [],
  "injection_suspected": false,
  "notes": "ok",
  "prediction": { "direction": "up", "ratio_lo": 0.5, "ratio_hi": 1.25, "confidence": 0.7 }
}
```

`Attest` 带 `acceptance_sha256`。

<!-- example:valid schema=Attest -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "channel": "canary",
  "member": "@handle",
  "window_start": "2026-10-15",
  "window_end": "2026-10-21",
  "kit_version": "0.0.0",
  "collector_versions": { "claude": "2.1.280" },
  "sessions_total": 41,
  "exposure_sessions": 12,
  "exposure_projects": 3,
  "fired": 12,
  "harmful": 0,
  "recurrence": 0,
  "signal_ids_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006",
  "method": "signature_proxy_v1",
  "acceptance_sha256": "0000000000000000000000000000000000000000000000000000000000000009",
  "run_id": "run-0001"
}
```

错误示例:`acceptance_sha256` 不是 64 位小写十六进制。

<!-- example:invalid schema=Attest -->

```json
{
  "schema_version": 1,
  "rule_id": "negative-assertion-needs-positive-control",
  "rule_sha256": "0000000000000000000000000000000000000000000000000000000000000005",
  "channel": "canary",
  "member": "@handle",
  "window_start": "2026-10-15",
  "window_end": "2026-10-21",
  "kit_version": "0.0.0",
  "collector_versions": { "claude": "2.1.280" },
  "sessions_total": 41,
  "exposure_sessions": 12,
  "exposure_projects": 3,
  "fired": 12,
  "harmful": 0,
  "recurrence": 0,
  "signal_ids_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000006",
  "acceptance_sha256": "ABC",
  "run_id": "run-0001"
}
```

`KitConfig` 带 `acceptance_tile_days` / `acceptance_max_tiles`。

<!-- example:valid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["claude"] },
  "budget": {},
  "channels": {},
  "lifecycle": { "canary_window_days": 14, "acceptance_tile_days": 7, "acceptance_max_tiles": 4 }
}
```

错误示例:`canary_window_days=28`、`tile=7`、`max_tiles=4` 得 `ceil(28/7)+1 = 5 > 4`。

<!-- example:invalid schema=KitConfig -->

```json
{
  "kit": { "name": "agent-kit", "version": "0.0.0" },
  "agents": { "enabled": ["claude"] },
  "budget": {},
  "channels": {},
  "lifecycle": { "canary_window_days": 28, "acceptance_tile_days": 7, "acceptance_max_tiles": 4 }
}
```

### 18.9 G3 冻结核验、按块覆盖与 `attest --tile`(K4 实装,订正 §18.8 的 G3 部分)

实现:`src/guards/criteria.ts`(`textSince` / `locateFreezeCommit` / `verifyFreeze` / `frozenCountable`)、`src/lifecycle/attest-count.ts`(`acceptanceD0` / `tileWindow` / `classifyTile` / `requiredValidTiles`,**G3 与 `attest --tile` 共用同一组函数**)、`src/commands/attest.ts`。

**哈希口径(K3 写、K4 重算,必须一致)**:`sha256(canonicalJson(对象))`,canonicalJson 即 `src/io/canonical-json.ts`(键按码元序、2 空格缩进、LF、**含末尾换行**)。`acceptance.sha256` 的对象 = acceptance 去掉顶层 `sha256` 键后的全部字段;`signature_sha256` 的对象 = `{type, pattern?}`(无 pattern 则不带该键),原子无 signature 时对象 = `null`;`baseline_sha256` 的对象 = `reflector.guidance` 原样,旧暂存提案没有 guidance 时对象 = `null`。旧暂存提案缺 guidance 时 judge 写 `guidance_until = frozen_at`、`baseline_sha256 = sha256(canonicalJson(null))`、`prediction.status = baseline_insufficient`;没有 signature 的原子 `prediction.status = not_measurable`。

**T2(advisory→active)判据顺序**:T1 全部检查 → `SIGNATURE_MISSING` → `ADVISORY_SINCE_UNKNOWN` → `textSince`(`TEXT_SINCE_UNKNOWN`)→ 冻结核验 → attest 载入与 `frozenCountable` → 按块覆盖阈值。T1(proposed→advisory)不要求冻结。**没有回落旧口径的分支**:提案缺 `judge.acceptance` 即 `ACCEPTANCE_MISSING` 并停止(重跑 judge 补)。retire 的 `no_exposure` / `harmful` 理由**继续用原 `countable`**,不受冻结口径影响(退役是安全方向)。

**历史一律从基线(`baseOid`)取**,不从 head 取:PR 作者能用合并提交的父顺序操纵 head 侧的 `git log -- path` 历史简化(opus 咨询结论)。因此晋升 PR 不得改规则正文(基线与 head 的归一化哈希须相等,否则 `TEXT_SINCE_UNKNOWN`)、不得改 `judge.acceptance`(`ACCEPTANCE_CHANGED_AFTER_FREEZE`)和 `judge.prediction`(`PREDICTION_CHANGED_AFTER_FREEZE`)。

**冻结核验三层**(全部失败项一次性报出):

1. 内容哈希 → `ACCEPTANCE_HASH_MISMATCH`:重算 `acceptance.sha256`;`prediction` 必须存在且 `acceptance_sha256` 相等;`acceptance.rule_sha256 == judge.rule_sha256 == 当前原子哈希`;`signature_sha256` == 当前签名的哈希;`baseline_sha256 == guidanceSha256(reflector.guidance)`;有 guidance 时基线自洽(`exposure_sessions ≤ sessions_total`、`≤ fired`)且 `guidance.until == acceptance.guidance_until`。
2. git 锚点:冻结提交 = `fileHistory(baseOid, proposals/<id>.yaml)` 中「从最新开始、`judge.acceptance` 的 canonical JSON 连续等于当前值」的**最老**提交。须:有父提交(根提交 / 浅克隆边界 → `FREEZE_COMMIT_UNKNOWN`)、是基线祖先;`judged_at_head` 是冻结提交的**严格**祖先,且不早于提案上一版(冻结提交之前最近一次改提案的提交须是它的祖先,否则填个根提交就能满足祖先检查)→ 否则 `ACCEPTANCE_CLOCK_INCONSISTENT`(oid 不存在 / git 失败同码);冻结提交里的 prediction 与当前相等,否则 `PREDICTION_CHANGED_AFTER_FREEZE`;`guidance_until ≤ frozen_at`,且 `frozen_at` 的 UTC 日期 ≤ 冻结提交日期 + 1(`fileHistory` 只给提交者**本地**日期,容忍 1 天时区差)→ 否则 `ACCEPTANCE_CLOCK_INCONSISTENT`。
3. `ACCEPTANCE_WEAKER_THAN_CORE`:`tile_days <` 基线 `acceptance_tile_days`,或 `max_tiles >` 基线 `acceptance_max_tiles`(比 `baseView('kit.toml')` 的现值;core 调严后旧冻结须重跑 judge)。

**重跑 judge(同一份规则文本再冻结)不报错**,只记 warn `GUARD_G3_ACCEPTANCE_REFROZEN`(附次数):重跑后 D0 取新冻结提交,旧协议下的 attest 因 `acceptance_sha256` 不符自动不计入。残余风险:看了前几块结果后重跑 judge 可以换掉一个差的预测——K5a 的校准账对同一 `rule_sha256` 的每一份已冻结预测都应结算(至少取第一份),不能只看最新一份。

**D0 与分块**:`D0 = max(anchor_min, guidance_until 的次日, frozen_at 的次日, 冻结提交日期的次日)`(UTC 日历日;`anchor_min` 可被手改,所以其余纸面时钟各自参与取大);第 k 块 = `[D0 + k·tile_days, D0 + k·tile_days + tile_days − 1]`,`0 ≤ k < max_tiles`。

**`frozenCountable`**(在现有 `countable` 全部条件之上再加,不满足记 warn `GUARD_G3_ATTEST_NOT_COUNTED` 并附原因):`acceptance_sha256 ==` 冻结协议的 `sha256`;窗口恰为某个对齐分块;`window_start ≥ textSince`(当前规则文本首次进入基线历史的日期,取「连续等于当前哈希」的最老提交,X→Y→X 取最近一次回到 X;堵 F4);attest 文件首次入库提交以冻结提交为**严格**祖先;attest 首次入库的提交者日期 + 1 天 ≥ `window_end`(挡住预先提交未来窗口;提交者日期是作者可写数据,只挡诚实的误用)。

**按块覆盖**:一块**有效** = 该块有 ≥ `min_members` 名成员(小写去重)各交了一份计入的 attest,其中 ≥ `min_non_owner_members` 名非 owner。`有效块数 ≥ requiredValidTiles(canary_window_days, tile_days, extra)` = `ceil(canary_window_days / tile_days) + extra`,否则 `THRESHOLD_TILES`(**`extra` 默认 0,是 K5a 晋升加严的参数位**;K4 的 `promotion()` 只传默认值)。`exposure_sessions` 只在有效块上合计(`THRESHOLD_EXPOSURE`)。**偏离设计稿**:`harmful` 取全部计入的 attest 合计(`THRESHOLD_HARMFUL`),不只看有效块——无效块里的有害证据不能被静默丢弃。旧的 `THRESHOLD_WINDOW_DAYS` / `THRESHOLD_MEMBERS` / `THRESHOLD_NON_OWNER_MEMBERS` 在 T2 不再产出(被 `THRESHOLD_TILES` 取代);同成员同窗口取 run_id 最新、同成员窗口不重叠两条保留。

**`attest --tile <k> --freeze-date <YYYY-MM-DD>`**:读**工作树**里原子 `origin` 指向的提案的 `judge.acceptance`(须通过 `AcceptanceProtocolSchema`、自哈希自洽、`rule_sha256` 与当前原子一致),用与 G3 相同的 `acceptanceD0` / `tileWindow` 算第 k 块窗口并把冻结协议的 `sha256` 写入 attest 的 `acceptance_sha256`;`--tile` 与 `--window-start/--window-end` 互斥;窗口结束日 ≥ 今天(UTC)→ 退出 4 `tile_not_ended`;`k ≥ max_tiles` → 退出 2;冻结缺失 / 已过时 → 退出 1;提案不可读 / 协议损坏 → 退出 3。**不读 git**(验收 A22 要求本命令闭包不含 child_process),所以冻结提交日期由调用方经 `--freeze-date` 给(`git log -1 --format=%cs -- proposals/<id>.yaml`,须是冻结提交);给错只会算出 G3 判为不对齐的窗口,不会放宽任何判据。手填窗口时若工作树提案有匹配的冻结协议也会绑定 `acceptance_sha256`,读不到就不写(这样的 attest 不会被 G3 计入)。

**残余缺口(如实)**:提交者日期可伪造(既有 GD-3),git 锚点给的是相对主线合并顺序的保证;`judged_at_head` 只证明时序锚点,不证明 judge 真的在该提交上运行;`textSince` 在非线性历史(合并提交)下沿 `git log -- path` 的线性结果取值,属 GD-3 同类残余;`GuardGit` 接口未改,浅克隆靠「冻结提交无父提交」识别。

### 18.10 judge 校准与 ①B 晋升加严(K5a 实装,订正 §18.8 的 K5a 行)

实现:`src/lifecycle/calibration.ts`(`computeCalibration`)、`src/guards/criteria.ts` 的 `promotion()`(T2)。常量 `STRICT_EXTRA_TILES` / `CALIBRATION_MIN_N` / `CALIBRATION_GAP` 在 `src/contracts/config.ts`,**不进 `kit.toml`**(`[lifecycle]` 是 strictObject,写这些键即配置不合法)。

**账本**:**基线树**(`baseOid`)里每个 `proposals/<id>.yaml` 的**每一份**不同冻结协议(`judge.acceptance.sha256`;同一 sha 的连续版本算一份,最老的提交 = 冻结提交)。只读基线,PR(head)里新增或改动的提案、attest 一概不影响自己的校准。排除正在被判的提案(按**文件名里的 id**,含它的全部历史版本)。只统计 `prediction.status=predicted`;`baseline_insufficient` / `not_measurable` 不进分母,但要复核——`predicted` 与由 guidance(及能定位到、且签名哈希相符的原子签名)复算的状态不一致即损坏,防止手改 status 逃避结算。没有 `judge`、或 judge 没有 acceptance 也没有 prediction(K1 之前的旧记录)直接忽略。条目从**冻结提交**那一版读取 prediction / guidance / vendor / model;同一冻结协议的后续版本若这些内容与冻结时不同(冻结之后被改),算损坏。

**校准键(两档并集)**:`vendor`(`judge.vendor`,须等于最后一跳的 vendor)与 `vendor/model`(最后一跳的 model),小写去空白。任一档过度自信即加严。只用 `vendor/model` 的话,改 model 串(`hops[].model` 是自由串)就能拆成 n<10 的新键。

**结算(命中口径)**:取 `attest/<targets>/` 下 `acceptance_sha256` 等于该冻结协议 `sha256` 的 attest,并要求 canary 渠道、成员在基线 `kit.toml` 成员表内(不早于 `since`)、`rule_sha256` 等于 `acceptance.rule_sha256`、`method=signature_proxy_v1`、窗口经 `classifyTile`(D0 = `acceptanceD0(acc, 冻结提交日期)`)对齐、attest 首次入库的提交以冻结提交为严格后代、入库日期 + 1 ≥ `window_end`;同 (成员,窗口) 取 run_id 时间戳最新。一块**有效** = ≥`min_members` 名成员、其中 ≥`min_non_owner_members` 名非 owner(owner 取基线里 `id == target` 的原子;找不到时不排除任何人)。实测比值 `r = (Σexposure_sessions / Σsessions_total) ÷ (guidance.baseline.exposure_sessions / guidance.baseline.sessions_total)`,只在有效块上合计;**命中 ⇔ ratio_lo ≤ r ≤ ratio_hi**(闭区间,`"inf"` 无上界)。比较用整数交叉相乘(网格点写成有理数),不用浮点。

- **最新一份**:有效块数 ≥ `ceil(canary_window_days / tile_days)`(基线 `kit.toml`,**不含**加严的 extra)才算已结算,否则未结算、不进分母(只在 `CALIBRATION_INSUFFICIENT` 的消息里披露条数)。块齐了但 `Σsessions_total=0` → 无法算比值,按损坏处理(加严)。
- **被重跑 judge 取代的旧份**(同一提案文件历史上出现过多份冻结):**每一份都进账**,不能只看最新或只看第一份——作者可以在本机 `attest` 偷看数据(命令不读 git、数据不必入库),发现要失手就重跑 judge 换掉预测。取代它的提交日期 `< 该份 D0`(验收期还没开始,没有数据可偷看)→ 忽略;否则有效块 ≥1 按已有块结算,0 块**按失手计**。被取代的旧份仍用它自己的 `acceptance_sha256` 绑定的 attest,新协议下不再计入它们(这是 §18.9 既有行为)。
- 同一冻结协议出现在两个提案文件里(整块 judge 复制)→ 都算损坏,不去重(去重会吞掉真实的独立预测,而复制是明显的伪造信号)。

**判据**:`n ≥ CALIBRATION_MIN_N` 且 `平均置信度 − 命中率 ≥ CALIBRATION_GAP` → overconfident。置信度只有 0.5/0.7/0.9,按十分位整数算:`Σconf10 − 10·hits ≥ 2·n`,与 gap ≥ 0.20 严格等价,没有浮点边界(n=10:conf 0.9 时 7 命中恰好 gap=0.20 → 加严,8 命中 → 不加严)。

**T2 接入**:加严(过度自信 / 校准不可用 / 同键条目损坏)→ 所需有效块数 `requiredValidTiles(canary_window_days, tile_days, STRICT_EXTRA_TILES)`,否则 extra=0;不足报 `GUARD_G3_THRESHOLD_TILES`,消息写明是否因加严。若所需块数超过冻结协议的 `max_tiles`(分块序号 ≥ `max_tiles` 不被 `classifyTile` 接受,永远凑不够)→ 直接报 `THRESHOLD_TILES` 并写明须重跑 judge 重新冻结,**不削减 extra**。

| 码                                     | 严重度 | 含义                                                                                                                                 |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GUARD_G3_JUDGE_OVERCONFIDENT`         | warn   | 某档(vendor 或 vendor/model)n ≥ 10 且 gap ≥ 0.20,加严                                                                                |
| `GUARD_G3_CALIBRATION_INSUFFICIENT`    | warn   | 两档 n 都不足,**不加严**(消息附 n 与未结算条数)                                                                                      |
| `GUARD_G3_CALIBRATION_UNAVAILABLE`     | warn   | 全局计算失败(异常、git 失败、提案 yaml 解析不了、judge 读不出 vendor/model 无法归属键、基线文本与其历史不一致):**按过度自信加严**    |
| `GUARD_G3_CALIBRATION_ITEM_UNREADABLE` | warn   | 同 vendor 条目读不出 / 哈希不符 / 冻结后被改 / status 被改 / 重复冻结协议 / attest 读不出:**按过度自信加严**;别家 judge 的损坏不影响 |

**偏离设计稿的一处**:`Diagnostic.severity` 只有 `error` / `warn` 两级,设计稿的「info」用 `warn` 实现(同 `ATTEST_NOT_COUNTED`,不计入失败);四个码的 warn 本身不使 G3 红,红的是加严后的 `THRESHOLD_TILES`。fail-closed 的损坏路径用 warn 提示 + 实际加严,不单独报 error。

**残余缺口(如实,K5a 不解决,需披露)**:

- **选择偏差**:账本只含「judge 给了 accept、原子到了 advisory、canary 成员凑够有效块」的预测。reject / revise 的预测永远不结算;作者可以不收集数据让会失手的最新预测永远不结算(只在 `INSUFFICIENT` 消息里报未结算条数,**不**把过期未结算算失手,那样罚的是缺数据而不是判错)。这是**完成样本的校准**,不是全部冻结预测的校准。覆盖率(已结算 / 已冻结)应随报告披露。
- **删除**:账本只枚举基线树里现存的 `proposals/*.yaml`;先用内容 PR 删掉失手的提案再发晋升 PR,历史上的失手就出账了。K6 已补两道:`kit:reflector` PR 对已有 `proposals/**` 只许新增(`GUARD_PATH_PROPOSAL_DELETED` / `GUARD_PATH_PROPOSAL_MODIFIED`),无标签内容 PR 不得删除(`GUARD_PROPOSAL_DELETED_UNLABELED`),见 §12.3。残余:无标签内容 PR 仍可**修改**已有提案(含改已冻结的 judge 块;那由 K4 冻结核验兜住当前提案,但不影响别家提案的校准账),账本按历史索引仍未做。
- **稀释**:同 vendor 下用大量低置信度(0.5)、宽区间的预测稀释高置信度失手,压低平均置信度。未做「置信度 ≥0.7 子集再算一次」(偏离 §18.8 的口径,需用户决定)。新模型 / 冷门模型在两档都 n<10 时不会被加严。
- **时间边界**:「取代日期 < D0 忽略」依赖提交者日期(作者可写,GD-3 同类);`attest` 成员字段是自报的,非 owner 门槛可伪造(CODEOWNERS / 四眼);owner 取自基线现值。
- **冻结核验未逐条重做**:账本条目只核哈希自洽与「冻结后未改」,不重做 `judged_at_head` 祖先、时钟交叉(那是晋升该原子时 K4 的事)。
- **性能**:每次 T2 对同 vendor 的每个提案读全部历史版本与其 attest 的 git 历史(别家 vendor 的条目仅解析、不结算),提案多了会慢;超时 / 失败记 `CALIBRATION_UNAVAILABLE`(加严),不静默跳过。CI 须用完整历史(浅克隆 → 加严)。

#### K5b `agent-kit calibrate [--vendor <v>] [--json]`:校准账的只读报告

实现:`src/commands/calibrate.ts`;`src/lifecycle/calibration.ts` 只**追加**了输出字段(`seen`、`counts`)与 `calibrationStrictReasons`,G3 行为不变。目的:让维护者在晋升前看到「judge 过度自信吗、数据够不够」,以及这份账**测不到什么**。

- **读什么**:基线 = 仓库 `HEAD` 树(工作树里改过、删掉、未跟踪的文件一概不读)。先用空 target 调一次 `computeCalibration` 枚举出现过的全部 `(vendor, model)`(含被重跑 judge 取代的历史冻结、损坏条目),再对每个键各调一次;不排除任何提案(G3 T2 排除正在被判的提案,所以**这不是某次晋升的预演**:n=10 的边界上差一份就可能不同)。不新增任何阈值,`CALIBRATION_MIN_N` / `CALIBRATION_GAP` 只经 `judgeKeyStat` 使用。
- **输出**(全是整数 / 枚举 / id;`--json` 为 canonical JSON,无浮点;`*_permille` = ×1000 四舍五入,**只用于显示**,状态取自 `judgeKeyStat`):
  - 每个 vendor:`frozen`(该 vendor 的冻结条目总数)= `unreadable_items` + `baseline_insufficient` + `not_measurable` + `ignored_superseded` + `settled` + `unsettled`(互斥守恒);`coverage_permille` = settled/frozen;`superseded_counted_miss`(被取代、0 块按失手计)、`settled_conf_05/07/09`(已结算条目的置信度分布,看稀释);`unreadable_files`(去重的提案路径,不含原因文本);`g3_strict` + `g3_strict_reasons`(`overconfident|unreadable`,与 T2 同口径:该 vendor 下**任一** model 作为被判 judge 时会不会触发加严)。
  - 每个键(vendor、vendor/model 两档):`n`、`hits`、`sum_conf10`、`mean_conf_permille`、`hit_permille`、`gap_permille`、`status`(`insufficient|overconfident|ok`)。`ok` **只表示本档没触发 gap 判据**:`n` 小、覆盖率低时 `ok` 不代表校准良好,须与 `n`、`coverage_permille` 一起读。
  - 全局:`vendors_total`、`frozen_total`、`settled_total`、`coverage_permille`、`unsettled_total`;`--vendor` 过滤后的 `hidden_vendors` / `hidden_overconfident` / `hidden_unreadable_items` / `hidden_g3_strict`。
  - **盲区行(固定,总是输出)**:`selection_bias_settled_only`(只算已结算样本)、`coverage_settled_over_frozen`、`deleted_proposals_not_in_ledger`、`dilution_not_checked`、`time_boundary_committer_date`、`attest_member_self_reported`、`shallow_clone_or_root_commit_unavailable`(提案历史最老一条没有父提交即 UNAVAILABLE,空账时不触发;能力限制,不是「仓库是浅克隆」的探测)、`not_a_promotion_preview`。
- **`--vendor <v>`** 只过滤显示(`calibrationKeys` 归一化);盲区、全局计数、被隐藏部分的计数与退出码都不受影响。
- **退出码**:0 完成(有 overconfident / 损坏条目也是 0,只报告);2 用法(未知参数、`--vendor` 缺值或为空、`--run-llm` / `--allow-egress`,先于任何仓库访问);3 fail-closed(git 不可用、`HEAD` 解析不了、`kit.toml` 读不出、枚举调用或任一 vendor/model 的调用返回 `unavailable`):stderr `CALIBRATE_FAIL_CLOSED reason=CALIBRATION_UNAVAILABLE`(其余 `HEAD_UNRESOLVED` / `CONFIG_UNREADABLE` / `git_failed` / `internal`),stdout 只有 `ok=false`,**不**输出残缺的档位。
- **零写入零网络**:不写任何文件,import 闭包不含 `llm-exec` / `reflect/backends/**` / 网络模块(`test/commands/calibrate.test.ts` 静态检查);git 子进程带 `GIT_NO_LAZY_FETCH=1`(K6 起由共享入口 `createGuardGit` 统一设置,所有守卫 / 晋升 / 退役 / calibrate 的只读 git 都带;调用方 `extraEnv` 仍可覆盖,仅测试用)。

## 19. sync / doctor / update 命令面与自动更新契约(S0,契约先行;S1–S9 实装后订正)

本节先定死三条命令的命令面、退出码、稳定码、文件位置与授权边界,实现在后续块(S1–S8)。`sync` 已由 S4 实装(§19.2),`doctor` 已由 S5 实装(§19.3),`update` 的检查 / 安装 / 回滚本体已由 S7c-A 实装(§19.4),启动器、后台 worker、自动同步评估由 S7c-B 实装(§19.5–§19.7)。设计依据:`sync-doctor-update-design.md` §0–§6、§8;用户 2026-10-14 对 16 条决策的拍板(14 条按设计稿推荐,**② 改 B、⑭ 改 B**)。新增 schema 全部 `strictObject`,只追加;`contracts-v1` 既有编号不重排。

通用约定(沿用 §17 / §18):

- **默认干跑**,`--write` 才写。stdout 只含计数、枚举、id、哈希前缀、写死的受管相对路径;`--json` 为 canonical JSON、键集合固定。stderr 只含稳定码 `<CMD>_USAGE|CHECK_FAILED|NOT_RUN|FAIL_CLOSED reason=<码>`,不回显异常消息、文件内容、绝对路径、用户名。
- 数字参数用 `parseDecimalUint`(十进制非负整数,拒绝 `0x10`、`1e3`、`+5`、`-1`、空白)。
- 退出码沿用 §2,多结果用 `combineExitCodes`(3 > 2 > 1 > 4 > 64 > 0)。

### 19.1 决策取值对契约的影响

| 决策                 | 取值                                            | 落在契约的哪里                                                                                                                      |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ① payload 分发       | npm 包带预渲染 payload                          | `PayloadManifest` / `PayloadIntegrity`;`sync` 只从包内 payload 装,不在本机渲染                                                      |
| ② 规则是否自动生效   | **B**:`auto_sync` 默认 `"safe"`                 | `UserConfig.update.auto_sync` 取值 `off \| safe`(没有全自动档);条件见 §19.6;`KIT_AUTO_SYNC=0` 或配置 `off` 恒关闭                   |
| ③ CLI 本体自动安装   | 默认开                                          | `update.auto_install` 缺省 `true`                                                                                                   |
| ④ 安装机制           | `versions/<v>/` + `current` 软链 + 启动器       | `~/.local/share/agent-kit/`;exec 白名单条款见 §19.7                                                                                 |
| ⑤ 冷却期             | 24h                                             | `update.cooldown_hours` 缺省 24,范围 1..720;用 registry 的 `time[<v>]`,不用本机时钟                                                 |
| ⑥ 检查时机           | 交互式命令启动时,24h 节流,后台进程              | 不检查:`check` / `build`、`CI=true`、stdout 非 TTY、`KIT_AUTO_UPDATE=0`、`update.auto_install=false`、`KIT_LAUNCHED` 已设           |
| ⑧ sync 范围          | 只做 home 目标;默认 claude / codex / pi         | `DEFAULT_SYNC_AGENTS`;`--agent kimi\|opencode` 显式指定;project 目标 v1 不处理                                                      |
| ⑨ personal 层        | v1 不渲染                                       | 报告写 `skippedLayers: personal`;`PayloadManifest.skippedLayers`                                                                    |
| ⑩ 路径中间有符号链接 | 拒绝                                            | `SYNC_PATH_SYMLINK`(退出 3,整次不写)                                                                                                |
| ⑪ 与 skills-hub 同名 | 拒绝,不碰点开头条目,不写对方清单                | `SYNC_TARGET_FOREIGN`                                                                                                               |
| ⑫ 漂移               | 保留、跳过、退出 1;`--overwrite-drifted` 才覆盖 | `SYNC_DRIFTED`;覆盖前先备份;`SyncTxnOp.overwrote_drifted`                                                                           |
| ⑬ provenance         | 必须有,钉死 repo / workflow / tag ref           | `UPDATE_VERIFY_FAILED reason=provenance_missing\|provenance_identity\|bundle`                                                       |
| ⑭ 镜像 registry      | **B**:允许;来源证明一律到 npmjs 取              | `update.registry` 可配;attestations / provenance 主机固定 `registry.npmjs.org`,不可配;取不到 → 不自动装(`attestations_unreachable`) |
| ⑦ 首发前测更新       | `file://` 假 registry + rc 预发布               | 只经环境变量 `KIT_UPDATE_REGISTRY=file://…`,且路径必须在 `KIT_TMP` 内,否则 `UPDATE_USAGE reason=registry_fixture_outside_tmp`       |
| ⑮ 首次真 HOME 同步   | 假 HOME 全过且用户当场同意后                    | 流程约束,不进 schema                                                                                                                |

镜像规则(⑭B)的完整语义:packument 与 tarball 可取自 `update.registry`;但 ① tarball 的 sha512 必须等于 **npmjs** attestation 的 subject 摘要(镜像给的 `dist.integrity` 只作提示,不作依据);② provenance 的 repo / workflow / ref 钉死比对;③ 任一步从 npmjs 取不到 → 记 `attestations_unreachable`、不安装、退出 4,下一个窗口再试。镜像与 npmjs 版本不一致(镜像有、npmjs 无)按 `not_ready` 处理。

> **v3.1 修订(§21.18 第 6 条,V2 生效)**:① 的「`sync` 只从包内 payload 装,不在本机渲染」改为:sync 来源为 `package | local`,本机 payload 只由 kit 本机渲染(R21-8.1);⑨ 对包 payload 不变。② 仍只有 `off | safe`,条件见 §19.6 与其修订。

### 19.2 `sync`

```
agent-kit sync [--agent <id>]… [--write] [--overwrite-drifted] [--json] [--home <dir>]
               [--rollback <txn_id> | --resume | --uninstall | --adopt]
```

- **agent 集合**:缺省 `claude,codex,pi`。给了 `--agent`,集合恰为所列(可含 `kimi` / `opencode`;`openclaw` 或未知值 → `bad_agent`)。登记表条目的 `agents` 是各 agent 请求该路径的并集;按集合 A 计算的操作**不会删除**仍被 A 之外 agent 请求的条目,只把 A 从其 `agents` 里去掉。同一绝对路径(如 `.agents/skills/<name>/SKILL.md`)只写一次,各 agent 渲染出的 sha 不同 → `SYNC_SHARED_PATH_CONFLICT`。
- **模式互斥**:`--rollback <txn_id>` / `--resume` / `--uninstall` / `--adopt` 至多一个(`mode_conflict`);`--rollback` 必须带 `txn-…` 形式的 id。`--overwrite-drifted` 需要 `--write`(`overwrite_requires_write`)。
- **`--home <dir>`**:只接受真实 HOME 或 `KIT_TMP` 之内的目录,否则 `home_not_allowed`(退出 2)。
- **干跑输出**:每行 `would <op> ~/<受管相对路径> sha256=<前 12 位> agents=<a,b>`,末行 `plan create=N update=N remove=N block_upsert=N block_remove=N skip_drifted=N refuse_foreign=N`,另有 `skippedLayers personal`。干跑不写任何文件,也不建 `~/.local/state`。`--write` 后行首换成 `did`。
- **落点与识别**:以登记表(`~/.local/state/agent-kit/sync/ledger.json`,路径 + sha256)认定「我们写的」;独占头与托管块标记只作提示。owned 文件原子替换(同目录临时文件 → fsync → rename);托管块只改块体,块外字节不变;corrupt 块一律拒绝、绝不追加。
- **事务**:预检(逐段 `lstat`,符号链接 / 硬链接 / 非常规文件 / corrupt 块 → 整次不写)→ 写 `txn/<id>.json` 与 `backups/<id>/` → 逐文件写 → 最后写 `ledger.json` → 删 txn 文件。残留 txn → `SYNC_TXN_INCOMPLETE`,用 `--rollback` 或 `--resume`。备份保留最近 `SYNC_BACKUPS_KEPT`(5)个事务。**`backups/<txn_id>/` 必须同时保存:被改文件的写前全文、txn 描述的副本(`txn.json`)、写前登记表全文(`ledger.before.json`;写前没有登记表则写「不存在」标记,`SyncTxn.ledger_sha256_before = null`)**;成功只删 active journal(`txn/<id>.json`),不删这份备份。`--rollback` 在「每个文件当前 sha 等于该事务写入后的 sha、登记表当前 sha 等于该事务写入后的 sha」时,按先文件、后登记表的顺序恢复(登记表同样 tmp + fsync + rename);任一前提不成立 → `SYNC_ROLLBACK_MISMATCH`,整次不写。
- **幂等**:第二次 `--write` 计划为空,零操作、零 mtime 变化(按内容 sha 比,不看 mtime)。
- **`--uninstall`**:同样受 agent 集合约束——只去掉所选 agent 的请求;一个条目的 `agents` 去掉后为空,才删除该登记过且未漂移的独占文件 / 托管块(`created_file=true` 且删块后只剩空白的文件一并删除);仍被其它 agent 请求的条目与文件原样保留。漂移而保留下来的条目**保留其登记信息**,不丢所有权。只有登记表的所有条目都已安全移除时才删登记表。不带 `--agent` 即默认集合 `claude,codex,pi`;全部 agent 的条目都装过时,用 `--agent` 列全才能卸干净。装 → 卸(同一 agent 集合)之后受管路径树哈希与装之前逐字节一致。
- **`--adopt`**:登记表丢失时,只认领「内容 sha 等于某个已知 payload 版本里同路径文件 sha」的文件。
- **永远不碰**:`~/.claude/CLAUDE.md`、`settings*.json`、hooks、`~/.codex/config.toml`、点开头的条目(`.social-hub-skills.json` 等)、登记表里没有的条目、`.json` 文件。
- **启动提示**:交互式命令启动时,payload 与登记表有差异则 stderr 一行 `SYNC_PENDING add=N update=M remove=K`(退出码不受影响)。

退出码:

| 码  | 含义                                                                                           |
| --- | ---------------------------------------------------------------------------------------------- |
| 0   | 完成或无变更                                                                                   |
| 1   | 有漂移被跳过、有外来冲突被跳过、owned 目录里有非登记条目(其余条目照常处理)                     |
| 2   | 用法错误                                                                                       |
| 3   | fail-closed:预检被拒、写出口拒绝、残留事务、登记表 / payload 损坏、回滚前提不成立;**整次不写** |
| 4   | 未执行:没有 payload(未构建或包残缺)、sync 锁被占                                               |

稳定码(`SYNC_<类别> reason=<码>`):

- 用法(2):`mode_conflict`、`missing:--rollback`、`bad_txn_id`、`bad_agent`、`home_not_allowed`、`overwrite_requires_write`、`unknown_arg`。
- 检查失败(1):`SYNC_DRIFTED`、`SYNC_TARGET_FOREIGN`、`SYNC_UNMANAGED_IN_OWNED_DIR`。
- 未执行(4):`SYNC_NO_PAYLOAD`、`SYNC_LOCKED`。
- fail-closed(3):`SYNC_TXN_INCOMPLETE`、`SYNC_PATH_SYMLINK`、`SYNC_PATH_HARDLINK`、`SYNC_PATH_NOT_REGULAR`、`SYNC_BLOCK_CORRUPT`、`SYNC_SHARED_PATH_CONFLICT`、`SYNC_LEDGER_INVALID`、`SYNC_PAYLOAD_INVALID`、`SYNC_ROLLBACK_MISMATCH`、`SYNC_WRITE_DENIED`。
- fail-closed(3,S4 追加):`SYNC_MIGRATION_UNSUPPORTED`(v1 不执行 migrations,见 §19.2.1;命令层常量 `SYNC_MIGRATION_UNSUPPORTED`,尚未进 `SYNC_FAIL_CLOSED_REASONS`,待主代理在契约 schema 里补)。
- 提示(不改退出码,仅 stderr,S10-a 追加):`SYNC_STATE_DIR tightened|would_tighten from=<nnnn> to=0700`、`SYNC_STATE_DIR_SKIPPED reason=link_or_not_dir|foreign_owner`,见 §19.2.2。

#### 19.2.1 S4 实装订正(sync 执行层与命令层)

**S3 计划器的决策(实装时确认,写进契约):**

- 用户删了登记过的文件:`sync` 会把它**重建**(登记表里有、磁盘上没有 → create),不当作「用户有意删除」。要彻底不要,用 `--uninstall`。
- 登记表表头(`kit_version` / `payload_sha256`)**只在本次没有任何提示项**(漂移 / 孤儿 / 独占目录非登记文件 / 外来冲突)时刷新;有提示项时表头保持旧值,避免「已同步到新版」的假象。
- 外来文件(磁盘上已有、登记表里没有)的内容**恰好等于** payload 也拒绝(`SYNC_TARGET_FOREIGN`),除非 `--adopt`;条目目录(如 `.agents/skills/<name>/`)已被别人占用、但目标文件不在,同样算外来。
- 托管块目标:文件存在但还没有该 id 的块 = 正常首装(追加,`created_file=false`);块 `corrupt` 一律整次拒绝,不追加。

**payload 与 migrations:**

- payload 位置:包根(本模块往上第一个含 `package.json` 的目录)下的 `payload/manifest.json` + `payload/files/…` + `integrity.json`。环境变量 `KIT_PAYLOAD_DIR`(经 `ctx.env` 注入,命令层不读 `process.env`)指向「含 `payload/` 与 `integrity.json` 的目录」,**只在它严格位于 KIT_TMP 之内时生效**,否则忽略;仅测试夹具使用。
- 使用前逐文件核对:`integrity.json` 必须存在且过 schema,必须列出 `payload/manifest.json` 与 manifest 声明的每个 `payload_path` 文件,sha256 与字节数一致,`kit_version` 与 manifest 一致;任一不满足 → `SYNC_PAYLOAD_INVALID`(退出 3)。`payload/` 目录整体不存在 → `SYNC_NO_PAYLOAD`(退出 4)。`--uninstall` / `--rollback` / `--resume` 不需要 payload。
- **v1 不执行 migrations**:`payload.migrations` 非空时,`sync`(含 `--adopt`,不含 `--uninstall`)退出 3 `SYNC_MIGRATION_UNSUPPORTED`,整次不写,stdout 为空。`rename_block` 的语义留到 v2(需要先定:新旧块 id 同时存在时谁赢、漂移判定、回滚怎么记)。

**命令输出:**

- 干跑 / 写入行:`would|did <op> ~/<受管路径> sha256=<前12位> agents=<a,b>`,托管块操作末尾加 ` block=<id>`;整次被拒时行首为 `refused`;sha 取写后(create/update/block_upsert)或写前(remove/block_remove),跳过 / 拒绝类为 `-`。末尾 `plan create=… refuse_foreign=…`(契约字段)、`plan_other adopt=… orphan_keep=… unmanaged_keep=… refuse_all=…`、`skippedLayers personal`。
- 路径只在落入 `HOME_WRITE_TABLE` 且为可见 ASCII 时原样输出,否则 `~/<path>`;独占目录里的非登记文件**不输出文件名**,只给 `unmanaged_keep ~/.claude/rules/agent-kit/ count=N`。
- 写入成功后末行 `txn <id>`(只改登记表 / 无操作时没有)。`--json` 键集合固定:`mode, dry, status, exit, ops[{op,path,block_id,sha256_12,agents,code}], summary, ledger, skippedLayers, txn, files`;`--rollback` / `--resume` 各有自己的固定键集。

**事务落盘布局(`~/.local/state/agent-kit/sync/`,目录 0700、文件 0600):**

```
ledger.json                     登记表(canonicalJson)
lock                            {pid, started_at, nonce}
txn/<id>.json                   active journal;存在 = 事务未收尾;phase: planned → backed_up → writing → ledger_written
backups/<id>/txn.json           事务描述副本(成功后保留)
backups/<id>/files/<HOME 相对路径>      被改文件的写前全文(写前不存在则无)
backups/<id>/after/<HOME 相对路径>      写后全文(让 --resume 不依赖 payload)
backups/<id>/modes.json         写前权限位
backups/<id>/ledger.before.json | ledger.before.absent
backups/<id>/ledger.after.json | ledger.after.delete | (都没有 = 登记表不变)
backups/<id>/complete           备份写完的标记(缺失则 --resume 拒绝)
```

顺序:预检(计划器 `refuse-all` 则整次不写)→ `txn/<id>.json`(planned)→ `backups/<id>/**`(最后写 `complete`)→ phase=backed_up → phase=writing → 逐文件(路径升序;写前**复核当前 sha 等于 txn 记录的写前 sha**,不等 → `SYNC_WRITE_DENIED`,整次停止,journal 残留)→ `ledger.json`(写 / 删)→ phase=ledger_written → 删 journal → 修剪备份。只改登记表(`--adopt`、仅 agents 变化)时不开事务,单文件原子替换。

- **文件权限**:更新已有文件保留其权限位;新建文件 0644;状态目录与状态文件 0700 / 0600。`modes.json` 让回滚重建被删文件时沿用原权限位。
- **托管块操作的 txn shaBefore / shaAfter 是整文件 sha**(计划器给的是块体 sha;执行层先算出写后全文再填)。
- **幂等运行不拿锁**:`--write` 先无锁规划,计划为空(无写操作、登记表不变)直接返回,零写入、零 mtime 变化(含目录项);有东西要写才拿锁,并在锁内重新读登记表 / 磁盘、重新规划。
- **锁**:`sync/lock`,pid + 开始时间 + nonce;持锁进程还在 → 退出 4 `SYNC_LOCKED`(超过 15 分钟 TTL 也只报不杀);进程已不在或内容损坏 → 回收。S7c-B 起 sync 锁与 update 锁同用 `createExclusive`(见 §19.5);回收协议本身仍**不是严格互斥**(两个回收者先后删除的竞态靠提交点前 `assertHeld` 复核 nonce 兜底)。K6 补齐 `assertHeld` 覆盖:`--rollback`、`--resume`、仅改登记表的 `applyPlan` 路径此前拿了锁却不复核,现与常规 sync 一样在每个写出口前复核;另在写备份前、journal 状态推进前、删 journal 前、修剪备份前也复核(`test/sync/lock-lost.test.ts`)。
- **`--resume`**:恰好一个残留 journal 且 `backups/<id>/complete` 在,才继续;每个文件当前 sha 必须等于写前或写后(写后的跳过),否则 `SYNC_TXN_INCOMPLETE`;写完后登记表、删 journal、修剪备份。不需要 payload。没有残留事务时是空操作(退出 0)。
- **`--rollback <id>`**:id 是残留事务(放宽:每个文件当前 sha 等于写前**或**写后,写后的还原;登记表同理)或已收尾事务(严格:每个文件与登记表当前 sha 都等于该事务写入后的 sha)。任一前提不成立,或备份缺失 / 内容 sha 对不上 → `SYNC_ROLLBACK_MISMATCH`,整次不写。回滚本身是一个有 journal 与备份的事务(`action=rollback`,可再回滚);先文件后登记表。回滚残留事务成功后删除该事务的 journal。
- **备份保留**:成功后只保留 id 最大(时间最新)的 `SYNC_BACKUPS_KEPT`(5)个 `backups/<id>/`;有 journal 的事务永不修剪。
- **卸载时块的删除**:块的删除是追加的逆操作——块在文件尾、前面是追加时加的空行分隔时拿掉那一个分隔换行。原文以单个 `\n` 结尾(含空文件、`created_file` 文件)的文件**逐字节还原**;原文无结尾换行或以多个空行结尾的文件会差一个换行(已知残余;要精确还原用 `--rollback`)。
- **sync 隐式创建的目录**:`home-fs` 写文件时隐式创建缺失的父目录;卸载 / 回滚删文件后,沿父目录向上 `removeDir` 空目录,止于 home-fs 的目录条目边界——能删的是严格位于条目内部的目录(如 `.claude/skills/<name>/`、`.agents/skills/<name>/`、`.claude/rules/agent-kit/paths/`)。**条目目录本身及其上级**(`.claude`、`.claude/skills`、`.claude/rules`、`.claude/rules/agent-kit`、`.codex`、`.codex/agents`、`.pi`、`.pi/agent`、`.agents`、`.agents/skills`、`.local/state/agent-kit/**` 等)home-fs 不允许删除,装 → 卸之后会留下**空目录**。条目目录可安全推定为 sync 所建:目录已存在而目标文件不在 → 计划器按外来拒绝,所以我们登记的文件所在的条目目录必为我们创建(用户后来往里放了文件则 `rmdir` 失败、原样保留)。
- **「装 → 卸后受管路径树哈希逐字节一致」的判据**(S8 的 A25 同此):比较「文件集合(相对路径 + 权限位 + 内容 sha256)」,忽略状态目录 `.local/state/agent-kit/**`(含 `backups/`,它保存着可回滚的写前全文);目录只要求「新增的目录全是空目录」。即:不含空目录的文件树逐字节一致。

#### 19.2.2 状态目录收紧(S10-a,D14 的处置;零写入口径里允许的唯一一处目录权限例外)

用户拍板:真实 HOME 下 D14 报 `mode_not_0700` 时,处置方式是 **sync 自动把状态目录收紧到 0700**;doctor 本身仍只读、只报告。

- **对象**:只有 `~/.local/state/agent-kit` 这一层(kit 自己拥有的状态目录),不碰其上级(`.local`、`.local/state`)、兄弟目录或目录里的任何文件。
- **条件**:权限位含任一组 / 其他位(`mode & 0o077 != 0`,即宽于 0700)才动,目标恒为 `0700`。已是 0700 不动;窄于 0700 且无组 / 其他位的(如 0500)不改,仍由 D14 `mode_not_0700` 报告。
- **不改并告警(不静默)**:任一路径段是符号链接或不是目录 → `SYNC_STATE_DIR_SKIPPED reason=link_or_not_dir`(实际上命令层更早的 `SYNC_PATH_SYMLINK` fail-closed 已先拦下,退出 3);属主不是当前用户 → `SYNC_STATE_DIR_SKIPPED reason=foreign_owner`。chmod 走 `O_NOFOLLOW|O_DIRECTORY` 的 fd 并核对 dev:ino 与 lstat 一致。
- **何时**:`sync` / `--adopt` / `--uninstall` 且计划 `status=ok` 时。`--write` 才改(幂等运行、无其它变更也会收紧);`--rollback` / `--resume` 不收紧。计划 `refuse-all`(退出 3)/ `not-run`(退出 4)时不写;`status=ok` 但有外来文件被跳过(退出 1)属部分执行,照常写入与收紧。
- **干跑**:不改(计划被拒时干跑仍会报告该目录的状态),只在 stderr 报 `SYNC_STATE_DIR would_tighten from=0755 to=0700`;写入后报 `SYNC_STATE_DIR tightened from=0755 to=0700`。**stdout 与 `--json` 的固定键集合不变**。
- **零写入口径**:这是 §12.1 / A5 零写入验收里允许的一处例外:仅限 `sync --write`、仅限状态目录自身的 mode 位;干跑与 doctor 仍零写入。幂等:收紧后重复 sync 不再有任何写入或输出。
- **写出口**:`src/io/home-fs.ts` 的 `tightenKitStateDir`,命令层经 `src/sync/apply.ts` 的 `tightenStateDir`;测试 `test/sync/state-dir-tighten.test.ts`。

### 19.3 `doctor`

```
agent-kit doctor [--json] [--only <id>]… [--online] [--home <dir>]
```

**默认零写入、零网络**(进 A5 命令清单)。实现(S5):`src/doctor/{types,checks,collect}.ts` + `src/commands/doctor.ts`;检查是纯函数,探测层只用只读 API,不 import `src/io/net.ts` / home-fs / 子进程(静态闭包里的 `safe-fs` 仅经 S4 既有链 `payload-load → build/payload → render/out-layout` 进入,行为上零写入由快照测试证明)。`--home` 同 `sync`:只收真实 HOME 或 KIT_TMP 之内(否则退出 2 `home_not_allowed`)。

**`--online`(S5 订正)**:本块不实现联网。传了 `--online` 且选中 D12 时,D12 记 `n_a`(`online_unavailable`)、stderr 一行 `DOCTOR_ONLINE_UNAVAILABLE`、退出 4;S7c 之后再接「多读一次 registry、不写缓存」。不影响其它检查。

输出只含 id、枚举、计数、版本号、sha 前缀与写死的受管相对路径(`~/<HOME 写入表内路径>[#块id]`);不含文件内容、摘录、绝对路径、用户名。每个检查固定六个键 `id` / `status`(`ok | warn | fail | n_a`)/ `result`(该检查自己的枚举)/ `counts` / `facts` / `items`;`--json` 为 `{schema_version, summary, checks[]}` 的 canonical JSON(`checks` 恒 16 项、按 id 升序,`--only` 时只含所选)。终端另有一道泄漏闸:输出里若出现 HOME / KIT_TMP / 状态目录 / 仓库根的绝对路径,整份输出作废,退出 3 `DOCTOR_FAIL_CLOSED reason=output_leak`。

| id  | 检查                                                                                                                                           | `result` 取值(括号内为 `status`)                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | 运行时 node ≥ 22;启动器状态(bootstrap 版本 / current 版本 / 是否正在用 current;启动器未安装按 `not_installed`)                                 | `ok`(ok)、`node_too_old`(fail)、`launcher_broken` / `current_unrecorded`(warn)                                                                                            |
| D02 | 安装完整性:current 逐文件 sha 对照 `integrity.json`;`integrity.json` 自身对照 `state.json` 的外部锚点                                          | `no_current`(n_a)、`ok`、`extra_files`(warn)、`current_unsafe` / `integrity_missing` / `integrity_invalid` / `file_mismatch` / `anchor_missing` / `anchor_mismatch`(fail) |
| D03 | payload manifest 可解析、逐文件 sha 一致                                                                                                       | `no_payload`(n_a)、`ok`、`payload_invalid`(fail)                                                                                                                          |
| D04 | 登记表存在、可解析、无残留 txn                                                                                                                 | `ok`、`not_installed`(warn)、`ledger_invalid` / `txn_residual`(fail)、`ledger_unreadable`(fail,退出 3)                                                                    |
| D05 | 每个登记条目:ok / drifted / missing / path_symlinked / hardlinked 计数(另有 `not_regular`、`block_corrupt` 两个键)                             | `no_ledger`(n_a)、`ok`、`issues`(drifted / 链接 / 非常规 / 块损坏 → fail;只有 missing → warn)                                                                             |
| D06 | 托管块:intact / drifted / corrupt / missing 计数(登记表块 ∪ payload 将装的块;后者只有 corrupt 才计)                                            | `no_blocks`(n_a)、`ok`、`issues`(drifted / corrupt → fail;missing → warn)                                                                                                 |
| D07 | 待同步:会新增 / 更新 / 删除几项(默认同步集合 ∪ 登记表里出现过的 agent,经 `planSync`)                                                           | `no_payload`(n_a)、`in_sync`(ok)、`pending`(warn)、`blocked`(fail:计划整次被拒,`items` 为稳定码)                                                                          |
| D08 | 外来冲突计数与条目 id(同一份计划)                                                                                                              | `not_evaluated`(n_a)、`ok`、`unmanaged_only`(warn)、`foreign`(fail)                                                                                                       |
| D09 | 遮蔽:`AGENTS.override.md`、`PI_CODING_AGENT_DIR`、claude 用户级 rules 加载(P-Q1 仍为 assumed)                                                  | `ok`、`shadowed` / `assumed`(warn;只有计划 / 登记表里有 `.claude/rules/agent-kit/` 文件时才 assumed)                                                                      |
| D10 | 预算:按**落盘后的整个文件**(现有内容与 payload 托管块合并之后)算 codex / pi 字节数,对照 `kit.toml`                                             | `nothing_measured`(n_a)、`ok`、`warn`(超 `max_bytes` 或达到阈值)、`over`(fail:超过数字型 `hard_limit`)                                                                    |
| D11 | 探针:payload 里带 `conditional` 的文件个数;各 agent `tested_versions` 是否为空                                                                 | `ok`、`untested`(warn:在用的 agent 为空)、`pending_probes`(warn)                                                                                                          |
| D12 | 更新:开关、pin、上次检查时间与结果码、可用版本、锁、残留 staging、`max_seen_version`、registry 是否镜像(只读 `state.json` 与 `config.toml`)    | `no_state` / `online_unavailable`(n_a)、`ok`、`last_check_failed` / `staging_residue` / `update_available`(warn)、`state_unreadable`(fail,退出 3)                         |
| D13 | hook:套件目前不渲染 hook,恒 `n_a`                                                                                                              | `no_hook_rendered`(n_a)                                                                                                                                                   |
| D14 | 状态目录权限:`~/.local/state/agent-kit` 为 0700、非链接、属主为当前用户(doctor 只读只报;`sync --write` 会把宽于 0700 的收紧到 0700,见 §19.2.2) | `absent`(n_a)、`ok`、`mode_not_0700` / `foreign_owner`(fail)、`link_or_not_dir`(fail,退出 3)                                                                              |
| D15 | LLM 门:`egress` 取值、`allow_unverified` 槽位数、今日冷却标记数(只读覆盖层与 `.state/llm-cooldown/`,不清扫过期标记)                            | `no_overlay`(n_a)、`ok`、`egress_on` / `allow_unverified` / `overlay_invalid`(warn)                                                                                       |
| D16 | 最近一次自动同步记录(`UpdateState.last_auto_sync`:outcome、原因码、计数)——② B 追加                                                             | `none`(n_a)、`applied`(ok)、`declined` / `failed`(warn)、`state_unreadable`(fail,退出 3)                                                                                  |

D05 / D06 复用 S3 的 `preflightEntry` / `currentOf`,D07 / D08 直接用 `planSync` 的计划,不另写第二套漂移判定(`test/doctor/consistency.test.ts` 与卸载模式计划对拍)。

退出码:0 = 只有 ok / warn / n_a;1 = 有任一 `status=fail`(drifted / corrupt / over 等),stderr 逐项 `DOCTOR_CHECK_FAILED check=<id> result=<码>`;2 = 用法错误(`DOCTOR_USAGE reason=unknown_arg|bad_check_id|home_not_allowed`);3 = doctor 自身 fail-closed(`DOCTOR_FAIL_CLOSED reason=state_unreadable|state_dir_unsafe|output_leak`:状态目录路径上有符号链接 / 不是目录 → `state_dir_unsafe`,此时 D04–D08、D12、D16 不读,记 `skipped_state_unsafe` 且仍退出 3,不因 `--only` 被放过;`state.json` / 登记表存在但读不了 → `state_unreadable`);4 = 用了 `--online`(`DOCTOR_ONLINE_UNAVAILABLE`,只影响 D12)。多项用 `combineExitCodes`(3 > 2 > 1 > 4 > 0)。

### 19.4 `update`

```
agent-kit update [--write] [--now] [--major] [--rollback] [--json] [--home <dir>]
```

- **默认干跑**:读一次 registry(只读网络请求),打印会装哪个版本、被哪条策略挡住;不写任何文件(不建状态目录、不记 `last_check_at`)。`--write` 才安装 / 回滚 / 记录检查结果。stdout 为 `current / channel / target / decision <码>[ detail=…][ remaining_hours=N]` 与 `would install <v>`(`--json` 为 canonical JSON,键固定:`mode, dry, channel, current, target, decision, detail, cooldown_remaining_hours` 及安装后的 `installed, anchor, gc_removed, gc_failed`);安装成功多一行 `installed <v>` 与锚点前 12 位。
- `--home <dir>`(S7c-A 追加,与 `sync` / `doctor` 同):只接受真实 HOME 或 `KIT_TMP` 之内的目录,否则 `UPDATE_USAGE reason=home_not_allowed`;`config.toml` / 状态 / 安装目录 / TUF 缓存都在该 HOME 下。
- `--now`:本次忽略冷却期,其余校验(sha512、provenance、防降级、同 major)照旧。`--major`:允许跨 major,需要 `--write`(`major_requires_write`)。`--rollback`:把 `current` 切回保留的上一版本并记入 `bad_versions`,需要 `--write`(`rollback_requires_write`);只能切到本地保留的版本。
- **环境来源(S7c-B 订正 S7c-A 的接线缺口)**:真实入口 `main(argv)` 不注入 `env`,命令上下文里没有 `ctx.env`;`update` 命令与 worker 在 `ctx.env` 缺省时改从进程环境取**收窄的具名键**(`RUN_SELF_ENV_PICK_RE`:`KIT_UPDATE_*`、`KIT_AUTO_*`、`KIT_TMP`、CI 变量、代理变量等,见 §19.7),此前这些变量在真实 CLI 里不生效。
- 内部入口 `agent-kit __update --background`(后台 worker,S7c-B 实装于 `src/update/worker.ts`,由 `src/cli.ts` 单独识别,不在 `COMMANDS`、不进 `--help`;只接受这一个精确形状,别的参数退出 2)不属于公开命令面;stdio 丢弃,日志只记稳定码(`update/log` 一行最近结果:`ok|skipped_gate|skipped_throttled|skipped_locked|failed`)。
- 退出码:0 已最新 / 计划已打印 / 已安装 / 被策略挡住(`cooldown`、`pinned`、`major_available`、`deprecated`);1 校验失败(`UPDATE_VERIFY_FAILED`)、防降级拒绝(`UPDATE_DOWNGRADE_REFUSED`);2 用法错误;3 fail-closed(状态目录不安全、状态 / 配置损坏、写出口拒绝、`current` 损坏);4 未执行(网络不可用 `UPDATE_CHECK_FAILED`、`UPDATE_NOT_READY`、`attestations_unreachable` / `trust_root_stale` / `tuf_unreachable`、锁被占 `UPDATE_NOT_RUN reason=locked`、没有可回滚版本 `UPDATE_NOT_RUN reason=no_previous|previous_missing`)。
- **实装(S7c-A)**:`src/update/{install,registry}.ts` + `src/commands/update.ts`。配置读 `~/.config/agent-kit/config.toml`(只读,损坏 → 退出 3 `config_invalid`),环境 `KIT_UPDATE_REGISTRY` / `KIT_UPDATE_PIN` 优先(`KIT_UPDATE_PIN` 非法 → 退出 3 `bad_pin`)。`KIT_UPDATE_REGISTRY` 可为 https registry 或 `file://<KIT_TMP 内目录>` 夹具(布局见 `src/update/registry.ts` 文件头)。`--write` 且策略放行时:拿 `update/lock` → **锁内重读状态与 packument、重新做一次 `decideUpdate`**(含该版本仍存在、未 deprecate)→ 安装;非安装的 `--write` 只拿锁记一次 `recordCheck`(锁被占就不记)。
- `--rollback --write`:零网络,锁内执行;`state.previous` 必须存在,`versions/<previous>` 必须通过**完整树校验**(`integrity.json` 的 sha256 等于 `previous.anchor`、`kit_version` 一致、树内无符号链接 / 特殊文件、文件集合与 `integrity.files` 严格相等、逐文件 sha256 + 字节数),否则不切(退出 3 `UPDATE_CURRENT_BROKEN` + `previous_invalid`)。成功后 `installed ← previous`、`previous` 清空、被回滚的版本进 `bad_versions`、`max_seen_version` 不降。回滚不做 gc(被回滚的版本留到下一次安装时清)。

稳定码:`UPDATE_USAGE`(`mode_conflict`、`major_requires_write`、`rollback_requires_write`、`bad_registry`、`registry_fixture_outside_tmp`、`unknown_arg`)、`UPDATE_CHECK_FAILED reason=<timeout|dns|connect|tls|http_<码>|too_large|parse|proxy|not_ready|attestations_unreachable>`、`UPDATE_VERIFY_FAILED reason=<integrity|provenance_missing|provenance_identity|bundle|attestations_unreachable|trust_root_stale|tuf_unreachable>`(后两者不进 `bad_versions`:问题在本地信任根 / TUF 网络,不在该版本;doctor 提示重装 bootstrap 或检查代理)、`UPDATE_DOWNGRADE_REFUSED`、`UPDATE_MAJOR_AVAILABLE`、`UPDATE_CURRENT_BROKEN`、`UPDATE_NOT_READY`、`UPDATE_FAIL_CLOSED`、`UPDATE_NOT_RUN`(S7c-A 追加:`locked` / `locked_over_ttl` / `deprecated` / `no_previous` / `previous_missing`)、`SYNC_PENDING`、`AUTO_SYNC_DECLINED`。失败原因绝不合并成一个笼统的码,也不吞(Hub 的教训)。

`UPDATE_USAGE` 另追加 `home_not_allowed`。`UPDATE_VERIFY_FAILED reason` 在原有取值之外追加(S7c-A):`trust_root_stale`、`tuf_unreachable`、`tar`(签名通过的 tarball 解包被严格 tar 读取器拒绝,`TAR_*` 细分只留在内部)、`package`(包内 `integrity.json` / `package.json` 与 tarball 不一致)、`smoke`、`host_denied`(镜像给的 tarball 地址不在允许主机内)、`bad_version`(干跑:目标已在 `bad_versions`)、`internal`(不认识的异常)。`last_result` 追加 `trust_root_stale`、`tuf_unreachable`、`deprecated`、`internal`、`rolled_back`。

**进不进 `bad_versions`(S7c-A 订正,取代 §19.5「任一校验失败 → 进 bad_versions」的笼统写法)**:只在「已认证的证据表明这个版本本身坏了」时拉黑。进:`provenance_identity`、`bundle`(验签器报告签名 / 证明无效)、`tar`、`package`、`smoke`(验签已通过,内容不一致或装不起来)、非镜像下 tarball 摘要与 `dist.integrity` 或已验签 subject 不符(`integrity`)、`provenance_missing`(版本发布已满 24 小时仍没有 SLSA 条目)。**不进**:`attestations_unreachable`、`trust_root_stale`、`tuf_unreachable`、网络类、本机 IO 错误 / 写出口拒绝、**镜像模式下** tarball 与已验签 subject 不符(镜像可以给垃圾,不能借此冻结真版本)、不到 24 小时的 `provenance_missing`(npm 半可见期,按 `not_ready`)、`internal`(验签器抛 `TypeError` / `RangeError` / `ReferenceError`:更像我们或依赖的缺陷,而不是 bundle 残缺的证据)、`deprecated`。

### 19.5 自动更新规则

- **节流**:24h 一次(`UPDATE_CHECK_INTERVAL_HOURS`);时钟往回走视为该检查了。时钟只决定检查频率,任何安全判断都不依赖本机时钟。
- **网络**:`GET <registry>/@chovizzz%2fagent-kit`(请求头 `Accept: application/json`,取完整 packument 而非精简版,否则没有 `time`),超时 5s、响应 ≤ 2MiB、不跟随跨主机重定向;主机白名单 = 配置的 registry 主机 + `registry.npmjs.org`。网络只经 `src/io/net.ts`。失败 TTY 下每天最多一行 `UPDATE_CHECK_FAILED reason=<码>`。
- **冷却期的时间来源**:`age = 响应 Date 头 − time[<v>]`,**两者都取自 npmjs 的 packument 响应**(用镜像时也到 npmjs 取;镜像的 `time` 与 `Date` 不作依据),**不用本机时钟**。冷却期起点取 `max(npmjs time[<v>], 已验签 SLSA bundle 的 Rekor integratedTime)`(决策 ㉔;integratedTime 由 Rekor 的 SET 背书,registry 一侧改不早它;没有 SET 背书时不取);`Date` 头缺失 / 不可解析、`time[<v>]` 缺失、或 `age < 0`,一律按「未满冷却期」处理(`cooldown`,fail-closed 不安装)。本机时钟只用于检查节流。
- **版本选择**:取 `dist-tags.<channel>`(通道名:稳定 `latest`,预发布 **`rc`**——release.yml 把预发布发到 dist-tag `rc`,设计稿旧称 `next` 作废;`UPDATE_CHANNELS` 已于 S7c-A 订正为 `['latest','rc']`,`policy.ts` 的 `channel` 类型同步);只在同一 major 内自动升,跨 major 只提示 `UPDATE_MAJOR_AVAILABLE`;`pin`(`X.Y.Z` 或 `~X.Y[.Z]`,或 `KIT_UPDATE_PIN`)限定范围;发布未满 `cooldown_hours` 不自动装;`max_seen_version` 只增不减;`bad_versions` 里的版本不再自动安装。优先级:`KIT_AUTO_UPDATE=0` > 环境变量 > 配置文件 > 默认。
- **npm 202 半可见期**:packument 已有新版本但 tarball 404 或缺 `dist.integrity` → `not_ready`,下一窗口再试,不算失败。
- **安装**(S7c-A 实装,`src/update/install.ts`):下载 tarball 到内存 → sha512 对 `dist.integrity`(非镜像必须相等;镜像只作提示)→ 取 npmjs attestations,先做未验签的 `verifyTarballBinding` 预检(**仅用于早退**)→ `verifyProvenance`(同一份 attestations 文档、同一份内存字节;**它的返回值是唯一信任源**)→ 冷却起点补强:`max(npmjs time[v], Rekor integratedTime)`,`Date` 头 / `time[v]` 缺失或 `age < 0` 一律按未满冷却期,`--now` 整体豁免 → **验签通过之后**才 `readTgz` 解包 → 包内一致性:`integrity.json` 过 schema、解出的文件集合与 `integrity.files ∪ {integrity.json}` 严格相等(多 / 少都拒)、逐文件 sha256 与字节数、`kit_version` 与 `package.json` 的 `name` / `version` 等于目标、路径全是可见 ASCII;`integrity.json` 原始字节的 sha256 即外部锚点 `installed.anchor` → 经 home-fs 写入 `staging/<token>/`(目录 0700)并**读回复核** → 冒烟 → `renameDir` 成 `versions/<v>` → `switchCurrent` → 写 `state.json`(`markInstalled` + `recordCheck`)→ gc 只保留 `UPDATE_KEEP_VERSIONS`(2)个版本(`installed` 与 `previous`;`current` 指向的永不删;只清名字是合法 semver 的普通目录,清不掉不让安装失败)。不执行任何包内代码、不跑 lifecycle 脚本。失败一律删 staging,哪些进 `bad_versions` 见 §19.4。
- **冒烟**:静态(S7c-A)——`package.json.bin` 指向 `dist/` 下的文件、该文件存在、权限 0755、以 `#!` 开头。真执行(S7c-B)——`InstallDeps.smoke({home, stagingAbs, version})` 由 `launcher.ts` 的 `smokeCandidate` 实现(正式的 `update` 命令默认注入;测试里 `createUpdateCommand(deps)` 不传则只做静态冒烟):在静态冒烟与读回复核之后、`renameDir` 之前,经 `runSelf` 的 candidate 目标跑 `staging/st-<hex>/dist/cli.js --version`,要求退出 0 且 stdout 去空白后**恰为目标版本号**(超时 15s);任一不满足 → `smoke`(进 `bad_versions`,staging 删除,`current` 不动)。冒烟发生在切换之前,所以没有「未冒烟的版本短暂成为 current」的窗口。
- **current 与状态的一致性**:先 `switchCurrent`、再写 `state.json`;写状态失败 → 把 `current` 切回切换前的版本(首次安装则撤掉链接),退出 3;连切回都失败 → `UPDATE_CURRENT_BROKEN` + `current_broken`。判据(供启动器 / doctor D02):`state.installed.version` 等于 `current` 解析出的版本目录名,且 `sha256(current/integrity.json)` 等于 `state.installed.anchor`;不满足就不要信 `current`。每个提交点(改名、切换、写状态)前都会复核锁文件里的 nonce 仍是自己的(`lock_lost`)。
- **启动器(S7c-B,`src/update/launcher.ts`;根入口 `cli.ts` 惰性加载它)**:`KIT_LAUNCHED` 已设(且不是 `0`)→ 不启动(防递归)。否则读 `state.json`:没有 `installed` → 静默用自己。有则依次核对,**任何一环不符 → 退回自身并 stderr 一行 `UPDATE_CURRENT_BROKEN reason=<state|current|version_mismatch|version|anchor|tree|<runSelf 拒绝原因>>`**:① `currentVersionOf` 解析出的版本目录名等于 `state.installed.version`;② 该版本目录通过 `verifyInstalledTree`(完整树校验:`sha256(integrity.json)` 等于 `state.installed.anchor`、`kit_version` 一致、无链接 / 特殊文件、文件集合与逐文件摘要一致);③ 版本比较:`current` **严格高于**自身且 major 相同才启动(相等 / 更低 / 跨 major 都用自己,且不算损坏)。通过后 `runSelf({target:{kind:'current', version}})` —— runSelf 内部**再按 `versions/<该版本>` 复核**目录名与 `dist/cli.js`,spawn 的是解析后的版本目录里的真实路径而不是 `current` 链接(校验与执行之间 `current` 被切走 → `version_mismatch` 拒绝)。子进程一旦 spawn 成功,无论退出码是多少都不再回退(否则用户命令会执行两遍);信号退出按 128+n。只有「没能 spawn」才退回自身。启动器本身的任何异常同样退回自身。
- **后台 worker(S7c-B,`src/update/worker.ts`)**:前台命令结束后(此时不阻塞用户),启动器的 `scheduleBackground` 在以下条件全部满足时起 `agent-kit __update --background`:`KIT_AUTO_UPDATE` 未关、`KIT_LAUNCHED` 未设(被启动的那份子进程不调度,由外层父进程调度,所以一次前台命令至多起一个)、非 CI、stdout 与 stdin 是 TTY、命令存在且不是 `check|build|__update`(只带 `--version` / `--help` 的调用不算)、24h 节流到期(时钟往回走视为到期)。worker 以 `detached`、stdio 丢弃、`unref` 启动,**TMPDIR 指向 spawn 之前创建并复核过的 `~/.local/state/agent-kit/update/tmp`**(0700、属主是自己、链上无符号链接,否则不启动;tuf-js 联网刷新会在 `os.tmpdir()` 建临时目录)。谁来跑:有效 `current`(通过上面的锚点 / 完整树校验)→ 由 current 起;否则(首次安装、刚用 npm 全局装的引导版本)→ `runSelf` 的 `self` 目标,即「本模块所在包的 `dist/cli.js`」,它是当前进程自己的代码,信任不高于当前进程。worker 内部:摘掉自带的 `KIT_LAUNCHED` 再判开关(`autoUpdateGate`,含 `config.update.auto_install`)→ 节流 → 复用 `update --write` 的完整流程(锁内重读状态与 packument、重新决策、验签、冒烟、切换);**worker 走「锁优先」**:`update` 命令在给了 `proceedInLock`(即后台 worker)时,先拿 update 锁、重读状态、再查一次节流,**之后才第一次访问 registry**;所有检查结果(含 up_to_date / cooldown 等非安装)都在锁内记录。排队的两个 worker 因此不会各自先联网再抢锁。拿不到锁:静默结束,日志记 `skipped_locked`,**不无锁改写 `state.json`**。worker 本身绝不输出;自动同步被拒的提示由下一次 TTY 前台命令在命令结束后读 `last_auto_sync` 补出一行 `AUTO_SYNC_DECLINED reason=<码>` + `SYNC_PENDING`(每条记录只提示一次,靠 `last_notice_at` 记账)。
- **代理 / TUF(S7c-B)**:`runSelf` 在环境里有代理变量(`HTTPS_PROXY` / `HTTP_PROXY` 及小写;`NODE_USE_ENV_PROXY=0|false` 视为显式关闭、`=1|true` 视为开启)且 Node ≥ 24.5 时给子进程加 `--use-env-proxy`(execArgv 之首);Node 不够新则**不硬传**(旧 Node 不认该选项),此时 tuf-js 刷新失败仍是 `tuf_unreachable`(fail-closed,绝不降级成跳过验签)。`runSelf` 不继承父进程的 `execArgv`。局限:这只作用于 runSelf 起的子进程(后台 worker、被启动的新版本、冒烟);用户前台直接运行的 bootstrap 进程不受影响,手动 `update --write` 在代理环境下是否带 `--use-env-proxy` 取决于用户怎么启动 node。同理,受控 TMPDIR 只覆盖后台 worker,前台 `update --write` 的 TUF 刷新仍用系统临时目录(保留的现状);冒烟子进程不传 TMPDIR(固定 `--version`,不联网、不建临时文件)。
- **锁**:(S7c-B 起 `sync/lock` 与 `update/lock` 用同一原语、同一回收规则:空文件且创建不满 10 秒按「正在写」、持锁 pid 在则不回收、损坏内容回收前复读确认;锁序固定 **update → sync**,手动 `sync` 不拿 update 锁;sync 事务在写 journal、每个文件、提交登记表之前都 `assertHeld()` 复核 nonce,锁被陈旧锁回收竞态夺走则停手,退出 4 `SYNC_LOCKED`——这只缩小窗口,回收协议本身仍非严格互斥,见下「已知残余」)`update/lock`(home-fs `createExclusive` = `O_CREAT|O_EXCL|O_NOFOLLOW`,内容 `{pid, started_at, nonce}`,0600,TTL 15 分钟);拿不到锁:`--write` 退出 4 `UPDATE_NOT_RUN reason=locked`(后台 worker 静默跳过并记 `skipped_locked`)。pid 已不在 → 回收(删除前复读确认仍是同一把);pid 在但超 TTL → 只报不杀(`locked_over_ttl`);内容损坏且创建不满 10 秒按「正在写」处理,超过则回收。已知残余:两个回收者先后删除的竞态靠提交点前的 nonce 复核兜底;pid 被无关长寿进程复用时,锁会一直报 `locked_over_ttl`(sync 锁同理报 `SYNC_LOCKED`),需要用户手工删 `update/lock`(或 `sync/lock`);doctor / 文档的人工处理提示就是这一句,没有自动清除(自动杀 / 删可能误伤真实持锁者)。
- **遥测**:无。唯一对外请求是向 registry 拉 packument / attestations / tarball。
- **文件位置**(HOME 相对):`.config/agent-kit/config.toml`(`UserConfig`,只读,sync / update 不写);`.local/state/agent-kit/sync/{ledger.json,txn/,backups/,lock}`;`.local/state/agent-kit/update/{state.json,lock,log}`;`.local/share/agent-kit/{versions/,current,staging/}`。目录 0700、文件 0600。
- **来源证明验签(S7a,`src/update/provenance.ts`;用户决定用官方完整 `sigstore` 包)**:`verifyProvenance` 只接受外层 predicateType = SLSA v1 且 `payloadType = application/vnd.in-toto+json` 的**恰好一条** bundle,对它验签(Fulcio 链 + Rekor SET / 包含证明 + DSSE),身份用 Fulcio 证书 SAN `https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@refs/tags/v<version>` + issuer `https://token.actions.githubusercontent.com` 钉死;🔴 sigstore 的 `certificateIdentityURI` 是**未锚定正则**,所以传 `^<转义>$` 并对返回的 identity 再做精确相等复核。验签后,**同一份已验签 payload** 的 subject 名必须是 `pkg:npm/%40chovizzz/agent-kit@<v>`、`digest.sha512` 必须等于内存里 tarball 的 sha512,`predicate.buildDefinition.externalParameters.workflow.{repository,path,ref}` 必须与 SAN 一致。`timestampThreshold` 绝不传 0(完整 sigstore 不暴露该选项,另加自查:bundle 必须带时间戳证据)。原因码:`ok`、`provenance_missing`、`provenance_identity`、`bundle`、`integrity`、`trust_root_stale`、`tuf_unreachable`;subject 名不符(换版本重放)归 `provenance_identity`。
- **sigstore 的缓存写入例外(只此一处)**:`provenance.ts` 内 sigstore / tuf-js 往 `tuf.cachePath` 写 TUF 元数据(root / timestamp / snapshot / targets / trusted_root),**不经 home-fs,范围仅限 `tuf.cachePath`**(安装器给 `~/.local/share/agent-kit/` 下的专用子目录,在 `HOME_WRITE_TABLE` 的 kit 条目内)。联网刷新时 tuf-js 另会在 `os.tmpdir()` 下建临时目录并在下载后删除;离线(`forceCache` 且缓存有效)零临时文件、零联网。其余路径(真实 HOME、默认缓存目录 `appdata`)不写,`test/update/provenance-tuf.test.ts` 断言。
- **TUF / 代理 / 离线**:tuf-js 用全局 `fetch`,**不读 `HTTPS_PROXY`**,除非进程带 `--use-env-proxy`(Node ≥ 24.5;实测带与不带行为不同);只能走代理的网络里不带该开关,刷新失败 → `tuf_unreachable`(fail-closed,绝不降级成跳过验签)。联网刷新约 1.5s,`forceCache` 命中缓存约 25ms。sigstore 5 **不支持**直接传入 `trusted_root.json`,随包固定信任根不能作回退;唯一的可选回退是用户配置显式允许的 `fallbackToCache`(联网刷新失败后用仍在有效期内的缓存重试)。缓存元数据过期(timestamp 约 7 天)时 `forceCache` 仍会尝试联网续期。`sigstore` 的 engines 为 `^22.22.2 || ^24.15.0 || >=26.0.0`(本包 `>=22`),在更老的 Node 上行为未保证。S7b 打包进 dist 后 `dependencies` 清空。
- **严格 tar 读取器(`src/update/tar.ts`)**:内存字节进、文件清单出;只接受 `package/` 下的普通文件与目录,拒绝符号链接 / 硬链接 / 设备 / FIFO / GNU 长名 / 全局 pax / 绝对路径 / `..` / `.` 段 / 空段 / 反斜杠 / 盘符 / NUL / 非 UTF-8 / 重复(含大小写与 Unicode 归一后折叠)/ 文件目录同名冲突;gzip 必须完整(截断、多余尾部、多成员、CRC / ISIZE 错均拒);限制单文件 / 总大小 / 条目数 / 路径长度 / 解压比;权限归一为 0644 / 0755。稳定码 `TAR_*`。

### 19.6 `auto_sync = "safe"` 的机器可判条件(决策 ②B)

自动同步只在更新安装成功之后、由同一 worker 评估,**一次评估一份 payload**。**执行不变量:先拿 sync 锁,再重新读取登记表、检查残留 txn、生成计划并逐条验证下表条件;写入前复核每个目标的内容指纹与路径安全属性,并确认被重扫的内容就是实际写入的内容(同一份内存字节)。**先判断后拿锁是不允许的。**以下全部成立才应用**,任一不成立 → 整次不应用,退回 `SYNC_PENDING` 提示,并把原因写进 `UpdateState.last_auto_sync`(`outcome=declined`,`reasons` 取 `AUTO_SYNC_DECLINE_REASONS`),stderr 一行 `AUTO_SYNC_DECLINED reason=<码>`。不存在「部分应用」。

| 条件(须全部为真)                                                                                                                                 | 不成立时的原因码                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `update.auto_sync = "safe"` 且 `KIT_AUTO_SYNC` 不是 `0`(否则根本不评估、不留记录)                                                                | (不评估)                           |
| 登记表已存在且可解析——用户必须先手动跑过 `sync --write`;**自动同步永远不做首次安装**                                                             | `not_installed` / `ledger_invalid` |
| 无残留 txn                                                                                                                                       | `txn_incomplete`                   |
| 新 payload 与登记表的 `kit_version` 同一 major                                                                                                   | `major_changed`                    |
| 计划中没有漂移条目                                                                                                                               | `drifted`                          |
| 计划中没有外来冲突(`SYNC_TARGET_FOREIGN` / `SYNC_UNMANAGED_IN_OWNED_DIR`)                                                                        | `foreign_conflict`                 |
| 没有共用路径冲突                                                                                                                                 | `shared_path_conflict`             |
| payload 的 `files` 全部是 instructions 类(`kind ∈ rules \| skill \| subagent`);**只要存在一个 `executable` 条目就拒,不论是否在计划内**           | `executable_in_payload`            |
| 计划中新建 / 更新的文件,其 `atoms` 里没有 `strength = must`(删除操作不受此限)                                                                    | `must_atom`                        |
| 本地对新内容重扫干净:危险话术(`scanDangerousPhrases`)+ 不可见字符(C1 / C1b);**依赖先修好话术检测极性(backlog 遗留 ①),未修好前实现不得启用 safe** | `rescan_dirty`                     |
| payload 的 `integrity.json` 逐文件核对通过,且其 sha256 等于安装时记下的外部锚点                                                                  | `integrity_unverified`             |
| 计划涉及的 agent 都已出现在登记表条目的 `agents` 里(不自动扩大 agent 集合)                                                                       | `agent_set_expanded`               |
| 计划操作数 ≤ `AUTO_SYNC_MAX_OPS`(20)                                                                                                             | `too_many_ops`                     |
| 预检通过(无符号链接段、硬链接、非常规文件、corrupt 块)                                                                                           | `precheck_refused`                 |
| 拿到 sync 锁                                                                                                                                     | `locked`                           |

**实装(S7c-B,`src/update/autosync.ts`,由 update 命令的 `afterInstall` 钩子在安装成功、仍持 update 锁时调用)**:先 `acquireLock`(sync 锁;拿不到 → 记 `declined locked`,别人的锁不动)→ **锁内**读登记表 / 查残留 txn → `verifyInstalledTree(新版本目录, {anchor, version})` 且 `loadPayload` **实际读到的 `integrity.json` 字节的 sha256 等于锚点**(`LoadedPayload.integritySha256`,S7c-B 追加字段;校验与加载读的是同一份)→ 生成计划(**agent 集合取登记表条目 `agents` 的并集**:不扩大,空集合不回退默认集合;共用路径上的 agent 另按「同一 path+block 条目自己的 `agents`」逐条再核)→ `evaluateSafeAutoSync` → 通过后**写入前再取一次磁盘快照、重新规划、重新验证**,两次的计划指纹(每个操作的 op / path / block / 写前后 sha / agents、登记表动作与 sha、残留 txn)与**每个将被写的目标的整文件文本**必须逐项一致,否则 `declined drifted`(用户在托管块之外的改动也算)→ 用**同一份内存里的 `LoadedPayload`** 执行与手动 `sync --write` 相同的事务(可 `sync --rollback`)。计划无事可做 → 不留记录;`failed`(执行中抛错)不改变已提交的安装结果、不 `markBad`,残留事务留给 `sync --resume` / `--rollback`。`last_auto_sync` 由 update 命令在同一把锁内写进 `state.json`。启用的前置条件「话术检测极性(backlog ①)」:`test/sync/safe.test.ts` 与 `test/update/autosync.test.ts` 的 `rescan_dirty` 用例钉着 `curl … | sh` 与不可见字符被拒;评审时仍以 backlog ① 是否关闭为准。

其它约束:只处理 `target=home`;使用与手动 `sync --write` 完全相同的事务与备份(可 `sync --rollback`);可执行类(hook、settings 等)**永远不自动应用**,将来即使渲染出来也要 `sync --write --allow-executable` 并在 TTY 确认;`doctor` D16 显示最近一次记录。

> **v3.1 修订(§21.18 第 7、8、9 条,V2 生效)**:上表条件全部保留、只追加:评估时机新增「本机 payload 变化后」(rsi worker 持 `rsi/lock` 后再拿 sync 锁);新增条件 `[rsi.auto] enabled = true`、差异只落在 `origin=auto_rsi` 文件(`local_non_auto_diff`)、差异文件都对应 `stable` 候选(`candidate_not_stable`)、不在 `auto_paused`(`auto_paused`);本机 payload 的锚点信任来源是本机 kit,与包 payload 的 npm 来源证明不同(R21-8.2)。「可执行类永远不自动应用」不变,E1 不经 sync(§21.16)。另新增只删除自动产出的撤销路径 `syncRevoke`(R21-9.3)。

### 19.7 写出口、lint 授权闸与 exec 白名单条款

**`HOME_WRITE_TABLE`**(`src/contracts/sync.ts`,写死,12 条,按 path 字节序;`test/contracts/sync-update.test.ts` 断言它等于 `adapters/*/managed-targets.json` 的并集加两个本套件目录,多一条少一条都红):

| 路径(HOME 相对)              | 类型 | 归属    | 声明的 adapter  |
| ---------------------------- | ---- | ------- | --------------- |
| `.agents/skills/`            | dir  | adapter | codex, kimi, pi |
| `.claude/agents/`            | dir  | adapter | claude          |
| `.claude/rules/agent-kit/`   | dir  | adapter | claude          |
| `.claude/skills/`            | dir  | adapter | claude          |
| `.codex/AGENTS.md`           | file | adapter | codex           |
| `.codex/agents/`             | dir  | adapter | codex           |
| `.config/opencode/AGENTS.md` | file | adapter | opencode        |
| `.kimi-code/AGENTS.md`       | file | adapter | kimi            |
| `.kimi-code/agents/`         | dir  | adapter | kimi            |
| `.local/share/agent-kit/`    | dir  | kit     | —               |
| `.local/state/agent-kit/`    | dir  | kit     | —               |
| `.pi/agent/AGENTS.md`        | file | adapter | pi              |

S7c-A 给 home-fs 追加三个原语(都走同一套「表内 + planScope + 逐段 lstat」校验):`createExclusive`(独占创建,已存在 → `HomeExistsError`,锁用)、`renameDir`(目录改名,目标须不存在,改名前后核对目录身份 dev:ino;残余:POSIX 目录 rename 会覆盖空的目标目录而 Node 无 no-replace 选项,故只在调用方持 update 锁时成立)、`switchCurrent(ctx, version | null)`(`current` 位置固定为 `.local/share/agent-kit/current`;目标由原语按 semver 拼成相对串 `versions/<version>`,调用方不能传路径;`versions/<version>` 须是真实目录、`versions` 与各上级不得是链接;临时符号链接 → rename 覆盖 → `readlink` 精确比对并核对 `realpath(current)` 严格位于 `realpath(versions)` 内;既有 `current` 必须是符号链接,是文件 / 目录则拒,指向别处的链接被覆盖即自愈)。`dev:ino` 复核只用于缩小窗口,不作为身份保证:Linux(ext4 等)会立即复用刚释放的 inode 号,「删除后同号重建」能通过这一步复核。安全性由 rename 后的 `readlink` / `realpath` 复核和启动时的 `verifyInstalledTree` 保证;同用户并发改写属于 §5 已接受的残余。

语义:`file` 条目要求路径相等;`dir` 条目本身不可写,只能写严格位于其内部、且在本次计划(`planScope`)里点名的文件(`isHomeWritePath`)。**adapter 的 `dir` 条目内部另禁点开头的路径段与 `.json` 结尾的文件**(只检查目录以下的段,`.claude/…` 等 HOME 根下的点目录不受影响;kit 状态目录的 `ledger.json` / `state.json` 不适用)。登记表 / 事务 / `PayloadFile(target=home)` 的路径在 schema 层就必须落在 adapter 条目内,因此上述禁写在 schema 层即成立。home-fs(S1)另加:路径任一中间段是符号链接即拒;`HOME` 必须是 `getRealHome()` 或 `KIT_TMP` 之内的 `--home`。`~/.config/agent-kit/` 是只读的用户配置,不在表内。

**eslint 授权闸**(`eslint.config.js`,文件由 S1 / S6 / S7 才建,规则先就位;`test/lint/violations.test.ts` 与 `test/fixtures/lint-violations/*` 证明):

| 出口                      | 谁能引用(import / export-from / 动态 import)                                                                                                                                                  | 其它                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/io/home-fs.ts`       | `src/sync/apply.ts`、`src/update/install.ts`、`test/io/home-fs*.test.ts`、`test/sync/apply*.test.ts`、`test/update/install*.test.ts`                                                          | 它自己可用 `node:fs`,不可用子进程 / 网络 / 环境                                                         |
| `src/io/net.ts`           | `src/update/**`(`launcher.ts` 除外)、`src/commands/update.ts`、`test/io/net*.test.ts`、`test/update/**`                                                                                       | 只有它可以 import 网络模块、使用全局 `fetch`                                                            |
| `src/update/launcher.ts`  | `cli.ts`、`src/cli.ts`、`src/update/**`、`src/commands/update.ts`、`test/update/**`                                                                                                           | launcher.ts 自己不得引用 net / home-fs                                                                  |
| `io/exec.ts` 的 `runSelf` | 仅 `src/update/launcher.ts` 与 `test/update/launcher*.test.ts`;R20-A0 起另含零网络桥接 `src/update/self-spawn.ts` 与 `test/update/self-spawn*.test.ts`(该文件不得引用 net / 启动器 / home-fs) | 命名导入、`import *`、`export … from`、对 `io/exec` 的动态 `import()` 都拦(静态导入 `runSync` 不受影响) |

**exec 白名单条款(S7c-B 已实装;订正)**:`EXEC_ALLOWLIST` 仍恰为 `['git']`,`runSync` 不变;`src/io/exec.ts` 新增独立导出 `runSelf`,只能 spawn 当前 `process.execPath`,**脚本路径只由函数内部解析,调用方不能指定**,不经 shell,不继承 `execArgv`。三种目标(`target.kind`):

- `current`:`<home>/.local/share/agent-kit/current` 必须是符号链接,`realpath` 必须是 `realpath(versions/)` 的**直接子目录**且目录名是合法 semver(给了 `version` 就必须相等),`dist/cli.js` 必须是普通文件且路径链无符号链接(`realpath(entry) === entry`);spawn 的是这个解析后的真实路径。用户命令,前台 stdio 继承。
- `self`:本模块所在包(`import.meta.url` 往上找 `package.json`,取 `dist/cli.js`,同样要求普通文件、无链接)。**只给后台 worker 用**:`current` 还不存在(首次安装 / 刚 `npm i -g` 的引导版本)时也要能自动更新。它运行的是当前进程自己的代码,不构成信任升级;不用 `process.argv[1]`(那是调用方可影响的路径)。
- `candidate`:`staging/st-<hex>` 的直接子目录(`realpath` 后),参数**固定 `--version`**(调用方的 `args` 被忽略),stdio 为管道(stdout 回传、上限 64KB)、有超时;只给安装冒烟用。
  环境(**订正 S0 的「只传 KIT_LAUNCHED=1 及既有白名单键」,理由见下**):`KIT_LAUNCHED=1` 强制、`HOME` 强制为已校验的 `home`、`TMPDIR` 在给了受控目录时以其为准;其余只透传**具名**清单 `RUN_SELF_ENV_KEYS`(`PATH`、`LANG`、`TZ`、`TMPDIR`、`KIT_TMP`、`KIT_STATE_DIR`、`KIT_WRITE_ROOTS`、`KIT_REAL_HOME_OVERRIDE`、`KIT_PAYLOAD_DIR`、`KIT_AUTO_UPDATE`、`KIT_AUTO_SYNC`、`KIT_UPDATE_REGISTRY`、`KIT_UPDATE_PIN`、判 CI 的 `CI` / `GITHUB_ACTIONS` / `GITLAB_CI` / `BUILDKITE` / `CIRCLECI` / `TF_BUILD` / `JENKINS_URL`、大小写两种 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`、`NODE_USE_ENV_PROXY`)加 `LC_*` 与 `GIT_*`。**不用 `KIT_*` 通配**(未来新增变量不会自动越界),明确不传 `NODE_OPTIONS`、`NODE_PATH`、`LD_*`、`DYLD_*`。订正理由:被启动的新版本就是用户要运行的 CLI 本身,没有 `PATH` 它的 `git` 调用找不到二进制、没有 `KIT_TMP` / `KIT_STATE_DIR` 它的写出口根就变了、没有代理变量验签联网不通;这些变量用户本来就交给了「当前进程」,而新版本经完整树校验后与当前进程同级。env 来源仍只能经 `io/paths.ts`(`pickProcessEnv`,按 `RUN_SELF_ENV_PICK_RE` 收窄)。后台模式(`background:true`):`detached`、stdio 丢弃、`unref`,立即返回。它是 launcher 专用入口,不是通用二进制放行;`EXEC_ALLOWLIST` 与 `runSync` 的行为不变。
- **R20-A0 订正(§20.9 第 2、3 条 ①②)**:①`RUN_SELF_ENV_KEYS` 追加具名键 `KIT_AUTO_RSI`、`KIT_RSI_CHILD`、`KIT_RSI_PI_DIR_SET`(仍不用通配);`PI_CODING_AGENT_DIR` 不在清单里、其值绝不传给子进程——调用方环境里它**已设置**(含空串)时,子进程得到 `KIT_RSI_PI_DIR_SET=1`(R20-2.9;调用方自带的该变量只有 `1` 被保留以跨过启动器一跳,其它值丢弃),`RUN_SELF_ENV_PICK_RE` 因此多收这一个名字。②`RunSelfOptions` 加可选 `cwd`:必须是绝对路径(否则抛 `RunSelfDeniedError`),且是规范路径(`realpath(cwd) === cwd`)的真实目录、本身不是符号链接(否则不 spawn,返回 `cwd_invalid`);缺省继承调用方 cwd(update 的既有行为不变);「等于 `realpath([rsi] repo)`」由调用方保证。③新增零网络桥接 `src/update/self-spawn.ts`(`spawnRsiWorker`:`self` 目标、参数固定 `__rsi --background`、后台、`cwd`=仓库根;从不抛错、不写文件),只引用 `io/exec.ts`,闭包不含 `net.ts` / `install.ts` / `registry.ts` / `provenance.ts` / `launcher.ts`(`test/rsi/import-closure.test.ts` 钉死,并对启动器链做正向对照)。该桥接不定位也不校验 `current`(Q25-A:钩子跑的就是被调用的那份包),所以 `verifyInstalledTree` 仍在 `install.ts`。eslint 对该文件的授权块排在 `src/update/**` 之后,只比默认多放行 `runSelf`,收回该目录给的 net / 启动器放行。
- 冒烟之所以从 `launcher.ts` 导出再由 `commands/update.ts` 注入 `InstallDeps.smoke`:lint 闸只许 `launcher.ts` 引用 `runSelf`,安装器 / 命令层都不直接引用它。

> **v3.1 修订(§21.18 第 10、11、32、33、45 条)**:`EXEC_ALLOWLIST` 仍恰为 `['git']`;本节不给 `HOME_WRITE_TABLE` 新增条目(条数只随 §20.9 第 13 条变化);新增私有仓库提交原语 `commitPersonal`(R21-3.6,V1)、HOME 侧个人层状态 `rsi-personal/` 的 home-fs 授权(R21-3.2,V1)、独立出口 `runGhPrCreate`(R21-17.10,V4,只许 `src/rsi/contrib/publish/**`)、`runHostScript` 与 `runIsolated`(R21-16.11,V6a,只许 `src/rsi/exec/**`)、导出写原语 `exportContrib`(R21-17.4,V4)、`extensions.json` 的 home-fs 授权(V5,只许 `src/rsi/capability/**`)。`runSelf` 与 R20-A0 的 self-spawn 桥接不变。

### 19.8 schema 与常量清单

`SyncLedger`、`SyncTxn`(`src/contracts/sync.ts`);`UserConfig`、`UpdateState`(`update.ts`);`PayloadManifest`、`PayloadIntegrity`(`payload.ts`);`DOCTOR_CHECK_IDS`(`doctor.ts`)。`SEMVER_RE` / `SemverSchema` / `RelPathSchema` 追加在 `common.ts`。`payload_sha256` = `canonicalJson(PayloadManifest)` 字节的 sha256。

### 19.9 验收与未核实

- S8 的 A25(sync 往返)、A26(doctor 与 sync 干跑进 A5)、A27(更新,假 registry)、A28(变异抽检)按设计稿 §6;A5 命令环境固定加 `KIT_AUTO_UPDATE=0`。
- 已核实(S7 调研 / S7a):Node 全局 `fetch` 默认不走 `HTTPS_PROXY`,带 `--use-env-proxy` 才走(Node 25.2 实测);attestations 响应形状与 SLSA predicate 字段路径(`predicate.buildDefinition.externalParameters.workflow.{repository,path,ref}`)见 `test/update/fixtures/att-rc0.json`;运行时依赖打包进 dist(S7b,见下)。
- 运行时依赖打包(S7b,已实装):`vite build`(SSR 模式,rolldown;配置 `vite.config.ts`)把 zod / yaml / smol-toml 与**完整 `sigstore` 依赖树**(52 个包,含 tuf-js、make-fetch-happen、cacache、proxy-agent 系)打进 `dist/`,发布包 `dependencies` 为空(这些包只留在 devDependencies)。产物:`dist/cli.js`(薄入口,bin;S7c-B 起它先惰性加载启动器 chunk,启动器放行才不加载主程序,退回自身时再惰性加载 `dist/main.js`——启动器决定与加载之间只隔毫秒,旧进程的版本目录被 gc 的窗口可以忽略,但这与 S7b 当初「主程序静态加载」的取舍不同,订正于此)、`dist/main.js`(主程序)、`dist/provenance.js` + `dist/chunks/*`(`import('sigstore')` 拆成**已打包**的动态 chunk,验签前不加载,不拖慢冷启动)、`dist/THIRD_PARTY_LICENSES`(`scripts/gen-third-party-licenses.mjs` 按产物里的 `//#region` 注释汇总被打包包的许可证原文;少数包的 npm 发布物不带 LICENSE 文件,退而记录其 package.json 的 license / author / repository)。`dist/provenance.js` 是 vite 的独立入口(S7a 的模块目前没有被 CLI 引用,不单列入口会被 tree-shake 掉而漏打 sigstore);S7c 接线后可保留。tsc 仍做类型检查与构建期产物(输出到 `node_modules/.cache/agent-kit-tsc`,仅供 `scripts/build-payload.mjs` / `check-publish.mjs` 复用 payload 重建逻辑,**不随包发布**;`ops/accept` 旧脚本若按 `dist/src/*` 取 tsc 模块,需改指该目录)。
  - **发布闸**(`scripts/lib/bundle-gate.mjs`,`check-publish.mjs` 调用,稳定原因码 `BUNDLE_*`):`dependencies` 必须为空;dist 里所有 import / dynamic import / `require` / `__require` / `*.resolve` 说明符只能是 `node:*` 或相对路径(AST 扫描,非字面量参数也拒);`THIRD_PARTY_LICENSES` 必须覆盖产物里实际包含的每个 `name@version`;dist 内无 `node_modules` 路径 / 符号链接;sourcemap 与产物文本无绝对路径 / HOME 泄漏;`integrity.json` 覆盖 dist 全部文件;`bin` 入口存在、有 shebang、体积 ≤ 8KB(薄入口)。
  - **engines**:本包保持 `>=22`;被打包的 `sigstore@5` / `@sigstore/*` 自身 engines 为 `^22.22.2 || ^24.15.0 || >=26.0.0`,更老的 Node(如 22.13、25.x)上验签路径行为未保证(S7 调研在 22.13 / 25.2 上实测能跑,但属不受支持组合)。打包后 engines 不再由依赖传递,故此差异只在这里和 doctor 的提示里说明。
  - 两个打包期处理:第三方 CJS 里的 `require('path')` 等内建一律改写成 `node:path`;`debug` 对 `supports-color` 的可选 `require` 固定解析成空模块(不留运行期按用户 node_modules 解析的裸 specifier,等同「没装」,只影响调试日志颜色档位)。
  - 实测(Node 25.2,机器高负载):`--version` 冷启动 bundle 约 115–145ms,tsc 产物约 200–270ms(`node -e 0` 约 50ms);`sigstore` chunk 1.39MB 仅在验签时加载;npm 包 819KB(解包 2.9MB)。
- 启动器冷启动实测(S7c-B,Node 25.2,机器高负载,`--version`,中位数,3.1MB 的 current 目录,20 次 × 2 轮):`node -e 0` 约 54ms;无 `current` / 不启动(启动器读一次 state 后退回自身)约 61–70ms,与 `KIT_LAUNCHED=1`(完全不经启动器)61–66ms 无可测差别;**启动到 current 的真实子进程约 122–139ms,即比直接运行多约 60–70ms**(第二次 node 启动约 55ms + 完整树校验 3.1MB 的 sha256)。启动器 chunk 与主程序共享同一 chunk,所以退回自身时不额外付 import 成本。
- 未核实,实现前先测并回写本节:Rekor v2 / bundle v0.3 在 `timestampThreshold` 默认值下是否通过(目前无样本;`provenance.ts` 对「无 SET、只有 RFC3161」放行但不报 integratedTime);未知 tlog 与篡改 SET 都表现为 `TLOG_INCLUSION_PROMISE_ERROR`,目前统一归 `bundle`,只有证书链 / TUF 元数据层面的陈旧才归 `trust_root_stale`;claude 用户级 `rules/agent-kit/` 是否加载(P-Q1);skills-hub 遇同名条目是否覆盖;pi 默认推理档位;镜像 registry 的 npmjs 响应的 `Date` 头在代理 / 缓存下是否可靠(冷却期的“当前时间”来源,见 §19.5)。

### 19.10 示例

`SyncLedger`:路径必须落在 `HOME_WRITE_TABLE` 的 adapter 条目内,`entries` 按 (path, block_id) 严格升序。

<!-- example:valid schema=SyncLedger -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "payload_sha256": "0000000000000000000000000000000000000000000000000000000000000001",
  "entries": [
    {
      "path": ".agents/skills/commit-checklist/SKILL.md",
      "kind": "owned",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "created_file": true,
      "agents": ["codex", "pi"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    },
    {
      "path": ".claude/skills/commit-checklist/SKILL.md",
      "kind": "owned",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "created_file": true,
      "agents": ["claude"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    },
    {
      "path": ".codex/AGENTS.md",
      "kind": "block",
      "block_id": "agent-kit-rules",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "created_file": false,
      "agents": ["codex"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    }
  ]
}
```

错误示例:`.claude/CLAUDE.md` 不在写入表内(用户自己的文件,永远不可写)。

<!-- example:invalid schema=SyncLedger -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "payload_sha256": "0000000000000000000000000000000000000000000000000000000000000001",
  "entries": [
    {
      "path": ".agents/skills/commit-checklist/SKILL.md",
      "kind": "owned",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "created_file": true,
      "agents": ["codex", "pi"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    },
    {
      "path": ".claude/CLAUDE.md",
      "kind": "owned",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "created_file": true,
      "agents": ["claude"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    },
    {
      "path": ".codex/AGENTS.md",
      "kind": "block",
      "block_id": "agent-kit-rules",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "created_file": false,
      "agents": ["codex"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    }
  ]
}
```

错误示例:`kind=block` 缺 `block_id`。

<!-- example:invalid schema=SyncLedger -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "payload_sha256": "0000000000000000000000000000000000000000000000000000000000000001",
  "entries": [
    {
      "path": ".agents/skills/commit-checklist/SKILL.md",
      "kind": "owned",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "created_file": true,
      "agents": ["codex", "pi"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    },
    {
      "path": ".claude/skills/commit-checklist/SKILL.md",
      "kind": "owned",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "created_file": true,
      "agents": ["claude"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    },
    {
      "path": ".codex/AGENTS.md",
      "kind": "block",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "created_file": false,
      "agents": ["codex"],
      "txn": "txn-20261014T120000Z-a1b2c3"
    }
  ]
}
```

`SyncTxn`:`block_upsert` 的写前文件存在,所以必须备份;`create` 的写前是 `null`。

<!-- example:valid schema=SyncTxn -->

```json
{
  "schema_version": 1,
  "txn_id": "txn-20261014T120000Z-a1b2c3",
  "action": "sync",
  "kit_version": "0.1.0",
  "payload_sha256": "0000000000000000000000000000000000000000000000000000000000000001",
  "ledger_sha256_before": null,
  "started_at": "2026-10-14T12:00:00Z",
  "phase": "backed_up",
  "ops": [
    {
      "op": "create",
      "path": ".claude/skills/commit-checklist/SKILL.md",
      "file_sha256_before": null,
      "file_sha256_after": "0000000000000000000000000000000000000000000000000000000000000002",
      "backup": false,
      "agents": ["claude"]
    },
    {
      "op": "block_upsert",
      "path": ".codex/AGENTS.md",
      "block_id": "agent-kit-rules",
      "file_sha256_before": "0000000000000000000000000000000000000000000000000000000000000004",
      "file_sha256_after": "0000000000000000000000000000000000000000000000000000000000000005",
      "backup": true,
      "overwrote_drifted": false,
      "agents": ["codex"]
    }
  ]
}
```

错误示例:写前文件存在却没有备份(回滚会无从恢复)。

<!-- example:invalid schema=SyncTxn -->

```json
{
  "schema_version": 1,
  "txn_id": "txn-20261014T120000Z-a1b2c3",
  "action": "sync",
  "kit_version": "0.1.0",
  "payload_sha256": "0000000000000000000000000000000000000000000000000000000000000001",
  "ledger_sha256_before": null,
  "started_at": "2026-10-14T12:00:00Z",
  "phase": "backed_up",
  "ops": [
    {
      "op": "create",
      "path": ".claude/skills/commit-checklist/SKILL.md",
      "file_sha256_before": null,
      "file_sha256_after": "0000000000000000000000000000000000000000000000000000000000000002",
      "backup": false,
      "agents": ["claude"]
    },
    {
      "op": "block_upsert",
      "path": ".codex/AGENTS.md",
      "block_id": "agent-kit-rules",
      "file_sha256_before": "0000000000000000000000000000000000000000000000000000000000000004",
      "file_sha256_after": "0000000000000000000000000000000000000000000000000000000000000005",
      "backup": false,
      "overwrote_drifted": false,
      "agents": ["codex"]
    }
  ]
}
```

`UpdateState`:只有 `schema_version` 也合法(全新机器);`bad_versions` 缺省为空数组。

<!-- example:valid schema=UpdateState -->

```json
{
  "schema_version": 1
}
```

<!-- example:valid schema=UpdateState -->

```json
{
  "schema_version": 1,
  "last_check_at": "2026-10-14T12:00:00Z",
  "last_result": "cooldown",
  "latest_seen": "0.2.1",
  "latest_seen_published_at": "2026-10-14T08:00:00Z",
  "max_seen_version": "0.2.1",
  "installed": {
    "version": "0.2.0",
    "anchor": "0000000000000000000000000000000000000000000000000000000000000006",
    "installed_at": "2026-10-10T09:00:00Z"
  },
  "bad_versions": ["0.1.9"],
  "last_auto_sync": {
    "at": "2026-10-12T09:30:00Z",
    "outcome": "declined",
    "reasons": ["drifted", "must_atom"],
    "add": 1,
    "update": 2,
    "remove": 0
  }
}
```

错误示例:`last_result` 不是枚举值(网络原因必须归到具体的码,不允许一个笼统的 `network_error`)。

<!-- example:invalid schema=UpdateState -->

```json
{
  "schema_version": 1,
  "last_result": "network_error"
}
```

错误示例:`declined` 却没有给出原因。

<!-- example:invalid schema=UpdateState -->

```json
{
  "schema_version": 1,
  "last_auto_sync": {
    "at": "2026-10-12T09:30:00Z",
    "outcome": "declined",
    "reasons": [],
    "add": 0,
    "update": 0,
    "remove": 0
  }
}
```

`UserConfig`(`~/.config/agent-kit/config.toml` 解析后的对象):整份缺省合法,缺省值 = `auto_install=true`、`auto_sync="safe"`、`channel="latest"`、`cooldown_hours=24`、`registry="https://registry.npmjs.org/"`、`pin` 不钉。

<!-- example:valid schema=UserConfig -->

```json
{}
```

<!-- example:valid schema=UserConfig -->

```json
{
  "update": {
    "auto_install": true,
    "auto_sync": "safe",
    "channel": "latest",
    "pin": "~0.2",
    "cooldown_hours": 24,
    "registry": "https://registry.npmmirror.com/"
  }
}
```

错误示例:`auto_sync` 只有 `off | safe`,没有「全自动」(决策 ②:不提供 C 档)。

<!-- example:invalid schema=UserConfig -->

```json
{
  "update": {
    "auto_sync": "full"
  }
}
```

错误示例:registry 必须是 https。

<!-- example:invalid schema=UserConfig -->

```json
{
  "update": {
    "registry": "http://registry.example.com/"
  }
}
```

错误示例:冷却期下限 1 小时(0 会撞上 npm 202 半可见期且没有投毒缓冲);要立刻装用 `update --now`。

<!-- example:invalid schema=UserConfig -->

```json
{
  "update": {
    "cooldown_hours": 0
  }
}
```

`PayloadManifest`:`target=home` 的路径必须在写入表内;`files` 按 `<agent>/<target>/<path>` 升序;`atoms[].strength` 供 `auto_sync=safe` 判断「不含 must」。

<!-- example:valid schema=PayloadManifest -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "channel": "stable",
  "files": [
    {
      "agent": "claude",
      "target": "home",
      "path": ".claude/skills/commit-checklist/SKILL.md",
      "mode": "owned",
      "kind": "skill",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "bytes": 812,
      "payload_path": "files/claude/home/.claude/skills/commit-checklist/SKILL.md",
      "atoms": []
    },
    {
      "agent": "codex",
      "target": "home",
      "path": ".agents/skills/commit-checklist/SKILL.md",
      "mode": "owned",
      "kind": "skill",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "bytes": 812,
      "payload_path": "files/codex/home/.agents/skills/commit-checklist/SKILL.md",
      "atoms": []
    },
    {
      "agent": "codex",
      "target": "home",
      "path": ".codex/AGENTS.md",
      "mode": "managed-block",
      "block_id": "agent-kit-rules",
      "kind": "rules",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "bytes": 420,
      "payload_path": "files/codex/home/.codex/AGENTS.md",
      "atoms": [
        {
          "id": "negative-assertion-needs-positive-control",
          "layer": "org",
          "strength": "should"
        }
      ]
    }
  ],
  "migrations": [],
  "skippedLayers": [
    {
      "layer": "personal",
      "reason": "v1 不渲染 personal 层"
    }
  ]
}
```

错误示例:`.claude/settings.json` 不在写入表内(settings 类文件永远不由 sync 写)。

<!-- example:invalid schema=PayloadManifest -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "channel": "stable",
  "files": [
    {
      "agent": "claude",
      "target": "home",
      "path": ".claude/settings.json",
      "mode": "owned",
      "kind": "skill",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "bytes": 812,
      "payload_path": "files/claude/home/.claude/skills/commit-checklist/SKILL.md",
      "atoms": []
    },
    {
      "agent": "codex",
      "target": "home",
      "path": ".agents/skills/commit-checklist/SKILL.md",
      "mode": "owned",
      "kind": "skill",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "bytes": 812,
      "payload_path": "files/codex/home/.agents/skills/commit-checklist/SKILL.md",
      "atoms": []
    },
    {
      "agent": "codex",
      "target": "home",
      "path": ".codex/AGENTS.md",
      "mode": "managed-block",
      "block_id": "agent-kit-rules",
      "kind": "rules",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "bytes": 420,
      "payload_path": "files/codex/home/.codex/AGENTS.md",
      "atoms": [
        {
          "id": "negative-assertion-needs-positive-control",
          "layer": "org",
          "strength": "should"
        }
      ]
    }
  ],
  "migrations": [],
  "skippedLayers": [
    {
      "layer": "personal",
      "reason": "v1 不渲染 personal 层"
    }
  ]
}
```

错误示例:`mode=managed-block` 缺 `block_id`。

<!-- example:invalid schema=PayloadManifest -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "channel": "stable",
  "files": [
    {
      "agent": "claude",
      "target": "home",
      "path": ".claude/skills/commit-checklist/SKILL.md",
      "mode": "owned",
      "kind": "skill",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "bytes": 812,
      "payload_path": "files/claude/home/.claude/skills/commit-checklist/SKILL.md",
      "atoms": []
    },
    {
      "agent": "codex",
      "target": "home",
      "path": ".agents/skills/commit-checklist/SKILL.md",
      "mode": "owned",
      "kind": "skill",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000002",
      "bytes": 812,
      "payload_path": "files/codex/home/.agents/skills/commit-checklist/SKILL.md",
      "atoms": []
    },
    {
      "agent": "codex",
      "target": "home",
      "path": ".codex/AGENTS.md",
      "mode": "managed-block",
      "kind": "rules",
      "confidence": "documented",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000003",
      "bytes": 420,
      "payload_path": "files/codex/home/.codex/AGENTS.md",
      "atoms": [
        {
          "id": "negative-assertion-needs-positive-control",
          "layer": "org",
          "strength": "should"
        }
      ]
    }
  ],
  "migrations": [],
  "skippedLayers": [
    {
      "layer": "personal",
      "reason": "v1 不渲染 personal 层"
    }
  ]
}
```

`PayloadIntegrity`(包根 `integrity.json`):逐文件哈希,按 path 严格升序,不含自身。

<!-- example:valid schema=PayloadIntegrity -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "algorithm": "sha256",
  "files": [
    {
      "path": "dist/cli.js",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000007",
      "bytes": 1200
    },
    {
      "path": "package.json",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000008",
      "bytes": 900
    },
    {
      "path": "payload/manifest.json",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000009",
      "bytes": 2100
    }
  ]
}
```

错误示例:顺序不是升序。

<!-- example:invalid schema=PayloadIntegrity -->

```json
{
  "schema_version": 1,
  "kit_version": "0.1.0",
  "algorithm": "sha256",
  "files": [
    {
      "path": "package.json",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000008",
      "bytes": 900
    },
    {
      "path": "dist/cli.js",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000007",
      "bytes": 1200
    },
    {
      "path": "payload/manifest.json",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000009",
      "bytes": 2100
    }
  ]
}
```

## 20. 自动 RSI(会话内 agent 模式)P0 契约(R20,契约先行;A1–A3 实装后订正)

本节把 `docs/design-auto-rsi.md`(v2,2026-10-23 合并;下称「设计稿」)里属于 **P0** 的部分写成可验收条款。P0 范围按设计稿 §14:本节、锁(A1)、L0 采集与 `rsi tick`(A2)、后台调度 `rsi poke`(A3)、项目索引与排除 / purge、`rsi hint` / `rsi status` / `rsi projects` / `rsi confirm` / `rsi stop`。P1(digest / ingest、技能与钩子安装、提醒、D17)只给命令面占位与不变量(§20.10)。已定决定:N3、N5、N6、N7(2026-10-23,按推荐);N1、N2、N4 待第二批,相关处写「待定,不在 P0 范围」。

条款编号形如 `R20-<小节>.<序号>`,测试与验收脚本按编号引用(`it('R20-1.4 …')`)。本节的数值全部是**不可配置的常量**(写进 `src/contracts/rsi.ts`),P0 的 `[rsi]` 没有任何调节预算、间隔、门槛的键;以后要开放,必须逐项写明字段、上下界与「调严」的方向。

本节正文里的 JSON 是说明性示例,**没有** `example` 标记;R20 的十个 schema(`RsiBase`、`RsiPolicy`、`RsiState`、`RsiProjectIndex`、`RsiCounts`、`RsiCursor`、`RsiPurgeJournal`、`RsiTaintMark`、`RsiStopMark`、`RsiLogLine`)的带标记合法 / 错误示例在 §20.14,已在 `test/contracts/registry.ts` 登记(`RsiSnapshot` / `RsiLockDoc` 的示例矩阵在 `test/contracts/rsi-lock-snapshot.test.ts`);错误示例断言「状态、阻断范围、原因码」三者,不只断言 zod 成败。

通用约定(沿用 §17 / §18 / §19):

- stdout 只含计数、枚举、id、哈希前缀;`--json` 为 canonical JSON、键集合固定。**唯一例外**:`rsi projects` 与 `rsi confirm` 输出经清洗的目录名(R20-3.5.2),`rsi projects --paths` 输出经清洗的绝对路径(R20-3.5.3)。stderr 只含稳定码 `RSI_<类别> reason=<码>` 或本节的顶层稳定码,不回显异常消息、文件内容、绝对路径、用户名、项目名。
- 单行日志用 `canonicalJsonLine`(与 `canonicalJson` 同键序规则,但无缩进、无多余空白、恰一个末尾 `\n`;§20.9 第 20 条)。
- 数字参数用 `parseDecimalUint`;未知参数、重复的单值参数、`--x=y` 写法一律退出 2 `RSI_USAGE reason=unknown_arg`(poke / hint 例外,见 R20-3.2.1 / R20-3.3.1)。
- 退出码沿用 §2,多结果用 `combineExitCodes`(3 > 2 > 1 > 4 > 64 > 0)。
- 时钟、随机源、进程存活判据、TTY 判据、文件系统读写都可注入(假时钟、假 `isAlive`、经 `read-fs` / `safe-fs` 注入的读写审计桩),测试不依赖真实时间。

### 20.1 范围与不变量

**决策**

- R20-1.1 **自动路径零 LLM、零联网**:从 `rsi poke`、`rsi hint`、`__rsi --background`、`rsi tick|status|projects|confirm|stop|purge` 各自的入口**分别**起算的 import 传递闭包,都不含 `src/io/llm-exec.ts`、`src/reflect/backends/**`、`src/io/net.ts`。现有 `src/update/launcher.ts → install.ts → net.ts` 的链意味着这些入口**不得**经过现有启动器(R20-1.2a、§20.9 第 3 条)。唯一允许的子进程是 poke / 顺带调度经零网络的 `runSelf` 桥接起 worker。A8 的 no-net 垫片下这些命令零网络调用。
  > **v3.1 修订(§21.18 第 12 条,V1 生效)**:追加允许的子进程——worker 经 `runSync('git')` 与封闭配置操作私有仓库(R21-3.6,零网络);自动入口闭包另不得含 `src/rsi/contrib/publish/**`、`src/rsi/exec/host/**`、`src/rsi/exec/isolated/**`;前台的明确例外见 R21-1.4(`rsi contrib submit` 由 kit 发起联网;`rsi exec-run` / `rsi isolation probe` 执行宿主脚本 / 容器)。
- R20-1.2 **默认关闭**:`~/.config/agent-kit/config.toml` 不存在、没有 `[rsi]`、`[rsi] enabled` 不是布尔 `true` → 状态 `off`。不存在任何「缺省开启」的路径(变异:缺省改为开启 → 契约测试红)。
- R20-1.2a **入口路由**:根入口 `cli.ts` 遇到 `rsi poke`、`rsi hint`、`__rsi --background` 时,**不**调用 `launchCurrent`(不转发到 `current`)、不调用 `noticeAutoSyncDeclined`、不调用 update 的 `scheduleBackground`,直接加载本包自己的 rsi 入口;因此这三者不会输出 `UPDATE_CURRENT_BROKEN` / `AUTO_SYNC_DECLINED`,也不会顺带起 update worker。代价:钩子触发时跑的是被调用的那份包(可能是引导版本),不是 `current`(待定夺 Q25)。其余 rsi 前台命令照常经启动器。验收用**真实发布产物**(`dist/cli.js` 子进程)测:`current` 损坏、存在待提示的自动同步记录、TTY / 非 TTY 四种组合下,poke / hint 的 stdout、stderr 为空且零写入。
- R20-1.3 **状态机**:`off`、`armed`、`confirmed`、`stopped`。状态由「配置 + `.state/rsi/state.json` 的确认记录 + 停止标记」经唯一实现 `rsiStateOf()`(`src/rsi/state.ts`)现算,不存一个可被改成 `confirmed` 的状态字段:

| 状态        | 判据(按顺序,先命中先算)                                                        | 允许读                                                                 | 允许写                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `off`       | §20.2 结果为 `off` 的配置问题;或(只对自动入口)`KIT_AUTO_RSI=0` 等 R20-1.6 条件 | 用户配置文件本身                                                       | 无                                                                                                                              |
| `stopped`   | 配置可用,且 `.state/rsi/STOP` 存在                                             | 已有的 `.state/**`(只为展示与管理)                                     | `rsi confirm`(清标记)、`rsi purge --write` / `--resume`、`rsi status --ack`;自动写入一律不做                                    |
| `armed`     | 配置可用、无停止标记、没有**有效**确认记录(R20-1.5)                            | 会话根的目录项;每个会话文件的头部预读(R20-1.4);已有的 `.state/**` 只读 | `.state/rsi/{state.json,log.jsonl,snapshot.json,counts.json,lock}`、poke 预留与 hint 去重标记、`rsi purge --write` / `--resume` |
| `confirmed` | 配置可用、无停止标记、确认记录有效                                             | 会话文件全文(经 reader,受 §20.6 上限)                                  | `.state/rsi/**`、`.state/{signals,sessions,salt}`、暂存 run 与 `.state/promote/**` 的 taint 改写(R20-4.7)                       |

> **v3.1 修订(§21.18 第 42 条)**:`off` 行追加允许 `rsi auto clear --write` 对 HOME 登记表、`.local/state/agent-kit/rsi-personal/`、私有仓库与本机 payload 的撤销(R21-9.5);`stopped` 行追加允许 `rsi auto clear --write`、`rsi rollback --to --write`、`rsi veto`(R21-9.4)。

- R20-1.4 **`armed` 零读正文**:对会话文件只允许 ①目录项列举(`readdir` / `lstat`);②**一次**从偏移 0 起、长度 ≤ 64KiB(`RSI_ARMED_HEAD_BYTES`)的物理读取。读到的字节里第一个 `\n` 之后的部分**直接丢弃**:不交给任何解析器、不保存、不计入任何输出(N5 衡量两件事:物理 I/O 为每个文件至多一次 ≤ 64KiB 的读;交给解析器的字节至多是首行)。首行用固定的轻量头部解析器取 cwd 与会话元数据,**不调用** reader 的 `read()`、不调用 `Redactor`、不读不建盐。首行取不到 cwd(没有 `\n`、不是 JSON、无 cwd 字段)→ 该会话计入归属不明,不再往下读。 (订正见 §20.14 B4 订正 #2)
- R20-1.5 **确认记录**(`state.json` 的 `confirm`)只由 `rsi confirm` 写入(R20-3.6)。以下任一成立即**无效**、退回 `armed`:①排除被放宽(确认时的任一排除项哈希不在当前集合里);②当前 `agents` 含确认时没有的 agent;③`repo` 的 `realpath` 或 `(dev, ino)` 与确认时不同;④overlay 的有无或内容 sha256 与确认时不同;⑤kit 主版本不同;⑥记录过不了 schema。收紧排除、减少 agent、新增项目都不使确认失效;新增项目在 `confirmed` 下自动纳入(D9),在 hint、`rsi status`、`rsi projects` 里单列「新增项目 n」(R20-4.2a)。
- R20-1.5a **首次 `armed` 与失效后的 `armed`**:从未确认过的仓库,`armed` 下 `.state/{signals,sessions,salt}`、`projects.json`、`cursor.json` **不存在**(N5 的验收面);确认失效退回 `armed` 时这些文件已经存在,`armed` 的约束是**不新建、不修改、不读会话正文**,已有数据只给 `rsi status` / `rsi projects` 只读展示和 `rsi purge` 删除用,不删除旧库来「满足」N5(待定夺 Q19)。
- R20-1.6 **跳过触发**:以下任一成立,poke、hint、顺带调度、worker 一律空操作(零写入、退出 0、stdout 为空):`KIT_AUTO_RSI=0`;`KIT_RSI_CHILD=1`(kit 手动 `reflect --run-llm` / `judge --run-llm` 起的 LLM 子进程,§20.9 第 5 条);任一 CI 变量为真(与 update 同一张 `CI_ENV_KEYS`);`KIT_LAUNCHED` 已设且不为 `0` 时**只**跳过顺带调度(同 §19.5)。`KIT_AUTO_RSI` 只能关不能开(`=1` 与未设相同)。前台命令(`rsi status|projects|confirm|stop|purge|tick`)不受 `KIT_AUTO_RSI` 影响。
- R20-1.7 **顺带调度白名单**:只有 `build`、`check`、`sync`、`reflect`(不带 `--run-llm`、不带 `--gc`)在命令结束后顺带调度,且 stdin 与 stdout 都是 TTY;`doctor`、`update`、`rsi *`、`__update`、`__rsi`、只带 `--version` / `--help` 的调用、任何读取用户配置失败的情况一律不调度(设计稿 §4.1,评审 v2 #15)。与 update 的 `scheduleBackground` 并列、互不影响,失败不改变用户命令的退出码。顺带调度的代码同样在零网络的桥接模块里(R20-1.1)。
- R20-1.8 **自动路径永不做**:apply、`promote`、`attest`、`retire`、`judge`、sync 写全局、开 PR、对外通知、改用户配置 / 覆盖层 / `team_project_keys`、`rsi purge`、`rsi confirm`。
  > **v3.1 修订(§21.18 第 13 条,V1 生效)**:对个人层,apply(写私有仓库)、生效(注入 / 本机 safe sync)、回滚、退役改为允许;其余照旧永不,并追加推送任何远端、发版、建 tag、改 agent 配置、`rsi auto resume`、打开 `[rsi.auto] exec` 等(完整表见 R21-1.3)。只有前台 `rsi contrib submit` 在逐次确认后开草稿 PR。
- R20-1.9 **钩子参数不可信**:poke / hint / worker **不读 stdin**(钩子会把含会话路径的 JSON 写到 stdin;不读、不解析、不等待其关闭),不使用调用方 cwd,不接受路径类参数。worker 的会话根、仓库、状态目录只来自 §20.2 的固定来源。

**不变量(测试钉死)**

- R20-1.10 `off` 与 R20-1.6 的跳过情形下,poke / hint / 顺带调度在 §20.8.1 的范围内零写入,且 safe-fs 写审计桩调用次数为 0。
- R20-1.11 首次 `armed`:读审计桩对每个会话文件至多记录一次偏移 0、≤ 64KiB 的读;reader `read()`、`Redactor.apply` 调用次数为 0;`.state/{signals,sessions,salt}`、`projects.json`、`cursor.json` 不存在。失效后的 `armed`:同样的读约束,且这些文件的内容 sha256 前后不变。 (订正见 §20.14 B4 订正 #2)
- R20-1.12 poke / hint / worker / 各命令都调用 `rsiStateOf()`;测试对 4 种状态 × 每个跳过条件 × 首次 / 失效两种 `armed` 做矩阵。

### 20.2 用户级配置 `[rsi]`

**位置与校验**

- R20-2.1 唯一入口:`<真实 HOME>/.config/agent-kit/config.toml`(`getRealHome()`;测试经 `KIT_REAL_HOME_OVERRIDE`)。kit 只读、永不写;不读 `XDG_CONFIG_HOME`,不跟随会话 cwd,不接受命令行或环境变量指定别的配置文件。
- R20-2.2 读之前逐段 `lstat` 校验 `.config`、`.config/agent-kit`、`config.toml`:都不是符号链接;属主都是当前 uid;`mode & 0o022 == 0`;文件是普通文件、`nlink == 1`、≤ 64KiB。比 update 读同一文件更严(update 现有行为不变,§20.9 第 1 条)。
- R20-2.3 `[rsi] repo`(启用时必填):绝对路径;`realpath(repo) === repo`;是目录;属主为当前 uid 且 `mode & 0o022 == 0`;直接含普通文件 `kit.toml`。rsi 命令与 worker 的仓库根**只**取它;全局 `--root` 给了且 `realpath` 不同 → 退出 2 `RSI_USAGE reason=root_mismatch`。
- R20-2.4 `[rsi] overlay`(可选):绝对路径、链上无符号链接、普通文件、属主为当前 uid、`mode & 0o022 == 0`,且过 `OverlaySchema`。用途:脱敏词表(`sensitive_words`、`internal_domains`)、`exclude_dirs`(与 `[rsi] exclude_dirs` 取并集)、`team_project_keys`(只读)。不给 overlay 时照常采集,`rsi status` 报 `warnings: ["overlay_absent"]`。
- R20-2.5 状态目录 = `<repo>/.state/`。rsi 的全部入口(自动与前台)**忽略** `KIT_STATE_DIR` 与 `KIT_WRITE_ROOTS`,除非同时设了 `KIT_TMP`(测试夹具),保证前台与后台读写同一份状态(待定夺 Q7)。

**分层解析(R20-2.6;错误优先级按表中从上到下,先命中先报)**

| 层        | 内容                                                                                                                                                                   | 失败结果                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| L-file    | 文件存在性、R20-2.2 校验、读取                                                                                                                                         | `off`                          |
| L-toml    | TOML 解析                                                                                                                                                              | `off`                          |
| L-base    | `RsiBaseSchema`(strict):`enabled`、`repo`、`overlay`、`agents` 的类型;`exclude_dirs` / `exclude_names` 只校验为「字符串数组、≤ 256 项」;`session` 只校验为「表或缺省」 | `off`                          |
| L-enabled | `enabled === true`                                                                                                                                                     | `off`(`disabled`)              |
| L-repo    | R20-2.3                                                                                                                                                                | `off`                          |
| L-overlay | R20-2.4(仅当给了 overlay)                                                                                                                                              | **停止采集**                   |
| L-policy  | 排除项内容:`exclude_dirs` 每项绝对路径、≤ 4096 字节、无 NUL / 控制字符;`exclude_names` 每项 1..255 字节、无 `/`、非 `.` / `..`、无 NUL / 控制字符                      | **停止采集**                   |
| L-session | `[rsi.session]`(P1 的 `RsiSessionSchema`)                                                                                                                              | **只禁用会话授权**(P1);L0 照常 |

> **v3.1 修订(§21.18 第 19 条)**:L-base 对 `auto`、`capability`、`contrib` 与 `session` 一样只校验为「表或缺省」;其后追加 L-auto / L-cap / L-contrib 三层,失败只禁用对应能力(R21-2.1)。

| 键              | 类型                              | 缺省                      | 约束                                                         |
| --------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `enabled`       | boolean                           | `false`                   | 字符串 `"true"` 在 L-base 失败(`cfg_schema`),不是 `disabled` |
| `repo`          | string                            | —                         | `enabled = true` 时必填(缺失 → `repo_invalid`)               |
| `overlay`       | string                            | 不设                      | R20-2.4                                                      |
| `agents`        | `("claude" \| "codex" \| "pi")[]` | `["claude","codex","pi"]` | 去重后非空;其它值在 L-base 失败(待定夺 Q12)                  |
| `exclude_dirs`  | string[]                          | `[]`                      | L-policy                                                     |
| `exclude_names` | string[]                          | `[]`                      | L-policy                                                     |
| `session`       | 表                                | 不设                      | P1 占位(§20.10)                                              |

示例(说明性,TOML 解析后的对象):

```json
{
  "rsi": {
    "enabled": true,
    "repo": "/home/u/agent-kit",
    "overlay": "/home/u/.config/agent-kit/overlay.toml",
    "agents": ["claude", "pi"],
    "exclude_dirs": ["/home/u/clients"],
    "exclude_names": ["client-x"]
  }
}
```

错误示例:`exclude_dirs` 含相对路径 → 状态照算(`armed` / `confirmed`),阻断范围 = 停止采集,原因码 `exclude_invalid`(不是「少排除一项继续采」)。

```json
{ "rsi": { "enabled": true, "repo": "/home/u/agent-kit", "exclude_dirs": ["clients"] } }
```

**原因码(R20-2.7,`rsi status` 的 `reason` 与日志只报码)**

| 问题                                                                          | 结果                                                                                          | 原因码                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 文件不存在 / 无 `[rsi]`                                                       | `off`                                                                                         | `absent` / `no_section`                                                                           |
| 符号链接 / 属主 / 组或其他人可写 / 非普通文件或硬链接 / 超 64KiB / 读取权限错 | `off`                                                                                         | `cfg_symlink` / `cfg_owner` / `cfg_perm` / `cfg_not_regular` / `cfg_too_large` / `cfg_unreadable` |
| TOML 解析失败 / L-base 失败                                                   | `off`                                                                                         | `cfg_parse` / `cfg_schema`                                                                        |
| `enabled` 为 `false` 或缺省                                                   | `off`                                                                                         | `disabled`                                                                                        |
| `repo` 缺失或不合规                                                           | `off`                                                                                         | `repo_invalid`                                                                                    |
| overlay 不合规                                                                | 停止采集                                                                                      | `overlay_invalid`                                                                                 |
| 排除项内容不合规                                                              | 停止采集                                                                                      | `exclude_invalid`                                                                                 |
| `exclude_dirs` 某项不存在                                                     | 照常生效(按字面前缀排除;挡住重建后的同路径)                                                   | —                                                                                                 |
| 重复项                                                                        | 去重,不报错                                                                                   | —                                                                                                 |
| 项目索引损坏 / 缺失 / 盐指纹不符                                              | 继续采集但不给摘要:L0 写信号库,索引不被覆盖(只能 `--rebuild-index` 替换),所有输出把信号计入 U | `index_invalid` / `index_absent`                                                                  |
| `[rsi.session]` 不合规或过期                                                  | 只禁用会话授权(P1)                                                                            | `session_invalid` / `session_expired`                                                             |
| 某 agent 会话根链上有符号链接、不是目录;pi 且 `PI_CODING_AGENT_DIR` 已设      | 该 agent 记 `not_evaluated`,其余照常                                                          | `root_symlink` / `root_not_dir` / `pi_dir_override`                                               |

- R20-2.8 「停止采集」:状态照算(`armed` / `confirmed`),`rsi status` / `rsi projects` 照常展示已有数据;worker、`tick --write` 不读任何会话文件(结果 `skipped_collect_blocked`);hint 输出空串。
- R20-2.9 会话根固定:claude `~/.claude/projects`,codex `~/.codex/sessions`(不含 `archived_sessions`),pi `~/.pi/agent/sessions`。只读普通文件(`lstat` 判定;符号链接、FIFO、设备跳过并计数 `skipped_not_regular`),沿用单行 64MiB 上限。`PI_CODING_AGENT_DIR` 的「已设置」语义要传到 worker:poke 发现它已设时给 worker 环境加 `KIT_RSI_PI_DIR_SET=1`(只传存在性,不传路径;§20.9 第 2 条);钩子环境里没有该变量时(例如 claude 的钩子),worker 读默认 pi 根,这是已知差异。

### 20.3 命令面、退出码与稳定码

```
agent-kit rsi tick [--write] [--json]
agent-kit rsi poke --agent <claude|codex|pi>
agent-kit rsi hint --agent <claude|codex|pi>
agent-kit rsi status [--json] [--ack]
agent-kit rsi projects [--json | --paths] | --rebuild-index [--write] [--json]
agent-kit rsi confirm
agent-kit rsi stop
agent-kit rsi purge (--project <绝对路径> | --excluded | --resume) [--write] [--json]
agent-kit __rsi --background          (内部入口,不进 --help、不在 COMMANDS;只接受这一个精确形状,别的参数退出 2)
```

`rsi` 不带子命令或子命令未知 → 退出 2 `RSI_USAGE reason=unknown_subcommand`。P1 预留子命令(`digest`、`session`、`hooks`、`dismiss`、`should-continue`)在 P0 注册为命令桩,退出 64(§7)。

**稳定码总表(R20-3.0;实现从 `src/contracts/rsi.ts` 的一份枚举生成,测试断言文档与枚举一致)** (订正见 §20.14 B3 订正 B3b-3、B3c-7) (订正见 §20.14 B4 订正 #1)

| 类别                                    | 码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 退出 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `RSI_USAGE reason=`                     | `unknown_subcommand`、`unknown_arg`、`missing:--agent`、`bad_agent`、`mode_conflict`、`not_tty`、`paths_requires_tty`、`write_requires_mode`、`bad_path`、`root_mismatch`                                                                                                                                                                                                                                                                                                                                     | 2    |
| `RSI_NOT_RUN reason=`                   | `off`、`stopped`、`collect_blocked`、`locked`、`locked_over_ttl`、`not_confirmed`、`no_journal`                                                                                                                                                                                                                                                                                                                                                                                                               | 4    |
| 顶层(4)                                 | `RSI_SNAPSHOT_BUSY`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 4    |
| 顶层(1)                                 | `RSI_RUN_TAINTED`、`RSI_RUN_ATTRIBUTION_UNKNOWN`、`RSI_PURGE_NOT_EXCLUDED`、`RSI_CONFIRM_DECLINED`、`RSI_CONFIRM_STALE`                                                                                                                                                                                                                                                                                                                                                                                       | 1    |
| `RSI_FAIL_CLOSED reason=`               | 配置:`cfg_symlink`、`cfg_owner`、`cfg_perm`、`cfg_not_regular`、`cfg_too_large`、`cfg_unreadable`、`cfg_parse`、`cfg_schema`、`repo_invalid`、`overlay_invalid`、`exclude_invalid`;状态:`state_invalid`、`state_dir_unsafe`、`index_invalid`、`cursor_invalid`、`counts_invalid`、`snapshot_invalid`、`journal_invalid`、`signal_store_corrupt`、`salt_invalid`、`redactor_init`、`staging_too_large`、`staging_unsafe_entry`;运行:`lock_lost`、`write_denied`、`purge_incomplete`、`output_leak`、`internal` | 3    |
| 计数码(不改退出码,只进 `--json` 与日志) | `RSI_FILE_TOO_LARGE`、`RSI_LIMIT_FILES`、`RSI_LIMIT_BYTES`、`RSI_LIMIT_TIME`、`RSI_LIMIT_DEPTH`、`RSI_LIMIT_ENTRIES`、`RSI_INDEX_FULL`                                                                                                                                                                                                                                                                                                                                                                        | —    |
| P1 预留(不实现)                         | `RSI_INGEST_TOO_LARGE`、`RSI_STAGING_FULL`、`RSI_DIGEST_*`、`RSI_SESSION_*`                                                                                                                                                                                                                                                                                                                                                                                                                                   | —    |

配置类原因码只在**前台命令确实需要读配置并因此无法继续**时以 `RSI_FAIL_CLOSED` 报出(例如 R20-4.8 的暂存区即时闸);`rsi status` 遇到同样的配置问题退出 0、在 `reason` 字段里报码;自动入口一律静默空操作。设计稿里的顶层码 `RSI_INDEX_INVALID` 在本节写作 `RSI_FAIL_CLOSED reason=index_invalid`(与 §19 风格一致)。

#### 20.3.1 `rsi tick [--write] [--json]`(A2)

- R20-3.1.1 **无 `--write` = 纯计划,零写入**:算出将读的文件数、字节数、预计新增信号数、项目 P / X / U / n、cursor 指纹是否匹配,打印后退出 0。不拿锁、不建目录;盐存在则只读,不存在则用内存临时盐(`--json` 里 `salt: "ephemeral"`,此时不输出依赖 key 的计数)。读快照不一致 → 退出 4 `RSI_SNAPSHOT_BUSY`。属 A5 零写入命令集。 (订正见 §20.14 B4 订正 #4)
- R20-3.1.2 `--write`:前台执行一次完整 L0,不受节流与 L0 间隔约束,受锁、状态机、资源上限约束;`armed` 下只做列举并更新 `state.json` / `counts.json` 的计数;`confirmed` 下采集。成功(含 `ok_partial`)清除熔断(R20-6.6)。熔断打开时照常执行——它是用户清除熔断的入口。 (订正见 §20.14 B4 订正 #4)
- R20-3.1.3 退出码:0;2;3(`RSI_FAIL_CLOSED`);4(`off`、`stopped`、`collect_blocked`、`locked`、`locked_over_ttl`、`RSI_SNAPSHOT_BUSY`)。
- R20-3.1.4 `--json` 键集合固定:`mode`、`state`、`reason`、`salt`、`files_planned`、`files_read`、`bytes_read`、`signals_new`、`sessions_new`、`projects`(`{collecting, excluded, new}`)、`unknown_signals`、`skipped`(`{not_regular, too_large, unchanged, excluded, self_state, unknown_project}`)、`limits_hit`(计数码数组,升序)、`cursor`(`{fingerprint_match, full_scan: {epoch, done}}`)、`duration_ms`。不含路径、key、项目名。

#### 20.3.2 `rsi poke --agent <id>`(A3,钩子专用)

- R20-3.2.1 **不阻塞宿主**:退出码恒 0;stdout、stderr 恒为空(参数错误也不输出);不读 stdin、不等 stdin 关闭。自身工作有 1s 的**尽力**预算(`RSI_POKE_BUDGET_MS`):每一步之间查一次已耗时,超出即放弃、退出 0;Node 启动与单个同步系统调用的耗时不受这条约束,验收以「stdin 为永不关闭的管道时,进程在 2s 内退出」判定。
- R20-3.2.2 判定顺序:R20-1.6 跳过条件 → 配置(`off` / 停止采集 → 空操作)→ 状态(`stopped` → 空操作)→ 熔断打开且未到半开时间 → 空操作 → L0 到期(读 `state.json` 的 `last_tick.completed_at`,距今 ≥ 6h 或时钟往回走)→ 不到期则空操作 → 启动预留(R20-6.2)→ 经零网络的 `runSelf` 桥接起 `__rsi --background`(`self` 目标:本包自己的 `dist/cli.js`;detached、stdio 丢弃、`unref`;`cwd` 固定为 `[rsi] repo`,需给 `RunSelfOptions` 加受校验的 `cwd`,§20.9 第 3 条)。
- R20-3.2.3 **可诊断状态**:只有走到启动预留才写入:预留标记 + `log.jsonl` 一行(`trigger=poke`、`agent`、`action=spawned|spawn_failed`)。其余分支零写入,原因由 `rsi status` 现算(配置、状态、熔断、到期),不依赖 poke 留痕。
- R20-3.2.4 `--agent` 缺失、非法或不在 `[rsi] agents` 里 → 空操作(不报错)。

#### 20.3.3 `rsi hint --agent <id>`(A3)

- R20-3.3.1 退出码恒 0;任何失败(参数、配置、快照不一致、超过 1s 尽力预算、索引损坏)输出空串。读集合**仅限**:用户配置与 overlay(排除项并集);`.state/rsi/{snapshot.json,state.json,projects.json,counts.json}`;对索引里的根路径做 `lstat` / `realpath`(元数据读取,≤ `RSI_INDEX_MAX_ENTRIES` 次,用于 R20-4.3 的 U 判定)。不读盐(用 `projects.json` 与 `counts.json` 各自的 `salt_fp` 互相核对)、不读信号库、不读会话文件、不拿锁。
- R20-3.3.2 输出为下列模板之一加一个 `\n`,或空串;**≤ 200 字节**(含换行,`Buffer.byteLength`);不含路径、项目名、key、摘录、会话 id。每个计数显示 `min(n, 9999)`,超过写 `9999+`。 (订正见 §20.14 B4 订正 #3)

```
confirmed:agent-kit RSI: 新信号 N、待反思聚类 K、待审提案 M、项目 P(新增 n、排除 X、归属不明 U)。仅在用户要求时使用技能 agent-kit-rsi。
armed:    agent-kit RSI: 待确认,将采集 P 个项目。仅在用户要求时运行 agent-kit rsi confirm。
```

(`confirmed:` / `armed:` 是本表的标签,不是输出。所有计数取最大显示值时,前者含换行 194 字节、后者 106 字节。)

- R20-3.3.3 计数口径(全部由 `counts.json` + 当前配置 + 当前索引现算,R20-4.6):N = 近 7 个 UTC 日内由 L0 新增、归属为「采集中」的信号数;K = 剔除 X 与 U 的证据后,仍达到 reflect 干跑聚类门槛(与 reflect 干跑同一常量)的聚类数;M = 证据全部归属「采集中」且不是 tainted 的暂存 run 里的提案数;P / X = 采集中 / 已排除项目数;n = 新增项目数(R20-4.2a);U = 归属不明信号数。 (订正见 §20.14 B4 订正 #3)
- R20-3.3.4 输出条件:`confirmed` 下 K ≥ 3(`RSI_HINT_MIN_CLUSTERS`)或 M ≥ 1 或 n ≥ 1;`armed` 下恒输出第二个模板;其余状态空串。同一 agent 30 分钟(`RSI_HINT_DEDUP_MINUTES`)内只输出一次:输出前独占创建 `.state/rsi/hint/<agent>-<窗口序号>`,`EEXIST` → 空串。这是 hint 唯一的写入;输出空串的调用零写入(待定夺 Q5)。
- R20-3.3.5 P0 只有纯文本。claude / codex 钩子要求的 JSON 输出形状(`hookSpecificOutput.additionalContext`)是 P1(A5)的 `--format`;P0 传 `--format` 按参数错误处理(退出 0、空串)。

> **v3.1 修订(§21.18 第 14 条,V1 生效)**:新增 `--canary` 分组路径(R21-6.2、R21-6.10、R21-6.11):只由「每会话开始一次」的钩子形状调用,不受 30 分钟去重;被随机的会话两组都输出中性关联标记,treat 组另附 ≤ 1536 字节的通用规则正文与「自动产出、未经核验」标记;标记对 G1 / G2 豁免,reader 识别后排除出评估指标(R21-6.9)。写入扩为去重标记、分组账一行、周报标记(均独占创建或单行追加,不拿锁);读集合只追加 `canary.json`、`canary-admission.json`、`AUTO_PAUSE`。计数行模板与 ≤ 200 字节不变;每周首次改输出周报行(R21-13.2)。

#### 20.3.4 `rsi status [--json] [--ack]`(A2)

- R20-3.4.1 只读(`--ack` 除外),不拿锁,按快照协议读(R20-5.6)。退出码:0(含 `off`、停止采集、存在 tainted run——这些是状态,不是错误);2;3(状态文件存在但过不了 schema);4 `RSI_SNAPSHOT_BUSY`。
- R20-3.4.2 `--json` 键集合固定:`state`、`reason`、`first_armed`(布尔,R20-1.5a)、`overlay`(`absent|ok|invalid`)、`agents`(`[{id, status: ok|not_evaluated, reason}]`)、`counts`(`{projects_collecting, projects_excluded, projects_new, unknown_signals, signals_total, signals_new_7d, clusters_pending, staged_runs, staged_proposals, tainted_runs}`)、`last_tick`(`{at, trigger, outcome, code, duration_ms, files_read, bytes_read}` 或 `null`)、`breaker`(`{state: closed|open|half_open, kind: retryable|safety|null, consecutive_failures, until}`)、`index`(`{status: ok|absent|invalid, entries}`)、`cursor`(`{status: ok|absent|invalid, fingerprint_match, full_scan: {epoch, done, last_completed_at}}`)、`snapshot`(`ok|absent|stale|invalid`)、`confirm`(`{confirmed_at, policy_fp12, invalid_reason}` 或 `null`)、`stop`(`{present, at}`)、`purge`(`{journal: absent|present}`)、`lock`(`free|held|held_over_ttl|stale|unsafe`;D7:`rsi/` 或锁文件元数据不合规时是 `unsafe`,不是读不到)、`tainted`(`[{run_id, reason}]`,`reason` ∈ `exclude|purge`;**只列 id 与原因码**,这是 `RSI_RUN_TAINTED` 拒绝面之外唯一的展示)、`warnings`(`overlay_absent`、`cloud_sync_suspected`、`index_full`、`breaker_open`)。不含路径、key、项目名。 (订正见 §20.14 B3 订正 B3a-3)
- R20-3.4.3 `--ack`:需要 stdin 与 stdout 为 TTY(否则 `not_tty`),拿锁,把 `state.json` 的 `projects_ack_generation` 设为当前索引 `generation`(「新增项目 n」清零)。

#### 20.3.5 `rsi projects`(A2)

- R20-3.5.1 缺省文本:每行一项,按 `status` 分别成形:`collecting` / `excluded` / `purge_pending` / `new` 行为 `key=<p_ 后 8 位> name=<目录名> sessions=<n> signals=<n> status=<…>`;`unknown` 行为 `key=<p_ 后 8 位> sessions=<n> signals=<n> status=unknown`(**无** name、无 path,N7);末行 `projects collecting=P excluded=X new=n unknown_signals=U`。按 key 升序。首次 `armed`(无盐)的行形如 `key=- name=<目录名> sessions=<n> status=pending`(现算,R20-4.2),归属不明会话只计入末行的 `unknown_sessions=`。`purge_pending` = 已排除但信号库仍有该 key 的信号。 (订正见 §20.14 B3 订正 B3a-2、B3a-4)
- R20-3.5.2 目录名 = 最近一次见到的根路径的 basename,清洗:C0 / C1 控制字符、Unicode 格式字符(含 bidi 覆盖与隔离、零宽字符)、私用区与未分配码点替换为 `?`,按码点边界截到 64 字节。
- R20-3.5.3 `--paths`:只在 stdout 是 TTY 时允许(否则 `paths_requires_tty`),与 `--json` 互斥(`mode_conflict`);`collecting` / `excluded` / `purge_pending` / `new` 行末追加 `path=<路径>`(同 R20-3.5.2 的清洗,不截断长度;`unknown` 行不追加)。
- R20-3.5.4 `--json`(键集合固定):`{state, first_armed, rows: [{key8, name, sessions, signals, status}], summary: {collecting, excluded, new, unknown_signals, unknown_sessions}}`;`unknown` 行的 `name` 为 `null`;首次 `armed` 的 `key8` 为 `null`。
- R20-3.5.5 `--rebuild-index [--write]`:`confirmed` / `stopped` / 失效后的 `armed` 下可用(首次 `armed` 无盐 → 退出 4 `not_confirmed`);用 rsi 口径(R20-4.1:canonical cwd)重新解析会话 cwd、用本机盐重算 key;干跑打印将写入的条目数与将变为可归属的信号数;`--write` 拿锁、整体替换 `projects.json`。旧索引有效时保留各 key 的 `first_indexed_generation`;旧索引无效时重建条目一律记 `first_indexed_generation = 0`(不算新增)。信号库里有、按 rsi 口径重算不出来的 key(例如手动 `signals collect --allow-project <父目录>` 采的,其 key 是 allow 路径的哈希)仍计入 U,**不**用新算出的 key 冒充。 (订正见 §20.14 B4 订正 #10)
- R20-3.5.6 泄漏闸:stdout 里出现 HOME、`KIT_TMP`、状态目录、仓库根的绝对路径 → 整份作废,退出 3 `output_leak`;**豁免只限 `--paths` 行的 `path=` 字段值**。退出码:0;2;3;4(`RSI_SNAPSHOT_BUSY`、`not_confirmed`)。

#### 20.3.6 `rsi confirm`(A2)

- R20-3.6.1 stdin 与 stdout 都必须是 TTY(否则 `not_tty`,退出 2);状态必须是 `armed` 或 `stopped`(`off` → 退出 4;`confirmed` → 退出 0,stdout `confirm already`)。
- R20-3.6.2 展示:做一次 `armed` 列举(R20-1.4,不读正文),打印与 `rsi projects` 相同的清单与汇总、固定说明(将读取这些项目的会话全文并脱敏后存入本机信号库;排除写法;`rsi stop` / `rsi purge` 的作用),然后要求输入 `yes`。同时在内存记下**展示指纹**:`repo` 的 `realpath` 与 `(dev, ino)`、`agents`、规范化排除项哈希集合、overlay 的有无与 sha256、kit 主版本。
- R20-3.6.3 输入不是 `yes` → 退出 1 `RSI_CONFIRM_DECLINED`,零写入。输入 `yes` → 拿锁 → 重读配置与状态、重算展示指纹;与展示时任一项不同 → 退出 1 `RSI_CONFIRM_STALE`,零写入(用户须重新运行看新清单,待定夺 Q18)。一致才写 `state.json` 的 `confirm` 记录 `{confirmed_at, kit_major, agents, exclude_hashes, repo_dev_ino, overlay_sha256, policy_fp, baseline_pending: true}`(不存路径原文)、删停止标记、清熔断。 (订正见 §20.14 B4 订正 #7)
- R20-3.6.4 TTY 判据只是**尽力**区分人与脚本(有 shell 的 agent 可以开伪终端),不是安全边界(设计稿 §6.3)。

#### 20.3.7 `rsi stop`(A2)

- R20-3.7.1 独占创建 `.state/rsi/STOP`(内容 `{at, by: "user"}`;已存在则不改,退出 0)。**不拿 `rsi/lock`**,须能在 worker 持锁时写入。不需要 TTY。配置不可用时找不到仓库:退出 0,stdout `stop noop reason=<码>`(此时 worker 在下一个检查点也会因配置不可用而放弃,R20-6.8)。 (订正见 §20.14 B3 订正 B3a-1)
- R20-3.7.2 三种语义分开承诺:①**停止未来调度**:标记存在期间 poke、顺带调度、`tick --write` 不再起采集;②**阻止下一次**:已预留、尚未拿到锁的 worker 拿锁后先查标记,存在即退出,不读任何会话文件;③**终止运行中**:持锁的 worker 在下一个检查点(R20-6.8)看到标记,放弃本次全部未提交结果、不推进 cursor、释放锁,日志记 `stopped`。①②在标记落盘后成立;③的时延上界是一个检查点间隔,不是零。已提交的信号不被撤回(删除用 `rsi purge`)。
- R20-3.7.3 清除:只有 `rsi confirm`(待定夺 Q11)。

#### 20.3.8 `rsi purge`(A2)

- R20-3.8.1 `--project <绝对路径>` / `--excluded` / `--resume` 三选一(否则 `mode_conflict`;`--project` 非绝对路径 → `bad_path`)。命中集合 K:`--excluded` = 当前判为已排除的全部 key;`--project <p>` = 索引里任一见过的根路径落在 `p` 之内(按 R20-4.4 口径)的 key,且**每个**命中 key 当前都已被排除,否则退出 1 `RSI_PURGE_NOT_EXCLUDED`、零写入(待定夺 Q8)。
- R20-3.8.2 干跑打印命中 key 数,将删的信号 / 会话计数行 / cursor 条目 / 索引条目数,将 taint 的暂存 run 与 promote 产物数,以及固定说明「已合进 git、发成 PR 或 `git apply` 到工作树的内容不在 kit 管辖范围」。`--write` 要求 TTY、状态为 `armed`(已有数据时)/ `confirmed` / `stopped`、拿锁。
- R20-3.8.3 删除范围:命中 key 的信号(重写 `.state/signals/<agent>/<yyyymm>.jsonl`)、会话计数行、cursor 条目、索引条目、`counts.json` 里相应的统计、`.state/rsi/digests/` 下全部文件(P1 才会有);**不删**盐、日志(本来不含 key)、暂存 run 与 promote 产物的目录(按 N6 taint,R20-4.7)。
- R20-3.8.4 **事务**:拿锁 → 写 `.state/rsi/purge-journal.json`(`RsiPurgeJournal`:命中 key 集合、**此刻经信号库算出的待 taint 目标集合**(暂存 run id 与 promote 产物 id)、阶段 `planned → tainted → signals_rewritten → indexed → done`)→ taint 目标集合里的每一项(R20-4.7)→ 重写信号库与会话计数(逐文件临时文件 + rename)→ cursor、索引、`counts.json` → 快照清单 → 删 journal。续做一律按 journal 里**已记下的**目标集合,不重新从信号库推导(信号可能已删)。
- R20-3.8.5 **续做入口**:journal 存在时,①`rsi purge --resume --write`(前台;`armed` / `confirmed` / `stopped` 均可,`stopped` / `armed` 的自动写禁令对它不适用——它完成的是用户已授权的删除);②`confirmed` 下的 worker 与 `tick --write` 在做自己的事之前先续做;③hint 输出空串、`rsi status` 报 `purge.journal = present`;④R20-4.8 的读暂存区命令退出 3 `purge_incomplete`。配置为 `off` 时没有入口(找不到仓库),此时 hint 与 P1 digest 也都不输出,不构成泄漏;配置恢复后先续做(待定夺 Q21)。续做失败 → `RSI_FAIL_CLOSED reason=purge_incomplete`(熔断按 safety)。没有 journal 时 `--resume` 退出 4 `no_journal`。
- R20-3.8.6 退出码:0 完成 / 干跑;1 `RSI_PURGE_NOT_EXCLUDED`;2;3;4(`locked`、`off`、首次 `armed` 的 `not_confirmed`、`no_journal`)。

#### 20.3.9 `__rsi --background`(A3,worker)

- R20-3.9.1 `src/cli.ts` 单独识别,只接受这一个精确形状;不输出;stdio 丢弃;环境经 `runSelf` 的具名白名单(需追加 `KIT_AUTO_RSI`、`KIT_RSI_CHILD`、`KIT_RSI_PI_DIR_SET`,§20.9 第 2 条)。
- R20-3.9.2 流程:重读配置与状态 → 拿 `rsi/lock`(拿不到 → 日志 `skipped_locked`)→ 锁内:快照未完成提交则重建(R20-5.6)→ 续做 purge journal(仅 `confirmed`)→ 把所有已有 `TAINTED` 的清理补完(R20-4.7)→ 查停止标记 → 查熔断 → 再查 L0 到期 → 记 attempt(R20-6.4)→ 记下本次**运行绑定**(`repo` 的 `realpath` 与 `(dev, ino)`、`policy_fp`、`agents`、确认记录的 `confirmed_at`)→ `armed` 列举或 `confirmed` 采集 → 新的 taint → 提交(R20-6.9)→ 记结果、更新熔断 → 释放锁。
- R20-3.9.3 worker 调用的采集、索引、taint、提交都是**不拿锁**的服务函数,参数必须带调用方持有的锁句柄(类型上不可缺省),每个提交点前 `assertHeld()`;手动 `signals collect`、`rsi tick --write` 是顶层,自己拿锁后调用同一组服务函数。

### 20.4 项目索引、排除、purge 与 taint(N5 / N6 / N7)

**项目根与 key**

- R20-4.1 rsi 路径的「项目根」= 会话 cwd(reader 的 `cwd_hint`)经 `exclude.ts` 的 `canonical()`(最长已存在前缀的 realpath + 去尾斜杠;需导出)后的路径,即现有 `signals collect` **无 allow 名单分支**的 `projectRoot`;`project_key = projectKeyFor(salt, 项目根)`(§9)。手动 `signals collect --allow-project <绝对路径>` 命中时 `projectRoot` 是 allow 路径(父目录下多个子目录共享一个 key),这一差异保留:手动 collect 更新索引时记的是它自己用的 `projectRoot`,所以 key 与根路径仍对应;只有 `--rebuild-index` 重算不出这类 key(R20-3.5.5)。P0 不向上找 git 根(待定夺 Q3)。cwd 为空、相对路径、取不到 → 归属不明。

**索引 `.state/rsi/projects.json`(`RsiProjectIndex`,0600)**

- R20-4.2 只在有盐之后由持锁写入方维护(worker、`tick --write`、手动 `signals collect`、`--rebuild-index --write`、purge);首次 `armed` 下不存在,`rsi projects` / `rsi confirm` 在首次 `armed` 下现算清单、不落盘(待定夺 Q2)。

```json
{
  "schema_version": 1,
  "salt_fp": "3f2a9c1d7e4b",
  "generation": 42,
  "entries": [
    {
      "key": "p_0123456789abcdef",
      "roots": [
        {
          "path": "/home/u/work/proj",
          "dev": 16777230,
          "ino": 1234567,
          "first_seen": "2026-10-23",
          "last_seen": "2026-10-24"
        }
      ],
      "sessions": 3,
      "signals": 17,
      "first_indexed_generation": 40
    }
  ]
}
```

- `salt_fp` = `sha256(盐)` 前 12 位,写入方对照真实盐;不符 → 整个索引按 `index_invalid`。`entries` 按 `key` 严格升序、唯一;每个 key 的 `roots` 1..8 条(保留最早一条与按 `last_seen` 最近的 7 条);`path` 是绝对路径、≤ 4096 字节、无 NUL;条目 ≤ 10000(`RSI_INDEX_MAX_ENTRIES`),满了新 key 不再入索引(其信号计入 U,计数码 `RSI_INDEX_FULL`,`warnings` 报 `index_full`)。`generation` 每次写入加一。日期只到天。
- 索引只在本机、只给 `rsi projects --paths` 与 hint / status 的现算用;路径与目录名不进 hint、status、日志、计数投影、P1 digest。
- R20-4.2a **新增项目 n**:`first_indexed_generation > state.json.projects_ack_generation` 且归属「采集中」的 key 数。确认后的第一次成功 L0 把 `projects_ack_generation` 设为该次写入的 `generation` 并清 `baseline_pending`(确认时看过的清单不算新增);之后由 `rsi status --ack` 推进。用 generation 而不用时间戳,时钟回拨不影响。 (订正见 §20.14 B4 订正 #7)

**归属判定(N7,R20-4.3)** (订正见 §20.14 B3 订正 B3c-4、B3c-11)

每个 key 现算并且**只**落入一类(优先级从高到低):

1. **已排除(X)**:该 key 的任一 `roots[].path` 命中当前排除规则(R20-4.4);根路径已不存在也照算(按字面前缀)。
2. **归属不明(U)**:索引缺失 / 损坏 / `salt_fp` 与 `counts.json` 不符;key 不在索引里;所有根路径都已不存在;最近一次见到的根路径现在的 `realpath` 与记录不逐字节相等(大小写变化、NFC / NFD 变化、经由别的符号链接);或其 `(dev, ino)` 与记录不同(换卷、删后重建)。
3. **采集中(P)**:其余。

- U 只以「信号条数」出现在 hint、`rsi status --json`、`rsi tick --json`、`log.jsonl` 里;`rsi projects` 里 U 行只有 key 前缀与计数。
- 移动 / 改名:新根产生新 key、新条目;旧 key 落入 U(或 X)。排除按「该 key 见过的任一根路径」判。

**排除比较口径(R20-4.4)**

- 排除项与根路径都先 `canonical()`。`exclude_dirs` 命中 = 根路径等于排除路径或位于其下(按 `/` 段边界);`exclude_names` 命中 = 任一根路径的 basename 等于该名字。**比较时折叠大小写**(只会多排除),另加:排除路径当前存在时,根路径的任一祖先目录 `(dev, ino)` 与之相同也算命中(认出 NFD、firmlink、大小写不敏感卷上的同一目录)。设计稿 §8 的「不无条件折叠大小写」针对 allow 名单的放宽方向;rsi 路径没有 allow 名单,折叠只是更保守(待定夺 Q4)。
- 自我排除照旧(`withSelfExclusion`:状态目录内或含 `.state/reflect/cwd` 段 → `self_state`)。
- rsi 路径不要求「至少一条排除或 allow」(D9);手动 `signals collect` 的默认拒绝不变。

**计数投影 `.state/rsi/counts.json`(`RsiCounts`,R20-4.5)**

hint / status 现算所需的数据,由每个持锁写入方在提交时重算并写入:`{schema_version, salt_fp, generation, computed_at, cluster_min, per_key: {<key>: {signals_total, sessions, signals_by_day: {<YYYY-MM-DD>: n}}}, clusters: [{cluster_id, evidence_by_key: {<key>: n}}], staged: [{run_id, proposals, evidence_keys: [<key>], tainted}], unknown_keys_signals}`。`signals_by_day` 只保留最近 8 个 UTC 日;`clusters` ≤ 500、`staged` ≤ 5000;`evidence_keys` 里映射不到 key 的证据记为字面量 `"?"`(按 U 处理)。`reflect --run-llm` 新建暂存 run、`judge` 改写提案、taint 之后都在同一把锁内更新 `staged`。

**排除立即对历史生效(R20-4.6)**

- 判定点:hint、`rsi status`、`rsi projects`、`rsi tick --json` 的计数,R20-4.8 的暂存区即时闸,以及 P1 的 digest / ingest,**每次调用时**按当前配置 + 当前索引 + `counts.json` 现算 X / U,不使用任何缓存的排除结论。写下排除后的**下一次**调用即不再把该项目算入 P、K、N、M、n,不需要等待重采。
- 写下排除不删除数据(信号库、会话计数、索引保留);删除只走 `rsi purge`。

**taint(N6,R20-4.7)** (订正见 §20.14 B3 订正 B3c-2、B3c-3、B3c-10)

> **v3.1 修订(§21.18 第 15 条,V1 生效)**:taint 扩到自动产出:未生效候选永不进灰度,已生效候选进回滚;对自动产出,「立即生效」收窄为「下一次 hint 起不再注入、不再作新证据」,静态撤销单独报告完成,已进模型上下文的收不回(R21-11.5)。

- 目标:①暂存 run `.state/reflect/<run_id>/`,其任一提案或暂存原子的证据 `sig_id` 映射到的 key 属于已排除或 purge 命中集合;②`.state/promote/<promo_id>/`,其 `report.json` 指向的 run 是①中的 run(这些产物含证据摘录,待定夺 Q22)。映射经信号库(`sig_id` → 信号的 `project_key`);映射不到的不触发 taint,但受 R20-4.8 的归属闸约束。
- 时机:排除写下后,下一次任何持锁的 rsi 写入(worker、`tick --write`、`purge --write`、`--rebuild-index --write`、`confirm`)在提交前完成;purge 在删信号之前按 journal 完成。
- 动作(持 `rsi/lock`,逐项,顺序固定):①独占创建 `TAINTED`(内容 `{reason: "exclude"|"purge", at}`);②把 `proposals/*.yaml` 与 `rules/**` 里**全部**证据的 `excerpt` 置为空串(不只命中的那几条;空串合法,不改 `Proposal` / `AtomFrontmatter` schema,待定夺 Q14);promote 产物则删 `promote.patch` 与 `pr-body.md`;③删除 `apply.patch`;④保留 `report.json`、提案 id、目录与编号(`loadUsedProposalIds` 结果不变)。先落标记,崩溃在中途时读路径照样拒。
- **续做**:每个持锁写入方在锁内**先**扫一遍所有带 `TAINTED` 的 run 与 promote 产物,把②③补到完成(不因标记已存在而跳过);这一步不依赖信号库映射。注入崩溃于①之后、②中途、③之前三处,恢复后都必须是「全部摘录为空、无 `apply.patch`」。
- 已经合进 git、发成 PR、或被 `git apply` 到工作树的内容不在 kit 管辖范围,purge 与 taint 都清不到。

**暂存区即时闸(R20-4.8)** (订正见 §20.14 B3 订正 B3c-1)

- 适用命令:`judge --run`(含干跑)、`promote --run`、P1 的查看 / 导出命令。它们读暂存区之前先做,并在**写出任何输出、发起任何 LLM 调用之前再做一次**:
  1. 有 `TAINTED` → 退出 1 `RSI_RUN_TAINTED`(stdout / stderr 只给 `run_id` 与原因码);
  2. 按当前配置与索引现算该 run 的证据归属:任一属于 X → 同样 `RSI_RUN_TAINTED`(原因 `exclude`),不必等 taint 落盘;任一属于 U(含索引缺失 / 损坏、盐不符、`sig_id` 在信号库里映射不到)→ 退出 1 `RSI_RUN_ATTRIBUTION_UNKNOWN`,零 LLM 调用、零输出写入(待定夺 Q20);
  3. purge journal 存在 → 退出 3 `purge_incomplete`。
- 生效条件:`[rsi]` 状态为 `armed` / `confirmed` / `stopped` 时才做;没有 `[rsi]` 段或 `enabled` 不为真时**不做**(兼容现有手动流程);`[rsi]` 存在但配置不可用(`cfg_*` / `repo_invalid` / `overlay_invalid` / `exclude_invalid`)时无法判断排除,一律退出 3(待定夺 Q9)。
- `promote --run` 因此加入锁矩阵:读暂存区到写完 `.state/promote/<id>/` 期间持 `rsi/lock`,写之前做第二次检查;`judge` 本来就持锁(R20-5.1)。

### 20.5 锁与并发

**资源—命令—锁矩阵(R20-5.1)**

| 资源                                                                                 | 写入方(拿 `rsi/lock`)                                                                                                                                  | 只读方(不拿锁)                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 信号库 `.state/signals/**`、会话计数 `.state/sessions/**`、盐 `.state/salt`          | worker、`rsi tick --write`、手动 `signals collect`(非 `--dry`)、`rsi purge --write` / `--resume`                                                       | `rsi tick` 干跑、`signals collect --dry`、reflect 干跑、`attest`、`calibrate` |
| `projects.json`、`cursor.json`、`counts.json`、`snapshot.json`、`purge-journal.json` | worker、`rsi tick --write`、手动 `signals collect`、`rsi purge --write` / `--resume`、`--rebuild-index --write`;`counts.json` 另有下一行的暂存区写入方 | hint、`rsi status`、`rsi projects`、`rsi tick` 干跑                           |
| `state.json`(确认、熔断、attempt、计数游标)、`log.jsonl` 的整体改写                  | 上述全部写入方 + `rsi confirm`、`rsi status --ack`                                                                                                     | hint、`rsi status`、poke                                                      |
| 暂存区 `.state/reflect/<run>/`、promote 产物 `.state/promote/<id>/`                  | `reflect --run-llm`、`judge --run-llm`、`reflect --gc --write`、`promote --run`(写路径)、taint 方                                                      | reflect 干跑、`rsi status`(只读 `counts.json`)                                |
| LLM cwd `.state/reflect/cwd/`                                                        | `reflect --run-llm`、`judge --run-llm` 另拿现有 `reflect/llm.lock`                                                                                     | —                                                                             |
| 停止标记 `STOP`、poke 预留标记、hint 去重标记、`log.jsonl` 单行追加                  | 独占创建 / `O_APPEND` 单行追加,**不拿锁**(`rsi stop`、poke、hint、任一写入方)                                                                          | 全部                                                                          |

- R20-5.2 **锁序**:`rsi/lock` → `reflect/llm.lock`。`reflect --run-llm`、`judge --run-llm` 先拿 `rsi/lock` 并在整个 LLM 调用期间持有(上限:reflect `max_calls ≤ 3` × 600000ms ≈ 30 分钟;judge `--max-calls ≤ 10` × 600000ms ≈ 100 分钟,另加开销);这段时间 worker 拿不到锁就跳过(待定夺 Q15)。两把锁都是**试锁**(拿不到立即报占用,不排队),不会死锁。现有 `llm.lock` 用链接 mtime 判 15 分钟过期、整段回调期间不续期,所以超过 15 分钟的 judge 期间它**可能**被另一个进程回收:新版本里外层 `rsi/lock` 已使同一仓库的 reflect / judge 互斥,只剩「新旧两个版本并发」的残余(§20.9 第 7 条)。
- R20-5.3 锁文件位置 `<realpath(stateDir)>/rsi/lock`;同一仓库经不同路径写法访问是同一把锁。
- R20-5.4 **嵌套**:顶层(worker、`tick --write`、`signals collect`、`purge`、`confirm`、`--ack`、reflect / judge / promote / gc 的写路径)拿锁一次;内部服务函数不拿锁、只接受锁句柄并在提交点 `assertHeld()`。同一进程第二次获取 `rsi/lock` 视为编程错误(`internal`),不重入。

**陈旧锁协议(R20-5.5,复用 §19.5 update 锁的规则)**

- 获取:safe-fs 新增的 `createExclusive`(`O_CREAT|O_EXCL|O_NOFOLLOW`,§20.9 第 4 条),内容 `{pid, started_at, nonce, kit_version}`,0600。
- 已存在:空文件且创建不满 10 秒 → 本次报占用;内容可解析且 pid 存活(`process.kill(pid, 0)` 成功,或报 `EPERM`——`EPERM` 算存活)→ 占用,超过 TTL 15 分钟(`RSI_LOCK_TTL_MINUTES`)只报 `locked_over_ttl`,**不杀、不删**;pid 不存在(`ESRCH`)→ 回收:删除前复读,与先前读到的逐字节相同才删,再重新独占创建;内容损坏且创建满 10 秒 → 同样复读确认后回收。
- 每个提交点(重写信号库文件、写索引 / cursor / 计数 / 快照 / `state.json` / journal、taint 每一项、删 journal)前 `assertHeld()`:锁文件的 nonce 仍是自己的,否则立即停止、不再写,`lock_lost`。
- 已知残余(照 §19.5 写明,不弱化):两个回收者先后删除的竞态只靠 nonce 复核缩小窗口;pid 被无关长寿进程复用时会一直报 `locked_over_ttl`,需要用户手工删 `.state/rsi/lock`(`rsi status` 的 `lock: held_over_ttl` 与这句提示是唯一的处理方式);状态目录被两台机器经云同步共用时 pid 判据无意义(不支持,`cloud_sync_suspected` 只是启发式提示)。

**快照清单与恢复(R20-5.6,设计稿 §8a.8)**

- `.state/rsi/snapshot.json`(`RsiSnapshot`):`{schema_version, generation, written_at, files: [{name, sha256, bytes}]}`。`name` 只能取自固定集合 `state.json`、`projects.json`、`cursor.json`、`counts.json`,或匹配 `^(signals|sessions)/(claude|codex|pi)/\d{6}\.jsonl$`;不得重复、按字节序升序、≤ 2000 项;读取方**只**按这个白名单拼路径,不按清单内容任意读文件。`generation` 只增。
- **提交义务**:任何写了 `state.json`、`projects.json`、`cursor.json`、`counts.json` 或信号库 / 会话计数文件的持锁写入方(包括 attempt 预写、confirm、`--ack`、熔断更新、taint 后的 `counts.json` 更新),都在**最后一步**用临时文件 + rename 替换快照清单。poke、hint、`rsi stop` 不写这些文件,不更新清单。
- 只读方:先读清单,再读自己需要的文件并核对 sha256 与字节数;不一致重读一次(重新取清单),仍不一致 → hint 输出空串,`rsi status`(`snapshot: stale`)/ `rsi projects` / `rsi tick` 干跑退出 4 `RSI_SNAPSHOT_BUSY`。只核对自己读的文件。
- **不一致 ≠ 损坏**:「各文件都过 schema 但与清单不符」= 未完成提交(上次写入方在替换清单前崩溃);任一文件过不了 schema = 损坏。持锁写入方拿锁后先检查:未完成提交 → 按当前文件重建清单(不改任何数据文件)后继续;损坏 → 安全阻断。所以崩溃在「文件已提交、清单未替换」时,下一次任何持锁写入(或用户 `rsi tick --write`)就恢复,不会永久卡住。清单缺失 = 从未提交过,不是错误。

**与 update 锁的关系(R20-5.7,如实写明)**

rsi 的锁(仓库 `.state/`)与 update / sync 的锁(HOME 下 `.local/state/agent-kit/`)谁也不拿对方的,没有跨组锁序,也不构成互斥。worker 拿到 `rsi/lock` 后若看到 `update/lock` 存在且持锁 pid 存活,本次以 `skipped_update_busy` 结束(正常跳过,不计熔断)。这只是**尽力降低资源竞争**,不是互斥保证:检查之后 update 照样可以开始。worker 由 `runSelf` 的 `self` 目标起,跑的是起它的那份包;update 切换 `current` 不影响已在跑的 worker。

**R20-A1 实装后订正(块 A1:`rsi/lock` 与快照清单的库与测试;命令接线未做,见末条)**

- R20-5.2 ~ R20-5.5 已实现:`src/rsi/lock.ts` 导出 `acquireRsiLock`(试锁)、`withRsiLock`(拿锁 → 回调 → 必释放)、`peekRsiLock`(只读,给 `rsi status` 的 `lock:` 行用)、`makeIsAlive`。获取失败抛 `RsiLockError`,`kind` 为 `locked` / `locked_over_ttl` / `lock_lost` / `state_dir_unsafe` / `write_denied` / `internal`,`toStable()` 给出 `RSI_NOT_RUN reason=locked|locked_over_ttl`(退出 4)或 `RSI_FAIL_CLOSED reason=<kind>`(退出 3)。常量(`RSI_LOCK_TTL_MINUTES`、`RSI_LOCK_PARTIAL_GRACE_MS`、`RSI_SNAPSHOT_MAX_FILES`、稳定码枚举等)与 `RsiLockDocSchema` / `RsiSnapshotSchema` 在 `src/contracts/rsi.ts`;稳定码枚举与 R20-3.0 总表的一致性由 `test/contracts/rsi-lock-snapshot.test.ts` 断言。
- 与上文条款的差异 / 补充(实现取的形状):①pid 判据比条文更保守——只有 `ESRCH` 才算「不存在」,`EPERM` 与其它任何错误都按存活、不回收;②空文件与内容损坏两种情形统一用锁文件 mtime 判 10 秒;③回收前复读除「逐字节相同」外还要求仍是同一个 inode;④`rsi/` 目录或锁文件是符号链接 / 非普通文件 / 硬链接(nlink>1)/ 属主不是当前 uid / 权限宽于 0600(目录 0700),或锁文件远大于正常内容(> 64KiB,不读不比较不回收)→ `RSI_FAIL_CLOSED reason=state_dir_unsafe`(不顺着链接建锁、不覆盖;校验是对已打开句柄的 fstat,见 R20-7.2 一行);写入方 `rsiDir()` 对**自己的** `rsi/` 目录权限过宽时收紧到 0700(目录属主不是当前 uid 则拒绝);只读入口(`peekRsiLock`、快照读取)不建目录、不 chmod、不收紧;⑤同一进程对同一真实路径第二次获取(含经不同路径写法解析到同一把锁)→ `internal`;⑥`beforeReclaim` 是测试缝,用来演练判定与删除之间的换锁竞态。评审(Pi)提醒并确认的残余,不弱化:回收的「复读」不是条件删除,两个回收者仍可能先后删掉对方刚建的新锁;`assertHeld()` 是丢锁检测不是 fencing,检查与 rename / 写入之间仍有窗口——因此该实现是缩小双持有窗口,不是严格互斥(与 §19.5 同口径)。
- R20-5.6 已实现:`src/rsi/snapshot.ts` 导出 `commitSnapshot`(持锁写入方的最后一步,临时文件 `snapshot.json.tmp` + rename;rename 前再 `assertHeld()`)、`recoverSnapshot`(持锁写入方拿锁后第一件事:`absent` / `consistent` / `rebuilt`,损坏抛 `RsiSnapshotError`)、`readVerified`(只读方:`ok` / `no_snapshot` / `busy` / `invalid`,不一致时重取清单重读一次)、`readSnapshot`。契约原文未写 `name` 的基准目录,实现取:四个固定名在 `.state/rsi/` 下,`signals/…` / `sessions/…` 月文件在 `.state/` 下;`generation` 首次提交为 1、之后逐次 +1;清单项只收白名单里**实际存在**的普通文件。读取前校验(R20-7.2)按两类口径:`.state/rsi/` 下的目录与固定文件(`snapshot.json`、四个固定名)——符号链接 / 非普通文件 / 硬链接 / 属主不是当前 uid / 权限宽于 0600(目录 0700)→ 写入方抛 `state_dir_unsafe`、只读方返回 `unsafe`(`readSnapshot` 的 `{kind:'unsafe'}`、`readVerified` 的 `{status:'unsafe'}`),不自动收紧;`.state/{signals,sessions}` 月文件沿用 state-store 的口径,只拒符号链接 / 非普通文件 / 硬链接(写入方视为 `signal_store_corrupt`,只读方 `invalid`),**不拒宽权限**;父目录 `signals/<agent>` 是符号链接同样视为损坏 / `invalid`。只读方遇到状态目录或 `rsi/` 不存在按「清单缺失」处理(`no_snapshot`),不创建目录。各数据文件的完整 schema(`RsiState` 等)属 A2,`recoverSnapshot` 的校验函数 `SnapshotValidator = (name, bytes: Uint8Array | null) => boolean` 可注入:`bytes === null` 表示「已提交清单里有、磁盘上现在没有」,由调用方判定它是不是必需文件(返回 `false` → 抛该文件的损坏码,如 `state.json` 缺失 → `state_invalid`,清单不改写);缺省 `structuralValidator` 对缺失一律放行(保持「cursor / counts 被 purge 重写后仍是未完成提交」的行为),只做结构检查——**A2 接入时仍须传入各文件的完整 schema 校验与「必需文件」规则**,否则 `{}` 这类形状合法的损坏、或必需文件被删,会被当成未完成提交而重新认证(固定名文件是 JSON 对象;JSONL 文件以换行结尾、每行是对象,信号库行另过 `SignalSchema`、会话计数行另过 `SessionStatSchema`);损坏时按文件映射原因码:`state.json` → `state_invalid`、`projects.json` → `index_invalid`、`cursor.json` → `cursor_invalid`、`counts.json` → `counts_invalid`、信号库 / 会话计数 → `signal_store_corrupt`;清单自身损坏 → `snapshot_invalid`。`readVerified` 的 `busy` 由命令层映射为 `RSI_SNAPSHOT_BUSY`(A2)。 (订正见 §20.14 B3 订正 B3c-5、B3c-9)
- 读取与上限(评审 P2 两条,已实现):①读取不再「先 lstat、再 `readFile(path)`」:`src/io/read-fs.ts` 的 `readFileSafe` 以 `O_NOFOLLOW | O_NONBLOCK` 打开,对**句柄** fstat 校验(普通文件、`nlink == 1`,提供 owner 策略时再校验属主与权限位)、大小上限内有界读取;检查与读取之间路径被换成符号链接 / FIFO,得到 `unsafe` 而不是跟随或挂住(打开后被别人 unlink 的 `nlink == 0` 按「文件不存在」处理)。目录用 `statDirSafe`(`O_DIRECTORY | O_NOFOLLOW`)。锁文件、`snapshot.json`、固定数据文件、月文件都走它;测试缝 `beforeOpen`(锁:`RsiLockDeps.beforeRead`)用来确定性演练换链。②`RSI_SNAPSHOT_MAX_FILES`(2000)在**枚举阶段**执行(只 readdir / lstat,超出 → `snapshot_invalid`,此前不读任何数据文件内容);提交摘要逐文件计算 sha256 / 字节数后即释放,恢复时校验函数一次只拿到一个文件;`snapshot.json` 解析前有 1MiB 字节上限(超出 `invalid`),单个数据文件读入内存上限 256MiB(超出按该文件损坏)。**已知残余(不增加承诺)**:`O_NOFOLLOW` 只保护末级路径分量;目录检查与 `open` 之间,若父目录(`signals/<agent>`、`rsi/`)被同 UID 进程换成符号链接,`open` 仍会穿过它(Node 没有逐级锚定的 `openat`);`fstat` 也只是一个时点的校验,不冻结内容、权限或链接数。威胁模型与设计稿 §6.3(同 UID)一致,本实现是缩小窗口、不是 fencing。`O_NOFOLLOW` / `O_NONBLOCK` / `O_DIRECTORY` 在平台缺失时退化为 0,安全支持平台 = 具备这些常量与 `process.getuid` 的 POSIX。新建锁后的确认读取若发现锁文件不安全,报 `state_dir_unsafe`(不是 `locked`)。
- §20.9 第 8 条的「盐首建非原子」部分已实现:`loadSalt` 首建经 `createExclusive`,输家读赢家落盘的那份;首次读取与 `EEXIST` 之后的读取都对「普通文件但仍为空」有限等待(共约 1 秒,仍为空则照旧 `salt_invalid`,fail-closed,不是可靠的等待协议);盐的格式、权限、`sig_id` 算法不变;`state-store.ts` 头注释已删该句。第 7 条的 `src/reflect/backends/lock.ts` 头注释残余说明已加。
- **未做(依赖 A2)**:§20.9 第 6、7、8、11 条里「reflect / judge / gc / promote / `signals collect` 入口拿 `rsi/lock`」的命令接线,以及第 17 条(rsi 专用 `IoContext`)。原因:R20-1.3 要求 off 状态下这些命令与现在逐字节一致、不拿锁、不创建 `.state/rsi/`,而 off 与否要由 `[rsi]` 配置分层校验(R20-2.6)与 `rsiStateOf()` 现算——它们属 A2,A1 无法判定;不经它们就接线,会让未启用 rsi 的用户多出 `.state/rsi/`。接线时用 `withRsiLock` 包住写路径即可。`state-store.ts` 头注释里「并发的两次 collect 会互相覆盖(P0 接受)」一句因此保留,待接线时删除。§20.8.2 A1 行里依赖接线的项(「去掉任一命令的拿锁」变异、worker × 各命令的并发组合)随接线补测。

### 20.6 节流、预算与熔断

- R20-6.1 **触发白名单**:只有会话结束钩子调用的 `rsi poke` 与 R20-1.7 的顺带调度会起 worker。hint、status、projects 永不起 worker。
- R20-6.2 **启动预留**:判定 L0 到期后,独占创建 `.state/rsi/poke/<agent>-<窗口序号>`(窗口 = `floor(now / 30 分钟)`,`RSI_POKE_WINDOW_MINUTES`);创建成功的那一个才 spawn,`EEXIST` → 空操作。顺带调度用 `agent=kit`。所以每个 agent 每 30 分钟至多起一个 worker,四类合计至多四个;多出的在锁内查到期后立即结束(`skipped_throttled`)。worker 持锁时删除早于当前窗口 2 个以上的预留标记。时钟往回走时窗口序号变小、标记可能再次创建成功——最多多起一个 worker,锁内的到期判断兜底。
- R20-6.3 **L0 间隔**:相邻两次 L0 的完成时间 ≥ 6 小时(`RSI_L0_MIN_INTERVAL_HOURS`),时钟往回走视为到期;前台 `rsi tick --write` 不受此限(待定夺 Q6)。
- R20-6.4 **attempt 计数时间点**:worker 拿锁并通过到期判断之后、读任何会话文件之前,把 `state.json` 的 `attempt = {started_at, nonce}` 写盘(连同快照)。正常结束时清除并写 `last_tick`。下一次拿锁时发现 `attempt` 残留 → 先记一次 `crashed`(可重试错误)。
- R20-6.5 **结果分类**:

| 类别       | 结果码                                                                                                                                                                                                                                        | 对熔断                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 成功       | `ok`、`ok_partial`(触发 `RSI_LIMIT_*`,已提交部分结果)                                                                                                                                                                                         | 计数清零,熔断关闭                   |
| 正常跳过   | `skipped_off`、`skipped_stopped`、`skipped_collect_blocked`、`skipped_throttled`、`skipped_locked`、`skipped_update_busy`、`skipped_ci`、`skipped_child`、`skipped_binding_changed`、`stopped`                                                | 不变                                |
| 可重试错误 | `io_error`(`EIO` / `EAGAIN` / `EMFILE` 等)、`crashed`、`internal`                                                                                                                                                                             | 连续失败 + 1;达到 3 → 打开 24 小时  |
| 安全阻断   | `state_invalid`、`cursor_invalid`、`counts_invalid`、`snapshot_invalid`、`journal_invalid`、`signal_store_corrupt`、`salt_invalid`、`redactor_init`、`write_denied`、`lock_lost`、`state_dir_unsafe`、`purge_incomplete`、`staging_too_large` | 立即打开,`kind = safety`,不自动半开 |

> **v3.1 修订(§21.18 第 16 条)**:并列新增 `auto_paused`(R21-10.1 / R21-10.2):只停新增生效、不停采集与撤销路径;本表的 `safety` 熔断停采集。两者不互相替代。

- R20-6.6 **熔断**:`retryable` 打开后到 `until`(打开时刻 + 24h)之前自动路径空操作;到期后允许一次半开尝试,成功关闭,失败再开 24h。`safety` 只有前台 `rsi tick --write` 成功或 `rsi confirm` 才关闭,不自愈覆盖损坏的状态。`state.json` 本身过不了 schema 时无处记录熔断:自动路径按「状态不可读」空操作,`rsi status` 退出 3。
- R20-6.7 **资源上限**(严格计数类与尽力预算类分开写;超限不报错退出,计数码进 `--json` 与日志;cursor 只推进到最后一个完整提交的文件): (订正见 §20.14 B3 订正 B3c-8) (订正见 §20.14 B4 订正 #5)

| 项                                        | 上限                                                           | 性质与超限行为                                                                             |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 会话根目录项(`armed` 与 `confirmed` 都算) | 50000(`RSI_MAX_DIR_ENTRIES`)                                   | 严格。停止列举,`RSI_LIMIT_ENTRIES`;已列的照算                                              |
| `armed` 头部预读                          | 2000 个文件,每个 ≤ 64KiB                                       | 严格(物理读 ≤ 2000 × 64KiB = 125MiB)。`RSI_LIMIT_FILES`                                    |
| `confirmed` 单次 L0 读取的改动文件数      | 2000(`RSI_MAX_FILES_PER_TICK`)                                 | 严格。停在文件边界,`RSI_LIMIT_FILES`;未改动文件只 `lstat`,不计入                           |
| 单次 L0 读取字节                          | 256MiB(`RSI_MAX_BYTES_PER_TICK`)                               | 每个文件读完后检查,实际读取 ≤ 256MiB + 单文件上限 512MiB;`RSI_LIMIT_BYTES`                 |
| 单文件                                    | > 512MiB 跳过(`RSI_MAX_FILE_BYTES`,按 `lstat` 大小);单行 64MiB | 严格。`RSI_FILE_TOO_LARGE` 计数;cursor 记 `too_large`,文件变化前不再尝试                   |
| 单行 JSON 嵌套深度                        | 256(`RSI_MAX_JSON_DEPTH`;解析前按括号计数预扫)                 | 严格。该行按超大行处理(`oversized_lines` + `RSI_LIMIT_DEPTH`),不使会话失败(§20.9 第 14 条) |
| 单次 L0 墙钟                              | 120 秒(`RSI_MAX_TICK_MS`)                                      | **尽力**。在检查点(R20-6.8)生效,可超出一个检查点间隔;`RSI_LIMIT_TIME`                      |
| poke / hint 自身                          | 1 秒                                                           | **尽力**(R20-3.2.1、R20-3.3.1)                                                             |
| worker 并发                               | 1(`rsi/lock`)                                                  | 严格                                                                                       |
| 暂存区扫描(taint、计数)                   | 5000 个 run + 5000 个 promote 产物                             | 严格。超出 → `staging_too_large`(安全阻断:taint 不能只做一部分)                            |
| cursor 条目                               | 100000                                                         | 最久未见的先淘汰(被淘汰的文件下次按改动处理;`sig_id` 去重保证幂等)                         |
| `log.jsonl`                               | 200 行、每行 ≤ 1KiB                                            | 持锁写入方改写时截断到最近 200 行;无锁追加可暂时超出                                       |
| 暂存区容量                                | 50 个 run / 50MiB                                              | P1 拒收用(`RSI_STAGING_FULL`);P0 只计数                                                    |

- 处理顺序确定:agent(`claude`、`codex`、`pi`)→ 文件 mtime 升序 → 路径字节序。
- R20-6.8 **检查点**:每个会话文件开始前、每处理 1000 行、每个提交步骤前,worker 重新调用 `rsiStateOf()` 并比对本次**运行绑定**(R20-3.9.2):停止标记出现 → `stopped`;配置不可用或停止采集 → `skipped_collect_blocked`;状态不再是 `confirmed`、`repo` 身份变化、`policy_fp` 或 `agents` 变化(**包括只收紧排除**)→ `skipped_binding_changed`。三者都放弃本次全部未提交结果、不推进 cursor;下一次运行按新策略重来(收紧后的那次运行不会提交按旧策略读到的数据)。 (订正见 §20.14 B4 订正 #6)
- R20-6.9 **cursor、全量扫描与提交**:
  - `.state/rsi/cursor.json`(`RsiCursor`):`{schema_version, fingerprint, full_scan: {epoch, started_at, done, last_completed_at}, files: {<session_ref>: {agent, size, mtime_ms, dev, ino, project_key, epoch, status}}}`,其中 `project_key` 是 `p_…` 字符串或 `null`(归属不明),`status` ∈ `ok|too_large|read_error|excluded|self_state|unknown_project`。
  - `fingerprint` = sha256(采集器版本、各 reader 版本、脱敏规则版本、overlay 里与脱敏有关字段的 sha256、排除策略指纹(规范化排除项哈希 + agents)、`salt_fp`、kit 主版本)的 canonical JSON。
  - 文件「未改动」= `size`、`mtime_ms`、`dev`、`ino` 全等**且**其 `epoch` 等于当前 `full_scan.epoch`。
  - **全量扫描续跑**:指纹变化,或距 `last_completed_at` ≥ 7 天 → `epoch + 1`、`done = false`。此后每次 L0 只读「未改动」判定为假的文件,在 2000 个 / 256MiB 上限内按处理顺序推进;读过的文件写入新 `epoch`。所有文件都到达新 `epoch` 时 `done = true`、记 `last_completed_at`。截断不会让全量扫描从头再来,也不会饿死后面的文件(测试:4001 个文件、多次 tick,最终全部覆盖、每个文件在一个 epoch 里只读一次)。
  - **重读不迁移历史**:信号库按 `sig_id` 去重,已存在的信号行**不被改写**;脱敏规则或 overlay 词表变化后的重读只补采缺失的信号,不清洗已存的摘录,cwd 更正也不改旧信号的 `project_key`。要清掉旧摘录只能 `rsi purge`(待定夺 Q24)。
  - **提交顺序**:信号库 → 会话计数 → 索引 → `counts.json` → `state.json` → cursor → 快照清单。cursor 只在前面全部提交成功后写(变异:cursor 先于信号库提交 → 测试红)。
- R20-6.10 节流窗口、L0 间隔、熔断 `until`、hint 去重、7 天全量、锁 TTL 全部只经注入的时钟;测试覆盖时钟往回走与跨窗口边界;读取用可取消的注入实现,测试不把「定时器触发」当作「读取已停止」。

### 20.7 可观测性与隐私

- R20-7.1 **日志** `.state/rsi/log.jsonl`(0600):每行 `canonicalJsonLine` 的 `{at, trigger: poke|kit|tick|confirm|purge|stop|rebuild|status, agent?, action, code, counts?, duration_ms?}`;`counts` 只含整数;不含路径、key、目录名、会话 id、摘录、异常消息。`action` / `code` 只取本节的枚举。
  > **v3.1 修订(§21.18 第 17 条)**:追加 `.state/rsi/audit.jsonl` 与分组账 `.state/rsi/canary-ledger.jsonl` 及其保留策略(R21-12.10、R21-6.4)。
- R20-7.2 **权限与读取前校验**: (订正见 §20.14 B4 订正 #8、#9)
  - `.state/rsi/` 及其子目录 0700、文件 0600,一律经 safe-fs 写。读取 `.state/rsi/*` 前校验:不是符号链接、普通文件、`nlink == 1`、属主为当前 uid、权限不宽于 0600(目录 0700);不满足 → `state_dir_unsafe`(安全阻断),**不自动收紧**。
  - `.state/{signals,sessions}` 与盐沿用 `state-store.ts` 的现有行为(盐:链接 / 非普通文件 / 宽于 0600 → `SaltError`;信号目录与文件:写入时收紧到 0700 / 0600)。这是与 `.state/rsi/` 的有意差异,共享服务改造时保留,不改成拒绝。
  - 暂存区与 promote 产物沿用 §17 / §18 的读取校验(`FS_SYMLINK` / `FS_NOT_REGULAR` / `FS_HARDLINK`)。`.state` 本身与其上级的链接检查由 §5 safe-fs 的写入根 realpath 校验负责。
- R20-7.3 **输出边界**:hint ≤ 200 字节、只有计数;`rsi status` 只有枚举与计数;`rsi projects` 缺省给 key 前缀与目录名,绝对路径只在 `--paths` + TTY;stderr 只有稳定码。三处(外部可见输出、暂存与 promote 文件、`log.jsonl`)的泄漏断言见 §20.8。
- R20-7.4 **承诺措辞**:本节与实现的提示文案不出现「立即生效」「最坏只是…」「完全隔离」这类绝对承诺,只用以下可验证的边界:
  - 「写下排除后,下一次调用 hint / status / projects 时不再计入该项目」(R20-4.6);
  - 「`rsi stop` 后:不再调度新的采集;已预留未开始的 worker 不读会话文件;正在运行的 worker 在下一个检查点放弃未提交结果」(R20-3.7.2);
  - 「已提交的信号保留,直到 `rsi purge --write` 完成」;「kit 不会给出比上述输出边界更多的数据」;
  - 不承诺会话 agent 自己不去读原始会话文件(同 UID,设计稿 §6.3)。
- R20-7.5 **残余风险**(照写):脱敏是规则式的,有已登记的残余缺口(`redaction.md` §7),默认全部项目下漏网影响面最大;脱敏规则更新不清洗已存摘录(R20-6.9);项目索引是一份本机项目路径清单,与信号库同权限同位置,仓库在云同步目录下会被同步出去(`cloud_sync_suspected` 只按路径段启发式判断);用户可能从不运行 `rsi projects`。 (订正见 §20.14 B4 订正 #11)

### 20.8 验收口径

#### 20.8.1 零写入的判定方式与范围(设计稿 §8a.11)

- 判据两层,缺一不可:①**写调用审计**:经 safe-fs 注入的审计桩记录到的写调用(含 `mkdir`、`createExclusive`、`appendFile`、`rename`、`remove`、`chmod`)次数为 0——这一层能抓「建了又删」「写后还原」;②**前后快照**:下列范围内没有任何文件或目录的新增、删除、修改(内容 sha256、大小、权限位、文件类型),**包括空目录、锁文件、日志、cursor、索引、计数、快照、预留 / 去重标记、临时文件**。快照只证明前后差异,所以①不能省。
- 范围:仓库工作树(另跑 `git status --porcelain --ignored` 核对,`.state` 是 gitignored)、`.state/` 整棵(独立遍历)、假 HOME 的受管路径(`HOME_WRITE_TABLE` + `.config/agent-kit/` + `.local/state/agent-kit/`)、会话根(不比较 atime)、`KIT_TMP`(验收脚本自己的目录除外)。真实 HOME 验收沿用 §12.1 的「待人工归因」规则。每组都带一个正向对照(故意写一个文件,判据必须报出)。
- 场景:干跑、失败、被拒、被中断(在检查点注入 SIGTERM)四种分别验。
- 适用命令:`rsi tick`(无 `--write`)、`rsi status`(无 `--ack`)、`rsi projects`(非 `--rebuild-index --write`)、`rsi purge`(无 `--write`)、被拒的 `rsi confirm`(`DECLINED` / `STALE`)、off / 跳过情形下的 poke、输出为空串的 hint。这些命令加入 A5 命令清单,A5 环境加 `KIT_AUTO_RSI=0`(§20.9 第 16 条)。

#### 20.8.2 各块验收项与必须覆盖的变异点

| 块                                                                      | 机器可判验收项(引用条款)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 必须覆盖的变异点(变异后必须有测试红)                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R20**(契约)                                                           | `RsiBase`、`RsiPolicy`、`RsiState`、`RsiProjectIndex`、`RsiCounts`、`RsiCursor`、`RsiSnapshot`、`RsiPurgeJournal`、`RsiTaintMark`、`RsiStopMark`、`RsiLogLine` 的合法 / 错误示例矩阵(断言状态、阻断范围、原因码);R20-2.6 分层优先级;缺省 `enabled=false`;稳定码表与枚举一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 缺省改成开启;`agents` 接受 `kimi`;L-policy 失败被当成 `off`;快照 `name` 接受白名单外路径                                                                                                                                                                                                                   |
| **A1**(锁)                                                              | R20-5.2 ~ R20-5.5 锁库:多个进程争同一把锁,第二个报占用、读-改-写无交错;SIGKILL 后被回收;假 `isAlive` 恒真 → `locked_over_ttl` 不删;空锁文件 10 秒规则;nonce 被替换后 `assertHeld` 阻止下一次写;盐首建经 `createExclusive`,两个进程同时首建只得一个盐;每个提交步骤注入崩溃后,快照「未完成提交」都能被下一次写入方恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 回收前不复读;`assertHeld` 恒真;`EPERM` 当作 pid 不存在;未完成提交被当成损坏(永久卡住)                                                                                                                                                                                                                      |
| **A2**(tick / 索引 / 排除 / purge / status / projects / confirm / stop) | (自 A1 挪入,用户决定接线随 A2)R20-5.1 每个写入方都拿锁且仅在 `[rsi]` 启用时才拿(未配置时逐字节一致、不创建 `.state/rsi/`):并发组合(worker × 手动 collect / `tick --write` / `reflect --gc --write` / `reflect --run-llm`(stub)/ `judge`(stub)/ `promote --run` / purge)第二个报占用、无交错写;§20.9 第 6、7、8、11、17 条接线;只读入口零写入须有写调用审计(不只查最终目录状态);`recoverSnapshot` 的生产调用必须传完整 schema 校验与「允许缺失」规则(缺省结构校验放行任何缺失,不得作为生产默认);R20-3.1.1 干跑零写入(§20.8.1);`--write` 只写 `.state/{rsi,signals,sessions,salt}`;零网络;R20-1.11 两种 `armed` 的读写审计;R20-4.3 的 U 情形(索引缺项 / 损坏 / 盐不符 / 根路径消失 / 移动 / 大小写变化 / `(dev,ino)` 变化),U 在 hint、`status --json`、`log.jsonl` 只以计数出现;**写下排除后下一次 hint / status 的 P、K、N、M、n 即不含该项目(中间不跑 tick)**;purge 前后计数,journal 每阶段注入崩溃后 `--resume` 完成;大小写敏感卷(Linux tmpfs)与不敏感卷(macOS APFS 默认)各一组;confirm:非 TTY 拒、输入非 `yes` 零写入、等待输入期间改 `agents` / 排除 / `repo` / overlay → `RSI_CONFIRM_STALE` 零写入;stop 三种语义各一例;检查点处收紧排除 → `skipped_binding_changed` 且不提交;全量扫描 4001 文件覆盖 | 去掉任一命令的拿锁;索引过滤取反;cursor 先于信号库提交;`armed` 判断取反;taint 漏删 `apply.patch`;taint 只清命中证据的摘录;续做跳过已有 `TAINTED` 的项;`promote --run` 去掉即时闸;排除判定改读缓存;purge 不检查 `--project` 已排除;confirm 不重算展示指纹;检查点不比对运行绑定 (订正见 §20.14 B3 订正 B3b-6) |
| **A3**(poke / hint / worker)                                            | 假时钟:节流窗口、L0 6h、三类结果对熔断、半开、时钟回拨;R20-1.6 每个跳过条件零写入;R20-1.2a 真实 `dist/cli.js` 子进程四组合下 poke / hint 的 stdout、stderr 为空;poke 不读 stdin(永不关闭的管道下 2s 内退出);hint ≤ 200 字节(计数取极值)、无路径(植入种子路径与种子目录名,输出 grep 为 0)、失败输出空;poke、hint、worker、各前台入口的 import 闭包分别不含 `llm-exec` / `reflect/backends/**` / `net.ts`;`KIT_RSI_CHILD=1` 全空操作;`PI_CODING_AGENT_DIR` 已设时 worker 记 pi `not_evaluated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 节流比较取反;去掉预留检查(两个 poke 都 spawn);attempt 在读文件之后才写;hint 去掉字节上限;`KIT_AUTO_RSI` 判断去掉;rsi 入口改回经 `launchCurrent`                                                                                                                                                            |
| **隐私(N5 / N6 / N7)**                                                  | N5:首次 `armed` 下 `.state/{signals,sessions,salt}`、`projects.json`、`cursor.json` 不存在,`confirm` 后的 `tick --write` 才出现;N6:purge 与写下排除后,命中 run 的 `excerpt` 全空、`apply.patch` 不存在、`TAINTED` 存在,相关 promote 产物的 `promote.patch` 不存在,`promote --run` / `judge` 给 `RSI_RUN_TAINTED`,外部可见输出(stdout / stderr / `--json`)、暂存与 promote 文件、`log.jsonl` 三处 grep 被排除项目的种子摘录与种子路径均为 0;taint 落盘前的窗口(排除已写、未跑任何持锁命令)同样拒;N7:索引损坏时 `judge --run-llm`(stub)零调用、`RSI_RUN_ATTRIBUTION_UNKNOWN`;配置是符号链接或权限过宽 → `off`;索引损坏 → 计数全归 U,`--rebuild-index --write` 后恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | taint 顺序改成先清摘录后写标记(两步之间注入崩溃,读路径放行 → 红);即时闸去掉;U 证据放行到 judge                                                                                                                                                                                                             |

### 20.9 与现有契约的衔接 / 修订清单

「先改」= 必须在对应块实现之前改既有条款(否则实现违反现行契约或撞现有测试);「随块」= 与实现同一 PR 订正。

| #   | 既有条款                                                                         | 修订内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 时机                                                |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | §19.8 / §19.10 `UserConfig`(`strictObject`)                                      | 追加可选 `rsi`。**现状下用户一写 `[rsi]`,`UserConfig` 校验失败,`update` 退出 3 `config_invalid`、后台更新停摆**。推荐 `rsi: z.unknown().optional()`,由 `src/rsi/config.ts` 按 R20-2.6 分层校验,`[rsi]` 写错不连累 update(待定夺 Q1)                                                                                                                                                                                                                                                                   | **先改**(R20)                                       |
| 2   | §19.7 `RUN_SELF_ENV_KEYS` / `RUN_SELF_ENV_PICK_RE`                               | 追加 `KIT_AUTO_RSI`、`KIT_RSI_CHILD`、`KIT_RSI_PI_DIR_SET`(具名,不用通配)                                                                                                                                                                                                                                                                                                                                                                                                                             | **先改**(A3)                                        |
| 3   | §19.7 lint 闸(`runSelf` 只许 `launcher.ts`)、`RunSelfOptions`、根入口、§7 命令表 | 现有 `launcher.ts` 经 `install.ts` 传递引入 `net.ts`,rsi 入口不能经过它(R20-1.1)。需要:①把 rsi 对 `runSelf` 的用法放进一个**零网络**桥接模块(例如 `src/update/self-spawn.ts`,不引用 `install.ts` / `registry.ts` / `provenance.ts`),lint 闸对 `runSelf` 的放行从「仅 `launcher.ts`」扩为「`launcher.ts` 与该桥接模块」;②`RunSelfOptions` 加受校验的 `cwd`(必须等于 `realpath([rsi] repo)`);③根入口按 R20-1.2a 路由;④`src/cli.ts` 识别 `__rsi --background`;⑤§7 命令表加 `rsi` 一行。lint 闸由主代理改 | **先改**(A3)                                        |
| 4   | §5 safe-fs 导出表                                                                | 追加 `createExclusive(ctx, path, content, mode)`(`O_CREAT\|O_EXCL\|O_NOFOLLOW`,受 `writeRoots` 守卫);eslint 不变                                                                                                                                                                                                                                                                                                                                                                                      | **先改**(A1)                                        |
| 5   | §5.2 `llm-exec` 固定环境                                                         | 追加固定 `KIT_RSI_CHILD=1`(与 `NO_COLOR=1` 同类)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **先改**(A3)                                        |
| 6   | §17.7「gc 不拿跨进程锁」                                                         | `reflect --gc --write` 拿 `rsi/lock`,干跑不拿;「没有写入方会再往它里面写」加注:taint 只改写含 `proposals/` 的 run,而 gc 候选不含 `proposals/`,结论不变                                                                                                                                                                                                                                                                                                                                                | **先改**(A1)                                        |
| 7   | §17.1 / §17.2 reflect、judge 真跑;`src/reflect/backends/lock.ts`                 | 先拿 `rsi/lock` 再拿 `reflect/llm.lock`(R20-5.2);拿不到 → 退出 4 `REFLECT_NOT_RUN reason=locked` / `JUDGE_NOT_RUN reason=locked`(零调用零写入)。`llm.lock` 的 mtime 过期语义不变,在 lock.ts 头注释写明「超过 15 分钟的调用期间可能被旧版本进程回收」这一残余                                                                                                                                                                                                                                          | **先改**(A1) (订正见 §20.14 B3 订正 B3b-1 至 B3b-5) |
| 8   | §7 / §10.6 `signals collect`、`state-store.ts` 头注释                            | 非 `--dry` 拿 `rsi/lock`,按 R20-6.9 更新 cursor、索引、计数、快照;删除「并发的两次 collect 会互相覆盖(P0 接受)」与「盐首建非原子」两句;权限收紧行为保留(R20-7.2)                                                                                                                                                                                                                                                                                                                                      | 随块(A1)                                            |
| 9   | §8 #23 会话计数库、§10.6 信号库                                                  | 新增按 key 删除(purge)的重写路径;写入顺序遵守 R20-6.9                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 随块(A2)                                            |
| 10  | `exclude.ts`(F2)                                                                 | 导出 `canonical()`;rsi 路径用新的策略构造(无默认拒绝、`exclude_names`、`(dev,ino)` 祖先匹配);手动 `--allow-project` 的大小写放宽与 allow 路径作 `projectRoot` 不变                                                                                                                                                                                                                                                                                                                                    | 随块(A2)                                            |
| 11  | §17.2 judge、§18.3 / §18.4 `promote --run`                                       | 追加 R20-4.8 即时闸:`RSI_RUN_TAINTED`、`RSI_RUN_ATTRIBUTION_UNKNOWN`(退出 1)、`purge_incomplete` 与配置不可用(退出 3);`promote --run` 加入锁矩阵(持 `rsi/lock`)                                                                                                                                                                                                                                                                                                                                       | **先改**(A2)                                        |
| 12  | §19.3 doctor「`checks` 恒 16 项」、`DOCTOR_CHECK_IDS`                            | D17 是 P1(A6),P0 不加;届时改为 17                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P1(A6)                                              |
| 13  | §19.7 `HOME_WRITE_TABLE`(12 条)                                                  | 第 13 条 pi 扩展(可执行类)是 P1(A5),P0 不改                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P1(A5)                                              |
| 14  | §13 / `reader-counting-spec.md`                                                  | 单行 JSON 嵌套深度 256 的预扫与 `<line-too-deep>` 计数是 reader 行为变更;推荐放进共享基类、同时改口径文档(待定夺 Q16)                                                                                                                                                                                                                                                                                                                                                                                 | **先改**(A2)                                        |
| 15  | §8 #24、§17.4a `Proposal.reflector`                                              | `provenance` 是 P1(A4),P0 不改                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P1(A4)                                              |
| 16  | §12.1 A5 命令清单与环境、§19.9                                                   | 加入 §20.8.1 列出的命令;A5 环境加 `KIT_AUTO_RSI=0`;A5 增加写调用审计桩这一层判据                                                                                                                                                                                                                                                                                                                                                                                                                      | 随块(A2 / A3)                                       |
| 17  | §5「state 位置」                                                                 | rsi 全部入口忽略 `KIT_STATE_DIR` / `KIT_WRITE_ROOTS`(除非设了 `KIT_TMP`)——`paths.ts` 增加 rsi 专用的上下文构造                                                                                                                                                                                                                                                                                                                                                                                        | **先改**(A1)                                        |
| 18  | §7 全局选项 `--root`                                                             | rsi 命令的仓库根取 `[rsi] repo`;`--root` 不同 → `root_mismatch`                                                                                                                                                                                                                                                                                                                                                                                                                                       | 随块(A2)                                            |
| 19  | §19.5 后台 worker 只对 TTY 前台命令调度                                          | rsi 的 poke 来自钩子、天然非 TTY,不复用 update 的 TTY 闸,用 R20-1.6 / R20-1.7 自己的闸;update 的闸不变                                                                                                                                                                                                                                                                                                                                                                                                | 随块(A3)                                            |
| 20  | §5「确定性序列化」                                                               | 追加 `canonicalJsonLine`(单行,键序同 `canonicalJson`)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **先改**(A1)                                        |
| 21  | §18.2 `promote --run` 产物                                                       | `.state/promote/<id>/` 可被 taint(删 `promote.patch`、`pr-body.md`,写 `TAINTED`);`promote --run` 的「同 id 已存在且一致 → 退出 0」对 tainted 目录改为 `RSI_RUN_TAINTED`                                                                                                                                                                                                                                                                                                                               | **先改**(A2)                                        |

**R20-A0 实装对照(第 0 块:与锁、状态机无关的前置修订;本块不含 `src/rsi/**`、RSI 锁、命令面)**:

- 第 1 条:已实现(R20-A0)—— `UserConfig.rsi: z.unknown().optional()`(Q1-A);`test/update/user-config-rsi.test.ts` 钉死旧配置 / 合法 `[rsi]` / 非法 `[rsi]` 下 `update`(含 `--write`)与后台 worker 的退出码与稳定码一致,其它未知段与 `[update]` 写错仍是 `config_invalid`。
- 第 2 条:已实现(R20-A0)—— 三个具名键;`PI_CODING_AGENT_DIR` 折成 `KIT_RSI_PI_DIR_SET=1`(见 §19.7 订正)。
- 第 3 条:①②已实现(R20-A0);③根入口按 R20-1.2a 路由、④`src/cli.ts` 识别 `__rsi --background`、⑤§7 命令表加 `rsi` 一行 —— 未做,依赖 rsi 入口与命令面存在(A3)。
- 第 4 条:已实现(R20-A0)—— `createExclusive`(见 §5 safe-fs 行)。
- 第 5 条:已实现(R20-A0)—— `filterLlmEnv` 固定 `KIT_RSI_CHILD=1`。
- 第 14 条:已实现(R20-A0)—— 共享基类预扫(Q16-A),见 §13 与 `reader-counting-spec.md` C8 补充。
- 第 20 条:已实现(R20-A0)—— `canonicalJsonLine`。
- 其余未做,原因:第 6、7、8 条(reflect / judge / gc / `signals collect` 加 `rsi/lock`)、第 11、21 条(`promote --run` 即时闸 / taint,依赖锁与暂存区 taint)、第 17 条(rsi 专用 `IoContext` 构造,依赖 `[rsi] repo` 解析,与 `src/rsi/config.ts` 同块)—— 依赖 RSI 锁(A1)或 rsi 配置 / 状态机;第 9、10、16、18 条与第 19 条 —— 随 A2 / A3 的实现块订正;第 12、13、15 条 —— P1。

### 20.10 P1 / P2 占位(只写接口与不变量,不写细则)

> **v3.1 修订(§21.18 第 18 条、§21.19)**:开启自动循环(`[rsi.auto] enabled`)时 claude / pi 的会话授权缺省为 S2(R21-2.3);`judge --ingest` 与 N4 对个人层不再需要,只影响 §18 手动路径;其余占位不变。

| 项                                                | 接口占位                                                  | P0 已定的不变量                                                                             | 依赖的待决事项 |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| `rsi digest --json`(A4)                           | 无 `--scope`(传了退出 2);≤ 48KiB、5 簇、每簇 8 条         | 摘录只限当前项目(N3);X / U 现算(R20-4.6),摘录恒 0;读前过快照协议;输出前用当前规则复扫       | 无(N3 已定)    |
| `reflect --ingest - --digest <id> --owner @h`(A4) | stdin ≤ 64KiB、≤ 5 条提案                                 | 摘录由合并器从信号库机械复制(§16);写暂存前复核授权与排除;持 `rsi/lock`;只写暂存区、不 apply | N4             |
| `[rsi.session]`(A4)                               | `enabled`、`agents`、`expires`(≤ 90 天)、`auto`(`s1\|s2`) | 只在 L-session 层校验,失败只禁用会话授权(R20-2.6);授权不是安全边界                          | N2             |
| `rsi hint --format <claude-json\|codex-json>`(A5) | 钩子输出形状                                              | 文本内容与字节上限同 R20-3.3.2                                                              | N1             |
| `rsi hooks --print / --install --agent pi`(A5)    | 片段打印;pi 扩展写入需 TTY 确认                           | 钩子不传路径与 cwd(R20-1.9);poke / hint 恒退出 0、不经启动器(R20-1.2a)                      | N1             |
| `rsi session --print`(A5)                         | 打印可粘贴配置                                            | kit 不写用户配置(R20-2.1)                                                                   | N2             |
| `rsi dismiss`、提醒一次、doctor D17(A6)           | `dismissed.json`;`RSI_PROPOSALS_READY`;D17                | D17 无绝对路径;P0 期间新增项目由 hint 的 n 与 `rsi status` 提示(R20-4.2a)                   | 无             |
| S0 / S1 / S2、`rsi should-continue`(P2)           | 独占创建的每日名额                                        | 自动路径永不 spawn LLM(R20-1.1)                                                             | N2             |
| `judge --ingest`(P2)                              | —                                                         | 厂商自报不可证明                                                                            | N4             |
| `reflector.provenance`(A4)                        | `spawned \| session_declared`                             | 缺省兼容为 `spawned` 仅当有完整后端身份(设计稿 §8a.6)                                       | 无             |

### 20.11 契约自洽性核对表

| #   | 新条款                                       | 对照的既有条款 / 设计稿                                                | 结论                                                                                                                                                      |
| --- | -------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | R20-2.1 读 `~/.config/agent-kit/config.toml` | §5「`~` 不展开」、§19.5 文件位置                                       | 不冲突:update 已经 `getRealHome()` 读同一文件,rsi 沿用入口、校验更严                                                                                      |
| 2   | `[rsi]` 段                                   | §19.8 `UserConfig` strict                                              | **冲突**:未修订前写 `[rsi]` 会让 update 失败。§20.9 第 1 条先改                                                                                           |
| 3   | R20-2.5 状态目录在仓库内                     | §5「state 位置」                                                       | 一致;「忽略 `KIT_STATE_DIR`」是收窄,§20.9 第 17 条                                                                                                        |
| 4   | R20-1.1 / R20-1.2a 零联网、不经启动器        | §19.7 lint 闸、`launcher.ts → install.ts → net.ts`                     | **冲突**:rsi 入口若经现有启动器,传递闭包含 `net.ts`,启动器还会输出 update 提示、起 update worker。按 R20-1.2a 路由并拆出零网络桥接(§20.9 第 3 条)后才一致 |
| 5   | R20-3.9.1 worker 环境                        | §19.7 `RUN_SELF_ENV_KEYS`                                              | 需追加三键(§20.9 第 2 条),方向一致                                                                                                                        |
| 6   | R20-5.2 reflect / judge 拿 `rsi/lock`        | §17.2 退出码表                                                         | 需新增 `reason=locked`(退出 4,NOT_RUN 语义已有)                                                                                                           |
| 7   | R20-5.1 gc 拿锁                              | §17.7「gc 不拿跨进程锁」                                               | **冲突**,按设计稿 §12 改为拿锁(§20.9 第 6 条);§17.7 已把「加共享锁」列为待定夺,方向一致                                                                   |
| 8   | R20-5.5 锁协议                               | §19.5 update / sync 锁                                                 | 规则一致;原语不同(safe-fs 而非 home-fs),§20.9 第 4 条                                                                                                     |
| 9   | R20-5.2 与现有 `reflect/llm.lock`            | `src/reflect/backends/lock.ts`(链接 + mtime 15 分钟)                   | **有残余**:llm.lock 整段回调不续期,超过 15 分钟的 judge(最多约 100 分钟)期间可能被回收。新版本靠外层 `rsi/lock` 互斥;新旧版本并发仍是残余(§20.9 第 7 条)  |
| 10  | R20-4.1 项目根                               | §9、`exclude.ts`                                                       | **部分一致**:与手动 collect 的「无 allow 名单」分支一致;allow 路径命中时手动 collect 用 allow 路径作根。R20-4.1 / R20-3.5.5 写明差异与重建边界            |
| 11  | R20-4.4 折叠大小写                           | 设计稿 §8「不无条件折叠」                                              | **与设计稿措辞不一致**,取「只会多排除」的保守方向,列 Q4                                                                                                   |
| 12  | R20-4.2 首次 armed 不落索引                  | 设计稿 §8a.1「项目根只进项目索引」                                     | **与设计稿不一致**:`project_key` 需要盐而首次 `armed` 不建盐;改为现算不落盘,列 Q2                                                                         |
| 13  | R20-1.5a 失效后的 armed                      | 设计稿 §8a.1、§14 A2 的 N5 断言                                        | 设计稿未区分;N5「文件不存在」只对首次 `armed` 成立,失效后改为「不新建不修改」,列 Q19                                                                      |
| 14  | R20-3.3.4 hint 写去重标记                    | 设计稿 §4.2「只读」与「30 分钟去重」                                   | **设计稿内部矛盾**(去重需要写),取「仅独占创建一个标记」,列 Q5                                                                                             |
| 15  | R20-3.3.2 hint 模板                          | 设计稿 §4.2 模板、§8a.1「提示里单列新增项目 n」、§14 A2「hint 输出 U」 | 原模板加 n 与 U 后超 200 字节;删去尾句「不要主动打断用户当前任务」,保留「仅在用户要求时」;194 字节                                                        |
| 16  | R20-3.3.1 hint 读集合                        | 设计稿 §4.2「只读 `state.json`」                                       | **与设计稿不一致**:只读 `state.json` 兑现不了「排除立即生效」与 U 判定;扩为四个 rsi 文件 + 配置 + 根路径元数据,新增 `counts.json`(R20-4.5)                |
| 17  | R20-4.7 taint 清空全部证据摘录               | §16、`Proposal` schema;设计稿 §8a.3 ①                                  | 不冲突:空串合法;不新增 `redacted_by`(与设计稿写法不同,原因记在 `TAINTED`),列 Q14                                                                          |
| 18  | R20-4.7 taint 改写暂存 run 与 promote 产物   | §17.7 gc;§18.2 promote 幂等                                            | gc 不冲突(tainted run 含 `proposals/`,不是候选);promote 的「同 id 已存在 → 退出 0」需改,§20.9 第 21 条                                                    |
| 19  | R20-4.8 即时闸读 `[rsi]`                     | §17 judge、§18 promote 现不读用户配置                                  | 新依赖;无 `[rsi]` 或未启用时行为不变;配置损坏时 fail-closed 是收紧,列 Q9、Q20                                                                             |
| 20  | R20-1.6 CI 判据                              | §19.5 / `policy.ts` `CI_ENV_KEYS`                                      | 一致,复用同一张表                                                                                                                                         |
| 21  | R20-6.7 JSON 深度上限                        | §13 reader、口径文档                                                   | 新增 reader 行为,先改口径(§20.9 第 14 条)                                                                                                                 |
| 22  | R20-3.0 稳定码风格                           | §19 `<CMD>_<类别> reason=`                                             | 一致;设计稿顶层码 `RSI_INDEX_INVALID` 映射为 `RSI_FAIL_CLOSED reason=index_invalid`                                                                       |
| 23  | R20-1.7 顺带调度要求 TTY                     | §19.5 update 调度                                                      | 一致;rsi 白名单含 `check` / `build`,update 的排除集恰好排除它们,两者独立判定                                                                              |
| 24  | R20-3.8 purge 删除信号                       | §17.3 会话计数 upsert、`ts` 钉死                                       | 不冲突:整行删除,不改其它行                                                                                                                                |
| 25  | R20-6.9 重读不迁移历史                       | 设计稿 §12「cursor 绑定脱敏规则版本,变化即全量重读」                   | **语义比设计稿弱**:设计稿暗示重读会更新,现有 `writeSignals` 按 `sig_id` 去重保留旧行。如实写明只补采,列 Q24                                               |
| 26  | R20-3.6 confirm 绑定展示指纹                 | 设计稿 §8a.1                                                           | 设计稿未写 TOCTOU;本节补「拿锁后重算,不同即 `RSI_CONFIRM_STALE`」,列 Q18                                                                                  |

### 20.12 待主代理 / 用户定夺

| #   | 问题                                        | 推荐(第一项)与备选                                                                                          | 代价                                                                                        |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Q1  | `UserConfig.rsi` 怎么进 schema              | **A** `z.unknown().optional()`,rsi 模块分层校验;B 直接挂 `RsiConfigSchema.optional()`                       | A:`UserConfig` 示例看不出 `[rsi]` 形状;B:`[rsi]` 写错会让 update 一起停                     |
| Q2  | 首次 `armed` 的项目清单落不落盘             | **A** 不落盘,每次现算;B 落一份不含 key 的「待确认清单」                                                     | A:每次重扫目录(受上限);B:未确认前就把全部项目路径写进状态目录                               |
| Q3  | 项目根是否向上找 git 根                     | **A** 不找,沿用 canonical cwd;B 找含 `.git` 的最近祖先                                                      | A:同一仓库子目录会话是多个项目;B:多读 `.git`、改变现有 `project_key`,历史失联               |
| Q4  | 排除比较是否折叠大小写                      | **A** 折叠 + `(dev,ino)` 祖先匹配;B 按卷的真实大小写语义                                                    | A:大小写敏感卷上多排除仅大小写不同的兄弟目录;B:卷探测不可靠时可能漏排除                     |
| Q5  | hint 30 分钟去重的写入                      | **A** 允许 hint 独占创建一个去重标记;B 不去重;C 由 worker 预计算                                            | A:hint 不再是纯只读;B:恢复 / 压缩时重复注入;C:窗口内首个会话可能拿不到提示                  |
| Q6  | L0 6 小时与 poke 30 分钟                    | **A** poke 先判 L0 到期,不到期不预留不 spawn;B 每 30 分钟都 spawn,由 worker 判                              | A:会话结束后最长 6 小时才采到;B:多数 worker 空跑                                            |
| Q7  | rsi 是否忽略 `KIT_STATE_DIR`                | **A** 忽略(除非 `KIT_TMP`);B 尊重                                                                           | A:用户不能把 rsi 状态放到别处;B:钩子进程与前台命令可能读写不同的状态目录                    |
| Q8  | `purge --project` 是否要求项目已排除        | **A** 要求;B 不要求                                                                                         | A:多一步先写排除;B:用户以为删了,下次 L0 又采回来                                            |
| Q9  | `[rsi]` 配置损坏时 judge / promote 读暂存区 | **A** fail-closed(退出 3);B 当作无排除继续                                                                  | A:配置写错会挡住手动晋升;B:配置写错期间被排除项目的摘录可能经 judge 外发                    |
| Q10 | `RSI_RUN_TAINTED` 的退出码                  | **A** 1;B 3                                                                                                 | A:与「不变量破坏」区分;B:与其它隐私闸同码                                                   |
| Q11 | 停止标记怎么清除                            | **A** 只有 `rsi confirm`;B 新增 `rsi start`                                                                 | A:恢复要再看一遍清单;B:多一条命令                                                           |
| Q12 | `[rsi] agents` 缺省与可选值                 | **A** 缺省 `claude,codex,pi`,只许这三家;B 缺省空                                                            | A:装了但不想采的 agent 也会被采(可删);B:启用时多写一行                                      |
| Q13 | 「首次 L0 完成后提示一次」放 P0 还是 P1     | **A** P1(A6),P0 由 `rsi confirm` 清单与 hint 的 n 承担;B 放 P0                                              | A:P0 期间没有「已开始采集」的单独提示;B:P0 多一个提醒机制                                   |
| Q14 | taint 原因记在哪                            | **A** 只记在 `TAINTED`,证据 `excerpt` 置空;B 在证据里加 `redacted_by`                                       | A:单看提案看不出为何为空;B:`Proposal` / `AtomFrontmatter` schema 变更                       |
| Q15 | reflect / judge 真跑整段持 `rsi/lock`       | **A** 持有;B 只在读信号与写暂存时短暂持有,写前重判排除                                                      | A:L0 最长推迟约 30 分钟(reflect)/ 约 100 分钟(judge);B:写暂存拿不到锁会浪费一次已外发的调用 |
| Q16 | JSON 深度上限放哪                           | **A** 共享 reader 基类,同时改口径文档;B 只在 rsi 路径                                                       | A:手动 collect 在病态行上的计数变化;B:两条路径对同一文件计数不同                            |
| Q17 | 首次 `armed` 首行取 cwd 的假设              | **A** A2 先对三家真实会话文件实测首行是否含 cwd,不含的 agent 在 `armed` 下记归属不明;B 放宽到前 N 行        | A:某家在确认前显示不出项目;B:违反 N5「至多读开头一行」                                      |
| Q18 | confirm 的 TOCTOU                           | **A** 拿锁后重算展示指纹,不同即 `RSI_CONFIRM_STALE`;B 在锁内完成展示与输入                                  | A:用户偶尔要重跑一次;B:等待输入期间长时间持锁,挡住 worker                                   |
| Q19 | 确认失效退回 `armed` 后旧数据怎么办         | **A** 保留,只读展示与 purge;B 失效即自动删除                                                                | A:失效期间旧数据仍在盘上;B:用户误删一条排除就丢掉全部历史                                   |
| Q20 | 归属不明(U)的证据对 judge / promote         | **A** 拒绝(`RSI_RUN_ATTRIBUTION_UNKNOWN`,零 LLM 调用);B 只拒 X、放行 U                                      | A:索引损坏期间手动 judge 用不了,需先 `--rebuild-index`;B:违背 N7「一律不输出」              |
| Q21 | purge journal 在 `stopped` / `armed` 下续做 | **A** 由前台 `rsi purge --resume --write` 续做(`confirmed` 下 worker 也自动续做);B 任何状态下 worker 都续做 | A:用户 `stop` 之后要手动续做;B:与「stopped 不做自动写入」冲突                               |
| Q22 | promote 产物是否纳入 taint                  | **A** 纳入(删 `promote.patch` 与 `pr-body.md`,写 `TAINTED`);B 不纳入,只在说明里写明                         | A:`promote --run` 的幂等语义要改;B:被排除项目的摘录留在 `.state/promote/`                   |
| Q23 | `armed` 头部读取的物理边界                  | **A** 一次 ≤ 64KiB 的读,首行之后的字节丢弃不解析;B 逐块读到首个换行为止                                     | A:物理上读到了首行之后的若干字节(不解析);B:多次读调用,审计更难写                            |
| Q24 | 脱敏规则 / overlay 变化后是否重写已存信号   | **A** P0 不重写,只补采,要清洗用 purge;B 指纹变化时按 `sig_id` 原地重写                                      | A:旧摘录在新规则下仍可能含漏网内容(P1 digest 输出前复扫兜底);B:要定跨月份一致性与回滚       |
| Q25 | 钩子触发的 poke / hint 是否转发到 `current` | **A** 不转发,跑被调用的那份包(R20-1.2a);B 拆出零网络的 current 校验后再转发                                 | A:可能跑旧版本代码;B:要把 `verifyInstalledTree` 从 `install.ts` 拆出,改动面大               |

### 20.13 评审记录

2026-10-23,`~/.claude/bin/pi-review.sh` 只读评审(第 1 级 Pi GPT-6.1 Sol 成功),针对本节初稿,26 条(高 12、中 12、低 2)。评审结论「建议修订后再冻结 R20」;§20.11 的 #4、#9、#10、#17 结论被指出不成立,已重写。逐条处置:

| #   | 问题(严重度)                                                       | 处置                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 自动路径闭包要求与 launcher 接线冲突(launcher → install → net)(高) | 采纳:R20-1.1 改为按入口分别起算;§20.9 第 3 条要求零网络桥接模块;核对表 #4 改为「冲突」                                                                                                                               |
| 2   | 公共启动器破坏 poke / hint 的静默与零写入(高)                      | 采纳:新增 R20-1.2a 入口路由与真实产物子进程验收;Q25                                                                                                                                                                  |
| 3   | 首次确认 TOCTOU(高)                                                | 采纳:R20-3.6.2–3 展示指纹 + 拿锁重算 + `RSI_CONFIRM_STALE`;Q18                                                                                                                                                       |
| 4   | 运行中 worker 未重验确认(高)                                       | 采纳:R20-3.9.2 运行绑定、R20-6.8 检查点比对,含「只收紧排除」也放弃                                                                                                                                                   |
| 5   | taint 中断后无续做协议(高)                                         | 采纳:R20-4.7「续做」条与崩溃注入点;purge journal 记下目标集合(R20-3.8.4)                                                                                                                                             |
| 6   | 索引损坏时暂存区闸缺 fail-closed(高)                               | 采纳:R20-4.8 新增 `RSI_RUN_ATTRIBUTION_UNKNOWN`,零 LLM 调用;Q20                                                                                                                                                      |
| 7   | promote 不拿锁、导出产物不在 purge 范围(高)                        | 采纳:`promote --run` 入锁矩阵、写前二次检查;promote 产物纳入 taint;§20.9 第 21 条;Q22                                                                                                                                |
| 8   | 快照缺提交义务与崩溃恢复(高)                                       | 采纳:R20-5.6 提交义务、「不一致 ≠ 损坏」与持锁重建                                                                                                                                                                   |
| 9   | purge 恢复与 stopped / off / armed 冲突(高)                        | 采纳:R20-3.8.5 续做入口与 `--resume`;Q21                                                                                                                                                                             |
| 10  | 重新 armed 时 N5 断言不可满足(高)                                  | 采纳:R20-1.5a 区分首次与失效后的 `armed`;R20-1.11 分开断言;Q19                                                                                                                                                       |
| 11  | 配置 schema 与 fail-closed 分层矛盾(高)                            | 采纳:R20-2.6 分层解析与错误优先级;示例断言状态 / 阻断范围 / 原因码                                                                                                                                                   |
| 12  | hint 读集合支撑不了现算(高)                                        | 采纳:R20-3.3.1 明确读集合与元数据读取;新增计数投影 `counts.json`(R20-4.5)                                                                                                                                            |
| 13  | 「与现有 collect 完全一致」不成立(allow 路径作根)(中)              | 采纳:R20-4.1 改为「无 allow 分支」口径;R20-3.5.5 不用新 key 冒充;核对表 #10 改为「部分一致」                                                                                                                         |
| 14  | 7 天全量在上限下饿死文件(中)                                       | 采纳:R20-6.9 epoch 续跑与 4001 文件测试                                                                                                                                                                              |
| 15  | 指纹变化重读不等于更新脱敏 / 归属(中)                              | 采纳:R20-6.9 写明「重读不迁移历史」,指纹含 overlay 脱敏字段哈希;Q24;核对表 #25                                                                                                                                       |
| 16  | 硬上限与 1s 的绝对措辞(中)                                         | 采纳:R20-6.7 分严格 / 尽力两类并写超量范围;R20-3.2.1 改为 2s 内退出的判据;补目录与暂存扫描上限                                                                                                                       |
| 17  | armed 物理读取边界不一致(中)                                       | 采纳:R20-1.4 明确「一次 ≤ 64KiB 物理读、首行后丢弃不解析」;Q23                                                                                                                                                       |
| 18  | llm.lock 不会误回收的结论不成立(中)                                | 采纳:R20-5.2 与核对表 #9 改为「有残余」,judge 上限约 100 分钟;Q15 代价同步修正                                                                                                                                       |
| 19  | `runSelf` 缺 cwd 接口;`PI_CODING_AGENT_DIR` 丢失(中)               | 采纳:§20.9 第 3 条加 `cwd`;R20-2.9 与 §20.9 第 2 条加 `KIT_RSI_PI_DIR_SET`                                                                                                                                           |
| 20  | 持久化 schema 不完整、快照路径可被引导(中)                         | 部分采纳:快照 `name` 白名单(R20-5.6)、cursor 的 `project_key` 写成合法形状、R20 行列全 schema 清单;各 schema 的逐字段上下界留给 R20 schema 落地时写进 `src/contracts/rsi.ts` 与带标记示例(本节是契约文字,不重复 zod) |
| 21  | 输出与权限策略修订不完整(中)                                       | 采纳:R20-7.2 分三类资源写读取前校验与写入权限策略,标明与手动 collect 的兼容差异                                                                                                                                      |
| 22  | `rsi projects` 输出例外与 N7 冲突(中)                              | 采纳:通用约定写明唯一例外;R20-3.5.1 按状态分别成形、unknown 无 name / path;R20-3.5.3 清洗;R20-3.5.4 固定 JSON 键;泄漏闸豁免只限 `path=` 值                                                                           |
| 23  | 新增项目 n 缺失、时间口径不稳(中)                                  | 采纳:hint 模板加 n(194 字节);R20-4.2a 改用 generation,定义确认与重建的基线                                                                                                                                           |
| 24  | JSONL、稳定码与 status 输出矛盾(中)                                | 采纳:`canonicalJsonLine`(§20.9 第 20 条);码表补全并改为单一枚举生成;`state_dir_unsafe` 只作 reason;status 列 tainted 而退出 0                                                                                        |
| 25  | 零写入需区分终态与写调用(低)                                       | 采纳:§20.8.1 两层判据(写调用审计 + 快照)、`--ignored` 与正向对照                                                                                                                                                     |
| 26  | 「只能调严」无配置项(低)                                           | 采纳:开头改为「全部常量不可配置」                                                                                                                                                                                    |

评审对 §20.12 的意见:Q1–Q14、Q16–Q17 推荐方向保留;Q15 保留 A 但修正代价;建议补列的 7 项已作为 Q18–Q24 加入(另加 Q25)。本次未做第二轮评审。

### 20.14 R20-A2 B2 实装订正与 schema 示例

**范围**:B2 只落地库(schema、配置分层解析、状态机、rsi 专用 `IoContext`、双闸函数、流式快照接口、生产校验器、home-fs 写审计钩子)。**没有任何 rsi 命令、没有任何现有命令的接线**;现有命令行为逐字节不变。

- **配置与状态**:`src/rsi/config.ts` 的 `loadRsiConfig` 按 R20-2.6 的层序解析(只读、不建目录;L-policy 对 `[rsi]` 与 overlay 的 `exclude_dirs` 取并集后一起校验,`buildRsiPolicy` 不静默丢弃不合规项),`src/rsi/state.ts` 的 `rsiStateOf` 按 R20-1.3 / R20-1.5 现算状态(六条失效判据,收紧排除 / 减少 agent 不使确认失效)。`confirm` 记录比契约列出的字段多一个 `repo_sha256`(`sha256(repo 的 realpath)`):R20-1.5 ③ 要比较 realpath 而记录不存路径原文。`state.json` 里的最近一次结果存为 `last_tick.completed_at`(R20-3.2.2 读它),`rsi status --json` 的 `last_tick.at` 由它映射。
- **双闸(R20-4.8 / R20-5.1)**:`src/rsi/gate.ts` 的 `lockGate`(要不要拿 `rsi/lock`)与 `privacyGate`(`judge` 含干跑 / `promote` 的即时闸)各自独立。`lockGate == off` **不是**放行:`cfg_*` / `repo_invalid` 让 `lockGate` 为 `off`、`privacyGate` 为 `deny`(退出 3)。`privacyGate` 对 `absent` / `no_section` / `disabled` 为 `legacyAllowed`;`on` 且 `overlay_invalid` / `exclude_invalid` 为 `deny`;`on` 且无 block 为 `enforce`。B2 的闸是库函数:命令是否按序调用(deny / refuse 之前不构造会写盘的上下文、不建 `rsi/`、不拿锁、不恢复快照)由 B3 的接线与顺序测试负责。取舍(opus 咨询已同意 deny;对 R20-4.8 的订正:「`[rsi]` 存在但配置不可用」改为「配置文件存在但无法证明没有 `[rsi]`,或 `[rsi]` 不可用(L-file 除 absent 外的失败、L-toml、L-base、L-repo、L-overlay、L-policy)→ 退出 3」;`disabled` 走旧流程的前提是已通过 L-base;deny 时的输出应带具体原因码与修复提示,B3 实现):文件层失败(`cfg_symlink` / `cfg_owner` / `cfg_perm` / `cfg_not_regular` / `cfg_too_large` / `cfg_unreadable`)与 `cfg_parse` 读不到 `[rsi]` 段,无法证明「没有 `[rsi]`」,按 deny 处理。
- **D1 修订稿(状态目录关系)**:rsi 状态树固定为 `<[rsi] repo>/.state`(R20-2.5);现有写入方用自己的 `ctx.io.stateDir`。`lockGate` 用**不建目录**的路径解析(最长已存在前缀的 `realpath` + 余下片段,并记该前缀各级祖先的 `(dev, ino)`):互不相同且互不为祖先 / 后代 → 独立,现有命令不拿锁、行为不变(两棵树有**共同的已存在前缀实体**时,即使路径字符串写法不同,只比较余下片段:逐段相等 → 相同,父子或忽略大小写后相同 / 前缀 → 无法证明,兄弟 → 独立);路径相同或 `(dev, ino)` 相同 → 拿锁;**无法证明**(悬空符号链接 / 循环 / 权限不足 / 中间组件不是目录 / 末端不是目录、两次解析结果不一致、父子重叠、仅忽略大小写后相同或重叠、平台不支持)→ 退出 3 `RSI_FAIL_CLOSED reason=state_dir_unsafe`,不写任何东西。这是对锁矩阵(R20-5.1)的显式订正:**启用 rsi 时各写入方共同持锁,但状态树与 rsi 状态树确定独立者除外**。残余:①解析与后续按字符串路径建目录 / 建锁之间有窗口,靠 `rsiDir()` 自己的复核缩小,不消除;②「前缀不是同一实体 → 独立」假定祖先关系会出现在 `realpath` 路径或 `(dev, ino)` 祖先链上,Linux 的 bind mount 可以隐藏这种关系(`/data/state` 与挂到 `/alias/repo` 的 `/data/state/repo`),单靠 `realpath` + `stat` 判不出;要消除就得对任何两个不同仓库都 refuse,会破坏「独立树不拿锁、行为不变」,所以作为已知残余记录,不弱化也不兜底。
- **D3**:`SIGNALS_NOT_RUN`、`PROMOTE_NOT_RUN`、`REFLECT_NOT_RUN`、`JUDGE_NOT_RUN` 的 `reason=locked`(退出 4,零调用零写入)只登记码(`src/contracts/rsi.ts` 的 `RSI_LOCKED_NOT_RUN_CODES`),B2 不接线。**D7**:`rsi status` 的 `lock` 枚举追加 `unsafe`,`peekRsiLock` 的返回值相应由 `unknown` 改为 `unsafe`。**D8**:缺 `O_NOFOLLOW` / `O_NONBLOCK` / `O_DIRECTORY` 或 `process.getuid` 的平台,配置 `on` 时 `lockGate` 为 `refuse`(退出 3 `state_dir_unsafe`),配置 `off` 时现有命令把闸门当 `off`。
- **rsi 专用 `IoContext`(§20.9 第 17、18 条)**:`src/rsi/io.ts` 的 `createRsiIoContext` 先复制 env 并剔除 `KIT_STATE_DIR` / `KIT_WRITE_ROOTS`(`KIT_TMP` 已设时保留),再以 `[rsi] repo` 为根构造——选择发生在通用路径校验之前,一个对 rsi 无效的 `KIT_STATE_DIR` 不影响 rsi 入口。给了 `base` 时经 `deriveIoContext` 派生(保留 `writeAudit`),所有与仓库有关的字段取新值。`--root` 与 `[rsi] repo` 的 `realpath` 不同 → `RSI_USAGE reason=root_mismatch`。真实 `main()` 路由(rsi 入口在 `createIoContext` 之前选择专用构造)随 B3 的命令分发落地。
- **流式快照(R20-5.6 订正)**:`openStreamSafe`(`src/io/read-fs.ts`)一次安全打开、同一句柄读完;月文件的提交与恢复对**原始**字节块同时算 sha256 / 字节数并喂 JSONL 校验引擎(`src/rsi/jsonl-stream.ts`:按 `\n` 字节切行、整行 fatal UTF-8 解码、行尾 `\r` 留给 `JSON.parse`、空行 / 非法 UTF-8 / 非 JSON / 超长行 / 缺尾换行均失败)。**月文件的 256MiB 单文件载入上限取消**;固定文件(四个)仍整份载入并保留 `RSI_DATA_FILE_MAX_BYTES` 上限;`readVerified` 仍整份载入,只应传固定文件。`SnapshotValidator` 改为 `{ fixed(name, bytes | null), record(name, value) }` 且 `recoverSnapshot` 的校验器**必填**(去掉缺省结构校验;`structuralValidator` 只留在测试里)。新增只读的 `inspectSnapshot`(不建目录、不删 `snapshot.json.tmp`、不写清单,给 D2 的「拿锁后无副作用复检」用),`recoverSnapshot` 与它共用评估核心再写。快路径语义:`consistent` 时固定文件仍整体校验(月文件与清单哈希一致即信任已提交内容,残余:提交本身不校验月文件内容);清单缺失(`absent`)只说明从未提交过,**不说明目录为空**——磁盘上已有的全部数据(固定文件、月文件)先做完整校验,有损坏就抛,没有才返回 `absent`;「必需文件」只对**清单列出的**文件成立(清单缺失时没有预期文件集合)。
- **生产校验器**:`src/rsi/validators.ts` 的 `productionSnapshotValidator`:`state.json` / `cursor.json` / `counts.json` 过各自 schema(`state.json` 与 `parseRsiStateDoc` 同一判定:只有 `confirm` 单独不合规是**状态**——退回 `armed`、原因 `schema`、可重新确认,快照校验放行;整份不合规才是损坏 `state_invalid`。否则恢复会先于 `rsi confirm` 抛错,用户没有重新确认的入口。对 R20-5.6 的订正:「任一文件过不了 schema = 损坏」的例外是 `state.json` 仅 `confirm` 过不了 `RsiConfirmSchema`、置空后整份合法;持锁写入方回写 `state.json` 时**必须原样保留**该字段(不得归一成 `null`,否则失效后的 `armed` 会被当成首次 `armed`,与 R20-1.5a 矛盾),只有 `rsi confirm` 能覆盖它;`parseRsiStateDoc` 是 `state.json` 的唯一解析入口。整份过不了 schema 时没有自动恢复入口:`rsi status` 退出 3,须人工处理 `state.json`);`projects.json` 的内容问题**不阻断**(D4,索引另算 `invalid`;链接 / 硬链接 / 权限 / 属主错误仍在读取阶段阻断);缺失仅 `projects.json` 放行(D5),其余固定文件与全部月文件缺失 = 损坏。
- **home-fs 写审计**:`HomeFsContext` 可选 `writeAudit`(类型同 safe-fs 的 `WriteAudit`),每个导出写函数入口第一行、任何校验之前记一次 `(home.<函数名>, path.resolve(home, rel))`;双路径函数先记 `<op>.from` 再记目标;`tightenKitStateDir` 只在 `apply=true` 时记。`ApplyEnv` / `InstallEnv` 可带 `writeAudit` 透传,`sync` / `update` 命令与 update worker 从 `ctx.io.writeAudit` 取。它记录**写尝试**,不替代任何安全检查。未设置时键不存在。

**B3-0 接口冻结(命令分发与服务层桩)**:`src/commands/rsi.ts` 一次登记全部子命令(P0:`tick` / `status` / `projects` / `confirm` / `stop` / `purge` / `poke` / `hint`,各一个入口文件 `src/rsi/<name>.ts`;P1 预留 `digest` / `session` / `hooks` / `dismiss` / `should-continue` 只在分发器里退 64)。均为命令桩:退出 64,stderr 只有 `RSI_NOT_IMPLEMENTED subcommand=<规范名>`(**仅桩使用**的码,常量 `RSI_STUB_CODE`,不属于 R20-3.0 总表,子命令实装后不再出现),stdout 为空;无子命令 / 未知子命令退出 2 `RSI_USAGE reason=unknown_subcommand`,不回显输入。`CommandDef` 新增可选 `runEarly`:`main()` 在创建通用 `IoContext` **之前**调用它(rsi 专用上下文的选择先于通用路径校验,§20.9 第 17 条);其他命令路径不变。共享类型集中在 `src/rsi/types.ts`,服务层桩在 `src/rsi/services/`(`resumeTaint` / `taintNewlyExcluded` / `detectPurgeJournal` / `immediateGate` / `judgeGateCallbacks` / `writeCountsProjection` / `commitUnderLock` / `openRsiIo`,全部 `not implemented`,持锁服务必须传 `RsiLockHandle`;提交顺序按 R20-6.9:`writeCountsProjection` → state → cursor → `commitUnderLock`(日志 + 快照清单,最后一步),counts 投影为目标值语义、不承诺字节级幂等)。`src/rsi/with-lock.ts` 的 `withRsiLockIfGated(ctx, fn)` 是真实现:`lockGate` 为 `off` 时 `fn(null)`、不建 `rsi/`;`lock` 时 `withRsiLock`;`refuse` 时抛 `RsiFailClosedError('state_dir_unsafe')`(退出 3),不调用 `fn`。两条调用顺序(rsi 自己的子命令 / 现有写入方)写在 `src/rsi/types.ts` 头注释;顺序用例在后续块实装前仅以 `it.todo` 登记,**尚未获得验证**。 (订正见 §20.14 B3 订正 B3a-5)

**示例**(带标记,`test/contracts/examples.test.ts` 逐条校验)。每个错误示例后面标出「状态 / 阻断范围 / 原因码」:

`RsiBase` 合法:

<!-- example:valid schema=RsiBase -->

```json
{
  "enabled": true,
  "repo": "/home/u/agent-kit",
  "agents": ["claude", "pi"],
  "exclude_dirs": ["/home/u/clients"],
  "exclude_names": ["client-x"]
}
```

`RsiBase` 错误:`agents` 含 `kimi`。状态 `off`、阻断范围整个 rsi(judge / promote 的即时闸 fail-closed)、原因码 `cfg_schema`:

<!-- example:invalid schema=RsiBase -->

```json
{ "enabled": true, "repo": "/home/u/agent-kit", "agents": ["kimi"] }
```

`RsiPolicy` 合法:

<!-- example:valid schema=RsiPolicy -->

```json
{
  "schema_version": 1,
  "agents": ["claude", "pi"],
  "exclude_hashes": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "overlay_sha256": null,
  "kit_major": 0
}
```

`RsiPolicy` 错误:`agents` 未升序(同一策略会得到两个指纹)。状态 = 确认记录无法比对、阻断范围 = 退回 `armed`、原因码 = `confirm` 的 `schema` 失效:

<!-- example:invalid schema=RsiPolicy -->

```json
{
  "schema_version": 1,
  "agents": ["pi", "claude"],
  "exclude_hashes": [],
  "overlay_sha256": null,
  "kit_major": 0
}
```

`RsiState` 合法(已确认,熔断关闭):

<!-- example:valid schema=RsiState -->

```json
{
  "schema_version": 1,
  "confirm": {
    "confirmed_at": "2026-10-24T08:00:00.000Z",
    "kit_major": 0,
    "agents": ["claude", "codex", "pi"],
    "exclude_hashes": [],
    "repo_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "repo_dev_ino": { "dev": 16777230, "ino": 1234567 },
    "overlay_sha256": null,
    "policy_fp": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "baseline_pending": true
  },
  "projects_ack_generation": 0,
  "attempt": null,
  "last_tick": null,
  "consecutive_failures": 0,
  "breaker": null
}
```

`RsiState` 错误:`projects_ack_generation` 为负。状态 = `state.json` 不可读,阻断范围 = 自动路径空操作、`rsi status` 退出 3,原因码 `state_invalid`:

<!-- example:invalid schema=RsiState -->

```json
{
  "schema_version": 1,
  "confirm": null,
  "projects_ack_generation": -1,
  "attempt": null,
  "last_tick": null,
  "consecutive_failures": 0,
  "breaker": null
}
```

`RsiProjectIndex` 合法:

<!-- example:valid schema=RsiProjectIndex -->

```json
{
  "schema_version": 1,
  "salt_fp": "3f2a9c1d7e4b",
  "generation": 42,
  "entries": [
    {
      "key": "p_0123456789abcdef",
      "roots": [
        {
          "path": "/home/u/work/proj",
          "dev": 16777230,
          "ino": 1234567,
          "first_seen": "2026-10-23",
          "last_seen": "2026-10-24"
        }
      ],
      "sessions": 3,
      "signals": 17,
      "first_indexed_generation": 40
    }
  ]
}
```

`RsiProjectIndex` 错误:`roots` 为空。状态 = 索引不可用,阻断范围 = 继续采集但不给摘要、所有输出把信号计入 U(索引不被覆盖),原因码 `index_invalid`:

<!-- example:invalid schema=RsiProjectIndex -->

```json
{
  "schema_version": 1,
  "salt_fp": "3f2a9c1d7e4b",
  "generation": 1,
  "entries": [
    {
      "key": "p_0123456789abcdef",
      "roots": [],
      "sessions": 0,
      "signals": 0,
      "first_indexed_generation": 0
    }
  ]
}
```

`RsiCounts` 合法:

<!-- example:valid schema=RsiCounts -->

```json
{
  "schema_version": 1,
  "salt_fp": "3f2a9c1d7e4b",
  "generation": 7,
  "computed_at": "2026-10-24T08:00:00.000Z",
  "cluster_min": 3,
  "per_key": {
    "p_0123456789abcdef": {
      "signals_total": 17,
      "sessions": 3,
      "signals_by_day": { "2026-10-24": 5 }
    }
  },
  "clusters": [{ "cluster_id": "c1", "evidence_by_key": { "p_0123456789abcdef": 4, "?": 1 } }],
  "staged": [
    { "run_id": "run-1", "proposals": 2, "evidence_keys": ["p_0123456789abcdef"], "tainted": false }
  ],
  "unknown_keys_signals": 0
}
```

`RsiCounts` 错误:`evidence_by_key` 的键不是 key 也不是 `?`。状态 = 计数投影损坏,阻断范围 = 持锁写入方安全阻断、hint 空串,原因码 `counts_invalid`:

<!-- example:invalid schema=RsiCounts -->

```json
{
  "schema_version": 1,
  "salt_fp": "3f2a9c1d7e4b",
  "generation": 7,
  "computed_at": "2026-10-24T08:00:00.000Z",
  "cluster_min": 3,
  "per_key": {},
  "clusters": [{ "cluster_id": "c1", "evidence_by_key": { "not-a-key": 4 } }],
  "staged": [],
  "unknown_keys_signals": 0
}
```

`RsiCursor` 合法:

<!-- example:valid schema=RsiCursor -->

```json
{
  "schema_version": 1,
  "fingerprint": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "full_scan": {
    "epoch": 2,
    "started_at": "2026-10-20T00:00:00.000Z",
    "done": true,
    "last_completed_at": "2026-10-21T00:00:00.000Z"
  },
  "files": {
    "s_0123456789abcdef": {
      "agent": "claude",
      "size": 1024,
      "mtime_ms": 1790000000000.5,
      "dev": 16777230,
      "ino": 99,
      "project_key": "p_0123456789abcdef",
      "epoch": 2,
      "status": "ok"
    }
  }
}
```

`RsiCursor` 错误:文件 `status` 不在枚举内。状态 = cursor 损坏,阻断范围 = 持锁写入方安全阻断,原因码 `cursor_invalid`:

<!-- example:invalid schema=RsiCursor -->

```json
{
  "schema_version": 1,
  "fingerprint": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "full_scan": { "epoch": 0, "started_at": null, "done": false, "last_completed_at": null },
  "files": {
    "s_0123456789abcdef": {
      "agent": "claude",
      "size": 1,
      "mtime_ms": 1,
      "dev": 1,
      "ino": 1,
      "project_key": null,
      "epoch": 0,
      "status": "weird"
    }
  }
}
```

`RsiPurgeJournal` 合法:

<!-- example:valid schema=RsiPurgeJournal -->

```json
{
  "schema_version": 1,
  "created_at": "2026-10-24T08:00:00.000Z",
  "phase": "planned",
  "keys": ["p_0123456789abcdef"],
  "taint_targets": { "runs": ["run-1"], "promotes": [] }
}
```

`RsiPurgeJournal` 错误:`phase` 不在五个阶段内。状态 = journal 不可读,阻断范围 = 读暂存区的命令退出 3、续做失败,原因码 `journal_invalid`:

<!-- example:invalid schema=RsiPurgeJournal -->

```json
{
  "schema_version": 1,
  "created_at": "2026-10-24T08:00:00.000Z",
  "phase": "half",
  "keys": ["p_0123456789abcdef"],
  "taint_targets": { "runs": [], "promotes": [] }
}
```

`RsiTaintMark` 合法:

<!-- example:valid schema=RsiTaintMark -->

```json
{ "reason": "exclude", "at": "2026-10-24T08:00:00.000Z" }
```

`RsiTaintMark` 错误:`reason` 不是 `exclude|purge`。状态 = 标记不可读,阻断范围 = 读路径按 tainted 拒绝(标记存在即拒,内容不合规不降级),原因码 `RSI_RUN_TAINTED`:

<!-- example:invalid schema=RsiTaintMark -->

```json
{ "reason": "manual", "at": "2026-10-24T08:00:00.000Z" }
```

`RsiStopMark` 合法:

<!-- example:valid schema=RsiStopMark -->

```json
{ "at": "2026-10-24T08:00:00.000Z", "by": "user" }
```

`RsiStopMark` 错误:`by` 不是 `user`。状态 = 标记内容不合规,阻断范围 = 仍按 `stopped` 处理(标记存在即停,不因内容错误恢复采集),原因码无(不是错误码):

<!-- example:invalid schema=RsiStopMark -->

```json
{ "at": "2026-10-24T08:00:00.000Z", "by": "worker" }
```

`RsiLogLine` 合法:

<!-- example:valid schema=RsiLogLine -->

```json
{
  "at": "2026-10-24T08:00:00.000Z",
  "trigger": "poke",
  "agent": "claude",
  "action": "spawned",
  "code": "ok",
  "counts": { "files_read": 0 },
  "duration_ms": 12
}
```

`RsiLogLine` 错误:`code` 含路径分隔符(日志不得带路径)。状态 = 该行不可写入,阻断范围 = 该行丢弃(日志不是安全依据),原因码无:

<!-- example:invalid schema=RsiLogLine -->

```json
{ "at": "2026-10-24T08:00:00.000Z", "trigger": "tick", "action": "failed", "code": "/home/u/x" }
```

### B3 订正(B3a / B3b / B3c 实装后并入;编号按组计,条款处以「B3a-1」形式引用)

**B3a(只读命令:status / projects / stop)**

1. **B3a-1(R20-3.7.1 STOP)**:STOP 位置上已有任何对象(含目录、链接、硬链接、悬空链接)都视为已存在,退 0,不改、不读。`.state/` 或 `.state/rsi/` 不存在时按 0700 创建,这是 stop 唯一允许新建的目录;已存在但不合规退 3 `state_dir_unsafe`,不收紧。
2. **B3a-2**:「不建 `rsi/`」只适用于 status 与 projects。
3. **B3a-3(R20-3.4.2)**:`cursor.status` 为 `ok|absent`,`snapshot` 为 `ok|absent`;cursor 或快照损坏按 R20-3.4.1 退 3,busy 退 4;只有 `index` 保留 `invalid`(D4,索引无效不阻断)。`reason` 在配置 on 时报 `overlay_invalid` / `exclude_invalid`(停止采集)或 `null`。agents 的 `not_evaluated` reason 取值:`root_symlink`、`root_not_dir`、`pi_dir_override`;status 按真实会话根链与 `PI_CODING_AGENT_DIR` 判定。
4. **B3a-4(R20-3.5)**:`key8` 取 `p_` 之后前 8 位十六进制;summary 的 `collecting` 含 `new`(`new` 是 P 的子集);计数口径:`counts.json` 存在时为权威,缺失才回退索引条目的 signals。
5. **B3a-5**:本节登记两处例外:桩码 `RSI_NOT_IMPLEMENTED` 在子命令实装后仍出现于 `status.ack`、`projects.rebuild_index`(B5)与 `projects.armed_listing`(B4)三处,随对应块删除;桩名改为点号形式(避免空格打断 key=value 解析)。(与 B3-0 接口冻结段「子命令实装后不再出现」的关系:以本条为准的例外。)
6. **B3a-6**:常量 `RSI_ARMED_HEAD_BYTES`(64KiB)。

**B3b(reflect / judge / gc 接锁)**

1. **B3b-1(§20.9 第 7 条)**:reflect / judge / gc 已接线。真跑的锁在构造后端前拿并持有到写完,LLM 返回后先复核再写。
2. **B3b-2**:命令级 `REFLECT_NOT_RUN` / `JUDGE_NOT_RUN` 只登记 `reason=locked`;`locked_over_ttl` 也合并报 `locked`,不抢占、不删旧锁;区分看 `rsi status` 的 `lock:` 行。
3. **B3b-3**:refuse 与其余锁错误统一报 `RSI_FAIL_CLOSED reason=<kind>`,退 3。
4. **B3b-4**:失锁语义:发现失锁后不再发起新的外发和持久化,已成功的写入不撤销;reflect 失锁后零写入(含 `report.json` 与临时目录,每个写点前有 beforeWrite 复核);gc 每次删除前复核,且返回前再复核,失锁退 3 `lock_lost`;`assertHeld` 与文件操作之间仍有检查到使用的时间窗,不是原子隔离。
5. **B3b-5**:`reflect --run-llm` 与 `judge --run-llm` 在锁内、建后端与任何写之前先调 `assertNoPurgeInProgress`,purge 进行中退 3 `purge_incomplete`。
6. **B3b-6(§20.8.2 A2 行)**:A2 验收表补「去掉任一命令拿锁」的变异已覆盖 gc、reflect、judge。worker × 各命令的并发组合仍留 A3。

**B3c(服务层)**

1. **B3c-1(R20-4.8)**:顺序实现为:配置 → TAINTED → purge journal → 归属(X>U>P)。journal 提到归属之前(purge 进行中信号库与索引正被改写)。副作用:purge 窗口内属于 X 的 run 退 3 `purge_incomplete`,不再是 1 `RSI_RUN_TAINTED`。
2. **B3c-2(R20-4.7)**:taint 清理白名单:run 目录只留 `TAINTED`、`report.json`(必须是普通文件)、`proposals/*.yaml`(摘录清空)、`rules/**/*.md`(摘录清空);promote 目录只留 `TAINTED` 与 `report.json`。异常 yaml 换同名空文件,异常 md 与杂项一律删。`TAINTED` 存在性用 lstat 判,空文件、半个 JSON、目录都算已标记。
3. **B3c-3(R20-4.7)**:promote 闭包:只要 `report.json.run_id` 指向已 taint 的 run 就补标;`report.json` 读不出或无法关联时,存在已 taint 的 run 就保守一并 taint;journal 记下的 promote 补标 reason=purge。
4. **B3c-4(R20-4.3)**:X 只依赖索引里的根路径,不依赖盐是否相符(X 优先);盐不符、counts 缺失才算 U。
5. **B3c-5(R20-5.6)**:`commitUnderLock` 先 `inspectSnapshot` 复验全部数据,再追加日志,最后 `commitSnapshot`;日志先于清单,崩在二者之间会多一行日志(不丢提交记录)。
6. **B3c-6(counts 写入)**:盐缺失 / 格式非法 / 权限宽一律 `salt_invalid`,不回退旧值;盐指纹与现有 counts 不符时,只有四段全给才允许覆盖;`cluster_min` 保留现值,首次取常量 2。
7. **B3c-7(R20-3.0 总表)**:安全残余:safe-fs 拒绝删除或改写硬链接(nlink>1)。暂存目录里有硬链接、指向写入根之外的符号链接或悬空符号链接,属「需人工修复」的阻断状态:新增 `RSI_FAIL_CLOSED reason=staging_unsafe_entry`(退 3,不带路径);出现时 `TAINTED` 保留,读路径照拒,kit 不替换或删除这些条目,也不做其它清理(预检先于任何清理)。需加进 R20-3.0 总表与 `src/contracts/rsi.ts` 的 `RSI_FAIL_CLOSED_REASONS`(此项由代码任务做,本文只写条款)。
8. **B3c-8(R20-6.7)**:5000 上限落实到 run 与 promote 目录数,检查顺序 promote 先、run 后,先于任何标记或清理;超限抛 `staging_too_large`。
9. **B3c-9(R20-5.6)**:信号库月文件读取走句柄级安全读(`openStreamSafe`):硬链接、枚举后换链、非普通文件、缺尾换行、坏行一律 `signal_store_corrupt`。
10. **B3c-10(R20-4.7)**:失败运行遗留的 `.tmp-<id>` 暂存目录不是 run,taint 不扫;只覆盖进程崩溃,不含断电。
11. **B3c-11(R20-4.3,统一归属口径)**:归属只有一份实现,hint、`rsi status`、`rsi projects`、`rsi tick`、R20-4.8 即时闸与 taint 共用:优先级 X > U > P;盐与 counts 不符时 X 仍优先(X 只依赖索引里的根路径与当前排除规则);`counts.json` 缺失按 U;`exclude_names` 取 `canonical()` 之后的 basename 比较;隐私路径(排除判定)与展示路径(R20-3.5.2 / R20-3.5.3)用同一口径。

### B4 订正(B4 实装前并入;编号按序,条款处以「B4 订正 #n」形式引用)

1. **#1(R20-3.0 总表)**:`RSI_FAIL_CLOSED` 行的状态类加入 `staging_unsafe_entry`(B3c-7 登记、`src/contracts/rsi.ts` 枚举已有),文档总表与枚举恢复逐行一致。`test/contracts/rsi-codes-table.test.ts` 的待并入清单随之清空,`rsi-lock-snapshot.test.ts` 的 `RSI_FAIL_CLOSED` 比对不再排除该码。
2. **#2(R20-1.4 / R20-1.11 / N5,D1)**:`armed` 头部读取按 agent 分开写。`claude`:同一次 ≤ 64KiB(`RSI_ARMED_HEAD_BYTES`)读取里最多看前 32 个完整行,找到 cwd 即停;规则与 claude reader 一致(跳过侧链行,cwd 先到先得;BOM、CRLF、过深行按 base-reader 自己的函数处理)。`pi`:只看首行,取 `type:"session"` 那行的顶层 cwd。`codex`:只看首行,取 `session_meta` 那行的 `payload.cwd`。解析器会在内存里看到 `last-prompt` / `ai-title` 里的用户文本,不保存、不输出、不进日志。codex 的 `turn_context` cwd 在 `armed` 下记 U。codex 首行超过 64KiB 记 U(实测 0 例,作为残余写明)。实测依据(本机抽样):pi 300/300 首行含顶层 cwd;codex 300/300 首行含 `payload.cwd`(299 个首行 < 32KB,1 个在 32K–64K);claude 首行 0/28 含 cwd,绝对路径 cwd 最早出现在第 3–20 行。已知局限:claude 样本只有 28 个且都是近期文件,看不出版本差异。
3. **#3(R20-3.3.2 / R20-3.3.3,D2)**:`state.json` 新增可选字段 `armed_listing`,绑定 `policy_fp` 与 `agents`。缺失或过期(绑定不符)时 hint 输出空串,不显示过期数字。`confirm` 成功时清空(删除该键)。
4. **#4(R20-3.1.1 / R20-3.1.2,D3、D14)**:`armed` 下 `tick --write` 只写 state、日志、快照,不建盐、不写 counts(与 R20-1.5a 一致)。干跑的 `signals_new` 为 null;使用临时盐或首次 `armed` 时,`projects` 与 `unknown_signals` 为 null(不输出依赖 key 的计数)。
5. **#5(R20-6.7,D4、D8)**:`armed` 头部读取 2000 个文件,按 mtime 降序取最近的,超出部分计入 `unknown_sessions`(D4)。「超限不报错退出」只适用于读取类上限;暂存扫描超限(5000 个 run / 5000 个 promote)是安全阻断,抛 `staging_too_large`(B3c-8 的延伸,与 B3c-8 同一口径:先于任何标记或清理)。cursor 淘汰顺序为 epoch → mtime → ref(D8)。
6. **#6(R20-6.8,D6)**:检查点中的「每处理 1000 行」改为 base-reader 的行级钩子,含预扫,按实际读取字节记账。
7. **#7(B2 baseline 例外,D10)**:确认后第一次成功 L0 可把 `baseline_pending` 从 true 改为 false。这是 B2「`confirm` 单独不合规时原样透传」规则的唯一例外;`confirm` 无效时仍原样透传。
8. **#8(R20-7.2,D5)**:盐读取统一为共同只读原语:普通文件、`nlink == 1`、权限 ≤ 0600、≤ 4KiB、格式合法;空文件只在 `loadSalt` 里有限等待。`loadSalt`、规划侧、counts 服务共用这一原语。因此 `loadSalt` 变严(拒绝硬链接),手动 `signals collect` 也受影响。
9. **#9(A1 空盐残余,D15)**:盐首建崩溃留下空文件时,持锁、空普通文件、mtime 已满 10 秒才可删除重建。
10. **#10(R20-3.5.5,D11)**:`--rebuild-index` 旧索引有效时合并:可信旧条目保留,新观测更新。头部读取上限 `RSI_REBUILD_MAX_FILES = 10000`,按 mtime 降序。如实承诺:「只重建最近 10000 个会话文件对应的项目,其余信号仍记 U」;超出报 `RSI_LIMIT_FILES` 和剩余数。
11. **#11(新增残余,R20-7.5)**:`sig_id` 依赖事件序号。reader 改动使事件编号整体偏移,会让重读产生重复信号。每次改 reader 都要跑「同一夹具新旧版本 `sig_id` 集合相同」的回归。

**已定决定(记录)**:

- D3、D4、D6–D16 均按推荐。
- D13:`recomputeCounts` 不返回 clusters,提交侧每次重算。
- D12:rebuild 的 cwd 一律按头部规则(与 #2 同一口径)。

## 21. 自主 RSI 契约(R21,v3.1,契约先行;V1–V6 实装后订正)

> **状态:冻结(2026-10-23,第五轮评审通过)**。共五轮只读评审(Pi GPT-6.1 Sol),第五轮结论「高严重度是否全部闭合:是」「§21 能否冻结:能」;评审范围与逐轮处置见 §21.23。冻结后的改动必须以带编号的契约修订进行(原位加修订标注、在 §21.23 记录),不得静默改写。§21.22 的 Q-A–Q-P 已定。`analysis-plan v1` 附录 `§21.7a` 是冻结时已登记的待补项,由 V1.5 的契约修订补入(R21-7.13),不影响冻结。

本节把 `docs/design-autonomous-rsi.md`(v3.1,2026-10-23 定稿,五轮评审;下称「v3.1」)写成可验收条款。v3.1 取消了团队层:**一切 RSI 产出都是个人层、只在本机**;唯一出本机的是用户在前台逐次确认后提交的「框架改进投稿」草稿 PR。v3.1 的用户决定(U1–U3、T0、M1–M5、M9–M15、P1–P3)全部视为已定,本节不重开;落契约时新发现的细节取舍 Q-A–Q-P 已由主代理按推荐定下(§21.22),正文按已定写成条款。

条款编号形如 `R21-<小节>.<序号>`,测试按编号引用(`it('R21-4.3 …')`)。本节与 §20 的关系:§20 的 P0 条款全部继续有效,除非 §21.18 / §21.19 写明「被取代」或「被细化」;两节冲突时以 §21.18 的「修订后」一栏为准。

**分期标注**:每条带 `[V1]`、`[V1.5]`、`[V2]`、`[V3]`、`[V4]`、`[V5]`、`[V6a]`、`[V6b]` 之一,表示该条随哪一期**生效**(该期的实现块必须让它成立)。标 `[V0]` 的是本节自身(契约与 schema 清单)。**未到期的条款是占位:到期前不得实现**——不得提前写出会被自动路径调用的代码路径;允许的只有 schema 常量与「拒绝」分支(例如 V1 的配置解析对 `exec = "host_after_trial"` 照样接受取值,但 V6a 之前 E1 通道不存在,取值无效果,`rsi status` 报 `exec: not_available`)。

本节的 JSON / 字段表是说明性的,**没有** `example` 标记(对应 schema 尚未登记);各期 schema 落地时改成带标记的合法 / 错误示例并在 `test/contracts/registry.ts` 登记,错误示例断言「状态、阻断范围、原因码」三者。

通用约定(沿用 §20 开头):stdout 只含计数、枚举、id、哈希前缀;`--json` 为 canonical JSON、键集合固定;stderr 只含稳定码;单行日志用 `canonicalJsonLine`;时钟、随机源、TTY 判据、文件系统读写、子进程出口都可注入;退出码用 `combineExitCodes`。**统计常量、闸词表、上限、保留期全部是代码常量**(`src/contracts/rsi.ts` 追加,不另起文件),配置只能选档位与开关,不能调数值。

### 21.0 分期总表

| 期   | 内容(v3.1 §10.2)                                                                                                                     | 本节生效条款                                                      | 进入条件(机器可判 / 需用户当场同意)                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| V0   | 本节;schema 清单                                                                                                                     | §21.0、§21.18 的「文档」类修订、§21.21                            | R20 / A1–A3 的契约已在树                                                                   |
| V1   | 个人层最小闭环:私有仓库、G0–G7、shadow、canary、ITT、四段回滚、撤销路径、冷却、审计、`rsi auto` / `veto`                             | §21.1–§21.7 中标 `[V1]` 者、§21.9–§21.13 中标 `[V1]` 者           | A1–A5 已实装;**判定默认关**(R21-7.9);§10.3 动作 1、2 用户同意;R21-6.5 标记取回准入实测通过 |
| V1.5 | 只记录 ≥ 30 天;功效模拟与无效果模拟                                                                                                  | R21-7.10–R21-7.12                                                 | V1;用户看校准报告后才开判定(§10.3 动作 3)                                                  |
| V2   | 本机静态生效:本机 payload、`source=local`、safe 新增条件、静态阶段监视;`canary → adopted → stable` 开放(须 `§21.7a` 已写入,R21-7.13) | §21.8、R21-7.3、R21-7.5、R21-9.4、§21.18 第 1、6、7、9、21、31 条 | V1.5;§10.3 动作 4;`analysis-plan v1` 附录 `§21.7a` 已写入且数值夹具测试通过(R21-7.13)      |
| V3   | 工作方法 / 技能 / 子代理;`phase_sequence`;声明式固定测试                                                                             | §21.14、R21-5.1 的 G8                                             | V2                                                                                         |
| V4   | 框架改进投稿                                                                                                                         | §21.17                                                            | V3;§10.3 动作 5、8                                                                         |
| V5   | 能力缺口与第三方扩展                                                                                                                 | §21.15                                                            | V3;§10.3 动作 6                                                                            |
| V6a  | E1 本体(假运行时)                                                                                                                    | §21.16 中标 `[V6a]` 者                                            | V5                                                                                         |
| V6b  | 隔离探针与真机验证                                                                                                                   | §21.16 中标 `[V6b]` 者                                            | V6a;§10.3 动作 7                                                                           |

- R21-0.1 `[V0]` **分期闸是代码常量**:`RSI_AUTO_PHASE`(整数枚举,当前实现到哪一期)由实现块提升,不读配置。某期之前的子命令注册为命令桩(退出 64,§7);某期之前的配置键可解析但无效果,`rsi auto status --json` 的 `phase` 字段如实报告。变异:把 `RSI_AUTO_PHASE` 提前而未实现对应条款 → 该期验收红。
- R21-0.2 `[V0]` 带契约 / schema 变更的期串行实现(v3.1 §10.2 末段);两期不得在同一 PR 里同时提升 `RSI_AUTO_PHASE`。

### 21.1 范围与不变量

- R21-1.1 `[V1]` **只有个人层**:自动循环的全部产出(规则、踩坑、方法 / 技能、子代理、能力缺口记录、E1)只写 §21.3 的私有仓库与本机状态目录,只经本机 payload(§21.8)生效。不存在团队层、团队仓库、团队 PR、远端状态同步(v3.1 T0)。
- R21-1.2 `[V1]` **框架内容不被自动改写**:候选目标路径不得落在框架方法技能(`agent-kit-rsi`、`agent-kit-capability`)、预置技能(当前为 `commit-checklist`,集合取包内 payload 的 `skill` 条目,`source=package`)、`rules/org/**` 或包内任何文件上(G4,R21-5.1)。框架内容的改进只走 §21.17 投稿。
- R21-1.3 `[V1]` **自动路径永不做**(取代 R20-1.8 的「apply / retire / sync 写全局」三项,其余保留):开 PR、推送任何远端、对外通知、npm 发版、建 tag、改用户配置 / overlay / `team_project_keys`、改 agent 配置(`settings*.json`、hooks、`~/.codex/config.toml`)、`rsi purge`、`rsi confirm`、`rsi auto resume`、`rsi veto --lift`、打开 `[rsi.auto] exec`、首次 E1 宿主运行的确认、第三方代码安装授权。**自动路径允许**:写私有仓库(经 R21-3.6 原语)、生成灰度注入、经撤销路径与 safe 条件同步本机 payload、自动回滚、自动退役、写投稿草稿(零子进程)。
- R21-1.4 `[V1]` **零 LLM;kit 进程自身零联网**(R20-1.1 不变并细化,§21.18 第 12 条):kit 进程不 spawn LLM CLI。分三层:①**自动入口**(poke、hint、worker)的 import 闭包不含 `llm-exec`、`reflect/backends/**`、`net.ts`、`src/rsi/contrib/publish/**`、`src/rsi/exec/host/**`、`src/rsi/exec/isolated/**`;worker 对 E1 只做登记与状态推进(启用表、停用事件处理、探针到期登记,R21-16.2c、R21-16.14),**从不**执行宿主脚本、启动容器或调用运行时客户端。允许的子进程只有 R20-1.1 的 `runSelf` 桥接与私有仓库 git(R21-3.6,`protocol.allow=never`,零网络)。②**前台命令**:除下面两类外同样遵守①的闭包禁令。③**明确例外**:`rsi contrib submit` 经 git / `gh` 子进程联网(§21.17),是唯一由 kit 发起网络的 rsi 命令;`rsi exec-run`(引用 `exec/host/**`)与 `rsi isolation probe`、`rsi exec-prepare`(引用 `exec/isolated/**`)执行宿主脚本或容器——宿主脚本以用户完整权限运行、**网络不受 kit 约束**(R21-16.5),这是 v3.1 P2 接受的风险,不能写成「rsi 命令都不联网」的全称断言。会话 agent 的联网与第三方代码执行(§21.15)不属 kit 进程。
- R21-1.5 `[V1]` **不降档放行**:闸、评估器、分组账、固定测试、隔离探针中任一不可用、超时或报内部错误 → 候选停在当前状态或进 `blocked` / `expired`,循环退回「只提示」;不存在「证据不全按通过处理」的分支(v3.1 §0 第 2 条)。变异:任一判定函数在异常时返回「通过」→ 测试红。
- R21-1.6 `[V1]` **计时口径**(新,§21.22 Q-A):①令候选**走向更多生效**的计时(shadow → canary 的 20 会话、组样本门槛、留出组门槛、静态阶段判定点)**只按「有观测会话」计**,用户不用 agent 时不前进;②令候选**走向更少生效**的计时(`expired` 的日历上限、`blocked` 到期、`static_pending` 超时、冷却、熔断窗口、保留期、授权请求超时、投稿频率)可以按 UTC 日历计。即:日历时间流逝只会让候选停用或到期,永远不会让它生效。v3.1 中写作「N 天」而属于①的,一律读作「N 个有观测会话」(v3.1 §5.1 末段)。
- R21-1.7 `[V1]` **「有观测会话」**:一个会话在 L0 采集后同时满足 ①会话文件被 reader 完整读完(无 `RSI_LIMIT_*` 截断、无解析失败);②属于「采集中」项目(R20-4.3);③若该会话被随机分组,分组账行能经随机会话标记关联且不属多标记会话(R21-6.4、R21-6.6)。不满足③的会话计入 C6 分母、不计入其它指标的分母。
- R21-1.8 `[V1]` **威胁模型**:防 kit 自己出错与已知注入模式,不防同 UID 的主动篡改(v3.1 R7)。kit 的输出与文档对审计、分组账只能称「kit 路径可追踪」,不得写「防篡改」「可证明」(沿用 R20-7.4 的措辞约束)。
- R21-1.9 `[V1]` **展示标签**:任何展示自动产出正文的地方(`rsi show`、TTY 确认、注入文本、渲染进 payload 的托管块头)都带固定标签「自动产出、未经人工核验」(常量 `RSI_AUTO_LABEL`)。

### 21.2 配置

- R21-2.1 `[V1]` 新增三个子表,全部在 `~/.config/agent-kit/config.toml` 的 `[rsi]` 之下,沿用 R20-2.1 / R20-2.2 的读取与校验;kit 只读、永不写。**未知键拒绝**(`strictObject`)。**R20-2.6 的 L-base 同时修订**:`RsiBaseSchema` 对 `auto`、`capability`、`contrib` 三键与 `session` 同样只校验为「表或缺省」,子表内容留给下列各层(否则 strict 的 L-base 会让任一子表写错就把整个 `[rsi]` 判 `off`,§21.18 第 19 条)。解析层追加在 R20-2.6 的 L-session 之后:

| 层        | 内容                                      | 失败结果                                              |
| --------- | ----------------------------------------- | ----------------------------------------------------- |
| L-auto    | `[rsi.auto]`(`RsiAutoSchema`)             | **只禁用自动生效**(`auto: invalid`);L0、hint 计数照常 |
| L-cap     | `[rsi.capability]`(`RsiCapabilitySchema`) | 只禁用 §21.15;其余照常                                |
| L-contrib | `[rsi.contrib]`(`RsiContribSchema`)       | 只禁用 `rsi contrib submit` / `export`;草稿生成照常   |

| 键                                | 类型                                                  | 缺省     | 约束 / 生效期                                                                                                |
| --------------------------------- | ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `rsi.auto.enabled`                | boolean                                               | `false`  | `[V1]`;缺省关;字符串 `"true"` 在 L-auto 失败                                                                 |
| `rsi.auto.profile`                | `"lite" \| "medium" \| "heavy"`                       | `medium` | `[V1]`(M3);V3 之前 `medium` 与 `lite` 行为相同(固定测试不存在),`rsi auto status` 报 `profile_effective=lite` |
| `rsi.auto.exec`                   | `"off" \| "host_after_trial"`                         | `off`    | `[V6a]`;之前取值无效果                                                                                       |
| `rsi.capability.allow_publishers` | string[](≤ 64 项,每项 1..214 字节,`[A-Za-z0-9@/._-]`) | `[]`     | `[V5]`;只影响展示,不影响是否需要授权(M15 C)                                                                  |
| `rsi.contrib.fork_owner`          | string                                                | 不设     | `[V4]`;R21-17.6 字符集;等于上游 owner(不区分大小写)→ L-contrib 失败 `fork_is_upstream`                       |
| `rsi.contrib.export_dir`          | string                                                | 不设     | `[V4]`;R21-17.4 的导出守卫(绝对路径、`realpath` 在 HOME 内、链上无符号链接)                                  |

- R21-2.2 `[V1]` **开启自动循环的有效条件** = R20-1.3 状态为 `confirmed` 且 `rsi.auto.enabled === true` 且 L-auto 通过 且 `RSI_AUTO_PHASE ≥ 1`。不满足时 worker 照常做 §20 的 L0,hint 只出计数行(`--canary` 按 R21-6.11 第 1、2 行处理)。**事件分类**(此处与 `auto_paused` 共用):「增加影响」的转移(`shadow → canary`、`canary → adopted`、`adopted → stable`、任一 agent 的 `→ injected` / `→ static_pending` / `→ static`、恢复注入、写入或放宽 `exec-enabled.json`)被禁止;采集、闸、shadow 计数、伤害判定、到期、`veto`、taint、回滚、退役、撤销路径、撤销凭据对账(R21-9.5)照常执行。
- R21-2.3 `[V1]` 开启自动循环时 claude / pi 的会话授权缺省为 S2(M10;R20 §20.10 的 `[rsi.session] auto` 缺省值随之改,codex 保持 S1);S2 的上限不变(每会话 ≤ 1、每天 ≤ 1、`stop_hook_active` 不续)。

### 21.3 个人层存储与私有仓库

- R21-3.1 `[V1]` 位置固定 `<真实 HOME>/.local/share/agent-kit/personal/`(在 `HOME_WRITE_TABLE` 的 kit 条目 `.local/share/agent-kit/` 之内),不可配置,**每个 HOME 唯一**(与 `[rsi] repo` 无关)。目录布局(v3.1 §3.1):`rules/<id>.md`、`pitfalls/<id>.md`、`methods/<id>/SKILL.md`(V3)、`agents/<id>.md`(V3)、`capabilities/<agent>/<capability>.md`(V5)、`exec/<id>/{script, manifest.json}`(V6a)、`cases/auto/<cluster>/`(V3)、`lifecycle/<id>.json`(`PersonalLifecycleRecord`)。固定分支 `rsi`。树中任何位置不得出现 `.gitattributes`、`.gitmodules`、符号链接、可执行位(E1 脚本以普通文件存放,执行时复制,R21-16.4)。
- R21-3.2 `[V1]` **HOME 侧个人层状态** `<真实 HOME>/.local/state/agent-kit/rsi-personal/`(0700,在 kit 条目 `.local/state/agent-kit/` 之内,经 home-fs 新授权写,§21.18 第 10 条):`lock`(个人层锁 `personal/lock`,协议同 R20-5.5)、`head.json`(kit 最近一次提交的 `head` 与 `owner_repo_fp` = `sha256(realpath([rsi] repo), dev, ino)` 前 16 位)、`commit-journal.json`(R21-3.6a)、`txn/<id>.json`(回滚与撤销 journal)、`revocations.jsonl`(撤销凭据,R21-9.5)、`last_local_sync.json`(本机 payload 的最近一次 safe 同步结果,**不写** `UpdateState`)。这些文件不依赖 `[rsi] repo`,`[rsi]` 关闭或换仓库后仍可找到。
- R21-3.3 `[V1]` **锁序**(全局,不可反转):`rsi/lock`(仓库,R20-5.3)→ `personal/lock`(HOME)→ sync 锁(§19.5)。全部为试锁。worker 与 §21.12 的 `--write` 前台命令按此序获取;`rsi auto clear --write` 在 `[rsi]` 不可用时只拿后两把(R21-9.5)。update 的自动同步只拿 update 锁 → sync 锁,不拿前两把,无环。
- R21-3.4 `[V1]` **结构校验**(每次操作前,先于 R21-3.5;任一不满足 → 熔断 `personal_repo_invalid`):`.git` 是真实目录(不是 gitdir 文件、不是符号链接、不是 worktree 链接);非裸仓库;无 `objects/info/alternates`;无 `config.worktree`;仓库本地 `.git/config` 只含白名单键(`core.repositoryformatversion`、`core.filemode`、`core.bare`、`core.logallrefupdates`、`core.ignorecase`、`core.precomposeunicode`),出现其它任何键(含 `include.*`、`filter.*`、`remote.*`、`core.hooksPath`、`core.sshCommand`)即不满足;`git remote` 为空;目录属主为当前 uid、权限恰为 0700;树满足 R21-3.1 的禁止项。
- R21-3.5 `[V1]` **HEAD 与工作树判定**(结构校验通过之后;机械判定,v3.1 §3.2)。**第 0 步(优先)**:`commit-journal.json` 存在 → 先按 R21-3.6a 的恢复优先级处理,处理完才做下面的判定(kit 自己未完成的提交不会被当成人工分叉)。①当前分支为 `rsi`、无 stash、工作树干净(`status --porcelain --ignored` 为空)、HEAD 是 `head.json` 记录提交的后代,且 `记录..HEAD` 只新增文件、不触碰任何 `origin=auto_rsi` 文件与 `lifecycle/**` → 接受,更新记录;②分支不是 `rsi`、有 stash、工作树不干净、HEAD 是记录的祖先、或 `记录..HEAD` 改 / 删了自动产出 → `personal_repo_diverged`:暂停**新增**生效(不熔断,R21-10.3);撤销照常,但**不触碰私有仓库的任何引用、索引与工作树**(R21-9.3a);`rsi auto status` 提示二选一(回到记录提交 / `rsi auto rebase-baseline`);③记录提交不存在或历史无共同祖先 → 熔断 `personal_repo_invalid`。④`owner_repo_fp` 与当前 `[rsi] repo` 不同 → `personal_owner_changed`:暂停新增生效,`rsi auto rebase-baseline --adopt-owner`(TTY)确认后改写记录;撤销照常。
- R21-3.6 `[V1]` **私有仓库提交原语** `commitPersonal(ctx, lockHandles, treeSpec)`(新,`src/rsi/personal/commit.ts`):调用方必须持 `personal/lock`(正常路径另持 `rsi/lock`,缩减入口下不持);只在 R21-3.5 判为情形①时执行(否则返回 `deferred`,R21-9.3a)。按「候选集合 + 内容寻址快照」以底层命令重建目标树并提交:`hash-object -w --no-filters`、`mktree`、`commit-tree`、`update-ref refs/heads/rsi <新> <旧>`(带期望旧值,原子比较交换),再以 `read-tree -m -u <旧> <新>` 做两树合并同步工作树——**不用 `--reset`**,工作树里有与目标冲突的未提交改动时 git 拒绝覆盖,kit 按 `personal_repo_diverged` 处理;不依赖 `git revert`、不用 `add` / `commit` 的高层路径。git 子进程一律 `runSync('git', …)`,环境与 R21-17.8 的封闭执行配置相同(`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL` 指向空文件、清除继承的 `GIT_*`、`-c core.hooksPath=<空目录>`、`-c core.fsmonitor=false`、`-c core.attributesFile=`、`-c protocol.allow=never` 且**不放行任何协议**、`-c commit.gpgsign=false`);作者与提交者固定为常量身份 `RSI_PERSONAL_AUTHOR`(不含邮箱字面量,不读用户全局配置)。因本地配置已被 R21-3.4 限为白名单、全局与系统配置被屏蔽,不存在可被调用的过滤器、钩子或外部程序。变异:去掉 `core.hooksPath` 覆盖、放行本地 `filter.*`、放行 `include.*`、改回 `read-tree --reset` → 对应夹具(全局钩子、本地过滤器、include 链、工作树里有用户未提交改动)的测试红。
- R21-3.6a `[V1]` **提交 journal 与恢复优先级**:`personal/lock` 串行化所有提交,同一时刻至多一个在途提交,journal 为单文件 `rsi-personal/commit-journal.json`(`PersonalCommitJournal`,`strictObject`,0600):`{schema_version, txn_id, kind: transition|rollback|clear|purge_rewrite|reconcile|identity_change, candidate_ids, ref: "refs/heads/rsi", old_head, target_tree, new_commit, phase, at}`,`phase` ∈ `planned → objects_written → ref_updated → worktree_synced → recorded`,每一步先 `fsync` journal 再做下一步;`recorded` 之后更新 `head.json`,最后删除 journal。**恢复**(下一次任何持 `personal/lock` 者,先于 R21-3.5 的判定)先读五个观测值:①HEAD 是否为指向 `journal.ref` 的符号引用(不是 detached,不是别的分支);②`journal.ref` 的值;③索引树(`diff-index --cached` 与 `old_head` / `new_commit` 比较);④工作树(`diff` 与二者比较);⑤未跟踪与忽略文件(`status --porcelain --ignored` 的 `??` / `!!` 项)。**只允许三种组合继续**:a)①是、②=`old_head`、③④都等于 `old_head`、⑤无 → 提交未生效:丢弃 journal(新对象无引用、无害),由调用方从头重做;b)①是、②=`new_commit`、③④都等于 `old_head`、⑤无 → 引用已更新、工作树未同步:以 `read-tree -m -u <old> <new>` 补同步,再更新 `head.json`、删 journal;c)①是、②=`new_commit`、③④都等于 `new_commit`、⑤无 → 只差记录:更新 `head.json`、删 journal。**其余任何组合**(切到同一提交的其它分支、detached HEAD、只改了索引、工作树混合、出现未跟踪文件、引用为第三个值)→ 保留 journal,判 `personal_repo_diverged`,不改引用、索引与工作树。`head.json` 只在 journal 到达 `recorded` 后写,所以「已提交但 `head.json` 未更新」一定由 journal 识别,不会被 R21-3.5 ②误判。验收:在五个 `phase` 之间各注入一次崩溃,恢复后 HEAD、索引、工作树、`head.json` 一致且不出现 `personal_repo_diverged`;另在崩溃窗口里分别①改一个工作树文件、②切到指向同一提交的另一分支、③进入 detached HEAD、④只改索引、⑤加一个未跟踪文件,恢复后用户的改动都保留、状态为 `personal_repo_diverged`、journal 仍在。
- R21-3.7 `[V1]` **`PersonalLifecycleRecord`**(新 schema,`strictObject`,私有仓库 `lifecycle/<id>.json`;只增字段不改):

| 字段                  | 类型 / 取值                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`      | `1`                                                                                                                                                                           |
| `id`                  | 候选 id(`ra_` + 12 位十六进制,kit 生成)                                                                                                                                       |
| `category`            | `rule \| pitfall \| method \| subagent \| capability_note \| exec`                                                                                                            |
| `lifecycle`           | R21-4.1 个人生命周期状态之一                                                                                                                                                  |
| `deploy`              | `{claude, pi, codex}` 三键,每键取 R21-4.2 本机部署状态之一(不参与的 agent 恒 `none`)                                                                                          |
| `watch`               | `{claude, pi, codex}` 三键,每键 `null` 或 `{phase, started_at_session, pre_sessions, post_sessions, result}`(`phase` 取 `pre` 或 `post`;`result` 的唯一封闭枚举见 R21-6.8)    |
| `rollback`            | `null` 或 `{phase, reason, target_terminal}`(R21-9.1)                                                                                                                         |
| `target_paths`        | 私有仓库相对路径数组(1..4)                                                                                                                                                    |
| `content_sha256`      | 规范化正文的 sha256                                                                                                                                                           |
| `fp_hmac`             | 规范化正文的 HMAC(本机密钥,R21-11.2)前 16 位                                                                                                                                  |
| `cluster_id`          | 目标聚类 id                                                                                                                                                                   |
| `case_set_sha256`     | `null` 或固定测试集合哈希(V3,R21-14.1)                                                                                                                                        |
| `blocked_from`        | `null` 或进入 `blocked` 前的状态                                                                                                                                              |
| `transitions`         | `[{dim, agent?, from, to, at, reason, idem_key}]`(`dim` 取 `lifecycle` / `deploy` / `rollback`),只追加;超过 256 条时最早的合并为 `transitions_dropped` 计数(完整历史在审计里) |
| `transitions_dropped` | 非负整数                                                                                                                                                                      |
| `terminal_reason`     | `null` 或 R21-4.6 的终态理由码之一                                                                                                                                            |
| `overlaps_preset`     | boolean(R21-5.1 G4)                                                                                                                                                           |

- R21-3.8 `[V1]` **权威副本与工作副本**:私有仓库的 `lifecycle/<id>.json` 是权威副本;`.state/rsi/candidates/<id>.json` 是工作副本(含 shadow 命中计数、证据归属、监视期的中间统计)。同步检查点:每次 `lifecycle` / `deploy` / `rollback` 维度的转移都经一次 `commitPersonal` 写入权威副本,写成功后才更新工作副本对应字段;工作副本的统计字段在两次转移之间可以领先。判定:权威副本领先于工作副本(崩溃于两步之间)→ 以权威副本为准续做;两者在转移历史上分叉(同一 `idem_key` 不同结果)→ `candidate_invalid`(安全阻断)。
- R21-3.9 `[V1]` **与 §18 不混用**(修订 §18,§21.18 第 4 条):`PersonalLifecycleRecord` 只出现在私有仓库;§18 的 `LifecycleRecord`、`attest` / `promote` / `retire` 只用于框架仓库自己的原子(人工路径)。现有代码对这一范围的实际强制是 `layer=personal` → 退出 2 `PERSONAL_LAYER_P2`(§18.2 不变),外加个人层产物从不写进框架仓库的 `rules/` 等目录;「只服务框架仓库」是范围声明,不是新增的仓库身份守卫。§18.5 理由码不变,`terminal_reason` 是独立枚举。
- R21-3.10 `[V1]` **原子字段**:个人层规则 / 踩坑沿用 `AtomFrontmatter`,取 `layer=personal`、`origin=auto_rsi`、`strength=should`;踩坑另要求 `kind=fact`、`volatility=volatile` 与非空 `trigger`(若 `AtomFrontmatter` 无 `trigger` 字段,V1 schema 落地时**追加可选字段**,不改既有字段)。`origin=auto_rsi` 是唯一能让候选进本机 payload 的来源值。

### 21.4 候选状态机:统一转移表(两个正交维度)

两个维度分开存:**个人生命周期** `lifecycle`(每候选一个)与**本机部署** `deploy`(每候选每 agent 一个,R21-3.7)。唯一实现 `transition(record, event, ctx)` 推进;每个转移写一条 `transitions[]` 与一行审计(R21-12.10)。**守卫**全部为真才转移;**幂等键** `idem_key` = `sha256(id, dim, agent, from, to, 触发证据指纹)` 前 16 位,同一键重复执行是空操作;**恢复**:崩溃后按 `txn/<id>.json` 续做,续做本身可再崩溃再续;**时钟**只经注入。

- R21-4.1 `[V1]` **维度一:个人生命周期**(`lifecycle`;「会话」= R21-1.7 的有观测会话):

| 从 → 到                            | 事件 / 守卫                                                                                                                                                                        | 计时       | 期  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --- |
| (无)→ `proposed`                   | ingest 成功(§17.1 ingest 修订)                                                                                                                                                     | —          | V1  |
| `proposed → shadow`                | G0–G7 全过                                                                                                                                                                         | —          | V1  |
| `proposed → rejected`              | 任一闸红;或 `veto`;或 taint                                                                                                                                                        | —          | V1  |
| `shadow → canary`                  | ≥ 20 会话且签名命中 ≥ 2;全局评估名额空闲(R21-6.8);profile ≥ medium 且 `RSI_AUTO_PHASE ≥ V3` 时另需 G8 通过且 `case_set_sha256` 已固定;`category=exec` 另需 R21-16.2 的 E1 准入守卫 | 会话       | V1  |
| `shadow → expired`                 | ≥ 20 会话且命中 < 2                                                                                                                                                                | 会话       | V1  |
| `shadow → rejected`                | G8 红(V3);`veto`;taint                                                                                                                                                             | —          | V1  |
| `proposed\|shadow → rejected`      | `rsi auto clear`(`cleared`;无部署,直接终态,不经 `rolling_back`)                                                                                                                    | —          | V1  |
| `shadow → blocked`                 | G8 所需测试未就绪:生成超 15 会话或执行超 30 会话(R21-14.5)                                                                                                                         | 会话       | V3  |
| `blocked → shadow`                 | 证据到齐                                                                                                                                                                           | —          | V3  |
| `blocked → expired`                | 进入 `blocked` 后再 30 会话                                                                                                                                                        | 会话       | V3  |
| `blocked → rejected`               | `veto`;taint;`rsi auto clear`(无部署,直接终态)                                                                                                                                     | —          | V3  |
| `canary → adopted`                 | `RSI_DECIDE_BETTER_ENABLED` 为真(V2 起,R21-7.9)且 R21-7.3 判生效                                                                                                                   | 会话       | V2  |
| `canary → rolling_back`            | R21-7.4 判变差;`veto`;taint;到上限(每组 120 会话**或**进入 canary 后 90 个 UTC 日)仍未判生效(`target_terminal=expired`);`category=exec` 授权身份变化(`target_terminal=shadow`)     | 会话或日历 | V1  |
| `adopted → stable`                 | 留出组 ≥ 20 会话(heavy 档 30)且全部保护指标非劣效(R21-7.5)                                                                                                                         | 会话       | V2  |
| `adopted → rolling_back`           | 留出组判变差;`veto`;taint;留出组到上限(120 会话或 90 个 UTC 日)仍证据不足(`target_terminal=expired`);E1 授权身份变化(`target_terminal=shadow`)                                     | 会话或日历 | V2  |
| `stable → rolling_back`            | 任一 agent 的静态监视「检出伤害」(R21-8.4)、控制图越限(R21-8.7)、C4 越限、`veto`、taint、`static_pending` 超时(R21-8.3)                                                            | —          | V2  |
| `stable → retiring`                | 静态阶段 60 个 UTC 日内签名零命中                                                                                                                                                  | 日历       | V2  |
| `rolling_back → <target_terminal>` | R21-9.1 四段全部完成;`target_terminal` ∈ `rolled_back`(缺省)、`expired`、`shadow`(仅 E1 授权身份变化,回到 shadow 重新等待确认)                                                     | —          | V1  |
| `retiring → <target_terminal>`     | 经撤销路径移除完成(与 R21-9.1 同四段);`target_terminal` 缺省 `retired`,经 R21-4.4a 升级后为 `rolled_back`;升级不改变状态名、不重做已完成的补偿阶段,完成时按当时的有效目标转移      | —          | V2  |

- R21-4.2 `[V1]` **维度二:本机部署**(每 agent):`none → injected → static_pending → static → removal_pending → none`,另有撤回支路 `static → withdraw_pending → injected`。

| 从 → 到(某 agent)                              | 事件 / 守卫                                                                                                                                              | 期  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `none → injected`                              | `lifecycle` 进入 `canary`;该 agent 参与灰度(claude / pi 且通过 R21-6.5 准入);codex 恒不进入                                                              | V1  |
| `injected → static_pending`                    | `lifecycle` 进入 `stable` 且该 agent 的静态部署被放行(claude / pi 先;codex 见 R21-8.7);私有仓库提交含该候选                                              | V2  |
| `none → static_pending`                        | 仅 codex:R21-8.7 的延后渲染条件成立                                                                                                                      | V2  |
| `static_pending → static`                      | 本机 payload 经 safe 条件同步成功(R21-8.2),HOME 中该 agent 的托管块存在且内容哈希一致;**同时**该 agent 停止注入正文(`canary.json` 对该 agent 去掉该候选) | V2  |
| `static → withdraw_pending`                    | R21-8.6:该 agent 转后 120 会话仍未证实非劣效                                                                                                             | V2  |
| `withdraw_pending → injected`                  | 撤销路径移除该 agent 的托管块完成,且渲染意图(R21-8.1)对该 agent 已改为「不渲染」;claude / pi 回 0.8 / 0.2 注入                                           | V2  |
| `withdraw_pending → none`                      | 仅 codex:撤回后对 codex 保持关闭                                                                                                                         | V2  |
| `injected → removal_pending`(撤回后的常驻注入) | 该 agent 撤回后的常驻注入已满 120 个有观测会话(R21-6.8)                                                                                                  | V2  |
| `* → removal_pending`                          | `lifecycle` 进入 `rolling_back` 或 `retiring`                                                                                                            | V1  |
| `removal_pending → none`                       | R21-9.1 第四段完成判据对该 agent 成立                                                                                                                    | V1  |

- R21-4.3 `[V1]` **合法组合**(其余 = `candidate_invalid`,安全阻断;「全 none」指三个 agent 都是 `none`):`proposed|shadow|blocked|rejected|expired|rolled_back|retired` ↔ 全 none;`canary|adopted` ↔ 每个 agent ∈ `none|injected`(codex 恒 `none`);`stable` ↔ 每个 agent ∈ `none|injected|static_pending|static|withdraw_pending|removal_pending`(`removal_pending` 只用于撤回后常驻注入结束的那个 agent,R21-4.2、R21-6.8);`rolling_back|retiring` ↔ 每个 agent ∈ `none|removal_pending`。
- R21-4.3a `[V6a]` **`category=exec` 的部署语义**(不经本机 payload、不经 sync,R21-8.1):同一组状态名在 E1 上表示每个 agent 的启用方式而不是渲染,与 `exec-enabled.json` 的 `agents[<agent>]`(R21-16.2a)**逐状态**对应:`none` ↔ `off`;`injected` ↔ `gated`(只放行该 agent 的 treat 组会话);`static_pending` 不使用,`stable` 且该 agent 静态放行时 worker 在同一次提交里把许可改为 `open` 并把部署记为 `static`;`static` ↔ `open`;`withdraw_pending` ↔ `gated`——进入 `withdraw_pending` 的那次提交就把 `open → gated`(收紧,R21-2.2 下暂停时也允许),随后同一 worker 把部署推进为 `injected`(无 payload 可撤,两步之间崩溃按 journal 续做);`removal_pending` ↔ `off`(进入时即收紧为 `off`),移除完成后 `→ none`。任何时刻只有一个 agent 的许可被改动,其它 agent 不受影响。E1 只对 claude / pi 启用,codex 恒 `none` / `off`(codex 不参与分组,R21-6.1)。E1 的静态监视期按 R21-8.4 / R21-8.5 每 agent 分别做(「转前 / 转后」改为「gated / open」),名额规则同 R21-6.8。
- R21-4.4 `[V1]` **任何离开注入的路径都先停注入**:`lifecycle` 离开 `canary` / `adopted` / `stable` 一律经 `rolling_back` 或 `retiring`(R21-9.1 四段,第二段停注入);不存在直接改 `lifecycle` 字段到终态的路径。`proposed` / `shadow` / `blocked` 没有部署,直接进终态。
- R21-4.4a `[V1]` **重复终止事件**:①处于 `rolling_back` / `retiring` 的候选再收到终止事件(`veto`、taint、`harm_*`、`clear`、E1 停用事件):追加一条 `dim=lifecycle`、`from` 与 `to` 都等于**实际当前状态**(`rolling_back` 或 `retiring`)的转移记录,**不重置**已完成的补偿阶段;`target_terminal` 只能按优先级升级、不能降级:`rolled_back` > `retired` > `expired` > `shadow`(例如 E1 身份变化中途被 `veto` → 目标升为 `rolled_back`;`retiring` 中途检出伤害 → 目标升为 `rolled_back`);`terminal_reason` 取优先级最高者:`vetoed` > `tainted` > `cleared` > `auto_rollback` > `static_sync_timeout` > `auto_expired` > `no_hit` > `rejected_gate`。②已在终态的候选:`veto` 只写黑名单(R21-11.3),其余终止事件是空操作(只写审计)。③同一 `idem_key` 的事件重复到达是空操作。
- R21-4.5 `[V1]` 每个转移函数的四件事(守卫、幂等键、注入的时钟、崩溃恢复)在实现里显式写出;测试对每条转移各一个「守卫为假不转移」与「同一 `idem_key` 执行两次只转移一次」用例,对每个非终态各一个 `veto` 与 taint 用例。
- R21-4.6 `[V1]` **终态理由码**(`terminal_reason`,封闭枚举):`auto_rollback`(R21-7.4 / R21-8.4 / 控制图 / C4)、`auto_expired`、`vetoed`、`no_hit`、`rejected_gate`、`tainted`、`static_sync_timeout`、`cleared`。**转移原因码** `reason` 为封闭枚举,分两类:①**正常转移**:`ingested`(→ proposed)、`gates_passed`(→ shadow)、`shadow_hits_met`(→ canary)、`evidence_ready`(blocked → shadow)、`decided_better`(→ adopted)、`holdout_passed`(→ stable)、`deploy_injected`、`static_released`(→ static_pending)、`sync_ok`(→ static)、`withdraw_done`、`residual_ended`、`exec_enabled`、`exec_unrestricted`、`compensation_done`(rolling_back → 终态)、`revocation_reconciled`(R21-9.5)、`retire_done`;②**终止 / 异常**:G0–G8 原因码(R21-5.1)、`harm_c1|harm_c2|harm_c3|harm_c4|harm_c6`、`limit_reached`、`vetoed`、`tainted`、`cleared`、`identity_changed`、`exec_post_check_failed`、`exec_timeout_unclean`、`static_sync_timeout`、`withdraw_120`、`no_hit`。

### 21.5 机器闸 G0–G9

- R21-5.1 `[V1]` 全部确定性代码、零 LLM,由 worker 执行;闸通过只表示「没检出已知问题」(展示带 R21-1.9 标签)。闸表(判据详见 v3.1 §4.1,此处只写机器可判的口径与稳定原因码,原因码进 `PersonalLifecycleRecord.transitions[].reason`):

| 闸  | 判据(机器可判)                                                                                                                                                                                                                                                                                                                         | 原因码                                                                                                                                                                        | 期   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| G0  | v2 受控入口全量校验(schema、别名、摘录机械复制、话术、不可见字符、回显、路径守卫模拟)                                                                                                                                                                                                                                                  | `g0_<子码>`(沿用 ingest 的码)                                                                                                                                                 | V1   |
| G1  | 已知注入模式:C1 话术(**极性修复后**,backlog 遗留 ①;未修好前 G1 视为不可用 → R21-1.5)、C1b 不可见字符、脱敏 pass2、终端控制序列;技能另扫「执行外部下载」「关闭校验」                                                                                                                                                                    | `g1_phrase`、`g1_invisible`、`g1_redact`、`g1_ctrl`、`g1_skill`                                                                                                               | V1   |
| G2  | 已知风险模式固定词表(带极性):跳过测试 / 检查、关闭签名、强制推送、删除保护、关闭钩子;提及 kit 自身及其指标 / 信号类型;项目特征(信号库出现过的项目目录名、`exclude_names`);修改或 override 既有安全类原子                                                                                                                               | `g2_risky`、`g2_kit_ref`、`g2_project_feature`、`g2_safety_atom`                                                                                                              | V1   |
| G3  | 证据 ≥ 2 个会话、≥ 2 个不同 UTC 日;踩坑另要求 trigger 在历史失败信号命中 ≥ 2 次;证据全部归属「采集中」                                                                                                                                                                                                                                 | `g3_sessions`、`g3_days`、`g3_trigger`、`g3_attribution`                                                                                                                      | V1   |
| G4  | 不冲突;不 override / disable 任何非 `auto_rsi` 原子;`strength=should`;近重复(比对集合含预置技能与全部 `stable` 候选)→ 拒;功能重叠未达近重复阈值 → 不拒、记 `overlaps_preset=true`;墓碑 / 冷却命中;目标路径命中 R21-1.2;子代理候选只许改描述与提示、工具集只减不增(与现有定义差分),方法 / 技能正文 ≤ 4096 字节、触发描述 ≤ 200 字节(V3) | `g4_conflict`、`g4_override`、`g4_strength`、`g4_near_dup`、`g4_tombstone`、`g4_cooldown`、`g4_framework_path`、`g4_tools_expanded`、`g4_field_not_editable`、`g4_skill_size` | V1   |
| G5  | 渲染后各目标 `level=ok`;自动配额(R21-5.3);规则 / 踩坑单条 ≤ 600 字节(方法 / 技能按 G4 的类别上限,不套 600);M11 注入上限(标记行 + treat 追加部分 ≤ 1536 字节)                                                                                                                                                                           | `g5_budget`、`g5_quota`、`g5_atom_bytes`、`g5_inject_bytes`                                                                                                                   | V1   |
| G6  | 签名在近 30 个 UTC 日信号上回放的命中会话数 ∈ [2, 0.5 × 同期会话数]                                                                                                                                                                                                                                                                    | `g6_too_few`、`g6_too_broad`                                                                                                                                                  | V1   |
| G7  | 退火:每个目标聚类同时一个非终态候选;全局评估名额至多一个(R21-6.8)                                                                                                                                                                                                                                                                      | (排队,不拒)`g7_queued`                                                                                                                                                        | V1   |
| G8  | 固定测试(medium / heavy;lite 不跑):候选通过率 ≥ 现状;不被「通过率更高且字节更少」者支配(§21.14);是 `shadow → canary` 的守卫                                                                                                                                                                                                            | `g8_worse`、`g8_dominated`、`g8_timeout`                                                                                                                                      | V3   |
| G9  | 生效判据(§21.7、§21.8)                                                                                                                                                                                                                                                                                                                 | (转移,不拒)                                                                                                                                                                   | V1.5 |

- R21-5.2 `[V1]` G0–G7 按编号顺序执行,首个红即停;任一闸实现抛错 → B2 `gate_internal`(熔断),**不**记为 `rejected`。
- R21-5.3 `[V1]` **自动配额**(v3.1 §3.5,常量):每个渲染目标预算的 25%(claude `max_lines=200` 中 50 行;其它 16384 字节中 4096 字节),lite 档只用一半(12.5%);配额内 规则 50% / 踩坑 30% / 技能触发描述 20%(逻辑分类,渲染后共用 `rules` 文件的同一份预算);预置技能不计入。新增使配额占用 ≥ 80% 时必须同时配对退役一条,否则 G5 拒;本代循环越过 80% 而未配对 = 实现缺陷 → B2。
- R21-5.4 `[V1]` 关联标记行与 treat 追加的标签 / 哈希行(R21-6.3)对 G1 / G2 豁免,豁免只按标记的精确字节前缀与内容哈希匹配,不按「看起来像标记」。

### 21.6 灰度:分组账、关联标记与 hint canary 模式

- R21-6.1 `[V1]` 参与 agent:claude 与 pi;codex 不参与(M4),codex 的 hint 永不进入分组路径。
- R21-6.2 `[V1]` **分组调用**:分组只发生在 hint 以 `--canary` 调用时(新参数,R20-3.3 修订);该调用只由 `rsi hooks` 安装的「每会话开始一次」钩子发出(claude:`SessionStart` 且 matcher 为 `startup`,恢复 / 压缩不发;pi:`before_agent_start` 中每会话首次触发的形状,以 V1 准入实测为准,R21-6.5)。`--canary` 调用**不受** R20-3.3.4 的 30 分钟去重约束(计数行去重与分组是两套机制,计数行照旧去重)。hint 用注入的随机源,以概率 `RSI_CANARY_P`(canary 期 0.5;adopted 期注入 0.8 / 留出 0.2)决定组别。
- R21-6.3 `[V1]` **关联标记**(每个被随机的会话都输出,两组相同):一行 `RSI_MARK_PREFIX` + 空格 + 随机会话标记(`rsm_` + 16 位十六进制),≤ 64 字节,不含任何候选内容。**treat 组**在标记行之后追加:R21-1.9 标签一行、候选内容哈希前 12 位一行、候选正文;标记行 + 追加部分 ≤ 1536 字节(M11)。**control 组**只有标记行。不含路径、项目名、摘录。
- R21-6.4 `[V1]` **分组账** `.state/rsi/canary-ledger.jsonl`(`RsiCanaryLedgerLine`,0600,`O_APPEND` 单行、不拿锁,与 R20-5.1 末行同类),行为两种 `kind` 的联合:`assign` = `{kind, at, agent, marker, candidate_id, arm: "treat"|"control"|"excluded", reason, p, background_fp, background_fp_ex, policy_fp, case_set_sha256, overlaps_preset, hint_version}`,`reason` 在 treat / control 为 `null`,在 excluded 取封闭枚举 `paused | not_admitted | policy_mismatch | agent_not_injected | revoked | rng_error | permit_unreadable`(`marker` 在 excluded 行为 `null`,因为未输出标记);`stop` = `{kind, at, candidate_id, reason, revocation_ref}`(R21-9.1 第二段):`revocation_ref` 在普通 stop 行为 `null`;在撤销对账写的 stop 行(`reason=revocation_reconciled`)为必填的 16 位十六进制(对应凭据行的 sha256 前 16 位),同一 `revocation_ref` 至多一行,`reason=revocation_reconciled` 而 `revocation_ref` 为 `null` 的行过不了 schema。`arm=excluded` 表示「未随机」(准入未过、暂停、策略指纹不符、失败兜底),`p=0`,不进分析、计入 C6 分母说明。`at` 只到秒;无路径、无项目 key。`background_fp` = 当前本机已同步 payload 的 `payload_sha256`(§19.8)前 16 位;`background_fp_ex` = 去掉当前候选托管块后的同一哈希(静态前后配对用,R21-8.4)。
- R21-6.5 `[V1]` **准入**:某 agent 开分组之前,必须在真实会话里实测一次:①标记进了会话记录且被 reader 取回;②「每会话开始一次」的钩子形状确实每会话只触发一次(§10.3 动作 2)。未通过的 agent 的 `--canary` 调用一律 `arm=excluded`。准入结果记 `.state/rsi/canary-admission.json`。
- R21-6.6 `[V1]` **会话归并**:reader 在一个会话记录里取回 0 个标记 → 该会话「关联失败」(计入 C6);取回 ≥ 2 个不同标记 → 「多标记」,整会话排除出分析并计入 C6(可判、可测)。
- R21-6.7 `[V1]` **资格与 ITT**:资格 = 会话所属项目在**会话开始之前**30 个 UTC 日内出现过目标签名;只用会话开始前的数据判定。hint 不知道会话项目(R20-1.9 不变,不读 cwd / stdin),因此分组对项目盲,资格在分析时由 L0 归属现算(§21.22 Q-B)。主分析 ITT:全部被随机(`arm ∈ treat|control`)且资格成立的会话进分母;关联失败的按最坏情况做敏感性分析。
- R21-6.8 `[V1]` **评估名额与释放**(全局至多一个候选占用):占用条件 = `lifecycle ∈ canary|adopted`,或 `lifecycle = stable` 且**不满足**下文的释放条件(占用与释放互补:任一参与 agent 的 `watch.result ∈ not_started|pending|withdrawn_residual` 都占用,包括 claude / pi 已 `passed`、codex 仍在等待 20 个转前会话的情形)。`watch.result` 封闭枚举:`not_started`(启动条件尚未满足)、`pending`(监视中)、`passed`(R21-8.4②)、`withdrawn_residual`(R21-8.6 撤回后回到 0.8 / 0.2 的常驻注入,只做 R21-7.4 的变差监视,最多 120 个该 agent 的有观测会话)、`withdrawn_ended`(常驻注入满 120 会话后经撤销路径移除,`deploy → none`,原因 `residual_ended`)、`skipped`(启动条件已不可能满足:codex 在 claude 或 pi 任一不是 `passed` 时置为 `skipped`)、`harm`(候选随之回滚)。**释放**:每个参与 agent 的 `watch.result ∈ passed|withdrawn_ended|skipped` 时释放;候选进入 `rolling_back` 时释放(回滚期间不占名额,它只会减少影响)。若释放时没有任何 agent 处于 `static` → 候选 `rolling_back`(`target_terminal=expired`,原因 `withdraw_120`)。其余候选在 `shadow` 排队(G7)。
- R21-6.9 `[V1]` **reader 注入识别**:reader 识别以 `RSI_MARK_PREFIX` 开头的内容块及其后的标签 / 哈希 / 正文,把它及其直接复述(与正文连续 16 字以上重合的消息片段)排除出显式教训、工具调用等全部计数,只用于取回标记与 C6;规则写进 `reader-counting-spec.md`(§21.18 第 20 条)。
- R21-6.10 `[V1]` **hint `--canary` 的读集合与判定顺序**(细化 R20-3.3,§21.18 第 14 条):读集合在 R20-3.3.1 之外**只**追加 `.state/rsi/{canary.json, canary-admission.json, AUTO_PAUSE}` 与 HOME 侧 `rsi-personal/revocations.jsonl`(≤ 1MiB,超出按读取失败处理)的存在性与内容;不读私有仓库、不读信号库。`canary.json`(worker 持 `rsi/lock` 与 `personal/lock` 写,0600)= `{candidate_id, content_sha256, body, content_sha12, p_by_agent, agents_inject, background_fp, background_fp_ex, policy_fp, revocation_gen, generation}`。判定顺序与各分支的输出 / 写入见 R21-6.11 结果矩阵;其中「用当前配置现算 `policy_fp`(R20-6.9 的排除策略指纹)与 `canary.json.policy_fp` 不等」与「`revocations.jsonl` 含 `(candidate_id, content_sha256)`」都是 hint 自己现算的,不等 worker:排除写下或撤销凭据落盘后的下一次 hint 即停注入。
- R21-6.11 `[V1]` **hint `--canary` 结果矩阵**(按顺序判定,先命中先用;「C6」列表示该会话是否进 C6 分母):

| #   | 情形                                                                                                         | stdout              | 写入                                                  | C6  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------- | --- |
| 1   | R20-1.6 跳过条件、状态 `off` / `stopped` / `armed`、配置不可用、停止采集                                     | 无                  | 无(R20-1.10 零写入)                                   | 否  |
| 2   | 自动循环未开启(R21-2.2)或 `RSI_AUTO_PHASE < 1`;agent 为 codex                                                | 无                  | 无                                                    | 否  |
| 3   | `canary.json` 不存在、无评估中候选、或读取 / 解析失败                                                        | 无                  | 无(没有合法 `candidate_id`,不伪造账行)                | 否  |
| 4   | 已知候选,但 `AUTO_PAUSE` 存在、准入未过、`policy_fp` 不符、agent 不在 `agents_inject`、撤销凭据命中(R21-9.5) | 无                  | 分组账一行 `arm=excluded` + 原因码                    | 否  |
| 4a  | 已知候选,但撤销凭据、准入文件或 `AUTO_PAUSE` 的读取 / 解析失败,或撤销凭据超过 1MiB                           | 无                  | 分组账一行 `arm=excluded`(`permit_unreadable`);不随机 | 否  |
| 5   | 已知候选,随机源报错                                                                                          | 无                  | 分组账一行 `arm=excluded`(`rng_error`)                | 否  |
| 6   | 已知候选,随机为 control                                                                                      | 关联标记行          | 分组账一行 `arm=control`                              | 是  |
| 7   | 已知候选,随机为 treat                                                                                        | 关联标记 + 追加部分 | 分组账一行 `arm=treat`                                | 是  |
| 8   | 第 6 / 7 行的账行追加失败                                                                                    | 无(未落账不输出)    | 无                                                    | 否  |

**未落账不注入**:第 6、7 行的 stdout 只在账行 `O_APPEND` 写入并 `fsync` 成功之后输出。计数行(若本次也输出)按 R20-3.3 的原有规则独立判定,与本表无关;两部分合计 ≤ 200 + 1536 字节。纯文本模式(无 `--format`)不走本表。

### 21.7 固定分析计划与统计常量

- R21-7.1 `[V1]` **常量**(写进 `src/contracts/rsi.ts`,不可配置;标「待 V1.5 校准」的数值只能由 V1.5 报告后的契约修订改):`RSI_MIN_SESSIONS_PER_ARM`(lite / medium 20、heavy 30)、`RSI_MIN_CONTROL_EVENTS=15`(主判据)、`RSI_MIN_CONTROL_EVENTS_C3=30`(待 V1.5 校准)、`RSI_MAX_RR_CI_WIDTH=0.6`(双侧 90% 区间)、`RSI_MAX_SESSIONS_PER_ARM=120`、`RSI_MAX_CANARY_DAYS=90`、`RSI_PERMUTATIONS=2000`、`RSI_ALPHA_BETTER=0.05`(单侧)、`RSI_RR_BETTER_UPPER=0.7`、`RSI_ALPHA_WORSE_TOTAL=0.10`、`RSI_ALPHA_BETTER_LOOK=0.025`、`RSI_LOOK_EVERY=10`、`RSI_TOOLCALL_DROP_SUSPECT=0.40`、`RSI_ANALYSIS_PLAN_VERSION`。保护指标界限(待 V1.5 校准):C1 率比 < 1.15;C2 几何均值比 < 1.15;C3 率比 < 1.25;C4 绝对上限(canary ≤ 1536 字节 / 会话;常驻 ≤ 自动配额);C5 率比 < 1.15(标注 ≥ 200 条后才可用);C6 两组完整率差 < 5 个百分点。边界一律:非劣效 = 上界**严格小于**界限;伤害 = 下界**严格大于** 1(或 C6 差值下界严格大于 5 个百分点);生效 = 上界**小于等于** 0.7 且单侧 p ≤ α。
- R21-7.2 `[V1]` **分析单位与统计量**(`analysis-plan v1` 的已定部分):单位 = 会话;分层 = agent × 项目,任一组会话数 < 2 的层并入该 agent 的「其它」层;C1、C3 与主判据用 Mantel–Haenszel 率比;C2 用 `log(1 + retry_chain_len)` 的分层均值差(即几何均值比);C6 用分层完整率差;p 值由分层置换(`RSI_PERMUTATIONS` 次,随机源可注入、种子写审计)给出,不假设泊松独立。两组均零事件 → 证据不足。
- R21-7.3 `[V2]` **判生效**(三重门槛全满足后才查看):每组 ≥ `RSI_MIN_SESSIONS_PER_ARM`、对照组主判据事件 ≥ 15、主判据率比区间宽度 ≤ 0.6;主判据单侧显著且上界 ≤ 0.7;C1、C2、C3、C6 每项非劣效;C4 未越限;每会话工具调用数降幅 ≤ 40%;profile ≥ medium 且 V3 起另需 G8 通过且当前 `case_set_sha256` 与分组账一致。只在门槛首次满足时与到上限时各查看一次(各 α = 0.025)。**区间构造**(置换反演的网格、步长)与数值夹具属 `analysis-plan v1` 的附表,由 V1.5 的契约修订写入;附表写入前,一切需要区间的正向判定(本条、R21-7.5、R21-8.4②)**不可判通过**。
- R21-7.4 `[V1]` **判变差**(不需要三重门槛,只用置换 p 值):总 α = 0.10 在 C1、C2、C3、C6 四项间平分(各 0.025,Bonferroni);每项按 Lan–DeMets O'Brien–Fleming 型 spending,信息时间 t = min(1, 对照组有观测会话数 / 120),每 `RSI_LOOK_EVERY` 个新有观测会话查看一次;任一越过边界 → `rolling_back`(`harm_<指标>`);C4 越限即回滚。canary 与 adopted 各用独立的查看计划(信息不累计);`background_fp` 换段后新段从 t = 0 重新计。判定关闭(R21-7.9)时**变差方向照常生效**。
- R21-7.4a `[V1]` **判变差的稀疏分层规则**(现在就定,不等附录):某次查看时,并层(R21-7.2)之后仍有任一组 < 2 个会话的层,本次查看把该层剔除出置换检验,剔除的会话数写进审计;剔除后无层可用 → 本次查看**不判定、不消耗 α**,信息时间照常推进,下一次查看重试;到上限时仍从未完成过一次有效查看 → 按「证据不足」走 R21-7.6(经回滚到 `expired`)。这一规则只作用于不需要区间的变差方向;正向方向的稀疏处理仍属 `§21.7a`(R21-7.13 ③)。
- R21-7.5 `[V2]` **留出组**(adopted):注入 0.8 / 留出 0.2;留出组 ≥ `RSI_MIN_SESSIONS_PER_ARM` 且全部保护指标非劣效 → `stable`;变差方向同 R21-7.4;到上限仍证据不足 → `rolling_back`(`target_terminal=expired`)。
- R21-7.6 `[V1]` **证据不足**:区间过宽、指标缺失、两组零事件 → 不判生效;到上限 → 经回滚到 `expired`(M9 A)。
- R21-7.7 `[V1]` **背景分段**:注入阶段按分组账 `background_fp` 分段,跨段不合并;主分析只用当前段,之前的段只作敏感性分析(v3.1 §0a.2)。本机 payload 漂移(登记表报告某托管块被用户改过)期间分析暂停,不计入任何组。
- R21-7.8 `[V1]` `overlaps_preset=true` 的候选照常评估,在报告与功效模拟里单列。
- R21-7.9 `[V1]` **判定开关**:常量 `RSI_DECIDE_BETTER_ENABLED`,V1 与 V1.5 恒为假;V1.5 报告通过、用户在场看过(§10.3 动作 3)且 `analysis-plan v1` 附表已写入后,随 V2 的契约修订置真。为假时 canary 只会经回滚走向 `rolled_back` 或 `expired`。变异:常量缺省为真 → 契约测试红。
- R21-7.10 `[V1.5]` **只记录期**:≥ 30 个 UTC 日只写分组账与评估结果;「本会判生效」只记为报告里的 `would_adopt` 计数,不执行转移。`§21.7a` 写入之前没有既定的区间算法,报告对正向方向一律记「不可判」,不输出 `would_adopt`(R21-7.13)。
- R21-7.11 `[V1.5]` **功效模拟**:用本机真实历史信号的发生率与过度离散重抽样,报告上限内可检出的最小效应量;常见聚类都检不出 30% 改善 → 统计生效通道在本机不可用,判定保持关闭,并如实提示用户。
- R21-7.12 `[V1.5]` **无效果模拟验收**(模拟里已知真值):注入无关文本,误生效率 ≤ 5%;每 100 个候选至多 5 个误生效,且误生效候选在 stable 监视期内被回滚的比例 ≥ 50%。**上线后的可观测代理**(生产没有真值):「已到 `adopted` 或 `stable` 后又因 `harm_*` 回滚」的事件,30 个 UTC 日内 ≥ 2 次 → 熔断 `rollback_storm`(与 B1 同码)。
- R21-7.13 `[V1]` **未定项是正向判定的硬前置**(评审 #14 的未处理部分):`analysis-plan v1` 中以下各项在本节**尚未写定**:①置换反演求区间的网格范围与步长(C1–C3 率比、C2 几何均值比、C6 差值);②C3 事件门槛 `RSI_MIN_CONTROL_EVENTS_C3` 与 R21-7.1 各非劣效界限的校准值(现值是待校准的占位);③极稀疏分层(全部层并入「其它」后仍有一组 < 2 会话)在**区间构造**中的处理(变差方向的同一情形已由 R21-7.4a 定死);④数值夹具(给定输入 → 唯一的区间与判定)。在 V1.5 的契约修订把这四项写进本节附录 `§21.7a`、且数值夹具测试通过之前:`RSI_DECIDE_BETTER_ENABLED` 必须为假,不存在任何 `canary → adopted`、`adopted → stable`、静态阶段「证实非劣效」(R21-8.4②)的判定;只允许不需要区间的判定(R21-7.4 的置换 p 值判变差、C4 绝对上限、到上限到期)。**分期自洽**:V1 与 V1.5 只有变差方向与到期(R21-4.1 中这两期的正向转移只有 `shadow → canary`,它不依赖区间);V2 的进入条件包含「`§21.7a` 已写入且夹具通过」(§21.0);V2 的静态伤害判定(R21-8.4①用区间下界)同样只在 V2 起才有,不早于附录。若 V1.5 交不出附录,V2 不开工,循环停在「只提示 + 变差回滚」。

### 21.8 本机静态生效与静态阶段 `[V2]`

- R21-8.1 `[V2]` **本机 payload** = npm 包 payload(含预置技能)+ 私有仓库中候选的渲染结果;**渲染集合按每 agent 的部署意图选取**:某候选对某 agent 被渲染,当且仅当该 agent 的 `deploy ∈ static_pending|static`(不是「`lifecycle=stable` 就渲染」);`withdraw_pending` / `injected` / `none` 一律不渲染,所以撤回后的候选不会被下一次渲染重新部署。只由 kit 在本机渲染,`layer=personal` 在本机 payload 里照常输出(修订 §4.2,§21.18 第 1 条)。`category=exec` 的候选**永不**进本机 payload,它的部署语义见 R21-4.3a。本机 payload 写在 `.local/share/agent-kit/local-payload/`(kit 条目之内),有自己的 `integrity.json` 与本机锚点。
- R21-8.2 `[V2]` **safe 条件**(修订 §19.6,§21.18 第 7 条):§19.6 原条件全部保留,新增评估时机「本机 payload 变化后」(rsi worker 按 R21-3.3 锁序持 `rsi/lock` → `personal/lock` → sync 锁评估);新增条件与原因码:`[rsi.auto] enabled = true`(否则不评估、不留记录);差异只落在 `origin=auto_rsi` 文件上(`local_non_auto_diff`);差异里的每个自动产出文件对应一个该 agent `deploy ∈ static_pending|static` 的 `stable` 候选(`candidate_not_stable`);不在 `auto_paused`(`auto_paused`,只约束增加影响的方向)。结果写 `rsi-personal/last_local_sync.json`(R21-3.2),**不写** `UpdateState.last_auto_sync`(那是 update 锁保护的包 payload 记录)。锚点信任来源是本机 kit(不是 npm 来源证明),文档与 `doctor` 如实写明。
- R21-8.3 `[V2]` 某 agent 的 `static_pending` 持续 7 个 UTC 日仍未同步成功(safe 条件不满足)→ 候选 `rolling_back`(`static_sync_timeout`);期间该 agent 继续按 0.8 / 0.2 注入。这与 R21-8.6(已同步后 120 会话证据不足的撤回)是两条不同路径。
- R21-8.4 `[V2]` **静态阶段三种结论**(每 agent 分别,转前 vs 转后;只用于触发回滚,不用于证明效果):转前 / 转后的配对键是 `background_fp_ex`(去掉当前候选托管块后的背景哈希,R21-6.4),同一 `background_fp_ex` 下的转前与转后数据才配对;`background_fp_ex` 变化即重新开始该 agent 的监视期;登记表报告该托管块漂移期间暂停分析。①**检出伤害**:C1–C3 任一转后 / 转前率比下界 > 1,或 C6 完整率「转前 − 转后」差值下界 > 5 个百分点(R21-7.4 的序贯与 α 分配)→ `rolling_back`;②**证实非劣效**:C1–C3 率比上界 < 界限且 C6 差值上界 < 5 个百分点 → 该 agent `watch.result=passed`;③**证据不足**:继续。零事件同 R21-7.2。
- R21-8.5 `[V2]` **判定时点与分母**:分母 = 有完整观测、资格成立的会话(C6 例外,用全部被渲染的会话);转后 ≥ 20 个会话起每 10 个会话查伤害;转后 ≥ 40 个会话起每 10 个会话判一次是否通过。
- R21-8.6 `[V2]` **上限与撤回**:某 agent 转后 120 个会话仍未证实非劣效 → 该 agent `static → withdraw_pending`,经撤销路径移除其托管块,完成后 claude / pi 回 `injected`(0.8 / 0.2),codex 回 `none` 并保持关闭。`watch.result` 的赋值:撤回进行中(`withdraw_pending`)保持 `pending`;撤回完成、claude / pi 回到常驻注入 → `withdrawn_residual`;codex 撤回完成 → `withdrawn_ended`;常驻注入满 120 会话、经撤销路径移除完成 → `withdrawn_ended`(R21-6.8)。撤回中途崩溃按 journal 续做。
- R21-8.7 `[V2]` **影响面与 codex**:先只对 claude 与 pi 放行静态部署;codex 在 claude / pi 的 `watch.result` 都为 `passed`、且 codex 自身已有 ≥ 20 个转前会话后才 `none → static_pending`,再单独走一个监视期,独立维护转前 / 转后数据与分段。监视期结束后按 agent 用控制图(C1–C3 的 28 会话滚动率越过监视期估计的 99% 上界 → 回滚);控制图常量为代码常量。
- R21-8.8 `[V2]` C4 越过绝对上限、用户 `veto`、熔断 `apply_failed` → 直接 `rolling_back`。
- R21-8.9 `[V2]` 锁序见 R21-3.3;sync 锁拿不到 → `declined locked`,下一次 worker 再试。
- R21-8.10 `[V2]` `check-publish` 断言包 payload 里不存在 `layer=personal` 或 `origin=auto_rsi` 条目;方法技能只从框架源码固定路径取,并核对来源路径与文件集合(§21.18 第 21 条)。

### 21.9 回滚四段与撤销路径

- R21-9.1 `[V1]` **四段补偿流程**(`rollback.phase`,journal `rsi-personal/txn/<id>.json`;`retiring` 与 E1 授权身份变化也走同一流程,只是 `target_terminal` 不同):

| 子状态                   | 动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 完成判据(机器可判)                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rollback_requested`     | 写 journal(含 `reason`、`target_terminal`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | journal 落盘(fsync)                                                                                                                                                                  |
| `injection_disabled`     | 先写撤销凭据(R21-9.5,`revocations.jsonl` 一行,`fsync`)——它单独即可让 hint 与 `exec-run` 停止(R21-6.10、R21-16.2b)。**例外**:`reason=identity_changed`(E1,`target_terminal=shadow`)不写撤销凭据,改以旧身份的拒绝标记(R21-16.2c)作为本段完成依据,journal 记 `kind=identity_change` 与 `identity12`,恢复与对账按此识别、继续;仓库可达且状态为 `confirmed` 时再把 `canary.json` 去掉该候选(`generation + 1`)、分组账追加一行 `kind=stop`、`category=exec` 另从 `exec-enabled.json` 删除该候选;**仓库不可达,或状态为 `stopped`(前台撤销命令)、`off`(缩减入口)时**,这三项不访问、记为「待对账」——`stopped` / `off` 下 hint 不输出任何内容(R21-6.11 第 1 行)、`exec-run` 被守卫 1 / 2 拦住,持久拒绝已足够,worker 恢复运行后按 R21-9.5 无条件补清 | 撤销凭据(或 `identity_changed` 时旧身份的拒绝标记)已落盘;仓库可达且状态为 `confirmed` 时另要求磁盘上的 `canary.json` 与 `exec-enabled.json` 不含该 id(其余情形由 R21-9.5 的对账补完) |
| `static_removal_pending` | 用「候选集合 − 回滚目标」+ 内容寻址快照重建私有仓库目标树并提交(R21-3.6);重渲染本机 payload,只做差量(以「上次已同步版本减去回滚目标」为目标,不顺带生效其它 `static_pending` 候选)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 私有仓库 HEAD 的树 sha 等于目标树 sha                                                                                                                                                |
| `rollback_complete`      | 经撤销路径同步 HOME                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | HOME 中该候选的托管块 / 独占文件不存在                                                                                                                                               |

- R21-9.2 `[V1]` V1 没有静态部署,`static_removal_pending` 只做私有仓库提交、`rollback_complete` 的判据恒真;V2 起完整执行。
- R21-9.3 `[V1]` **撤销路径**(新 sync 模式,`syncRevoke`,§21.18 第 9 条):只允许**删除**自动产出的托管块 / 独占文件(每个由 `source=local` 且 `origin=auto_rsi` 的登记表条目唯一标识);**不受** `auto_paused`、候选状态条件、操作数上限、`[rsi.auto] enabled` 阻挡;**仍遵守**漂移规则(用户改过 → 不覆盖、停在 `static_removal_pending`、`rsi auto status` 提示)与 §19.2 的路径安全检查;沿用 sync 事务与备份,可 `sync --rollback`。自动产出一律写独立托管块或独占文件(不与包 payload 共用块)。
- R21-9.3a `[V1]` **人工分叉下的撤销**:R21-3.5 判为 `personal_repo_diverged` 或 `personal_owner_changed` 时,第三段的私有仓库部分返回 `deferred`:不提交、不改引用、不动索引与工作树(**不 reset 用户改动**);本机 payload 的重渲染改用「上次已同步版本减去撤销凭据所列候选」作目标(不需要读私有仓库),第四段照常经撤销路径清理 HOME。`PersonalLifecycleRecord` 的权威副本推进被推迟,工作副本记 `repo_removal_deferred=true`;分叉解除(回到记录提交或 rebase-baseline)后的第一次持锁写入方先补做被推迟的提交,再做其它事。第三段完成判据在 `deferred` 下改为「本机 payload 已不含该候选」。
- R21-9.4 `[V2]` 撤销路径在 `stopped` 状态下不由 worker 执行(worker 不运行),但前台 `rsi auto clear --write` / `rsi rollback --to --write` / `rsi veto` 可执行(与 `rsi purge --write` 同类,完成的是用户已授权的减少影响;R20-1.3 `stopped` 行的允许写集合随之追加,§21.18 第 42 条)。
  验收:仓库可达、状态为 `stopped`、`exec-enabled.json` 仍有 E1 条目时,前台 `rsi auto clear --write` 退出 0 完成撤销且不改启用表;之后 `rsi confirm` 恢复,worker 第一次拿锁先对账删除该条目,期间与之后 `exec-run` 对该候选都零调用。
- R21-9.5 `[V1]` **缩减权限撤销与撤销凭据**:
  - **撤销凭据** `rsi-personal/revocations.jsonl`(`RsiRevocationLine`,0600,持 `personal/lock` 追加并 `fsync`;只增不删):`{at, candidate_id, content_sha256, identity12, reason, by: worker|clear|rollback_to|veto|exec_event}`。凭据是「该候选的这份内容不得再注入、不得再部署、不得再执行」的权威记录,优先于仓库 `.state` 里的任何缓存。
  - **缩减入口**:`[rsi]` 配置不可用(`off`)或 `owner_repo_fp` 指向的仓库已不存在时 worker 不运行,但 `rsi auto clear [--write]` 仍可用:只读写 HOME 侧(登记表、`rsi-personal/`、私有仓库、本机 payload),只拿 `personal/lock` → sync 锁。它为每个非终态候选写撤销凭据(第二段完成),按 R21-9.3a 处理私有仓库(干净则提交,否则 `deferred`),以「上次已同步版本减去凭据所列候选」重渲染本机 payload,经撤销路径清理 HOME(第四段);仓库 `.state` 下的 `canary.json`、分组账、`exec-enabled.json`、工作副本**不访问**,记为待对账,不把访问不到的文件当作已改写。
  - **对账先于授予**:任何会授予影响的写入(写 `canary.json`、写或放宽 `exec-enabled.json`、渲染本机 payload、任一「增加影响」的转移)都必须在持 `personal/lock` 时重读 `revocations.jsonl`;凡被凭据列出的候选一律不授予。worker(含配置恢复、旧仓库重新可达、换回旧仓库的情形)每次拿锁后第一件事是**对账**:对每条凭据,**无论**仓库里该候选的工作副本是否已是终态,都核对并清理对应的授予缓存(去掉 `canary.json` 条目、删 `exec-enabled.json` 条目、补分组账 `kind=stop` 行——stop 行带 `revocation_ref` = 该凭据行的 sha256 前 16 位,已有同值的行即不重复写);工作副本不是终态时再推进到终态(原因 `revocation_reconciled`);对账未完成前不做任何增加影响的转移。`canary.json.revocation_gen` 记生成时凭据的行数,hint 与 `exec-run` 见到行数更多时照样以凭据内容为准(不信任缓存)。
  - **旧 worker 仍在运行**:它写 `canary.json` / `exec-enabled.json` 之前必须拿 `personal/lock` 并重读凭据(上一条),拿不到就放弃本次写入;已经写出的旧缓存被 hint 与 `exec-run` 的凭据检查拦住。
  - R20-1.3 `off` 行的允许写集合随之追加这一项(§21.18 第 42 条;§21.22 Q-C)。验收:①`off` 下 clear 后,把原仓库恢复为可达并重新启用配置,下一次 hint 对被清候选为 `excluded`、`exec-run` 零调用,worker 首次运行完成对账;②clear 过程中原仓库不可达,clear 仍以退出 0 完成且未创建任何仓库 `.state` 文件;③旧仓库 worker 持 `rsi/lock` 时并发 clear,两者经 `personal/lock` 串行,结果中被清候选没有任何授予写入;④工作副本已是终态但 `canary.json` / `exec-enabled.json` 仍残留该候选:下一次对账后两处都不含该候选,分组账只多一条 stop 行。
- R21-9.6 `[V1]` 回滚每个子状态都可注入崩溃并续做;续做再崩溃同样可续。

### 21.10 熔断 `auto_paused`

- R21-10.1 `[V1]` 任一触发即进入 `auto_paused`:按 R21-2.2 的事件分类,「增加影响」的转移全部禁止,其余照常;**撤销路径不受阻挡**。当前评估中候选的注入停止——hint 直接看 `AUTO_PAUSE` 标记(用户暂停,不等 worker),worker 写熔断码时同时把 `canary.json` 置为不注入(`generation + 1`);`lifecycle` 不变,解除后恢复注入,暂停期间的会话 `arm=excluded`、不计入任何一组。与 R20-6.5 的 `safety` 熔断并列:后者停采集,前者只停增加影响。
- R21-10.2 `[V1]` **码表**(`RSI_AUTO_PAUSE_REASONS`,写进 `state.json.auto_pause.reasons`,可同时存在多个):

| 码                      | 条件                                                                           | 解除                                                                                                       | 期  |
| ----------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --- |
| `rollback_storm`        | 30 个 UTC 日内自动回滚 ≥ 3 次;或 R21-7.12 的上线代理事件 30 个 UTC 日内 ≥ 2 次 | `rsi auto resume`(TTY,重查 `gate_internal`、`apply_failed`、`personal_repo_invalid`、`budget_high_legacy`) | V1  |
| `gate_internal`         | 任一闸 / 评估器 / 转移函数抛内部错误;本代循环越过配额 80% 未配对退役           | 同上                                                                                                       | V1  |
| `apply_failed`          | 本机 payload 渲染或 sync 事务失败、残留 txn                                    | `sync --resume` / `--rollback` 后 `rsi auto resume`                                                        | V2  |
| `personal_repo_invalid` | R21-3.4 结构性问题;R21-3.5 情形③                                               | 修好后 `rsi auto resume`                                                                                   | V1  |
| `budget_high_legacy`    | 自动配额占用 ≥ 90% 且不是本代循环造成                                          | 退役腾出空间后自动解除                                                                                     | V1  |
| `cost_high_legacy`      | M11 注入 / 常驻上限的遗留超限                                                  | 回落后自动解除                                                                                             | V1  |
| `no_observation`        | 7 个 UTC 日无任何有观测会话而 L0 有运行记录(采集中断)                          | 采集恢复后自动解除                                                                                         | V1  |
| `redaction_changed`     | 脱敏规则版本变化或 `known_gap` 新增                                            | `rsi auto resume`                                                                                          | V1  |
| `user_vetoes`           | 7 个 UTC 日内 `rsi veto` ≥ 2 次                                                | `rsi auto resume`                                                                                          | V1  |
| `kit_major_changed`     | kit 主版本变化                                                                 | `rsi auto resume`                                                                                          | V1  |
| `user_paused`           | 用户 `rsi auto pause`(`AUTO_PAUSE` 标记存在)                                   | `rsi auto resume`                                                                                          | V1  |
| `isolation_unverified`  | E1 探针失败、探针版本变化、运行时版本 / 配置指纹不一致(只暂停 E1 类)           | 探针重新通过后自动解除                                                                                     | V6b |

- R21-10.3 `[V1]` `personal_repo_diverged` 与 `personal_owner_changed`(R21-3.5 情形② / ④)不是熔断码,是单独的暂停原因(`state.json.auto_pause.diverged` / `.owner_changed`),只阻挡增加影响,用 `rsi auto rebase-baseline [--adopt-owner]` 或回到记录提交解除。
- R21-10.4 `[V1]` 「自动解除」由 worker 在持锁时重查条件;「`rsi auto resume`」只清除可人工解除的码,条件仍成立的码保留(resume 对它退出 1 `RSI_AUTO_RESUME_BLOCKED reason=<码>`)。

### 21.11 防止重复提出

- R21-11.1 `[V1]` **聚类冷却**(UTC 日历):自动回滚 90 天、`expired` 30 天、`rejected` 连续 5 次 7 天;期间该聚类不进 digest。与 tainted 独立。
- R21-11.2 `[V1]` **文本指纹**:规范化正文的 HMAC-SHA256(本机密钥 `.state/rsi/fp.key`,0600,32 字节随机,首建经 `createExclusive`)+ 近似指纹(固定 shingle 参数,常量);与冷却同期失效;只在本机,永不进投稿、日志、`--json`(只出前 8 位用于人工对照)。
- R21-11.3 `[V1]` **用户否决**:`rsi veto <id>` 的指纹永久黑名单(`.state/rsi/veto.json`);只能前台 `rsi veto --lift <id>` 解除(TTY)。未部署候选直接 `rejected`,已部署候选进 `rolling_back`(R21-12.6)。
- R21-11.4 `[V1]` **墓碑**:终态 id 进 `.state/rsi/tombstones.json`,ingest 与 G4 拒复用。
- R21-11.5 `[V1]` **taint 扩展**(修订 R20-4.7,§21.18 第 15 条):证据项目被排除或 purge 命中 → `proposed` / `shadow` / `blocked` 候选直接 `rejected`(`tainted`);已部署候选进 `rolling_back`(`tainted`)。「立即生效」收窄为:下一次 hint 起不再注入、不再作新证据;静态撤销单独报告完成;已进模型上下文的收不回。
- R21-11.6 `[V1]` `rsi purge --write` 额外对私有仓库做历史改写(重建 `rsi` 分支,去掉含命中候选的提交内容),并报告「备份与系统级快照不在 kit 管辖范围」。

### 21.12 命令面、退出码与稳定码

```
agent-kit rsi auto status [--json]                                        [V1]
agent-kit rsi auto pause                                                  [V1]
agent-kit rsi auto resume                                                 [V1]
agent-kit rsi auto clear [--write]                                        [V1]
agent-kit rsi auto rebase-baseline [--adopt-owner]                        [V1]
agent-kit rsi veto <id> | --lift <id>                                     [V1]
agent-kit rsi rollback --to <YYYY-MM-DD> [--write]                        [V1]
agent-kit rsi report [--week | --since <YYYY-MM-DD>] [--json]             [V1]
agent-kit rsi show <id>                                                   [V1]
agent-kit rsi contrib show <id> | export <id> --out <目录> | submit <id>  [V4]
agent-kit rsi capability inventory --agent <a> [--json]                   [V5]
agent-kit rsi capability authorize <cand_id>                              [V5]
agent-kit rsi capability ticket <auth_id> | verify <ticket_id> | disable <adoption_id>   [V5]
agent-kit rsi isolation probe [--explain] [--json]                        [V6b]
agent-kit rsi exec-run <id> --agent <a> --marker <m>                       [V6a]
agent-kit rsi exec-prepare <id>                                           [V6a]
agent-kit rsi exec-confirm <id>                                           [V6a]
```

**命令桩与分期**:某期之前注册的子命令一律是命令桩,退出 64(§7),不输出 `phase_not_available`;`RSI_NOT_RUN reason=phase_not_available`(退出 4)只用于**已注册**命令遇到本期尚不可用的分支(例如 V6a 期间 `rsi exec-run` 要求真实宿主执行,R21-16.2)。`rsi status --json` 沿用 R20-3.4.2 的键集合并追加 R21-13.1 的键(`rsi auto status` 只输出追加部分)。

**输出边界的例外**(修订 R20 通用约定「stdout 只含计数、枚举、id、哈希前缀」,§21.18 第 43 条):只有下列输出可以含正文或相对路径,且除 hint 外都要求 stdout 为 TTY:`rsi show`(候选正文)、hint `--canary` 的 treat 部分(候选正文,R21-6.3)、`rsi contrib show` / `submit` 的确认展示(草稿全文与将执行的命令)、`rsi auto rebase-baseline` 的确认清单(私有仓库内相对路径)、`rsi capability authorize` 的授权展示(包标识、版本、闭包清单、权限三栏)、E1 首次宿主运行确认(脚本全文、manifest、闭包清单)。全部经 R20-3.5.2 同口径的控制字符 / bidi 清洗,带 R21-1.9 标签;绝对路径、HOME、用户名在这些输出里仍被泄漏闸拦(R20-3.5.6 同理,豁免只限上述字段)。

**命令 × 退出码**(多结果用 `combineExitCodes`):

| 命令                          | 0                | 1                                                  | 2                                   | 3                             | 4                                                                                                                                                                                        | TTY / 锁                           |
| ----------------------------- | ---------------- | -------------------------------------------------- | ----------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `rsi auto status`             | 成功(含暂停状态) | —                                                  | `unknown_arg`                       | 状态文件过不了 schema         | `RSI_SNAPSHOT_BUSY`                                                                                                                                                                      | 否 / 不拿                          |
| `rsi auto pause`              | 已写或已存在     | —                                                  | `unknown_arg`                       | `write_denied`                | `off`(找不到仓库)                                                                                                                                                                        | 否 / 不拿                          |
| `rsi auto resume`             | 全部清除         | `RSI_AUTO_RESUME_BLOCKED`                          | `not_tty`                           | `RSI_FAIL_CLOSED`             | `locked`、`off`                                                                                                                                                                          | 是 / 三把锁                        |
| `rsi auto clear`              | 完成 / 干跑      | 部分条目漂移停住                                   | `not_tty`(仅 `--write`)             | `RSI_FAIL_CLOSED`             | `locked`                                                                                                                                                                                 | `--write` 是 / R21-9.5             |
| `rsi auto rebase-baseline`    | 已改写记录       | `RSI_CONFIRM_DECLINED`                             | `not_tty`                           | `RSI_FAIL_CLOSED`             | `not_diverged`、`locked`                                                                                                                                                                 | 是 / 三把锁                        |
| `rsi veto`                    | 已写黑名单       | —                                                  | `not_tty`、`unknown_id`             | `RSI_FAIL_CLOSED`             | `locked`                                                                                                                                                                                 | 是 / 三把锁                        |
| `rsi rollback --to`           | 完成 / 干跑      | 部分条目漂移停住                                   | `bad_date`、`not_tty`               | `RSI_FAIL_CLOSED`             | `locked`                                                                                                                                                                                 | `--write` 是 / 三把锁              |
| `rsi report`                  | 成功             | —                                                  | `bad_date`、`mode_conflict`         | 状态文件过不了 schema         | `RSI_SNAPSHOT_BUSY`                                                                                                                                                                      | 否 / 不拿                          |
| `rsi show`                    | 成功             | —                                                  | `not_tty`、`unknown_id`             | `output_leak`                 | —                                                                                                                                                                                        | 是 / 不拿                          |
| `rsi contrib show` / `export` | 成功             | —                                                  | `not_tty`、`unknown_id`、`bad_path` | `output_leak`、`write_denied` | `locked`                                                                                                                                                                                 | show 是 / export 拿 `contrib/lock` |
| `rsi contrib submit`          | PR 已创建        | `RSI_CONTRIB_DEGRADED`(R21-17.11)                  | `not_tty`、`unknown_id`             | `RSI_FAIL_CLOSED`             | `locked`、`rate_limited`                                                                                                                                                                 | 是 / `contrib/lock`                |
| `rsi capability *`            | 成功             | `RSI_CONFIRM_DECLINED`、`manual_recovery_required` | `not_tty`、`unknown_id`             | `RSI_FAIL_CLOSED`             | `locked`、`ticket_expired`                                                                                                                                                               | authorize / disable 是             |
| `rsi isolation probe`         | `verified`       | `unverified`(有归因码)                             | `unknown_arg`                       | `probe_error`                 | `no_runtime`、`locked`                                                                                                                                                                   | 否 / `exec/lock`                   |
| `rsi exec-run`                | 已运行           | `RSI_EXEC_DECLINED`                                | `unknown_id`、`bad_marker`          | `RSI_FAIL_CLOSED`             | `RSI_EXEC_NOT_RUN`(`auto_disabled`、`paused`、`exec_off`、`probe_stale`、`unverified`、`revoked`、`denied`、`not_enabled`、`agent_off`、`not_treat`、`exec_busy`、`phase_not_available`) | 否 / `exec/lock`(不拿 `rsi/lock`)  |
| `rsi exec-prepare`            | 试跑通过         | 试跑未通过(断言 / 资源 / 超时)                     | `unknown_id`                        | `RSI_FAIL_CLOSED`             | `RSI_EXEC_NOT_RUN`(`exec_busy`、`exec_off`、`unverified`、`probe_stale`、`phase_not_available`、`denied`)                                                                                | 否 / `exec/lock`,提交时三把锁      |
| `rsi exec-confirm`            | 已确认           | `RSI_CONFIRM_DECLINED`                             | `not_tty`、`unknown_id`             | `RSI_FAIL_CLOSED`             | `locked`、`denied`                                                                                                                                                                       | 是 / 三把锁                        |

- R21-12.1 `[V1]` `rsi auto status`、`rsi report`、`rsi show`、`rsi auto clear` 与 `rsi rollback --to` 的干跑、`rsi contrib show`:零写入(进 A5 清单,§21.18 第 39 条)。
- R21-12.2 `[V1]` `rsi auto pause`:独占创建 `.state/rsi/AUTO_PAUSE`(`{at, by: "user"}`),**不拿锁**(须在 worker 持锁时可写);hint 直接读它(R21-6.10);等价熔断码 `user_paused`;不需要 TTY(§21.22 Q-J)。
- R21-12.3 `[V1]` `rsi auto resume`:删 `AUTO_PAUSE`、清除可人工解除且条件已不成立的码(R21-10.4)。
- R21-12.4 `[V1]` `rsi auto clear`:撤掉全部自动产出,不删审计、黑名单、墓碑、冷却。按候选分两类(与 R21-4.1 一致):无部署的 `proposed` / `shadow` / `blocked` 直接 `rejected`(`cleared`);已部署的 `canary` / `adopted` / `stable` 按生效逆序经 R21-9.1 四段到 `rolled_back`(`cleared`);已在 `rolling_back` / `retiring` 的按 R21-4.4a 升级目标为 `rolled_back`。仓库不可达或 `[rsi]` 不可用时按 R21-9.5 的缩减入口执行。
- R21-12.5 `[V1]` `rsi auto rebase-baseline`:R21-3.5 情形②下把当前 HEAD 记为新基线(展示 `记录..HEAD` 的相对路径清单并要求输入 `yes`);`--adopt-owner` 用于情形④,把 `owner_repo_fp` 改为当前 `[rsi] repo`;其它情形退出 4 `not_diverged`。
- R21-12.6 `[V1]` `rsi veto <id>`:写黑名单;`proposed` / `shadow` / `blocked` 候选直接 `rejected`(`vetoed`),已部署候选进 `rolling_back`(`vetoed`);`--lift` 只解除黑名单,候选仍是终态。`unknown_id` 一律是用法错误(退出 2)。
- R21-12.7 `[V1]` `rsi rollback --to <日期>`:按生效逆序逐个回滚该 UTC 日之后进入 `canary` 及更后状态的候选。
- R21-12.8 `[V1]` `rsi show` 输出正文(按上面的输出例外);`report` 只输出 id、枚举、计数与 UTC 日期。
- R21-12.9 `[V1]` **稳定码追加**(`src/contracts/rsi.ts` 的同一份枚举;动态后缀一律是封闭集合):`RSI_USAGE reason=` 追加 `bad_date`、`unknown_id`、`bad_marker`;`RSI_NOT_RUN reason=` 追加 `not_diverged`、`phase_not_available`、`rate_limited`、`ticket_expired`、`no_runtime`;顶层(1)追加 `RSI_AUTO_RESUME_BLOCKED`、`RSI_CONTRIB_DEGRADED`(V4)、`RSI_EXEC_DECLINED`(V6a);顶层(4)追加 `RSI_EXEC_NOT_RUN`(V6a,`reason` 取 R21-16.2b 守卫的封闭码表);`RSI_FAIL_CLOSED reason=` 追加 `personal_repo_invalid`、`candidate_invalid`、`ledger_line_invalid`、`txn_invalid`、`probe_error`。G0 的 `g0_<子码>` 子码集合 = ingest 受控入口的原因码表(A4 落地时登记在同一文件);`harm_<指标>` 只取 `c1|c2|c3|c4|c6`。熔断码(R21-10.2)只进 `--json` 与日志,不作 stderr 顶层码。
- R21-12.10 `[V1]` **审计** `.state/rsi/audit.jsonl`(`RsiAuditLine`,0600):每个转移、每次同步、每次评估查看(含置换种子)、每次 E1 运行、每次投稿结果一行 `canonicalJsonLine` 的 `{at, kind, id, dim?, agent?, from?, to?, reason?, hashes?, counts?, seed?, exec?}`,其中 `exec` = `{started_at, ended_at, exit_code, duration_ms, cpu_ms, max_rss_kib, post_check: pass|undeclared_write|unchecked|error}`;无路径、无文本;保留 365 个 UTC 日、上限 20000 行,超出先按月汇总再删;分组账保留到候选终态后 90 个 UTC 日,之后只留聚合计数(修订 R20-7.1,§21.18 第 17 条)。

### 21.13 可见性:`rsi status` 追加键、周报与 `rsi report`

- R21-13.1 `[V1]` `rsi status --json` 追加键(只含 id、枚举、计数):`auto`(`{enabled, phase, paused, pause_reasons, diverged, profile, profile_effective}`)、`pipeline`(各 `lifecycle` 状态计数 + 近 30 个 UTC 日的 `rejected` / `rolled_back` / `expired` / `retired`)、`budget`(自动配额占用百分比)、`cost`(每会话注入字节均值、S2 次数)、`canary`(`{id, treat, control}` 或 `null`)、`static_watch`(V2;`{id, agent, sessions_after, remaining}` 或 `null`)、`isolation`(V6b;`{status, reason}`)、`extensions`(V5;`{trial, adopted, pending_auth}`)、`contrib`(V4;待处理草稿数)、`exec`(V6a;`not_available|off|host_after_trial`)、`last_rollback`(`{id, at, reason}` 或 `null`)。
- R21-13.2 `[V1]` **周报行**:每个 UTC 周(周一起)第一次输出计数行的 hint,改输出周报行(**替换**计数行,仍 ≤ 200 字节):`agent-kit RSI 周报: 生效 a、回滚 r、灰度中 c、待授权扩展 x、投稿草稿 d、配额 q%。仅在用户要求时使用技能 agent-kit-rsi。`;「本周已报」用独占创建 `.state/rsi/hint/week-<ISO 周序号>`(全局,不分 agent),`EEXIST` → 照常输出计数行。V5 / V4 之前 x / d 恒为 0。
- R21-13.3 `[V1]` `rsi report [--week|--since]`:按 UTC 日期范围列出转移、回滚、到期、注入字节与 S2 次数的计数与 id;`--json` 键集合固定(`range`、`transitions`、`rollbacks`、`expired`、`cost`、`canary`)。

### 21.14 声明式固定测试(Medium 档)`[V3]`

- R21-14.1 `[V3]` 由会话 agent(S2)依据当前项目脱敏摘录(N3)写 1–3 个合成任务:prompt + 合成 fixture + 声明式断言;在候选处于 `shadow` 期间生成与执行;进私有仓库 `cases/auto/<cluster>/`,集合哈希写 `PersonalLifecycleRecord.case_set_sha256` 与之后每条分组账的 `case_set_sha256`;同一聚类所有候选与「现状」用同一套。G8 结果绑定该哈希:集合变化 → 结果作废、候选回到「待测」(仍在 `shadow`)。
- R21-14.2 `[V3]` **断言 schema**(`RsiCaseAssertion`,固定解释器判定,**不接收、不执行任何生成的 shell**):`file_contains`、`file_not_contains`(字面串,≤ 256 字节)、`changed_files_equal`、`changed_files_subset`、`changed_lines_max`(N ≤ 2000)、`file_exists`、`file_absent`;路径为 fixture 相对路径、无 `..`、无绝对路径。其它键 → schema 拒。
- R21-14.3 `[V3]` 筛选(HarnessPro 式两阶段):①淘汰通过率 < 现状;②淘汰被「通过率更高且字节更少」者同时支配的;③同一聚类仍剩多个候选时(G7 放宽之后才会出现),按归一化后的 `α·(1 − 通过率)² + β·(字节 / 配额)²` 取最小者,权重 (α, β):lite 不跑、medium (1, 1)、heavy (2, 1)。G8 只作否决,不作正面证据;G8 红 → `rejected`(`g8_worse` / `g8_dominated`)。
- R21-14.3a `[V3]` **档位矩阵**:lite = 自动配额减半、不跑固定测试、每组最少 20;medium = 全额配额、跑固定测试、每组最少 20;heavy = 全额配额、跑固定测试、每组最少 30。V3 之前 medium / heavy 都不跑测试,但配额与每组最少会话按所选档位,`rsi auto status` 报 `profile_effective`。
- R21-14.4 `[V3]` 执行在 `KIT_TMP` 下;不隔离(agent 有 shell),文档如实写明。
- R21-14.5 `[V3]` 超时(计时起点:候选进入 `shadow` 的那个会话之后):生成在 15 个有观测会话内未完成,或生成完成后执行在 30 个有观测会话内未完成 → `shadow → blocked`;进入 `blocked` 后再 30 个有观测会话 → `expired`;**不降档**(medium 不退回 lite)。
- R21-14.6 `[V3]` 现有人工 `cases/*/check.sh` 不受影响。

### 21.15 能力缺口与第三方扩展 `[V5]`

- R21-15.1 `[V5]` **三件套 schema**(`strictObject`):`CapabilityGap`(`agent`、`capability` ∈ 固定枚举 + `other`、首次 / 最近 UTC 日、次数、识别来源、状态)、`ExtensionCandidate`(`ecosystem` ∈ `pi_package | claude_plugin | mcp_server`、包标识、精确版本、完整制品清单哈希、来源仓库、发布者、`declared_permissions`、`observed_behaviors`、`enforced_permissions`)、`ExtensionAdoption`(候选或「无可用候选 + 替代做法」、授权记录 id、安装 UTC 时间、配置基线哈希、观察结果、停用状态)。存放见 v3.1 §3.6 三件套表;`extensions.json` 在 `.local/state/agent-kit/rsi/`,经 home-fs 新授权写(§21.18 第 32 条)。
- R21-15.2 `[V5]` 识别信号 `agent_self_incapable`、`user_asks_for_extension`、`tool_missing` 只存枚举 + capability 标签;门槛:同一 `(agent, capability)` ≥ 2 个会话或一次 `user_asks_for_extension`;`capability=other` 只记录不搜索。信号只触发调查,「询问插件不等于同意安装」。
- R21-15.3 `[V5]` **授权边界 = 首次执行第三方代码之前**:自动段(识别、本地能力清点、搜索、获取、安全解包、非执行式检查)零第三方代码执行;授权由会话 agent 发起、用户在 TTY 确认;授权后段(离线安装已审阅制品、观察、记录)才执行第三方代码。验收:加载时写哨兵文件的样本包证明授权前哨兵不存在。
- R21-15.4 `[V5]` **非执行式检查 E-G0..E-G7**(E-G5 编号保留不用,§21.22 Q-F):E-G0 安全解包(拒绝绝对路径、`..`、链接、设备文件;文件数与展开字节上限;类型白名单;产出清单哈希);E-G1 发布者在 `allow_publishers` 中(只影响展示);E-G2 闭包固定(全部传递 / 可选 / 平台依赖与原生二进制都有精确版本与内容哈希,记录安装器版本;拿不到完整闭包 → `unsupported_ecosystem`,只能人工);E-G3 权限三栏,声明超出 capability 模板即拒;E-G4 静态检查只作线索(标红展示);E-G6 去重与膨胀(同一 `(agent, capability)` 至多一个 `trial` / `adopted`;每个 agent 经 kit 采用 ≤ 5;`adopted` 后 60 个 UTC 日无目标能力调用 → 停用候选);E-G7 冷却(被拒 / 停用按「包标识 + 版本 + 闭包哈希」拉黑;同一缺口 30 个 UTC 日内不重复搜索,用户再次追问除外)。
- R21-15.4a `[V5]` **受控入口**:本地能力清点 `rsi capability inventory --agent <a>`(kit 读已装扩展清单与配置,零第三方代码执行,只输出 id 与枚举);候选提交经 `reflect --ingest` 的 `kind=extension_candidate`(§21.18 第 3 条);授权请求 `rsi capability authorize <cand_id>`(TTY,展示来源、版本、完整闭包、权限三栏、检查结论;输入 `yes` 才写授权记录);停用 `rsi capability disable <adoption_id>`。`CapabilityGap`、`ExtensionCandidate` 只由 worker 与 ingest 写;`ExtensionAdoption` 只由 `authorize` / `verify` / `disable` 写。
- R21-15.4b `[V5]` **授权记录** `ExtensionAuthorization`(`strictObject`,`.local/state/agent-kit/rsi/authorizations/<auth_id>.json`):`{auth_id, candidate_id, agent, scope, manifest_sha256, closure_sha256, allow_install_scripts, policy_version, granted_at, expires_at}`,`scope` 只取 `user`,`expires_at` = 授权后 14 个 UTC 日;过期未用 → 作废,需重新授权。
- R21-15.5 `[V5]` **安装票** `rsi capability ticket <auth_id>`(票状态 `issued → consumed | expired | voided`,出票与消费都以独占创建落盘,同一授权至多一张有效票;票 24 小时过期):绑定目标 agent、作用域(只用户级)、制品清单哈希、预期配置差异、授权记录、策略版本;单次使用;出票时记配置基线哈希、不长期持锁;安装前重新校验清单;安装器禁止重新解析或下载;安装脚本默认禁用,需执行的在授权时单列。`rsi capability verify <ticket>`:把票从 `issued` 原子地改为 `consumed`,做安装前后基线比对;与预期差异一致 → `ExtensionAdoption.state=trial`;不一致(含基线之后出现的无关配置改动)→ `manual_recovery_required`;对已 `consumed` 的票再次 verify 返回同一结论、不重复写入(幂等)。kit 不写 agent 配置(F8 不变),只读做基线;配置备份 0700 / 0600,`uninstalled` 后 30 个 UTC 日删除。
- R21-15.6 `[V5]` **停用状态机**:`disable_requested → disabled → cleanup_pending → uninstalled | manual_recovery_required`。`uninstalled` 只表示「可归属的配置差异已撤销」,`rsi status` 对每个 `uninstalled` 常驻一句「部署恢复不等于安全事件恢复」;**不存在 `restored` 状态**(v3.1 第三轮 M9;§3.6 安装票段的「`restored` 后 30 天删除」读作 `uninstalled`,§21.22 Q-G)。停用由会话 agent 以「不加载、**不执行其卸载脚本**」的方式移除(可测:带卸载脚本哨兵的样本包,停用后哨兵不存在),kit 核对;agent 起不来 / 停用失败 → 停在 `disable_requested`,下一次任何 kit 命令提示手动处理并给出要删的条目;只撤销可归属的配置差异,遇到无关改动即停,不整文件覆盖。
- R21-15.7 `[V5]` 观察:`adopted` = 20 个有观测会话无硬失败且目标能力被调用 ≥ 3 次;不是安全证明。
- R21-15.7a `[V5]` **记录正文**:`capabilities/<agent>/<capability>.md` 的普通记录(三种写法:「本机已安装且验证」「仅推荐候选」「未安装时的替代做法」)是 `category=capability_note` 的候选,走完整的 G0–G9 与灰度,与扩展是否安装相互独立。
- R21-15.8 `[V5]` 未授权 / 授权请求 14 个 UTC 日无回应 → 写负面记忆(只含 capability、UTC 日期、「未安装,替代做法:…」),不进灰度、不经 G0–G9,有 schema 与上限(每个 agent ≤ 50 条);同一缺口第三次出现时 hint 提示一次。记录正文不能充当安装授权。
- R21-15.9 `[V5]` 扩展由 agent 自己的安装命令装到各 agent 的扩展目录,**不经** kit 写出口,不进 `HOME_WRITE_TABLE`(与 §20.9 第 13 条 pi 扩展经 kit 写入是两回事)。

### 21.16 可执行物 E1 与隔离探针 `[V6a]` / `[V6b]`

- R21-16.1 `[V6a]` **`ExecManifest`**(`strictObject`):用途(≤ 200 字节)、触发方式(工具 / 命令前后,枚举)、输入(只读路径,必须是当前项目目录子集,≤ 16 项)、输出(stdout ≤ 64KiB,或容器内临时目录产出的补丁文件)、解释器绝对路径、资源上限、超时、声明式断言(R21-14.2 同形);不得请求网络、不得挂 HOME、kit 状态目录、私有仓库。闸:G0–G7 + 静态检查(只作线索)。
- R21-16.2 `[V6a]` **总开关、准备与准入守卫**:`[rsi.auto] exec`:`off`(缺省)= 零调用;`host_after_trial` 只能由用户在看过探针报告后手动写入配置;关闭 = 停用全部 E1。**准备入口**(都是前台命令,worker 不做):①`rsi exec-prepare <id>`(不需要 TTY;持 `exec/lock`;在已验证隔离环境里用合成输入跑 manifest 声明的用例并按声明式断言判定,同时检查资源与超时;结果写 `.state/rsi/exec/trial/<id>.json` = `{identity_sha256, probe_version, runtime_fp, passed, assertions, resource, at}`,写时持 `rsi/lock` → `personal/lock` 短暂提交,失败不写 `passed=true`);②`rsi exec-confirm <id>`(需 TTY;R21-16.4 的确认展示;输入 `yes` 后写 `.state/rsi/exec/confirm/<id>.json` = `{identity_sha256, confirmed_at}` 并把脚本与辅助文件复制到 `.state/rsi/exec/copy/<id>-<identity12>/`(0700);写时同样持 `rsi/lock` → `personal/lock`)。`category=exec` 候选的 `shadow → canary` 另需全部为真(worker 持锁判定):a)`isolation.json` 为 `verified`、`probe_version` 等于代码常量 `ISOLATION_PROBE_VERSION`、距今 ≤ 7 个 UTC 日;b)`trial/<id>.json` 的 `passed=true` 且 `identity_sha256`、`probe_version`、`runtime_fp` 都与当前一致;c)`exec = host_after_trial`;d)`confirm/<id>.json` 的 `identity_sha256` 等于当前授权身份;e)该身份没有拒绝标记(R21-16.2c)且不在撤销凭据里。**分期**:V6a 只用注入的假运行时与假宿主执行器测试;`RSI_AUTO_PHASE < V6b` 时真实的 `runIsolated` 与 `runHostScript` 一律拒绝(`RSI_EXEC_NOT_RUN reason=phase_not_available`)。
- R21-16.2a `[V6a]` **`exec-enabled.json`**(`strictObject`,`.state/rsi/exec-enabled.json`):`[{id, identity_sha256, agents, enabled_at, copy_dir}]`,`agents` = `{claude, pi, codex}` 三键,每键 `off | gated | open`(codex 恒 `off`):与部署状态的逐状态对应见 R21-4.3a(`gated` ↔ `injected` / `withdraw_pending`,`open` ↔ `static`,`off` ↔ `none` / `removal_pending`)。**写入权分两类**:①**授予 / 放宽**(新增条目、`off → gated`、`gated → open`)只能由持 `rsi/lock` → `personal/lock` 的 worker 做,写入前在锁内重读拒绝标记目录与撤销凭据,存在 `exec-deny/<id>-<identity12>` 或凭据列出该候选时**不得授予**(旧快照不能把已停用的条目写回);②**收紧 / 删除**(`open → gated`、`* → off`、删条目)由 worker 或持同样两把锁的前台撤销命令(`rsi auto clear --write`、`rsi rollback --to --write`、`rsi veto`)做。前台撤销命令在仓库不可达、`stopped` 或 `off` 下不改本文件,只写拒绝标记与撤销凭据,条目留待对账(R21-9.5,与 R21-9.1 第二段的例外一致);此时运行许可由守卫 1 / 2 / 5 保证。`exec-run` 自己从不写本文件。总开关关闭时视为空。
- R21-16.2b `[V6a]` **`rsi exec-run <id> --agent <claude|pi> --marker <rsm_…>` 的共同硬守卫**(运行许可;全部为真才执行,任一为假即执行器零调用,`RSI_EXEC_NOT_RUN reason=<码>`):
  1. R20-1.3 状态为 `confirmed`、`[rsi.auto] enabled = true`、L-auto 通过、`RSI_AUTO_PHASE ≥ V6b`(`auto_disabled` / `phase_not_available`);
  2. 不存在 `STOP`、`AUTO_PAUSE`,`state.json.auto_pause.reasons` 为空(任一熔断码,含 `isolation_unverified`,都拒;`paused`);
  3. `[rsi.auto] exec = host_after_trial`(`exec_off`);
  4. `isolation.json` 为 `verified`、`probe_version == ISOLATION_PROBE_VERSION`、距今 ≤ 7 个 UTC 日(`probe_stale`,即 R21-16.14 的「到期」),且本次读到的运行时版本与配置指纹与之一致(`unverified`,同时登记 B11);
  5. 撤销凭据不含该候选(`revoked`);不存在当前身份的拒绝标记 `exec-deny/<id>-<identity12>`(`denied`);
  6. `exec-enabled.json` 含该 id 且其 `identity_sha256` 等于当前授权身份(`not_enabled`;身份不同 → `RSI_EXEC_DECLINED reason=identity_changed` 并按 R21-16.2c 发停用事件);
  7. `agents[<agent>]` 为 `gated` 或 `open`(`agent_off`);为 `gated` 时,分组账中 `marker` 那一行的 `agent` 等于 `--agent`、`candidate_id` 等于该候选、`arm=treat`,且该行晚于该候选在该 agent 上最近一次 `exec_enabled` 转移(`not_treat`)。`--agent` 是调用方自报,kit 只用它在正常路径上选取许可、核对与账行一致,**不是安全身份**(同 UID,R21-1.8);
  8. 拿到 `exec/lock`(`exec_busy`,不排队)。

  拿到锁后**按 1–7 再查一遍**(消除检查与执行之间的窗口),再做单次输入快照 → 运行(R21-16.5)→ 事后检测(R21-16.6)→ 审计。守卫只约束**新的调用**;正在运行的宿主进程不受守卫影响,只按 R21-16.5 的超时尽力终止。`exec-run` 由宿主 agent 按注入正文的指示调用;worker 从不调用它。**验收**:持有一条真实 treat 标记,分别在其后制造 `AUTO_PAUSE`、`STOP`、熔断码、`exec=off`、`[rsi.auto] enabled=false`、探针失败(版本与指纹不变)、探针版本常量变化、探针超过 7 天、撤销凭据、当前身份的拒绝标记,每种情形下 `runHostScript` 的调用次数都为 0;另有 `claude=open` / `pi=gated` 并存时 pi 的 control 标记被拒、claude 任意会话放行,以及只撤回 pi(`open → gated`)不影响 claude 的用例——撤回分别在正常与 `AUTO_PAUSE` 下做,中间态与完成态的许可都等于 R21-4.3a 的映射。

- R21-16.2c `[V6a]` **停用协议(唯一方案:拒绝标记 + 事件,由 worker 收口)**:任何发现 E1 必须停用的一方(`exec-run` 检出身份变化、事后检测失败、超时清理不确定;前台 `rsi veto` / `rsi auto clear` / `rsi rollback --to` 针对 E1;worker 自己的伤害判定)先做两件**不拿 `rsi/lock`** 的事:①`createExclusive` 拒绝标记 `.state/rsi/exec-deny/<id>-<identity12>`(内容 `{at, reason}`;已存在即视为成功);②向 `.state/rsi/exec-events.jsonl` 单行追加 `{at, id, identity12, kind: identity_changed|post_check_failed|timeout_unclean|user_disable|harm}`。拒绝标记一落盘,下一次 `exec-run` 即被守卫 5 拦住(不等 worker)。前台撤销命令随后按各自流程写撤销凭据并(仓库可达时)持锁收紧启用表(R21-16.2a ②)。worker 持 `rsi/lock` → `personal/lock` 处理事件:推进生命周期(`rolling_back`;`identity_changed` 时 `target_terminal=shadow`,其余 `rolled_back`)、删除或收紧 `exec-enabled.json` 条目;除 `identity_changed` 外写撤销凭据。**`identity_changed` 是撤销凭据的唯一例外**:它只停用旧身份(旧身份的拒绝标记永久有效,不写候选级撤销凭据,R21-9.1 第二段的例外),同一候选以新身份经 `exec-prepare` / `exec-confirm` 后可重新进入 canary;旧身份永远不能被重新写入启用表(R21-16.2a ①)。拒绝标记只在候选进入终态 90 个 UTC 日后由 worker 删除。**并发验收**(注入交错):a)worker 读快照 → 拒绝标记落盘 → worker 写启用表:授予被锁内重读拦住;即便启用表里留下旧条目,`exec-run` 仍被守卫 5 拦住;b)两个 `exec-run` 同时检出身份变化:只产生一个拒绝标记、两条事件,worker 处理结果幂等;c)worker 处理事件时崩溃:重启后按 journal 续做,启用表最终不含该身份的条目,拒绝标记仍在;d)**端到端**:旧身份被拒绝 → 候选回 `shadow` → 新身份 prepare / confirm → 重新进 canary 并可在 treat 会话执行;旧身份在全过程中执行器零调用。
- R21-16.3 `[V6a]` **授权身份** = sha256(脚本内容、manifest、执行闭包(解释器路径与二进制哈希、本地辅助文件)、策略版本);与确认时不一致 → 不运行、`RSI_EXEC_DECLINED reason=identity_changed`,候选经 `rolling_back`(`target_terminal=shadow`)回到 `shadow` 等待重新确认(R21-4.1)。**单次输入快照**每次记哈希进审计,不要求等于试用输入。哈希不覆盖动态加载的系统库,文档如实写明。
- R21-16.4 `[V6a]` **首次宿主运行确认**(入口 = `rsi exec-confirm <id>`,R21-16.2):必须在第一次 canary 运行之前、以及授权身份任一变化后的首次运行之前完成;需 TTY,展示脚本全文、manifest、闭包清单、强制层表中「部分强制」「不强制」各项与「遗留后台执行」风险;确认绑定授权身份;确认后脚本与辅助文件复制到执行器专用目录(0700),之后只执行这份副本。未确认或确认绑定的身份与当前不同 → 候选不进 canary(R21-16.2 d),`exec-run` 被守卫 6 拦住。
- R21-16.5 `[V6a]` **宿主执行器 `runHostScript` 的强制层**(写进契约,不得在文档或输出里升格):

| 约束           | 做法                                                               | 等级                                                                                                                          |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 超时终止       | 新进程组;超时 SIGTERM → 宽限 → SIGKILL;结束后检查进程组为空        | **部分强制**:脱离会话 / 进程组的进程与委托给其它宿主服务的工作不保证终止;超时或清理不确定 → 停用 + `manual_recovery_required` |
| 环境变量白名单 | 显式给出环境(manifest 声明 ∩ 契约白名单;`HOME` 指向执行器临时目录) | **强制**(脚本自己读配置文件取凭据不受此限)                                                                                    |
| 资源上限       | 固定外壳先 `ulimit` 再 `exec`;外壳字符串为常量,不拼接外部文本      | **部分强制**(逐平台登记在 `isolation.json`)                                                                                   |
| 输入只读       | 复制到执行器临时目录,只传副本路径                                  | **不强制**,只靠事后检测                                                                                                       |
| 输出限定目录   | 工作目录为执行器新建目录,声明输出只从这里取                        | **不强制**,只靠事后检测                                                                                                       |
| 无网络工具     | `PATH` 只含 kit 维护的精简目录                                     | **不强制**                                                                                                                    |
| 额外沙箱       | `sandbox-exec` 可用时尽力套一层                                    | **不计入保证**                                                                                                                |

- R21-16.6 `[V6a]` **事后检测**:运行前后对项目目录(有大小上限)与 HOME 受管路径做树哈希(含类型、模式、链接目标;超限目录记 `unchecked` 而不是通过;kit 自己的审计 / journal 写入不计);出现声明之外的改动 → 停用、`undeclared_write`、`manual_recovery_required`;检测失败按未通过。只覆盖「受检范围内、结束时仍存在」的改动。
- R21-16.7 `[V6a]` **审计**:每次宿主运行一行(候选 id、三个哈希、起止时间、退出码、耗时、资源用量、事后检测结论),不写参数与输出内容。
- R21-16.8 `[V6a]` **并发**:`exec-run`、`exec-prepare`、`rsi isolation probe` 共用全局并发 1 的 `.state/rsi/exec/lock`(独立,试锁,不嵌套在 `rsi/lock` 之内:需要写 `trial` / `confirm` / 探针结果时,先释放 `exec/lock` 再按 R21-3.3 锁序拿锁提交;`exec-run` 自身从不拿 `rsi/lock`);占用 → `RSI_EXEC_NOT_RUN reason=exec_busy`(不排队)。
- R21-16.9 `[V6a]` **输入 TOCTOU 与补丁回传**:容器启动前对声明输入算内容哈希,容器内前置步骤校验,不一致不运行;产出补丁交给 agent 前须过 G1、G2 与补丁安全检查(§18 C9 同口径),不过即丢弃。
- R21-16.10 `[V6a]` **停用状态机**:`disable_requested → disabled → cleanup_pending → uninstalled | manual_recovery_required`;`disable_requested` = 拒绝标记与事件已落盘(R21-16.2c,立即阻止新调用);`disabled` = worker 已从 `exec-enabled.json` 删除;宿主改动只按事后检测记录尽力恢复可归属部分。
- R21-16.11 `[V6a]` **`runIsolated` 出口**(新,`src/io/exec.ts` 的独立导出,lint 闸约束;§21.18 第 11 条):形状与 `runSelf` 同构(受校验参数、固定 env、stdout 上限、超时可杀),不继承 `RUN_SELF_ENV_KEYS`,环境只传容器运行时所需的具名键;只能调用本机运行时客户端,拒绝远端 context;只由 `src/rsi/exec/isolated/**` 引用。**`runHostScript`** 同为独立导出,只由 `src/rsi/exec/host/**` 引用;`exec/host/**` 只能被 `rsi exec-run` 的命令模块引用,`exec/isolated/**` 只能被 `rsi isolation probe` 与 `rsi exec-prepare` 的命令模块引用(自动入口闭包禁止,R21-1.4)。`EXEC_ALLOWLIST` 仍为 `['git']`。
- R21-16.12 `[V6b]` **隔离探针 I1–I8**(判据与正向对照见 v3.1 §3.4 探针表,逐项写入 `isolation.json`):每项四态 `pass | fail | unknown | error`;只有必需项(I1–I7 全部 + I8 中无网络、只读根、丢弃 capability、禁止提权、只连本机实例)全部 `pass` 才判 `verified`;`unknown` 与 `error` fail-closed;归因三类 `platform_unsupported | config_unsafe | probe_error`。每条连通性路径有解除隔离后的正向对照,对照不成立记 `unknown`。
- R21-16.13 `[V6b]` **`isolation.json`**(`strictObject`):`host_os`、`runtime_kind`(`native | vm`)、运行时名称与版本、配置指纹(VM 参数与守护进程配置文件内容哈希)、镜像摘要、探针版本、每项 `{ok, observed, expected, reason_code}`、UTC 时间。镜像摘要常量 `ISOLATION_IMAGE_DIGEST`,每次使用前核对;镜像拉取需用户同意(§10.3 动作 7)。
- R21-16.14 `[V6b]` **探针调度与执行前复核**:**worker 只登记、不执行**:`isolation.json` 距今超过 7 个 UTC 日或 `probe_version` 不等于当前常量时,worker 在 `state.json.isolation` 记 `due=true` 与原因(`age` / `probe_version`),`rsi status` 与周报行报告;此时守卫 4 已使 E1 停止(到期即视为未验证),不需要 worker 做任何执行。完整探针只由前台 `rsi isolation probe` 执行(用户手动,或用户自己安排的定时任务调用该前台命令;kit 不安装定时任务)。运行时版本 / 配置指纹的变化只能在调用运行时客户端时发现,因此由 `exec-run` 与 `exec-prepare` 的执行前复核发现(守卫 4),发现即不执行并登记熔断码 `isolation_unverified`。前台探针与执行前复核共用同一份验证策略。
- R21-16.15 `[V6b]` **探针自身验收**:合成对照组(可控假运行时)8 个变异——开网络、去只读、挂入运行时 socket、去丢弃 capability、去进程数上限、去内存上限、传完整宿主环境、可写挂载指到哨兵兄弟目录——每个预先登记「必须失败的核心项 / 允许联动失败的项 / 不得失败的无关项」三组,断言核心项失败、无关项不变、最终 `unverified`(**不要求恰好一项**);另有反向变异(任一项的失败改成跳过 → 必须红)。真机对照组:至少一台 Linux 与一台 macOS 宿主各跑一次;macOS 允许 `unverified`,但必须有归因码。无运行时 → `no_runtime`,E1 不启用。

### 21.17 框架改进投稿 `[V4]`

- R21-17.1 `[V4]` **判定**(机械,按目标):框架层 = 候选目标路径属于框架方法技能 / 预置技能,或指向闸常量表某项并附合成样例,或指向契约常量,或证据来自 kit 自己的稳定码(`RSI_FAIL_CLOSED reason=internal`、`gate_internal`、reader 解析异常计数);其余一律个人层。被 G4 以 `g4_framework_path` 拒绝的个人层候选只生成「抽象描述 + 合成样例」形态的草稿,不保留候选正文。veto 指纹命中 → 该目标草稿生成暂停 30 个 UTC 日,之后标注「你否决过相关个人层候选」。
- R21-17.2 `[V4]` **草稿内容**:只允许抽象描述(≤ 1KiB,固定模板)、对框架文件的补丁、合成样例;不得含会话摘录(含脱敏后)、项目名与路径、用户名与主机名、精确计数与日期(只允许四档 `≥1 / ≥2 / ≥10 / ≥50`)、信号 id、私有仓库内容。
- R21-17.3 `[V4]` **草稿存放** `.state/rsi/contrib/<id>/{patch, pr-body.md, check.json}`(0600;`check.json` 含 `target_paths`);30 个 UTC 日未处理自动删除。模块边界:草稿生成在 `src/rsi/contrib/draft/**`(worker 可用,零子进程);前台发布在 `src/rsi/contrib/publish/**`(只由 `rsi contrib submit` 引用;自动入口闭包不得含它)。
- R21-17.4 `[V4]` **导出写原语** `exportContrib(ctx, id, outDir)`(新,独立 lint 授权,§21.18 第 33 条):`outDir` 由用户显式给出;`realpath` 后仍在 HOME 内;链上无符号链接;目录尚不存在才创建(0700),文件 0600。`export` 不进零写入清单,`show` 进。
- R21-17.5 `[V4]` **泄漏闸 L1–L7**(生成时与提交前各跑一次;扫描对象是 R21-17.9 第 3 步的完整公开制品;**启发式**,通过不等于可安全公开):L1 脱敏 pass2 全文;L2 项目特征(项目索引目录名、`exclude_names`、HOME 路径、当前用户名与主机名);L3 与信号库 `excerpt_redacted` 的重合(只豁免令牌绑定的 `base` 提交中补丁原位置上的未修改上下文行与删除行;其余任一连续 16 字 / 8 英文词重合即拒;「agent 名 + 工具名 + 失败类别」同段同现即拒);L4 邮箱、IPv4、非白名单 URL 字面量、疑似凭据赋值(与 A10 同一套规则);L5 补丁文件集合**完全等于** `target_paths`,每个路径由 kit 机械判定属于 R21-17.1 四类之一,契约文件只许追加形状,不改 `.github/`、`package.json`、锁文件、`CODEOWNERS`;L6 补丁 ≤ 16KiB、描述 ≤ 1KiB;L7 PR 标题 / 正文 / 提交说明只许版本号与四档分档,不得有其他裸整数与日期,补丁新增行出现日期字面量即拒;合成样例不受 L7 限制(仍受 L1–L6)。L1、L2、L4 不因任何豁免跳过。
- R21-17.6 `[V4]` **fork 身份**:`fork_owner` 只许 `[A-Za-z0-9-]`、1–39 字符、不以连字符开头或结尾;仓库名固定 `agent-kit`;kit 由两者构造唯一的 SSH 形式规范地址(不接受 URL、remote 名、端口、协议、路径);等于上游 owner 即拒。kit 不验证 fork 关系,保证写作「推送到用户显式配置的、非上游的同名仓库」。
- R21-17.7 `[V4]` **TTY、频率与预留**:submit 需 stdin / stdout 为 TTY,持 `.state/rsi/contrib/lock`(独立,试锁)。频率按「推送已发出」计(含 `push_unknown`,不只算成功):全局每 UTC 周至多 1 次、同一框架目标累计至多 3 次,超出 → 退出 4 `rate_limited`。推送命令发出**之前**先在 `.state/rsi/contrib/submissions.jsonl` 追加一行预留(`{id, at, target_fp, phase}`,`phase=reserved`),结束后追加结果行(`phase ∈ no_remote_change|push_unknown|pr_unconfirmed|pr_created`);崩溃后只有预留行的记录按 `push_unknown` 计。
- R21-17.8 `[V4]` **封闭的 git 执行配置**:所有 git 子进程在 `KIT_TMP` 下新建的临时仓库运行;环境只设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL`=kit 生成的空文件、`GIT_TERMINAL_PROMPT=0`(先清除继承的全部 `GIT_*` / `GIT_CONFIG_*`),`HOME` 保持用户 HOME;每条命令前置 `-c core.hooksPath=<空目录> -c init.templateDir= -c protocol.allow=never -c protocol.ssh.allow=always -c core.fsmonitor=false -c transfer.fsckObjects=true`;不设任何 `url.*.insteadOf`;作者身份只读取用户全局配置的 `user.name`、`user.email`、`user.signingkey`、`gpg.format` 四值(校验字符集后以 `-c` 传入);明确授权的间接执行只有 SSH 客户端与签名程序(`gpg.format` 只接受 `ssh` / `openpgp`,程序路径确认时解析并记录);凭据助手、过滤器、远程传输助手一律不配置。
- R21-17.9 `[V4]` **先构建、再确认、确认什么推什么**:①临时仓库 fetch 上游 main(地址为常量)记 `base`;建 `refs/heads/rsi-contrib/<id>`(`<id>` 只含 `[a-z0-9-]`);`apply --check` 后应用补丁;固定模板提交说明,得 `head`。②校验 `base..head`:恰一个提交;文件集合等于 `target_paths`;只许普通文本文件、模式 100644;拒绝符号链接、gitlink、二进制补丁、可执行位变化、重命名到集合外;出现未列出的提交头部字段即拒。③公开元数据全部枚举 8 项(差异、提交说明、分支名、PR 标题、PR 正文固定副本、作者 / 提交者身份、作者 / 提交者时间=`base` 的提交者时间、签名块),前五项全量跑 L1–L7;作者 / 提交者的 `user.name` / `user.email` 这一对精确值是 L2 / L4 的唯一受限豁免,写进确认令牌,其它位置出现同值仍拒;签名块受限豁免并展示。④TTY 完整展示全部内容与将执行的命令(上游的两次只读 fetch、push、`gh pr create`);确认令牌绑定 `base`、`head`、正文副本哈希、上游、fork、分支名;单次使用、10 分钟过期;执行前逐项复核,并**再 fetch 一次上游 main**:与 `base` 不同 → 令牌作废(`upstream_moved`,无远端变化)。⑤`git push <规范地址> <head>:refs/heads/rsi-contrib/<id>`(无 `--force`,不推其它引用)。⑥开草稿 PR。
- R21-17.10 `[V4]` **`runGhPrCreate` 出口**(新,`src/io/exec.ts` 独立导出,只由 `src/rsi/contrib/publish/**` 引用;§21.18 第 11、36 条):以确认时解析并记录的绝对路径、argv 数组、不经 shell 执行唯一形状 `pr create --repo <上游常量> --base main --head <fork_owner>:rsi-contrib/<id> --draft --title <固定模板> --body-file <正文副本路径>`;环境只传 `PATH`(精简目录 + `gh` 所在目录)、`HOME`、`GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、代理变量,清除继承的 `GH_*` / `GIT_*`;超时 60 秒;不核验二进制内容(只核 `realpath`);内置子命令不可被别名 / 扩展覆盖是 V4 实测项。
- R21-17.11 `[V4]` **结果四态**(`RSI_CONTRIB_DEGRADED reason=` 码表):①推送未发出前任一步失败(`gh_missing`、`git_missing`、`config_invalid`、`leak_gate`、`token_invalid`、`upstream_moved`、`fetch_failed`、`base_head_invalid`)→ 无远端变化;②推送已发出但失败 / 超时 / 中断 → `push_unknown` + fork 分支名,提示用户去 fork 查看,不重试、不声称无副作用;③推送成功,`gh` 失败、超时,或退出 0 但 stdout 解析不出 PR 编号 → `pr_unconfirmed` + 分支名,不重试、不清理远端分支。①②③都退出 1,草稿都经 R21-17.4 导出到 `export_dir`(未配置则留在 `.state/rsi/contrib/<id>/`);导出本身失败时草稿留在原处,另报 `RSI_FAIL_CLOSED reason=write_denied`(退出码按 `combineExitCodes` 取 3);④`gh` 退出 0 且 stdout 解析出 PR 编号 → 输出 PR 编号、写审计,退出 0。
- R21-17.12 `[V4]` **kit 不做**:合并、关闭、评审、编辑 PR;读写 secrets、规则集、发布、工作流;建删仓库与 fork;删远端分支;修改用户的 `gh` 或 git 配置。

### 21.18 既有条款修订清单(v3.1 修订)

「影响已实现代码」指 R20-A0 已合并的部分(`UserConfig` 接受 `[rsi]`、self-spawn 桥接、`createExclusive`、reader JSON 深度上限、`canonicalJsonLine`)与 P0 / P1 已实装代码。最后一栏的写法:「是:…」= 要改**现有**代码或测试;「否(新…)」= 只新增模块 / 文件 / schema,不改现有代码;「否(规划)」= 被修订的条款尚未实现,只改规划。修订处在原条款位置加了「v3.1 修订」标注,条款编号不变。

| #   | 条款                                  | 修订前                                                                              | 修订后                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 生效期   | 影响已实现代码                                                                                                                 |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | §4.2 personal 层                      | P0 / v1 不渲染,`skippedLayers` 写「P2 才在本机渲染」                                | **包 payload** 照旧不含 personal;**本机 payload**(R21-8.1)渲染 `origin=auto_rsi` 的 personal 原子;A15 只针对包 payload                                                                                                                                                                                                                                                                                                                                          | V2       | 是:渲染器、`PERSONAL_SKIP`、A15(V2 改);V1 不改                                                                                 |
| 2   | §7 命令表                             | 无 `rsi auto` 等                                                                    | 追加 §21.12 命令(按期注册,未到期为桩)                                                                                                                                                                                                                                                                                                                                                                                                                           | V1 起    | 是(新命令;A0 不受影响)                                                                                                         |
| 3   | §17.1 / v2 §7.2 ingest                | ingest 只写暂存区,不 apply                                                          | ingest 后候选进闸队列(`proposed`);新增 `kind=extension_candidate`(V5)、`kind=exec_manifest`(V6a)、`kind=contrib`(V4)                                                                                                                                                                                                                                                                                                                                            | V1       | 否(A4 未实现,改规划)                                                                                                           |
| 4   | §18 开头                              | 生命周期契约对全部原子                                                              | 只服务框架仓库自己的原子(人工);个人层用 `PersonalLifecycleRecord`(R21-3.7 / R21-3.9),两套不混用;§18.5 理由码不变                                                                                                                                                                                                                                                                                                                                                | V0       | 否(文档)                                                                                                                       |
| 5   | (新)个人层生命周期记录                | —                                                                                   | `PersonalLifecycleRecord` schema,理由码 `auto_rollback`、`auto_expired`、`vetoed`、`no_hit`、`rejected`、`tainted`                                                                                                                                                                                                                                                                                                                                              | V1       | 否(新 schema)                                                                                                                  |
| 6   | §19.1 ① / ⑨                           | sync 只从包内 payload 装;personal v1 不渲染                                         | sync 来源 `package \| local`;本机 payload 只由 kit 本机渲染;⑨ 对包 payload 不变                                                                                                                                                                                                                                                                                                                                                                                 | V2       | 是:`sync`、`loadPayload`(V2)                                                                                                   |
| 7   | §19.6                                 | 只在 npm 更新安装成功后评估包 payload                                               | 仍只有 `off \| safe`、条件不放宽只追加;新增评估时机与条件、原因码 `local_non_auto_diff`、`candidate_not_stable`、`auto_paused`(追加进 `AUTO_SYNC_DECLINE_REASONS`);锚点信任来源差异写明(R21-8.2)                                                                                                                                                                                                                                                                | V2       | 是:`autosync.ts`(V2)                                                                                                           |
| 8   | §19.6 末段                            | 可执行类永不自动应用                                                                | 保留(sync 仍永不自动应用可执行类);E1 走独立通道,不经 sync(§21.16)                                                                                                                                                                                                                                                                                                                                                                                               | V0       | 否                                                                                                                             |
| 9   | (新)撤销路径                          | —                                                                                   | `syncRevoke`:只减少影响,不受 `auto_paused` / 候选状态 / 操作数上限阻挡,仍遵守漂移规则(R21-9.3)                                                                                                                                                                                                                                                                                                                                                                  | V1       | 是:sync 新模式(V1 只需私有仓库段;HOME 段 V2)                                                                                   |
| 10  | §19.7 home-fs / 写出口                | 12 条表;无私有仓库原语                                                              | 新增 `commitPersonal`(R21-3.6,经 `runSync('git')` 写私有仓库,不经 home-fs 直接写 `.git`)与私有仓库结构校验(R21-3.4);HOME 侧个人层状态 `.local/state/agent-kit/rsi-personal/`(R21-3.2)经 home-fs 新增 lint 授权(只许 `src/rsi/personal/**`);`HOME_WRITE_TABLE` 本节不新增条目(两处都在现有 kit 条目内)                                                                                                                                                           | V1       | 是:eslint 授权块追加;`HOME_WRITE_TABLE` 与其测试不变                                                                           |
| 11  | §19.7 exec 白名单                     | `EXEC_ALLOWLIST=['git']`;独立出口只有 `runSelf`                                     | `EXEC_ALLOWLIST` 不变;新增独立出口 `runGhPrCreate`(V4)、`runHostScript`(V6a)、`runIsolated`(V6a),各自 lint 授权只许指定目录引用(R21-16.11、R21-17.10)                                                                                                                                                                                                                                                                                                           | V4 / V6a | 是:`src/io/exec.ts` 追加导出、eslint 授权块;`runSelf` 与 A0 的 self-spawn 桥接不变                                             |
| 12  | R20-1.1                               | 自动路径唯一子进程 = `runSelf` 桥接                                                 | 分三层(R21-1.4):自动入口另允许私有仓库 git(零网络),闭包另禁 `publish/**`、`exec/host/**`、`exec/isolated/**`(`draft/**` 允许);前台明确例外 `rsi contrib submit`(kit 发起联网)与 `rsi exec-run` / `rsi isolation probe`(宿主脚本 / 容器,网络不受 kit 约束);会话 agent 的联网与第三方代码执行不属 kit 进程                                                                                                                                                        | V1       | 是:`test/rsi/import-closure.test.ts` 追加断言(V1);A0 已有的闭包断言不变                                                        |
| 13  | R20-1.8                               | 自动路径永不 apply、promote、attest、retire、judge、sync 写全局、开 PR …            | 分表(R21-1.3):个人层允许 apply(私有仓库)、生效、回滚、退役;`promote` / `attest` / `judge` 仍永不自动(§18 路径);开 PR / 推送 / 对外通知 / 发版 / 建 tag / 改配置 / purge / confirm 仍永不                                                                                                                                                                                                                                                                        | V1       | 是:R20-1.8 的测试(A3 起才有)按新表写                                                                                           |
| 14  | R20-3.3 hint                          | 只输出计数、≤ 200 字节、唯一写入是去重标记                                          | canary 模式(R21-6.10 / R21-6.11):可附 ≤ 1536 字节通用规则正文;写入扩为去重标记、分组账一行(三种 arm 都写)、周报标记;对照组也输出中性关联标记(R21-6.3);内容信任属性三句:注入文本自带固定「自动产出、未经核验」标记;该标记对 G1 / G2 豁免;reader 识别并排除出评估指标                                                                                                                                                                                             | V1       | 否(hint 未实现,A3 / A5 规划;A0 不涉及)                                                                                         |
| 15  | R20-4.6 / R20-4.7(N6)                 | 排除立即对历史生效;taint 只管暂存 run 与 promote 产物                               | taint 扩到已生效的自动产出(进回滚);「立即生效」对自动产出收窄为「下一次 hint 起不再注入、不再作新证据」(R21-11.5)                                                                                                                                                                                                                                                                                                                                               | V1       | 否(A2 未实现)                                                                                                                  |
| 16  | R20-6.5                               | 熔断只有 retryable / safety                                                         | 并列新增 `auto_paused` 与码表(R21-10.2);两者不互相替代                                                                                                                                                                                                                                                                                                                                                                                                          | V1       | 否                                                                                                                             |
| 17  | R20-7.1                               | 只有 `log.jsonl`                                                                    | 追加 `audit.jsonl`、分组账及保留策略(R21-12.10、R21-6.4)                                                                                                                                                                                                                                                                                                                                                                                                        | V1       | 否(新文件)                                                                                                                     |
| 18  | §20.10 S2                             | 会话授权缺省 S1(N2 待定)                                                            | 开启自动循环时 claude / pi 缺省 S2(R21-2.3)                                                                                                                                                                                                                                                                                                                                                                                                                     | V1       | 否(规划)                                                                                                                       |
| 19  | §20.2 配置(R20-2.6 L-base)            | `RsiBaseSchema` strict,子表只允许 `session`                                         | L-base 对 `auto`、`capability`、`contrib` 与 `session` 一样只校验为「表或缺省」;追加 L-auto / L-cap / L-contrib 层(R21-2.1);子表内未知键拒;统计常量为代码常量                                                                                                                                                                                                                                                                                                   | V1       | 否(规划):`src/rsi/config.ts` 未实现(A2);A0 的 `UserConfig.rsi: z.unknown().optional()` 已让任意 `[rsi.*]` 不连累 update,无需改 |
| 20  | 信号 schema / reader 口径             | 无 `tool_error_class` 等                                                            | 追加可选字段 `tool_error_class`、`retry_chain_len`(V1)、`phase_sequence`(V3)、缺口三类(V5),只存枚举 / 整数,只增不改;**`sig_id` 算法不变**(新字段不进 `sig_id`);reader 新增注入文本识别(R21-6.9);`reader-counting-spec.md` 同步                                                                                                                                                                                                                                  | V1 起    | 是:reader、oracle;A0 的 JSON 深度上限(`RSI_MAX_JSON_DEPTH`)不变                                                                |
| 21  | `check-publish`                       | 无 personal 断言                                                                    | 包 payload 不得含 `layer=personal` / `origin=auto_rsi`;方法技能核对来源路径与文件集合(R21-8.10)                                                                                                                                                                                                                                                                                                                                                                 | V2       | 是:`scripts/check-publish.mjs`                                                                                                 |
| 22  | G4 目标路径(新)                       | —                                                                                   | R21-1.2、G4 `g4_framework_path`;近重复比对集合含预置技能                                                                                                                                                                                                                                                                                                                                                                                                        | V1       | 否(新代码)                                                                                                                     |
| 23  | 固定测试(新)                          | —                                                                                   | §21.14;现有 `cases/*/check.sh` 不受影响                                                                                                                                                                                                                                                                                                                                                                                                                         | V3       | 否                                                                                                                             |
| 24  | 隔离探针(新)                          | —                                                                                   | R21-16.12–16.15、B11                                                                                                                                                                                                                                                                                                                                                                                                                                            | V6b      | 否                                                                                                                             |
| 25  | E1(新)                                | —                                                                                   | R21-16.1–16.10                                                                                                                                                                                                                                                                                                                                                                                                                                                  | V6a      | 否                                                                                                                             |
| 26  | 静态阶段监视(新)                      | —                                                                                   | §21.8                                                                                                                                                                                                                                                                                                                                                                                                                                                           | V2       | 否                                                                                                                             |
| 27  | 框架投稿(新)                          | —                                                                                   | §21.17                                                                                                                                                                                                                                                                                                                                                                                                                                                          | V4       | 否                                                                                                                             |
| 28  | 制品获取与解包(新)                    | —                                                                                   | R21-15.4 E-G0、E-G2                                                                                                                                                                                                                                                                                                                                                                                                                                             | V5       | 否                                                                                                                             |
| 29  | agent 配置读取与备份                  | F8:sync 永不碰 agent 配置                                                           | F8 不变;kit 只读 agent 配置做基线与核对;备份 0700 / 0600、30 天保留(R21-15.5)                                                                                                                                                                                                                                                                                                                                                                                   | V5       | 否                                                                                                                             |
| 30  | 第三方代码执行授权(新)                | —                                                                                   | R21-15.3、R21-15.5、R21-15.6                                                                                                                                                                                                                                                                                                                                                                                                                                    | V5       | 否                                                                                                                             |
| 31  | payload 来源标记                      | `PayloadFile` / `SyncLedger` / `Manifest` 条目无 `source`;`PayloadAtom` 无 `origin` | 追加**可选**字段 `source: package \| local`(缺省按 `package`);`PayloadAtom` 追加可选 `origin`(`strictObject` 下必须显式追加);旧文件照常通过                                                                                                                                                                                                                                                                                                                     | V2       | 是:`src/contracts/{payload,sync}.ts` 追加字段;既有示例与夹具不变                                                               |
| 32  | 扩展落点与写入表                      | —                                                                                   | 第三方扩展不经 kit 写出口、不进 `HOME_WRITE_TABLE`(R21-15.9);`extensions.json` 写在 kit 条目 `.local/state/agent-kit/rsi/`,经 home-fs 新增 lint 授权(只许 `src/rsi/capability/**`)                                                                                                                                                                                                                                                                              | V5       | 是:eslint 授权块(V5)                                                                                                           |
| 33  | 导出写原语(新)                        | —                                                                                   | `exportContrib`(R21-17.4),独立 lint 授权                                                                                                                                                                                                                                                                                                                                                                                                                        | V4       | 否                                                                                                                             |
| 34  | 分组账字段                            | —                                                                                   | `background_fp`、随机会话标记、`overlaps_preset`(R21-6.4)                                                                                                                                                                                                                                                                                                                                                                                                       | V1       | 否                                                                                                                             |
| 35  | E1 运行时校验                         | —                                                                                   | R21-16.14、`ISOLATION_IMAGE_DIGEST`、`exec/lock`                                                                                                                                                                                                                                                                                                                                                                                                                | V6b      | 否                                                                                                                             |
| 36  | 投稿发布出口(新,P1)                   | —                                                                                   | R21-17.6–17.11                                                                                                                                                                                                                                                                                                                                                                                                                                                  | V4       | 否                                                                                                                             |
| 37  | 宿主执行器(新,P2)                     | —                                                                                   | R21-16.3–16.7                                                                                                                                                                                                                                                                                                                                                                                                                                                   | V6a      | 否                                                                                                                             |
| 38  | §12.4 `runIsolated` / 真跑            | 真跑不在 A5 零写入覆盖内(只说 LLM CLI)                                              | 同理追加:`rsi isolation probe`、`rsi exec-run`、`rsi contrib submit` 不在 A5 零写入覆盖内(会起容器 / 宿主脚本 / 推送);`runIsolated` 的 lint 约束见第 11 条                                                                                                                                                                                                                                                                                                      | V4 起    | 否(文档)                                                                                                                       |
| 39  | §20.8.1 A5 清单                       | §20 的干跑命令                                                                      | 追加 `rsi auto status`、`rsi auto clear`(无 `--write`)、`rsi rollback --to`(无 `--write`)、`rsi report`、`rsi show`、`rsi contrib show`;canary 模式的 hint、隔离探针、`export` 不进                                                                                                                                                                                                                                                                             | V1 起    | 否                                                                                                                             |
| 40  | `sig_id` 算法                         | §9                                                                                  | **不变**:新信号字段、注入文本识别、分组账都不进 `sig_id` 的输入                                                                                                                                                                                                                                                                                                                                                                                                 | V0       | 否                                                                                                                             |
| 41  | R20-5.1 锁矩阵                        | 无私有仓库、HOME 侧个人层状态、分组账与 sync 锁的关系                               | 锁序 `rsi/lock` → `personal/lock` → sync 锁(R21-3.3);私有仓库与 `rsi-personal/**` 写入方 = 持 `personal/lock` 者;`.state/rsi/{candidates,canary.json,veto.json,tombstones.json}` 写入方 = 持 `rsi/lock` 的 worker 与 §21.12 的 `--write` 前台命令;`exec-enabled.json` 的授予只由 worker、收紧 / 删除由 worker 或持两把锁的前台撤销命令(R21-16.2a);拒绝标记、`exec-events.jsonl` 不拿锁;分组账 / `AUTO_PAUSE` / hint 标记不拿锁;`exec/lock`、`contrib/lock` 独立 | V1       | 否(规划;A1 未实现)                                                                                                             |
| 42  | R20-1.3 状态 × 读写矩阵               | `off` 无写;`stopped` 只允许 confirm / purge / `--ack` 写                            | `off` 追加:`rsi auto clear --write` 对 HOME 登记表、`rsi-personal/`、私有仓库与本机 payload 的撤销(R21-9.5);`stopped` 追加:`rsi auto clear --write`、`rsi rollback --to --write`、`rsi veto`(R21-9.4);`armed` 不变(自动循环要求 `confirmed`)                                                                                                                                                                                                                    | V1       | 否(规划;`rsiStateOf` 未实现)                                                                                                   |
| 43  | §20 通用约定 / R20-7.3 输出边界       | stdout 只含计数、枚举、id、哈希前缀(唯一例外 `rsi projects`)                        | 追加 §21.12「输出边界的例外」所列六处(除 hint 外都要求 TTY),仍过清洗与泄漏闸                                                                                                                                                                                                                                                                                                                                                                                    | V1 起    | 否(规划)                                                                                                                       |
| 44  | R20-3.3.1 / R20-3.3.4 hint 参数与去重 | 只接受 `--agent`(P1 `--format`);同一 agent 30 分钟只输出一次                        | 新增 `--canary`(只由「每会话开始一次」的钩子形状传入,R21-6.2);`--canary` 的分组路径不受 30 分钟去重,计数行去重不变;`rsi hooks` 的片段相应追加(v2 A5)                                                                                                                                                                                                                                                                                                            | V1       | 否(规划;hint 未实现)                                                                                                           |
| 45  | §19.7 `HOME_WRITE_TABLE` 条数         | 12 条;§20.9 第 13 条(v2 A5)另加第 13 条 pi 扩展                                     | 本节**不新增**条目;条数按 v2 A5 是否落地为 12 或 13,与本节无关                                                                                                                                                                                                                                                                                                                                                                                                  | —        | 否                                                                                                                             |

### 21.19 与 §20 / R20-A0 的衔接

**§20 条款的去留**:

| §20 条款                                         | 处理                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R20-1.1                                          | **细化**(§21.18 第 12 条):允许私有仓库 git;闭包另禁 `publish/**` 与宿主执行器                                                                                        |
| R20-1.2、R20-1.2a、R20-1.4–R20-1.7、R20-1.9–1.12 | **保持有效**;`[rsi.auto] enabled` 是 R20-1.2 之上的第二道开关,缺省同样关                                                                                             |
| R20-1.3 状态矩阵                                 | **细化**(§21.18 第 42 条:`off` / `stopped` 的允许写集合追加撤销类前台命令)                                                                                           |
| R20-1.8                                          | **部分取代**(§21.18 第 13 条,R21-1.3)                                                                                                                                |
| §20.2                                            | **修订** R20-2.6 的 L-base(§21.18 第 19 条),其余保持;追加子表(R21-2.1)                                                                                               |
| R20-3.0 稳定码表                                 | **保持有效**,追加(R21-12.9)                                                                                                                                          |
| R20-3.3(hint)                                    | **细化**(R21-6.10、R21-6.11、R21-13.2、§21.18 第 44 条);计数行模板与 ≤ 200 字节不变                                                                                  |
| §20 通用约定、R20-7.3                            | **细化**(§21.18 第 43 条输出例外)                                                                                                                                    |
| R20-3.4(status)                                  | **保持有效**,追加键(R21-13.1)                                                                                                                                        |
| R20-3.8(purge)                                   | **细化**(R21-11.6:私有仓库历史改写)                                                                                                                                  |
| §20.4 其余、§20.5、R20-6.1–6.4、R20-6.6–6.10     | **保持有效**                                                                                                                                                         |
| R20-4.6 / R20-4.7                                | **细化**(R21-11.5)                                                                                                                                                   |
| R20-5.1                                          | **细化**(§21.18 第 41 条)                                                                                                                                            |
| R20-6.5                                          | **保持有效**,并列 `auto_paused`(R21-10.1)                                                                                                                            |
| R20-7.1                                          | **细化**(R21-12.10)                                                                                                                                                  |
| §20.8                                            | **保持有效**;§21.20 追加                                                                                                                                             |
| §20.10 P1 / P2 占位                              | `rsi digest` / `reflect --ingest` / `[rsi.session]` / `--format` / `rsi hooks` 保持;S2 缺省改为 R21-2.3;`judge --ingest` 与 N4 对个人层不再需要(只影响 §18 手动路径) |

**R20-A0 已实现部分**:全部**保持有效、不需要改**——`UserConfig.rsi: z.unknown().optional()`(任意 `[rsi.*]` 子表不连累 update,R21-2.1 的分层校验落在 `src/rsi/config.ts`)、`RUN_SELF_ENV_KEYS` 三个具名键、`RunSelfOptions.cwd`、`src/update/self-spawn.ts`(只用于起 worker;§21 不给它增加目标或参数)、`safe-fs.createExclusive`(R21-11.2 首建密钥、R21-12.2 的 `AUTO_PAUSE` 与周报标记复用它)、`KIT_RSI_CHILD=1`、reader 单行 JSON 深度 256(`RSI_MAX_JSON_DEPTH`;注入识别 R21-6.9 在其之后执行)、`canonicalJsonLine`(审计与分组账复用)。

**§20.9 未做项归期**(先完成 §20 的 A1–A3 与 v2 A4–A6,§21 的 V1 才开工):

| §20.9 条                | 内容                                                    | 归属                                                          |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| 第 3 条 ③④⑤             | 根入口路由、`__rsi --background` 识别、§7 加 `rsi` 行   | §20 A3(V1 前置)                                               |
| 第 6、7、8 条           | gc / reflect / judge / `signals collect` 拿 `rsi/lock`  | §20 A1(V1 前置)                                               |
| 第 9、10、16、18、19 条 | purge 重写、exclude 导出、A5 清单、`--root`、调度闸     | §20 A2 / A3(V1 前置);第 16 条另按 §21.18 第 39 条追加 V1 命令 |
| 第 11、21 条            | `promote --run` 即时闸 / taint                          | §20 A2(V1 前置)                                               |
| 第 17 条                | rsi 专用 `IoContext`                                    | §20 A1(V1 前置)                                               |
| 第 12 条                | doctor D17                                              | v2 A6(V1 前置);D17 在 V1 追加显示 `auto` 状态                 |
| 第 13 条                | `HOME_WRITE_TABLE` 第 13 条 pi 扩展(kit 写入、可执行类) | v2 A5;与 R21-15.9 第三方扩展无关,不合并                       |
| 第 15 条                | `Proposal.reflector.provenance`                         | v2 A4(V1 前置)                                                |

### 21.20 验收口径与必须覆盖的变异点

各期验收沿用 v3.1 §10.2 的表(验收项与变异点逐条引用本节条款);下面只列必须由契约测试钉死、且 v3.1 表里没有逐字写出的项:

| 期   | 补充验收(机器可判)                                                                                                                                                                                                                                                                                                                                                                                                                               | 补充变异点                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| V0   | 本节稳定码 / 原因码 / 熔断码在 `src/contracts/rsi.ts` 有唯一枚举,测试断言文档与枚举一致(同 §19 的做法)                                                                                                                                                                                                                                                                                                                                           | 枚举多一项或少一项                                                                                                              |
| V1   | R21-4.3 非法组合矩阵全部 `candidate_invalid`;每个非终态的 `veto` / taint / 到期都先停注入(R21-4.4);control 组也输出关联标记;`AUTO_PAUSE` 或策略指纹不符时下一次 hint 即 `excluded`;`off` 下 clear 与旧仓库 worker 经 `personal/lock` 互斥;R21-1.6 计时口径(假时钟推进 365 天、零会话 → 无任何候选走向更多生效);R21-3.6 用户全局钩子与本地过滤器不执行;R21-6.11 hint 总输出 ≤ 1736 字节、codex 恒无 canary;R21-9.5 `off` 下 `rsi auto clear` 可用 | 日历计时用于 shadow → canary;`commitPersonal` 继承全局配置;hint 在纯文本模式附 canary;撤销路径检查 `auto_paused`                |
| V1.5 | `RSI_DECIDE_BETTER_ENABLED` 在报告通过且 `§21.7a` 写入、夹具通过前为假;附录缺任一项时 `canary → adopted` 的转移函数拒绝(R21-7.13)                                                                                                                                                                                                                                                                                                                | 常量缺省为真                                                                                                                    |
| V2   | `AUTO_SYNC_DECLINE_REASONS` 追加三码且在 §19 文本中出现(`test/contracts/sync-update.test.ts` 的同一断言);锁序反向时测试红                                                                                                                                                                                                                                                                                                                        | 先拿 sync 锁后拿 `rsi/lock`                                                                                                     |
| V4   | 草稿目录与 `export` 的权限、HOME 内判定(macOS `/var` 软链形态的临时目录各跑一遍)                                                                                                                                                                                                                                                                                                                                                                 | `export_dir` 链上符号链接被接受                                                                                                 |
| V5   | `restored` 不在任何枚举里                                                                                                                                                                                                                                                                                                                                                                                                                        | 停用终态写成 `restored`                                                                                                         |
| V6a  | `RSI_AUTO_PHASE < V6b` 时真实 `runIsolated` / `runHostScript` 拒绝;`exec-run` 对 `arm=control` 的标记拒绝;worker 闭包不含 `exec/host/**`                                                                                                                                                                                                                                                                                                         | 准入守卫缺任一项仍进 canary;control 会话也执行                                                                                  |
| V6a  | R21-16.2b 的「旧 treat 标记 + 暂停 / STOP / 熔断 / 探针失败 / 探针到期 / 撤销 / 拒绝」十种情形执行器零调用;R21-16.2c 三种并发交错;R21-3.6a 五个 phase 的崩溃恢复(V1 起);R21-9.5 三项验收(V1 起);R21-6.11 结果矩阵每行一例(V1 起)                                                                                                                                                                                                                 | 守卫在拿锁后不复查;worker 不重读拒绝标记就写启用表;恢复时用 `read-tree --reset`;缩减 clear 写仓库 `.state`;账行写失败仍输出标记 |

### 21.21 契约自洽性核对表

| #   | 新条款                               | 对照                                                 | 结论                                                                                                                                                            |
| --- | ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | R21-1.4 零 LLM / kit 进程零联网      | D5 / D10、R20-1.1                                    | 自动入口一致;前台有两类明确例外(`contrib submit` 联网;`exec-run` / `isolation probe` 执行宿主脚本 / 容器,网络不受 kit 约束),经 §21.18 第 12 条写明,不作全称断言 |
| 2   | R21-1.3 个人层自动生效               | R20-1.8                                              | **冲突**,第 13 条修订;开 PR / 推送 / 通知禁令保持                                                                                                               |
| 3   | R21-3.6 私有仓库 git                 | R20-1.1「唯一子进程」、§19.7 `EXEC_ALLOWLIST`        | **冲突**,第 12 条扩展 R20-1.1;白名单本身(`git`)不变                                                                                                             |
| 4   | R21-8.1 personal 本机渲染            | §4.2、A15、§19.1 ⑨                                   | **冲突**,第 1、6 条;包 payload 侧不变                                                                                                                           |
| 5   | R21-8.2 safe 新增条件                | §19.6                                                | 条件不放宽只追加;锚点信任来源不同(写明)                                                                                                                         |
| 6   | R21-6.10 canary                      | R20-3.3、R20-1.9                                     | **冲突**,第 14、44 条;R20-1.9(不读 cwd / stdin)保持,因此资格改为分析时现算(R21-6.7),同会话去重改由钩子形状 + 多标记排除(R21-6.2、R21-6.6)                       |
| 7   | R21-16.11 / R21-17.10 新出口         | §19.7 exec 白名单                                    | 不冲突:白名单不变,新增的是与 `runSelf` 同类的独立出口                                                                                                           |
| 8   | E1 自动启用                          | §19.6 末段                                           | 不冲突:E1 不经 sync                                                                                                                                             |
| 9   | 第三方扩展                           | F8、R20-1.1                                          | 一致:kit 不写 agent 配置、kit 进程零联网;端到端联网与执行属会话 agent,需 §21.15 授权                                                                            |
| 10  | R21-3.9 两套生命周期                 | §18                                                  | 一致:分开存放、分开枚举                                                                                                                                         |
| 11  | R21-12.2 `rsi auto pause` 不拿锁     | R20-5.1 末行(标记类不拿锁)                           | 一致                                                                                                                                                            |
| 12  | R21-9.4 stopped 下的撤销             | R20-1.3 `stopped` 允许写                             | **冲突并修订**(§21.18 第 42 条)                                                                                                                                 |
| 13  | R21-9.5 `off` 下 `rsi auto clear`    | R20-1.3 `off` 不允许任何写                           | **冲突并修订**(§21.18 第 42 条);Q-C                                                                                                                             |
| 14  | R21-2.3 S2 缺省                      | §20.10 N2 待定                                       | 一致:v3.1 M10 已定开启自动循环时的缺省                                                                                                                          |
| 15  | R21-6.4 分组账不拿锁                 | R20-5.1                                              | 一致:单行 `O_APPEND`                                                                                                                                            |
| 16  | R21-12.10 审计保留                   | R20-7.1 `log.jsonl` 200 行                           | 不冲突:不同文件、不同用途                                                                                                                                       |
| 17  | R21-11.6 purge 改写私有仓库历史      | R20-3.8.3「不删暂存 run」                            | 不冲突:私有仓库不是暂存区;journal 阶段追加 `personal_rewritten`(在 `tainted` 之后、`signals_rewritten` 之前)                                                    |
| 18  | R21-1.6 计时口径                     | v3.1 §5.1「N 天按 N 会话」、§5.3「120 会话或 90 天」 | v3.1 内部口径混用;本节按方向拆开,列 Q-A                                                                                                                         |
| 19  | R21-7.5 / R21-6.2 adopted 注入比例   | v3.1 §8 表「90% 注入」 vs §5.1 / §5.4「80% / 20%」   | **v3.1 内部不一致**,取 80% / 20%(两处正文 + 留出组算术),列 Q-D                                                                                                  |
| 20  | R21-14.5 G8 超时                     | v3.1 §8 表「7 / 14 天」 vs §4.3「15 / 30 会话」      | **v3.1 内部不一致**,取 §4.3 的会话口径(符合 R21-1.6 ①),列 Q-E                                                                                                   |
| 21  | `PersonalLifecycleRecord`            | §18.5 理由码                                         | 一致:独立枚举                                                                                                                                                   |
| 22  | 信号字段追加                         | §9 `sig_id`、`SignalSchema`                          | 一致:只增不改、不进 `sig_id`                                                                                                                                    |
| 23  | R21-3.2 HOME 侧个人层状态            | v3.1 §3.2、§5.5(journal 在 `.state/rsi/`)            | **与设计稿位置不同**:私有仓库每 HOME 唯一而 `.state` 每仓库一份,journal / 锁 / HEAD 记录放 HOME 侧才能在换仓库、关配置后续做;列 Q-M                             |
| 24  | R21-4.1 G8 在 `shadow → canary` 之前 | v3.1 §5.1「canary → blocked(G8 超时)」               | **比设计稿更保守**:G8 未过不进灰度,`blocked` 只从 `shadow` 进入;列 Q-K                                                                                          |
| 25  | R21-4.1 `canary → adopted` 标 V2     | v3.1 §10.2 V1.5「判定」                              | 一致方向:V1.5 只记录 `would_adopt`,真正的 adopted 与 stable 同期开放,避免 V1.5 产生无处可去的 adopted;列 Q-N                                                    |
| 26  | R21-5.3 配额常量                     | v3.1 §3.5「配置只能调严」                            | **比设计稿更严**:配额不开放任何配置键(R20 开头「全部常量不可配置」);档位 lite 是唯一的「调严」途径                                                              |
| 27  | R21-7.2 / R21-7.4 统计方法           | v3.1 §5.3(置换检验、OBF 型 spending,未写分配)        | 本节补定:MH 率比、几何均值比、四项 Bonferroni 平分、Lan–DeMets 信息时间;区间构造留给 V1.5 的 `analysis-plan v1` 附表,附表前不判通过;列 Q-O                      |

### 21.22 已定细节取舍(Q-A–Q-P,主代理按推荐,2026-10-23)

v3.1 已把用户决定列全;以下是落契约时新发现的契约细节取舍。**全部已定(主代理按推荐,2026-10-23)**:每项取第一项 **A**,正文据此写成的条款是正式条款,不再是暂定;表中保留未采纳的备选与代价,供日后复核。这些是契约细节取舍,不属用户决定(U / M / P / T 系列)的范围;日后若改判,以一次契约修订替换对应条款。

| #   | 问题                                                    | 已定(A)与未采纳的备选                                                                                                                                                | 各项代价                                                                                          |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q-A | v3.1 的「N 天」何时按会话、何时按日历                   | **A** 按方向拆分(R21-1.6):走向更多生效只按会话,走向停用 / 到期可按日历;B 全部按会话                                                                                  | A:长期不用时候选会因日历到期而 `expired`(保守);B:长期不用的候选永不到期,冷却与保留期也停摆        |
| Q-B | hint 不知道会话项目(R20-1.9),资格如何前置               | **A** 分组对项目盲、资格在分析时用会话开始前的数据现算(R21-6.7);B 放宽 R20-1.9 让 hint 读钩子 stdin 里的 cwd                                                         | A:不合格会话也被注入(多花注入字节,M13 只注入通用规则,风险低);B:推翻 P0 已定的「钩子参数不可信」   |
| Q-C | `[rsi]` 关闭(`off`)后已生效的自动产出怎么撤             | **A** `rsi auto clear --write` 不依赖 `[rsi]`,只读 HOME 登记表与私有仓库;B 要求先恢复配置                                                                            | A:`off` 的「零写入」多一个前台例外;B:用户关掉配置后自动产出仍常驻、且撤不掉                       |
| Q-D | adopted 注入比例                                        | **A** 80% / 20%(v3.1 §5.1、§5.4);B 90% / 10%(v3.1 §8 表)                                                                                                             | A:灰度组少拿 10% 受益;B:留出组凑 20 会话要约 200 个总会话,与 §5.1「总计约 100」不符               |
| Q-E | G8 固定测试超时口径                                     | **A** 会话口径(生成 15、执行 30、再 30 → `expired`,v3.1 §4.3);B 日历 7 / 14 天(v3.1 §8)                                                                              | A:用户不用 agent 时不超时;B:与「走向更少生效可按日历」不冲突,但与 §4.3 正文矛盾                   |
| Q-F | E-G5 编号                                               | **A** 保留空号不用(防将来与 v3.1 引用错位);B 重排为连续编号                                                                                                          | A:编号不连续;B:v3.1 与评审记录里的 E-G6 / E-G7 引用全部错位                                       |
| Q-G | v3.1 §3.6 安装票段仍写「`restored` 后 30 天删除」       | **A** 读作 `uninstalled`(第三轮 M9 已改终态名),契约不出现 `restored`;B 保留 `restored` 作为别名                                                                      | A:设计稿需一处措辞订正(本 PR 在「契约落地对照」里记下);B:两个名字指同一状态,枚举测试难写          |
| Q-H | 私有仓库提交是否也用封闭 git 配置                       | **A** 是(R21-3.6,另禁全部协议、不签名、固定作者);B 沿用用户全局配置                                                                                                  | A:私有仓库提交不带用户签名与作者身份;B:用户全局钩子 / 过滤器 / fsmonitor 会在**自动路径**上被执行 |
| Q-I | `static_pending` 7 天超时的去向                         | **A** `rolling_back`(v3.1 §8 表原意,原因 `static_sync_timeout`);B 回 `adopted` 继续注入、下次再试                                                                    | A:因用户改过托管块等环境原因而丢掉已证实的候选;B:可能长期卡在「注入 + 待同步」两种部署并存        |
| Q-J | `rsi auto pause` 是否要求 TTY                           | **A** 不要求(紧急停应当随手可用,只减少影响);B 要求                                                                                                                   | A:有 shell 的 agent 也能暂停循环(只是少生效,不扩大能力);B:脚本与钩子里没法一键停                  |
| Q-K | G8(固定测试)放在 `shadow → canary` 之前还是 canary 期间 | **A** 之前(R21-4.1):测试未过不注入;B 照 v3.1 §5.1 在 canary 期间,超时 `canary → blocked`                                                                             | A:有 G8 的候选进灰度更晚;B:未过测试的规则已经注入用户会话                                         |
| Q-L | 「每会话开始一次」靠什么保证                            | **A** 钩子形状(claude `SessionStart` 只挂 `startup`;pi 以 V1 准入实测为准)+ 同会话多标记整会话排除(R21-6.2、R21-6.6);B 放宽 R20-1.9 让 hint 读钩子 stdin 里的会话 id | A:pi 的钩子若每轮触发,只能靠多标记排除,样本浪费;B:推翻「钩子参数不可信」,会话 id 进 kit 输入面    |
| Q-M | 私有仓库的锁、journal、HEAD 记录放哪                    | **A** HOME 侧 `.local/state/agent-kit/rsi-personal/`(R21-3.2),与仓库 `.state` 分开;B 照设计稿放 `<repo>/.state/rsi/`                                                 | A:多一处状态目录与一把锁;B:换仓库或关配置后无法续做撤销,两个仓库可各持一把锁改同一私有仓库        |
| Q-N | V1.5 能否产生 `adopted`                                 | **A** 不能,`canary → adopted` 随 V2 开放,V1.5 只记 `would_adopt`;B 能,adopted 在 V2 前停留                                                                           | A:V1.5 期间看不到「生效」;B:adopted 在 V2 前占用全局唯一评估名额且无处可去                        |
| Q-O | 统计方法的未定部分                                      | **A** 本节先定单位、统计量、α 分配与 OBF 信息时间,区间构造由 V1.5 附表补,附表前不判通过;B 全部留给 V1.5                                                              | A:V1 的伤害判定可以先跑;B:V1 期间连「判变差」都没有确定的 oracle                                  |
| Q-P | `rsi auto clear` 的终态理由                             | **A** 新增 `cleared`(R21-12.4);B 复用 `vetoed`                                                                                                                       | A:理由码多一项;B:`clear` 会把全部候选写进永久黑名单,之后同样的规则永远提不出来                    |

### 21.23 评审记录

2026-10-23,`~/.claude/bin/pi-review.sh` 只读评审(第 1 级 Pi GPT-6.1 Sol 成功),针对本节初稿与修订标注,20 条(高 10、中 9、低 1)。结论:「37 项映射已齐,但关键状态、证据关联和恢复边界尚未闭合;修复高严重度问题并补齐机器可判定义后,才建议冻结 §21」。逐条处置:

| #   | 问题(严重度)                                                      | 处置                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 对照组没有可取回标记,ITT 与 C6 无法成立(高)                       | 采纳:两组都输出中性关联标记,control 只不附正文(R21-6.3);`arm=excluded` 与随机对照区分(R21-6.4);准入同时验证标记(R21-6.5)                                                                                                                                                                                 |
| 2   | 单会话标记不能去重;30 分钟去重改变随机化单位(高)                  | 采纳:删去单会话标记;分组只经 `--canary`、由「每会话开始一次」的钩子形状发出,不受 30 分钟去重(R21-6.2、§21.18 第 44 条);同会话多标记整会话排除(R21-6.6);不放宽 R20-1.9,列 Q-L                                                                                                                             |
| 3   | `expired` / `blocked` 等退出路径无撤销,与组合矩阵冲突(高)         | 采纳:离开注入一律经 `rolling_back` 四段,`target_terminal` 决定终态(R21-4.1、R21-4.4);`blocked` 只从 `shadow` 进入、无部署;各非终态补 `veto` / taint 路径                                                                                                                                                 |
| 4   | 静态撤回起始状态写错;撤回后会被重新渲染(高)                       | 采纳:新增 `static → withdraw_pending → injected`(codex 为 `→ none`)(R21-4.2、R21-8.6);渲染集合按每 agent 部署意图选取(R21-8.1)                                                                                                                                                                           |
| 5   | 单个 `deploy` 字段表示不了按 agent 分阶段部署(高)                 | 采纳:`deploy` 与 `watch` 改为每 agent 三键(R21-3.7);静态确认后该 agent 停注入(R21-4.2);评估名额释放条件写明(R21-6.8)                                                                                                                                                                                     |
| 6   | E1 准入流程未进状态机(高)                                         | 采纳:E1 准入守卫四项、`exec-enabled.json` schema、`exec-run` 执行前检查顺序与 `--marker` 组别校验(R21-16.2、16.2a、16.2b);V6b 前真实执行器一律拒绝                                                                                                                                                       |
| 7   | E1 宿主执行与「唯一联网命令、禁止宿主闭包」矛盾(高)               | 采纳:R21-1.4 改为三层(自动入口 / 前台 / 明确例外),不作全称断言;worker 只调度不执行;§21.18 第 12 条、§21.21 第 1 条同步                                                                                                                                                                                   |
| 8   | 暂停、排除后下一次 hint 停注入无法保证(高)                        | 采纳:hint 直接读 `AUTO_PAUSE` / `STOP`、现算 `policy_fp` 与 `canary.json` 比对(R21-6.10);暂停语义改为按事件分类(R21-2.2、R21-10.1)                                                                                                                                                                       |
| 9   | 私有仓库「熔断 / 不熔断」自相矛盾;封闭 git 漏本地配置与过滤器(高) | 采纳:结构校验与 HEAD 三态分开、定优先级(R21-3.4、R21-3.5);本地 `.git/config` 键白名单,禁 alternates / `config.worktree` / gitdir 链接 / `.gitattributes`,提交走底层命令(R21-3.6)                                                                                                                         |
| 10  | `off` 下清理与多仓库共用私有仓库缺锁与恢复归属(高)                | 采纳:HOME 侧 `rsi-personal/`(锁、journal、HEAD 记录、`owner_repo_fp`)与全局锁序(R21-3.2、R21-3.3);换仓库 → `personal_owner_changed`(R21-3.5 ④);列 Q-M                                                                                                                                                    |
| 11  | V1.5 可产生 adopted 但出口到 V2 才有(中)                          | 采纳:`canary → adopted` 改标 V2,V1.5 只记 `would_adopt`(R21-4.1、R21-7.9、R21-7.10);adopted 到上限 → 回滚到 `expired`;列 Q-N                                                                                                                                                                             |
| 12  | G8 触发位置与生效守卫未闭合(中)                                   | 采纳:G8 为 `shadow → canary` 守卫并绑定 `case_set_sha256`,判生效再核一次(R21-4.1、R21-7.3、R21-14.1);G8 红 → `rejected`;列 Q-K                                                                                                                                                                           |
| 13  | lite / heavy 与 V3 产物限制遗漏(中)                               | 采纳:档位矩阵(R21-14.3a)、heavy 每组 30、权重公式(R21-14.3);技能正文 4096 / 触发 200 字节、子代理工具集差分(G4);600 字节只管规则 / 踩坑(G5)                                                                                                                                                              |
| 14  | 统计方法不能产生唯一可复现判定(中)                                | 部分采纳:定单位、分层并层规则、统计量、四项 Bonferroni、Lan–DeMets 信息时间、查看计划不累计与换段重置、边界严格性、C3 事件门槛(R21-7.1、7.2、7.4);区间构造留 V1.5 附表,附表前正向判定不可判通过(R21-7.3)。未在本节写全区间算法,理由:需本机历史数据校准,列 Q-O;未定的四项已写成正向判定的硬前置(R21-7.13) |
| 15  | 背景分段与静态前后比较、生产误生效不可观测(中)                    | 采纳:`background_fp_ex` 配对与漂移暂停(R21-6.4、R21-7.7、R21-8.4);生产改用「adopted / stable 后因 harm 回滚」代理事件(R21-7.12)                                                                                                                                                                          |
| 16  | schema 不足以支撑恢复,有字段冲突(中)                              | 采纳:分组账 `assign` / `stop` 联合与 `arm=excluded`、`case_set_sha256`;`transitions` 带 `dim` / `agent`、上限 256 与溢出计数;权威副本 / 工作副本的同步检查点(R21-3.8);审计 `seed` / `exec` 形状(R21-12.10)。完整 schema 登记清单留给 V1 schema 落地(带标记示例)                                          |
| 17  | 投稿漏失败、频率、令牌失效的行为(中)                              | 采纳:三类失败都导出、导出失败另报;`gh` 退出 0 但无编号归入 `pr_unconfirmed`;按「推送已发出」计频、预留行与 `contrib/lock`;再 fetch 判 `upstream_moved`;L7 合成样例例外(R21-17.5、17.7、17.9、17.11)                                                                                                      |
| 18  | 扩展流程入口、授权记录、停用不完整(中)                            | 采纳:`inventory` / `authorize` / `disable` 入口与写入方(R21-15.4a)、`ExtensionAuthorization`(R21-15.4b)、票状态机与幂等 verify(R21-15.5)、「不执行卸载脚本」可测(R21-15.6)、记录正文走灰度(R21-15.7a)                                                                                                    |
| 19  | 冲突表遗漏,部分「保持有效」不准确(中)                             | 采纳:§21.18 新增第 42–45 条(R20-1.3 矩阵、输出例外、hint 参数与去重、`HOME_WRITE_TABLE` 条数);第 19 条改为 L-base 修订;本机同步结果不写 `UpdateState`(R21-8.2);§18 范围改写为范围声明(R21-3.9);影响代码一栏写法说明                                                                                      |
| 20  | 稳定码、退出码、冻结状态收口(低)                                  | 采纳:命令 × 退出码表、`unknown_id` 统一为用法错误、桩(64)与 `phase_not_available`(4)分工、动态后缀封闭集合(§21.12);配额不可配置登记为偏离(§21.21 第 26 条);Q-A–Q-P 已由主代理按推荐定下(§21.22),§21 整体标「草案,第二轮评审通过前不冻结」(节首状态行)                                                    |

评审对 Q-A–Q-J 的意见:全部认为推荐合理;Q-B、Q-C、Q-H、Q-I、Q-J 附带的补充(关联与去重、HOME 侧锁、本地配置与过滤器、两类撤回区分、hint 直接看暂停)已分别并入问题 1、2、10、9、4、8 的处置。评审建议新增的待澄清项已作为 Q-K–Q-O 加入(另加 Q-P)。修订后未做第二轮评审;如需,建议只评 §21.3、§21.4、§21.6、§21.16 四处。

**第二轮评审**(2026-10-23,第 1 级 Pi GPT-6.1 Sol;范围按主代理指定:§21.3、§21.4、§21.6、§21.16,第一轮高 1–10 的闭合核查,抽查 11、12、16、19,第 14 条硬前置与分期)。结论原文:「高严重度是否全部闭合:否」「§21 能否冻结:不能(冻结前至少修复上述六组契约缺口)」。

第一轮核查:高 1、2、4、8 闭合;高 3、5、6、7、9、10 部分闭合;抽查 11、12、19 闭合,16 部分闭合;第 14 条的正向硬前置与分期判为自洽,另要求补 V1 变差方向的稀疏规则与 V1.5 无附录时不出 `would_adopt`。

本轮新发现 11 条(高 4、中 7)。**第二轮处置**(按评审建议的六组收口,均在已定决定之内,未改任何用户决定):

| #   | 问题(严重度)                                                                             | 落点                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `exec-run` 未检查暂停 / 停止 / 配置失效 / 探针非 verified,旧 treat 标记仍可放行(高)      | 第 1 组:R21-16.2b 改为八项共同硬守卫(状态与开关、`STOP` / `AUTO_PAUSE` / 任一熔断码、总开关、探针 verified + 版本常量 + ≤ 7 天 + 指纹、撤销凭据与拒绝标记、启用表身份、treat 账行晚于最近启用、`exec/lock`),拿锁后复查;补「旧 treat 标记 + 十种情形 → 执行器零调用」验收 |
| 2   | E1 停用与身份变化的写入方不符锁约束,存在停用后被重新启用的窗口(高)                       | 第 1 组:唯一停用协议 R21-16.2c(拒绝标记按身份 + 事件,不拿 `rsi/lock`;worker 唯一写启用表并在锁内重读拒绝标记与凭据,R21-16.2a);补三种并发交错验收                                                                                                                         |
| 3   | `commitPersonal` 缺 durable journal,崩溃被误判为人工分叉;分叉下撤销会 reset 用户改动(高) | 第 2 组:R21-3.6a 单文件提交 journal(五个 phase、`update-ref` 带期望旧值)与三分支恢复优先级,先于 R21-3.5 判定;`read-tree -m -u` 两树合并取代 `--reset`(R21-3.6);人工分叉下撤销不碰私有仓库、改用撤销凭据重渲染(R21-9.3a)                                                  |
| 4   | `off` 缩减撤销仍依赖原仓库文件(高)                                                       | 第 3 组:HOME 侧持久撤销凭据 `revocations.jsonl`(R21-9.5),它单独构成第二段完成判据(R21-9.1);缩减模式不访问仓库 `.state`,记待对账;任何授予写入与 worker 首次拿锁都先对账;hint 与 `exec-run` 直接读凭据;补三项验收                                                          |
| 5   | E1 隔离试跑与首次确认没有可达入口(中)                                                    | 第 4 组:前台 `rsi exec-prepare`(试跑,写 `trial/<id>.json`)与 `rsi exec-confirm`(TTY 确认,写 `confirm/<id>.json` 与固定副本),写入方、锁、结果绑定写进 R21-16.2 / R21-16.4;命令 × 退出码表补两行                                                                           |
| 6   | worker 复跑完整探针与闭包禁令冲突(中)                                                    | 第 4 组:R21-16.14 改为 worker 只登记到期,完整探针只由前台 `rsi isolation probe` 执行;到期即被守卫 4 视为未验证;R21-1.4 同步                                                                                                                                              |
| 7   | E1 到 stable 后落入文本静态部署状态机(中)                                                | 第 4 组:R21-4.3a 定义 `category=exec` 的部署语义(`injected` = arm-gated,`static` = 全放行,不经 payload / sync,codex 恒 `none`),R21-8.1 写明 E1 不进本机 payload                                                                                                          |
| 8   | 转移表缺 `blocked → rejected`、clear 路径、重复终止事件语义、正常原因码(中)              | 第 5 组:R21-4.1 补 `blocked → rejected` 与 `proposed\|shadow → rejected`(clear);R21-4.4a 重复终止事件(不重置阶段、目标与理由按优先级只升不降、终态只记黑名单);R21-4.6 正常转移原因码                                                                                     |
| 9   | 评估名额在静态证据不足撤回后无法释放(中)                                                 | 第 5 组:R21-6.8 的 `watch.result` 封闭枚举(`not_started` / `pending` / `passed` / `withdrawn_residual` / `withdrawn_ended` / `skipped` / `harm`)、常驻注入 120 会话上限、释放条件与「无 agent 静态 → 到期」;R21-4.2 补常驻注入结束的转移                                 |
| 10  | `excluded` 账行与 `off` 零写入、无候选状态未对齐(中)                                     | 第 5 组:R21-6.11 八行结果矩阵(无候选不伪造账行、`off` 零写入、未落账不注入)                                                                                                                                                                                              |
| 11  | 稀疏分层也影响 V1 变差判定(中)                                                           | 第 6 组:R21-7.4a(剔层、无层可用不判定不耗 α、到上限按证据不足);R21-7.13 ③ 收窄为区间构造;R21-7.10 附录前正向记「不可判」                                                                                                                                                 |

修订后做第三轮评审。

**第三轮评审**(2026-10-23,第 1 级 Pi GPT-6.1 Sol;范围:第二轮六组修订与点名条款)。结论原文:「高严重度是否全部闭合:否」「§21 能否冻结:不能(冻结前必须修复上述第 1–5 项契约缺口,并同步条款及验收引用)」。第二轮 11 条核查:1、5、6、11 闭合;2、3、4、7、8、9、10 部分闭合。本轮新提 9 条(高 2、中 6、低 1),**第三轮处置**:

| #    | 问题(严重度)                                                | 落点                                                                                                                                                                       |
| ---- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 高-1 | E1 身份变化回到 shadow,却被通用四段补偿写入永久撤销凭据(高) | R21-9.1 第二段写明 `identity_changed` 例外(以旧身份拒绝标记为完成依据,journal 记 `kind=identity_change`);R21-16.2c 同步并补端到端验收 d)                                   |
| 高-2 | 提交恢复只看 HEAD 哈希与工作树,不保护分支切换与索引(高)     | R21-3.6a:journal 绑定 `refs/heads/rsi`;恢复前校验 symbolic HEAD、引用值、索引、工作树与未跟踪文件,只允许三种组合;其余保留 journal、`personal_repo_diverged`;补三例保护测试 |
| 中-1 | 启用表无 agent 维度                                         | R21-16.2a 的 `agents` 三键(`off` / `gated` / `open`);`exec-run --agent` 与账行 `agent` 核对(守卫 7,声明非安全身份);R21-4.3a 对应;补并存与单 agent 撤回用例                 |
| 中-2 | 「worker 唯一写启用表」与前台撤销冲突                       | R21-16.2a 写入权分「授予只由 worker」「收紧 / 删除由 worker 或持两把锁的前台撤销命令」;仓库不可达或 `stopped` 下前台只写拒绝标记与凭据、留待对账;§21.18 第 41 条同步       |
| 中-3 | clear、残余注入结束、重复终止的源状态不一致                 | R21-12.4 按有无部署分两类;R21-4.3 允许 `stable` 下的 `removal_pending`;R21-4.4a 记实际源状态                                                                               |
| 中-4 | `watch.result` 三处定义不一致                               | R21-3.7 改为引用 R21-6.8 的唯一枚举;R21-8.6 列出每个时点的赋值                                                                                                             |
| 中-5 | 对账以「工作副本非终态」为条件,陈旧缓存不收敛               | R21-9.5:每条凭据无条件清理授予缓存,stop 行以 `revocation_ref` 去重;补验收④                                                                                                 |
| 中-6 | excluded 原因无字段;许可文件读取失败未入矩阵                | R21-6.4 `reason` 字段与封闭枚举(excluded 行 `marker=null`);R21-6.11 新增第 4a 行 `permit_unreadable`                                                                       |
| 低-1 | 16.2b / 16.2c 排版错位                                      | 已重排:八项守卫、复查与验收都在 R21-16.2b 内,R21-16.2c 只含停用协议与并发验收                                                                                              |

另在本轮发现并修正了两处排版错误(表格单元格里未转义的 `|` 把 `watch` / `transitions` 两行拆成多列;一条验收行被误插进 §21.0)。

**第四轮评审**(2026-10-23,第 1 级 Pi GPT-6.1 Sol;范围:第三轮 9 条与其涉及条款)。结论原文:「高严重度是否全部闭合:是」「§21 能否冻结:不能(冻结前必须修复中-1 至中-5,并同步相应 schema、转移表及验收引用)」。第三轮 9 条核查:高-1、高-2、中-1、中-4、中-6、低-1 闭合;中-2、中-3、中-5 部分闭合。本轮新提 5 条(全部中),**第四轮处置**:

| #    | 问题                                             | 落点                                                                                                                                              |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中-1 | `stopped` 下前台撤销的第二段没有一致的完成判据   | R21-9.1 第二段与完成判据:仓库不可达、`stopped`、`off` 三种情形下持久拒绝即完成,仓库缓存待对账;R21-16.2a 同步;R21-9.4 补验收                       |
| 中-2 | `retiring` 目标升级后无合法完成转移              | R21-4.1 `retiring → <target_terminal>`(缺省 `retired`,升级后 `rolled_back`,沿用已完成阶段)                                                        |
| 中-3 | 对账 stop 行的 `revocation_ref` 不在分组账结构里 | R21-6.4 `stop` 行登记 `revocation_ref`(普通行 `null`、对账行必填、同值至多一行、对账行为 `null` 即 schema 错)                                     |
| 中-4 | 静态监视 `not_started` 时既不占用也不释放        | R21-6.8 占用条件改为释放条件的补集(`not_started` / `pending` / `withdrawn_residual` 都占用)                                                       |
| 中-5 | E1 撤回中间态与启用表映射冲突                    | R21-4.3a 逐状态映射(`withdraw_pending` ↔ `gated`,进入时即收紧;`removal_pending` ↔ `off`);R21-16.2a 引用该映射;R21-16.2b 验收补正常 / 暂停两种撤回 |

修订后做第五轮评审。

**第五轮评审**(2026-10-23,第 1 级 Pi GPT-6.1 Sol;范围:第四轮 5 条与其涉及条款)。第四轮 5 条全部闭合;限定范围内未发现新的高、中、低严重度问题。结论原文:「高严重度是否全部闭合:是」「§21 能否冻结:能(本轮限定范围内无冻结前必须修复项)」。据此 §21 状态改为**冻结**(节首状态行)。评审自述:结论只针对指定范围,不表示对 §21 其它条款重新做了全量评审——第一轮是全量评审,第二至五轮是逐轮收窄的定向复核。
