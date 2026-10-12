# B15 存量盘点命令 — 格式契约见 docs/contracts.md §4.3:<编号>\t<命令>\t<期望值>\t<时点 UTC>
# 每条命令只读、单行,可在仓库根 bash -c 直接执行;期望值为该时点实测输出。报告里的 [#编号] 与此一一对应。
B15-001	wc -c < ~/.claude/CLAUDE.md | tr -d ' '	41310	2026-10-12T10:11:05Z
B15-002	LC_ALL=C awk '{s+=length($0)+1} END{print s+0}' ~/.claude/CLAUDE.md	41310	2026-10-12T10:11:05Z
B15-003	wc -l < ~/.claude/CLAUDE.md | tr -d ' '	363	2026-10-12T10:11:05Z
B15-004	awk 'END{print NR}' ~/.claude/CLAUDE.md	363	2026-10-12T10:11:05Z
B15-005	shasum -a 256 ~/.claude/CLAUDE.md | cut -c1-64	8e646e1212bf58300d52c240b53e43519aa2a5510525de8579f316e6500a8835	2026-10-12T10:11:05Z
B15-006	awk 'BEGIN{f=0;n=0} /^[ \t]*(```|~~~)/{f=!f;next} !f && /^#{1,3} /{n++} END{print n+0}' ~/.claude/CLAUDE.md	10	2026-10-12T10:11:05Z
B15-007	grep -cE '^#{1,3} ' ~/.claude/CLAUDE.md	10	2026-10-12T10:11:05Z
B15-008	awk 'BEGIN{f=0} /^[ \t]*(```|~~~)/{f=!f;next} !f && /^#{1,3} /{l=match($0,/ /)-1; c[l]++} END{printf "L1=%d L2=%d L3=%d\n", c[1]+0, c[2]+0, c[3]+0}' ~/.claude/CLAUDE.md	L1=1 L2=5 L3=4	2026-10-12T10:11:05Z
B15-009	LC_ALL=C awk 'BEGIN{f=0;s=0} /^[ \t]*(```|~~~)/{f=!f} !f && /^#{1,3} /{s++} {b[s]+=length($0)+1} END{for(i=0;i<=s;i++) printf "%s%d", (i?" ":""), b[i]+0; print ""}' ~/.claude/CLAUDE.md	0 22 2046 647 12876 163 5023 9969 3120 1709 5735	2026-10-12T10:11:05Z
B15-010	LC_ALL=C awk 'BEGIN{f=0;s=0} /^[ \t]*(```|~~~)/{f=!f} !f && /^#{1,3} /{s++} {b[s]+=length($0)+1} END{for(i=0;i<=s;i++) print b[i]+0}' ~/.claude/CLAUDE.md | awk '{t+=$1} END{print t+0}'	41310	2026-10-12T10:11:05Z
B15-011	LC_ALL=C awk 'BEGIN{f=0;s=0} /^[ \t]*(```|~~~)/{f=!f} !f && /^#{1,3} /{s++} {c[s]++} END{for(i=0;i<=s;i++) printf "%s%d", (i?" ":""), c[i]+0; print ""}' ~/.claude/CLAUDE.md	0 2 18 10 122 4 26 83 14 30 54	2026-10-12T10:11:05Z
B15-012	awk 'BEGIN{f=0} /^[ \t]*(```|~~~)/{f=!f;next} !f && /^#{1,3} /{print NR} END{print NR+1}' ~/.claude/CLAUDE.md | awk 'NR>1{print p, $1-1} {p=$1}' | while read a b; do sed -n "${a},${b}p" ~/.claude/CLAUDE.md | shasum -a 256 | cut -c1-64; done | paste -sd' ' -	cc3df3bb9e6db53e040eb8e64ee2958635cfb4f3b7aa0bb8c74197fad13fead5 69711c034638d3ae32fc361c76ba06ca15cf81b5924c8fcfd4601d7d7cf878f4 ff39f36fe97553f82f83880f2e52242c2709724c8f80b1bf0455120f84c6c0fc 14778137c15aa7f19c43d804f67f23477520f9a8bda8119b481a97655086d36a 16d64c2b06f33188f24a7cafc5283c6b9584fe1b576cee3576619e6db1a6be1d b691ff3ad9df806b22ad92377e0b156befc6546edcde2c331420a8185f83add0 8a92fb28976d83b06df2d9edd2bb2425026c3b3afabe4ffd9d4d2fa9ca6d2d4a 76528114ccc4c63a721eb04589108bcb26098bf2bcc76fe17556bf9236296a0a e577dd3c28d0c318cc5c565d97ec03d0ba696f50f864d2661707dfad3844e4f4 9c8375a49bcdcbeec1fc9ee66b0d2565daf1b607bb53f76a30dc8d2e86c39093	2026-10-12T10:11:05Z
B15-013	ls -1 ~/.claude/skills | wc -l | tr -d ' '	208	2026-10-12T10:11:05Z
B15-014	find ~/.claude/skills -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l | tr -d ' '	208	2026-10-12T10:11:05Z
B15-015	ls -1 ~/.agents/skills | wc -l | tr -d ' '	252	2026-10-12T10:11:05Z
B15-016	find ~/.agents/skills -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l | tr -d ' '	252	2026-10-12T10:11:05Z
B15-017	ls -1 ~/.kimi-code/skills | wc -l | tr -d ' '	37	2026-10-12T10:11:05Z
B15-018	find ~/.kimi-code/skills -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l | tr -d ' '	37	2026-10-12T10:11:05Z
B15-019	find ~/.claude/skills -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l | tr -d ' '	78	2026-10-12T10:11:05Z
B15-020	ls -l ~/.claude/skills | grep -c '^l'	78	2026-10-12T10:11:05Z
B15-021	cd ~/.claude/skills && for n in $(find . -mindepth 1 -maxdepth 1 ! -name '.*' -type l | sed 's#^\./##'); do [ "$(readlink "$n")" = "../../.agents/skills/$n" ] && echo y; done | wc -l | tr -d ' '	78	2026-10-12T10:11:05Z
B15-022	cd ~/.claude/skills && for n in *; do [ -L "$n" ] && [ "$(readlink "$n")" = "../../.agents/skills/$n" ] && echo y || true; done | wc -l | tr -d ' '	78	2026-10-12T10:11:05Z
B15-023	cd ~/.claude/skills && for n in *; do [ -L "$n" ] && [ ! -e "$n" ] && echo x || true; done | wc -l | tr -d ' '	0	2026-10-12T10:11:05Z
B15-024	comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	194	2026-10-12T10:11:05Z
B15-025	cd ~/.agents/skills && n=0; for x in $(ls -1 ~/.claude/skills); do [ -e "$x" ] && n=$((n+1)); done; echo $n	194	2026-10-12T10:11:05Z
B15-026	comm -23 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	14	2026-10-12T10:11:05Z
B15-027	comm -13 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	58	2026-10-12T10:11:05Z
B15-028	comm -12 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	36	2026-10-12T10:11:05Z
B15-029	comm -23 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	1	2026-10-12T10:11:05Z
B15-030	cd ~/.claude/skills && for n in $(comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort)); do if [ -L "$n" ]; then echo sym; elif [ "$(cd "$HOME/.claude/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" = "$(cd "$HOME/.agents/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" ]; then echo same; else echo drift; fi; done | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}'; echo	drift=41 same=75 sym=78	2026-10-12T10:11:05Z
B15-031	cd ~/.claude/skills && for n in $(comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort)); do if [ -L "$n" ]; then echo sym; elif diff -rq "$HOME/.claude/skills/$n" "$HOME/.agents/skills/$n" >/dev/null 2>&1; then echo same; else echo drift; fi; done | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}'; echo	drift=41 same=75 sym=78	2026-10-12T10:11:05Z
B15-032	cd ~/.kimi-code/skills && for n in $(comm -12 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort)); do if [ -L "$n" ]; then echo sym; elif [ "$(cd "$HOME/.kimi-code/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" = "$(cd "$HOME/.agents/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" ]; then echo same; else echo drift; fi; done | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}'; echo	drift=1 same=35	2026-10-12T10:11:05Z
B15-033	jq -r '.skills[].id' ~/.agents/skills/.social-hub-skills.json | sort -u | comm -12 - <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	36	2026-10-12T10:11:05Z
B15-034	(jq -r '.skills[].id' ~/.agents/skills/.social-hub-skills.json; jq -r '.entries[].artifact | split("/")[-1]' ~/.agents/skills/.geoly/ledger.json) | sort -u | comm -12 - <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	36	2026-10-12T10:11:05Z
B15-035	find ~/.agents/skills -mindepth 1 -maxdepth 2 \( -name plugin.json -o -name .claude-plugin \) | wc -l | tr -d ' '	0	2026-10-12T10:11:05Z
B15-036	comm -23 <(ls -1 ~/.agents/skills | sort) <(jq -r '.skills[].id' ~/.agents/skills/.social-hub-skills.json | sort -u) | wc -l | tr -d ' '	216	2026-10-12T10:11:05Z
B15-037	find ~/.agents/skills -mindepth 1 -maxdepth 1 -name .geoly -type d | wc -l | tr -d ' '	1	2026-10-12T10:11:05Z
B15-038	ls -d ~/.claude/projects/*/memory 2>/dev/null | wc -l | tr -d ' '	13	2026-10-12T10:11:05Z
B15-039	find ~/.claude/projects -mindepth 2 -maxdepth 2 -type d -name memory | wc -l | tr -d ' '	13	2026-10-12T10:11:05Z
B15-040	for d in ~/.claude/projects/*/memory; do ls -1 "$d" | wc -l; done | awk '{s+=$1} END{print s+0}'	>=396	2026-10-09T01:47:53Z
B15-041	find ~/.claude/projects -mindepth 3 -maxdepth 3 -path '*/memory/*' -type f ! -name '.*' | wc -l | tr -d ' '	>=396	2026-10-09T01:47:53Z
B15-042	for d in ~/.claude/projects/*/memory; do p=$(basename "$(dirname "$d")"); printf %s "$p" | shasum -a 256 | cut -c1-8; done | sort | paste -sd' ' -	08b410b6 32f608a6 3b7c18ab 3e9ccf57 4ab90bef 53d79adc 5d5069e5 663cb7e2 66ef1351 6881b014 c62dcb78 d6a01043 f58a11f5	2026-10-12T10:11:05Z
B15-043	find ~/.claude/projects -mindepth 3 -maxdepth 3 -path '*/memory/MEMORY.md' | wc -l | tr -d ' '	13	2026-10-12T10:11:05Z
B15-044	find ~/.claude/projects -mindepth 3 -maxdepth 3 -path '*/memory/*' -type d | wc -l | tr -d ' '	0	2026-10-12T10:11:05Z
B15-045	jq -r '.hooks|keys|join(",")' ~/.claude/settings.json	PreToolUse	2026-10-12T10:11:05Z
B15-046	jq -r '.hooks|to_entries[]|.key as $e|.value[]|"\($e):\(.matcher // "-")"' ~/.claude/settings.json | paste -sd' ' -	PreToolUse:Bash PreToolUse:Write PreToolUse:Agent	2026-10-12T10:11:05Z
B15-047	jq -r '.hooks[][]?.hooks[]?.command // empty' ~/.claude/settings.json | grep -c .	3	2026-10-12T10:11:05Z
B15-048	jq -r '.hooks[][]?.hooks[]?.command // empty' ~/.claude/settings.json | grep -oE '[^[:space:]"'"'"']+\.(sh|js|mjs|cjs|py|ts)' | paste -sd' ' -	$HOME/.claude/hooks/guard-bash.sh $HOME/.claude/hooks/guard-write.sh $HOME/.claude/hooks/guard-agent-model.sh	2026-10-12T10:11:05Z
B15-049	jq -r '.hooks[][]?.hooks[]?.command // empty' ~/.claude/settings.json | grep -oE '[^[:space:]"'"'"']+\.(sh|js|mjs|cjs|py|ts)' | while read -r p; do q="${p/#\~/$HOME}"; q="${q//\$HOME/$HOME}"; wc -c < "$q" | tr -d ' '; done | paste -sd' ' -	4994 2794 15138	2026-10-12T10:11:05Z
B15-050	wc -c < ~/AGENTS.md | tr -d ' '	2725	2026-10-12T10:11:05Z
B15-051	shasum -a 256 ~/AGENTS.md | cut -c1-64	de44af4ba73bb973f420b05195febb356b53a71c2b885c528a64fef36686e060	2026-10-12T10:11:05Z
B15-052	wc -c < ~/workspace/AGENTS.md | tr -d ' '	2678	2026-10-12T10:11:05Z
B15-053	shasum -a 256 ~/workspace/AGENTS.md | cut -c1-64	7e11d4d4db4a6ab61f1c4077c8e4cd9be3bac57464b172b3e57875cf286281ed	2026-10-12T10:11:05Z
B15-054	jq '.skills|length' ~/.agents/skills/.social-hub-skills.json	36	2026-10-12T10:11:05Z
B15-055	jq '.entries|length' ~/.agents/skills/.geoly/ledger.json	7	2026-10-12T10:11:05Z
B15-056	cd ~/.claude/skills && n=0; for x in $(comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort)); do [ -L "$x" ] && continue; h1=$(cd "$HOME/.claude/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); h2=$(cd "$HOME/.agents/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); [ "$h1" = "$h2" ] && n=$((n+1)); done; echo $n	75	2026-10-12T10:11:05Z
B15-057	cd ~/.kimi-code/skills && m=0; for x in $(comm -12 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort)); do [ -L "$x" ] && continue; h1=$(cd "$HOME/.kimi-code/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); h2=$(cd "$HOME/.agents/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); [ "$h1" = "$h2" ] && m=$((m+1)); done; echo $m	35	2026-10-12T10:11:05Z
B15-058	jq -r '.entries[].artifact | split("/")[-1]' ~/.agents/skills/.geoly/ledger.json | sort -u | comm -12 - <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	0	2026-10-12T10:11:05Z
B15-059	jq -r '.hooks|to_entries[]|.key as $e|.value[]|(.matcher // "-") as $m|.hooks[]?|"\($m)\t\(.command // "")"' ~/.claude/settings.json | while IFS=$'\t' read -r m c; do s=$(printf '%s' "$c" | grep -oE '[^[:space:]"'"'"']+\.(sh|js|mjs|cjs|py|ts)' | awk -F/ '{print $NF}' | head -1); echo "$m:$s"; done | paste -sd' ' -	Bash:guard-bash.sh Write:guard-write.sh Agent:guard-agent-model.sh	2026-10-12T10:11:05Z
B15-060	find ~/.agents/skills -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l | tr -d ' '	0	2026-10-12T10:11:05Z
B15-061	find ~/.kimi-code/skills -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l | tr -d ' '	0	2026-10-12T10:11:05Z
