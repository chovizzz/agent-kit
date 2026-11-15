/**
 * §21 V1 装配块 A 段(只读适配)必杀变异:`resolveGitPath` 的每条拒绝原因、`peekRecord(s)` / `recordedSha` 的失败映射(读失败绝不是 missing / absent)、撤销凭据读与 B 标记读的失败映射、
 * 暂存提案 / 信号 / 预置技能三个读来源端口、分析源四端口(`payloadDrift` / `collectedThrough` / `c4Bytes`)、读侧组合根的未装配 / 惰性 / 零 I/O 语义、
 * 读侧 import 闭包与 eslint 的写出口拦截(契约 §21.24 W0-22 第 6 条、R21-7.7、R21-6.11 第 4a 行;设计稿 verify_r21-asm-design-v2.md 第 6 节 A 段)。
 * 执行方式同 W5 / W6 / W7 / W8:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理 / 验证机执行,结果记进 `V1_ASM_A_RESULTS`(与表**同序**;未执行时留空)。变异 id 用短的下划线词。
 * 不在本表的点(如实记录):读 / 写分文件的搬迁(ledger / pause-marker / judge store / signals store-error / candidate 端口类型)只有「再导出兼容性」断言(`a-zero-write.test.ts`),搬迁后行为不变由基线 diff 核对与既有 W5 / W7 / judge 行为用例承担,不另设变异;
 * `entry_not_probed`(登记路径落在写入表外)没有可构造的夹具,未设变异;`resolveGitPath` 的文件名预检(`path.basename(candidate)`)被 realpath 文件名检查等价覆盖,未设变异。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmAMutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmAResult {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const swap = (file: string, anchor: string, replacement: string): Edit => ({
  file,
  anchor,
  replacement,
});

export const V1_ASM_A_MUTATIONS: readonly V1AsmAMutation[] = [
  {
    id: 'gp_not_file_accepted',
    clause: 'resolveGitPath:不是普通文件的候选被接受',
    edits: [swap('src/rsi/auto/git-path.ts', '    if (!st.isFile) return null;\n', '')],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    mustKill: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
  },
  {
    id: 'gp_exec_bit_dropped',
    clause: 'resolveGitPath:不可执行的候选被接受',
    edits: [
      swap('src/rsi/auto/git-path.ts', '    if ((st.mode & 0o111) === 0) return null;\n', ''),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    mustKill: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
  },
  {
    id: 'gp_writable_accepted',
    clause: 'resolveGitPath:组 / 其他人可写的候选被接受',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '    (st.mode & 0o022) === 0 && (st.uid === 0 || st.uid === probe.uid);\n',
        '    st.uid === 0 || st.uid === probe.uid;\n',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: [
      '候选是符号链接',
      '父目录可被组 / 其他人写',
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    mustKill: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
  },
  {
    id: 'gp_owner_unchecked',
    clause: 'resolveGitPath:属主既非 root 也非当前用户的候选被接受',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '    (st.mode & 0o022) === 0 && (st.uid === 0 || st.uid === probe.uid);\n',
        '    (st.mode & 0o022) === 0;\n',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: [
      '父目录可被组 / 其他人写',
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    mustKill: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
  },
  {
    id: 'gp_real_name_unchecked',
    clause: 'resolveGitPath:realpath 之后文件名不是 git 仍被接受',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        "    if (!path.isAbsolute(real) || path.basename(real) !== 'git') return null;\n",
        '',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: ['realpath 之后文件名不是 git'],
    mustKill: ['realpath 之后文件名不是 git'],
  },
  {
    id: 'gp_probe_error_accepted',
    clause: 'resolveGitPath:探测失败(不存在 / 不可读)被当成可用',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '  } catch {\n    return null;\n  }',
        '  } catch {\n    return candidate;\n  }',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
      '全部解析不到 → null(保持未装配);只探测固定候选(不查 PATH:合规的 git 放在别处也不影响结果)',
    ],
    mustKill: [
      '拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
  },
  {
    id: 'peek_read_error_absent',
    clause: 'peek:读抛错被映射成 absent(而不是 invalid)',
    edits: [
      swap(
        'src/rsi/auto/read/peek.ts',
        "      return { kind: 'invalid', why: 'unreadable' };",
        "      return { kind: 'absent' };",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid'],
    mustKill: ['peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid'],
  },
  {
    id: 'peek_exit_absent',
    clause: 'peek:不稳定 / 读取失败的退出被映射成 absent',
    edits: [
      swap(
        'src/rsi/auto/read/peek.ts',
        "        kind: 'invalid',\n        why: v.stderr.startsWith(RSI_SNAPSHOT_BUSY)",
        "        kind: 'absent',\n        why: v.stderr.startsWith(RSI_SNAPSHOT_BUSY)",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid'],
    mustKill: ['peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid'],
  },
  {
    id: 'peek_head_null_ok',
    clause: 'peek:head.json 不存在不再是 absent',
    edits: [
      swap(
        'src/rsi/auto/read/peek.ts',
        "    if (v.head === null) return { kind: 'absent' };\n",
        '',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing'],
    mustKill: ['peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing'],
  },
  {
    id: 'peek_invalid_as_missing',
    clause: 'peek:读失败被映射成 missing(veto 会误判 unknown_id)',
    edits: [
      swap(
        'src/rsi/auto/read/peek.ts',
        "    if (r.kind !== 'ok') return r;",
        "    if (r.kind !== 'ok') return { kind: 'missing', head: '' };",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      'peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid',
      'peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing(正向对照)',
    ],
    mustKill: ['peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid'],
  },
  {
    id: 'peek_id_ignored',
    clause: 'peek:不看 id,总返回第一条记录(缺失判不出来)',
    edits: [
      swap(
        'src/rsi/auto/read/peek.ts',
        '    const rec = r.value.find((x) => x.id === id);',
        '    const rec = r.value[0];',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing'],
    mustKill: ['peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing'],
  },
  {
    id: 'sha_failure_value',
    clause: 'recordedSha:读不到时返回值而不是 null',
    edits: [
      swap(
        'src/rsi/auto/read/peek.ts',
        "    if (r.kind !== 'ok') return null;",
        "    if (r.kind !== 'ok') return '';",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['recordedSha:读到 = content_sha256;读不到 / 候选不在 / 记录坏 = null'],
    mustKill: ['recordedSha:读到 = content_sha256;读不到 / 候选不在 / 记录坏 = null'],
  },
  {
    id: 'cred_throw_empty',
    clause: '凭据读:端口抛错被当成空凭据',
    edits: [
      swap(
        'src/rsi/personal/read/credentials.ts',
        "      } catch {\n        return { kind: 'invalid', why: 'unreadable' };",
        "      } catch {\n        return { kind: 'ok', lines: [] };",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['端口抛错 → invalid(不外泄、不当成空)'],
    mustKill: ['端口抛错 → invalid(不外泄、不当成空)'],
  },
  {
    id: 'cred_unreadable_empty',
    clause: '凭据读:读失败(权限过宽 / 链接 / 超限)被当成空凭据',
    edits: [
      swap(
        'src/rsi/personal/read/credentials.ts',
        "      if (raw.kind === 'unreadable') return { kind: 'invalid', why: 'unreadable' };",
        "      if (raw.kind === 'unreadable') return { kind: 'ok', lines: [] };",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid',
    ],
    mustKill: [
      '缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid',
    ],
  },
  {
    id: 'cred_parse_empty',
    clause: '凭据读:坏行 / 缺尾换行被当成空凭据',
    edits: [
      swap(
        'src/rsi/personal/read/credentials.ts',
        "      return p.kind === 'ok' ? { kind: 'ok', lines: p.value } : { kind: 'invalid', why: 'parse' };",
        "      return { kind: 'ok', lines: p.kind === 'ok' ? p.value : [] };",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid',
    ],
    mustKill: [
      '缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid',
    ],
  },
  {
    id: 'marker_error_absent',
    clause: 'B 标记读:不可安全读取(unsafe:读错误 / 权限 / 超限 / 链接)被当成不存在',
    edits: [
      swap(
        'src/rsi/canary/pause-marker-read.ts',
        "      if (r.kind === 'missing') return null;\n",
        "      if (r.kind === 'missing' || r.kind === 'unsafe') return null;\n",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '权限过宽 / 硬链接 / 超限',
      '缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错',
    ],
    mustKill: [
      '缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错',
    ],
  },
  {
    id: 'staged_classify_skipped',
    clause: '暂存提案:不归属 P 的证据不再被排除',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        'cls.set(k, await d.classify(k))',
        "cls.set(k, 'P')",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['只收未 tainted、证据非空、全部归属 P 的 run;其余不装载'],
    mustKill: ['只收未 tainted、证据非空、全部归属 P 的 run;其余不装载'],
  },
  {
    id: 'staged_load_swallowed',
    clause: '暂存提案:装载失败被吞掉(尽量)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        '        const r = await load(d.io, run.runId);',
        '        const r = await load(d.io, run.runId).catch(() => ({ loaded: [], unsupported: [] }));',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['装载失败 / 暂存清单读失败 → 抛错(不跳过坏 run 去尽量)'],
    mustKill: ['装载失败 / 暂存清单读失败 → 抛错(不跳过坏 run 去尽量)'],
  },
  {
    id: 'signal_bad_row_skipped',
    clause: '信号查询:不合 schema 的行被跳过(少计冒充成功)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        '          if (!p.success) return false;',
        '          if (!p.success) return true;',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['任一行不合 schema → 整体抛错(不返回「少几条」冒充成功)'],
    mustKill: ['任一行不合 schema → 整体抛错(不返回「少几条」冒充成功)'],
  },
  {
    id: 'preset_content_skipped',
    clause: '预置技能:内容缺失被跳过(返回少一项)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        "        if (text === undefined) throw new PresetError('content_missing');",
        '        if (text === undefined) continue;',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文',
    ],
    mustKill: [
      '读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文',
    ],
  },
  {
    id: 'preset_shape_loose',
    clause: '预置技能:缺 description / 空值 / 非字符串不再抛错',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        "  if (!nonEmpty(name) || !nonEmpty(description) || body === '') {",
        "  if (!nonEmpty(name) || body === '') {",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文',
      'frontmatter 按 YAML 取真实值:折叠多行标量、引号;空值 / 非字符串 / 非映射 / 坏 YAML → 抛错;包内真实技能文件可解析',
    ],
    mustKill: [
      '读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文',
    ],
  },
  {
    id: 'preset_yaml_naive',
    clause: '预置技能:frontmatter 退回按行取值(折叠多行标量读成字面 `>`)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        '    fm = parseYaml(m[1] as string);',
        "    fm = Object.fromEntries((m[1] as string).split('\\n').map((l) => [l.split(':')[0], (l.split(':')[1] ?? '').trim()]));",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['frontmatter 按 YAML 取真实值'],
    mustKill: ['frontmatter 按 YAML 取真实值'],
  },
  {
    id: 'signal_vanished_ignored',
    clause: '信号查询:已枚举的月文件打开前消失被忽略(查询只完成一部分却成功)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        "        if (id === null) throw new SignalLookupError('month_file_vanished');\n",
        '',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['已枚举的月文件打开前消失(scan 返回 null)→ 整体抛错'],
    mustKill: ['已枚举的月文件打开前消失(scan 返回 null)→ 整体抛错'],
  },
  {
    id: 'marker_nonregular_accepted',
    clause:
      'B 标记读:不安全(符号链接 / 非普通文件 / 权限过宽 / 硬链接 / 超限)不再被拒,被读成「不存在」',
    edits: [
      swap(
        'src/rsi/canary/pause-marker-read.ts',
        "      if (r.kind === 'unsafe') throw new MarkerUnsafeError(r.why);\n",
        "      if (r.kind === 'unsafe') return null;\n",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '检查之后、打开之前被换成悬空符号链接',
      '检查之后、打开之前被换成指向有效文件的符号链接',
      '权限过宽 / 硬链接 / 超限',
      '缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错',
    ],
    mustKill: [
      '缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错',
    ],
  },
  {
    id: 'preset_kind_ignored',
    clause: '预置技能:非 skill 类别的文件也被收',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        "        if (f.kind !== 'skill') continue;\n",
        '',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文'],
    mustKill: ['取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文'],
  },
  {
    id: 'preset_nonskillmd_taken',
    clause: '预置技能:skill 目录里非 SKILL.md 的文件也被收',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        "        if (!f.payload_path.endsWith('/SKILL.md')) continue;\n",
        '',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文'],
    mustKill: ['取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文'],
  },
  {
    id: 'drift_ledger_unreadable_clean',
    clause: 'payloadDrift:登记表不可读 / 不合规被落成 clean',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        "if (lr.state !== 'ok') throw new PortError('ledger_unreadable');",
        "if (lr.state !== 'ok') return 'clean';",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean'],
    mustKill: ['登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean'],
  },
  {
    id: 'drift_entry_unsafe_skipped',
    clause: 'payloadDrift:条目路径是链接 / 非普通文件被跳过',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        "if (preflightEntry(disk, e.block_id) !== null) throw new PortError('entry_unsafe');",
        'if (preflightEntry(disk, e.block_id) !== null) continue;',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean'],
    mustKill: ['登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean'],
  },
  {
    id: 'drift_sha_ignored',
    clause: 'payloadDrift:独占文件内容与登记 sha 不符不算漂移',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        'if (!cur.present || cur.markerDrifted || cur.sha !== e.sha256) drifted = true;',
        'if (!cur.present || cur.markerDrifted) drifted = true;',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts', 'rsi/asm/a-empty-write-root.test.ts'],
    expectRed: [
      '没有登记表 = clean(只表示没有登记项漂移);内容与登记一致 = clean(对照);被改过 = drifted',
      '非空世界的对照',
    ],
    mustKill: [
      '没有登记表 = clean(只表示没有登记项漂移);内容与登记一致 = clean(对照);被改过 = drifted',
    ],
  },
  {
    id: 'through_partial_ok',
    clause: 'collectedThrough:ok_partial 的 tick 被当成已覆盖',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        "if (t === null || t.outcome !== 'ok') return null;",
        'if (t === null) return null;',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      'ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null',
    ],
    mustKill: [
      'ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null',
    ],
  },
  {
    id: 'through_end_not_start',
    clause: 'collectedThrough:取 tick 结束时刻而不是开始时刻',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        'return new Date(start).toISOString();',
        'return new Date(end).toISOString();',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      'duration_ms 大于完成时刻',
      'ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null',
    ],
    mustKill: [
      'ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null',
    ],
  },
  {
    id: 'c4_unavailable_zero',
    clause: 'c4Bytes:不可得返回 0 而不是 null',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        "return r.kind === 'ok' ? c4BytesOfDoc(r.value) : null;",
        "return r.kind === 'ok' ? c4BytesOfDoc(r.value) : 0;",
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['合规 = 字节数;缺失 / 不合规 = null(不是 0)'],
    mustKill: ['合规 = 字节数;缺失 / 不合规 = null(不是 0)'],
  },
  {
    id: 'asm_unwired_fake_success',
    clause: '组合根:gitPath 解析不到时仍装配 git 适配器(假装成功)',
    edits: [
      swap(
        'src/rsi/assemble-read.ts',
        '          ? unwiredRecordedRead',
        "          ? makeGitReadonly({ gitPath: '/usr/bin/git', gitDir: d.gitDir, spawn: d.gitSpawn })",
      ),
    ],
    tests: ['rsi/asm/a-factory-zero-io.test.ts'],
    expectRed: ['recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次'],
    mustKill: ['recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次'],
  },
  {
    id: 'asm_gitpath_not_memoized',
    clause: '组合根:git 路径每次调用都重新解析',
    edits: [swap('src/rsi/assemble-read.ts', '    (port ??= d', '    (port = d')],
    tests: ['rsi/asm/a-factory-zero-io.test.ts'],
    expectRed: ['recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次'],
    mustKill: ['recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次'],
  },
  {
    id: 'asm_eager_gitpath',
    clause: '组合根:工厂创建时就解析 git 路径(创建不得有 I/O)',
    edits: [
      swap(
        'src/rsi/assemble-read.ts',
        '  const home = makeHomeReadPort(d.home);',
        '  const home = (void d.gitPath(), makeHomeReadPort(d.home));',
      ),
    ],
    tests: ['rsi/asm/a-factory-zero-io.test.ts'],
    expectRed: [
      'assembleReadAdapters 创建:零读盘、不解析 git 路径、不调 payload / spawn',
      'recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次,spawn 一次都不调;解析到但仓库目录不存在 = 在预检就拒绝,同样不 spawn',
    ],
    mustKill: ['assembleReadAdapters 创建:零读盘、不解析 git 路径、不调 payload / spawn'],
  },
  {
    id: 'closure_root_safe_fs',
    clause: '读侧组合根的闭包里出现 safe-fs',
    edits: [
      swap(
        'src/rsi/assemble-read.ts',
        "import type { Redactor } from '../contracts/redact.js';",
        "import type { Redactor } from '../contracts/redact.js';\nimport { writeFile as asmProbeWrite } from '../io/safe-fs.js';\nexport const asmProbe = asmProbeWrite;",
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    mustKill: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
  },
  {
    id: 'closure_staged_store',
    clause: '暂存提案读入口改回含写出口的 judge/store.ts',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        "from '../../../judge/store-read.js';",
        "from '../../../judge/store.js';",
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    mustKill: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
  },
  {
    id: 'closure_analysis_ledger',
    clause: '分析读取层改回含写出口的 canary/ledger.ts',
    edits: [
      swap(
        'src/rsi/analysis/read.ts',
        "import { readLedger } from '../canary/ledger-read.js';",
        "import { readLedger } from '../canary/ledger.js';",
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    mustKill: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
  },
  {
    id: 'closure_attribution_lock',
    clause: '归属判定改回经 lock.ts',
    edits: [
      swap(
        'src/rsi/services/attribution.ts',
        "import { RSI_FILE_OWNER, rsiDirReadonly } from '../lock-read.js';",
        "import { RSI_FILE_OWNER, rsiDirReadonly } from '../lock.js';",
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    mustKill: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
  },
  {
    id: 'closure_scan_state_store',
    clause: '月文件扫描改回 import 含写出口的 state-store.ts',
    edits: [
      swap(
        'src/signals/store-scan.ts',
        "import { SignalStoreError } from './store-error.js';",
        "import { SignalStoreError } from './state-store.js';",
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    mustKill: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
  },
  {
    id: 'closure_marker_safe_fs',
    clause: 'B 标记只读模块的闭包里出现 safe-fs',
    edits: [
      swap(
        'src/rsi/canary/pause-marker-read.ts',
        "import { readFileSafe } from '../../io/read-fs.js';",
        "import { readFileSafe } from '../../io/read-fs.js';\nimport { createExclusiveDurable } from '../../io/safe-fs.js';\nexport const asmProbe = createExclusiveDurable;",
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    mustKill: [
      '不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
  },
  {
    id: 'eslint_read_root_rule_dropped',
    clause: 'eslint:读根文件的写出口 import 限制被去掉',
    edits: [
      swap(
        'eslint.config.js',
        '  { files: READ_ROOT_FILES, rules: readRootRestrictions() },\n',
        '',
      ),
    ],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: ['safe-fs / exec / 锁 / 含写出口的原模块:读根文件红'],
    mustKill: ['safe-fs / exec / 锁 / 含写出口的原模块:读根文件红'],
  },
  {
    id: 'eslint_ledger_not_forbidden',
    clause: 'eslint:读根文件可 import 含写出口的 canary/ledger.ts',
    edits: [swap('eslint.config.js', "  '**/ledger.js',\n", '')],
    tests: ['rsi/asm/a-zero-write.test.ts'],
    expectRed: ['safe-fs / exec / 锁 / 含写出口的原模块:读根文件红'],
    mustKill: ['safe-fs / exec / 锁 / 含写出口的原模块:读根文件红'],
  },
  // ---- 验收评审采纳项(H1 / H2 / M1 / M2 / M3 / L1 / L2)新增 ----
  {
    id: 'gp_returns_candidate',
    clause: 'resolveGitPath:返回候选原路径而不是规范路径(候选链接可在探测后被换掉)',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '    return real;\n  } catch {',
        '    return candidate;\n  } catch {',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: ['候选是符号链接'],
    mustKill: ['候选是符号链接'],
  },
  {
    id: 'gp_stat_candidate_not_real',
    clause: 'resolveGitPath:元数据检查对象是候选名而不是规范路径指向的文件',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '    const st = await probe.stat(real);\n',
        '    const st = await probe.stat(candidate);\n',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: ['候选是符号链接', 'realpath 之后文件名不是 git'],
    mustKill: ['候选是符号链接'],
  },
  {
    id: 'gp_parent_unchecked',
    clause: 'resolveGitPath:父目录可被组 / 其他人写(目录项可被替换)仍被接受',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '    const dir = await probe.stat(path.dirname(real));\n    if (!dir.isDirectory || !trusted(dir)) return null;\n',
        '',
      ),
    ],
    tests: ['rsi/asm/a-git-path.test.ts'],
    expectRed: ['父目录可被组 / 其他人写'],
    mustKill: ['父目录可被组 / 其他人写'],
  },
  {
    id: 'marker_check_use_race',
    clause:
      'B 标记读:改回按路径 lstat 后再 readText(检查—使用竞态:检查后被换成链接被跟随 / 悬空链接被读成「不存在」)',
    edits: [
      swap(
        'src/rsi/canary/pause-marker-read.ts',
        "import { readFileSafe } from '../../io/read-fs.js';",
        "import { lstat, readText } from '../../io/read-fs.js';",
      ),
      swap(
        'src/rsi/canary/pause-marker-read.ts',
        `      const r = await readFileSafe(file, {
        maxBytes: MARKER_MAX_BYTES,
        owner: RSI_FILE_OWNER,
        ...(seam.beforeOpen === undefined ? {} : { beforeOpen: seam.beforeOpen }),
      });
`,
        `      const r = await (async (): Promise<any> => {
        try {
          const st = await lstat(file);
          if (!st.isFile() || st.isSymbolicLink()) return { kind: 'unsafe', why: 'link' };
          await seam.beforeOpen?.();
          return { kind: 'ok', bytes: Buffer.from(await readText(file)) };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
          throw e;
        }
      })();
`,
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
      '检查之后、打开之前被换成悬空符号链接',
      '检查之后、打开之前被换成指向有效文件的符号链接',
      '权限过宽 / 硬链接 / 超限',
    ],
    mustKill: [
      '检查之后、打开之前被换成悬空符号链接',
      '检查之后、打开之前被换成指向有效文件的符号链接',
    ],
  },
  {
    id: 'marker_owner_policy_dropped',
    clause: 'B 标记读:属主 / 权限校验被去掉(0644 的标记被读成合法)',
    edits: [swap('src/rsi/canary/pause-marker-read.ts', '        owner: RSI_FILE_OWNER,\n', '')],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['权限过宽 / 硬链接 / 超限'],
    mustKill: ['权限过宽 / 硬链接 / 超限'],
  },
  {
    id: 'drift_missing_entry_clean',
    clause: 'payloadDrift:有登记而目标文件 / 托管块缺失被判 clean',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        '        if (!cur.present || cur.markerDrifted || cur.sha !== e.sha256) drifted = true;\n',
        '        if (cur.present && (cur.markerDrifted || cur.sha !== e.sha256)) drifted = true;\n',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts', 'rsi/asm/a-empty-write-root.test.ts'],
    expectRed: ['条目文件已不在 = drifted', '托管块整体不在 = drifted', '非空世界的对照'],
    mustKill: ['条目文件已不在 = drifted', '托管块整体不在 = drifted'],
  },
  {
    id: 'drift_block_missing_clean',
    clause: 'payloadDrift:有登记的托管块整体缺失被判 clean(文件级缺失仍判 drifted)',
    edits: [
      swap(
        'src/rsi/analysis/source-ports.ts',
        '        if (!cur.present || cur.markerDrifted || cur.sha !== e.sha256) drifted = true;\n',
        '        if ((cur.present || e.block_id === undefined) && (!cur.present || cur.markerDrifted || cur.sha !== e.sha256)) drifted = true;\n',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['托管块整体不在 = drifted'],
    mustKill: ['托管块整体不在 = drifted'],
  },
  {
    id: 'preset_first_copy_only',
    clause: '预置技能:同 id 比对形不同的副本只取第一份(漏掉只与被丢弃副本重叠的候选)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        '        byForm.set(JSON.stringify([t.id, t.do, t.why]), t);\n',
        '        if (!byForm.has(t.id)) byForm.set(t.id, t);\n',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts', 'rsi/asm/a-empty-write-root.test.ts'],
    expectRed: ['同 id 比对形不同的副本全部保留', '非空世界:有效暂存提案'],
    mustKill: ['同 id 比对形不同的副本全部保留'],
  },
  {
    id: 'preset_identical_not_merged',
    clause: '预置技能:比对形完全相同的副本不合并(按来源路径各留一条)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        '        byForm.set(JSON.stringify([t.id, t.do, t.why]), t);\n',
        '        byForm.set(JSON.stringify([t.id, t.do, t.why, f.payload_path]), t);\n',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts', 'rsi/asm/a-empty-write-root.test.ts'],
    expectRed: ['比对形完全相同的多 agent 副本合并为一条', '非空世界:有效暂存提案'],
    mustKill: ['比对形完全相同的多 agent 副本合并为一条'],
  },
  {
    id: 'preset_sort_dropped',
    clause: '预置技能:结果顺序依赖遍历顺序(不按 id / do / why 排序)',
    edits: [
      swap(
        'src/rsi/personal/read/step-sources.ts',
        'cmp(a.id, b.id) || cmp(a.do, b.do) || cmp(a.why, b.why)',
        '0',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['同 id 比对形不同的副本全部保留'],
    mustKill: ['同 id 比对形不同的副本全部保留'],
  },
  {
    id: 'collected_negative_start_kept',
    clause: 'collectedThrough:duration_ms 大于完成时刻(开始时刻为负)不返回 null',
    edits: [swap('src/rsi/analysis/source-ports.ts', '  if (start < 0) return null;\n', '')],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['duration_ms 大于完成时刻'],
    mustKill: ['duration_ms 大于完成时刻'],
  },
  {
    id: 'assemble_staged_empty',
    clause: '读侧组合根:暂存清单恒为空(非空世界才能发现)',
    edits: [
      swap('src/rsi/assemble-read.ts', '        return p.data.staged;\n', '        return [];\n'),
    ],
    tests: ['rsi/asm/a-empty-write-root.test.ts'],
    expectRed: ['非空世界:有效暂存提案'],
    mustKill: ['非空世界:有效暂存提案'],
  },
  {
    id: 'assemble_presets_unwired',
    clause: '读侧组合根:预置技能不取包内 payload(恒空)',
    edits: [
      swap(
        'src/rsi/assemble-read.ts',
        '    presets: makePresetSource({ payload: d.payload }),\n',
        '    presets: makePresetSource({ payload: async () => ({ manifest: { files: [] }, contents: new Map() }) }),\n',
      ),
    ],
    tests: ['rsi/asm/a-empty-write-root.test.ts'],
    expectRed: ['非空世界:有效暂存提案'],
    mustKill: ['非空世界:有效暂存提案'],
  },
  {
    id: 'closure_util_export_from_ignored',
    clause: 'closureOf:`export … from` / `export * from` 不进闭包',
    edits: [
      swap(
        'test/rsi/closure-util.ts',
        '      if (includeTypes || !n.isTypeOnly) specs.push(n.moduleSpecifier.text);\n',
        '',
      ),
    ],
    tests: ['rsi/asm/a-closure-util.test.ts'],
    expectRed: ['运行时依赖:静态 import', '仅类型依赖', '经中间模块的传递'],
    mustKill: ['运行时依赖:静态 import', '经中间模块的传递'],
  },
  {
    id: 'closure_util_type_only_as_runtime',
    clause: 'closureOf:`import type` 在运行时口径也进闭包(口径失真)',
    edits: [
      swap(
        'test/rsi/closure-util.ts',
        '      if (includeTypes || !n.importClause?.isTypeOnly) specs.push(n.moduleSpecifier.text);\n',
        '      specs.push(n.moduleSpecifier.text);\n',
      ),
    ],
    tests: ['rsi/asm/a-closure-util.test.ts'],
    expectRed: ['仅类型依赖'],
    mustKill: ['仅类型依赖'],
  },
  {
    id: 'closure_util_member_require_ignored',
    clause: 'closureOf:`module.require(…)` 不被记为 dynamic',
    edits: [
      swap(
        'test/rsi/closure-util.ts',
        "      n.expression.name.text === 'require'\n",
        "      n.expression.name.text === 'require_x'\n",
      ),
    ],
    tests: ['rsi/asm/a-closure-util.test.ts'],
    expectRed: ['绕过静态闭包的写法'],
    mustKill: ['绕过静态闭包的写法'],
  },
  {
    id: 'closure_util_create_require_ignored',
    clause: 'closureOf:`createRequire(…)(…)` 不被记为 dynamic',
    edits: [
      swap(
        'test/rsi/closure-util.ts',
        "      n.expression.text === 'createRequire'\n",
        "      n.expression.text === 'createRequire_x'\n",
      ),
    ],
    tests: ['rsi/asm/a-closure-util.test.ts'],
    expectRed: ['绕过静态闭包的写法'],
    mustKill: ['绕过静态闭包的写法'],
  },
];

/** 执行变异后回填(与 `V1_ASM_A_MUTATIONS` 同序);未执行时为空 */
export const V1_ASM_A_RESULTS: readonly V1AsmAResult[] = [];
