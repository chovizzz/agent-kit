# A24 生命周期变异抽检(人工完成项,与 A20 / A13 同构)

A24 不是普通脚本:它要求对 attest / promote / retire 功能的 9 处关键逻辑各做一次变异,**每一处都必须让测试变红**,再把代码还原。
`ops/accept-p1.sh --list` 与汇总里 A24 恒显示为【人工完成项】,状态由下面的标记文件决定;没有有效标记就按「未执行(4)」计入失败汇总。

## 9 处核心变异(L1–L9)

| 编号 | 变异                                                          | 位置                                     | 应变红的测试                                                               |
| ---- | ------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| L1   | C1 跳过 injection 复核(本地危险话术扫描的命中被忽略)          | `src/lifecycle/checks.ts`(`checkC1`)     | `test/lifecycle/checks-text.test.ts`                                       |
| L2   | C6 不归一化(对全文直接取哈希)                                 | `src/lifecycle/checks.ts`(`checkC6`)     | `test/lifecycle/checks-gov.test.ts`、`test/commands/promote-adopt.test.ts` |
| L3   | judge 不写 `rule_sha256`                                      | `src/judge/run.ts`                       | `test/judge/rule-hash.test.ts`、`test/commands/promote-adopt.test.ts`      |
| L4   | `promote --run` 用评审前的旧补丁内容(提案文件不含 judge 记录) | `src/lifecycle/adopt.ts`                 | `test/commands/promote-adopt.test.ts`                                      |
| L5   | 晋升不查 attest 阈值                                          | `src/guards/criteria.ts`(`need`)         | `test/guards/criteria.test.ts`、`test/commands/promote.test.ts`            |
| L6   | retire 不写 lifecycle 记录                                    | `src/lifecycle/retire.ts`                | `test/commands/retire.test.ts`、`test/lifecycle/retire-patch.test.ts`      |
| L7   | 墓碑不参与 C7                                                 | `src/lifecycle/checks.ts`(`checkC7`)     | `test/lifecycle/checks-gov.test.ts`、`test/commands/promote.test.ts`       |
| L8   | CI 判据比本地 C5 宽(去掉 `C5_EXTRA_REASONS`)                  | `src/guards/criteria.ts`(`judgeChecks`)  | `test/guards/criteria.test.ts`                                             |
| L9   | `--write` 缺省也写(干跑也落盘 `.state/promote`)               | `src/commands/promote.ts`(`promoteRule`) | `test/commands/promote.test.ts`                                            |

另有两处验收脚本自检(不计入标记的 9 处,`--set all` 才跑):X1 = A21 矩阵不再逐条核对原因码;X2 = A22 的 import 图检查不再拒绝 `llm-exec`
(都由 `test/accept/p1-lifecycle-ops.test.ts` 变红)。

具体替换文本、匹配次数断言(必须恰好 1 次)和预期变红用例的完整标题都写在 `ops/accept/lib/a24.mjs` 的 `MUTATIONS` 里;
`test/accept/p1-lifecycle-ops.test.ts` 另有一条用例在**未变异**的源码上核对每处 `find` 恰好出现 1 次(源码漂移时先在那里红)。

## 做法(防止「变异没生效却显示绿」)

自动做法(推荐):

```sh
export KIT_TMP=$(mktemp -d /tmp/ak-a24.XXXX); chmod 700 $KIT_TMP     # 指向仓库外
node ops/accept/lib/a24.mjs --run --set a24 --write-marker             # 只做 L1–L9,全红且基线为绿才写标记(工作树须干净)
node ops/accept/lib/a24.mjs --run --set all                            # 做全部 11 处(L1–L9 + X1–X2),不写标记
node ops/accept/lib/a24.mjs --run --ids L4,L9                          # 只做指定几处,不写标记
```

约 8 分钟(每处变异跑一次相关 vitest 文件)。脚本做的事,手工做时照此执行:

1. 先在**未变异**的树上跑对应测试(并集),确认基线是绿的(否则「变红」不能说明任何事);
2. 变异前 `cp <文件> <文件>.mut-bak`(**不要用 `git checkout` 还原**:会丢掉未提交的改动),并记下原 mtime;
3. 用脚本做替换并**先断言匹配次数恰好为 1**(0 次 = 变异没落到代码上,多次 = 改多了),再跑测试;
4. 红的判据:vitest 进程非零退出,**并且**该变异的 `redTitles`(预期变红用例的**完整标题**,整串精确相等,不是子串)里至少一条确实变红;变异运行里有 skipped / todo、有测试文件加载失败、`redTitles` 有标题没出现在这次运行里或同名出现多次,一律不算红;`redTitles` 之外的失败用例是无关红灯,不计入(共用判据 `judgeMutationRed` 在 `ops/accept/lib/common.mjs`);
5. `cp <文件>.mut-bak <文件>` 还原、删备份,并**恢复原 mtime**(变异窗口里没有构建 dist,vitest 直接跑 `.ts`;恢复 mtime 后 dist 仍与 src 一致,A16–A19、A21–A23 不会变成「未执行」)。
   这一点与 A20 不同:A20 不恢复 mtime、结束后重新 build;A24 不构建,所以可以恢复。全部做完再跑一次并集基线,必须为绿;
6. 变异期间**同一棵树里不要开别的 vitest**(也不要跑 `pnpm run build`);
7. 进程收到 SIGINT/SIGTERM 会先还原再退出;SIGKILL 会留下 `.mut-bak`,下一次运行与 `freshDist` 都会拒绝继续,先人工处理(把 `.mut-bak` 拷回原文件)。

## 标记文件

9 处都变红、已还原、基线重新为绿之后,写 `.state/accept/a24.done`(已被 gitignore,不入库),**内容恰好如下**(`#` 开头的行与空行忽略):

```
head: <当前 HEAD 的 40 位提交 SHA>
result: 9/9 red
L1: red
L2: red
L3: red
L4: red
L5: red
L6: red
L7: red
L8: red
L9: red
```

- `head:` 必须等于当前 `git rev-parse HEAD`。**提交之后标记就过期**(状态显示「未做」,detail 为 stale):A24 要在最终提交之后做、或提交后重做。
- 缺任何一行、多出任何内容、`result` 不是 `9/9 red`(A20 的 `6/6 red` 标记不能冒充),一律按无效处理。
- 标记只是「主代理声明做过」的凭据,不替代上面的做法;验收汇报里仍应逐处写出变异位置与失败信息。
