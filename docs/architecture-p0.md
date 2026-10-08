# P0 架构

P0 只在仓库内工作:读规则/技能/子代理源文件,合并、渲染到 `out/`,检查预算与守卫,只读解析本机会话日志并脱敏。
**不写任何全局位置**(A5 证明)、**运行期零网络**(A8 证明)。契约见 [`contracts.md`](./contracts.md),块边界见 [`block-boundaries.md`](./block-boundaries.md)。

## 数据流

```
rules/ skills/ agents/ ─► atoms (B03: parse+lint) ─► merge (B05) ─► ResolvedAtom[] ─► adapters/<agent> (B06 核心 + B07/B08)
                                                                                         │
kit.toml ──────────────────────────────────────────────────────────────────────────────┤
                                                                                         ▼
                                                                      OutFile[] ─► budget (B05) ─► out/<agent>/{home|project}/… + out/manifest.json
                                                                                         ▲
git base/head ─► guards G1–G4 (B04)                                                     │ safe-fs(唯一写出口)

--source <会话目录> ─► readers (B11–B14) ─► NormEvent ─► redact (B09, 两遍 fail-closed) ─► Signal ─► .state/（--dry 时不写）
                         │ read-fs(只读)
```

## 模块依赖(箭头 = 依赖,不允许反向)

```
cli.ts ─► commands/* ─► {atoms, guards, merge, budget, render, redact, signals, readers}
                         └──────────────► contracts/*   (所有模块只依赖契约,不互相依赖实现)
                         └──────────────► io/*          (唯一的 fs 写、fs 读、环境、子进程出口)
adapters/<agent> ─► contracts/render.ts   (渲染器只吃 RenderInput,吐 RenderOutput;不读文件、不写文件)
```

- **contracts/**:zod schema + `z.infer` 类型 + 少量纯函数(诊断排序、文件名构造)。无业务逻辑。
- **io/**:`paths`(唯一读 HOME/env/cwd)、`safe-fs`(唯一写)、`read-fs`(只读)、`exec`(唯一子进程,仅 `git`)、`canonical-json`/`canonical-text`(确定性序列化)。
- **commands/**:每个命令一个文件,`export const command: CommandDef`;`check` 由三个子 runner(`lint-cmd`/`check-budget`/`guards-cmd`)组合。
  `cli.ts` 的注册表由 B01 一次写定,后续块只替换命令文件内容。
- **adapters/**:渲染器是纯函数(输入 → 输出),文件写入由 `build` 统一经 `safe-fs` 完成。B01 预建 5 个桩与 `managed-targets.json`。

## 确定性

所有落盘文本经 `canonicalText`/`canonicalJson`(LF、末尾恰一个换行、键序固定);遍历目录用字节序;`out/` 内无时间戳、绝对路径、用户名(A1)。

## 构建与运行

- ESM(`"type":"module"`,`module: NodeNext`):相对导入必须带 `.js` 扩展名,这是刻意的——运行期解析规则由 `tsc` 在 typecheck 阶段兜住。
- 入口:根 `cli.ts` 编译为 `dist/cli.js`(再 import `dist/src/cli.js`)。这样 `src/` 之外的 `adapters/` 也能参与编译(`rootDir: "."`),同时保持 `node dist/cli.js` 的固定路径。
- 仓库未发布,`bin` 在本地不可用,所有验收脚本一律走 `node dist/cli.js`(`agent-kit …` 在文档里是它的简写)。
- 测试不依赖 `dist/`(干净克隆里 install → typecheck → test 就能跑),命令桩的退出码用进程内 `main()` 断言。

## 已知的故意限制

- `build` 命令的串联(合并 → 渲染 → 预算 → 写 `out/` + manifest)不属于任何块的边界,由 B19 集成;B01 只放桩。
- 命令桩一律退出 64,不会静默成功;多步命令合并退出码时含桩不会返回 0。
