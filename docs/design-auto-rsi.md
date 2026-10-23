# 自动 RSI 设计:自动收集 + 干跑提案

> 状态:**设计稿,未实现**。基线 `815d2d0`。只出方案,不改 `src/` `test/` `ops/`。
> 依据:`contracts.md` §5.2、§12.4、§16、§17(含 §17.6 R6、§17.7 gc)、§18、§19(含 §19.5 后台 worker、§19.6 `auto_sync`);`redaction.md` §1、§6;`reader-counting-spec.md` §2;`p1-backlog.md`;`src/reflect/backends/**`、`src/update/{launcher,worker}.ts`、`src/signals/{exclude,state-store}.ts`。
> 用户方向(2026-10-23):自动跑 `signals collect` + `reflect` 干跑,只产出提案供人看;**不自动采纳、不写全局、不自动 promote**。本稿把「不写全局」落实为:**kit 自己不做任何全局分发写入**(不 sync、不写 HOME 受管路径);被自动调用的 LLM CLI 自身对 HOME 的副作用(§17.6 `globalWrites`)不在 kit 控制内,只有列入同意书并被用户接受的后端才能自动跑(§4.2、决定 D10)。
>
> 标注约定:**[契约]** = 已读契约 / 代码的事实;**[实测]** = 本机或 R6 实测;**[假设]** = 本稿推断,实现前要核实;**[推荐]** = 本稿建议,待用户拍板。

## 0. 结论摘要

1. **分两档,默认只开零外发的一档**。L0 = `signals collect`(只读会话、本地脱敏、写仓库 `.state/`)+ `reflect` 契约意义上的干跑(不构造后端、零 LLM、零外发),产出是「有多少聚类可以反思」的计数。L1 = `reflect` 真跑,只写暂存区(`.state/reflect/<run>/` + `apply.patch`),绝不 apply。L1 要用户一次性显式同意,同意与「CLI 二进制 + 参数集 + 已接受的未满足项」绑定,CLI 一升级就失效、退回 L0。
2. **触发统一成一个入口**:内部命令 `agent-kit __rsi --background`(仿 `__update`)。各种触发面只负责「戳一下」(poke),节流、门、锁、预算全在 kit 内判。首选触发面:pi 用户级扩展的 `session_shutdown` 事件 + kit 自己任意交互命令结束后顺带(与 update worker 同一套 `scheduleBackground`)。claude / codex 的 hooks 只**打印片段**由用户自己贴,kit 不改它们的配置文件。
3. **judge 不自动**(第二次外发、跨厂商)。apply、promote、retire、attest、sync 写全局、开 PR、任何对外通知一律不自动。
4. **RSI 开关类环境变量只能关、不能开**;开启只在固定用户级配置文件里,kit 永不写这些文件。这**不是**对同 UID 代码的安全边界(能写用户文件的 agent 也能改这些配置),威胁模型见 §8a.1。
5. 评审(§11)后补了一组硬约束(§8a):自动外发前按当前授权范围**再过滤一次历史信号**、外发前**先预留记账**再 spawn、完整锁矩阵与陈旧锁协议、固定的后台定位入口。这些约束是进入 R20 契约的前提。
6. 自动路径与手动 `signals collect` / `reflect` / `judge` 共用一把新锁 `.state/rsi/lock`(现在信号库假设单进程写,并发 collect 会互相覆盖 **[契约]**)。
7. 分期:P0 = 契约 §20 + 锁 + `rsi tick`(L0,前台)+ 后台调度;P1 = pi 扩展安装 + L1 同意与自动真跑 + 提醒/忽略 + doctor D17;P2 = 自动 judge、launchd、claude/codex 钩子自动安装、带提案 run 的回收。粗估 11–14 人日实现 + 评审(评审后补的 §8a 约 +2–3 日),另需一次用户在场的 R6 补测。

## 1. 现状事实(设计的出发点)

| #   | 事实                                                                                                                                                                                                                                         | 来源                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| F1  | 整条 RSI 都是手动命令;只有分发端有自动(`update` 后台 worker、`auto_sync=safe`),且 `auto_sync` 没有全自动档、永不首装、可执行类永不自动应用                                                                                                   | [契约] §19.5、§19.6                                    |
| F2  | `signals collect` 必须显式 `--source`;默认拒绝:既无 `exclude_dirs` 又无 `--allow-project` 时退出 2;cwd 为空/相对路径一律跳过;自带「自我排除」(会话 cwd 落在 state 目录或反思器 cwd 段内即跳过)                                               | [代码] `src/signals/exclude.ts`                        |
| F3  | 盐与信号库在仓库 `.state/`(`KIT_STATE_DIR` 只能在仓库或 `KIT_TMP` 内),目录 0700 / 文件 0600;盐首建非原子、信号库「并发的两次 collect 会互相覆盖(P0 接受)」                                                                                   | [代码] `src/signals/state-store.ts`、`src/io/paths.ts` |
| F4  | `reflect` 默认干跑 = 不构造后端、不调用、不写文件;真跑三道门 `--run-llm` + `--allow-egress` + 覆盖层 `reflect.egress=true`,另需 `--owner`;所有参数集 `verified:false`,无槽位 `allow_unverified` 就不 spawn                                   | [契约] §17.1、#29、#30;[代码] `cli-common.ts`          |
| F5  | 覆盖层只经 `--overlay <path>` 显式传入,kit 不自己找                                                                                                                                                                                          | [代码] `src/commands/reflect.ts`                       |
| F6  | R6(2026-10-13):noTools 三家 verified;codex 的 noMcp、noSession 为 `not_met`;noProjectSettings / noUserRouting 三家 `unresolved`;claude、codex 真跑会写各自全局文件,pi 无可归因全局写入                                                       | [实测] §17.6                                           |
| F7  | pi 的 noUserRouting:主代理告知 2026-10-23 实测**不成立**(用户级 `models.json` 可改写 provider 的 baseUrl,请求可经中转站)。本基线 `src/reflect/backends/cli-pi.ts` 仍记 `unresolved`,待回写为 `not_met`                                       | 主代理告知 [实测];代码未回写                           |
| F8  | LLM 调用串行:进程内 Promise 链(`gate.ts`)+ 跨进程 `.state/reflect/llm.lock`(符号链接锁,拿不到即 busy、不排队);冷却标记 `.state/llm-cooldown/<slot>-<YYYYMMDD>`                                                                               | [代码] `gate.ts`、`lock.ts`、`cooldown.ts`             |
| F9  | `reflect --gc` 只回收「≥30 天、目录里只有 `report.json`、无引用」的 run;含暂存提案的 run 本版不回收                                                                                                                                          | [契约] §17.7                                           |
| F10 | 后台先例:`scheduleBackground` 在前台命令结束后、TTY、非 CI、24h 节流到期时,经 `runSelf` 以 detached / stdio 丢弃 / `unref` 起 `__update --background`;worker 绝不输出,结果写日志稳定码;被拒提示由下一次 TTY 前台命令补出一行、每条只提示一次 | [契约] §19.5;[代码] `launcher.ts`、`worker.ts`         |
| F11 | `sync` 永远不碰 `~/.claude/settings*.json`、hooks、`~/.codex/config.toml`;`HOME_WRITE_TABLE` 写死 12 条,不含任何 hook / 扩展目录                                                                                                             | [契约] §19.2、§19.7                                    |
| F12 | 外部内容会话的信号摘录为 `''`,只进结构化计数(#8、#23)                                                                                                                                                                                        | [契约]                                                 |

## 2. 触发点(问题 1)

### 2.1 各 agent 可用的触发面

| 触发面                                                            | 能力                                                                                                                                                           | 本机核实情况                                                                                                                                                    | 侵入面                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| pi 用户级扩展 `~/.pi/agent/extensions/*.ts`                       | 事件 `session_shutdown`(`reason: quit\|reload\|new\|resume\|fork`)、`agent_end`、`agent_settled`;`ctx.hasUI`、`ctx.cwd`、`ctx.sessionManager.getSessionFile()` | [实测] 读本机 pi 0.87.1 的 `docs/extensions.md` 与 `dist/core/extensions/types.d.ts`;扩展与 pi 同进程、同权限;`--no-extensions` 时不加载                        | 新增一个**独立文件**,不合并任何既有配置                                                    |
| pi 项目级 `.pi/extensions`                                        | 同上                                                                                                                                                           | [实测] `docs/security.md`:受 project trust 管;print / RPC 模式不弹信任提示                                                                                      | **不用**:恶意仓库可借此执行代码                                                            |
| claude Code hooks(`SessionEnd`、`Stop`)                           | hook 进程从 stdin 收 JSON(含 `session_id`、`transcript_path`、`cwd`)                                                                                           | [假设] 依据公开文档,本机未跑;本机 `~/.claude/settings.json` 现有 `hooks` 只含 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` 三类事件(只读键名)              | 要改 `settings.json`(JSON 合并),F11 禁止 kit 写                                            |
| codex `~/.codex/hooks.json`                                       | 与 claude 相同的事件模型                                                                                                                                       | [实测] 本机 hooks.json 只用到 `PreToolUse`;codex-cli 0.161 二进制里含 `Stop`、`SessionEnd` 等事件名字符串。[假设] 是否真的会派发 `Stop` / `SessionEnd` 未跑实验 | 改 hooks.json,F11 禁止 kit 写                                                              |
| codex `notify`(顶层键,`agent-turn-complete` 时以 JSON 实参调程序) | 每轮结束                                                                                                                                                       | [实测] 本机 `config.toml` 已有顶层 `notify` 键(只看了键是否存在)                                                                                                | **不用**:单值键会覆盖用户现有设置;JSON 走 argv,会把最后一条助手消息放进进程参数(`ps` 可见) |
| kit 任意交互命令结束后                                            | 复用 F10 的 `scheduleBackground` 形状                                                                                                                          | [契约]                                                                                                                                                          | 零新增侵入;但用户不常跑 kit 命令时几乎不触发                                               |
| launchd / cron 定时                                               | 与 agent 无关                                                                                                                                                  | [假设] 要写 `~/Library/LaunchAgents/*.plist`(不在写入表内,属可执行类)                                                                                           | 新增系统级常驻,用户不用 agent 时也会跑                                                     |

### 2.2 推荐策略 [推荐]

- **一个入口,多处戳**。所有触发面只执行 `agent-kit rsi poke --agent <id>`:前台判总开关、CI、节流(读一个小状态文件),到期才经 launcher 的 `runSelf` 起 `__rsi --background` 并立即返回(目标 < 200ms,不等后台)。节流、门、锁、预算、去重全在 worker 内判,触发面里没有逻辑,换触发面不改语义。
- **首选**:①pi 用户级扩展(只在 `session_shutdown` 且 `reason ∈ {quit,new,resume,fork}`、`ctx.hasUI === true` 时 poke;`reload` 不触发;无 UI 的 `pi -p` 脚本调用不触发);②kit 交互命令结束后顺带 poke(与 update 调度并列,不新开机制)。
- **claude / codex**:`rsi hooks --print --agent claude|codex` 打印一段 `SessionEnd`(codex 若不支持则 `Stop`)的 hook 片段,用户自己贴进配置;kit 不写它们的配置文件(遵守 F11)。
- **launchd**:P2 备选,只打印 plist 模板,不安装。
- **pi 扩展由谁装**:`agent-kit rsi hooks --install --agent pi --write`,要求 stdin/stdout 都是 TTY 且交互确认(与 §19.6「可执行类必须 `--allow-executable` 并在 TTY 确认」同口径)。写入点 `~/.pi/agent/extensions/agent-kit-rsi.ts`,作为 `HOME_WRITE_TABLE` 新增的**可执行类** file 条目(12 → 13 条,契约变更);进 sync 登记表、可 `--uninstall`、可 `--rollback`;**`auto_sync=safe` 永不自动更新它**(payload 里出现 executable 条目即整次拒,已是 §19.6 现行规则——所以这个扩展**不能**放进 payload,只能由 `rsi hooks --install` 从 kit 包内常量生成,否则会让所有用户的 `auto_sync` 永久 `executable_in_payload`)。
- **扩展本身的最小形状** [推荐]:只注册 `session_shutdown` 一个 handler;handler 用 `child_process.spawn(<安装时写死的 agent-kit 绝对路径>, ['rsi','poke','--agent','pi'], {detached:true, stdio:'ignore'}).unref()`,不传会话路径、不读会话内容、不联网;**必须给子进程注册 `error` 监听**(`spawn` 的异步 `error` 事件不会被外层 `try/catch` 捕获,不监听会冒泡到 pi 宿主),同步异常也全部吞掉,失败只表现为「没有 poke」,由 `rsi status` 里「最近 poke 时间」诊断。会话文件在 `session_shutdown` 回调时是否已写完 **[假设]**:worker 本来就不读 hook 传来的路径,且只处理 mtime 早于启动时刻若干秒的文件、遇半行按 reader 现有口径处理,所以不依赖这个顺序。内容固定、带 kit 版本与 sha256 注释头,`doctor` 能校验它未被改。`PI_CODING_AGENT_DIR` 已设时拒绝安装(D09 的遮蔽场景,装了也不会被加载,或装错地方)。

**备选**:A. 只靠 kit 命令顺带(零侵入,但几乎不运转);B. launchd 定时(与 agent 一致,但系统级常驻、用户不用时也跑);C. 三家 hooks 全由 kit 自动写(体验最好,但要 JSON 合并用户配置、违反 F11、出错面最大)。
**代价**:推荐方案要新增一个可执行受管路径(契约变更)+ 一次 TTY 确认;claude/codex 要用户自己贴片段。

### 2.3 防自触发

kit 自己调的 LLM CLI 也会触发 agent 的钩子:pi 带 `--no-extensions`,扩展不加载 **[契约]** R6 参数集;claude `-p` 会加载用户 `settings.json` 的 hooks **[假设]**;codex exec 是否跑 hooks 未知 **[假设]**。推荐两层:

1. `llm-exec` 的固定环境追加 `KIT_RSI_CHILD=1`(与现有固定 `NO_COLOR=1` 同类,契约变更 §5.2),`rsi poke` 见到即直接退出 0;
2. 节流 + `.state/rsi/lock` 兜底:即使第一层失效,自触发也只是一次「已节流」的空 poke。
   另外 F2 的自我排除保证这些子会话即便落盘也不会被收集成信号。

## 3. 自动做什么、不做什么(问题 2)

| 动作                                                                           | 自动?                                   | 说明                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------- |
| `signals collect`(只读会话 → 本地脱敏 → `.state/signals/`、`.state/sessions/`) | ✅ L0                                   | 走现有 pipeline,不改脱敏口径                               |
| `reflect` 契约干跑(计数、聚类、提示字节数与 sha256,零外发)                     | ✅ L0                                   | 结果只记计数进 `.state/rsi/state.json`                     |
| `reflect --run-llm`(只写暂存区与 `apply.patch`)                                | ⚠️ L1,需同意                            | 判据见 §4                                                  |
| `judge`                                                                        | ❌(P2 可选)                             | 第二次外发、发给另一家厂商;promote 需要它,但那时用户已在场 |
| `git apply`、`promote`、`attest`、`retire`                                     | ❌ 永不                                 | 生命周期要人与四眼                                         |
| `sync --write` / 写任何 HOME 路径                                              | ❌ 永不                                 | `rsi hooks --install` 是用户前台手动命令,不是自动路径      |
| 开 PR、push、对外通知(含飞书/邮件/webhook)                                     | ❌ 永不                                 |                                                            |
| 改 `team_project_keys`、覆盖层、用户配置                                       | ❌ 永不                                 | kit 对这些文件只读                                         |
| `reflect --gc --write`                                                         | ❌(P1 只在 `rsi status` 里提示可回收数) | 删除动作留给用户                                           |

L0 是否「足够」:够让用户看到「有 N 个聚类、M 条证据可以反思」并决定是否手动真跑,零外发零风险;但它不产出提案文本。用户要的「用着用着自己转起来」真正需要 L1。故推荐:**默认 L0 自动,L1 由一次性同意打开**(决定 D1)。

## 4. LLM 调用的门(问题 3)

### 4.1 现有门在自动路径上怎么处理

现有门全部保留,自动路径**只增不减**:`reflect.egress=true`、槽位 `allow_unverified=true`、`--owner`(自动路径从用户配置 `[rsi] owner` 取)在自动路径同样必需;另加「自动同意书」与「自动判据」两层。**RSI 开关类**环境变量只能关:`KIT_AUTO_RSI=0` 关整个自动;不存在能打开 RSI 档位或门的环境变量。注意这条只针对开关:`PATH`、`XDG_*`、代理变量仍经 `llm-exec` 白名单传给子进程(§5.2),它们**能**改变程序解析、配置来源与网络路由——后台 worker 因此使用 §8a.4 的固定执行环境,而不是继承触发者的环境。

### 4.2 同意书(存放与撤销)[推荐]

- `agent-kit rsi consent --slot <slot>`(前台;kit 不写文件,**也不执行**待授权的 CLI——不跑 `--version`,只做路径与静态元数据读取)打印一个同意令牌:对一份**带版本号的规范化 JSON**(`canonicalJson`)取 sha256 的前 32 位十六进制,内容含 `slot`、`cli`、`provider`、`model`、`realpath(二进制)`、CLI 所在包的 `package.json` 版本与包目录内 JS 文件的整体摘要、参数集 id、参数集里**全部非 `verified` 项**(`claimed` / `unresolved` / `not_met`,含状态)的有序集合、`globalWrites` 清单。命令逐条列出这些非 `verified` 项、已知副作用与「外发目的地由该 CLI 自己的用户配置决定」的提示,请用户读完再抄。
- 执行时 spawn 的二进制必须是**计算令牌时解析出的同一个 realpath**,spawn 前复核一次,不再按 PATH 重新挑(评审 #4)。
- 已知不覆盖:包外的依赖与 node 运行时变化;CLI 自己的用户配置(例如 pi 的 `models.json` 改写 baseUrl)变化。后者是否也要进令牌见决定 D11。
- 用户**自己**把令牌写进覆盖层 `reflect.auto = { slot = "…", consent = "…", accept = ["noUserRouting", …], expires = "YYYY-MM-DD" }`(新增可选键,契约变更;kit 永不写覆盖层)。
- 失效:CLI 升级(二进制路径、包版本或包内 JS 摘要变)、参数集或其任一项状态 / `globalWrites` 变、`accept` 不覆盖当前全部未满足项、过期(上限 90 天)→ 当次只做 L0,并在 `rsi status` / 下次交互命令提示一次 `RSI_CONSENT_STALE reason=<码>`。
- 撤销:删掉 `reflect.auto` 段,或 `[rsi] level = "collect"`(持久,下一次检查即生效);`KIT_AUTO_RSI=0` 只影响带着这个环境变量的进程,对已在运行的 pi 与已起的 worker 无效。撤销语义分三档见 §8a.6。
- **[假设]** pnpm / npm 全局安装下,升级会改变包版本与包内 JS 摘要;实现前在本机对 pi、claude、codex 各升一次核实,并加「入口文件不变、实现文件改变」的验收用例。

备选:B. kit 在 TTY 确认后自己写 `.state/rsi/consent.json`(体验好;但 `.state/` 是 kit 可写处,任何能跑 kit 的进程都能伪造);C. 不绑定版本的永久同意(最省事;但 codex 升级须重测 `--disable` 组 **[实测]** §17.6 第 2 条,永久同意会把新版本的未知行为直接放行)。

### 4.3 「何时可以自动跑 reflect」判据(须全部成立,否则只做 L0)

1. 用户配置 `[rsi] enabled = true` 且 `level = "propose"`;`KIT_AUTO_RSI ≠ 0`;非 CI。
2. 覆盖层可读且:`reflect.egress = true`;`reflect.auto.slot` 是已绑定槽位且该槽位 `allow_unverified = true`;同意令牌与当前重算值相等;未过期。
3. 该槽位参数集:`noTools`、`noSession`、`inputViaStdin` 三项必须 `verified`;其余每一项是 `verified`,或是 `claimed` / `unresolved` / `not_met` 且名字出现在 `reflect.auto.accept` 里(`accept` 必须恰好覆盖 consent 命令列出的全部非 `verified` 项)。该后端的 `globalWrites` 非空时,另需决定 D10 选了允许。
4. 槽位 CLI 限 `[rsi] auto_clis`(推荐缺省只有 `pi`;codex 因 noMcp、noSession `not_met` 且会写四个 sqlite,不推荐自动)。
5. 推导厂商不是 `unknown`(沿用 `REFLECT_VENDOR_UNKNOWN`)。这只是必要条件:它**不能**证明请求的实际接收方(F7),接收方由同意书里用户接受的 `noUserRouting` 项承担。
6. 预算 `level == ok`;该槽位今天无冷却标记;未超每日 / 每周上限(§6)。
7. 新信号数(自上次 L1 以来新增、**通过 §8a.2 授权再过滤**的信号)≥ `[rsi] min_new_signals`(缺省 20),且本次输入指纹与上一次 L1 的不同。指纹 = 带版本的规范化 JSON(kit 版本、提示模板 sha、策略指纹、最终提示字节的 sha256)的 sha256,不只是 `sig_id` 集合(评审 #20)。
8. 拿到 `.state/rsi/lock` 与 `.state/reflect/llm.lock`,且 §8a.3 的调用预留已落盘。
9. 最终提示超过 `llm-exec` 的 stdin 上限时按确定性规则(聚类按证据数降序、整簇取舍)缩小,仍超限则整次不调用;绝不截断单条证据(评审 #21)。

pi 的现状(F7):noUserRouting `not_met`——外发目的地由用户自己的 `models.json` 决定,可能经中转站。用户交互使用 pi 时走的也是这条路由,所以把它列为**可接受但必须显式写进 `accept`** 的项;判据 5 的厂商推导对中转站无感知,`judge` 的跨厂商证明也就不可靠(这是 judge 不自动的又一个理由)。

## 5. 隐私与脱敏(问题 4)

- **读哪些**:只读用户在 `[rsi] agents` 列出的 agent 的默认会话根:claude `~/.claude/projects`、codex `~/.codex/sessions`(不含 `archived_sessions`)、pi `~/.pi/agent/sessions`、kimi `~/.kimi-code/sessions`(`reader-counting-spec.md` §2)。`PI_CODING_AGENT_DIR` 已设时 pi 记 `not_evaluated`、不猜路径。不接受 hook 传来的路径(claude 的 `transcript_path`、pi 的 session file 都不用),避免触发面变成「指定任意读路径」的通道。会话根下的资源边界:沿用 reader 现有的单行 64MiB 硬上限与超限计数(§13),自动路径另加「只读普通文件、不跟随符号链接、不读 FIFO/设备」、单次扫描的文件数与总字节数上限(超限本次停在已读部分,下次接着读);会话自报的 cwd 只用于项目归属的判断,不当作身份证明(评审 #8)。
- **项目范围**:沿用 F2 的默认拒绝。自动路径**只接受白名单**:`[rsi] allow_projects`(绝对路径列表)必填,`exclude_dirs` 只作附加排除;都没写 → 整次不 collect,`rsi status` 显示 `needs_project_policy`。理由:自动采集是长期静默行为,黑名单漏一个客户项目就是持续泄露。白名单只管「采什么」;「发什么」由 §8a.2 在外发前再过滤一次。比较规则按 §8a.2 收紧(现有 `exclude.ts` 对 allow 不区分大小写,源码注明在大小写敏感文件系统上是放宽 **[代码]**,自动路径不得照搬)。
- **层**:`team_project_keys` 白名单原样生效(缺省空 = 全部 personal,fail-closed **[契约]** #29);自动路径不改它,也不建议它。个人层提案照常暂存,只在本机。
- **落盘**:全部在 `<repo>/.state/`(已 gitignore),目录 0700、文件 0600(F3);新增 `.state/rsi/{lock,state.json,log.jsonl,cursor.json,dismissed.json}` 同权限。`rsi status` 对仓库位于常见云同步目录之下给 warn(**[假设]** 只能按路径前缀启发式判断)。
- **脱敏闸**:不新增口径。信号进库前两遍 `apply` fail-closed(`redaction.md` §1、§6);L1 提示构造后的复扫(`ReflectFailClosedError`)照旧;LLM 输出过 `validateReflectorOutput`(话术、不可见字符、回显)。自动路径遇到任何 fail-closed:本次停止、记稳定码、**同一输入指纹不自动重试**(防止对同一条疑似秘密反复撞闸);kit 版本或脱敏规则变更会改变指纹,于是自然重新评估;用户也可用 `rsi unblock <指纹前缀>` 显式解除。
- **提示注入**:外部内容会话只进计数(#8);LLM 产出的提案文本一律当不可信数据——`rsi status` 与提醒只显示 run_id、计数、稳定码,不显示提案正文;正文只在用户显式查看命令里出现,查看时剥掉终端控制序列、限制长度并标明「不可信内容」。能保证的只有两件:**模型不能调用工具**(noTools verified)、**提案不会被自动应用**。注入仍可能诱导模型在输出里回显敏感摘录(由输出回显校验拦一部分)、耗费额度、或在人读提案时误导人——这些是残余风险,不是「最坏只是一条坏提案」。

## 6. 成本与节流(问题 5)

| 项                     | 缺省 [推荐]                                                                  | 说明                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| poke 节流              | 同一 agent 30 分钟内只起一次 worker                                          | 前台只读 `state.json` 的时间戳                                                                                                                                      |
| L0 频率                | 每 6 小时至多一次                                                            | 用 `cursor.json` 记每个会话文件的 (路径哈希, size, mtime),未变的不重读;丢失也只是多读一遍(信号库按 `sig_id` 去重、会话计数按 `session_ref` upsert,**[契约]** §17.3) |
| L1 频率                | 每天 ≤ 1 次、每周 ≤ 3 次,`max_calls = 1`                                     | 按 `reflect.reset_tz` 算日期;上限写成代码常量,配置只能调严                                                                                                          |
| 单次时限               | collect 墙钟 120s;LLM 超时沿用 `timeout_ms`(缺省 180s);worker 总时限 10 分钟 | 超时整次放弃,下个窗口再来                                                                                                                                           |
| 预算耗尽 / 冷却 / 限流 | 当天只做 L0                                                                  | 沿用冷却标记;不读用户私人限流标记(**[契约]** §16)                                                                                                                   |
| 连续失败               | 3 次连续失败 → 退避 24h;7 天内全失败 → 自动暂停并提醒一次                    | 熔断状态在 `state.json`                                                                                                                                             |

**与用户自己的额度抢占**:kit 看不到各家订阅的周限额。缓解:L1 每周 ≤ 3 次、每次 1 次调用;缺省只允许 pi 槽位(用户可把它路由到不占主力订阅的 provider);用户可设 `[rsi] quiet_hours` 窗口内不跑 L1。**[假设]** 一次 reflect 的提示 ≤ 64KiB(`llm-exec` 的 stdin 上限),量级相当于一次普通对话。

**不影响用户正在做的事**:poke 不等后台;worker detached、stdio 丢弃、TMPDIR 指向受控目录(仿 F10);任何异常都只写日志稳定码,不弹输出、不改退出码。

## 7. 产出怎么到达用户(问题 6)

- **位置**:与手动 reflect 完全一样,`.state/reflect/<run_id>/`(提案 + `apply.patch` + `report.json`)。自动产生的 run 在 `report.json` 之外由 `.state/rsi/state.json` 记 `origin=auto`(不改 `ReflectRunReportSchema`,避免波及 gc 与 promote)。
- **提醒**:不打断。下一次 TTY 交互 kit 命令结束后 stderr 一行 `RSI_PROPOSALS_READY runs=N proposals=M`,每个 run 只提示一次(仿 `last_notice_at`);`agent-kit rsi status [--json]` 列最近 run、状态、门的判定结果与原因码;`doctor` 新增 D17(契约里 doctor 恒 16 项 → 17,契约变更)。pi 会话开始时用 `ctx.ui.notify` 提示属于打断,列为 P2 可选(决定 D7)。
- **忽略 / 清理**:`agent-kit rsi dismiss <run_id>|--all` 只写 `.state/rsi/dismissed.json`(不删 run),被忽略的不再提醒,也不再参与「上次 L1 输入指纹」之外的任何判断。真正删除含提案的 run 依赖 backlog 里「含暂存提案的 run 回收」的设计(需先定编号高水位,否则 `loadUsedProposalIds` 会变,**[契约]** §17.7),本稿不突破;只读部分的 `reflect --gc` 候选数在 `rsi status` 里显示。

## 8. 安全与失败模式(问题 7)

| 威胁 / 失败                                           | 处置                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 恶意仓库的 `.pi/extensions`、`CLAUDE.md`、`AGENTS.md` | 只用 pi **用户级**扩展;kit 不读项目里任何钩子;仓库内容能做的最多是引导 agent 在工具里跑 kit 命令——而所有开门的开关都在用户手写文件里、环境变量只能关、`rsi hooks --install` 要 TTY 确认                                                                                                                         |
| 自动跑在哪个仓库                                      | 只跑 `[rsi] repo` 指定的一个仓库(绝对路径、真实目录、链上无符号链接、含 `kit.toml`、属主是当前用户);**不跟随**会话 cwd,恶意仓库无法让 worker 在它那里跑                                                                                                                                                         |
| 被篡改的信号库 / 状态文件                             | 现有 `SignalStoreError`、`project_key` 形状检查 fail-closed;`state.json` 过 schema,坏了 → 本次只记 `state_invalid` 并停止自动(熔断),不自愈覆盖                                                                                                                                                                  |
| 被改写的 pi 扩展                                      | doctor D17 校验扩展文件 sha 与登记表一致;漂移按 sync 现有 `SYNC_DRIFTED` 语义处理,不覆盖                                                                                                                                                                                                                        |
| 触发风暴(很多会话同时结束、自触发)                    | poke 节流 + worker 锁 + §2.3 的子进程标记;拿不到锁即退出(不排队)                                                                                                                                                                                                                                                |
| 与手动命令并发                                        | 新锁 `.state/rsi/lock`:自动 worker、手动 `signals collect`、`reflect --run-llm`、`judge` 都要拿(契约变更);锁序 `rsi/lock → reflect/llm.lock`;手动命令拿不到 → 退出 4 `*_NOT_RUN reason=rsi_locked`。需要 safe-fs 增加独占创建原语(现在没有 O_EXCL,reflect 锁靠符号链接技巧,**[代码]** `lock.ts`),或沿用同一技巧 |
| 与 update worker 并发                                 | 状态完全分开(HOME 下 vs 仓库 `.state/`);rsi worker 发现 update 锁被持有时本次跳过——**只是尽力降低资源竞争,不是互斥**(检查后仍可能同时启动);worker 的执行代码由 `runSelf` 固定到已校验的版本目录,所以中途 `current` 被切换不影响本次运行                                                                         |
| 机器高负载                                            | **[假设]** 无法降优先级(lint 禁 `os` 模块);靠频率上限与 collect 增量                                                                                                                                                                                                                                            |
| 可观测性                                              | `.state/rsi/log.jsonl` 每次一行:时间、触发源枚举、档位、结果稳定码、计数、耗时;无路径、无文本;保留最近 200 行                                                                                                                                                                                                   |
| 一键关闭                                              | `[rsi] enabled = false`(持久;worker 在 collect 前与 spawn 前各重读一次,下一个检查点生效);`KIT_AUTO_RSI=0`(只对带此变量的新进程生效);`rsi stop`(给正在运行的 worker 发停止,见 §8a.6;已发出的 LLM 请求无法撤回);`rsi hooks --uninstall --agent pi --write` 卸扩展。缺省:`enabled` 不写即关,`level` 缺省 `collect` |

## 8a. 评审后补充的硬约束(进入 R20 契约的前提)

### 8a.1 威胁模型(先说清不防什么)

- **防**:恶意仓库的项目级资源与上下文文件;触发面传来的参数(路径、cwd、会话 id);被篡改的 `.state/` 文件(按 schema fail-closed);触发风暴;自触发。
- **不防**:任意同 UID 代码,或拥有任意文件写工具的 agent。它们能改用户配置、覆盖层、pi 扩展,也能直接跑 `reflect --run-llm`,这在本设计之前就成立。kit 不把「配置是用户手写的」当作身份证明;本设计只保证**自动路径不会比用户手动执行更宽**。若将来要求「用户在场」才能开 L1,需要独立的交互授权流程(TTY 确认 + 本机密钥签名等),列为 P2,不在本期。
- **配置的可信入口**:自动路径只从固定用户级文件 `~/.config/agent-kit/config.toml` 的 `[rsi]` 段读取 `repo`、`overlay`(覆盖层绝对路径)、`owner`、`agents`、`allow_projects`、`level`;读取前校验:路径链上无符号链接、属主是当前用户、组与其他人不可写。hook、cwd、仓库内容、环境变量都不能替换这些值。worker 定位完全不依赖启动 cwd(评审 #1、#14)。

### 8a.2 外发前按当前授权再过滤

- 共享信号库里可能有手动采集的、白名单之外的数据,白名单也会收缩。所以 L1 在**装载信号与构造提示时**再按**当前** `[rsi] agents`、`allow_projects`、`exclude_dirs` 过滤一次;信号缺少可核对的来源信息(没有能映射回白名单项的 `project_key`)→ 自动路径不使用它(手动路径行为不变)。
- 实现要点 **[假设]**:信号里只有加盐的 `project_key`,不存路径;过滤时对 `allow_projects` 的每一项用同一个盐算出 key 集合再比对。由此带来的限制:`allow_projects` 只能精确匹配到「项目 key 的生成口径」,父目录授权不会自动包含子项目——这与下一条的「精确项目」口径一致,实现前要核对 `project_key` 的生成规则。
- 自动白名单比较:按文件系统真实语义,不无条件折叠大小写;区分「精确项目」(缺省)与「递归包含子目录」(必须显式写 `recursive = true`);测试覆盖大小写敏感卷、符号链接、目录删除后重建、父路径授权(评审 #2、#3)。

### 8a.3 外发记账:先预留,再 spawn

- 锁内先把一条 `attempt` 记录写进 `.state/rsi/state.json`(状态 `reserved`),再 spawn;spawn 后改 `started`,结果落盘后改 `completed` 并写结果码。
- 崩溃 / 被杀 / 写盘失败留下的 `reserved` 或 `started` 记录一律按 `outcome_unknown` 处理:**计入当日与当周上限**,同一输入指纹不自动重试。
- 验收:在「已发出请求、结果未落盘」时 kill worker,下次运行必须看到 `outcome_unknown` 且不再调用(评审 #9)。
- 「次数上限」不等于「费用上限」:kit 只能限制调用次数、超时与 stdout 大小,不能限制供应商侧的重试或推理计费;文档与 `rsi status` 都只承诺次数。

### 8a.4 后台的执行环境

worker 不继承触发者的环境:由 launcher 的 `runSelf` 按 `RUN_SELF_ENV_KEYS` 起 worker(§19.7),worker 再用 `ctx.io.hostEnv`(§12.4 ④)经 `filterLlmEnv` 拼 LLM 子进程环境。代理变量与 `XDG_*` 是否透传给自动调用的 LLM CLI 按「与用户交互使用时一致」处理,并在 consent 输出里明示(评审 #5)。

### 8a.5 锁矩阵与陈旧锁

| 资源                                                     | 写入方                                     | 规则                                                  |
| -------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `.state/salt`、`.state/signals/**`、`.state/sessions/**` | 自动 worker、手动 `signals collect`        | 拿 `.state/rsi/lock`                                  |
| `.state/reflect/<run>/`、`.state/llm-cooldown/`          | 自动 L1、手动 `reflect --run-llm`、`judge` | 拿 `rsi/lock` → `reflect/llm.lock`(固定锁序)          |
| `.state/reflect/<run>/` 删除                             | `reflect --gc --write`                     | 拿 `rsi/lock`(gc 现在不拿锁,§17.7,自动路径加入后要拿) |
| `.state/rsi/*`                                           | worker、`rsi dismiss`、`rsi unblock`       | 拿 `rsi/lock`                                         |
| 只读查询(`rsi status`、`doctor`、干跑)                   | —                                          | 不拿锁,读到半成品按 schema 判 `invalid` 并提示,不修复 |

- worker 由顶层持锁,内部调用**不再拿锁的内部服务函数**,而不是去调各命令层(否则自己锁住自己)。锁身份按 `realpath(stateDir)` 规范化。
- 锁内容 `{pid, started_at, nonce}`,释放前核对 nonce 是自己的;陈旧判据沿用 §19.5 update 锁的协议(pid 不在才回收、回收前复读确认、pid 在但超 TTL 只报不杀、提交点前 `assertHeld`);不凭 TTL 直接删锁。测试覆盖持锁崩溃、pid 复用、旧持有者延迟释放(评审 #10、#11)。

### 8a.6 关闭与撤销的三档语义

①禁止未来调度:`[rsi] enabled=false` / 卸扩展;②禁止下一次外发:worker 在 collect 前与 spawn 前重读配置与同意书,任一不再成立即停在 L0;③终止正在运行的:`rsi stop` 写停止标记,worker 在每个检查点读到即退出;已经发出的请求无法撤回(评审 #13)。

### 8a.7 cursor、启动预留与产出索引

- **cursor** 绑定「采集器版本 + 白名单与排除策略指纹 + 脱敏规则版本」,任一变化即全量重读;记录文件身份(dev:ino)+ size + mtime,每 7 天强制全量核对一次;只有信号库提交成功后才推进 cursor(评审 #19)。
- **启动预留**:poke 用独占创建一个短期标记(`.state/rsi/poke-<分钟桶>`)作为原子的「本时段已起 worker」预留,触发风暴下同一时段只起一个进程(评审 #22)。
- **失败分类**:结果分「成功 / 正常跳过(无新信号、预算满、授权失效、锁忙)/ 可重试错误 / 安全阻断(fail-closed)」;只有可重试错误计入熔断;安全阻断直接停在该输入指纹;跳过不计。连续失败按「连续 N 次 attempt」计,不按自然日;测试用假时钟覆盖跨日、跨周、时钟回拨与夏令时。
- **产出索引**:`state.json` 里的 run 索引可由扫描 `.state/reflect/*/report.json` 重建(`rsi status --rebuild-index`);run 已写成功而索引没写上 → 下次启动补登;索引里有而目录不在 → 标 `missing`。累计暂存 run 数或字节数超过阈值(缺省 50 个 / 50MiB)或磁盘可用不足 → 暂停 L1 并提示,不自动删除(评审 #23)。

### 8a.8 端到端验收(补「用户不跑 kit 也能获知」)

P1 收尾必须做一次端到端:普通 pi 会话结束 → 自动 collect → 满足判据时自动产出暂存提案 → 用户**不必记得跑 kit 命令**也能获知(决定 D7 选定的通道),且通知里不出现提案正文。采集自动化(P0)与提案闭环(P1)分开验收,P0 完成不等于「RSI 已经自己转起来」(评审 #24)。

## 9. 分期与验收(问题 8)

带契约 / schema 变更的块串行;同一文件不并行。所有测试、构建在 javis 上跑(仓库约定)。

| 块                             | 内容                                                                                                                                                             | 文件边界                                                                                                             | 依赖          | 验收与变异点                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R20**(P0,串行)               | 契约 §20:`UserConfig.rsi`、覆盖层 `reflect.auto`、`.state/rsi/*` schema、稳定码 `RSI_*`、锁序、`KIT_RSI_CHILD`、D17、`HOME_WRITE_TABLE` 第 13 条(可执行类)的语义 | `docs/contracts.md`、`src/contracts/{update,config,rsi}.ts`、对应 contracts 测试                                     | 无            | schema 夹具矩阵;变异:`level` 缺省改成 `propose` 必红;环境变量能开门必红                                                                                                                                        |
| **A1**(P0)                     | 锁原语 + `.state/rsi/` 状态 / 日志;手动 `signals collect` / `reflect --run-llm` / `judge` 接锁                                                                   | `src/io/safe-fs.ts`(若加独占创建)、`src/rsi/{lock,state,log}.ts`、三个命令文件                                       | R20           | 并发两个 collect:一个 `rsi_locked`;变异:去掉手动命令的拿锁 → 并发测试红                                                                                                                                        |
| **A2**(P0)                     | `rsi tick [--write]`(前台,L0;不带 `--write` 是纯计划:不建盐、cursor、日志与目录;带 `--write` 才真采集)与 `rsi status`;cursor 增量;项目白名单必填                 | `src/rsi/{tick,cursor,status}.ts`、`src/commands/rsi.ts`                                                             | A1            | 分两条判:无 `--write` 进 A5 绝对零写入;`--write` 只许写 `.state/{rsi,signals,sessions}`(限域写入);两者都 A8 零网络;import 闭包不含 `llm-exec`;幂等(第二次零新增);变异:去掉白名单检查 → 无白名单也 collect 必红 |
| **A3**(P0)                     | `rsi poke` + `__rsi --background` + kit 命令后顺带;节流、熔断、子进程标记                                                                                        | `src/update/launcher.ts`(唯一可用 `runSelf` 处)、`src/rsi/worker.ts`、`src/cli.ts`、`src/io/llm-exec.ts`(加固定变量) | A2            | 假 HOME + 假时钟:节流 / 熔断 / `KIT_AUTO_RSI=0` / `KIT_RSI_CHILD=1` / CI 各自不起 worker;变异:节流比较取反必红                                                                                                 |
| **A4**(P1,需用户同意装真 HOME) | `rsi hooks --print`(三家)与 `--install/--uninstall --agent pi`(TTY 确认、登记表、可回滚)                                                                         | `src/rsi/hooks.ts`、`src/sync/**` 中受管条目、`adapters/pi/managed-targets.json`                                     | R20、A3       | 假 HOME 装 → 卸树哈希一致;非 TTY 拒;`PI_CODING_AGENT_DIR` 拒;变异:去掉 TTY 检查必红;**真 pi 上手测一次 `session_shutdown` 触发(用户在场)**                                                                     |
| **A5**(P1)                     | L1:同意令牌、§4.3 判据纯函数、上限、指纹去重                                                                                                                     | `src/rsi/{consent,criteria}.ts`、`src/commands/rsi.ts`                                                               | A3            | 判据矩阵每条单独不满足 → 只做 L0 且原因码精确;变异:跳过令牌比对 / 跳过 `accept` 覆盖检查 / 上限 off-by-one 各自必红;**R6 补测(用户在场)**:pi 在无 TTY 后台真跑一次、全局写入快照、noUserRouting 回写 `not_met` |
| **A6**(P1)                     | 提醒一次、`rsi dismiss`、doctor D17                                                                                                                              | `src/rsi/notice.ts`、`src/doctor/**`                                                                                 | A5            | 每个 run 只提示一次;D17 的泄漏闸(无绝对路径);变异:重复提示                                                                                                                                                     |
| **P2**                         | 自动 judge(另一份同意)、launchd 模板、claude/codex 钩子自动安装、含提案 run 的回收                                                                               | —                                                                                                                    | A6 + 用户决定 | 另立设计                                                                                                                                                                                                       |

**粗估**:R20 0.5–1 日;A1 1 日;A2 1.5 日;A3 1.5 日;A4 1.5 日;A5 2 日;A6 1 日;§8a 的锁矩阵 / 记账预留 / 授权再过滤 / 索引重建分摊进 A1、A2、A5,约 +2–3 日;合计约 11–14 人日(含评审修订),另 R6 补测约半天且须用户在场。

**需要用户当场同意的真实环境动作**:A4 在真实 HOME 装 pi 扩展;A5 的 R6 补测(真跑 pi 一次、外发合成提示);claude / codex 的 hook 片段由用户自己贴并在真会话里观察一次是否触发(核实 §2.1 的两条假设)。

## 10. 需要用户拍板的决定

| #   | 问题                 | 选项(第一个为推荐)                                                                               | 代价                                                                                                               |
| --- | -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| D1  | 自动档位             | A(推荐)L0 自动 + L1 一次性同意;B 只做 L0,永不自动外发;C L1 默认开                                | A:要实现同意与判据(A5);B:永远不出提案文本,「自己转起来」只转一半;C:违背默认 fail-closed,外发无人确认               |
| D2  | 触发主路径           | A(推荐)pi 用户级扩展 `session_shutdown` + kit 命令顺带;B launchd 定时;C 只靠 kit 命令顺带        | A:新增一个可执行受管路径(契约变更);B:系统级常驻、不用 agent 时也跑;C:几乎不触发                                    |
| D3  | claude / codex 钩子  | A(推荐)只打印片段,用户自己贴;B kit 合并写进配置;C 不支持                                         | A:多一步手工;B:违反「永不碰 settings/hooks/config.toml」,JSON 合并出错面大;C:只有 pi 会自动转                      |
| D4  | 同意书存放           | A(推荐)覆盖层手写令牌、绑定 CLI 版本、≤90 天;B kit 在 TTY 确认后写 `.state`;C 不绑版本的永久同意 | A:每次 CLI 升级要重抄令牌;B:kit 可写处可被伪造;C:升级后的未知行为被直接放行                                        |
| D5  | 自动外发允许哪些 CLI | A(推荐)只 pi;B pi + claude;C 任意满足判据的槽位                                                  | A:用户若主要用 claude 则 L1 不可用;B:claude 真跑会写其全局文件(F6)且占订阅额度;C:codex 的 noMcp / noSession 未满足 |
| D6  | L1 频率上限          | A(推荐)每天 ≤1、每周 ≤3;B 每周 ≤1;C 每天 ≤3                                                      | A:折中;B:提案慢;C:与用户周限额抢得更多                                                                             |
| D7  | 提醒方式             | A(推荐)下一次 kit 交互命令一行 + `rsi status`;B 另加 pi 会话开始时 `ui.notify`;C 不提醒          | A:不用 kit 命令的用户看不到;B:打断会话;C:提案堆积无人看                                                            |
| D8  | judge                | A(推荐)不自动;B P2 自动但仅可证明跨厂商、另一份同意                                              | A:promote 前要手动跑 judge;B:第二次外发,且中转站路由下跨厂商证明不可靠(F7)                                         |
| D9  | 项目范围             | A(推荐)自动路径只接受 `allow_projects` 白名单;B 允许只用 `exclude_dirs`                          | A:要先列项目;B:漏排一个客户项目就持续采集                                                                          |

| D10 | 自动跑的 CLI 自己写 HOME(`globalWrites` 非空)怎么办 | A(推荐)有已知全局写入的后端禁止自动跑(现状只剩 pi 可自动);B 列进同意书,用户接受后允许 | A:claude 永远不能自动跑;B:「不写全局」承诺缩成「kit 自己不写」,HOME 里会多出 CLI 自己的文件 |
| D11 | 同意书要不要绑定 CLI 自己的路由配置(如 pi 的 `models.json`) | A(推荐)绑定其 sha256,配置一改同意即失效;B 不绑定,接受「以后用户改路由也照发」 | A:改模型配置后要重抄令牌;B:接收方可能悄悄变成别的中转站 |

建议第一批先定 D1、D2、D4、D9(解锁 R20 契约与 P0 全部块),第二批 D10、D11、D5(L1 开工前),其余随 P1 开工前再定。

## 11. 评审记录

2026-10-23,`~/.claude/bin/pi-review.sh` 只读评审(第 1 级 Pi GPT-6.1 Sol;评审方另核对了 `exclude.ts`、`llm-exec.ts`、`commands/reflect.ts`、`cli-pi.ts`、`launcher.ts`,其余引用以文中陈述为准)。共 24 条,逐条处置:

| #   | 问题(严重度)                                            | 处置                                                                                                               |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | 「用户手写配置」不是对同 UID 代码的安全边界(高)         | 采纳:§8a.1 写明威胁模型与「不防」项;摘要第 4 条收窄                                                                |
| 2   | `allow_projects` 只管新采集,历史信号仍可能外发(高)      | 采纳:§8a.2 外发前按当前授权再过滤,缺来源信息的信号自动路径不用                                                     |
| 3   | 白名单比较不区分大小写、父目录默认含后代(高)            | 采纳:§8a.2 严格比较,区分精确 / 递归;§5 引用代码事实                                                                |
| 4   | 只哈希入口文件不能证明升级失效;批准 A 执行 B(高)        | 采纳:§4.2 令牌改含包版本与包内 JS 摘要,spawn 用同一 realpath 并复核;已知不覆盖项写明                               |
| 5   | 同意书没绑定实际路由;环境变量并非「只能关」(高)         | 部分采纳:开关类环境变量的表述收窄(§4.1),后台固定环境(§8a.4),判据 5 写明不能证明接收方;是否绑定路由配置列为决定 D11 |
| 6   | 「不写全局」与接受 `globalWrites` 冲突(高)              | 采纳:顶部说明改为「kit 自己不做全局分发写入」,判据 3 加条件,新增决定 D10                                           |
| 7   | 「注入最坏只是一条坏提案」说得过满(中)                  | 采纳:§5 改为只保证无工具、不自动应用,列出残余风险与查看命令的安全渲染                                              |
| 8   | 会话源文件的类型与资源边界未定义(中)                    | 采纳:§5 加普通文件、不跟随链接、文件数 / 字节上限;cwd 不作身份证明                                                 |
| 9   | 调用已发生但未记账,上限失效(高)                         | 采纳:§8a.3 先预留后 spawn,`outcome_unknown` 计入上限且不重试,加 kill 故障注入验收                                  |
| 10  | 锁覆盖不完整、嵌套拿锁会自锁(高)                        | 采纳:§8a.5 资源—命令—锁矩阵(含 gc),worker 用不拿锁的内部服务,锁身份按 realpath                                     |
| 11  | 陈旧锁恢复与所有权协议未设计(中)                        | 采纳:§8a.5 沿用 §19.5 update 锁协议(nonce 核对、pid 判据、只报不杀)                                                |
| 12  | 「发现 update 锁就跳过」有检查后竞争(中)                | 采纳:§8 表改为「只是尽力,不是互斥」,执行代码固定到已校验版本目录                                                   |
| 13  | 关闭 / 撤销不会立即生效(中)                             | 采纳:§8a.6 三档语义,§4.2 与 §8 表同步改写                                                                          |
| 14  | 后台如何找到 repo / 覆盖层未闭合(高)                    | 采纳:§8a.1 固定用户级配置入口与校验,不依赖 cwd                                                                     |
| 15  | `claimed` 项要 accept 但 consent 没展示(中)             | 采纳:§4.2 展示并绑定全部非 `verified` 项,令牌改用带版本的 `canonicalJson`                                          |
| 16  | consent 若跑 `--version` 就不是只读(中)                 | 采纳:§4.2 明确不执行待授权 CLI,只做静态读取                                                                        |
| 17  | 扩展的异步 `error` 未监听;shutdown 时会话是否已落盘(中) | 采纳:§2.2 要求注册 `error` 监听;落盘顺序列为假设,worker 不依赖它                                                   |
| 18  | `rsi tick` 无 `--write` 的语义未定义(中)                | 采纳:A2 行写明无 `--write` 为纯计划;零写入与限域写入分开判                                                         |
| 19  | cursor 会漏读、不随配置失效(中)                         | 采纳:§8a.7 cursor 绑策略指纹、文件身份、定期全量,信号库提交后才推进                                                |
| 20  | 输入指纹只哈希 `sig_id`;永不重试会卡死修复后的输入(中)  | 采纳:§4.3 判据 7 改为带版本的有效输入指纹;§5 加 `rsi unblock` 与版本变化自然重评                                   |
| 21  | 调用次数上限不等于成本上限;64KiB 是出口上限不是保证(中) | 采纳:§4.3 判据 9 定确定性缩减规则,不截断证据;§8a.3 写明只承诺次数                                                  |
| 22  | poke 风暴下仍会起很多进程;熔断计数口径不清(中)          | 采纳:§8a.7 原子的时段预留标记,结果四分类,只有可重试错误进熔断                                                      |
| 23  | run 已落盘而索引没写上;提案长期占盘(中)                 | 采纳:§8a.7 索引可重建、补登、阈值暂停 L1;删除仍依赖 backlog 的回收设计                                             |
| 24  | 「不跑 kit 的用户看不到提醒」没有在验收中闭环(低)       | 采纳:§8a.8 端到端验收,P0 与 P1 分开验收;提醒通道仍由 D7 定                                                         |
