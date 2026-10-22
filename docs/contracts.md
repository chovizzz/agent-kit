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
| 唯一写出口          | `src/io/safe-fs.ts`;每次写前校验目标(解析 symlink 后)落在 `IoContext.writeRoots` 内,违者 `WriteDeniedError`(`IO_WRITE_DENIED`),CLI 退出 3。拒绝:根外、`..` 逃逸、符号链接逃逸、悬空链接、硬链接(`nlink>1`)、写/删根本身                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
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
| 确定性序列化        | `canonicalJson`(键序、2 空格、LF、末尾换行,拒 undefined/NaN/环/非纯对象)、`canonicalText`(LF,末尾恰一个换行)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 5.2 受控 LLM 出口 `src/io/llm-exec.ts`(R0,#28)

`runLlm(ctx, req)`(异步)。**契约变更**:这是 `exec.ts` 之外第二个子进程出口,用于 reflect / judge 调用第三方 LLM CLI(摘录会离开本机)。

- **开关**:`req.allowEgress` 必须是布尔 `true`,否则 `IO_LLM_EGRESS_DENIED`,不 spawn、不消耗预算。命令层只在用户同时给 `--run-llm --allow-egress` 后置 true;**干跑路径不得 import 本模块**(eslint 强制,见下)。
- **二进制**:只能是 `claude` / `codex` / `pi`(裸名按 `envSource.PATH` 的绝对项解析,或同名绝对路径);解析结果落在仓库内且不在 `KIT_TMP` 内 → 拒(防仓库里埋假 `claude`)。`shell:false`,参数数组,≤64 个、每个 ≤8KiB、无 NUL;提示走 stdin(≤64KiB)。
- **env**:不继承。`LLM_ENV_ALLOW` 名字白名单(`PATH HOME USER LOGNAME LANG LC_* TZ TMPDIR XDG_*_HOME` 与代理变量)+ 固定 `NO_COLOR=1`;key/token/secret、`*_BASE_URL`、`CODEX_HOME`、`NODE_OPTIONS`、`LD_*`、`TERM` 等一律不传。唯一例外 `passEnv`:调用方在代码里写死、形如 `<NAME>_API_KEY` 的名字。本模块不读进程环境(只许 `paths.ts`),`envSource` 由调用方给,`filterLlmEnv()` 负责挑选(**待主代理**:`IoContext` 增可选 `hostEnv`,由 `paths.ts` 提供)。`HOME` 传**真实 HOME**(CLI 要读自己的登录态),必须绝对路径。
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

- LLM CLI 用**真实 HOME** 里的登录态,并会写它自己的全局文件(会话日志、history、缓存);`llm-exec` 只管 env/cwd/超时/输出/次数,**不能**阻止这些写入,A5 零写入验收对真跑不成立。真跑前后的受管路径快照与「每个 CLI 实际写了哪些全局文件」清单属 R6(主代理、需用户当场同意)。干跑与 stub 路径零调用零写入,仍在 A5 覆盖内。
- 残余:①`ANTHROPIC_BASE_URL` 等写在 CLI 自己的 `settings.json` 里时能把请求导向别家,`deriveVendor` 看不到,只能靠 R3 每次显式传 provider/model 与 R6 实测;②子进程若 `setsid` 脱离进程组则杀不到;③校验与 spawn 之间的路径竞态;④`envSource` 的来源(宿主环境)目前没有受控的 `IoContext` 字段(待主代理)。

## 13. reader 已知差异(B21 记录;口径正文见 `docs/reader-counting-spec.md` §8.3)

- **agent_version 形状(R1)**:只接受版本号形状(`X.Y.Z[-+后缀]`,总长 ≤ 64);其余值当取不到,走 `collector_fallback`。四家共用基类校验。
- **R8**:Claude reader 取 `version` 时跳过侧链行,§7.5 探针不跳过;首个带 `version` 的行恰是内联侧链行时两边版本可能不同。已知差异,未改。
- **单行硬上限 64 MiB(R3)**:超限的行记 `oversized_lines` 与 `unknown_event_types["<line-too-large>"]`,不使整个会话失败。`--max-event-bytes` 的上限等于该硬上限:超过时参数解析阶段报 USAGE(退出 2);`collect()` 库入口同样拒绝越界值(RangeError);reader 的 `read()` 同步抛错按该会话 `read_error` 处理(退出 1 + `SESSION_READ_FAILED count=N classes={"<类名>":n}`,只含异常类名计数,不含 message / 路径),不使进程崩溃。`signals collect` / `redact` 的 `--timeout-ms`、`--max-event-bytes` 与 zero-write 的 `--settle-ms` 一律只收十进制非负整数(共享解析 `src/commands/args.ts`;`ops/lib/zero-write.mjs` 就地同规则),否则 USAGE(退出 2)。
- **空白/BOM(R2)**:每一行按 jq 的空白集判空白、去行首一个 BOM(详见口径 C2 补充)。

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

### 17.6 R6 真实环境实测结论(2026-10-13,合成提示,回复 `NOTOOLS` 表示零工具成立)

参数集的 `claims` 与新增只读字段 `globalWrites` 已按下表更新;**`verified` 整体门三者都仍为 `false`**(noProjectContext / noProjectSettings / noUserRouting 本次未测,仍 `unresolved`),用户放行仍靠 `allow_unverified`,gate 语义不变。`FlagClaim` 增 `verified`(实测成立)与 `not_met`(实测不成立)。

| CLI    | 参数(模型/provider 由调用方给)                                                                                                                                                                            | noTools  | noMcp   | noSession | inputViaStdin |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | --------- | ------------- |
| claude | `-p --model <m> --tools "" --strict-mcp-config --no-session-persistence`                                                                                                                                  | verified | claimed | verified  | verified      |
| codex  | `exec -m <m> -c model_provider=… -c mcp_servers={} -s read-only --skip-git-repo-check --ephemeral` + `--disable {shell_tool,unified_exec,js_repl,code_mode,view_image,multi_agent,apps,plugins,memories}` | verified | not_met | not_met   | verified      |
| pi     | `-p --no-session --no-context-files --no-skills --no-extensions --provider <p> --model <m> --no-tools`(取代旧的 `--tools read`)                                                                           | verified | claimed | verified  | verified      |

1. **codex 的 `-c mcp_servers` 必须写 `mcp_servers={}`**:原写法 `mcp_servers="{}"` 在 codex-cli 0.161 直接报错(`invalid type: string "{}", expected a map`)。测试断言参数里不得再出现带引号的形式。`model_reasoning_effort` 不在 `build()` 的参数里(现有语义不变):R6 人工实测时另传,当前后端接口未提供该入口。
2. **codex 仅靠只读沙箱 + 空 MCP 仍会执行 shell**(read-only 下 `echo` 照跑)。加上九个 `--disable` 后回 `NOTOOLS`;**是组合有效,不知道哪几项起决定作用**,codex 升级后须重测这组 `--disable`(新版本可能改名/新增工具特性)。
3. **codex 的 MCP 仍会尝试连接**:`mcp_servers={}` 没有阻止它去连 `localhost:8000` 的 MCP(连接报错,不影响结果),所以 noMcp 标 `not_met`,不得当作「已隔离」。
4. **codex 的 `--ephemeral` 只是不存会话文件**,仍写 sqlite,noSession 标 `not_met`。
5. **R6 观察到的全局写入**(`globalWrites`;单次实测所见,不保证每次发生、清单不保证穷尽;`llm-exec` 与参数都挡不住,A5 零写入验收不覆盖真跑,见 §12.4/§17.4):
   - claude:`~/.claude.json`、`~/.claude/backups/` 新备份、`~/.claude/plugins/.last_inuse_sweep`、`~/.claude/plugins/synced` 与 `~/.claude/skills/synced` 下同步文件、`~/.claude/session-env` 启动脚本。
   - codex:`~/.codex/` 下 `state_5`、`goals_1`、`queue_1`、`logs_2` 四个 sqlite 及其 `-shm`/`-wal`。
   - pi:无可归因的全局写入。
6. 本次未测:noProjectSettings、noUserRouting 三者都保持 `unresolved`;noProjectContext 在 claude/codex 保持 `unresolved`,pi 沿用原先的 `claimed`(§16① 的 cwd 在仓库树内问题仍在)。claude 与 pi 的 noMcp 沿用 `claimed`。
7. **证据范围**:`noTools=verified` 的判据是合成提示下 CLI 回复 `NOTOOLS`(未保存工具注册清单/调用轨迹),且 codex 的结论是在「MCP 连接失败」的环境下得出——**未测**「用户配置了可连通且提供工具的 MCP」这一组合。升级 CLI 或环境里有可用 MCP 时须重测。

## 18. attest / promote / retire 生命周期契约(L0 追加字段;L1–L7 实装后订正)

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

| 出口                      | 谁能引用(import / export-from / 动态 import)                                                                                         | 其它                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/io/home-fs.ts`       | `src/sync/apply.ts`、`src/update/install.ts`、`test/io/home-fs*.test.ts`、`test/sync/apply*.test.ts`、`test/update/install*.test.ts` | 它自己可用 `node:fs`,不可用子进程 / 网络 / 环境                                                         |
| `src/io/net.ts`           | `src/update/**`(`launcher.ts` 除外)、`src/commands/update.ts`、`test/io/net*.test.ts`、`test/update/**`                              | 只有它可以 import 网络模块、使用全局 `fetch`                                                            |
| `src/update/launcher.ts`  | `cli.ts`、`src/cli.ts`、`src/update/**`、`src/commands/update.ts`、`test/update/**`                                                  | launcher.ts 自己不得引用 net / home-fs                                                                  |
| `io/exec.ts` 的 `runSelf` | 仅 `src/update/launcher.ts` 与 `test/update/launcher*.test.ts`                                                                       | 命名导入、`import *`、`export … from`、对 `io/exec` 的动态 `import()` 都拦(静态导入 `runSync` 不受影响) |

**exec 白名单条款(S7c-B 已实装;订正)**:`EXEC_ALLOWLIST` 仍恰为 `['git']`,`runSync` 不变;`src/io/exec.ts` 新增独立导出 `runSelf`,只能 spawn 当前 `process.execPath`,**脚本路径只由函数内部解析,调用方不能指定**,不经 shell,不继承 `execArgv`。三种目标(`target.kind`):

- `current`:`<home>/.local/share/agent-kit/current` 必须是符号链接,`realpath` 必须是 `realpath(versions/)` 的**直接子目录**且目录名是合法 semver(给了 `version` 就必须相等),`dist/cli.js` 必须是普通文件且路径链无符号链接(`realpath(entry) === entry`);spawn 的是这个解析后的真实路径。用户命令,前台 stdio 继承。
- `self`:本模块所在包(`import.meta.url` 往上找 `package.json`,取 `dist/cli.js`,同样要求普通文件、无链接)。**只给后台 worker 用**:`current` 还不存在(首次安装 / 刚 `npm i -g` 的引导版本)时也要能自动更新。它运行的是当前进程自己的代码,不构成信任升级;不用 `process.argv[1]`(那是调用方可影响的路径)。
- `candidate`:`staging/st-<hex>` 的直接子目录(`realpath` 后),参数**固定 `--version`**(调用方的 `args` 被忽略),stdio 为管道(stdout 回传、上限 64KB)、有超时;只给安装冒烟用。
  环境(**订正 S0 的「只传 KIT_LAUNCHED=1 及既有白名单键」,理由见下**):`KIT_LAUNCHED=1` 强制、`HOME` 强制为已校验的 `home`、`TMPDIR` 在给了受控目录时以其为准;其余只透传**具名**清单 `RUN_SELF_ENV_KEYS`(`PATH`、`LANG`、`TZ`、`TMPDIR`、`KIT_TMP`、`KIT_STATE_DIR`、`KIT_WRITE_ROOTS`、`KIT_REAL_HOME_OVERRIDE`、`KIT_PAYLOAD_DIR`、`KIT_AUTO_UPDATE`、`KIT_AUTO_SYNC`、`KIT_UPDATE_REGISTRY`、`KIT_UPDATE_PIN`、判 CI 的 `CI` / `GITHUB_ACTIONS` / `GITLAB_CI` / `BUILDKITE` / `CIRCLECI` / `TF_BUILD` / `JENKINS_URL`、大小写两种 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`、`NODE_USE_ENV_PROXY`)加 `LC_*` 与 `GIT_*`。**不用 `KIT_*` 通配**(未来新增变量不会自动越界),明确不传 `NODE_OPTIONS`、`NODE_PATH`、`LD_*`、`DYLD_*`。订正理由:被启动的新版本就是用户要运行的 CLI 本身,没有 `PATH` 它的 `git` 调用找不到二进制、没有 `KIT_TMP` / `KIT_STATE_DIR` 它的写出口根就变了、没有代理变量验签联网不通;这些变量用户本来就交给了「当前进程」,而新版本经完整树校验后与当前进程同级。env 来源仍只能经 `io/paths.ts`(`pickProcessEnv`,按 `RUN_SELF_ENV_PICK_RE` 收窄)。后台模式(`background:true`):`detached`、stdio 丢弃、`unref`,立即返回。它是 launcher 专用入口,不是通用二进制放行;`EXEC_ALLOWLIST` 与 `runSync` 的行为不变。
- 冒烟之所以从 `launcher.ts` 导出再由 `commands/update.ts` 注入 `InstallDeps.smoke`:lint 闸只许 `launcher.ts` 引用 `runSelf`,安装器 / 命令层都不直接引用它。

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
