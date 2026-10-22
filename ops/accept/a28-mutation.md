# A28 sync / update 变异抽检(人工完成项,与 A24 / A20 / A13 同构)

A28 不是普通脚本:它要求对 sync / update 的 8 处关键逻辑各做一次变异,**每一处都必须让测试变红**,再把代码还原。
`ops/accept-p1.sh --list` 与汇总里 A28 恒显示为【人工完成项】,状态由下面的标记文件决定;没有有效标记就按「未执行(4)」计入失败汇总。

## 8 处核心变异(S1–S8)

| 编号 | 变异                                                                 | 位置                                                    | 应变红的测试                                                               |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1   | 卸载不删块(`block_remove` 不再从文件里移除托管块)                    | `src/sync/txn.ts`(`block_remove` 分支)                  | `test/sync/command.test.ts`(装 → 卸载)、`test/sync/recovery.test.ts`(卸载) |
| S2   | 回滚时备份内容不校验 sha(被改过的备份也被当作写前全文还原)           | `src/sync/apply.ts`(`rollbackTxn`)                      | `test/sync/rollback-backup-sha.test.ts`(本块新增,原先没有用例钉这一行)     |
| S3   | 回滚不检前提(文件当前 sha 不等于该事务写入后的 sha 也照样还原)       | `src/sync/apply.ts`(`rollbackTxn` 的 `file_changed`)    | `test/sync/recovery.test.ts`(回滚前提不成立)                               |
| S4   | registry 夹具路径守卫放宽(KIT_TMP 之外的 `file://` 目录也被接受)     | `src/update/registry.ts`(`openRegistrySource`)          | `test/update/registry.test.ts`                                             |
| S5   | 锁不复核 `assertHeld`(锁被夺走后仍继续写)                            | `src/sync/apply.ts`(`acquireLock` 的 `assertHeld`)      | `test/sync/lock-lost.test.ts`                                              |
| S6   | 完整性校验跳过(`dist.integrity` 与 tarball 不符也继续安装)           | `src/update/install.ts`(`sriMatches` 调用处)            | `test/update/install-flow.test.ts`(dist.integrity 与 tarball 不符)         |
| S7   | 回滚不验上一版本目录的完整树(被篡改 / 多文件的上一版本也被切回)      | `src/update/install.ts`(`verifyInstalledTree` 结果)     | `test/update/install-rollback.test.ts`                                     |
| S8   | sync 写前不复核文件当前 sha(计划之后被用户改过的文件会被覆盖 / 删除) | `src/sync/apply.ts`(`applyTxn` 的 `changed_during_run`) | `test/sync/recovery.test.ts`(计划之后、写盘之前文件被改)                   |

具体替换文本、匹配次数断言(必须恰好 1 次)和预期变红用例的完整标题都写在 `ops/accept/lib/a28.mjs` 的 `MUTATIONS` 里;
`test/accept/p1-sync-update-ops.test.ts` 另有一条用例在**未变异**的源码上核对每处 `find` 恰好出现 1 次(源码漂移时先在那里红)。

## 做法(防止「变异没生效却显示绿」)

自动做法(推荐):

```sh
export KIT_TMP=$(mktemp -d /tmp/ak-a28.XXXX); chmod 700 $KIT_TMP     # 指向仓库外
node ops/accept/lib/a28.mjs --run --write-marker                      # 全做;全红、基线为绿、真实 HOME 无差异才写标记(工作树须干净)
node ops/accept/lib/a28.mjs --run --ids S2,S5                         # 只做指定几处,不写标记
```

约 1.5 分钟(javis,M4)。脚本做的事,手工做时照此执行:

1. 先在**未变异**的树上跑对应测试(并集),确认基线是绿的(否则「变红」不能说明任何事);
2. 变异前 `cp <文件> <文件>.mut-bak`(**不要用 `git checkout` 还原**:会丢掉未提交的改动;脚本用 `COPYFILE_EXCL` 拷备份,已有备份就报错而不覆盖,所以两个实例同时跑会失败而不是互相覆盖),并记下原 mtime;
3. 用脚本做替换并**先断言匹配次数恰好为 1**(0 次 = 变异没落到代码上,多次 = 改多了),再跑测试;
4. 红的判据:vitest 进程非零退出,**并且**该变异的 `redTitles`(预期变红用例的**完整标题**,整串精确相等,不是子串)里至少一条确实变红;变异运行里有 skipped / todo、有测试文件加载失败、或 `redTitles` 有标题没出现在这次运行里或同名出现多次,一律不算红;`redTitles` 之外的失败用例是无关红灯,不计入(判据是 A20 / A24 / A28 共用的 `judgeMutationRed`,在 `ops/accept/lib/common.mjs`);
5. `cp <文件>.mut-bak <文件>` 还原、删备份,并**恢复原 mtime**(变异窗口里没有构建 dist,vitest 直接跑 `.ts`,所以 dist 仍与 src 一致)。全部做完再跑一次并集基线,必须为绿;
6. **假 HOME**:vitest 子进程的 `HOME` 是 `tmp/sbx-home`,`KIT_TMP` / `TMPDIR` 在同级的 `tmp/sbx-kit`(产品拒绝「KIT_TMP 是 HOME 的上级」,所以二者必须是同级)。
   整个运行开始与结束各取一次真实 HOME 快照(`ops/managed-paths.txt` 的受管路径 + `~/.local/share|state/agent-kit`、`~/.config/agent-kit` 的树),有差异按「待人工归因(5)」报并拒绝写标记;
7. 变异期间**同一棵树里不要开别的 vitest**(也不要跑 `pnpm run build`);
8. 进程收到 SIGINT/SIGTERM 会先还原再退出;SIGKILL 会留下 `.mut-bak`,下一次运行与 `freshDist` 都会拒绝继续,先人工处理(把 `.mut-bak` 拷回原文件)。

## 实跑记录(javis,基线 116/116 通过,还原后 116/116)

| 编号 | 结果 | 指向被变异行为的失败用例(节选)                                                                    |
| ---- | ---- | ------------------------------------------------------------------------------------------------- |
| S1   | red  | `装 → 卸载:受管路径树逐字节一致…`、`只卸一个 agent:共用路径仍被其它 agent 请求就保留…`            |
| S2   | red  | `备份内容被改(sha 对不上)=> SYNC_ROLLBACK_MISMATCH,整次不写`                                      |
| S3   | red  | `回滚前提不成立 → SYNC_ROLLBACK_MISMATCH,整次不写(文件被改 / 登记表被改 / 不是最新事务 …)`        |
| S4   | red  | `KIT_TMP 之外 / 没有 KIT_TMP / 非 file:// 写法 → registry_fixture_outside_tmp`                    |
| S5   | red  | `journal 写完后锁被夺走:不写任何受管文件…`、`写第一个文件之后锁被夺走:不继续写后面的文件与登记表` |
| S6   | red  | `dist.integrity 与 tarball 不符(非镜像)→ integrity,拉黑,不再重试`                                 |
| S7   | red  | `上一版本目录被篡改 → 不切(完整树校验)…`、`上一版本目录里多了文件 → 同样拒绝`                     |
| S8   | red  | `计划之后、写盘之前文件被改(竞态):写前复核指纹,拒绝覆盖 / 删除用户版本`                           |

S2 在本块之前没有任何用例钉「备份 sha 核对」这一行(变异存活),所以本块补了 `test/sync/rollback-backup-sha.test.ts`(含正向对照:备份完好则回滚成功)。

## 标记文件

8 处都变红、已还原、基线重新为绿之后,写 `.state/accept/a28.done`(已被 gitignore,不入库),**内容恰好如下**(`#` 开头的行与空行忽略):

```
head: <当前 HEAD 的 40 位提交 SHA>
result: 8/8 red
S1: red
S2: red
S3: red
S4: red
S5: red
S6: red
S7: red
S8: red
```

- 标记绑定的是**开跑时**的 HEAD;结束时 HEAD 变了或工作树被改动,脚本拒绝写标记。
- `head:` 必须等于当前 `git rev-parse HEAD`。**提交之后标记就过期**(状态显示「未做」,detail 为 stale):A28 要在最终提交之后做、或提交后重做。
- 缺任何一行、多出任何内容、`result` 不是 `8/8 red`(A24 的 `9/9 red`、A20 的 `6/6 red` 标记不能冒充),一律按无效处理。
- 标记只是「主代理声明做过」的凭据,不替代上面的做法;验收汇报里仍应逐处写出变异位置与失败信息。
