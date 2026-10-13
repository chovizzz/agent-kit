# P1 待办与排期

> 依据:`docs/release-checklist.md` §4(不在 P0 的)、`docs/reader-counting-spec.md` §8.1(D1–D6 待设计者定)、
> `docs/contracts.md` 决策 ②/§11、`docs/redaction.md` §3.2/§7 残余缺口。
> 状态标记:☐ 未开始 | ◐ 进行中 | ✅ 完成 | ⏸ 等外部(凭据/决策/时机)。

## Phase P0-close(前置,不属 P1 但挡 tag)

- ✅ A6-pi 基线刷新(2026-10-11:pi 样本追平 1844 行;另一个 claude 样本被自动清理,按选样规则换第 5 个;A6 60/60):等本会话静默 ≥60 分钟,按 `ops/accept-p0.sh --only A6` 的报错行数更新
  `inventory/reader-samples.txt` 第 5 个 pi 条目(基线追平真实文件的合法增长,断言本身不变),重跑 A6 转 PASS
- ✅ 全量 `ops/accept-p0.sh` 15/15(2026-10-11,A13 标记绑定 593ebc7)→ tag `p0-accept` → 按 `release-checklist.md` §3 核对 → 打 tag `p0-accept`

## Phase P1-A(契约已写死的低成本项,可立即开工)

- ✅ **决策 ②:预算 `enforce` 默认收紧**(`358f968`)——`documented`/`probed` 目标默认 `block`(assumed 仍恒 warn);
  kit.toml 注释、`src/budget`、`test/budget`、contracts 决策 ② 同步。fixture 矩阵(A2)需加 block 默认格
- ✅ **D2:`agent_version` 的 `unknown` 入契约**(`1c09d06`)——`AgentVersionSourceSchema` 加 `unknown`(spec §8.1 D2 备选),
  消除 `collector_fallback` 的双词口径;reader/oracle/schema/test 五处同步
- ◐ **脱敏 §7 残余缺口清理**:键名词表族已收(`c3034d0`:db_pass/passcode/requirepass/中文键名);
  其余族(多行 heredoc/三引号、模板默认值链、`cred_*` pass2 残留探测器、对抗评审清单)待逐族排块

## Phase P1-B(设计决策 + 实现,按依赖序)

- ✅ **D1 适用性标记**(契约变更):`CollectReport` 加 `tool_failures_scope: "full" | "codex_pre_0149_limited"`
  (推荐 spec 方案 A);codex reader 按会话内是否出现 `CommandExecution` 判定;oracle 与 A6 Codex 部分同步
- ✅ **D3 `maxEventBytes` 定值**:按 spec C8 本机实测(最大单行 4.0MB)定默认值;`oversized_lines` 口径验证
- ◐ **D4 跨文件去重**:决策已定(attest 聚合层去重;Signal 加可选加盐 `event_key`;实现随 P1-C attest 块)
- ✅ **D5/D6**:owner 拍板维持现行口径 A(全条目 + branch_count;两类边界行均计用户消息),spec 已记录

## Phase P1-C(新功能主体)

- ✅ **探针 `probe`**(`d12a32a`):干跑测量 + `--write` 产 kit.toml 补丁(不落盘);
  documented 不改写、缺版本 USAGE 拒绝;pendingProbes 只列不断言。有效性探针(跑真实 agent 观察 P-Q*)仍待主代理真实环境项
- ✅ **反思器 `reflect` + 裁判 `judge`**(实现:stub 验证;**真实后端未验证**——所有 CLI 参数集仍是 `verified:false`,
  默认拒绝真跑,需覆盖层 `allow_unverified` 显式放行,R6 实测前不要在真实数据上跑):`Proposal.reflector.vendor` 必填、
  `judge.vendor ≠ reflector.vendor`、`skipped:same-vendor` 记账(contracts #18);含外部内容的会话只进结构化计数(#8);
  命令面与退出码见 contracts §17;验收 `ops/accept-p1.sh`(A16–A20)。
- ☐ **`attest` / `promote` / `retire`**:按 contracts §对应节;依赖 reflect。
  **注意**:G3 判据(`promote`)不能信任 judge 的 `injection_suspected=false`——要在本地对提案/原子文本再跑一遍
  reflect 的话术检测(`scanDangerousPhrases` + 不可见字符),judge 的结论只作输入,不作放行依据

## Phase P1-C 之后的待办(R5 汇报时登记)

- ☐ **R6 真实环境 spike**(主代理、需用户当场同意):①各 CLI 的无工具 / 无会话 / 无上下文参数逐项核实
  (`claude`/`codex`/`pi` 的 `claims` 全是 `claimed`/`unresolved`);②`llm-exec` 的固定 cwd 在仓库 git 树内
  (`<repo>/.state/reflect/cwd`),CLI 向上找项目根时可能读到仓库的 CLAUDE.md / AGENTS.md / `.claude/settings.json`
  (contracts §16①),需实测或允许 `KIT_STATE_DIR` 指向仓库外;③每个 CLI 真跑实际写了哪些全局文件(会话日志、history),列清单
- ☐ **暂存区过期 / gc**:`.state/reflect/<run_id>/` 现在只增不减(`loadUsedProposalIds` / `loadStagedAtoms` 会随之变慢,
  且已用编号永不释放);需要 `reflect --gc` 或过期策略,并保证不删还在被 judge / 人工 apply 使用的 run
- ☐ **契约层不可见字符补全**:`HIDDEN_CHARS_RE` 漏 Unicode tag 字符(U+E0000 段)、bidi U+061C(ALM)、变体选择符
  (U+FE00–FE0F、U+E0100 段)、Hangul 填充(U+3164、U+115F/1160、U+FFA0)等;`hidden_chars_in_output` 目前只是纵深防御
  (A16 里没有夹具能走到它,因为 schema 的零宽检查先拦下)
- ☐ **reader 原型键问题**:事件类型名为 `constructor` / `__proto__` / `toString` 时,按普通对象做计数键会碰到原型链
  (`unknown_event_types` 之类);reader 与 `safeKey` 要改用 `Object.create(null)` / `Map` 或前缀转义,并加用例
- ☐ **单厂商时 `no_cross_vendor` 退出 0 的提示**:`judge` 在只有同厂商 / 未配置时退出 0(决策 ⑩A),且「未配置」与「单厂商」
  都落成 `no_cross_vendor`,用户看不出是配置问题;需要在 stdout/stderr 区分(`not_configured` vs `same_vendor_only`),
  并考虑 `--strict` 退出 4
- ☐ **`LlmBackend` 扩 `cli` / `provider` 字段**:现在命令层要靠覆盖层反查 `backendCli`(只能对默认接线做到,
  注入的后端拿不到);扩接口后 `reflector.backend` 才能从后端自己拿
- ☐ **CI 校验**:要求 `reflector.backend` 必填(CI 才能用 provider/model 重算 `deriveVendor`),并拒收 `reflector.stub: true`
  的提案(contracts #24)
- ☐ **`IoContext.hostEnv`**:命令层不能读 `process.env`(eslint:只许 `src/io/paths.js`),真实 CLI 路径下 `reflect`/`judge`
  只能用 `IoContext.execPath`(= PATH)和 `getRealHome()` 拼子进程环境;应由 `paths.ts` 提供受控的 `hostEnv`
  (contracts §12.4 ④),并把 `CommandContext.env` 正式加进 `src/commands/types.ts`(目前经 `EnvCommandContext` 交叉类型传入)
- ☐ **`team_project_keys` 填什么**:值是信号里的 `project_key`(加盐哈希 `p_…`),但 CLI 没有任何地方把它列给用户;
  `reflect` 干跑(或 `signals collect --dry`)应列出各 `project_key` 的会话数/信号数(只有 id 与计数),用户才填得出白名单
- ☐ **A20 在共用工作树里原地变异**:同一棵树里别的进程(build / test)会读到变异后的源码;更稳的做法是在临时 worktree 里做变异。
  现已缓解:不恢复 mtime(变异窗口内构建的 dist 会被 `freshDist` 判陈旧)、结束后自动重建 dist、SIGINT/SIGTERM 先还原、
  `--write-marker` 要求工作树干净、遗留 `.mut-bak` 时拒绝继续;SIGKILL 仍可能留下变异源码(靠 `.mut-bak` 检测发现)
- ☐ **R2 接口**:`runReflect` 的 `personalProjectKeys` 是黑名单,命令层靠补集代理对象把白名单 `team_project_keys` 接进去
  (只支持 `has()`);R2 应直接提供 `teamProjectKeys` 白名单参数
- ☐ **`kit:reflector` 标签不禁止修改既有文件**:A17 的 N1 钉住了现状——反思器 PR 改已有 active 原子的**正文**不被
  路径守卫 / G1 / G2 拒(G2 只锁治理字段,契约 GD-2 已接受);`reflect` 自己只产生新增文件,但 CI 侧对 `kit:reflector`
  应加「只许新增」判据
- ☐ **`sync` 写全局 + `doctor`**(P2 表内但同批):真实 HOME 受管路径写入,依赖 B17 守卫面

## Phase P1-D(发布与治理,⏸ 等用户凭据/授权)

- ◐ **npm 发布**:包定名 `@chovizzz/agent-kit@0.1.0`,`scripts/check-publish.mjs` 自检 + `.github/workflows/release.yml`(tag `v*` 触发,`npm publish --provenance`,用 `secrets.NPM_TOKEN`);
  **待办:①在 GitHub 仓库加 `NPM_TOKEN` secret(npm token 须对 `@chovizzz` scope 有发布权;`chovizzz` 若还不是 npm org 需先建);②确认 CI 全绿;③推 tag `v0.1.0` 触发首发**
- ⏸ **远端分支保护 + CODEOWNERS**:需要 repo admin(geoly/chovizzz 两远端的策略要分别定)
- ⏸ **签名提交**:需要本机签名密钥决策(ssh 签名可用现有 ssh-key,`git config gpg.format ssh` + GitHub 上传公钥)
- ◐ CI 观察:`.github/workflows/ci.yml` 在 origin 的红点——已定位两处真红(见下),现验证中
  - probe 那两次失败:`format:check`(已提交的 probe.ts/check-budget.ts/contracts.md 未过 prettier;`b312e95` 修复)
  - 教训:门禁用 `pnpm run x >/dev/null 2>&1 && echo ok` 或 `pnpm run x | tail -1` 会被管道吞掉退出码——**必须单独跑并读退出码**

## 已定:`KIT_TMP` 是 `out/` 上级时不收紧

2026-10-12 用户决定「不收紧」。现有测试和验收脚本合法地把仓库建在 `KIT_TMP` 之下,收紧会让它们变红;写入范围由 `findWriteRootEscape`(realpath + 身份比较)兜住逃逸。残余:校验与 fs 调用之间的竞态(需要 `O_NOFOLLOW`/`openat`),已写进 contracts。

## A7 基线刷新(已做:`ops/inventory-refresh.mjs`)

`inventory/commands.sh` 的期望值是某个时点的快照;用户的个人文件(`~/.claude/CLAUDE.md`、hook 脚本等)变化后 A7 会红,这不是代码回归(2026-10-12 的 B15-001/002/003/004/005/009/010/011/012/049 就是这么来的)。刷新流程把「重测 → 改期望值与时点 → 同步 md 里引用它们的数值」做成一个工具,不要手改期望值:

```sh
ops/inventory-refresh.sh                 # dry-run(默认,完全只读):旧值 -> 新值、引用它们的 md 行、将要做的 md 修改、需人工核对的位置
ops/inventory-refresh.sh --apply         # 写 inventory/**(先备份到仓库外临时目录),再自动重跑 A7
```

- 退出码:0=无需刷新(dry-run)或已刷新且 A7 通过(apply);1=dry-run 有差异、或 apply 后 A7 仍红、或改写后复验不一致(此时不写);2=用法错;3=清单被拒(格式 / 只读检查 / inventory 里有符号链接或多重硬链接);4=有命令未执行(输入缺失、命令非零退出;不写任何文件);5=有「需人工核对」项(apply 时安全部分已写入)。文档与期望值不一致但没有任何编号变化时 dry-run 也退出 5。
- commands.sh:只改值变了的行的第 3、4 列;重测一致的精确型行只记新时点;只增项(`>=N`)只在新值小于 N 时才下调(同时列为需人工),否则连时点都不动。
- md 只改能无歧义绑定的位置:`<值> [#编号]`(整数、整哈希、`L1=1, L2=5` 这类 k=v)、表格行里标注格无值时同行唯一的整数格、表头带标注的有序列表列(含序言段的 `0` 首项)、逐行各一个标注的有序列表(如每个 hook 的字节数)、由行数列推出的「起止行」。改之前先核对文档现值等于旧期望值(不等 = 文档早已漂移,不覆盖)。改表格单元格时保持列宽。
- 不自动改、列入「需人工核对」:文字型期望值(路径、事件名)及由它们推出的计数;8 位短哈希这类标识列;列表长度与表格行数对不上;旧值仍残留在别处的行(推导句、结论句);含只增项的文件里的「时点」行。命令输出含竖线/反引号/`[#`/`>=` 开头时也不写入。**文本型新值(路径、事件名,以及任何与旧值形状不同的输出)一律不自动写入、也不打印**,只给长度和 sha256 前 8 位 —— 命令输出可能含个人文件内容。同表按行配对的几个编号同时变了(例如 hook 换序)时,逐行数值不自动同步。
- apply 后另需自己做的事:`.state/inventory/*` 旁路文件(如各节边界表)不会被重生成;`pnpm exec prettier --check inventory` 应仍绿,不绿就 `prettier --write` 那几个 md。
- 已知局限(A7 本身,未改):B15-020/021/047 这类命令在值为 0 或最后一次比较为假时会因 pipefail 以非零退出,A7 与本工具都会把它们当作「未执行(4)」;遇到时要改命令而不是改期望值。

## 已知偶发红(待复测)

- `test/build/determinism.test.ts`、`test/build/write.test.ts` 在机器重载时偶发红(build 退出 1、或 out/ 缺文件):2026-10-11 夜里 A12 在干净克隆里连红两次后转绿;重载循环 1/6 复现一次,基线 ac816ef 与 39a4ffd 各 12 次均 0 红。未查到根因,怀疑是负载下的时间预算(单位:CHECK_FAILED=1)。**脱敏缺口块收尾、机器空闲后在干净克隆里重测;复现时先抓 build 的 stdout 诊断再下结论**。同时发现:多个 vitest 进程同时跑同一仓库会互相踩 `.state/`(`test/signals/collect.test.ts` 红),并行验收时不要在同一树里开多个 vitest。

## 排期建议(串行优先,避免同文件并行)

1. **P0-close**(等时机)→ 2. **P1-A** 三件(本仓内,无外部依赖)→ 3. **P1-B** 按 D1→D3→D4→D5/D6
   → 4. **P1-C** probe → reflect → attest/promote/retire → sync/doctor → 5. **P1-D** 随凭据到位随时插入。

> 每块沿用 P0 纪律:块边界不动 `docs/block-boundaries.md` 之外的文件;全量门禁 + A1–A15 逐块回跑;
> 契约变更必须同步 contracts.md 编号条款与 oracle,不得只改实现。
