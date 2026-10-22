# A20 变异抽检(人工完成项,与 A13 同构)

A20 不是普通脚本:它要求对 6 处关键逻辑各做一次变异,**每一处都必须让测试变红**,再把代码还原。
`ops/accept-p1.sh --list` 与汇总里 A20 恒显示为【人工完成项】,状态由下面的标记文件决定;没有有效标记就按「未执行(4)」计入失败汇总。

## 6 处变异点(M1–M6)

| 编号 | 变异                                                                      | 位置                                             | 应变红的测试                                                    |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| M1   | reflect:外部内容会话的摘录进了提示(装载不清空 + 证据资格不再排除外部内容) | `src/reflect/load.ts`、`src/reflect/evidence.ts` | `test/commands/r5-e2e.test.ts`、`test/reflect/*`                |
| M2   | judge:与反思器同厂商的跳没被拒绝,照常调用后端                             | `src/judge/run.ts`(同厂商判断与 `isCrossVendor`) | `test/judge/run.test.ts`、`test/commands/r5-e2e.test.ts`        |
| M3   | 干跑误写:干跑模式被改成会走后端失败路径、写出 report                      | `src/commands/reflect.ts`(`mode: … : 'dry'`)     | `test/commands/reflect.test.ts`                                 |
| M4   | 状态转移绕过:合并器把新原子写成 `status: active`                          | `src/reflect/merge.ts`                           | `test/commands/r5-e2e.test.ts`、`test/commands/reflect.test.ts` |
| M5   | egress 门:`--run-llm` 缺 `--allow-egress` 也执行                          | `src/commands/reflect.ts`(`parseArgs`)           | `test/commands/reflect.test.ts`                                 |
| M6   | judge 越权改提案的其它字段(多写 `layer`,且拆掉「只许改 judge」的不变式)   | `src/judge/store.ts`(`applyJudgeFields`)         | `test/judge/*`、`test/commands/r5-e2e.test.ts`                  |

具体替换文本、匹配次数断言和预期变红用例的完整标题都写在 `ops/accept/lib/a20.mjs` 的 `MUTATIONS` 里
(同一张表另有 `X1`–`X14` 共 14 处附加变异,覆盖 `--owner` 不校验、默认模式改成真跑、干跑也构造后端、unknown 厂商放行、数字参数改回 `Number`、
退出码映射错位、`team_project_keys` 缺省放行团队层、`allow_unverified` 缺省为真、judge 默认命令干跑时构造后端、`--json` 含提示文本、
A19 快照比对被跳过、A16 不再核对原因码、`budgetFull` 恒 false、覆盖层未同意外发也放行)。

## 做法(防止「变异没生效却显示绿」)

自动做法(推荐):

```sh
export KIT_TMP=$(mktemp -d /tmp/ak-a20.XXXX); chmod 700 $KIT_TMP     # 指向仓库外
node ops/accept/lib/a20.mjs --run --set a20 --write-marker             # 只做 M1–M6,全红且基线为绿才写标记
node ops/accept/lib/a20.mjs --run --set all                            # 做全部 20 处(M1–M6 + X1–X14),不写标记
```

脚本做的事,手工做时照此执行:

1. 先在**未变异**的树上跑对应测试(并集),确认基线是绿的(否则「变红」不能说明任何事);
2. 变异前 `cp <文件> <文件>.mut-bak`(**不要用 `git checkout` 还原**:会丢掉未提交的改动);
3. 用脚本做替换并**先断言匹配次数恰好为 1**(0 次 = 变异没落到代码上,多次 = 改多了),再跑测试;
4. 红的判据:vitest 进程非零退出,**并且**该变异的 `redTitles`(预期变红用例的**完整标题**,整串精确相等,不是子串)里至少一条确实变红;变异运行里有 skipped / todo、有测试文件加载失败、`redTitles` 有标题没出现在这次运行里或同名出现多次,一律不算红;`redTitles` 之外的失败用例是无关红灯,不计入(共用判据 `judgeMutationRed` 在 `ops/accept/lib/common.mjs`);
5. `cp <文件>.mut-bak <文件>` 还原、删备份,**恢复原 mtime**(否则 `dist` 会被判陈旧,A16–A19 变成「未执行」);全部做完再跑一次并集基线,必须为绿;
6. 变异期间**同一棵树里不要开别的 vitest**。

## 标记文件

6 处都变红、已还原、基线重新为绿之后,写 `.state/accept/a20.done`(已被 gitignore,不入库),**内容恰好如下**(`#` 开头的行与空行忽略):

```
head: <当前 HEAD 的 40 位提交 SHA>
result: 6/6 red
M1: red
M2: red
M3: red
M4: red
M5: red
M6: red
```

- `head:` 必须等于当前 `git rev-parse HEAD`。**提交之后标记就过期**(状态显示「未做」,detail 为 stale):A20 要在最终提交之后做、或提交后重做。
- 缺任何一行、多出任何内容、`result` 不是 `6/6 red`,一律按无效处理。
- 标记只是「主代理声明做过」的凭据,不替代上面的做法;验收汇报里仍应逐处写出变异位置与失败信息。
