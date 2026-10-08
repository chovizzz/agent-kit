# Spike B02：gitleaks 能否作依赖，及脱敏规则来源

核对日期：2026-10-08（下文「核对」均指该日）。环境：Node v25.2.0、Python 3 `tomllib`、`gh api`。
规则文件下载在仓库外临时目录，未入仓。文中不含任何完整的真实形态密钥。

## 结论（一句话）

默认结论成立：脱敏模块用**自有规则 + 参考上游正则**，**不把 gitleaks 二进制作运行时依赖**。
上游 `gitleaks.toml` 可作**参考素材**（仓库为 MIT；单条规则的版权归属未核实，复制时保留版权声明），但不能原样直接喂给 JS 引擎。

## 问题 1：许可证

- gitleaks 仓库许可证为 **MIT**。
  - GitHub API 返回 `license.spdx_id = MIT`（`gh api repos/gitleaks/gitleaks`，核对 2026-10-08）。
  - LICENSE 文件首行为 "MIT License"，版权 "Copyright (c) 2019 Zachary Rice"。来源：<https://github.com/gitleaks/gitleaks/blob/master/LICENSE>（核对 2026-10-08）。
- `gitleaks.toml` 位于同一仓库 `config/` 目录，未见单独的许可证声明，按仓库许可证（MIT）处理。
  - 「各条规则的贡献者是否各自持有版权」**未核实**（仓库未见 NOTICE 文件的证据我没有逐项查）。
  - vendoring 时按 MIT 要求保留版权声明与许可文本。
- 关联：`gitleaks-action`（GitHub Action）的 SPDX 为 `NOASSERTION`（<https://github.com/gitleaks/gitleaks-action>，核对 2026-10-08）。它不是本项目要用的东西，只提示别把 action 与主仓库的许可证混为一谈。

## 问题 2：规则文件、规则数量与可移植性

### 获取方式与基线

- 官方默认规则文件：<https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml>。
  - 文件头注明由 `cmd/generate/config/main.go` 自动生成，`minVersion = "v8.25.0"`。
  - 规则源码在 `cmd/generate/config/rules/`（目录项 132 个，含非规则文件）。
- 最新发布版 **v8.30.1**（发布于 2026-03-21，`gh api repos/gitleaks/gitleaks/releases/latest`）。
- 本次分析的基线（用于将来钉 sha）：
  - master 上 `config/gitleaks.toml` 的 git blob sha = `256f64790ea6d954f0041024be2938089ae1e7a7`，大小 97731 字节；`ref=v8.30.1` 上的 blob sha 与之相同。
  - 下载内容的 SHA-256 = `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf`。
  - 取回方式：`gh api -H "Accept: application/vnd.github.raw" repos/gitleaks/gitleaks/contents/config/gitleaks.toml`，核对 2026-10-08。
  - 钉 sha 时用 git blob sha 或文件 SHA-256 均可，建议同时记 release tag。

### 规则数量（实测，Python tomllib 解析）

| 项                                         | 数量                                  |
| ------------------------------------------ | ------------------------------------- |
| `[[rules]]` 总数                           | **222**                               |
| 含 `regex` 的规则                          | 221（1 条仅按文件路径匹配）           |
| 带 `keywords`（预筛关键词）                | 221                                   |
| 带 `entropy`（最小香农熵阈值）             | 130                                   |
| 带 `secretGroup`（取第几个捕获组作为密钥） | 1                                     |
| 规则级 allowlist                           | 9                                     |
| 全局 allowlist                             | 有（`paths`、`regexes`、`stopwords`） |

语义不止正则：关键词预筛、熵阈值、allowlist、捕获组选择共同决定精度。字段含义见 README 的配置段：<https://github.com/gitleaks/gitleaks/blob/master/README.md>（核对 2026-10-08）。README 说明 regex 为 Go 风格（"Golang regular expression"）。

### Go 正则与 JS 正则的差异（实测）

方法：把 221 条正则分别用 Node v25.2.0 的 `new RegExp` 编译。

| 处理方式                                                                                                          | 能编译的条数                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 原样交给 JS（带 `u` 标志）                                                                                        | 82 / 221                                                                                                                            |
| 仅剥掉开头的 `(?i)`/`(?s)` 转成标志，`\z`→`$`、`\A`→`^`（语义等价是按语言定义推断，未单独对拍）、`(?P<n>`→`(?<n>` | 199 / 221                                                                                                                           |
| 再把**模式中段**的 `(?i)` 去掉并改为整条加 `i`（语义变宽）                                                        | 221 / 221（首次脚本报 219，余下 2 条 `gocardless-api-token`、`planetscale-password` 是脚本把 `i` 标志重复添加所致，非规则不可移植） |

具体差异点：

1. **开头内联标志** `(?i)`：114 条。JS 没有内联写法，需转成 `i` 标志。
2. **模式中段的 `(?i)`**：22 条，如 `prefix-(?i)[a-z0-9]{32}`（前缀区分大小写、后段不区分）。JS 无法照写，会报 Invalid group。
   - 近似做法是整条加 `i`，会放宽前缀匹配（假阳性略增）。
   - 精确做法是展开成字符类，例如把 `[a-z0-9]` 写成 `[a-zA-Z0-9]`。
3. **作用域标志组** `(?i:...)`、`(?-i:...)`、`(?s:...)`：分别 8、若干、1 处。Node v25.2.0 能编译；低版本 Node 是否支持**未核实**，P0 的最低 Node 版本需注意。
4. **`\z` / `\A`**：5 处，JS 无此转义，需换成 `$` / `^`（不加 `m` 标志时语义一致）。
5. **POSIX 字符类** `[[:alnum:]]`：1 处（Airtable 规则）。🔴 在不带 `u` 标志的 JS 里它**能编译但含义不同**（变成字符集 `[:alnum]` 后面跟一个 `]`），属于静默错误，不是报错。
6. **命名组** `(?P<name>`：1 处，需改成 `(?<name>`。
7. 未发现零宽断言（lookahead/lookbehind）：因为 Go 的 RE2 不支持它们，规则里没有（grep 为 0 处）。
8. **性能保证不同**：Go 的 `regexp` 基于 RE2、保证线性时间（<https://pkg.go.dev/regexp>、<https://github.com/google/re2/wiki/Syntax>，**本次未重新抓取，据称**）；JS 的 RegExp 是回溯引擎（<https://developer.mozilla.org/docs/Web/JavaScript/Guide/Regular_expressions>，同样据称），存在 ReDoS 风险。
   - 小实验：用 5 种合成长输入（约 20KB：重复字符、空格、`key=` 重复、点分、重复的 `curl -H`）依次跑可编译的规则。「规则 × 输入」共 4 个组合超过 200ms，最慢 282ms（`cisco-meraki-api-key`、`okta-access-token`、`privateai-api-token`）。
   - 这个实验很粗，**不能证明安全**；只说明应对输入长度设上限或分块扫描，且种子集测试要含长输入。
9. `\s`、`\w`、`\b` 在 Go 里是 ASCII 语义，JS 的 `\s` 含 Unicode 空白；对密钥匹配影响小，但脱敏的第二遍有零宽字符处理（设计 §6.3），要单独测。

要真正复用规则，还要在 JS 里重实现：关键词预筛、熵计算、`secretGroup`、规则级和全局 allowlist（含 stopwords）。这部分才是精度的来源，不只是正则文本。

## 问题 3：引入方式的选项

| 选项                                          | 说明                                                                    | 事实依据                                                                                                                                                                                                                                                                                                                          | 判断               |
| --------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A 二进制作运行时依赖                          | 调 `gitleaks` 子进程                                                    | 发布物是按平台的压缩包（darwin arm64/x64、linux 多架构、windows），共 11 个资产（`gh api repos/gitleaks/gitleaks/releases/latest`，核对 2026-10-08）。官方 Releases 只有这些平台压缩包，未见官方 npm 分发（我只查了 Releases 资产；`npm view gitleaks` 返回一个 1.0.0、ISC 的同名包，内容与来源**未核实**，不应假定它是官方封装） | 拒绝（见下）       |
| B vendored 上游 toml 并钉 sha，运行时翻译加载 | 复制 `gitleaks.toml` 进仓库，写转换器                                   | 上表：约 10% 规则需特殊处理；需自己实现关键词/熵/allowlist；要保留 MIT 声明；上游更新要人工 diff                                                                                                                                                                                                                                  | 可选，P0 不做      |
| C 自有规则 + 参考上游正则                     | 按设计 §6.3 写自有规则，从上游挑选/改写个别正则，并在注释里标出处与 sha | 设计 §6.3 的规则集主要是项目自有前缀（`soh_` 等）、IPv4、邮箱、敏感词表，这些在上游 toml 里**未见对应规则**（只核对了 id 列表，未逐条读正则）；PEM 与 JWT 上游有 `private-key`、`jwt`、`jwt-base64` 规则（toml 第 2424、2431、2785 行）可参考；通用厂商密钥前缀是上游的强项                                                       | **采纳**           |
| D 使用 Node 生态现成规则库                    | 见下一节                                                                | 见下一节                                                                                                                                                                                                                                                                                                                          | 作为 P0 之后的备选 |

### 为什么拒绝 A（运行时二进制）

1. 要额外分发：每个平台一个二进制、需校验和与升级策略；本项目运行期要求零网络（A8），二进制必须随安装一起到位。
2. 被扫文本是**内存中的会话片段**，不是 git 仓库或文件；调用二进制要落临时文件或走 stdin，增加把明文写盘的风险（脱敏模块本来就是为了不让明文落盘）。这是我的设计判断，不是 gitleaks 文档的断言。
3. 补充：任务给出的默认理由之一是「规则格式含 Go 正则差异」。该理由只对 B（在 JS 里加载规则）成立；A 的二进制自带 Go 引擎，不受影响。所以拒绝 A 靠的是 1、2、4 条，不靠这一条。
4. 脱敏要求两遍扫描、固定格式占位符 `[[REDACTED:<type>]]`、`fail-closed`；gitleaks 是「检测并报告」，不做替换，替换逻辑仍要自己写，二进制只能提供命中位置。（"detecting" 的定位见 README 开头；核对 2026-10-08。）

### 为什么 C 优先于 B

- P0 的脱敏种子集是项目自定的（设计 §6.3、§10），自有规则可以与种子集一一对应并写负向对照；
- B 的转换器本身是一块独立工作，且 22 条需要手工语义处理；
- C 仍可逐条借鉴上游正则；若将来需要更广覆盖，再做 B。

## 附：Node/TS 生态里的现成密钥规则集（只列事实）

核对日期均为 2026-10-08；许可证来自 GitHub API 的 SPDX 或 `npm view`。

| 项目                                           | 许可证       | 事实                                                                                                                                 | 来源                                                                                         |
| ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| secretlint                                     | MIT          | TypeScript 实现的可插拔 linter；`@secretlint/core` 13.0.7（npm 更新于 2026-10-03），`engines.node >=22.0.0`；仓库最近推送 2026-10-06 | <https://github.com/secretlint/secretlint>、<https://www.npmjs.com/package/@secretlint/core> |
| `@secretlint/secretlint-rule-preset-recommend` | MIT          | 13.0.7；npm 登记的依赖仅 `debug`、`structured-source`、`@secretlint/types`、`@secretlint/profiler`                                   | <https://www.npmjs.com/package/@secretlint/secretlint-rule-preset-recommend>                 |
| `@secretlint/secretlint-rule-pattern`          | MIT          | 13.0.7；可自定义正则规则                                                                                                             | <https://www.npmjs.com/package/@secretlint/secretlint-rule-pattern>                          |
| detect-secrets（Yelp）                         | Apache-2.0   | Python，非 Node                                                                                                                      | <https://github.com/Yelp/detect-secrets>                                                     |
| trufflehog                                     | AGPL-3.0     | Go，二进制；copyleft                                                                                                                 | <https://github.com/trufflesecurity/trufflehog>                                              |
| secrets-patterns-db                            | CC-BY-SA-4.0 | 正则数据库；ShareAlike 条款对本项目是否构成传染**未核实**                                                                            | <https://github.com/mazen160/secrets-patterns-db>                                            |

secretlint 的**规则覆盖面、误报率、对内存字符串（而非文件）的 API 是否合适，本 spike 未评估**。如果 P0 之后要扩大覆盖，它是首个值得单独 spike 的对象；其 Node ≥22 的要求要与本项目的最低 Node 版本对照。

## 问题 4：结论、被拒备选

结论：

1. 脱敏第一遍的规则集 = 自有规则（设计 §6.3 列表）+ 从上游 `gitleaks.toml` 手工挑选并改写的正则；每条借来的正则在注释里写上游规则 id 与基线（tag v8.30.1、blob sha `256f647…`）。
2. 不引入 gitleaks 二进制；不在运行时解析上游 toml。
3. 项目内保留一份署名：在许可/NOTICE 处写明部分正则源自 gitleaks（MIT, Copyright (c) 2019 Zachary Rice）。
4. 移植规则时按上面「差异点」检查：中段 `(?i)` 要展开、不得使用 POSIX 字符类、给输入长度设上限。种子集要含长输入用例。

被拒备选与理由：

| 备选                       | 理由                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A 二进制运行时依赖         | 额外分发面；明文需交给子进程；不提供替换，只报告命中；与项目运行期零网络/零额外依赖的取向不合（其中「取向」是设计判断） |
| B 运行时加载 vendored toml | P0 成本大（转换器 + 熵 + allowlist 的重实现）；22 条需手工语义处理；暂缓而非永久否决                                    |
| 直接用 trufflehog          | AGPL-3.0，且是 Go 二进制                                                                                                |
| 直接用 secretlint          | 本 spike 未评估覆盖与 API 适配；列为后续 spike，不是否决                                                                |

## 未核实 / 遗留

- 各规则贡献者的版权归属（仅核实了仓库级 MIT）。
- npm 上是否有成熟的 gitleaks 第三方封装。
- `(?i:` 作用域标志在低版本 Node 的支持情况。
- 熵阈值的计算细节（香农熵的具体实现、按字节还是按字符）未读源码，移植前需读 `detect` 部分。
- 上游规则的误报/漏报率；没有做语料评估。
- 上游更新节奏与跟进流程（建议：每次升级基线时对 `gitleaks.toml` 做 diff，记入变更日志）。
