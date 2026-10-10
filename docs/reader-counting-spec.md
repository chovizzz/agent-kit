# reader 计数口径表(B10a)

- 状态:B10a 交付稿,基线 `5cb253b`(tag `contracts-v1`),核实日期 2026-10-08。
- 读者:B11–B14(四个 reader)、B16(jq oracle)、B19/主代理(A6 验收)。reader 与 oracle 必须对着**本文**各写一份,互不参照对方实现;两边对不上时先查本文是否二义,二义则退回本文修订,**不得**在任一边私自定口径,更不得放宽 A6(D §13)。
- 本文不含任何会话正文。例子全部是合成数据;真实样本只出现路径哈希、行数、计数。
- 本文的 jq 程序和合成夹具都已在 jq 1.7.1 上跑过,期望值是实测值(自检方法见 §10)。

## 0. 速查

| 项              | Claude                                      | Codex                                                                           | Pi                                              | Kimi                                                             |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 会话文件        | `<项目目录>/<UUID>.jsonl`(深度 2)           | `Y/M/D/rollout-*.jsonl`,首行 `session_meta.payload.source` 非 subagent 对象     | `--<路径>--/*.jsonl`                            | `<wd>/<session>/agents/main/wire.jsonl`                          |
| 用户消息        | 见 §2.1.3 的 U0–U9 谓词                     | `event_msg/item_completed` 且 `item.type=="UserMessage"`                        | `message.role=="user"` 的 message 条目          | `context.append_message`,`role=="user"` 且 `origin.kind=="user"` |
| 工具调用        | assistant 行 `tool_use` 块个数              | `response_item` 的 4 种 `*_call`                                                | assistant message 的 `toolCall` 块个数          | `context.append_loop_event` 且 `event.type=="tool.call"`         |
| 工具失败        | user 行 `tool_result` 块且 `is_error==true` | `item_completed` 的 5 种工具 item 且 `status=="failed"`(**版本受限,见 §2.2.5**) | `message.role=="toolResult"` 且 `isError==true` | `tool.result` 且 `result.isError==true`                          |
| 子代理          | 独立文件,不计入                             | 独立文件,首行判定,不计入                                                        | 无独立文件(`custom_message` 通知)               | 独立 `agents/agent-N/wire.jsonl`,不计入                          |
| `ts`            | 行内 `timestamp`                            | 行内 `timestamp`                                                                | 条目 `timestamp`                                | 行内 `time`(毫秒数)                                              |
| `agent_version` | 行内 `version`(`session_meta`)              | `session_meta.payload.cli_version`(`session_meta`)                              | **会话里没有**(`collector_fallback`)            | **会话里没有**(`collector_fallback`)                             |

## 1. 共同规则

C1 到 C12 对四家都成立。四家各自的细节在 §2。

**C1 会话 = 主文件。** 一个主文件是一个会话,`SessionRef` 只枚举主文件。子代理/侧链文件不是会话,`discover` 不返回它们,它们的事件不计入主会话的任何计数(主会话里只看到「调用了子代理」这一次工具调用)。

**C2 行解析。** 文件按 UTF-8 逐行读。

- 空白行(只含空白字符)忽略,不计任何数。
- 不是合法 JSON、或合法 JSON 但不是对象的行 = **畸形行**:不产出事件,计入 `unknown_event_types["<malformed>"]`。文件被截断的末行(正在写入的会话)属于这一类。
- 对象行缺 `type` 字段(或 `type` 不是字符串):计入 `unknown_event_types["<no-type>"]`,不产出事件。判定顺序:先判畸形,再判 Claude/Kimi 的侧链过滤(Claude `isSidechain==true`、Kimi `agentId` 非 `main`),侧链行优先于 `<no-type>`,即缺 `type` 的侧链行只算侧链,不计 `<no-type>`。
- 行分隔符是 `\n`;行尾的 `\r` 当空白处理(CRLF 文件与 LF 文件结果相同);文件末行没有换行符照样算一行;文件开头的 UTF-8 BOM 忽略,不算畸形行。本机四家的语料里 BOM 为 0 个文件,jq 1.7.1 对 BOM、CRLF 都已按夹具实测(§7.6);Node 侧 `readFileSync(…,'utf8')` 会去掉 BOM,reader 若用流式读取要自己去。
- **B21 补充(R2,以 jq 1.7.1 实测为准,取代上一条里关于 BOM 的说法)**:判空白与去 BOM 对**每一行**同样处理,首行不特殊。先在原始行上判「整行只含空白」(字符集 = Unicode White_Space:`\t \n \v \f \r`、空格、`U+0085`、`U+00A0`、`U+1680`、`U+2000–U+200A`、`U+2028`、`U+2029`、`U+202F`、`U+205F`、`U+3000`;**不含 `U+FEFF`**,已对全部码位逐个与 jq 的 `test("\\S")` 核对);非空白行再去掉行首**恰好一个** `U+FEFF`(jq 的 `fromjson` 跳过它),然后解析。
  结果:只含 `U+FEFF` 的行(含首行)计 `<malformed>`;只含 `U+0085` 的行是空白、跳过;行首一个 BOM + 对象的非首行(如 `cat a b` 拼接)正常计数;BOM 在行尾、连续两个、或在空格之后仍是 `<malformed>`。
- 重复行**不去重**:同一文件里逐字节相同的两行算两行。本机 Claude 主文件内 `uuid` 重复为 0,不需要文件内去重。
- 只收**已关闭**的文件做验收比对(C10)。

**C3 `ts` 回退。** `NormEvent.ts` 非空率必须 100%(A6)。取值顺序:

1. 该行自带的有效时间戳(各家字段见 §2),转成 ISO-8601 UTC 毫秒(`toISOString()`)。有效 = Claude/Codex/Pi 为匹配 `^[0-9]{4}-[0-9]{2}-[0-9]{2}T` 且 `Date.parse` 非 NaN 的字符串;Kimi 为 `1e12 <= 值 < 4e12` 的数字(毫秒)。
2. 缺失或无效时,用**会话起始时间** = 该文件按行序第一个有效时间戳(reader 在读文件头部时预扫到第一个即停,不需要读全文件)。
3. 整个文件没有任何有效时间戳时,用文件 `mtime`(UTC,毫秒)。

- 本机实测:Claude 主文件里没有时间戳的行都是元数据行(`mode`、`permission-mode`、`last-prompt`、`ai-title`、`bridge-session`、`file-history-snapshot` 等);Codex、Pi 每行都有;Kimi 每行有 `time`(首行 `metadata` 用 `created_at`)。第 3 级回退本机零命中,只能用合成夹具测。
- `SessionMeta.started_at` = 上面第 2 级的值;第 3 级回退时为 `null`。
- 续接/fork 出来的文件(C9)开头是被复制的旧历史,所以「文件里第一个时间戳」是旧历史的起点,不是这次续接的开始时间;本文不区分,只保证非空。
- **`ts` 不进 A6 的逐项相等元组。** A6 逐项相等的只有三个计数;`ts` 只验非空率 100%。第 3 级(文件 mtime)jq 拿不到,由采集端(reader)负责,oracle 只提供「第一个有效时间戳」探针(§7.5)。mtime 受拷贝、rsync 影响,不稳定,所以只作最后兜底。

**C4 `agent_version`。** 见 §3。只允许两种来源:会话元数据(`agent_version_source="session_meta"`)和采集时 CLI 版本(`"collector_fallback"`)。

**C5 `Counts` 与事件的恒等式。** 对任一会话,`Counts.user_messages` = 该会话产出的 `kind=="user_message"` 的事件数;`Counts.tool_calls` = `kind=="tool_call"` 的事件数;`Counts.tool_failures` = `tool_failed===true` 的事件数(不论 kind)。reader 不得为了凑数把别的事件改记成这三类,也不得有「计了数却没产出事件」的路径。

**C5b A6 的相等元组。** 逐项相等的只有 `user_messages`、`tool_calls`、`tool_failures`(三个计数,4 家 × 5 样本 = 60 个数,plan A6)。`unknown_event_types` 用合成夹具验证(含 `<malformed>`),`branch_count` 用 Pi 合成夹具验证;`ts` 与 `agent_version` 按各自判据(非空率、来源标注)验,不要求 jq 复算整条序列。本机全库四家的 `unknown_event_types` 都是空的(按本文的已知清单),所以建议(非强制)A6 也对每个真实样本断言 reader 与 oracle 的 `unknown_event_types` 都等于 `{}`,这样已知清单在两边错位会被发现。

**C6 `unknown_event_types` 的键。** 键 = 各家小节定义的「未知键格式」,值 = 该键出现的**行数**(块级未知按块数计)。已知集合见各家小节,**唯一来源是 §7 里 `unknown_event_types` 程序的 `k_*`/`known_*` 列表**(正文里的清单是从中抄出的,文档生成时已核对一致);reader 应从同一份清单生成,或在测试里断言相等。未知类型的行 `kind` 记 `unknown`,`raw_type` 取该键;**不抛错,不影响其它计数**。
`<malformed>` 与 `<no-type>`(C2)和各家未知键放在同一个 `unknown_event_types` 里。

**C7 `ignored_duplicate_kinds` 的键。** 键 = 各家小节列出的「重复键」,值 = 被忽略的行数。Codex、Kimi 的键对应同一事件的两种记录;Claude 只有一个键 `claude.sidechain_line`(主文件内联的侧链行,被整体跳过);Pi 不填。Claude、Pi 的**跨文件**重复不在这里计(见 C9)。各家都有 §7 的 jq 程序可复算(`*-ignored`),夹具上有期望值。

**C8 `oversized_lines`。** 单行字节数超过 `maxEventBytes` 的行。**口径要求**:计数不得因行超长而改变——reader 必须在丢弃文本前完成分类并计数,只截断/丢弃 `text`;oracle 不丢行。如果 reader 实现做不到(要整行解析才能分类),则 `oversized_lines > 0` 的文件**不得**用于 A6 比对(A6 必须在 `oversized_lines == 0` 的样本上比)。本机各家单行最大值:Claude 约 1.3 MB、Kimi 约 2.5 MB、Pi 约 4.0 MB,所以 `maxEventBytes` 默认值不够大时这条会真实触发。这是 §8 的 D3,**待设计者定**。

**C8 补充(B21/R3)。** reader 另有一个单行**硬上限 64 MiB**(UTF-8 字节,不含 `\n` 但含行尾 `\r`;`maxEventBytes` 不得超过它,否则 `read()` 直接报错)。超过硬上限的行不再累积正文,无法分类,不产出事件:计入 `oversized_lines`,并计入 `unknown_event_types["<line-too-large>"]`(不计 `<malformed>`,因为 jq 能解析它)。会话其余行照常读取。这类文件按 C8 的规则不得用于 A6 比对;A6 对 `unknown_event_types == {}` 的断言会直接发现它。

**C9 跨文件重复(已知,P0 不处理)。** Claude 续接(resume)会把旧历史复制进新文件(`uuid`、`tool_use.id` 相同,`sessionId` 被改写成新文件的):本机 42 个主文件里有 1922 个 `uuid`、355 个 `tool_use.id` 出现在多个文件里。Pi `/fork` 会把父会话条目复制进新文件(本机 808 个 `id` 出现在 9 个文件里)。P0 的计数**按文件**:①继承来的历史在每个后代文件里都重复计入,不做跨文件去重;②因此跨文件求和没有全局意义;③这对 A6(逐文件比对)没有影响,但会让跨文件汇总(P1 attest 的 `sessions_total`、`fired`)重复计数;④量级校准:Claude 1922 个 `uuid` / 42 个文件,Pi 808 个 `id` / 9 个文件。去重键:Claude 用 `uuid`,Pi 用条目 `id`(都需要跨文件索引)。这是 §8 的 D4。

**C10 活动文件。** 正在写入的会话文件计数会变。抽样一律排除最近 60 分钟内修改过的文件(§5);reader 对活动文件的结果是读取瞬间的快照。

**C11 `external_content`、`cwd_hint`、`loaded_rule_paths`。** 不属于计数口径,由 B11–B14 各自定,B10b 汇总。§4 只列已经看到的字段位置线索。

**C12 `NormEvent` 的 `text`。** 只在 reader→redactor 之间流动,本文不规定。`tool_name` 取各家工具名字段(见各节映射表)。

## 2. 四家口径

### 2.1 Claude Code

版本范围:本机主文件里出现过 2.1.250 到 2.1.293(`claude --version` = 2.1.294)。**逐行 schema 官方文档未读**;以下全部是本机 42 个主文件(约 22.5 万行)的结构归纳,没有官方文档背书。

#### 2.1.1 会话文件(`--source` = `~/.claude/projects`)

| 路径                                              | 是否会话 | 说明                                                                     |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `<项目目录>/<UUID>.jsonl`                         | 是       | 深度恰为 2,文件名匹配 `????????-????-????-????-????????????.jsonl`       |
| `<项目目录>/<UUID>/subagents/agent-*.jsonl`       | 否       | 子代理。本机约 720 个(随时间增加),每行 `isSidechain=true` 且有 `agentId` |
| `<项目目录>/<UUID>/tool-results/*`、`memory/*.md` | 否       | 非 JSONL 会话                                                            |
| `<插件目录>/<名字>.jsonl`(文件名不是 UUID)        | 否       | 非会话,不收                                                              |

`<项目目录>` 是工作目录路径把 `/` 换成 `-` 的结果。它含用户目录名,**不得写进任何落盘产物**,只用哈希。

主文件里的 `isSidechain` 本机全是 `false`(0 行为真)。但更老的 Claude Code 版本可能把子代理消息以 `isSidechain:true` 内联写进主文件(**本机无这类样本,未核实**),所以规则是:主文件里 `isSidechain==true` 的行整体跳过(不产出事件,不进 `user_messages`/`tool_calls`/`tool_failures`/`unknown_event_types`),只累加 `ignored_duplicate_kinds["claude.sidechain_line"]`。oracle 同样先过滤这些行。

#### 2.1.2 行 → 事件映射

顶层 `type` 的已知集合(本机观察到的 20 个):`user`、`assistant`、`attachment`、`system`、`queue-operation`、`permission-mode`、`mode`、`atis-latch`、`last-prompt`、`ai-title`、`frame-link`、`bridge-session`、`file-history-snapshot`、`artifact-autoreact-ledger`、`file-history-delta`、`artifact-comment-monitor`、`pr-link`、`agent-name`、`cost-state`、`continued-in`。

| 行                                             | 产出的 `NormEvent`                                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`,`message.content` 里有 `tool_result` 块 | 每个 `tool_result` 块一个 `tool_result` 事件;`tool_failed = (块.is_error === true)`;`tool_name` 取不到(靠 `tool_use_id` 回查,可选);同一行里的 `text`/`image` 块各产一个 `meta`(本机没有混合行) |
| `user`,无 `tool_result` 块,且满足 U0–U9        | 一个 `user_message`                                                                                                                                                                            |
| `user`,无 `tool_result` 块,不满足 U0–U9        | 一个 `meta`,`raw_type="user"`                                                                                                                                                                  |
| `assistant`,`content` 为字符串                 | 一个 `assistant_message`                                                                                                                                                                       |
| `assistant`,`content` 为数组                   | 每块一个事件:`text`→`assistant_message`;`tool_use`→`tool_call`(`tool_name=块.name`);`thinking`→`meta`(`raw_type="assistant.thinking"`);其它 → `unknown`                                        |
| 其余已知 `type`                                | 一个 `meta`                                                                                                                                                                                    |
| 未知 `type`                                    | 一个 `unknown`                                                                                                                                                                                 |

块级未知键:`assistant.<块type>`(已知 `text`、`thinking`、`tool_use`)、`user.<块type>`(已知 `text`、`image`、`tool_result`)。未知键格式:行级 = `type` 值,块级 = `<行type>.<块type>`;块缺 `type`(或不是字符串)记 `(none)`,即 `assistant.(none)`。

#### 2.1.3 三个计数

**tool_calls** = 所有 `type=="assistant"` 行的 `message.content` 数组里 `type=="tool_use"` 的块数(按**块**计,一行可有多块)。`tool_use.id` 在文件内唯一(本机 29114 个块 = 29114 个不同 id),不需要去重。

**tool_failures** = 所有 `type=="user"` 行的 `message.content` 数组里 `type=="tool_result"` 且 `is_error==true` 的块数。`is_error` 为 `false`、`null` 或缺失都不算失败。本机 `tool_result` 块数 = `tool_use` 块数(29114 = 29114),且 `is_error` 为真的 769 个里含 148 个权限拒绝(`toolDenialKind` 存在:`permission-rule`、`automode-blocked`、`user-rejected`、`automode-unavailable`),**按失败计**,不另外拆分。

**user_messages** = 满足下面全部条件(U0–U9)的 `type=="user"` 行数(每行至多计 1):

- U0 `message` 是对象且 `message.content` 是字符串或数组(`null`、缺失或其它形态不算)。
- U1 `message.content` 里没有 `tool_result` 块(字符串内容视为没有)。同一行既有 `tool_result` 又有 `text` 的混合行,整行不算用户消息(本机 `tool_result` 行的 `content` 恒为 1 个块,没有混合行)。
- U2 `isMeta != true`。
- U3 `isCompactSummary != true`。
- U4 `isVisibleInTranscriptOnly != true`。
- U5 没有 `interruptedMessageId` 字段(值非 null)。
- U6 没有 `scheduledTaskId` 字段(值非 null)。
- U7 `origin.kind`:`origin` 不是对象、或 `kind` 缺失/为 null 时视为 `"human"`;否则取 `kind` 的值,必须等于 `"human"`(其它任何值,包括非字符串,都不算)。本机 `kind` 的取值:`human`(1611 行)、`task-notification`(1484)、`peer`(267)、`auto-continuation`(5);另有 3.2 万个 user 行没有 `origin`(含所有 tool_result 行和旧版本的行)。
- U8 `turnOrigin`:缺失/为 null 时视为 `"human"`;否则必须等于 `"human"`。本机见过的非 human 值:`scheduled`、`task_notification`、`peer`、`system`、`auto_continuation`、`sdk`。
- U9 把 `message.content` 里 `type=="text"` 的块文本(字符串内容取原串)按换行拼接,拼接后的整串**不以**(允许前导空白)`<local-command-stdout`、`<local-command-caveat`、`[Request interrupted` 开头。检查对象是拼接后的整串,不是每个块。

要点:

- 缺 `origin` 和 `turnOrigin` 视为 human:旧版本,以及部分新版本里的斜杠命令行,不写这两个字段(本机 2.1.250 到 2.1.280 多个版本都有这样的人工输入行);
- 用户输入的斜杠命令(内容形如 `<command-name>…`)**算**用户消息;`<local-command-stdout>` 是命令输出,不算;
- 排队消息(`promptSource=="queued"`)、接受建议(`suggestion_accepted`)都是用户行为,算;
- `queue-operation` 行不算(它记录入队,真正的用户行随后出现);
- 本机 6 行带 `sessionKind` 字段的 user 行(后台会话)按上述规则会被计为用户消息,**语义未核实**(§8 D6)。

#### 2.1.4 重复、子代理、分支

- 子代理:见 §2.1.1,不计入。主会话里的 `Agent`/`Task` 调用是一次普通 `tool_use`。
- 同一次 API 回复会被拆成多行(`apiBlockIndex`),每个 `tool_use` 块只在一行里出现一次,不会重复计。
- 跨文件重复:见 C9。

#### 2.1.5 `ts` 与 `agent_version`

- `ts`:行内 `timestamp`(本机格式一律 `YYYY-MM-DDTHH:mm:ss.sssZ`);无时间戳的元数据行按 C3 回退。
- `agent_version`:按行序第一个非空字符串的 `version` 字段(首批元数据行没有该字段,第 2 行起有)。`agent_version_source="session_meta"`。本机 42/42 个主文件取得到。同一文件里版本会变(本机 1 个文件含 2 个版本,会话跨了一次升级),取第一个,变化不上报。
- 兜底:`claude --version` 的首个 `X.Y.Z` 片段(本机输出 `2.1.294 (Claude Code)`)。

### 2.2 Codex CLI

版本范围:本机 6509 个 rollout 的 `cli_version` 从 0.80.0 到 0.161.0(0.80.0 共 7 个,0.142.5 起连续)。**rollout 的完整 schema 官方文档未读**;以下是本机 4444 个主文件的结构归纳。**不同版本的事件集合差别很大**,所以每个口径都标了适用版本。

#### 2.2.1 会话文件(`--source` = `~/.codex/sessions`)

- 文件:`YYYY/MM/DD/rollout-<时间>-<id>.jsonl`。`~/.codex/archived_sessions/` 不在 `--source` 内,不读。
- 首行都是 `session_meta`(本机仅有的例外:1 个 0 字节新文件,忽略)。
- **侧链(子代理)判定**:首行 `session_meta.payload.source` 是对象且含 `subagent` 键。命令:`head -1 FILE | jq -e '((.payload.source | objects | has("subagent")) // false) | not'`,退出码 0 = 主会话。本机 6509 个文件里 2064 个是侧链、4444 个是主会话、1 个空文件。
  - 侧链文件带 `forked_from_id`、`parent_thread_id`、`subagent_history_start_ordinal`,文件前缀复制了父会话的历史;其中 669 个含 2 条 `session_meta`。所以侧链**整体排除**,不做前缀裁剪。
- 主会话的 `payload.source` 是字符串:`exec`(2545)、`mcp`(1267)、`vscode`(605)、`cli`(27);`payload.thread_source` 为 `user`、`automation` 或缺失。`exec`/`automation` 是脚本或定时任务发起的会话,**照样算会话**,它们的「用户消息」是脚本传入的提示词。

#### 2.2.2 同一事件的两种记录与取舍

Codex 把同一件事记两遍:`response_item`(模型对话历史)和 `event_msg/item_completed`(界面事件)。取舍如下,**以出现在所有版本里的为准**:

| 语义     | 计数用的记录(canonical)                                                                       | 被忽略的重复记录(`ignored_duplicate_kinds` 键)                                                                      |
| -------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 用户消息 | `event_msg/item_completed`,`item.type=="UserMessage"`                                         | `response_item.message.user`(`response_item` 的 `message` 且 `role=="user"`,**含**环境/AGENTS.md 等注入文本,不区分) |
| 助手消息 | `response_item` 的 `message`,`role=="assistant"`                                              | `event_msg.item_completed.AgentMessage`                                                                             |
| 推理     | `response_item.reasoning`(→ `meta`)                                                           | `event_msg.item_completed.Reasoning`                                                                                |
| 工具调用 | `response_item` 的 `function_call`、`custom_tool_call`、`web_search_call`、`tool_search_call` | `event_msg.item_completed.WebSearch`、`event_msg.item_completed.ImageView`                                          |
| 工具结果 | `event_msg/item_completed` 的工具类 item(见 §2.2.5)→ `tool_result`                            | (`*_call_output` 行记为 `meta`,它们没有状态位)                                                                      |

取舍依据(本机实测,仅给计数):对全部 4444 个主会话文件,`UserMessage` 数与「`response_item` 里非注入的 `role=="user"` 消息数」逐文件相等的占 99.8% 以上,其余 5 个文件后者多 1(推测是中断的回合,未核实);`web_search_call` 数 = `WebSearch` item 数(各 1371)。选 `item_completed(UserMessage)` 是因为它不混入注入的环境/AGENTS.md 文本,不需要靠文本前缀判断。`item_completed(UserMessage)` 在 0.80.0 到 0.161.0 全版本都有。

#### 2.2.3 行 → 事件映射

已知集合:

- 顶层 `type`:`session_meta`、`response_item`、`event_msg`、`turn_context`、`world_state`、`token_usage_record`、`compacted`、`inter_agent_communication_metadata`。
- `response_item.payload.type`:`reasoning`、`message`、`custom_tool_call`、`custom_tool_call_output`、`function_call`、`function_call_output`、`agent_message`、`web_search_call`、`tool_search_call`、`tool_search_output`。
- `event_msg.payload.type`:`token_count`、`item_completed`、`task_started`、`task_complete`、`thread_settings_applied`、`turn_aborted`。
- `item_completed` 的 `item.type`:`Reasoning`、`AgentMessage`、`UserMessage`、`CommandExecution`、`SubAgentActivity`、`FileChange`、`CollabAgentToolCall`、`McpToolCall`、`WebSearch`、`ContextCompaction`、`ImageView`、`Plan`、`DynamicToolCall`。

未知键格式:顶层未知 = `type` 值;`response_item` 未知 = `response_item.<payload.type>`;`event_msg` 未知 = `event_msg.<payload.type>`;`item_completed` 未知 = `event_msg.item_completed.<item.type>`;缺 `payload.type` 记 `(none)`。

| 行                                                                                                                     | `NormEvent.kind`                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `item_completed`,`UserMessage`                                                                                         | `user_message`                                                                    |
| `response_item.message`,`role=="assistant"`                                                                            | `assistant_message`                                                               |
| `response_item.message`,其它 role(`user`、`developer`)                                                                 | `meta`(`user` 同时计 `response_item.message.user`)                                |
| `response_item` 的 4 种调用                                                                                            | `tool_call`(`tool_name=payload.name`,两个 search 取 `web_search` / `tool_search`) |
| `item_completed`,`item.type` ∈ {`CommandExecution`,`FileChange`,`McpToolCall`,`DynamicToolCall`,`CollabAgentToolCall`} | `tool_result`,`tool_failed = (status === "failed")`                               |
| `item_completed`,`Reasoning`/`AgentMessage`/`WebSearch`/`ImageView`                                                    | 不产出事件,只累加 `ignored_duplicate_kinds`                                       |
| `item_completed`,`SubAgentActivity`/`ContextCompaction`/`Plan`                                                         | `meta`                                                                            |
| 其余已知行(含 `response_item.agent_message`、各 `*_call_output`)                                                       | `meta`                                                                            |
| 未知                                                                                                                   | `unknown`                                                                         |

#### 2.2.4 三个计数中的两个

**user_messages** = `type=="event_msg"` 且 `payload.type=="item_completed"` 且 `payload.item.type=="UserMessage"` 的行数。

**tool_calls** = `type=="response_item"` 且 `payload.type` ∈ {`function_call`,`custom_tool_call`,`web_search_call`,`tool_search_call`} 的行数。

- 包含协作类调用(`spawn_agent`、`wait_agent`、`send_message` 等,`namespace` 为 `collaboration`)、MCP 调用(`mcp__*` 命名空间)、`update_plan`、`write_stdin`、`wait`:它们都是模型发起的调用,一律计。
- `custom_tool_call` 的 `exec`(本机 6.3 万个)是 JS 包装器,里面嵌套的命令会另外产生 `CommandExecution` 事件;这些嵌套命令**不**另计为调用(`CommandExecution` 条数因此可以大于调用数)。
- `*_call_output`、`tool_search_output` 不是调用。本机 `function_call` 与 `function_call_output` 差 7(50793/50786),不影响本口径。
- 调用类型清单是否穷尽:本机 4444 个主会话里 `response_item.payload.type` 以 `_call` 结尾的只有这 4 种(`function_call`、`custom_tool_call`、`web_search_call`、`tool_search_call`);`local_shell_call` 等其它名字零样本,若新版本出现会落入 `response_item.<名字>` 未知键,不会被静默计入也不会被静默丢掉。
- 用户消息的中断情形:回合在 `item_completed` 写出之前中断时,可能只有 `response_item` 里的用户消息而没有 `UserMessage` 事件(本机 5/4444 个文件,每个差 1),本口径**接受**这一缺口,不补数。

#### 2.2.5 tool_failures:没有跨版本稳定字段(待设计者定,§8 D1)

**定义(结构化,保守):** `type=="event_msg"` 且 `payload.type=="item_completed"` 且 `payload.item.type` ∈ {`CommandExecution`,`FileChange`,`McpToolCall`,`DynamicToolCall`,`CollabAgentToolCall`} 且 `payload.item.status=="failed"` 的行数。`status` 的其它值(`completed`、`declined`)都不算失败。

这是**下界**:读到的失败一定是失败,读不到不代表没有失败。`function_call_output`/`custom_tool_call_output` 的键只有 `call_id`、`id`、`output`、`type` 等,没有 `status`/`success`/`exit_code`,所以 `response_item` 一侧没有可用的结构化状态位;`WebSearch`、`ImageView`、`Reasoning`、`AgentMessage`、`UserMessage` 等 item 没有 `status` 键,所以不在失败类型集合里,即使将来加了也不计(新增类型 = 修订本文)。**明文禁止**用 `output` 文本里的退出码字样补数(不同版本格式不同、受语言环境影响,且「非零退出」不等于「工具失败」)。

**覆盖范围(本机实测):**

| 失败来源                       | 起始版本(本机最早样本) | 说明                                                                                                       |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `McpToolCall` 的 `failed`      | 0.142.5                | MCP 调用失败                                                                                               |
| `CommandExecution` 的 `failed` | 0.149.0-alpha.4.3      | shell 命令失败(`exit_code` 非 0);0.147.0 里只有 8 个文件带 `CommandExecution`                              |
| 0.142.5 的 shell 失败          | 无结构化字段           | 只能从 `function_call_output.output` 文本里的 `Process exited with code N` 推断(文本启发式,**本文不采用**) |
| 0.147.x 的 shell 失败          | **不可判定**           | `custom_tool_call_output.output` 变成 block 数组,没有退出码;`function_call_output` 文本无稳定标记          |
| 0.80.0                         | 无结构化字段           | 输出是 JSON 串带 `metadata.exit_code`,但全库只有 7 个文件,不采用                                           |

数字:4444 个主文件里 3111 个含 `function_call`/`custom_tool_call`,其中只有 796 个(约 26%)带 `CommandExecution` 事件。**也就是说,约 74% 的有工具调用的 Codex 会话,shell 失败数恒为 0,不是「没失败」而是「看不见」。**

对 A6 的影响:reader 与 oracle 用同一定义,必然相等,所以 A6 不会红;但如果样本全落在 0.149 以前,`tool_failures` 两边都是 0,比对是空的(负向断言静默变空)。因此:

- Codex 样本必须满足**正向控制**:5 个样本里至少 1 个 `tool_failures > 0`,且至少 1 个来自 `CommandExecution`(`cli_version >= 0.149`);选法见 §5。
- 汇报里 Codex 的 `tool_failures` 一律标「结构化口径,0.149 以前不可判定」,不得宣称覆盖全部失败。

#### 2.2.6 `ts` 与 `agent_version`

- `ts`:每行顶层 `timestamp`(`YYYY-MM-DDTHH:mm:ss.sssZ`),本机所有行都有。`started_at` = 首行 `session_meta.payload.timestamp`。
- `agent_version`:首行 `session_meta.payload.cli_version`(字符串,含 `-alpha.N` 后缀的预发布版本,原样保留)。`session_meta`。本机除空文件外 100% 有。
- 兜底:`codex --version` 的首个 `X.Y.Z[-…]` 片段(本机 `codex-cli 0.161.0`)。

### 2.3 Pi

版本:`pi --version` = 0.87.1。会话头里的 `version: 3` 是**会话文件格式版本**,不是 Pi 版本。格式文档:`@earendil-works/pi-coding-agent/docs/session-format.md`(已读),本机 188 个会话文件与文档一致,另有文档里有而本机零样本的条目类型(见 §2.3.2)。

#### 2.3.1 会话文件(`--source` = `~/.pi/agent/sessions`)

- 文件:`--<路径>--/<时间>_<uuid>.jsonl`;同目录树下还有 9 个非 JSONL 文件,不收。
- 首行 `{"type":"session","version":3,"id","timestamp","cwd"[,"parentSession"]}`,是头,不是树节点(无 `id`/`parentId`),不产出事件。
- 其余行是树节点:`id`、`parentId`、`timestamp`(ISO 字符串)、`type`。
- 没有独立的子代理文件;子代理活动以 `custom_message`(`subagent-notify` 等)和 `custom` 条目出现,按 `meta` 处理,不计数。
- `/fork` 产生的新文件头带 `parentSession`(本机 16 个),并复制父会话条目(C9)。

#### 2.3.2 行 → 事件映射

已知集合:

- 条目 `type`:`session`、`message`、`custom_message`、`context_edit`、`custom`、`model_change`、`thinking_level_change`、`compaction`、`session_info`;文档里有、本机零样本:`usage`、`branch_summary`、`label`。
- `message.role`:本机 `system`、`user`、`assistant`、`toolResult`;文档里有、本机零样本:`bashExecution`、`custom`、`branchSummary`、`compactionSummary`。
- 内容块 `type`:`text`、`thinking`、`toolCall`、`image`。

未知键格式:条目 = `type` 值;role = `message.<role>`,`role` 缺失记 `message.(none)`;块 = `message.<role>.<块type>`(只检查 `user`、`assistant`、`toolResult`),块缺 `type` 记 `(none)`。

| 行                                                                                        | `NormEvent.kind`                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `message`,`role=="user"`                                                                  | `user_message`                                                                                                         |
| `message`,`role=="assistant"`                                                             | 每块一个事件:`text`→`assistant_message`;`toolCall`→`tool_call`(`tool_name=块.name`);`thinking`→`meta`;其它 → `unknown` |
| `message`,`role=="toolResult"`                                                            | `tool_result`,`tool_failed = (isError === true)`,`tool_name=message.toolName`                                          |
| `message`,`role` 为 `system`/`bashExecution`/`custom`/`branchSummary`/`compactionSummary` | `meta`(`bashExecution` 是用户手敲的 `!` 命令,不是模型工具调用,**不计**)                                                |
| 其余已知条目 `type`                                                                       | `meta`                                                                                                                 |
| 未知                                                                                      | `unknown`                                                                                                              |

#### 2.3.3 三个计数

**user_messages** = `type=="message"` 且 `message.role=="user"` 的条目数。`custom_message`(目标/后台任务/子代理通知等扩展注入)**不算**用户消息。

**tool_calls** = `type=="message"` 且 `message.role=="assistant"` 的条目里,`message.content` 数组中 `type=="toolCall"` 的块数。

**tool_failures** = `type=="message"` 且 `message.role=="toolResult"` 且 `message.isError==true` 的条目数。

本机 `toolCall` 块 7709 个、`toolResult` 条目 7672 个(16 个文件两者不等,推测是调用没拿到结果就被中断,未核实),所以**调用数与结果数不要求相等**。

#### 2.3.4 树分支与 `branch_count`

- 计数覆盖文件内**全部** `message` 条目,**包括被放弃分支上的**:那些工具确实执行过,那些用户消息确实输入过。
- `branch_count`(`Counts.branch_count`,Q-N10)= 不在**活动链**上的条目数。活动链 = 从文件里**最后一个带字符串 `id` 的条目**沿 `parentId` 一路走到根(`parentId` 为 `null` 或指向不存在的 id 时停止)。所有带字符串 `id` 的条目类型都计(不只是 `message`);头不是条目;没有字符串 `id` 的行不是树节点,既不在链上也不计分支(本机 0 个)。
- 「最后一个条目 = 当前叶子」是**假设**:Pi 不把叶子位置写进文件,文档只说叶子是内存中的当前位置(`getLeafId()`)。所以 `branch_count` 对**写入顺序敏感**:若文件最后一次追加落在某个分支上,原来的主链会被记作分支;这是本口径固有的,不是缺陷。
- 边界:`parentId` 指向文件里不存在的 `id`(断链)时,链在该点终止;同一文件里 `id` 重复时,后出现的条目覆盖先出现的父子关系(不报错);多个根(`parentId` 为 `null` 的条目不止一个)时,不在活动链上的根及其后代全算分支;`parentId` 成环(自指、a↔b)时,沿链最多走「条目数 + 1」步后停止,等同断链,程序不会死循环。
- `(user_messages, tool_calls, tool_failures, branch_count)` 四个数**不能**反推活动链上各指标的值;需要活动链口径时是 P1 的事(§8 D5)。
- 本机 188 个文件全是单链:`branch_count` 恒为 0,没有一个真实的分支样本,**分支口径只在合成夹具上验证过,真实数据上未核实**。并行工具结果在本机是串成一条链的(第二个 `toolResult` 的 `parentId` 是第一个),不是兄弟节点。
- 其它 agent 的 `branch_count` 缺省(不填)。

#### 2.3.5 `ts` 与 `agent_version`

- `ts`:条目顶层 `timestamp`(ISO 字符串);`message.timestamp` 是毫秒数,**不用**。本机所有条目都有。`started_at` = 头的 `timestamp`。
- `agent_version`:**会话文件里没有**。头 `version` 是格式版本(3);也没有其它含 Pi 版本的字段。一律 `collector_fallback`:`pi --version`(本机 `0.87.1`)。

### 2.4 Kimi Code

版本:`kimi --version` = 2.0.0。`wire.jsonl` 首行 `{"type":"metadata","protocol_version":"1.4"|"1.5","created_at":<毫秒>}`,协议版本不是 CLI 版本。官方文档对 wire 事件没有逐行说明,以下全部是本机 152 个主文件的结构归纳。

#### 2.4.1 会话文件(`--source` = `~/.kimi-code/sessions`)

- 主会话:`<wd 键>/<session_xxx>/agents/main/wire.jsonl`(本机 152 个)。`<wd 键>` 形如 `wd_<目录名>_<哈希>`,含目录名,**只用哈希**。
- 子代理:`.../agents/agent-<N>/wire.jsonl`(本机 88 个),不是会话,不收。它们里面没有 `origin.kind=="user"` 的消息。
- 同级的 `state.json`、`notify/`、`logs/`、`media/` 不是 wire,不读来计数。
- 主 wire 的行带 `agentId` 时恒为 `"main"`(1.5 协议),缺省为 1.4 协议。**两个条件同时成立才收**:文件路径是 `agents/main/wire.jsonl`,且行的 `agentId` 缺失或为 `"main"`(防御性规则;本机无例外)。`agents/agent-N/wire.jsonl` 里即使有 `agentId:"main"` 的行也不收。

#### 2.4.2 行 → 事件映射

已知顶层 `type`(本机主文件观察到的 53 个,完整清单见 §7.4 的 `unknown_event_types` 程序里的 `k_top`):`metadata`、`context.append_loop_event`、`context.append_message`、`llm.request`、`usage.record`、`turn.prompt`、`turn.steer`、`turn.ended`、`prompt.completed`、`prompt.accepted` 等。未知键:顶层未知 = `type` 值;`context.append_loop_event` 的未知子类型 = `context.append_loop_event.<event.type>`(已知 `content.part`、`step.begin`、`step.end`、`tool.call`、`tool.result`)。

| 行                                                                                                                                   | `NormEvent.kind`                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `context.append_message`,`message.role=="user"` 且 `message.origin.kind=="user"`                                                     | `user_message`                                                                |
| `context.append_message`,其它(`injection`、`system_trigger`、`background_task`、`task`、`skill_activation` 来源,或 `role=="system"`) | `meta`                                                                        |
| `context.append_loop_event`,`event.type=="content.part"`,`event.part.type=="text"`                                                   | `assistant_message`                                                           |
| 同上,`part.type=="think"`                                                                                                            | `meta`                                                                        |
| `context.append_loop_event`,`event.type=="tool.call"`                                                                                | `tool_call`(`tool_name=event.name`)                                           |
| `context.append_loop_event`,`event.type=="tool.result"`                                                                              | `tool_result`,`tool_failed = (event.result.isError === true)`                 |
| `turn.prompt`、`turn.steer` 且 `origin.kind=="user"`                                                                                 | 不产出事件,只累加 `ignored_duplicate_kinds["turn.prompt"]` / `["turn.steer"]` |
| 其余已知 `type`                                                                                                                      | `meta`                                                                        |
| 未知                                                                                                                                 | `unknown`                                                                     |

`turn.prompt` 与 `context.append_message(user)` 是同一次用户输入的两种记录;`turn.steer`(用户在回合中途插话)只在 `append_message` 里有对应的用户消息。所以以 `append_message` 为准:本机 152 个主文件里 `append_message` 用户消息 329 条,`turn.prompt` 用户来源 327 条,差的正是 steer。

#### 2.4.3 三个计数

**user_messages** = `type=="context.append_message"` 且 `message.role=="user"` 且 `message.origin.kind=="user"` 的行数(`origin` 里可能带 `clientMetadata`,不影响)。`origin` 缺失、不是对象、或 `kind` 是任何其它值(含未来新值)都**不算**用户消息,也不进 `unknown_event_types`(它们是已知 `type` 下的值,按 `meta` 处理)。

**tool_calls** = `type=="context.append_loop_event"` 且 `event.type=="tool.call"` 的行数。`toolCallId` 在文件内唯一(本机 2880 = 2880),与 `tool.result` 一一对应。

**tool_failures** = `type=="context.append_loop_event"` 且 `event.type=="tool.result"` 且 `event.result.isError==true` 的行数。`isError` 键**只在失败时出现**(值为 `true`),成功时没有该键。

已知未核实的边界:`context.undo`/`context.undone`(本机各 1 条)和压缩(`context.apply_compaction`,3 条)是否让已计入的消息「撤销」,本文**不撤销**,按出现过计。

#### 2.4.4 `ts` 与 `agent_version`

- `ts`:行内 `time`(毫秒数);首行 `metadata` 用 `created_at`。无效值按 C3 回退。`started_at` = 第一个有效时间。
- `agent_version`:**会话里没有**。`state.json.version` 是数字(2,状态文件格式版本),`metadata.protocol_version` 是协议版本。一律 `collector_fallback`:`kimi --version`(本机 `2.0.0`)。

## 3. 各家 `agent_version` 来源总表

| Agent  | 来源字段                                | `agent_version_source` | 取不到时                |
| ------ | --------------------------------------- | ---------------------- | ----------------------- |
| Claude | 按行序第一个非空字符串的 `.version`     | `session_meta`         | `claude --version` 兜底 |
| Codex  | 首行 `session_meta.payload.cli_version` | `session_meta`         | `codex --version` 兜底  |
| Pi     | 无                                      | `collector_fallback`   | `pi --version`          |
| Kimi   | 无                                      | `collector_fallback`   | `kimi --version`        |

兜底规则:

1. 一次 `signals collect` 运行内,每个 agent 只执行一次 `<cli> --version`(不是每个会话一次),只读 stdout(忽略 stderr),取输出里第一个匹配 `[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?` 的片段(前导 `v`、`codex-cli `、尾部括号说明都不属于版本串,如 `2.1.294 (Claude Code)` → `2.1.294`)。
   **格式版本字段不得当作 CLI 版本**:Pi 头的 `version`(3)、Kimi `state.json` 的 `version`(2)、Kimi `metadata.protocol_version`(1.4/1.5)都不是。Codex 在同一文件有多条 `session_meta`(仅侧链文件)时取第一条,但侧链文件本来就不收。
2. 兜底值是**采集时**的 CLI 版本,不一定是产生会话时的版本;所以必须标 `collector_fallback`,`agent_version_fallback_ratio`(`CollectReport`)按此计。
3. CLI 不存在或输出里匹配不到:`agent_version` 取字面量 `"unknown"`,来源仍标 `collector_fallback`(`Signal.agent_version` 要求非空串,所以不能留 `null`)。是否为此加枚举值,见 §8 D2。
4. A6 的判据(设计 §10 P0 验收 6):兜底后非空率 100%,且每个样本的来源取值与本表一致——即 Claude/Codex 样本应为 `session_meta`,Pi/Kimi 样本应为 `collector_fallback`。

## 4. 其它 `SessionMeta` 字段的位置线索(非计数口径)

| 字段                | Claude                                           | Codex                      | Pi                                              | Kimi                                                            |
| ------------------- | ------------------------------------------------ | -------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `cwd_hint`          | 行内 `cwd`(同一文件里会变,取第一个有 `cwd` 的行) | `session_meta.payload.cwd` | 头 `cwd`                                        | 同级 `state.json` 的 `cwd`(旧版为 `workDir`)                    |
| `loaded_rule_paths` | 未发现专用字段                                   | 未发现专用字段             | 系统消息 `sections.project_context`(结构未核实) | `profile.bind` 行的顶层 `agentsMdPaths` 数组(本机 132 个文件有) |

这些字段由 B11–B14 核实后实现,本文不规定。

## 5. 抽样规则(可复现)

目标:每个 agent 5 个样本,`inventory/reader-samples.txt` 只记路径的 sha256 和行数。以下命令在本机跑通,**输出不得贴进任何文档**(路径含用户目录和项目名)。

```sh
# 候选:确定性排序;排除最近 60 分钟内改动过的文件(正在写入,C10);Codex 同时排除侧链
sample_candidates() { # $1=agent  $2=--source 目录
  local agent="$1" src="$2"
  case "$agent" in
    claude) find "$src" -mindepth 2 -maxdepth 2 -type f -name '????????-????-????-????-????????????.jsonl' -mmin +60 ;;
    pi)     find "$src" -type f -name '*.jsonl' -mmin +60 ;;
    kimi)   find "$src" -type f -path '*/agents/main/wire.jsonl' -mmin +60 ;;
    codex)  find "$src" -type f -name 'rollout-*.jsonl' -mmin +60 | LC_ALL=C sort | while IFS= read -r f; do
              head -1 "$f" | jq -e '((.payload.source | objects | has("subagent")) // false) | not' >/dev/null 2>&1 && printf '%s\n' "$f"
            done ;;
  esac | LC_ALL=C sort
}
# 行数窗口:[MIN, MAX]
sample_window() { local min="$1" max="$2" f n; while IFS= read -r f; do n=$(wc -l < "$f" | tr -d ' '); [ "$n" -ge "$min" ] && [ "$n" -le "$max" ] && printf '%s\n' "$f"; done; }
# 取样:sample_candidates <agent> <src> | sample_window 50 5000 | head -5
```

规则:

1. **范围**:`<src>` 就是 `--source`;B16 在此基础上再按「允许项目」过滤(Claude/Pi 看项目目录名,Kimi 看 `wd_` 目录名,Codex 看 `session_meta.payload.cwd`),被排除目录一律不入样。过滤用目录名/路径匹配,过滤后仍按同样的排序取。
2. **取前 5 个**满足行数窗口 `[50, 5000]` 的文件(`LC_ALL=C` 字典序;行数一律以 `wc -l` 为准,只数换行符,末行没有换行符时少算 1,对样本选取无影响)。某 agent 不足 5 个时放宽下限并在清单文件头声明。
3. **正向控制**:5 个样本里每个计数(`user_messages`、`tool_calls`、`tool_failures`)都必须至少有 1 个样本 > 0。按 `tool_calls`、`tool_failures`、`user_messages` 的顺序逐个检查;某个计数全为 0 时,把当前排在最后的样本替换为「排序里下一个满足窗口且该计数 > 0 的文件」,不回头重查已检查过的计数,替换逐条写进清单文件头;全部检查完仍有计数全为 0 时,在文件头声明。Codex 额外要求至少 1 个样本含 `status=="failed"` 的 `CommandExecution` 事件(§7.2 的第三条命令输出 > 0;按内容判定,不按版本号判定)。
4. **超长行**:样本里 `LC_ALL=C awk '{ if (length($0)>m) m=length($0) } END{print m+0}' FILE` 超过 reader 的 `maxEventBytes` 时,按 C8 该样本不得用于 A6,顺延取下一个。
5. 验收前把 5×4 个样本复制到只读临时目录(`chmod -R a-w`),`--source` 指向该副本(plan A6)。

本机按以上规则取到的前几个 Codex 样本都来自 0.142.5 的 vscode 对话,`tool_calls` 与 `tool_failures` 均为 0——这正是要求第 3 条的原因。

## 6. 口径细则补充

### 6.1 `Counts` 字段对照

| `Counts` 字段             | Claude                  | Codex              | Pi     | Kimi                        |
| ------------------------- | ----------------------- | ------------------ | ------ | --------------------------- |
| `user_messages`           | §2.1.3                  | §2.2.4             | §2.3.3 | §2.4.3                      |
| `tool_calls`              | §2.1.3                  | §2.2.4             | §2.3.3 | §2.4.3                      |
| `tool_failures`           | §2.1.3                  | §2.2.5(受限)       | §2.3.3 | §2.4.3                      |
| `unknown_event_types`     | §2.1.2                  | §2.2.3             | §2.3.2 | §2.4.2                      |
| `ignored_duplicate_kinds` | `claude.sidechain_line` | 见 §2.2.2 的重复键 | 不填   | `turn.prompt`、`turn.steer` |
| `branch_count`            | 不填                    | 不填               | §2.3.4 | 不填                        |
| `oversized_lines`         | C8                      | C8                 | C8     | C8                          |

### 6.2 `unknown_event_types` 与「已知集合」的维护

已知集合就是各家 oracle 的 `k_*` / `known_*` 列表。新版本引入新类型时,先落到 `unknown`(这是预期行为,不是缺陷),由人确认是否加入已知集合;**加入已知集合是修订本文**,reader 与 oracle 同步改。

### 6.3 与 `NormEvent` 契约的接缝

- `NormEvent.raw_type`:行级 = 上述未知键同格式(已知行也用同格式的键,例如 Codex 的 `event_msg.item_completed.UserMessage`、Claude 的 `user`);块级 = `<行type>.<块type>`。
- `NormEvent.tool_failed`:只在 `tool_result` 事件上设置(`true`/`false`);Claude 的 `is_error` 缺失时设 `false`;Codex 工具类 `item_completed` 设 `status === "failed"`。`tool_call` 事件不设。

## 7. oracle:每个口径一条 jq 命令

约定:`FILE` 是单个会话文件;一律 `jq -nRc '<程序>' FILE`,逐行读,不整文件载入(Pi 的 `branch_count` 例外,需要整树)。程序对畸形行、空白行、非对象行的处理与 C2 一致。输出是 JSON:三个计数,或 `unknown_event_types` 对象,或一个整数。

### 7.1 Claude

```sh
jq -nRc 'def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object") | select(.isSidechain != true);
def blocks: (.message | objects | .content | arrays) // [];
def okind: ([.origin | objects | .kind] | .[0]) | if . == null then "human" else . end;
def tkind: .turnOrigin | if . == null then "human" else . end;
def txt: (.message | objects | .content | if type=="string" then . elif type=="array" then ([.[] | objects | select(.type=="text") | (.text | strings)] | join("\n")) else "" end) // "";
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="user" then
    ($l | blocks | map(objects | select(.type=="tool_result"))) as $tr
    | .tool_failures += ($tr | map(select(.is_error==true)) | length)
    | if ($tr|length)==0
         and ((($l | .message | objects | .content | type) // "none") | IN("string","array"))
         and $l.isMeta != true and $l.isCompactSummary != true and $l.isVisibleInTranscriptOnly != true
         and $l.interruptedMessageId == null and $l.scheduledTaskId == null
         and (($l | okind) == "human")
         and (($l | tkind) == "human")
         and (($l | txt | test("^\\s*(<local-command-stdout|<local-command-caveat|\\[Request interrupted)")) | not)
      then .user_messages += 1 else . end
  elif $l.type=="assistant" then
    .tool_calls += ($l | blocks | map(objects | select(.type=="tool_use")) | length)
  else . end)' FILE
```

`unknown_event_types`:

```sh
jq -nRc 'def known_line: ["user","assistant","attachment","system","queue-operation","permission-mode","mode","atis-latch","last-prompt","ai-title","frame-link","bridge-session","file-history-snapshot","artifact-autoreact-ledger","file-history-delta","artifact-comment-monitor","pr-link","agent-name","cost-state","continued-in"];
def known_block: {"assistant":["text","thinking","tool_use"],"user":["text","image","tool_result"]};
def keys_of: (.type | strings) as $t
  | if (known_line | index($t)) == null then [$t]
    elif $t=="user" or $t=="assistant" then
      [ (.message | objects | .content | arrays | .[] | objects | ((.type | strings) // "(none)")) as $b
        | select((known_block[$t] | index($b)) == null) | "\($t).\($b)" ]
    else [] end;
reduce (inputs | select(test("\\S")) | ((fromjson? | select(type=="object")) // "<malformed>")) as $l ({};
  if $l == "<malformed>" then .["<malformed>"] += 1
  elif $l.isSidechain == true then .
  elif ($l.type | type) != "string" then .["<no-type>"] += 1
  else reduce ($l | keys_of)[] as $k (.; .[$k] += 1) end)' FILE
```

`ignored_duplicate_kinds`(侧链行):

```sh
jq -nRc 'reduce (inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object") | select(.isSidechain == true)) as $l ({}; .["claude.sidechain_line"] += 1)' FILE
```

合成夹具(`claude.jsonl`)。第 14 行是被截断的 JSON,第 15 行是空白行(原夹具里带空格,Markdown 会吃掉行尾空格,不影响结果):

```jsonl
{"type":"mode","mode":"default","sessionId":"S1"}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:01.000Z","version":"2.1.0","sessionId":"S1","cwd":"/w/p","message":{"role":"user","content":"hello"}}
{"type":"assistant","isSidechain":false,"timestamp":"2026-01-01T00:00:02.000Z","version":"2.1.0","sessionId":"S1","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"t1","name":"Bash","input":{}},{"type":"tool_use","id":"t2","name":"Read","input":{}}]}}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:03.000Z","version":"2.1.0","sessionId":"S1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"x"},{"type":"tool_result","tool_use_id":"t2","content":"y"}]}}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:04.000Z","version":"2.1.0","sessionId":"S1","isMeta":true,"message":{"role":"user","content":"meta"}}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:05.000Z","version":"2.1.0","sessionId":"S1","origin":{"kind":"task-notification"},"message":{"role":"user","content":"n"}}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:06.000Z","version":"2.1.0","sessionId":"S1","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:07.000Z","version":"2.1.0","sessionId":"S1","origin":{"kind":"human"},"turnOrigin":"human","message":{"role":"user","content":[{"type":"text","text":"second"}]}}
{"type":"user","isSidechain":true,"timestamp":"2026-01-01T00:00:08.000Z","message":{"role":"user","content":"side"}}
{"type":"weird-new-type","timestamp":"2026-01-01T00:00:09.000Z"}
{"type":"assistant","isSidechain":false,"timestamp":"2026-01-01T00:00:10.000Z","message":{"role":"assistant","content":[{"type":"server_tool_use","id":"z"}]}}
{"type":"assistant","isSidechain":false,"timestamp":"2026-01-01T00:00:10.500Z","message":{"role":"assistant","content":[{"text":"block without type"}]}}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:11.500Z","message":"not-an-object-content-shape"}
{"type":"user","isSidechain":false,"timestamp":"2026-01-01T00:00:11.000Z"

```

期望:`{"user_messages":2,"tool_calls":2,"tool_failures":1}`;`unknown_event_types` = `{"weird-new-type":1,"assistant.server_tool_use":1,"assistant.(none)":1,"<malformed>":1}`;`ignored_duplicate_kinds` = `{"claude.sidechain_line":1}`。逐行判定:

| 行  | 判定                                                                             |
| --- | -------------------------------------------------------------------------------- |
| 1   | `mode`:`meta`,无时间戳,`ts` 回退到第 2 行的时间                                  |
| 2   | 用户消息(#1)                                                                     |
| 3   | assistant:一个 `text`,两个 `tool_use`(`tool_calls` +2)                           |
| 4   | 两个 `tool_result`,其中一个 `is_error:true`(`tool_failures` +1);不是用户消息(U1) |
| 5   | `isMeta:true`:不是(U2)                                                           |
| 6   | `origin.kind` 为 `task-notification`:不是(U7)                                    |
| 7   | 文本以 `[Request interrupted` 开头:不是(U9)                                      |
| 8   | `origin.kind:"human"` 且 `turnOrigin:"human"`:用户消息(#2)                       |
| 9   | `isSidechain:true`:跳过                                                          |
| 10  | 未知顶层类型 `weird-new-type`                                                    |
| 11  | assistant 里的未知块 `server_tool_use`(不计调用)                                 |
| 12  | assistant 里的块缺 `type`:未知键 `assistant.(none)`                              |
| 13  | `message` 是字符串(不是对象):不是用户消息(U0),也不报未知                         |
| 14  | 畸形行(被截断的 JSON)                                                            |
| 15  | 空白行,忽略                                                                      |

真实样本(取自 §5 的规则,**取该规则排序后的第一个满足窗口的文件**,路径哈希前 12 位 `aca55482e865`,620 行,2026-10-08):oracle 输出 `{"user_messages":4,"tool_calls":78,"tool_failures":2}`;独立交叉:`grep -o '"type":"tool_use"' FILE | wc -l` = 78,`grep -o '"is_error":true' FILE | wc -l` = 2,另用 `jq -c select(...)` 管道重算用户消息 = 4。

### 7.2 Codex

```sh
jq -nRc 'def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object");
def p: (.payload | objects) // {};
def it: (p.item | objects) // {};
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="event_msg" and ($l|p.type)=="item_completed" then
    (if ($l|it.type)=="UserMessage" then .user_messages += 1 else . end)
    | (if ($l|it.status)=="failed" and (($l|it.type) | IN("CommandExecution","FileChange","McpToolCall","DynamicToolCall","CollabAgentToolCall")) then .tool_failures += 1 else . end)
  elif $l.type=="response_item" and (($l|p.type) | IN("function_call","custom_tool_call","web_search_call","tool_search_call")) then .tool_calls += 1
  else . end)' FILE
```

`unknown_event_types`:

```sh
jq -nRc 'def k_top: ["session_meta","response_item","event_msg","turn_context","world_state","token_usage_record","compacted","inter_agent_communication_metadata"];
def k_resp: ["reasoning","message","custom_tool_call","custom_tool_call_output","function_call","function_call_output","agent_message","web_search_call","tool_search_call","tool_search_output"];
def k_evt: ["token_count","item_completed","task_started","task_complete","thread_settings_applied","turn_aborted"];
def k_item: ["Reasoning","AgentMessage","UserMessage","CommandExecution","SubAgentActivity","FileChange","CollabAgentToolCall","McpToolCall","WebSearch","ContextCompaction","ImageView","Plan","DynamicToolCall"];
def key_of: (.type | strings) as $t | ((.payload | objects) // {}) as $p
  | if (k_top | index($t)) == null then $t
    elif $t=="response_item" then (($p.type | strings) // "(none)") as $x | if (k_resp | index($x)) == null then "response_item.\($x)" else empty end
    elif $t=="event_msg" then (($p.type | strings) // "(none)") as $x
      | if (k_evt | index($x)) == null then "event_msg.\($x)"
        elif $x=="item_completed" then (((($p.item | objects) // {}).type | strings) // "(none)") as $i | if (k_item | index($i)) == null then "event_msg.item_completed.\($i)" else empty end
        else empty end
    else empty end;
reduce (inputs | select(test("\\S")) | ((fromjson? | select(type=="object")) // "<malformed>")) as $l ({};
  if $l == "<malformed>" then .["<malformed>"] += 1
  elif ($l.type | type) != "string" then .["<no-type>"] += 1
  else reduce ([$l | key_of])[] as $k (.; .[$k] += 1) end)' FILE
```

`ignored_duplicate_kinds`:

```sh
jq -nRc 'def p: (.payload | objects) // {};
def it: (p.item | objects) // {};
reduce (inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object")) as $l ({};
  if $l.type=="response_item" and ($l|p.type)=="message" and ($l|p.role)=="user" then .["response_item.message.user"] += 1
  elif $l.type=="event_msg" and ($l|p.type)=="item_completed" and (($l|it.type) | IN("AgentMessage","Reasoning","WebSearch","ImageView")) then .["event_msg.item_completed.\($l|it.type)"] += 1
  else . end)' FILE
```

判定 CommandExecution 失败(正向控制用):

```sh
jq -nRc '[inputs | (fromjson? // empty) | objects | select(.type=="event_msg" and .payload.type=="item_completed" and .payload.item.type=="CommandExecution" and .payload.item.status=="failed")] | length' FILE
```

合成夹具(`codex.jsonl`),最后一行不是 JSON:

```jsonl
{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"c1","cli_version":"0.154.0","cwd":"/w/p","source":"exec","timestamp":"2026-01-01T00:00:00.000Z"}}
{"timestamp":"2026-01-01T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}
{"timestamp":"2026-01-01T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"timestamp":"2026-01-01T00:00:02.001Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"u1"}}}
{"timestamp":"2026-01-01T00:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"k1","arguments":"{}"}}
{"timestamp":"2026-01-01T00:00:04.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"k1","output":"x"}}
{"timestamp":"2026-01-01T00:00:04.001Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","status":"failed","exit_code":1}}}
{"timestamp":"2026-01-01T00:00:05.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"k2","input":"p"}}
{"timestamp":"2026-01-01T00:00:05.001Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","status":"completed"}}}
{"timestamp":"2026-01-01T00:00:06.000Z","type":"response_item","payload":{"type":"web_search_call","status":"completed"}}
{"timestamp":"2026-01-01T00:00:06.001Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"WebSearch"}}}
{"timestamp":"2026-01-01T00:00:07.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FutureThing","status":"failed"}}}
{"timestamp":"2026-01-01T00:00:08.000Z","type":"event_msg","payload":{"type":"brand_new_event"}}
{"timestamp":"2026-01-01T00:00:09.000Z","type":"brand_new_top"}
not json at all
```

期望:`{"user_messages":1,"tool_calls":3,"tool_failures":1}`;`unknown_event_types` = `{"event_msg.item_completed.FutureThing":1,"event_msg.brand_new_event":1,"brand_new_top":1,"<malformed>":1}`;`ignored_duplicate_kinds` = `{"response_item.message.user":2,"event_msg.item_completed.WebSearch":1}`。要点:第 2 行(注入文本的 `response_item` 用户消息)和第 3 行(真正的提示词)都不计,只计第 4 行的 `UserMessage`;第 7 行 `CommandExecution` failed 计失败;第 12 行未知类型的 `FutureThing` 即使带 `status:"failed"` 也**不**计失败。

真实样本:

- 取样规则排序后第一个满足窗口的主会话(`9ab683403820`,0.142.5,123 行):`{"user_messages":21,"tool_calls":0,"tool_failures":0}`——后两个计数为空,**这个样本只能验 `user_messages`**。
- 带正向控制的样本 A(`734a38b8d661`,0.142.5,1660 行):`{"user_messages":19,"tool_calls":317,"tool_failures":15}`;交叉:`grep -c` 四种调用类型 = 317,`UserMessage` = 19,`jq -s` 数 `status=="failed"` 的 item = 15(全部来自 `McpToolCall`)。
- 带 `CommandExecution` 失败的样本 B(`ff65425fc056`,0.149.0-alpha.4.3,1081 行):`{"user_messages":6,"tool_calls":155,"tool_failures":10}`,其中 8 个 `McpToolCall`、2 个 `CommandExecution`。

### 7.3 Pi

```sh
jq -nRc 'def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object");
def m: (.message | objects) // {};
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="message" then
    ($l|m.role) as $r
    | if $r=="user" then .user_messages += 1
      elif $r=="assistant" then .tool_calls += (($l|m.content|arrays) // [] | map(objects | select(.type=="toolCall")) | length)
      elif $r=="toolResult" then (if ($l|m.isError)==true then .tool_failures += 1 else . end)
      else . end
  else . end)' FILE
```

`unknown_event_types`:

```sh
jq -nRc 'def k_entry: ["session","message","custom_message","context_edit","custom","model_change","thinking_level_change","compaction","session_info","usage","branch_summary","label"];
def k_role: ["system","user","assistant","toolResult","bashExecution","custom","branchSummary","compactionSummary"];
def k_block: ["text","thinking","toolCall","image"];
def keys_of: (.type | strings) as $t
  | if (k_entry | index($t)) == null then [$t]
    elif $t=="message" then ((.message | objects | .role | strings) // "(none)") as $r
      | if (k_role | index($r)) == null then ["message.\($r)"]
        elif ($r=="user" or $r=="assistant" or $r=="toolResult") then
          [ (.message | .content | arrays | .[] | objects | ((.type | strings) // "(none)")) as $b | select((k_block | index($b)) == null) | "message.\($r).\($b)" ]
        else [] end
    else [] end;
reduce (inputs | select(test("\\S")) | ((fromjson? | select(type=="object")) // "<malformed>")) as $l ({};
  if $l == "<malformed>" then .["<malformed>"] += 1
  elif ($l.type | type) != "string" then .["<no-type>"] += 1
  else reduce ($l | keys_of)[] as $k (.; .[$k] += 1) end)' FILE
```

`branch_count`(整树,输出整数):

```sh
jq -nR '[inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object")]
| map(select(.type != "session" and (.id | type) == "string")) as $E
| if ($E | length) == 0 then 0 else
    ($E | map({key: .id, value: .parentId}) | from_entries) as $P
    | ([ limit(($E | length) + 1; ($E | last | .id) | recurse(if (. != null and $P[.] != null) then $P[.] else empty end)) ]
        | map({key: ., value: true}) | from_entries) as $on
    | ($E | map(select($on[.id] | not)) | length)
  end' FILE
```

合成夹具(`pi.jsonl`),含一个被放弃的分支(`b1`→`b2`→`b3`,从 `a1` 分出)和一个未知条目类型:

```jsonl
{"type":"session","version":3,"id":"p1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/w/p"}
{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1767225601000}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}},{"type":"toolCall","id":"c2","name":"read","arguments":{}}],"stopReason":"toolUse"}}
{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":true}}
{"type":"message","id":"a4","parentId":"a3","timestamp":"2026-01-01T00:00:04.000Z","message":{"role":"toolResult","toolCallId":"c2","toolName":"read","content":[],"isError":false}}
{"type":"message","id":"b1","parentId":"a1","timestamp":"2026-01-01T00:00:05.000Z","message":{"role":"user","content":"abandoned branch"}}
{"type":"message","id":"b2","parentId":"b1","timestamp":"2026-01-01T00:00:06.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c3","name":"bash","arguments":{}}]}}
{"type":"custom_message","id":"b3","parentId":"b2","customType":"x","content":"inj","display":false,"timestamp":"2026-01-01T00:00:07.000Z"}
{"type":"message","id":"a5","parentId":"a4","timestamp":"2026-01-01T00:00:08.000Z","message":{"role":"user","content":"live branch"}}
{"type":"future_entry","id":"a6","parentId":"a5","timestamp":"2026-01-01T00:00:09.000Z"}
```

期望:`{"user_messages":3,"tool_calls":3,"tool_failures":1}`(3 条用户消息含被放弃分支上的 `b1`;3 个 `toolCall` 含 `b2` 里的 `c3`);`unknown_event_types` = `{"future_entry":1}`;`branch_count` = 3(`b1`、`b2`、`b3`;活动链是 `a6→a5→a4→a3→a2→a1`)。

真实样本(第一个满足窗口的文件,`e6dbb63ffdb8`,267 行):`{"user_messages":9,"tool_calls":118,"tool_failures":4}`,`branch_count` = 0;交叉:`grep -o '"type":"toolCall"'` = 118,`grep -c '"isError":true'` = 4,`grep -c '"role":"user"'` = 9。

### 7.4 Kimi

```sh
jq -nRc 'def L: inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object") | select((.agentId | if . == null then "main" else . end) == "main");
def ev: (.event | objects) // {};
reduce L as $l ({user_messages:0,tool_calls:0,tool_failures:0};
  if $l.type=="context.append_message" then
    (if (((($l.message|objects|.role) // null)=="user") and ((($l.message|objects|.origin|objects|.kind) // null)=="user")) then .user_messages += 1 else . end)
  elif $l.type=="context.append_loop_event" then
    (if ($l|ev.type)=="tool.call" then .tool_calls += 1
     elif ($l|ev.type)=="tool.result" and ((($l|ev.result|objects|.isError) // null)==true) then .tool_failures += 1
     else . end)
  else . end)' FILE
```

`unknown_event_types`:

```sh
jq -nRc 'def k_top: ["metadata","context.append_loop_event","llm.request","usage.record","context.append_message","goal.update","agent.message.appended","token_counting.measured","mcp.tools_discovered","turn.prompt","turn.ended","token_counting.turn_recorded","agent.turn.started","agent.turn.ended","prompt.completed","permission.set_mode","runtime.set_binding","tools.update_store","profile.bind","config.update","turn.steer","turn.step.retrying","file_history.tracked","llm.tools_snapshot","file_history.checkpoint","tools.set_active_tools","plugin.session_start","permission.record_approval_result","prompt.accepted","staleGuard.recorded","turn.cancel","task.terminated","task.started","turn.step.interrupted","interaction.resolved","interaction.request","swarm_mode.exit","swarm_mode.enter","prompt.aborted","prompt.steered","interruptionReminder.recorded","goal.create","full_compaction.complete","full_compaction.begin","context.apply_compaction","token_counting.truncated","plan.revision","plan_mode.exit","plan_mode.enter","goal.clear","context.undone","context.undo","agent.switched"];
def k_loop: ["content.part","step.begin","step.end","tool.call","tool.result"];
def key_of: (.type | strings) as $t
  | if (k_top | index($t)) == null then $t
    elif $t=="context.append_loop_event" then (((.event | objects | .type | strings)) // "(none)") as $e | if (k_loop | index($e)) == null then "context.append_loop_event.\($e)" else empty end
    else empty end;
reduce (inputs | select(test("\\S")) | ((fromjson? | select(type=="object")) // "<malformed>")) as $l ({};
  if $l == "<malformed>" then .["<malformed>"] += 1
  elif (($l.agentId | if . == null then "main" else . end) != "main") then .
  elif ($l.type | type) != "string" then .["<no-type>"] += 1
  else reduce ([$l | key_of])[] as $k (.; .[$k] += 1) end)' FILE
```

`ignored_duplicate_kinds`:

```sh
jq -nRc 'reduce (inputs | select(test("\\S")) | (fromjson? // empty) | select(type=="object") | select((.agentId | if . == null then "main" else . end) == "main")) as $l ({};
  if ($l.type | IN("turn.prompt","turn.steer")) and ((($l.origin | objects | .kind) // null) == "user") then .[$l.type] += 1 else . end)' FILE
```

合成夹具(`wire.jsonl`),含一条子代理 `agentId` 的行,最后一行 `message` 不是对象:

```jsonl
{"type":"metadata","protocol_version":"1.5","created_at":1767225600000}
{"type":"context.append_message","time":1767225601000,"agentId":"main","message":{"role":"user","origin":{"kind":"user"},"content":[{"type":"text","text":"hi"}],"toolCalls":[]}}
{"type":"turn.prompt","time":1767225601001,"agentId":"main","origin":{"kind":"user"},"input":[]}
{"type":"context.append_message","time":1767225602000,"message":{"role":"user","origin":{"kind":"injection","variant":"goal"},"content":[{"type":"text","text":"inj"}],"toolCalls":[]}}
{"type":"context.append_loop_event","time":1767225603000,"event":{"type":"tool.call","toolCallId":"k1","name":"Bash","args":{}}}
{"type":"context.append_loop_event","time":1767225604000,"event":{"type":"tool.result","toolCallId":"k1","result":{"isError":true,"output":"x"}}}
{"type":"context.append_loop_event","time":1767225605000,"event":{"type":"tool.call","toolCallId":"k2","name":"Read","args":{}}}
{"type":"context.append_loop_event","time":1767225606000,"event":{"type":"tool.result","toolCallId":"k2","result":{"output":"y"}}}
{"type":"context.append_loop_event","time":1767225607000,"agentId":"agent-1","event":{"type":"tool.call","toolCallId":"z","name":"Bash","args":{}}}
{"type":"turn.steer","time":1767225608000,"origin":{"kind":"user"}}
{"type":"context.append_message","time":1767225609000,"message":{"role":"user","origin":{"kind":"user"},"content":[{"type":"text","text":"steer"}],"toolCalls":[]}}
{"type":"context.append_loop_event","time":1767225610000,"event":{"type":"future.event"}}
{"type":"brand.new.type","time":1767225611000}
{"type":"context.append_message","time":1767225612000,"message":5}
```

期望:`{"user_messages":2,"tool_calls":2,"tool_failures":1}`(第 2 行和第 11 行是用户消息;第 4 行是 `injection`,不算;第 9 行 `agentId:"agent-1"` 被排除;第 3、10 行 `turn.prompt`/`turn.steer` 是重复记录,不计);`unknown_event_types` = `{"context.append_loop_event.future.event":1,"brand.new.type":1}`;`ignored_duplicate_kinds` = `{"turn.prompt":1,"turn.steer":1}`(第 14 行 `message:5` 不是用户消息,也不报未知)。

真实样本(第一个满足窗口的文件,`10f1d3e730a1`,111 行):`{"user_messages":3,"tool_calls":3,"tool_failures":1}`;交叉:`grep -c '"type":"tool.call"'` = 3,`grep -c '"isError":true'` = 1。

### 7.5 `ts`、`agent_version` 的探针命令

```sh
# 第一个有效时间戳(Claude / Pi / Codex)
jq -nR 'first(inputs | (fromjson? // empty) | objects | .timestamp | strings | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")))' FILE
# 第一个有效时间(Kimi,毫秒数)
jq -nR 'first(inputs | (fromjson? // empty) | objects | (if .time != null then .time else .created_at end) | numbers | select(. >= 1e12 and . < 4e12))' FILE
# Claude 的 agent_version
jq -nR 'first(inputs | (fromjson? // empty) | objects | .version | strings | select(length > 0))' FILE
# Codex 的 agent_version
jq -nR 'first(inputs | (fromjson? // empty) | objects | select(.type=="session_meta") | (.payload | objects) | .cli_version | strings | select(length > 0))' FILE
```

无输出 = 取不到,走 C3 / §3 的回退。时间戳探针只做前缀正则,不做 `Date.parse`;`2026-13-45T…` 这类通不过 `Date.parse` 的值,reader 会跳过而探针不会,这只影响 `started_at`,不影响 A6 的三个计数。版本串只取前三段数字(四段版本 `2.1.294.1` 会被截成 `2.1.294`),本机四家都没有四段版本。

### 7.6 夹具的鲁棒性变体(C2)

同一份夹具加 BOM、改成 CRLF、去掉末尾换行,三种变体的计数与原夹具**必须相同**:

```sh
P='…同 §7.1 的程序…'
{ printf '\357\273\277'; cat claude.jsonl; } | jq -nRc "$P"      # 开头 BOM
sed 's/$/\r/' claude.jsonl | jq -nRc "$P"                          # CRLF
perl -pe 'chomp if eof' pi.jsonl | jq -nRc "$P_PI"                  # 末行无换行
```

在本机 jq 1.7.1 上三种变体的输出都与原夹具一致(Claude 的 `unknown_event_types` 在 BOM 变体下仍只有一个 `<malformed>`)。

## 8. 交回设计者的条目与未核实清单

### 8.1 待设计者定(不阻断 B10b/B11–B14 开工,但 A6 的 Codex 部分与 D3 需要先定)

- **D1 Codex `tool_failures` 无跨版本稳定字段。** 本文取「结构化 `status=="failed"`」。代价:0.149 之前(约 74% 的有工具调用的会话)shell 失败不可见。若要让报告层能区分「0 次失败」与「看不见失败」,需要在 `Counts` 或 `CollectReport` 加一个适用性标记(例如按 `cli_version >= 0.149` 或会话内是否出现过 `CommandExecution` 事件判定),这是契约变更。备选:A 接受(推荐;A6 Codex 样本强制含 `CommandExecution` 失败,汇报里标「受限口径」,适用性标记留给 P1);B 对 0.142.x 追加文本启发式 `Process exited with code N`(只覆盖 0.142.x,0.147.x 仍是盲区,且文本格式无保证);C P0 不验 Codex 的 `tool_failures`(等同缩小 reader 范围,需改 D §10 验收 6)。
  **已落地(P1,2026-10-09)**:采纳 A 的适用性标记半边——`CollectReport.tool_failures_scope`(仅 codex 报告携带):全部会话 `cli_version >= 0.149` → `full`;任一会话更老或版本未知(不能证明可见性,按受限归档)→ `codex_pre_0149_limited`。其余 agent 不带该字段;文本启发式(B)仍不做。
- **D2 `agent_version` 取不到时的取值。** 本文用 `"unknown"` + `collector_fallback`。备选:给 `AgentVersionSourceSchema` 加 `unknown`(改契约)。
  **已落地(P1,2026-10-09)**:采纳备选——`unknown` 入契约,语义二分:CLI 版本兜底成功 = `collector_fallback`
  (计入 `agent_version_fallback_ratio`),连 CLI 版本都没有 = `unknown`(不计入该比率)。
- **D3 超长行。** 本文要求计数不因 `maxEventBytes` 改变(C8)。若 reader 做不到,需定:要么 reader 必须整行分类后再丢文本,要么 A6 样本限定 `oversized_lines==0`。本机行长最大值约 1.3 MB(Claude)、2.5 MB(Kimi)、4.0 MB(Pi)。`maxEventBytes` 的默认值与定值责任人也要定(B10b 的参数),§5 规则 4 的样本筛选依赖它。
  **已定(P1,2026-10-09)**:默认 `DEFAULT_MAX_EVENT_BYTES = 8 MiB`(`src/signals/base-reader.ts`,定值责任人 = 设计者,记录于此)。依据:覆盖本机实测最大 4.0 MB 并留一倍余量;远低于单行硬上限 64 MiB。reader 已满足 C8 的第一种形态(超长行仍整行分类、只截断 text,计数不变——`test/signals/base-reader.test.ts` 双取值对照钉住),因此 §5 规则 4 的样本筛选按本文原样执行,不额外收紧。
- **D4 跨文件重复(Claude resume、Pi fork)。** P0 按文件计。P1 的 `sessions_total`、`fired` 汇总需要去重键(Claude `uuid`,Pi 条目 `id`),需要定是 reader 输出、还是 collector 汇总时做。
  **已定(P1,2026-10-09)**:三层取舍——①**去重发生在 attest 聚合层**(不在 reader、不在 collector:逐文件口径是 C9 明文承诺,A6 依赖它,不动);②**去重键随 Signal 携带**:Signal 增加可选 `event_key` = 加盐 sha256(agent + 源事件 id;Claude `uuid`、Pi 条目 `id`),在 pipeline 组装处计算(那里同时拿得到 reader 元组与 salt),盐与 `session_ref` 同源,防止 uuid 明文入库;③**实现与 attest 块绑定**(P1-C):`sessions_total`/`fired` 汇总按 `event_key` 去重,无 `event_key` 的 agent(kimi/codex 无跨文件重复问题)照旧按会话计数。契约变更(SignalSchema 加可选字段)随 attest 块一并落地并同步 oracle/文档。
- **D5 Pi 分支。** 本文:计全部条目 + `branch_count` 报非活动链条目数。备选 A:只计活动链(被放弃分支上执行过的工具不算);备选 B:本文口径之外另报活动链三项计数(`Counts` 要加字段)。本机零分支样本,无法用真实数据比较。
- **D6 Claude 的两类边界行。** (a) 带 `sessionKind` 的后台会话 user 行(本机 6 行)按规则计为用户消息;(b) 斜杠命令(`<command-name>…`)计为用户消息。若设计要的是「人敲的自然语言」,这两类要另外排除,口径会改。

### 8.2 未核实(没有一手来源,不补全)

- Claude 逐行 schema 官方文档未读;本文所有 Claude 字段来自本机 2.1.250–2.1.293 的结构归纳;更老的 `summary` 类型行、其它版本的 `origin`/`turnOrigin` 取值本机无样本(落入 `unknown`)。
- Codex rollout 官方 schema 未读;本机最早样本 0.80.0(7 个文件),0.81–0.141 之间无样本;`FileChange` 的 `declined` 状态只有 1 条;`Plan`、`DynamicToolCall` 各只有 1 条。
- Pi:`usage`/`branch_summary`/`label` 条目、`bashExecution` 等 role 本机零样本;「最后一个条目 = 叶子」是假设;分支口径无真实样本。
- Kimi:`context.undo`/`context.apply_compaction` 对计数的影响;协议 1.4/1.5 之外的版本;`assistant` 角色的 `append_message` 本机零样本(按 `meta` 处理)。
- `ts` 第 3 级回退(文件 mtime)本机零命中,只能用合成夹具测。`agent_version` 的 CLI 版本兜底,本机只有 Pi、Kimi 会走到;Claude(42/42)和 Codex(除空文件外全部)的会话内版本都取得到,它们的兜底分支本机零命中。
- 事件文本里是否含外部内容(`external_content`)的判定不在本文范围。

### 8.3 已知差异(B21 记录,未改口径)

- **R1 agent_version 形状**:reader 只接受 `^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}([-+][0-9A-Za-z.+-]{0,40})?$` 且总长 ≤ 64 的值;不符合的当作「这一行没有版本」,继续找后面第一个合法的,都没有则走 `collector_fallback`。§7.5 的探针取「第一个非空字符串」,两者只在 trace 里出现畸形 `version` 时不同(此时探针的值本来就不该进 Signal)。
- **R8 Claude 的 version 与侧链行**:reader 先跳过侧链行(`isSidechain==true`),所以侧链行上的 `version` 不参与取值;§7.5 的探针不过滤侧链。首个带 `version` 的行恰是内联侧链行(老版本)时,两边取到的版本可能不同。本机零样本,不影响 A6 计数;未改。
- **R4 目录布局与首行过滤**:Claude 要求 `<项目目录>/<UUID>.jsonl`、Kimi 要求 `…/agents/main/wire.jsonl`、Pi 要求 `--<路径>--/<文件>.jsonl`,而 §5 的抽样是 `find -name '*.jsonl'`(任意深度)。A6 复制样本时**必须保留相对布局**(Codex 只看文件名,不受此限)。Pi 的 discover 还会跳过「首个非空白行是 type 非 session 的对象」的文件(被截掉文件头的会话),该过滤不在 §2.3.1 里,被跳过的文件没有诊断;未改。
- **R5 显式文件**:`--source` 指向单个文件时,Claude 要求文件名是 UUID 形状且父目录不叫 `subagents`(与 Codex 的首行判定同为「子代理文件不是会话」);Pi 没有子代理文件,显式文件原样接受;Kimi 按路径尾部卡。
- **R6 Kimi state.json**:只读普通文件;符号链接、命名管道、目录一律当 cwd 未知(`cwd_hint=null`)。

## 9. 本机语料概况(2026-10-08,仅供量级参考,不是验收数据)

| Agent  | 主会话文件 | 侧链文件        | 本文引用的版本范围       |
| ------ | ---------- | --------------- | ------------------------ |
| Claude | 42         | 约 720          | 2.1.250 – 2.1.293        |
| Codex  | 4444       | 2064(+1 空文件) | 0.80.0 – 0.161.0         |
| Pi     | 188        | 0               | 格式 v3;CLI 0.87.1       |
| Kimi   | 152        | 88              | 协议 1.4 / 1.5;CLI 2.0.0 |

## 10. 自检方法

本文的 jq 程序、夹具与期望值可以自检:把 §7 各代码块抽出来,夹具写成临时文件,逐个跑上面的命令,与期望值比对。B16 应把这一步做成 `ops/reader-oracle` 的单测:**直接从本文抽取程序和夹具**(不要另抄一份,否则会漂移),夹具运行时写到 `$KIT_TMP`,不以 `.jsonl` 文件入仓。A10 检查的是 `git ls-files` 里的 `.jsonl` 文件和秘密形态的字符串;本文的夹具是 Markdown 代码块里的合成内容,不含秘密形态。如果 A10 的实现把「Markdown 里出现 jsonl 代码块」也算命中,需要调整 A10,不要改本文。
