# hooks 与 AGENTS.md 盘点(B15)

- 时点:2026-10-13T06:01:20Z(UTC)。
- 范围:`~/.claude/settings.json` 中的 `hooks` 字段,只记事件名、matcher、脚本路径与脚本字节数;脚本内容与该文件其它字段**均未读取或记录**。另记 `~/AGENTS.md` 与 `~/workspace/AGENTS.md` 的大小与 sha256。

## hooks 清单

事件名:`PreToolUse` [#B15-045]。hook 条目共 3 条 [#B15-046]、hook 命令共 7 条 [#B15-047]。

| 事件       | matcher | 脚本路径                               | 脚本字节数 | 编号                        |
| ---------- | ------- | -------------------------------------- | ---------- | --------------------------- |
| PreToolUse | Bash    | `~/.claude/hooks/guard-bash.sh`        | 4994       | [#B15-049]、映射 [#B15-059] |
| PreToolUse | Write   | `~/.claude/hooks/guard-write.sh`       | 2794       | [#B15-049]、映射 [#B15-059] |
| PreToolUse | Agent   | `~/.claude/hooks/guard-agent-model.sh` | 5226       | [#B15-049]、映射 [#B15-059] |

- 脚本路径 [#B15-048] 在 `settings.json` 中写作 `$HOME/.claude/hooks/...`,此处统一写为 `~/`。
- 字节数顺序与路径顺序一致 [#B15-049];路径与 matcher 的一一对应由 [#B15-059] 独立给出。

## AGENTS.md

| 文件                    | 字节数 | sha256                                                                        | 编号            |
| ----------------------- | ------ | ----------------------------------------------------------------------------- | --------------- |
| `~/AGENTS.md`           | 2725   | `de44af4ba73bb973f420b05195febb356b53a71c2b885c528a64fef36686e060` [#B15-051] | 字节 [#B15-050] |
| `~/workspace/AGENTS.md` | 2678   | `7e11d4d4db4a6ab61f1c4077c8e4cd9be3bac57464b172b3e57875cf286281ed` [#B15-053] | 字节 [#B15-052] |

两个文件均存在。内容未记录。

## 备注

- 本盘点不判断这些 hook 是否应被纳入后续的分类或迁移,只做登记。
