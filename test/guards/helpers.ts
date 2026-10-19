import { afterEach } from 'vitest';
import { createGuardGit, runGuards } from '../../src/guards/index.js';
import type { CriteriaChecker, GuardLabel, GuardResult } from '../../src/guards/index.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { FileMap, TestRepo } from '../helpers/make-repo.js';

const repos: TestRepo[] = [];
/** 每个测试文件调用一次:测试结束后删掉临时仓库 */
export function useRepoCleanup(): void {
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((r) => r.dispose()));
  });
}

/** 登记一个由测试自己建的仓库,afterEach 时统一清理(K4:冻结世界要按日期造提交,不走 scenario) */
export function trackRepo(repo: TestRepo): TestRepo {
  repos.push(repo);
  return repo;
}

export const PASS: CriteriaChecker = () => [];

export interface Scenario {
  repo: TestRepo;
  result: GuardResult;
  /** 去重排序后的诊断码 */
  codes: string[];
  /** 某条诊断码命中的路径(去重排序) */
  pathsOf(code: string): string[];
}

export interface ScenarioOptions {
  label?: GuardLabel;
  criteria?: CriteriaChecker;
  /** 在 base 之前先提交的历史(每项一个提交;可带 tag) */
  /** head 提交之后、跑守卫之前的额外动作(例如补打 tag、造旁支) */
  afterHead?: (repo: TestRepo) => void | Promise<void>;
  history?: readonly { files: FileMap; tag?: string; annotated?: boolean }[];
}

/**
 * 建仓库:history… → base 提交(tag `base`)→ head 提交(tag `head`),对 base..head 跑守卫。
 * head 是相对 base 的增量(null = 删除)。
 */
export async function scenario(
  baseFiles: FileMap,
  headFiles: FileMap,
  opts: ScenarioOptions = {},
): Promise<Scenario> {
  const repo = await makeTestRepo();
  repos.push(repo);
  for (const h of opts.history ?? []) {
    await repo.commit(h.files, 'history');
    if (h.tag !== undefined) repo.tag(h.tag, 'HEAD', h.annotated ?? false);
  }
  await repo.commit(baseFiles, 'base');
  repo.tag('kit-base');
  await repo.commit(headFiles, 'head');
  repo.tag('kit-head');
  await opts.afterHead?.(repo);
  const result = runGuards({
    git: createGuardGit(repo.io, repo.dir, repo.gitEnv),
    base: 'kit-base',
    head: 'kit-head',
    label: opts.label,
    ...(opts.criteria ? { criteria: opts.criteria } : {}),
  });
  const codes = [...new Set(result.diagnostics.map((d) => d.code))].sort();
  return {
    repo,
    result,
    codes,
    pathsOf: (code) =>
      [...new Set(result.diagnostics.filter((d) => d.code === code).map((d) => d.path))].sort(),
  };
}
