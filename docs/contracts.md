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

### 4.4 测试 harness 的 git 环境卫生

任何起 git 子进程的测试代码(`test/helpers/make-repo.ts` 等,B04/B17)统一:

- 环境变量:`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`HOME=$KIT_TMP/githome`(事先建好的空目录)。
- 每条命令加 `-c user.name=kit-test -c user.email=kit-test@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main`。
- 一律经 `src/io/exec.ts`(默认**不继承 HOME**,上述变量由调用方在 `opts.env` 里显式给),仓库建在 `$KIT_TMP` 下;
  禁止读写真实的全局 git 配置。

### 4.5 Q-N14:golden 不是兼容声明

见 §1 末条。

## 5. 路径与环境约定(io 层)

| 约定                | 落点                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一写出口          | `src/io/safe-fs.ts`;每次写前校验目标(解析 symlink 后)落在 `IoContext.writeRoots` 内,违者 `WriteDeniedError`(`IO_WRITE_DENIED`),CLI 退出 3。拒绝:根外、`..` 逃逸、符号链接逃逸、悬空链接、硬链接(`nlink>1`)、写/删根本身                                                                                                                           |
| 唯一读 HOME/env/cwd | `src/io/paths.ts`(`os.homedir()` / `process.env` / `process.cwd()` 只许出现在这里)                                                                                                                                                                                                                                                                |
| 只读出口            | `src/io/read-fs.ts`(不导出任何写 API;读真实会话目录靠 `--source` 显式传入)                                                                                                                                                                                                                                                                        |
| 唯一子进程          | `src/io/exec.ts`:无 shell;**二进制白名单(P0 只有 `git`)**;env 键白名单 `GIT_*`/`HOME`/`LANG`/`LC_*`/`TZ`,默认只有 `PATH` 加 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`(HOME 缺失时 git 会经 passwd 回退读真实 `~/.gitconfig`,所以默认屏蔽;调用方可覆盖)、**不继承 HOME**;显式传 `HOME` 时其值必须在 `KIT_TMP` 内。加二进制 = 契约变更 |
| 写入根              | 默认 = `<repo>/out/`、`<state>`(默认 `<repo>/.state/`)、`$KIT_TMP`(若设)。`KIT_WRITE_ROOTS`(`path.delimiter` 分隔的绝对路径)**只能收窄**:每项必须落在默认根之内,越界、相对路径、`/`、HOME 及其上级一律 `PathsError`(退出 3)                                                                                                                       |
| state 位置          | P0 只能在仓库内或 `KIT_TMP` 内(`KIT_STATE_DIR` 可改);`~/.local/state/<kit>/` 留到 P2(Q-N13),届时只改 `paths.ts`                                                                                                                                                                                                                                   |
| 相对路径            | 写出口按 **repoRoot** 解析相对路径,不按 cwd                                                                                                                                                                                                                                                                                                       |
| `~`                 | P0 **不展开** `~/.config/<kit>`;覆盖层只经 `--overlay <path>`;`out/<agent>/home/…` 的 `home` 只是路径记号,任何代码不得把它展开成真实 HOME                                                                                                                                                                                                         |
| 复制来源            | `copyFile` 的来源限定在仓库或写入根内,不能把仓库外的内容(如 `~/.ssh`)吸进 `out/`                                                                                                                                                                                                                                                                  |
| 测试临时目录        | `safe-fs.mkdtemp(ctx, ctx.tmpDir ?? <state>/test-tmp, prefix)`;测试不得自己 `import node:fs`                                                                                                                                                                                                                                                      |
| 确定性序列化        | `canonicalJson`(键序、2 空格、LF、末尾换行,拒 undefined/NaN/环/非纯对象)、`canonicalText`(LF,末尾恰一个换行)                                                                                                                                                                                                                                      |

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
- 决策 ②:真实仓库 `kit.toml` 的 `enforce = "warn"`;`block` 只由 fixture 开启;P1 把默认值改为 `block`(documented/probed 目标)。
  **P1 落地(2026-10-09)**:`BudgetConfigSchema.enforce` 缺省改为 `block`(assumed 目标恒只告警的 carve-out 不变,
  故缺省阻断实际只作用于 documented/probed);真实仓库 `kit.toml` 显式保持 `warn`,阈值探针(probe)定稿后再收紧。

- **实现与上述口径的已知偏离(如实记录,B21/B5)**:
  1. 除 `conditional` 非空外,**纯技能/子代理文件**(有 `sourceRefs`、不含规则原子)也**不计入**预算(`countsTowardBudget`):技能/子代理按需加载、不常驻,这是实现里加的口径,各 agent 是否真如此未逐家核实。
  2. 去重公式实现为「目标总字节 = Σ 各处该原子的 `atomBytes` − 其中最大的一份」(同一原子各处字节相同时与上面的 `(k−1)×atomBytes` 等价;不同时实现更保守,即扣得少)。
  3. 预算报告 `targets[].files` 只记文件的 `relPath`(项目链为 `projectChain#i`),不含 `<agent>/<target>/` 前缀:同一目标下 home 与 project 都有 `AGENTS.md` / `CLAUDE.md` 时会出现两个同名项,报告里无法区分是哪一个。
  4. `budgetFailed` 用「诊断里有 error」判断,所以 `enforce=block` 下的 `BUDGET_ATOM_TOO_LARGE`(单原子正文超限,**不看** `limit_source`)也会让 build 退出 1;lint 的 `ATOM_BODY_TOO_LARGE` 通常更早拦下。
- **多维度目标**:逐维度判断(bytes↔`max_bytes`,lines↔`max_lines`),只配了一个维度的目标只看那一维;目标级 `level` = 任一维度 `over` 则 `over`,否则任一维度 `near` 则 `near`,否则 `ok`。
- **Codex 项目链**:`projectChain` 是根→cwd 各层 AGENTS.md 的**文本内容**数组,字节数按 UTF-8 计后与托管块产物相加。

A2 的 12 格矩阵(`limit_source` × `enforce` × 超/不超;退出码 / 是否出告警):

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

「不超」指 level 为 `ok`;处于 `near` 时同样无阻断,但出一条 `warn` 级的 `BUDGET_NEAR_LIMIT`(提示一进一出)。

## 7. 命令面(`src/cli.ts` 注册表;命令桩的形状)

| 命令                                          | 阶段   | 文件                              | 备注                                                                  |
| --------------------------------------------- | ------ | --------------------------------- | --------------------------------------------------------------------- |
| `build`                                       | P0     | `src/commands/build.ts`           | 合并+渲染到 `out/`;**B01 之后无块的边界覆盖它**,由 B19 接线           |
| `check`                                       | P0     | `src/commands/check.ts`           | 组合 `lint-cmd.ts`(B03)、`check-budget.ts`(B05)、`guards-cmd.ts`(B04) |
| `redact`                                      | P0     | `src/commands/redact-cmd.ts`      | `--selftest` / `--stdin`(B09)                                         |
| `signals collect`                             | P0     | `src/commands/signals-collect.ts` | `--source <路径> --dry`(B10b)                                         |
| `inventory`                                   | P1(桩) | `src/commands/inventory.ts`       | 见 §4.1                                                               |
| `probe` `reflect` `attest` `promote` `retire` | P1     | 各一个文件                        | 桩                                                                    |
| `sync` `doctor`                               | P2     | 各一个文件                        | 桩                                                                    |

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
12. **阈值探针写回结构(plan-P0 §7)**:`BudgetTarget` 增加可选 `probed_value` / `probed_agent_version` / `probed_at`;`limit_source=probed` 时三者必填。
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

- **GD-1(边)**:`merge` 不看声明者的 status,`disables`/`overrides` 一合入就生效。守卫层的处置(`src/merge/**` 不在本块范围):G1 拒绝**新增**原子声明非空 `disables`/`overrides`(`GUARD_G1_NEW_ATOM_HAS_EDGES`);G2 拒绝**已有**原子对这两个字段的任何增、删、改(`GUARD_G2_FIELD_LOCKED`;删边会让被压掉的原子复活);`kit:retire` 不放开(退役靠改 status 即可)。**后果**:P0 里新边只能在守卫之外由人引入。**根治(待主代理)**:`src/merge/merge.ts` 只采纳 status 为 active/advisory 的声明者发出的边。另注意:retired/proposed 原子身上的存量边仍然生效,删掉持边原子会让目标恢复,这一步只受 G4 约束。
- **GD-2(治理字段)**:内容 PR 不得改已有原子的 `status`、`id`、`layer`、`strength`、`applies_to`、`paths`、`overrides`、`disables`,`review_by` 不得延长或改写(只允许提前)。`id` 被锁是因为边按 id 解析;要改这些字段,新建新 id 的原子并走退役。例外:基线 status 仍是 `proposed`(尚未生效)的原子可以改 `id/layer/strength/applies_to/paths`,否则写错的 proposed 原子既改不了也删不掉;`overrides/disables` 不论状态一律锁定(缺省与 `[]` 视为相同)。`owner`/`volatility` 不锁。**策略层说明**:内容 PR 仍可改 active 原子的正文、`verifier`、`evidence`、`signature`——守卫不约束正文,这是已接受的策略选择,靠人工评审。
- **GD-3(stable tag)**:只认**注解** `stable-*` tag,且其提交须是基线的**严格**祖先(指向基线本身的不算)。**已知缺口**:没有签名/创建者校验(tagger 可伪造,CODEOWNERS 的 handle 与 tagger 邮箱也无映射,故不做该匹配);任何能在本地打注解 tag 的人都能在基线祖先上补 tag。**P1 CI 必须使用服务端受保护 tag 或 `verify-tag` 验签,不得信任仓库内可写的 tag。**
- 发版说明:仓库里存量的轻量 `stable-*` tag 现在被忽略,原本能通过的删除会变红(收紧方向)。
- GD-4(`.kit/rules/` 子模块被 lint 读到而守卫看不到)、GD-5(merge-base 契约未强制,只会假阳性)、GD-6(晋升 PR 不能同时补 `signature`,须先走内容 PR 补)延后;GD-6 的两步流程以此处为准。

## 13. reader 已知差异(B21 记录;口径正文见 `docs/reader-counting-spec.md` §8.3)

- **agent_version 形状(R1)**:只接受版本号形状(`X.Y.Z[-+后缀]`,总长 ≤ 64);其余值当取不到,走 `collector_fallback`。四家共用基类校验。
- **R8**:Claude reader 取 `version` 时跳过侧链行,§7.5 探针不跳过;首个带 `version` 的行恰是内联侧链行时两边版本可能不同。已知差异,未改。
- **单行硬上限 64 MiB(R3)**:超限的行记 `oversized_lines` 与 `unknown_event_types["<line-too-large>"]`,不使整个会话失败。
- **空白/BOM(R2)**:每一行按 jq 的空白集判空白、去行首一个 BOM(详见口径 C2 补充)。
