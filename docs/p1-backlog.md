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
  kit.toml 注释、`src/budget`、`test/budget`、contracts 决策 ② 同步。
  **收口(PB3,2026-10-22)**:A2 矩阵扩到 15 格(加三种来源「不写 enforce」超限格),A2 改为断言 `kit.toml` 的 `enforce = "block"`,真实 `kit.toml` 已翻成 block(契约 §6、§17.5「A2 语义订正」)
- ✅ **D2:`agent_version` 的 `unknown` 入契约**(`1c09d06`)——`AgentVersionSourceSchema` 加 `unknown`(spec §8.1 D2 备选),
  消除 `collector_fallback` 的双词口径;reader/oracle/schema/test 五处同步
- ✅(主体)**脱敏 §7 残余缺口清理**:键名词表族(`c3034d0`:db_pass/passcode/requirepass/中文键名)、多行三引号 / YAML 块标量 /
  shell heredoc、模板默认值链、`probe_cred` pass2 探测器均已收(P1-A.3,用户 D3 定:声明主体完成)。
  剩余缺口登记为 `known_gap` 种子(只报告、修好时测试变红提醒晋升):`gap.triple_escaped_quotes` `gap.yaml_anchor_block`
  `gap.yaml_anchor_inline` `gap.yaml_tag` `gap.template_default_call` `gap.helm_default_func` `gap.hcl_variable_default`
  `gap.hcl_ternary_default` `gap.long_segment_concat` `gap.md_inline_code_split` `gap.backtick_leading_space` `gap.placeholder_then_space_value`
  `gap.upper_dollar_name` `gap.upper_getenv_default` `gap.upper_env_or_default`(详见 `docs/redaction.md` §7)

## Phase P1-B(设计决策 + 实现,按依赖序)

- ✅ **D1 适用性标记**(契约变更):`CollectReport` 加 `tool_failures_scope: "full" | "codex_pre_0149_limited"`
  (推荐 spec 方案 A);codex reader 按会话内是否出现 `CommandExecution` 判定;oracle 与 A6 Codex 部分同步
- ✅ **D3 `maxEventBytes` 定值**:按 spec C8 本机实测(最大单行 4.0MB)定默认值;`oversized_lines` 口径验证
- ✅ **D4 跨文件去重**:attest 聚合层去重,Signal 加可选 `event_key`(L5 实装;键的来源见下节遗留项⑤)
- ✅ **D5/D6**:owner 拍板维持现行口径 A(全条目 + branch_count;两类边界行均计用户消息),spec 已记录

## Phase P1-C(新功能主体)

- ✅ **探针 `probe`**(`d12a32a`):干跑测量 + `--write` 产 kit.toml 补丁(不落盘);
  documented 不改写、缺版本 USAGE 拒绝;pendingProbes 只列不断言。有效性探针(跑真实 agent 观察 P-Q*)仍待主代理真实环境项。
  **2026-10-22 收口(PB1–PB5)**:干跑行尾换行、量得 0 不出补丁、补丁 schema 自校验(`PROBE_PATCH_INVALID`,退出 3)、严格参数(未知 flag / 缺值 / 未启用 agent / 非法或重复版本退出 2);
  `--write` 必须带 `--observed <agent>=<N>`,`probed_value` 写**外部观测值**(不是 kit 产物大小),原 `max_*` 大于观测值整批拒绝(`PROBE_LIMIT_ABOVE_OBSERVED`);
  双维度目标用 `bytes:N,lines:M`(混用 `PROBE_OBSERVED_DIM_MISMATCH`),两个维度各自比较,并同时落盘 `probed_value` 与可选 `probed_lines`(仅 `probed` 且有 `max_lines` 时允许);契约 §8 #12。
  遗留:显式 `--agent codex` 但没配 `[budget.codex]` 时静默输出 0(未处理)。发版说明须写明:新版双维度补丁粘进旧版 CLI 会被 `strictObject` 拒绝
- ✅ **反思器 `reflect` + 裁判 `judge`**(实现:stub 验证;**真实后端未验证**——所有 CLI 参数集仍是 `verified:false`,
  默认拒绝真跑,需覆盖层 `allow_unverified` 显式放行,R6 实测前不要在真实数据上跑):`Proposal.reflector.vendor` 必填、
  `judge.vendor ≠ reflector.vendor`、`skipped:same-vendor` 记账(contracts #18);含外部内容的会话只进结构化计数(#8);
  命令面与退出码见 contracts §17;验收 `ops/accept-p1.sh`(A16–A20;生命周期部分 A21–A24 见下)。
- ✅ **`attest` / `promote` / `retire`**(L0–L7,2026-10-13):三条命令全部实装,命令面 / 退出码 / 稳定码见 contracts §18;
  纯本地零网络、默认干跑、`--write` 只写 `.state/<命令>/`;G3 真判据(`lifecycleCriteria`,T1–T6)、采纳检查 C1–C9
  (`src/lifecycle/checks.ts`,采纳 / 晋升 / CI 共用)、`lifecycle/` 只增目录兼作 id 墓碑、`proposed→retired` 被否决提案出口均已落地。
  验收 A21–A24(`ops/accept-p1.sh`;A24 为人工完成项,标记 `.state/accept/a24.done` 绑 HEAD,清单 `ops/accept/a24-mutation.md`);
  A5 的命令清单已含三条命令(合成仓库上的干跑)。
  G3 判据不信任 judge 的 `injection_suspected=false`:本地重扫话术与不可见字符(C1 / C1b),judge 结论只作输入。
  **遗留项见下节「attest / promote / retire 遗留项」。**

## attest / promote / retire 遗留项(L7 登记)

- ✅ ① **反思器危险话术检测的极性豁免已收窄**(`src/reflect/validate.ts` 的 `scanDangerousPhrases`;夹具 `test/reflect/validate-polarity.test.ts`):
  旧逻辑只要话术**之前**同一子句里有任何否定词就放行,攻击者撒一个否定词即可绕过 reflect 本地校验与 C1 重扫。
  新规则:取话术前**最近的**否定词,二者之间的间隔必须**全部**由修饰同一动作的轻量填充词组成(使用/运行/执行/添加/直接/the/use/run/git、有限的「在 提交/CI/生产… 时」场景短语,
  反引号与引号不算内容)且 ≤ 24 字符;间隔里有连词、别的动词、祈使词、名词即按未否定处理(fail-closed)。另有三条收紧:命中文本内部含转折/并列/祈使词(「push … 但请 … --force」)
  或命中后紧跟「以外 / 之外 / except」(否定的是补集)时不算否定;同一规则多次命中**每一次**都要被否定才算护栏提及;
  压缩形(`no_verify`)出现次数多于正常形命中次数时按未否定拦,不再被旁边一处合法护栏写法抵消。
  已知仍会误杀的合法写法:间隔里有未列入填充表的词(「不要使用 --no-verify 或 --no-gpg-sign」的第二项、「请勿再直接使用」之外的口语);误杀只会让提案被拒或 C1 红灯,不会放行。
  已知仍可能放行的形态:否定词后的间隔恰好全是填充词、但语义被后文翻转的写法(如「不要 X,否则…」类需靠整批其它话术表兜住);本规则不做语义理解
  **K6 极性核查(启用 `auto_sync=safe` 的前置,已完成)**:`blocked` 非空 = 不放行;五个调用点(`reflect/validate.ts` 整批拒、`lifecycle/checks.ts` C1、`lifecycle/adopt.ts` 补丁复扫、`guards/criteria.ts` `rescan`、`sync/safe.ts` 自动同步)都以 `blocked.length > 0` 拒绝,
  没有把「检测失败 / 异常 / 空结果」当放行的路径:扫描抛异常在 C1 → `CHECK_INTERNAL_ERROR`,在 `runAutoSync` → 外层 `catch` 记 `failed`(不写);`sync/safe.ts` 对内容缺失(`undefined`)按 `rescan_dirty` 拒;空串没有载荷,返回空 blocked 是预期。
  回归钉:`test/reflect/validate-polarity.test.ts` 末尾 `fail-closed 极性钉`。
- ✅ ② **`SAFE_PATH_RE` 在 `src/reflect/stage.ts` 与 `src/lifecycle/checks.ts` 各复刻一份**:应从 stage.ts 导出、checks.ts 引用,去掉重复(两处改一处就会分叉)
- ☐ ③ **retire 靠 L2 诊断文案挑 `attest_digests`**:`lifecycle/retire.ts` 对每个候选单独探测、按判据返回的诊断剔除无效项;
  应由 `src/guards/criteria.ts` 导出「计入口径的有效 attest 集合」纯函数,或给「digest 无效」单独稳定码,不要靠文案
- ☐ ④ **`harmful` / `recurrence` 在真实信号库里恒为 0**:信号流水线没有纠正 / 回滚类信号,所以 `harmful` 判据(`THRESHOLD_HARMFUL`、`harmful` 退役理由)
  现在只在合成数据上可达;要等信号流水线开始产出这类信号
- ☐ ⑤ **`event_key` 是历史链哈希**:`NormEvent` 没有源事件 id,现在的键是 `sha256(salt ‖ agent ‖ chain)`,`chain' = sha256(chain ‖ ts ‖ kind ‖ toolName ‖ 文本哈希)`
  (`src/signals/pipeline.ts`);reader 带上源事件 id 后应换成「加盐源 id」(D4 的原意),并保持对旧键的兼容
- ☐ ⑥ **`retire` 的 `run_id` 是确定性的**(同输入同记录,为幂等):若要真随机的 run_id,就得放弃 `RETIRE_RUN_EXISTS` 的幂等判定;当前取舍是保幂等
- ☐ ⑦ **无签名的 advisory 原子要两步晋升**:先走内容 PR 补 `signature` 并重跑 judge(`rule_sha256` 会变),再 `promote --to active`;命令只给 `SIGNATURE_MISSING` 与提示,不自动化
- ☐ ⑧ **org 层现有 3 个原子没有 `origin=proposal`,不能走晋升**(`ORG_LAYER_NOT_PROMOTABLE`);它们的状态变更需要另一条路径(或给它们补提案出身),否则永远是 proposed
- ☐ ⑨ **`promote --run` 里 personal + team 混合的退出码语义**:现在 team 提案照常写出、整体退 2;是否改为「整批不写」待定
- ✅ ⑩ **`test/ops/inventory-refresh.test.ts` 在全量高负载下总是超时红、单跑绿**(单跑约 30s):应加大该用例的超时(已改:用 `SLOW_TEST_TIMEOUT_MS`,见 vitest.config.ts)
- ☐ ⑪ **T2 的 `review_by` 受 lint 上限约束**:`promote --to active` 的新 `review_by` = `min(今天 + 90/30, created + 180/30)`,老原子(created 很久以前)可能 `REVIEW_BY_UNREACHABLE`;
  需要一条「复审后延期」的合法路径(改 lint 上限的语义,或允许 `review_by` 随复审重置)
- ☐ ⑫ **P1-D:四眼 / 受保护 tag / 签名缺口(GD-3)**:PR 作者 ≠ 审批人只能靠远端分支保护 + CODEOWNERS;stable tag 本地可伪造(`COOLDOWN_NOT_MET` 与 G4 都依赖它);
  attest / judge / lifecycle 文件无签名;窗口日期、`recorded_at`、「转为 advisory 的日期」(取提交者日期)都是作者可写数据。三条命令在 P1-D 落地前不能提供硬的权限边界

## Phase P1-C 之后的待办(R5 汇报时登记)

- ☐ **R6 真实环境 spike**(主代理、需用户当场同意):①各 CLI 的无工具 / 无会话 / 无上下文参数逐项核实
  (`claude`/`codex`/`pi` 的 `claims` 全是 `claimed`/`unresolved`);②`llm-exec` 的固定 cwd 在仓库 git 树内
  (`<repo>/.state/reflect/cwd`),CLI 向上找项目根时可能读到仓库的 CLAUDE.md / AGENTS.md / `.claude/settings.json`
  (contracts §16①),需实测或允许 `KIT_STATE_DIR` 指向仓库外;③每个 CLI 真跑实际写了哪些全局文件(会话日志、history),列清单
- ✅ **暂存区过期 / gc**(S10-rc5,D6):`reflect --gc`(默认干跑,`--write` 才删)只清「已过期(30 天)且无引用、目录仅含 `report.json`」的 run,fail-closed,不改变 `loadUsedProposalIds`(契约 §17.7)。**遗留**:含暂存提案的 run 不回收(需先设计「已 apply 的 run」判据或编号高水位记录)
- ✅ **契约层 FE0F**(2026-10-22 用户定:保持现状,无代码改动)——`reflect.ts` 拦 U+FE0F(⚠️/❤️ 这类 emoji 呈现序列会被拒),`lifecycle.ts` 的 `note` 为避免旧记录解析失败刻意放行 FE0F,两处语义不统一是有意的
- ✅ **契约层不可见字符补全**:`HIDDEN_CHARS_RE` 漏 Unicode tag 字符(U+E0000 段)、bidi U+061C(ALM)、变体选择符
  (U+FE00–FE0F、U+E0100 段)、Hangul 填充(U+3164、U+115F/1160、U+FFA0)等;`hidden_chars_in_output` 目前只是纵深防御
  (A16 里没有夹具能走到它,因为 schema 的零宽检查先拦下)
- ✅ **reader 原型键问题**:事件类型名为 `constructor` / `__proto__` / `toString` 时,按普通对象做计数键会碰到原型链
  (`unknown_event_types` 之类);reader 与 `safeKey` 要改用 `Object.create(null)` / `Map` 或前缀转义,并加用例
- ✅ **单厂商时 `no_cross_vendor` 退出 0 的提示**(2026-10-22 用户定 D4):拆成 `JUDGE_NOT_CONFIGURED`(`not_configured`)与
  `JUDGE_SAME_VENDOR_ONLY`(`same_vendor_only`),默认仍退出 0(决策 ⑩A),新增 `--strict` 时退出 4;契约见 contracts §17.1/§17.2
- ✅ **`LlmBackend` 扩 `cli` / `provider` 字段**(S10-rc2):后端自己暴露 `cli`/`provider`,`reflector.backend` 与 judge 的厂商判定从后端取,
  覆盖层反查 `backendCli` 已移除;缺字段 / `stub` 标记 fail-closed。契约见 contracts §17.4a
- ✅ **CI 校验**(S10-rc6):`kit:reflector` PR 新增的提案要求 `reflector.backend` 必填(`GUARD_PROPOSAL_BACKEND_MISSING`),拒收 `reflector.stub: true`
  (`GUARD_PROPOSAL_STUB`,contracts #24),读不出 fail-closed(`GUARD_PROPOSAL_UNPARSEABLE`),见 contracts §12.3
- ✅ **`IoContext.hostEnv`**(S10-rc7):`paths.ts` 提供受控的 `hostEnv`(`HOST_ENV_NAMES` + `LC_*` 的冻结副本,PATH/HOME 有缺省),
  `reflect`/`judge` 在没有注入 `ctx.env` 时取它;`CommandContext.env` 已正式加进 `src/commands/types.ts`,`EnvCommandContext` 已移除。
  契约见 contracts §12.4 ④;测试 `test/io/llm-exec-host-env.test.ts`
- ✅ **`team_project_keys` 填什么**(S10-rc34,用户定 D5):`reflect` 干跑在 `--json` 里新增可选键 `project_key_counts`、文本输出新增一段,
  列出各 `project_key`(加盐哈希)的会话数/信号数(只有 id 与计数);契约见 contracts §17.1。`signals collect --dry` 因盐可能是临时盐而不加。
  小计数 k-匿名/合并显示:契约无规定,未设阈值,待主代理定夺
- ☐ **A20 / A24 在共用工作树里原地变异**(A24 同构:cp 备份 + cp 还原,还原后恢复 mtime,变异窗口里不构建 dist):同一棵树里别的进程(build / test)会读到变异后的源码;更稳的做法是在临时 worktree 里做变异。
  现已缓解:不恢复 mtime(变异窗口内构建的 dist 会被 `freshDist` 判陈旧)、结束后自动重建 dist、SIGINT/SIGTERM 先还原、
  `--write-marker` 要求工作树干净、遗留 `.mut-bak` 时拒绝继续;SIGKILL 仍可能留下变异源码(靠 `.mut-bak` 检测发现)
- ✅ **R2 接口**(S10-rc34,用户定 D5):`runReflect` 直接提供 `teamProjectKeys` 白名单参数(名单外一律 personal、空集全 personal、未知 key 无害),
  删除命令层补集代理 `personalKeysFromTeamWhitelist` 与黑名单 `personalProjectKeys`;契约见 contracts #29
- ✅ **库级缺省语义**(S10-fc,用户定:默认 fail-closed):`runReflect` 不传 `teamProjectKeys` = 空白名单 = 全部按 personal(原为「不设限」);`MergeInput.teamProjectKeys` / `decideLayer` 的 `team` 改必填,测试夹具显式传 `allTeamKeys(...)`;命令层行为不变;契约见 contracts #29
- ✅ **`kit:reflector` 标签不禁止修改既有文件**(S10-rc6,用户定 D7):`rules/` `skills/` `cases/` 同 `proposals/**` 一样「只许新增」:
  修改 → `GUARD_PATH_EXISTING_MODIFIED`,删除 / 重命名旧路径 / 换成非普通文件 → `GUARD_PATH_EXISTING_DELETED`(contracts §12.3);A17 的 N1 已改钉新语义(被拒)。
  只作用于带 `kit:reflector` 标签的 PR,无标签内容 PR 行为不变
- ☑ **`sync` 写全局 + `doctor`**(已实装:S4 / S5,契约见 contracts §19.2 / §19.3)(P2 表内但同批):真实 HOME 受管路径写入,依赖 B17 守卫面

## S10 系列收口(2026-10-22)

- ✅ **S10-a(D14)**:`sync --write` 在拿锁并重新规划(replan)且计划 ok 后,把 kit 状态目录(`.local/state/agent-kit`)自动收紧到 0700;只动这一层,走 home-fs 守卫(HOME 身份、逐段 lstat、`O_NOFOLLOW`、dev:ino 复核);
  干跑只在 stderr 报 `would_tighten`,失败稳定码 `SYNC_STATE_DIR_SKIPPED reason=link_or_not_dir|foreign_owner`。refuse-all(3)/ not-run(4)不收紧,退出 1 的部分执行照常收紧。
- ✅ **S10-b**:A26 与 D07 各自准备并隔离载荷状态(`noPayload` 用 `KIT_TMP` 内空假包根)。
- ✅ **S10-c**:A20/A24/A28 变异判据精确标题化(`judgeMutationRed`)。
- ☐ S10-a 遗留(小):①干跑在计划被 refuse-all 时仍报 `would_tighten`(只改了文档);②`fsp.open` 的 EACCES / I/O 错误被归为 `link_or_not_dir`,可加更泛的 reason;
  ③缺测试:replan 后变拒绝、chmod 期间目录被替换、`--rollback` 干跑、`--resume` 不收紧。
- ☐ 已知偶发红:`test/commands/calibrate.test.ts` 在 javis 共用机器的全量 vitest 下偶发整文件加载失败(单跑 29/29,约 197s);疑似负载下超时,未查根因。

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
