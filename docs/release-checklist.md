# P0 发布检查清单

P0 不发布 npm 包、不推远端分支保护;本清单只管「P0 验收通过后打 tag / 合并」前要做的事。
所有命令在仓库根执行,先 `pnpm install --frozen-lockfile --ignore-scripts && pnpm run build`。

## 1. 自动验收

```sh
ops/accept-p0.sh --list          # 必须列出 15 项,A13 显示为【人工完成项】
ops/accept-p0.sh                 # 汇总 A1–A15;任何 4(未执行)按失败
```

退出码:0 全部通过 | 1 有违规 | 2 用法错 | 3 清单被拒 | 4 有未执行或人工项未完成 | 5 待人工归因。

## 2. 只能由主代理在真实环境做的项

| 项  | 做什么                                                                                                                                                                                                                                                                  | 前置                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A5  | `ops/accept-p0.sh --only A5`(会只读快照真实 HOME 的受管路径);差异先按「待人工归因」流程判断,不得把 managed 路径挪进 volatile,也不得在受管目录之下加 volatile 行(退出 3);退出 5 可能来自命令窗口之外的变化(`CHANGE_OUTSIDE_COMMAND_WINDOW`)或快照截断,见 contracts §12.1 | `dist/` 已构建;`origin/main` 可解析;工作树干净        |
| A6  | `.state/reader-samples.local.txt`(`<agent>\t<绝对路径>`,与 `inventory/reader-samples.txt` 的路径哈希、行数一致)就位后 `--only A6`                                                                                                                                       | 20 个样本;允许项目只限 `social-ops-hub`、`skills-hub` |
| A7  | `--only A7`(在本机重跑 `inventory/commands.sh`;期望值是 2026-10-09 的实测值,会话文件数这类只增项用 `>=N`;用户个人文件变化后先 `ops/inventory-refresh.mjs`(dry-run)→ 人工看 → `--apply`,不要手改期望值)                                                                  | 本机 HOME 下的盘点来源仍在                            |
| A10 | 全量脱敏扫描无豁免;URL 只放行 `ops/accept/lib/a10.mjs` 里 `PUBLIC_DOC_HOSTS`(github.com、pkg.go.dev、developer.mozilla.org、www.npmjs.com,均为文档与种子里的公开引用),IPv4 字面量一律不放行(测试里的回环地址运行时拼接);新增命中仍会被拦                                | 无                                                    |
| A11 | `--only A11`(audit 需要网络)                                                                                                                                                                                                                                            | 能访问 npm registry                                   |
| A12 | 提交之后 `--only A12`(验的是提交,不是工作树)                                                                                                                                                                                                                            | 工作树干净                                            |
| A13 | 按 `ops/accept/a13-mutation.md` 做 5 处变异,写标记文件                                                                                                                                                                                                                  | 最终提交之后做(标记绑定 HEAD)                         |

## 3. 打 tag / 合并前

- [ ] `pnpm run typecheck && pnpm run build && pnpm run test && pnpm run lint && pnpm run format:check` 全绿(skipped 数为 0)
- [ ] 上面 A1–A15 全部为 PASS(A13 为「已做」),没有任何 4
- [ ] `git status --porcelain` 为空(过滤 `.state/`、`out/` 之外)
- [ ] `out/` 已随源码重新生成并提交(A15 会核对它与重新构建的结果一致)
- [ ] retire / promote 类 PR 的描述写明「本 PR 使哪些被压住 / 生效的原子重新出现在或退出 `out/`」(见 `docs/contracts.md` §12.3),并与重新生成的 `out/` 对得上
- [ ] `docs/deps.md` 与 `package.json` 一致(直接依赖逐个有理由)
- [ ] 若改了 `.github/workflows/ci.yml` 里的 action:SHA 与 `docs/deps.md` 的表同步
- [ ] 远端 CI 推上去后观察一次(P0 不要求跑通,但要看懂每个红点)

## 4. 不在 P0 的

npm 发布、远端分支保护与 CODEOWNERS、签名提交、`sync` 写全局、探针与反思器:都是 P1 及以后。
