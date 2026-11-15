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
    edits: [swap('src/rsi/auto/git-path.ts', '    if (!st.isFile) return false;\n', '')],
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
      swap('src/rsi/auto/git-path.ts', '    if ((st.mode & 0o111) === 0) return false;\n', ''),
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
      swap('src/rsi/auto/git-path.ts', '    if ((st.mode & 0o022) !== 0) return false;\n', ''),
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
    id: 'gp_owner_unchecked',
    clause: 'resolveGitPath:属主既非 root 也非当前用户的候选被接受',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        '    if (st.uid !== 0 && st.uid !== probe.uid) return false;\n',
        '',
      ),
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
    id: 'gp_real_name_unchecked',
    clause: 'resolveGitPath:realpath 之后文件名不是 git 仍被接受',
    edits: [
      swap(
        'src/rsi/auto/git-path.ts',
        "    return path.isAbsolute(real) && path.basename(real) === 'git';",
        '    return true;',
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
        '  } catch {\n    return false;\n  }',
        '  } catch {\n    return true;\n  }',
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
    clause: 'B 标记读:非 ENOENT 的读错误被当成不存在',
    edits: [
      swap('src/rsi/canary/pause-marker-read.ts', '        throw e;', '        return null;'),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
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
    clause: 'B 标记读:符号链接 / 非普通文件不再被拒(悬空链接被读成「不存在」)',
    edits: [
      swap(
        'src/rsi/canary/pause-marker-read.ts',
        '        if (!st.isFile() || st.isSymbolicLink()) throw new MarkerUnsafeError();\n',
        '',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: [
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
        'if (cur.present && (cur.markerDrifted || cur.sha !== e.sha256)) drifted = true;',
        'if (cur.present && cur.markerDrifted) drifted = true;',
      ),
    ],
    tests: ['rsi/asm/a-adapters.test.ts'],
    expectRed: ['没有登记表 = clean;内容与登记一致 = clean(对照);被改过 = drifted'],
    mustKill: ['没有登记表 = clean;内容与登记一致 = clean(对照);被改过 = drifted'],
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
        'return new Date(Math.max(0, end - t.duration_ms)).toISOString();',
        'return new Date(end).toISOString();',
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
        "import { lstat, readText } from '../../io/read-fs.js';",
        "import { lstat, readText } from '../../io/read-fs.js';\nimport { createExclusiveDurable } from '../../io/safe-fs.js';\nexport const asmProbe = createExclusiveDurable;",
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
];

/** 执行变异后回填(与 `V1_ASM_A_MUTATIONS` 同序);未执行时为空 */
/** 实测结果:r21asma-mut-f2 @2d58591(dolphin) */
export const V1_ASM_A_RESULTS: readonly V1AsmAResult[] = [
  {
    id: 'gp_not_file_accepted',
    failed: 1,
    skipped: 0,
    killedBy: [
      'resolveGitPath 拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    restored: true,
  },
  {
    id: 'gp_exec_bit_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'resolveGitPath 拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    restored: true,
  },
  {
    id: 'gp_writable_accepted',
    failed: 1,
    skipped: 0,
    killedBy: [
      'resolveGitPath 拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    restored: true,
  },
  {
    id: 'gp_owner_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'resolveGitPath 拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
    ],
    restored: true,
  },
  {
    id: 'gp_real_name_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'resolveGitPath realpath 之后文件名不是 git → 拒绝(makeGitReadonly 的断言);相对路径 / 文件名不是 git 的候选 → 拒绝',
    ],
    restored: true,
  },
  {
    id: 'gp_probe_error_accepted',
    failed: 2,
    skipped: 0,
    killedBy: [
      'resolveGitPath 拒绝:不可执行 / 组或其他人可写 / 属主既非 root 也非当前用户 / 不是普通文件 / 不存在',
      'resolveGitPath 全部解析不到 → null(保持未装配);只探测固定候选(不查 PATH:合规的 git 放在别处也不影响结果)',
    ],
    restored: true,
  },
  {
    id: 'peek_read_error_absent',
    failed: 1,
    skipped: 0,
    killedBy: [
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid,绝不是 missing 或 absent',
    ],
    restored: true,
  },
  {
    id: 'peek_exit_absent',
    failed: 1,
    skipped: 0,
    killedBy: [
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid,绝不是 missing 或 absent',
    ],
    restored: true,
  },
  {
    id: 'peek_head_null_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing(正向对照)',
    ],
    restored: true,
  },
  {
    id: 'peek_invalid_as_missing',
    failed: 2,
    skipped: 0,
    killedBy: [
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing(正向对照)',
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid,绝不是 missing 或 absent',
    ],
    restored: true,
  },
  {
    id: 'peek_id_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing(正向对照)',
    ],
    restored: true,
  },
  {
    id: 'sha_failure_value',
    failed: 1,
    skipped: 0,
    killedBy: [
      'peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读 recordedSha:读到 = content_sha256;读不到 / 候选不在 / 记录坏 = null',
    ],
    restored: true,
  },
  {
    id: 'cred_throw_empty',
    failed: 1,
    skipped: 0,
    killedBy: [
      '撤销凭据读(只读适配器)与写侧 homeRevocationReader 同一契约 端口抛错 → invalid(不外泄、不当成空)',
    ],
    restored: true,
  },
  {
    id: 'cred_unreadable_empty',
    failed: 1,
    skipped: 0,
    killedBy: [
      '撤销凭据读(只读适配器)与写侧 homeRevocationReader 同一契约 缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid(绝不是空);与写侧逐输入同结论',
    ],
    restored: true,
  },
  {
    id: 'cred_parse_empty',
    failed: 1,
    skipped: 0,
    killedBy: [
      '撤销凭据读(只读适配器)与写侧 homeRevocationReader 同一契约 缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid(绝不是空);与写侧逐输入同结论',
    ],
    restored: true,
  },
  {
    id: 'marker_error_absent',
    failed: 1,
    skipped: 0,
    killedBy: [
      'B 标记只读端口与写侧端口 read 同一语义 缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错,绝不是 null;悬空 / 有效符号链接也抛错',
    ],
    restored: true,
  },
  {
    id: 'staged_classify_skipped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'StagedSource:暂存提案来源 只收未 tainted、证据非空、全部归属 P 的 run;其余不装载(正向对照:合规 run 被装载)',
    ],
    restored: true,
  },
  {
    id: 'staged_load_swallowed',
    failed: 1,
    skipped: 0,
    killedBy: ['StagedSource:暂存提案来源 装载失败 / 暂存清单读失败 → 抛错(不跳过坏 run 去尽量)'],
    restored: true,
  },
  {
    id: 'signal_bad_row_skipped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'SignalLookup:按 sig_id 取信号 任一行不合 schema → 整体抛错(不返回「少几条」冒充成功);信号库不存在 = 空',
    ],
    restored: true,
  },
  {
    id: 'preset_content_skipped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'PresetSource:预置技能的比对形 读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文',
    ],
    restored: true,
  },
  {
    id: 'preset_shape_loose',
    failed: 2,
    skipped: 0,
    killedBy: [
      'PresetSource:预置技能的比对形 读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文',
      'PresetSource:预置技能的比对形 frontmatter 按 YAML 取真实值:折叠多行标量、引号;空值 / 非字符串 / 非映射 / 坏 YAML → 抛错;包内真实技能文件可解析',
    ],
    restored: true,
  },
  {
    id: 'preset_yaml_naive',
    failed: 1,
    skipped: 0,
    killedBy: [
      'PresetSource:预置技能的比对形 frontmatter 按 YAML 取真实值:折叠多行标量、引号;空值 / 非字符串 / 非映射 / 坏 YAML → 抛错;包内真实技能文件可解析',
    ],
    restored: true,
  },
  {
    id: 'signal_vanished_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'SignalLookup:按 sig_id 取信号 已枚举的月文件打开前消失(scan 返回 null)→ 整体抛错,不当成「这些 id 不存在」(正向对照:scan 返回文件号时成功)',
    ],
    restored: true,
  },
  {
    id: 'marker_nonregular_accepted',
    failed: 1,
    skipped: 0,
    killedBy: [
      'B 标记只读端口与写侧端口 read 同一语义 缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错,绝不是 null;悬空 / 有效符号链接也抛错',
    ],
    restored: true,
  },
  {
    id: 'preset_kind_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'PresetSource:预置技能的比对形 取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文;多 agent 副本只取第一份(按 payload_path 升序);其它类别 / 非 SKILL.md 不收',
    ],
    restored: true,
  },
  {
    id: 'preset_nonskillmd_taken',
    failed: 1,
    skipped: 0,
    killedBy: [
      'PresetSource:预置技能的比对形 取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文;多 agent 副本只取第一份(按 payload_path 升序);其它类别 / 非 SKILL.md 不收',
    ],
    restored: true,
  },
  {
    id: 'drift_ledger_unreadable_clean',
    failed: 1,
    skipped: 0,
    killedBy: [
      '分析源端口 payloadDrift:登记表条目的当前内容 vs 登记 sha 登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean',
    ],
    restored: true,
  },
  {
    id: 'drift_entry_unsafe_skipped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '分析源端口 payloadDrift:登记表条目的当前内容 vs 登记 sha 登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean',
    ],
    restored: true,
  },
  {
    id: 'drift_sha_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '分析源端口 payloadDrift:登记表条目的当前内容 vs 登记 sha 没有登记表 = clean;内容与登记一致 = clean(对照);被改过 = drifted;条目文件已不在 = clean(不算漂移)',
    ],
    restored: true,
  },
  {
    id: 'through_partial_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      '分析源端口 collectedThrough:最近一次完整成功 tick 的开始时刻 ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null(分析 unavailable)',
    ],
    restored: true,
  },
  {
    id: 'through_end_not_start',
    failed: 1,
    skipped: 0,
    killedBy: [
      '分析源端口 collectedThrough:最近一次完整成功 tick 的开始时刻 ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null(分析 unavailable)',
    ],
    restored: true,
  },
  {
    id: 'c4_unavailable_zero',
    failed: 1,
    skipped: 0,
    killedBy: [
      '分析源端口 c4Bytes:canary.json 的 treat 注入字节数 合规 = 字节数;缺失 / 不合规 = null(不是 0)',
    ],
    restored: true,
  },
  {
    id: 'asm_unwired_fake_success',
    failed: 1,
    skipped: 0,
    killedBy: [
      '工厂创建与 import 不读盘、不起子进程 recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次,spawn 一次都不调;解析到但仓库目录不存在 = 在预检就拒绝,同样不 spawn',
    ],
    restored: true,
  },
  {
    id: 'asm_gitpath_not_memoized',
    failed: 1,
    skipped: 0,
    killedBy: [
      '工厂创建与 import 不读盘、不起子进程 recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次,spawn 一次都不调;解析到但仓库目录不存在 = 在预检就拒绝,同样不 spawn',
    ],
    restored: true,
  },
  {
    id: 'asm_eager_gitpath',
    failed: 2,
    skipped: 0,
    killedBy: [
      '工厂创建与 import 不读盘、不起子进程 assembleReadAdapters 创建:零读盘、不解析 git 路径、不调 payload / spawn;第一次调用端口才读(正向对照)',
      '工厂创建与 import 不读盘、不起子进程 recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次,spawn 一次都不调;解析到但仓库目录不存在 = 在预检就拒绝,同样不 spawn',
    ],
    restored: true,
  },
  {
    id: 'closure_root_safe_fs',
    failed: 2,
    skipped: 0,
    killedBy: [
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(运行时依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(含类型依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    restored: true,
  },
  {
    // killedBy 只列日志里完整的 2 条:验证机步骤日志单行约 780 字节截断,实际红 4 条(同一断言在其余读入口上的同名用例)
    id: 'closure_staged_store',
    failed: 4,
    skipped: 0,
    killedBy: [
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(运行时依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(含类型依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    restored: true,
  },
  {
    // killedBy 只列日志里完整的 2 条:验证机步骤日志单行约 780 字节截断,实际红 4 条(同一断言在其余读入口上的同名用例)
    id: 'closure_analysis_ledger',
    failed: 4,
    skipped: 0,
    killedBy: [
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(运行时依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(含类型依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    restored: true,
  },
  {
    id: 'closure_attribution_lock',
    failed: 2,
    skipped: 0,
    killedBy: [
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(运行时依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(含类型依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    restored: true,
  },
  {
    // killedBy 只列日志里完整的 2 条:验证机步骤日志单行约 780 字节截断,实际红 6 条(同一断言在其余读入口上的同名用例)
    id: 'closure_scan_state_store',
    failed: 6,
    skipped: 0,
    killedBy: [
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(运行时依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(含类型依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    restored: true,
  },
  {
    // killedBy 只列日志里完整的 2 条:验证机步骤日志单行约 780 字节截断,实际红 4 条(同一断言在其余读入口上的同名用例)
    id: 'closure_marker_safe_fs',
    failed: 4,
    skipped: 0,
    killedBy: [
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(运行时依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
      '读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径) src/rsi/assemble-read.ts(含类型依赖):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内',
    ],
    restored: true,
  },
  {
    id: 'eslint_read_root_rule_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'eslint:读侧组合根 / 只读适配器 import 写出口即红;未登记文件同样代码不红(负对照) safe-fs / exec / 锁 / 含写出口的原模块:读根文件红,放行文件(原写侧模块、测试)不红',
    ],
    restored: true,
  },
  {
    id: 'eslint_ledger_not_forbidden',
    failed: 1,
    skipped: 0,
    killedBy: [
      'eslint:读侧组合根 / 只读适配器 import 写出口即红;未登记文件同样代码不红(负对照) safe-fs / exec / 锁 / 含写出口的原模块:读根文件红,放行文件(原写侧模块、测试)不红',
    ],
    restored: true,
  },
];
