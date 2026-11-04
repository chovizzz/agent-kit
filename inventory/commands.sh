# B15 存量盘点命令 — 格式契约见 docs/contracts.md §4.3:<编号>\t<命令>\t<期望值>\t<时点 UTC>
# 每条命令只读、单行,可在仓库根 bash -c 直接执行;期望值为该时点实测输出。报告里的 [#编号] 与此一一对应。
B15-001	wc -c < ~/.claude/CLAUDE.md | tr -d ' '	41728	2026-11-04T07:48:23Z
B15-002	LC_ALL=C awk '{s+=length($0)+1} END{print s+0}' ~/.claude/CLAUDE.md	41728	2026-11-04T07:48:23Z
B15-003	wc -l < ~/.claude/CLAUDE.md | tr -d ' '	269	2026-11-04T07:48:23Z
B15-004	awk 'END{print NR}' ~/.claude/CLAUDE.md	269	2026-11-04T07:48:23Z
B15-005	shasum -a 256 ~/.claude/CLAUDE.md | cut -c1-64	719ab8e9df34fbbb7b6d90bcda094ac790ea7fabb4bae38238e6ec3c3f6377d3	2026-11-04T07:48:23Z
B15-006	awk 'BEGIN{f=0;n=0} /^[ \t]*(```|~~~)/{f=!f;next} !f && /^#{1,3} /{n++} END{print n+0}' ~/.claude/CLAUDE.md	13	2026-11-04T07:48:23Z
B15-007	grep -cE '^#{1,3} ' ~/.claude/CLAUDE.md	13	2026-11-04T07:48:23Z
B15-008	awk 'BEGIN{f=0} /^[ \t]*(```|~~~)/{f=!f;next} !f && /^#{1,3} /{l=match($0,/ /)-1; c[l]++} END{printf "L1=%d L2=%d L3=%d\n", c[1]+0, c[2]+0, c[3]+0}' ~/.claude/CLAUDE.md	L1=1 L2=12 L3=0	2026-11-04T07:48:23Z
B15-009	LC_ALL=C awk 'BEGIN{f=0;s=0} /^[ \t]*(```|~~~)/{f=!f} !f && /^#{1,3} /{s++} {b[s]+=length($0)+1} END{for(i=0;i<=s;i++) printf "%s%d", (i?" ":""), b[i]+0; print ""}' ~/.claude/CLAUDE.md	0 377 1711 9143 2809 5132 3901 2341 2895 1306 6050 2593 1822 1648	2026-11-04T07:48:23Z
B15-010	LC_ALL=C awk 'BEGIN{f=0;s=0} /^[ \t]*(```|~~~)/{f=!f} !f && /^#{1,3} /{s++} {b[s]+=length($0)+1} END{for(i=0;i<=s;i++) print b[i]+0}' ~/.claude/CLAUDE.md | awk '{t+=$1} END{print t+0}'	41728	2026-11-04T07:48:23Z
B15-011	LC_ALL=C awk 'BEGIN{f=0;s=0} /^[ \t]*(```|~~~)/{f=!f} !f && /^#{1,3} /{s++} {c[s]++} END{for(i=0;i<=s;i++) printf "%s%d", (i?" ":""), c[i]+0; print ""}' ~/.claude/CLAUDE.md	0 4 17 56 25 20 23 12 17 9 56 10 10 10	2026-11-04T07:48:23Z
B15-012	awk 'BEGIN{f=0} /^[ \t]*(```|~~~)/{f=!f;next} !f && /^#{1,3} /{print NR} END{print NR+1}' ~/.claude/CLAUDE.md | awk 'NR>1{print p, $1-1} {p=$1}' | while read a b; do sed -n "${a},${b}p" ~/.claude/CLAUDE.md | shasum -a 256 | cut -c1-64; done | paste -sd' ' -	cebc0b8c33016e0f7f951feb88c535b5bc48a53357e5b4dd53b514dbbb8369f5 c5110e26f692c069db6f1c599fb689441257aaa24765fe1c02df2c8f3dfe90e2 35c7a3044e02bea3e8ffe1ea0e7c0b2157432381df59c860189e6555d423149a df7d7fa74b7898e81cf6ffc9ca011f19d06d88818784fa60fda10e846683a0a1 d24e5deae6e56e62198fbdf6fa93644e47cac447d37487af0e42c98852a8f338 329dc8147cd9a6422933e1694b80ad158e3e86c68584dd4e9432bb86ff9ed3bb b644cbd9b5654ebdcbbf4788c67ab46ae1233caf150a2a1eb7bbac786ea0c522 295611a832ae5de325336c69488f040a01bb90b0cfba5b66418c766233fa0630 f757092f3600a2f76fd593b5f6f28ef9203b61c44298399892dc3103844fd684 0014f82dc293cd7bcfcb88425fb010f97ed6872ff0b2e6ccdcce9991291895d1 18271c7716ca783936083b4861d377d16a576d278f76e86199952c61c7f58e3c 8fe162ab4c2df3befac23c41297ce830abddb0bc856d7838d8a5b2d5c5a7a0cf 61c3d00ab9063a4ab6824dc9898a8d2e0e5d01c2dd6ec53e43ca3405fc87c495	2026-11-04T07:48:23Z
B15-013	ls -1 ~/.claude/skills | wc -l | tr -d ' '	218	2026-11-04T07:48:23Z
B15-014	find ~/.claude/skills -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l | tr -d ' '	218	2026-11-04T07:48:23Z
B15-015	ls -1 ~/.agents/skills | wc -l | tr -d ' '	255	2026-11-04T07:48:23Z
B15-016	find ~/.agents/skills -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l | tr -d ' '	255	2026-11-04T07:48:23Z
B15-017	ls -1 ~/.kimi-code/skills | wc -l | tr -d ' '	37	2026-11-04T07:48:23Z
B15-018	find ~/.kimi-code/skills -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l | tr -d ' '	37	2026-11-04T07:48:23Z
B15-019	find ~/.claude/skills -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l | tr -d ' '	85	2026-11-04T07:48:23Z
B15-020	ls -l ~/.claude/skills | grep -c '^l'	85	2026-11-04T07:48:23Z
B15-021	cd ~/.claude/skills && for n in $(find . -mindepth 1 -maxdepth 1 ! -name '.*' -type l | sed 's#^\./##'); do [ "$(readlink "$n")" = "../../.agents/skills/$n" ] && echo y; done | wc -l | tr -d ' '	80	2026-11-04T07:48:23Z
B15-022	cd ~/.claude/skills && for n in *; do [ -L "$n" ] && [ "$(readlink "$n")" = "../../.agents/skills/$n" ] && echo y || true; done | wc -l | tr -d ' '	80	2026-11-04T07:48:23Z
B15-023	cd ~/.claude/skills && for n in *; do [ -L "$n" ] && [ ! -e "$n" ] && echo x || true; done | wc -l | tr -d ' '	0	2026-11-04T07:48:23Z
B15-024	comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	197	2026-11-04T07:48:23Z
B15-025	cd ~/.agents/skills && n=0; for x in $(ls -1 ~/.claude/skills); do [ -e "$x" ] && n=$((n+1)); done; echo $n	197	2026-11-04T07:48:23Z
B15-026	comm -23 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	21	2026-11-04T07:48:23Z
B15-027	comm -13 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	58	2026-11-04T07:48:23Z
B15-028	comm -12 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	36	2026-11-04T07:48:23Z
B15-029	comm -23 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	1	2026-11-04T07:48:23Z
B15-030	cd ~/.claude/skills && for n in $(comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort)); do if [ -L "$n" ]; then echo sym; elif [ "$(cd "$HOME/.claude/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" = "$(cd "$HOME/.agents/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" ]; then echo same; else echo drift; fi; done | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}'; echo	drift=41 same=76 sym=80	2026-11-04T07:48:23Z
B15-031	cd ~/.claude/skills && for n in $(comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort)); do if [ -L "$n" ]; then echo sym; elif diff -rq "$HOME/.claude/skills/$n" "$HOME/.agents/skills/$n" >/dev/null 2>&1; then echo same; else echo drift; fi; done | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}'; echo	drift=41 same=76 sym=80	2026-11-04T07:48:23Z
B15-032	cd ~/.kimi-code/skills && for n in $(comm -12 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort)); do if [ -L "$n" ]; then echo sym; elif [ "$(cd "$HOME/.kimi-code/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" = "$(cd "$HOME/.agents/skills/$n" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256)" ]; then echo same; else echo drift; fi; done | sort | uniq -c | awk '{printf "%s%s=%s", (NR>1?" ":""), $2, $1}'; echo	drift=1 same=35	2026-11-04T07:48:23Z
B15-033	jq -r '.skills[].id' ~/.agents/skills/.social-hub-skills.json | sort -u | comm -12 - <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	36	2026-11-04T07:48:23Z
B15-034	(jq -r '.skills[].id' ~/.agents/skills/.social-hub-skills.json; jq -r '.entries[].artifact | split("/")[-1]' ~/.agents/skills/.geoly/ledger.json) | sort -u | comm -12 - <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	36	2026-11-04T07:48:23Z
B15-035	find ~/.agents/skills -mindepth 1 -maxdepth 2 \( -name plugin.json -o -name .claude-plugin \) | wc -l | tr -d ' '	0	2026-11-04T07:48:23Z
B15-036	comm -23 <(ls -1 ~/.agents/skills | sort) <(jq -r '.skills[].id' ~/.agents/skills/.social-hub-skills.json | sort -u) | wc -l | tr -d ' '	219	2026-11-04T07:48:23Z
B15-037	find ~/.agents/skills -mindepth 1 -maxdepth 1 -name .geoly -type d | wc -l | tr -d ' '	1	2026-11-04T07:48:23Z
B15-038	ls -d ~/.claude/projects/*/memory 2>/dev/null | wc -l | tr -d ' '	18	2026-11-04T07:48:23Z
B15-039	find ~/.claude/projects -mindepth 2 -maxdepth 2 -type d -name memory | wc -l | tr -d ' '	18	2026-11-04T07:48:23Z
B15-040	for d in ~/.claude/projects/*/memory; do ls -1 "$d" | wc -l; done | awk '{s+=$1} END{print s+0}'	>=396	2026-10-09T01:47:53Z
B15-041	find ~/.claude/projects -mindepth 3 -maxdepth 3 -path '*/memory/*' -type f ! -name '.*' | wc -l | tr -d ' '	>=396	2026-10-09T01:47:53Z
B15-042	for d in ~/.claude/projects/*/memory; do p=$(basename "$(dirname "$d")"); printf %s "$p" | shasum -a 256 | cut -c1-8; done | sort | paste -sd' ' -	08b410b6 32f608a6 3b7c18ab 3bde7cc7 3e9ccf57 4ab90bef 4cb3d531 503f2a94 53d79adc 5d5069e5 663cb7e2 66ef1351 6881b014 759e209b c62dcb78 d6a01043 eabbdf8b f58a11f5	2026-11-04T07:48:23Z
B15-043	find ~/.claude/projects -mindepth 3 -maxdepth 3 -path '*/memory/MEMORY.md' | wc -l | tr -d ' '	13	2026-11-04T07:48:23Z
B15-044	find ~/.claude/projects -mindepth 3 -maxdepth 3 -path '*/memory/*' -type d | wc -l | tr -d ' '	0	2026-11-04T07:48:23Z
B15-045	jq -r '.hooks|keys|join(",")' ~/.claude/settings.json	PostToolUse,PreModelSwitch,PreToolUse,UserPromptSubmit	2026-11-04T07:48:23Z
B15-046	jq -r '.hooks|to_entries[]|.key as $e|.value[]|"\($e):\(.matcher // "-")"' ~/.claude/settings.json | paste -sd' ' -	PreModelSwitch:.*fable.* UserPromptSubmit:- PostToolUse:AskUserQuestion PostToolUse:- PreToolUse:Bash PreToolUse:Write PreToolUse:Agent PreToolUse:AskUserQuestion	2026-11-04T07:49:12Z
B15-047	jq -r '.hooks[][]?.hooks[]?.command // empty' ~/.claude/settings.json | grep -c .	8	2026-11-04T07:48:23Z
B15-048	jq -r '.hooks[][]?.hooks[]?.command // empty' ~/.claude/settings.json | grep -oE '[^[:space:]"'"'"']+\.(sh|js|mjs|cjs|py|ts)' | paste -sd' ' -	~/.claude/hooks/guard-model-switch.sh $HOME/.claude/hooks/usage-handoff-hint.sh $HOME/.claude/feishu-relay/ask-done-hook.mjs $HOME/.claude/hooks/usage-handoff-hint.sh $HOME/.claude/hooks/guard-bash.sh $HOME/.claude/hooks/guard-write.sh $HOME/.claude/hooks/guard-agent-model.sh $HOME/.claude/feishu-relay/ask-hook.mjs	2026-11-04T07:49:12Z
B15-049	jq -r '.hooks[][]?.hooks[]?.command // empty' ~/.claude/settings.json | grep -oE '[^[:space:]"'"'"']+\.(sh|js|mjs|cjs|py|ts)' | while read -r p; do q="${p/#\~/$HOME}"; q="${q//\$HOME/$HOME}"; wc -c < "$q" | tr -d ' '; done | paste -sd' ' -	1105 1246 699 1246 4994 2794 6361 1896	2026-11-04T07:48:23Z
B15-050	wc -c < ~/AGENTS.md | tr -d ' '	2725	2026-11-04T07:48:23Z
B15-051	shasum -a 256 ~/AGENTS.md | cut -c1-64	de44af4ba73bb973f420b05195febb356b53a71c2b885c528a64fef36686e060	2026-11-04T07:48:23Z
B15-052	wc -c < ~/workspace/AGENTS.md | tr -d ' '	2678	2026-11-04T07:48:23Z
B15-053	shasum -a 256 ~/workspace/AGENTS.md | cut -c1-64	7e11d4d4db4a6ab61f1c4077c8e4cd9be3bac57464b172b3e57875cf286281ed	2026-11-04T07:48:23Z
B15-054	jq '.skills|length' ~/.agents/skills/.social-hub-skills.json	36	2026-11-04T07:48:23Z
B15-055	jq '.entries|length' ~/.agents/skills/.geoly/ledger.json	7	2026-11-04T07:48:23Z
B15-056	cd ~/.claude/skills && n=0; for x in $(comm -12 <(ls -1 ~/.claude/skills | sort) <(ls -1 ~/.agents/skills | sort)); do [ -L "$x" ] && continue; h1=$(cd "$HOME/.claude/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); h2=$(cd "$HOME/.agents/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); [ "$h1" = "$h2" ] && n=$((n+1)); done; echo $n	76	2026-11-04T07:48:23Z
B15-057	cd ~/.kimi-code/skills && m=0; for x in $(comm -12 <(ls -1 ~/.kimi-code/skills | sort) <(ls -1 ~/.agents/skills | sort)); do [ -L "$x" ] && continue; h1=$(cd "$HOME/.kimi-code/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); h2=$(cd "$HOME/.agents/skills/$x" && find . -type f ! -name '.DS_Store' -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); [ "$h1" = "$h2" ] && m=$((m+1)); done; echo $m	35	2026-11-04T07:48:23Z
B15-058	jq -r '.entries[].artifact | split("/")[-1]' ~/.agents/skills/.geoly/ledger.json | sort -u | comm -12 - <(ls -1 ~/.agents/skills | sort) | wc -l | tr -d ' '	0	2026-11-04T07:48:23Z
B15-059	jq -r '.hooks|to_entries[]|.key as $e|.value[]|(.matcher // "-") as $m|.hooks[]?|"\($m)\t\(.command // "")"' ~/.claude/settings.json | while IFS=$'\t' read -r m c; do s=$(printf '%s' "$c" | grep -oE '[^[:space:]"'"'"']+\.(sh|js|mjs|cjs|py|ts)' | awk -F/ '{print $NF}' | head -1); echo "$m:$s"; done | paste -sd' ' -	.*fable.*:guard-model-switch.sh -:usage-handoff-hint.sh AskUserQuestion:ask-done-hook.mjs -:usage-handoff-hint.sh Bash:guard-bash.sh Write:guard-write.sh Agent:guard-agent-model.sh AskUserQuestion:ask-hook.mjs	2026-11-04T07:49:12Z
B15-060	find ~/.agents/skills -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l | tr -d ' '	0	2026-11-04T07:48:23Z
B15-061	find ~/.kimi-code/skills -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l | tr -d ' '	0	2026-11-04T07:48:23Z
