/**
 * 停在 `rolling_back` 的候选的人工处置文案(contracts §21.24 W0-22 第 10 条;固定文案,不含路径,不写「删除即可恢复」「完成后 resume」)。
 * 固定处置:①撤销凭据尚未写入(`revoked=no`)时先 `rsi auto pause`;②`rsi auto clear --write`(全部非终态候选)或 `rsi veto <id>`(只此候选,代价:指纹永久黑名单、计入 `user_vetoes`);
 * ③完成证据 = 命令退 0 且 `rsi auto status` 在 `view_state=fresh` 下无 `stalled` / `unconfirmed`。不合规 journal 只写 `journal=invalid` 与「按运行手册处置」。
 */
export const MANUAL_DISPOSAL_LINES: readonly string[] = Object.freeze([
  '不会自动恢复;终态原因记为 cleared / vetoed,原保护仍按进入回滚时的原因生效',
  '处置:revoked=no 时先执行 rsi auto pause;再执行 rsi auto clear --write(全部非终态候选)或 rsi veto <id>(只此候选,代价:指纹永久黑名单、计入 user_vetoes)',
  '完成证据:命令退 0,且 rsi auto status 在 view_state=fresh 下无 stalled 与 unconfirmed',
]);
export const INVALID_JOURNAL_LINE = 'journal=invalid 按运行手册处置';
