# 块边界(谁可以写哪些路径)

来源:plan-P0 §3.3,加上 B01 预建的骨架文件的归属。**不在自己行里的路径一律不改**;需要改动时在汇报里列「待主代理接线」。

## 只由 B01 / 主代理改的共享热点

`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`tsconfig.build.json`、`eslint.config.js`、`.prettierrc`、`.prettierignore`、`vitest.config.ts`、`cli.ts`、
`src/cli.ts`、`src/commands/types.ts`、`src/contracts/**`、`src/io/**`、`kit.toml`、`docs/contracts.md`、`test/contracts/**`(契约示例与登记表)、`test/helpers/tmp.ts`、`test/lint/**`、`test/fixtures/lint-violations/**`。

- 块内另需新依赖:不改 `package.json`,在汇报里列「依赖 + 理由 + 精确版本」,由主代理统一加。
- **新增 io 例外 / 放开 `exec` 白名单 / 改 eslint 规则 = 契约变更**,先问主代理。
- `Options` 类型(`CheckOptions` 等)只允许**追加可选字段**。

## 各块可写路径

| 块      | 可写路径(仅限)                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01     | 上面的共享热点、全仓骨架、`docs/{architecture-p0,contracts,block-boundaries,deps}.md`、`test/fixtures/README.md`、`adapters/*/index.ts` 与 `adapters/*/managed-targets.json`(桩) |
| B02     | `docs/spikes/**`                                                                                                                                                                 |
| B03     | `src/atoms/**`、`src/commands/lint-cmd.ts`、`test/atoms/**`、`test/fixtures/atoms/**`                                                                                            |
| B04     | `src/guards/**`、`src/commands/guards-cmd.ts`、`test/guards/**`、`test/fixtures/guards/**`、`test/helpers/make-repo.ts`                                                          |
| B05     | `src/merge/**`、`src/budget/**`、`src/commands/check-budget.ts`、`test/merge/**`、`test/budget/**`、对应 fixtures                                                                |
| B06     | `src/render/**`、`test/render-core/**`、`test/golden-harness/**`                                                                                                                 |
| B07     | `adapters/{claude,codex}/**`(替换桩)、`test/golden/{claude,codex}/**`                                                                                                            |
| B08     | `adapters/{pi,kimi,opencode}/**`(替换桩)、`test/golden/{pi,kimi,opencode}/**`                                                                                                    |
| B09     | `src/redact/**`、`src/commands/redact-cmd.ts`、`test/redact/**`、`docs/redaction.md`                                                                                             |
| B10a    | `docs/reader-counting-spec.md`                                                                                                                                                   |
| B10b    | `src/signals/**`、`src/commands/signals-collect.ts`、`test/signals/**`、`test/fixtures/sessions/**`                                                                              |
| B11–B14 | 各自 `src/readers/<agent>/**`、`test/readers/<agent>/**`                                                                                                                         |
| B15     | `inventory/**`                                                                                                                                                                   |
| B16     | `ops/reader-oracle/**`、`inventory/reader-samples.txt`                                                                                                                           |
| B17     | `ops/zero-write-check.sh`、`ops/lib/**`、`ops/managed-paths.txt`、`ops/volatile-paths.txt`、`ops/guards/**`、`test/ops/**`                                                       |
| B18     | `ops/accept/**`、`ops/accept-p0.sh`、`.github/workflows/**`、`docs/deps.md`(追加)                                                                                                |
| B19     | `src/commands/build.ts`(串联 B05/B06/B07/B08)、集成修补                                                                                                                          |

## 与 lint 的关系

`ops/**` 不受 `eslint.config.js` 的 io 限制(验收工具要读真实 HOME),但 `src/ adapters/ test/ cli.ts` 不得 import 它。
块内测试要临时目录/写文件/起 git:用 `test/helpers/tmp.ts`(`makeTempDir` → `safe-fs.mkdtemp`)与 `src/io/exec.ts`,不要自己 `import node:fs` 或 `node:child_process`。

## 命令文件替换约定

每个命令桩只有一个导出,后续块替换内容时**保持导出形状**:

- 顶层命令:`export const command: CommandDef`(`run(ctx)` 返回退出码,见 `docs/contracts.md` §2)。
- `check` 子 runner(`lint-cmd.ts`/`check-budget.ts`/`guards-cmd.ts`):`export const run: CheckStep`。
- 渲染器:`export const adapter: Adapter`。
