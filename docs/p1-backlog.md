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
- ☐ **反思器 `reflect`**:`Proposal.reflector.vendor` 必填、`judge.vendor ≠ reflector.vendor`、
  `skipped:same-vendor` 记账(contracts #18);含外部内容的会话只进结构化计数(#8)
- ☐ **`attest` / `promote` / `retire`**:按 contracts §对应节;依赖 reflect
- ☐ **`sync` 写全局 + `doctor`**(P2 表内但同批):真实 HOME 受管路径写入,依赖 B17 守卫面

## Phase P1-D(发布与治理,⏸ 等用户凭据/授权)

- ◐ **npm 发布**:包定名 `@chovizzz/agent-kit@0.1.0`,`scripts/check-publish.mjs` 自检 + `.github/workflows/release.yml`(tag `v*` 触发,`npm publish --provenance`,用 `secrets.NPM_TOKEN`);
  **待办:①在 GitHub 仓库加 `NPM_TOKEN` secret(npm token 须对 `@chovizzz` scope 有发布权;`chovizzz` 若还不是 npm org 需先建);②确认 CI 全绿;③推 tag `v0.1.0` 触发首发**
- ⏸ **远端分支保护 + CODEOWNERS**:需要 repo admin(geoly/chovizzz 两远端的策略要分别定)
- ⏸ **签名提交**:需要本机签名密钥决策(ssh 签名可用现有 ssh-key,`git config gpg.format ssh` + GitHub 上传公钥)
- ◐ CI 观察:`.github/workflows/ci.yml` 在 origin 的红点——已定位两处真红(见下),现验证中
  - probe 那两次失败:`format:check`(已提交的 probe.ts/check-budget.ts/contracts.md 未过 prettier;`b312e95` 修复)
  - 教训:门禁用 `pnpm run x >/dev/null 2>&1 && echo ok` 或 `pnpm run x | tail -1` 会被管道吞掉退出码——**必须单独跑并读退出码**

## 排期建议(串行优先,避免同文件并行)

1. **P0-close**(等时机)→ 2. **P1-A** 三件(本仓内,无外部依赖)→ 3. **P1-B** 按 D1→D3→D4→D5/D6
   → 4. **P1-C** probe → reflect → attest/promote/retire → sync/doctor → 5. **P1-D** 随凭据到位随时插入。

> 每块沿用 P0 纪律:块边界不动 `docs/block-boundaries.md` 之外的文件;全量门禁 + A1–A15 逐块回跑;
> 契约变更必须同步 contracts.md 编号条款与 oracle,不得只改实现。
