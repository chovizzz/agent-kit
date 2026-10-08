# 依赖清单(B01 定稿;主代理合并时核定)

直接依赖共 10 个(A11 要求 ≤12),全部精确版本,无 `^ ~`。`pnpm install --ignore-scripts` 已实测可装、可测。

| 包                  | 版本    | 类型 | 许可证       | 传递依赖 | 用途 / 理由                                                                                | 回退版本                              |
| ------------------- | ------- | ---- | ------------ | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `zod`               | 4.6.5   | 运行 | MIT          | 0        | 契约 schema(`z.strictObject`、`z.iso.datetime`、`z.partialRecord`)                         | 4.x 其它精确版本(API 为 zod 4;不回 3) |
| `yaml`              | 2.9.1   | 运行 | ISC          | 0        | 原子 frontmatter、`agents/*.yaml`、`proposals/*.yaml`(B03)                                 | —                                     |
| `smol-toml`         | 1.9.0   | 运行 | BSD-3-Clause | 0        | `kit.toml` 解析;Codex 子代理 `.toml` 序列化(B07,已验证 stringify 幂等)                     | —                                     |
| `typescript`        | 6.0.3   | 开发 | Apache-2.0   | 0        | 7.0.2 是原生移植版,而 `typescript-eslint` 8.71.1 的 peer 要求 `<6.1`,故用 6.x 最后一个版本 | 5.9.3                                 |
| `vitest`            | 5.0.3   | 开发 | MIT          | 多       | 测试;要求 Node `^22.12 \|\| ^24 \|\| >=26`(本机 Node 25 会有 engines 警告但可跑,CI 用 22)  | 4.x + vite 7                          |
| `vite`              | 8.3.3   | 开发 | MIT          | 多       | `vitest` 5 的**非可选 peer**,必须显式装                                                    | 7.x(配 vitest 4)                      |
| `eslint`            | 10.12.0 | 开发 | MIT          | 多       | A9 的 io 限制规则;`typescript-eslint` 8.71.1 的 peer 含 `^10`                              | 9.x                                   |
| `typescript-eslint` | 8.71.1  | 开发 | MIT          | 多       | TS 解析与 recommended 规则(不用 type-aware 规则,避免对 tsconfig 的耦合)                    | —                                     |
| `prettier`          | 3.9.9   | 开发 | MIT          | 0        | `format:check`                                                                             | —                                     |
| `@types/node`       | 22.20.5 | 开发 | MIT          | 1        | 与 CI 的 Node 22 对齐的类型(本机 Node 25 也能编译)                                         | —                                     |

## YAML / TOML 选型(Q-N12)

- **YAML**:`yaml` 2.9.1(eemeli/yaml)。零传递依赖;默认 core schema 下 `2026-10-08` 这类未加引号的日期**保持字符串**(契约 `IsoDate` 依赖这一点,`test/contracts/skeleton.test.ts` 有断言);`stringify` 对同一对象幂等。
  备选 `js-yaml`(1 个传递依赖,默认会把日期解析成 `Date`,需要换 schema)被否。自写受限子集解析器的方案没有必要,不启用。
- **TOML**:`smol-toml` 1.9.0。零传递依赖,同时有 `parse` 与 `stringify`(B07 需要确定性序列化 Codex `.toml`);`parse→stringify→parse` 往返相等且 stringify 幂等已有测试。
  备选 `@iarna/toml`(不再积极维护)、`toml`(只能 parse)被否。

## 已知注意

- `vitest` 5 的 engines 不含 Node 25;本机 Node 25.2 上测试正常,CI 固定 Node 22。A12(干净克隆)是最终判据。
- `pnpm install` 会提示部分依赖的构建脚本被忽略(`--ignore-scripts`);当前依赖链在忽略脚本时测试与构建均通过(vite 8 不依赖 esbuild 的 postinstall)。若将来某依赖需要构建脚本,在 `package.json` 配 `pnpm.onlyBuiltDependencies` 并由主代理评审。
- `package.json` 的 `packageManager` 固定 `pnpm@10.33.0`,避免 lockfile 版本漂移。
