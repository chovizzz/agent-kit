/**
 * 端口契约测试套件(W8a 骨架;contracts §21.24 W0-22 第 6、7 条;SOLID 的 L):**同一套用例**对测试假件与生产适配器各跑一遍——假件必须通过同一份契约才可用于命令测试。
 * 契约:读失败 = `unreadable`(绝不返回 `absent` / 空冒充成功);只有「确认不存在」才是 `absent` / `missing`;未装配的端口 fail-closed(`unreadable(not_wired)`)。
 * 本段覆盖用到的读端口:`HomeReadPort`(假件 vs `makeHomeReadPort`)与 `RecordedReadPort`(假件 vs `unwiredRecordedRead` / 真适配器见 `git-readonly.test.ts`)。
 * 写端口(延期、CAS、锁持有断言、`applyOnce` 幂等、`blacklist_veto` 集合插入、`ensureUser` 不覆盖、`bump` 单调)随 W8b 加入本文件。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HomeReadPort } from '../../../src/rsi/auto/read/ports.js';
import {
  PERSONAL_STATE_REL_READ,
  makeHomeReadPort,
} from '../../../src/rsi/personal/read/home-reads.js';
import { PERSONAL_STATE_REL } from '../../../src/rsi/personal/home-state.js';
import { unwiredRecordedRead } from '../../../src/rsi/personal/read/recorded-port.js';
import {
  RSI_REVOCATION_BY,
  RSI_TRANSITION_REASONS_TERMINATING,
} from '../../../src/contracts/rsi.js';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import { sourceCompatible } from '../../../src/rsi/auto/read/journal-check.js';
import { sourceProblem } from '../../../src/rsi/personal/rollback-journal.js';
import { makeWorld as makeIoWorld } from '../personal/repo-helpers.js';
import { makeWorld, portsOf } from './auto-fixture.js';

interface HomeHarness {
  port: HomeReadPort;
  putHead(text: string): Promise<void>;
  putRevocations(text: string): Promise<void>;
  putJournal(id: string, text: string): Promise<void>;
  /** 让 head / revocations / journal / txn 目录的读取失败(不是缺失) */
  breakReads(): Promise<void>;
}

const JID = '0123456789abcdef';

const fakeHome = async (): Promise<HomeHarness> => {
  const w = makeWorld();
  const p = portsOf(w).home;
  return {
    port: p,
    putHead: async (t) => void (w.head = { kind: 'ok', text: t }),
    putRevocations: async (t) => void (w.rev = { kind: 'ok', text: t }),
    putJournal: async (id, t) => {
      w.names.push(id);
      w.journals[id] = { kind: 'ok', text: t };
    },
    breakReads: async () => {
      w.head = { kind: 'unreadable' };
      w.rev = { kind: 'unreadable' };
      w.namesUnreadable = true;
      w.journals[JID] = { kind: 'unreadable' };
    },
  };
};

const prodHome = async (): Promise<HomeHarness> => {
  const w = await makeIoWorld('w8a-contract-');
  const dir = path.join(w.home, ...PERSONAL_STATE_REL_READ.split('/'));
  const put = async (rel: string, text: string, mode = 0o600): Promise<void> => {
    await mkdirp(w.io, path.dirname(path.join(dir, rel)), 0o700);
    await writeFile(w.io, path.join(dir, rel), text, { mode });
  };
  return {
    port: makeHomeReadPort(w.home),
    putHead: (t) => put('head.json', t),
    putRevocations: (t) => put('revocations.jsonl', t),
    putJournal: (id, t) => put(`txn/${id}.json`, t),
    // 权限宽于 0600 = 不安全 = 读失败(不是缺失);目录不可读同理
    breakReads: async () => {
      await put('head.json', 'x', 0o644);
      await put('revocations.jsonl', 'x', 0o644);
      await put(`txn/${JID}.json`, 'x', 0o644);
    },
  };
};

describe.each([
  ['测试假件', fakeHome],
  ['生产适配器 makeHomeReadPort', prodHome],
] as const)('HomeReadPort 契约:%s', (_name, make) => {
  it('什么都没有 → head / revocations / journal 是 absent,事务目录是空(不是读失败)', async () => {
    const h = await make();
    expect(await h.port.head()).toEqual({ kind: 'absent' });
    expect(await h.port.revocations()).toEqual({ kind: 'absent' });
    expect(await h.port.txnNames()).toEqual({ kind: 'ok', names: [] });
    expect(await h.port.journal(JID)).toEqual({ kind: 'absent' });
  });

  it('有内容 → 原文;事务目录名升序', async () => {
    const h = await make();
    await h.putHead('{"a":1}');
    await h.putRevocations('line\n');
    await h.putJournal('bbbbbbbbbbbbbbbb', '{"j":2}');
    await h.putJournal('aaaaaaaaaaaaaaaa', '{"j":1}');
    expect(await h.port.head()).toEqual({ kind: 'ok', text: '{"a":1}' });
    expect(await h.port.revocations()).toEqual({ kind: 'ok', text: 'line\n' });
    expect(await h.port.txnNames()).toEqual({
      kind: 'ok',
      names: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
    });
    expect(await h.port.journal('aaaaaaaaaaaaaaaa')).toEqual({ kind: 'ok', text: '{"j":1}' });
  });

  it('读失败 → unreadable,绝不是 absent / 空', async () => {
    const h = await make();
    await h.breakReads();
    expect((await h.port.head()).kind).toBe('unreadable');
    expect((await h.port.revocations()).kind).toBe('unreadable');
    expect((await h.port.journal(JID)).kind).toBe('unreadable');
  });
});

describe('个人层状态目录常量:读端口与写侧 home-state.ts 指向同一位置', () => {
  it('PERSONAL_STATE_REL_READ === PERSONAL_STATE_REL', () => {
    expect(PERSONAL_STATE_REL_READ).toBe(PERSONAL_STATE_REL);
  });
});

describe.each([
  ['测试假件', () => portsOf(makeWorld()).recorded],
  ['生产未装配实现 unwiredRecordedRead', () => unwiredRecordedRead],
] as const)('RecordedReadPort 契约(未装配 / 缺对象):%s', (name, make) => {
  it('非 40 位小写十六进制的 oid → unreadable(bad_oid)或未装配(not_wired);绝不 ok / missing 冒充', async () => {
    const p = make();
    for (const m of ['readCommit', 'listTree', 'readBlob'] as const) {
      const r = await p[m]('HEAD');
      expect(r.kind, `${name}.${m}`).toBe('unreadable');
    }
  });

  it('未装配 = 恒 unreadable(not_wired)', async () => {
    const r = await unwiredRecordedRead.readCommit('a'.repeat(40));
    expect(r).toEqual({ kind: 'unreadable', why: 'not_wired' });
    expect(await unwiredRecordedRead.listTree('a'.repeat(40))).toEqual({
      kind: 'unreadable',
      why: 'not_wired',
    });
    expect(await unwiredRecordedRead.readBlob('a'.repeat(40))).toEqual({
      kind: 'unreadable',
      why: 'not_wired',
    });
  });
});

describe('RecordedReadPort 假件:确认不存在才是 missing', () => {
  it('合法 oid 但对象不存在 → missing', async () => {
    const p = portsOf(makeWorld()).recorded;
    expect(await p.readCommit('a'.repeat(40))).toEqual({ kind: 'missing' });
  });
});

describe('journal 来源相容性:读侧镜像与写侧 sourceProblem 逐组合相等(防漂移)', () => {
  it('全部 (by, kind, reason) 组合:sourceCompatible === (sourceProblem === null)', () => {
    const kinds = ['rollback', 'clear', 'reconcile', 'identity_change'] as const;
    const reasons = [...RSI_TRANSITION_REASONS_TERMINATING, 'gates_passed'];
    let n = 0;
    for (const by of RSI_REVOCATION_BY) {
      for (const kind of kinds) {
        for (const reason of reasons) {
          expect(sourceCompatible(by, kind, reason), `${by}/${kind}/${reason}`).toBe(
            sourceProblem(by, kind, reason) === null,
          );
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(100);
  });
});
