# 运行手册:停在 `rolling_back` 的候选与不合规的回滚 journal

适用:`rsi auto status` 把某个候选列为 `stalled`(或 `unconfirmed`),或 `rsi show <id>` / `rsi auto clear` 报 `journal=invalid`。契约依据:`docs/contracts.md` §21.24 W0-22 第 10 条、W0-25。

## 先弄清两件事

- **不会自动恢复。** 停住的候选(原因属需要原始证据的类,journal 又丢了或不可读)不会被 worker 自己救回来;状态里看到 `stalled` 不等于正在恢复。
- **终态原因记为 `cleared` / `vetoed`,原保护仍按进入回滚时的原因生效。** 处置之后冷却等保护仍按原来的原因发,不会因为人工处置而变弱。

## 固定处置(命令能做的部分)

1. 撤销凭据尚未写入(`revoked=no`)时,先执行 `rsi auto pause`,让自动注入先停下来。
2. 再二选一:
   - `rsi auto clear --write`:处理全部非终态候选;
   - `rsi veto <id>`:只处理这一个候选。代价:该指纹永久进黑名单,并计入 `user_vetoes`。
3. 完成证据:命令退 0,并且 `rsi auto status` 在 `view_state=fresh` 下没有 `stalled` 与 `unconfirmed`。截断的清单(`rollback_stalled_truncated` 为 `true` 或 `null`)不能当作处置完成的证据。
4. 不要写「处置完成后 resume」:`rsi auto resume` 只清熔断码与用户暂停,与回滚处置无关。

## 不合规的 journal(命令输出只给 `journal=invalid` 与「按运行手册处置」)

命令不提供「修复 journal」的开关,也不会输出路径。按下列步骤手工判断,**不要靠删除 journal 来恢复**。

1. **先暂停**:`rsi auto pause`。
2. **保全证据**:把下面这些复制到一个只读的备份目录,不要原地修改:
   - `rsi-personal/txn` 下该事务的文件;
   - 撤销凭据 `revocations.jsonl`;
   - `head.json` 记录的那个提交里该候选的记录。
3. **验证身份与内容绑定**:
   - `txn_id` 与 `(candidate_id, content_sha256)` 按 `rollbackTxnId` 推导的结果一致;
   - `kind` / `reason` / `by` / `target_terminal` 与 `terminal_event` 相容;
   - 撤销凭据里是否已经有 `(candidate_id, content_sha256)` 这一行。
4. **只有能证明**可以由权威记录加撤销凭据重建出同一事务,才由专门的工具或支持协助重建。**不要手工删除** journal,也不要把「删掉它就能恢复」当作结论:journal 是续做的依据,删掉等于丢掉进度与来源。
5. **证明不了就继续停住**,保持暂停,把证据交给支持或维护者;停住是安全方向(撤销凭据一旦写入,hint 与 `exec-run` 已经停止对它注入或执行)。

## 其它

- 同一候选出现两份不一致的 journal、或 journal 无法解析,都属于「完整性错误」:它不会被另一份 journal 的 `complete` 消除,`rsi auto clear --write` 会退 3(`reason=txn_invalid`)直到处置完成。
- `RSI_MANUAL txn=… cause=manual_event_required` / `manual_by_ambiguous` 表示缺的是原始事实(终止事件或来源),命令不会伪造;按上面的步骤 2 – 5 处理。
