/**
 * 来源证明(provenance)验签(S7a;docs/contracts.md §19.5 / §19.9)。
 *
 * 与 policy.ts 的 `verifyTarballBinding` 分工:那边只**解码**未验签的 statement 做摘要绑定;这里对**同一条**
 * SLSA bundle 真正验签(Fulcio 证书链 + Rekor SET / 包含证明 + DSSE 签名),并钉死身份,再核对 statement 内容。
 * 判定顺序与原因码见 {@link ProvenanceReason};任何一步无法确认一律 fail-closed,绝不降级成「跳过验签」。
 *
 * 实现要点(都有测试 / 变异覆盖):
 *  1. 只接受外层 predicateType = SLSA v1 且 `dsseEnvelope.payloadType = application/vnd.in-toto+json` 的 bundle,且必须恰好一条。
 *  2. 身份钉死用 Fulcio 证书 SAN + issuer 扩展。🔴 sigstore 的 `certificateIdentityURI` 是**未锚定的正则**(`String.match`),
 *     裸传会让「前缀 / 后缀 / `.` 通配」的 SAN 蒙混过关,所以这里传 `^<转义后的 SAN>$`,验完再对返回的 identity 做**精确相等**复核。
 *  3. 摘要 / subject 名 / predicate.workflow 都取自**已验签的那条 bundle 的同一份 payload 字符串**(验签前捕获,TOCTOU 无缝隙)。
 *  4. `timestampThreshold` / `tsaThreshold` 不得出现在传给 sigstore 的选项里(@sigstore/verify 的 Verifier 若被传 0,
 *     「无时间戳」的 bundle 也能通过,证书有效期检查对空数组恒真)。完整 sigstore 包的顶层 API 不暴露该选项、默认已是 1,
 *     所以这条是防「以后改成直接用 Verifier」或上游默认值变化;这里另加自查:bundle 必须带时间戳证据
 *     (带 SET 的 tlog 条目,或 RFC3161 时间戳),否则归 `bundle`。
 *  integratedTime 取自验签通过的同一份 bundle:@sigstore/verify 对每个带 inclusionPromise 的条目都验 SET,
 *  而 SET 的签名负载包含 integratedTime,所以通过验签后该值已被背书(不是另一份未验的数据)。
 *  5. 库抛的各种错(含 bundle 残缺时的 TypeError)按 name / code 鸭子类型归类,不依赖 instanceof(打包后类可能重复)。
 *
 * 🔴 sigstore 的写盘与联网(用户决定用完整 `sigstore` 包的已知代价,逐条处理):
 *  - TUF 缓存:sigstore 自己往 `tuf.cachePath` 写(root.json / timestamp / snapshot / targets / trusted_root),
 *    **这些写入不经 home-fs,是「HOME 只经 home-fs 写」的唯一例外,范围仅限 `tuf.cachePath`**(安装器给 `~/.local/share/agent-kit/`
 *    下的专用子目录,已在 HOME_WRITE_TABLE 的 kit 条目内)。除此之外,联网刷新 TUF 时 tuf-js 会在 `os.tmpdir()` 下建临时目录
 *    (`mkdtemp`,下载完即删);离线 / forceCache 路径零临时文件。provenance.ts 不读环境,故不改 TMPDIR,由调用方决定。
 *    验证:test/update/provenance-tuf.test.ts 把 HOME、TMPDIR、cachePath 都指进 KIT_TMP,验签后断言真实 HOME 与默认 tmpdir 无新文件。
 *  - 代理:tuf-js 6 用**全局 `fetch`**(undici),不是 make-fetch-happen;在 Node ≥ 24.5 上只有进程带 `--use-env-proxy`
 *    (或 `NODE_USE_ENV_PROXY=1`)才走 HTTPS_PROXY。只能走代理的网络里不带该开关,刷新必然失败 → `tuf_unreachable`(fail-closed)。
 *  - 联网刷新每次约 1.5s(要拉 timestamp.json);`tuf.forceCache` 优先用磁盘缓存(约 25ms,不联网)。实测:缓存里的 TUF 元数据过期
 *    (timestamp 约 7 天)时 forceCache 仍会尝试联网续期,离线则失败 → `tuf_unreachable`。所以随包固定一份 TUF 快照做长期离线回退不可行。
 *  - sigstore 5 **不支持**直接传入 trustedRoot(`createVerifier` 只经 TUF 取),所以「随包固定 trusted_root.json」无法作为回退;
 *    可选回退只有 `tuf.fallbackToCache`:联网刷新失败后,用磁盘上**仍在有效期内**的缓存重试(默认关,须用户配置显式打开)。
 *  - engines `^22.22.2 || ^24.15.0 || >=26.0.0`:本包 engines 更宽(>=22),在更老的 Node 上 sigstore 的行为未保证。
 *  - 懒加载:`sigstore` 依赖树 50 余个包,只在真的验签时才 `import()`,不拖慢其它命令的冷启动。
 *
 * 只有本文件可以 import `sigstore`(eslint.config.js 限定)。
 */
import { SLSA_PREDICATE as SLSA_PREDICATE_TYPE, expectedSubjectName } from './policy.js';

export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const FULCIO_ISSUER_GITHUB_ACTIONS = 'https://token.actions.githubusercontent.com';
export const DEFAULT_PKG_NAME = '@chovizzz/agent-kit';
export const DEFAULT_REPOSITORY = 'https://github.com/chovizzz/agent-kit';
export const DEFAULT_WORKFLOW = '.github/workflows/release.yml';
export const DEFAULT_TUF_MIRROR = 'https://tuf-repo-cdn.sigstore.dev';

/** 稳定原因码(`ok` 之外都是失败;`UPDATE_VERIFY_FAILED reason=` 取这些值,trust_root_stale / tuf_unreachable 另见 §19.5) */
export type ProvenanceReason =
  | 'ok'
  /** 没有符合条件的 SLSA v1 + in-toto bundle */
  | 'provenance_missing'
  /** 证书 SAN / issuer / subject 名 / predicate.workflow 与钉死的身份不符 */
  | 'provenance_identity'
  /** bundle 结构残缺、签名 / 证明验不过、缺时间戳证据,及其它库内验证失败 */
  | 'bundle'
  /** 已验签 statement 的 sha512 与 tarball 不符 */
  | 'integrity'
  /** 信任根陈旧或不认识的 CA 链 / TUF 元数据过期:调用方不得拉黑该版本(决策 ㉕) */
  | 'trust_root_stale'
  /** TUF 刷新失败 / 缓存不可用:fail-closed,调用方不得拉黑该版本 */
  | 'tuf_unreachable';

export type ProvenanceResult =
  | {
      ok: true;
      reason: 'ok';
      /** 已验签的 Fulcio SAN(与钉死值精确相等) */
      subjectAlternativeName: string;
      /**
       * Rekor integratedTime(毫秒);只取**带 SET(inclusionPromise)**的 tlog 条目(SET 背书了该时间),
       * 多条取最大。没有 SET 背书(例如只有 RFC3161 时间戳)时为 undefined。冷却期起点 = max(npmjs time[v], 此值)(决策 ㉔)。
       */
      integratedTimeMs: number | undefined;
    }
  | { ok: false; reason: Exclude<ProvenanceReason, 'ok'>; cause?: string };

export interface ProvenanceIdentity {
  /** 例 `https://github.com/chovizzz/agent-kit` */
  repository: string;
  /** 例 `.github/workflows/release.yml` */
  workflow: string;
  /** 例 `refs/tags/v0.1.0` */
  ref: string;
}

/** 传给验证器的选项(与 sigstore 的 VerifyOptions 子集同名同义) */
export interface ProvenanceVerifierOptions {
  certificateIssuer: string;
  /** 🔴 sigstore 把它当**正则**用;这里始终是 `^…$` 且已转义 */
  certificateIdentityURI: string;
  tufCachePath: string;
  tufMirrorURL: string;
  tufForceCache: boolean;
  /** TUF 网络超时(毫秒) */
  timeout: number;
  /** TUF 网络重试次数 */
  retry: number;
}

/** 验证器返回的已验签身份(默认实现取自 sigstore 返回的 identity) */
export interface VerifiedSigner {
  subjectAlternativeName?: string | undefined;
  issuer?: string | undefined;
}

/** 验签失败抛错;成功必须返回已验签的签名者身份(缺失 = 无法复核 = 拒绝) */
export type ProvenanceVerifier = (
  bundle: unknown,
  options: ProvenanceVerifierOptions,
) => Promise<VerifiedSigner | undefined>;

export interface TufConfig {
  /** 受控缓存目录(绝对路径);sigstore 写这里是允许的唯一例外 */
  cachePath: string;
  mirrorURL?: string;
  /** 只读缓存、不联网(缓存元数据过期即失败) */
  forceCache?: boolean;
  timeoutMs?: number;
  retries?: number;
  /** 联网刷新失败(tuf_unreachable)后,用仍有效的缓存重试一次。默认 false;须由用户配置显式打开 */
  fallbackToCache?: boolean;
}

export interface VerifyProvenanceInput {
  /** npmjs `/-/npm/v1/attestations/<pkg>@<version>` 的响应 JSON */
  attestationsDoc: unknown;
  /** 内存里 tarball 字节的 sha512(小写 / 大写十六进制均可) */
  tarballSha512Hex: string;
  pkgName?: string;
  version: string;
  /** 默认由 DEFAULT_* 与 `refs/tags/v${version}` 生成 */
  identity?: ProvenanceIdentity;
  /** 默认用 sigstore;测试注入 */
  verifier?: ProvenanceVerifier;
  tuf: TufConfig;
}

// ---------------------------------------------------------------------------

const SHA512_HEX_RE = /^[0-9a-f]{128}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const DEFAULT_TUF_TIMEOUT_MS = 5000;
const DEFAULT_TUF_RETRIES = 1;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 转义成可放进正则的字面量 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

export function expectedSan(identity: ProvenanceIdentity): string {
  return `${identity.repository}/${identity.workflow}@${identity.ref}`;
}

function fail(
  reason: Exclude<ProvenanceReason, 'ok'>,
  cause?: string,
): Extract<ProvenanceResult, { ok: false }> {
  return cause === undefined ? { ok: false, reason } : { ok: false, reason, cause };
}

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300);
  return String(e).slice(0, 300);
}

/** 沿 cause 链拼出文本,供归类用 */
function errChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(' <- ');
}

/**
 * 把库抛出的错归到稳定原因码(按 name / code / message 鸭子类型,不用 instanceof)。
 * 关键区分:TUF 失败(不拉黑)≠ 信任根陈旧(不拉黑)≠ 身份不符 / 其它验证失败(拉黑)。
 */
export function classifyVerifyError(e: unknown): Extract<ProvenanceResult, { ok: false }> {
  const cause = errText(e);
  const name = isRecord(e) || e instanceof Error ? String((e as { name?: unknown }).name) : '';
  const code = isRecord(e) || e instanceof Error ? (e as { code?: unknown }).code : undefined;
  const chain = errChain(e);
  if (name === 'TUFError') {
    // 缓存里的 TUF 元数据过期(forceCache 下无法刷新)= 信任根陈旧,不是网络问题
    return /expired/i.test(chain)
      ? fail('trust_root_stale', cause)
      : fail('tuf_unreachable', cause);
  }
  if (name === 'PolicyError' || code === 'UNTRUSTED_SIGNER_ERROR') {
    return fail('provenance_identity', cause);
  }
  if (name === 'VerificationError') {
    // 证书链连不到受信 CA(Fulcio CA 轮换 / 本地信任根太旧 / 伪造证书都会落在这里;三者都不得安装,也都不拉黑)
    if (code === 'CERTIFICATE_ERROR' && /certificate chain|certificate path/i.test(chain)) {
      return fail('trust_root_stale', cause);
    }
    return fail('bundle', cause);
  }
  // 系统错误(EACCES / ENOSPC / EROFS …,多为 TUF 缓存目录不可写):版本没有错,环境有问题
  if (e instanceof Error && typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) {
    return fail('tuf_unreachable', cause);
  }
  // TypeError / ValidationError / 其它:bundle 结构残缺
  return fail('bundle', cause);
}

interface Candidate {
  bundle: Record<string, unknown>;
  payloadB64: string;
}

function selectSlsaCandidates(doc: unknown): Candidate[] | 'malformed' {
  if (!isRecord(doc) || !Array.isArray(doc['attestations'])) return 'malformed';
  const out: Candidate[] = [];
  for (const a of doc['attestations'] as unknown[]) {
    if (!isRecord(a)) return 'malformed';
    if (a['predicateType'] !== SLSA_PREDICATE_TYPE) continue;
    const bundle = a['bundle'];
    if (!isRecord(bundle)) continue;
    const env = bundle['dsseEnvelope'];
    if (!isRecord(env) || env['payloadType'] !== IN_TOTO_PAYLOAD_TYPE) continue;
    if (typeof env['payload'] !== 'string') continue;
    out.push({ bundle, payloadB64: env['payload'] });
  }
  return out;
}

interface TimestampEvidence {
  hasEvidence: boolean;
  integratedTimeMs: number | undefined;
}

function readTimestampEvidence(bundle: Record<string, unknown>): TimestampEvidence | undefined {
  const vm = bundle['verificationMaterial'];
  if (!isRecord(vm)) return undefined;
  let integrated: number | undefined;
  let evidence = false;
  const entries = vm['tlogEntries'];
  if (Array.isArray(entries)) {
    for (const t of entries as unknown[]) {
      if (!isRecord(t) || !isRecord(t['inclusionPromise'])) continue;
      const it = t['integratedTime'];
      const secs = typeof it === 'string' && /^[0-9]{1,12}$/.test(it) ? Number(it) : NaN;
      // 带 SET 的条目 integratedTime 格式不对 = bundle 有问题,不是「跳过这一条」
      if (!Number.isSafeInteger(secs) || secs <= 0) return undefined;
      evidence = true;
      integrated = Math.max(integrated ?? 0, secs * 1000);
    }
  }
  const tsd = vm['timestampVerificationData'];
  if (
    isRecord(tsd) &&
    Array.isArray(tsd['rfc3161Timestamps']) &&
    tsd['rfc3161Timestamps'].length > 0
  ) {
    evidence = true;
  }
  return { hasEvidence: evidence, integratedTimeMs: integrated };
}

function parseStatement(payloadB64: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 默认验证器:懒加载完整 `sigstore` 包。tuf-js 用全局 fetch(见文件头注释)。 */
export const sigstoreVerifier: ProvenanceVerifier = async (bundle, options) => {
  const sigstore = await import('sigstore');
  const signer = await sigstore.verify(bundle as Parameters<typeof sigstore.verify>[0], {
    certificateIssuer: options.certificateIssuer,
    certificateIdentityURI: options.certificateIdentityURI,
    tufCachePath: options.tufCachePath,
    tufMirrorURL: options.tufMirrorURL,
    tufForceCache: options.tufForceCache,
    timeout: options.timeout,
    retry: options.retry,
    // 🔴 不得在此加 timestampThreshold / tsaThreshold(见文件头第 4 条)
  });
  const id = (
    signer as { identity?: { subjectAlternativeName?: string; extensions?: { issuer?: string } } }
  ).identity;
  return { subjectAlternativeName: id?.subjectAlternativeName, issuer: id?.extensions?.issuer };
};

export async function verifyProvenance(input: VerifyProvenanceInput): Promise<ProvenanceResult> {
  const pkgName = input.pkgName ?? DEFAULT_PKG_NAME;
  const version = input.version;
  if (!VERSION_RE.test(version)) throw new TypeError('verifyProvenance: invalid version');
  const sha = input.tarballSha512Hex.toLowerCase();
  if (!SHA512_HEX_RE.test(sha)) throw new TypeError('verifyProvenance: invalid tarballSha512Hex');
  if (typeof input.tuf?.cachePath !== 'string' || input.tuf.cachePath === '') {
    throw new TypeError('verifyProvenance: tuf.cachePath is required (controlled directory)');
  }
  const identity: ProvenanceIdentity = input.identity ?? {
    repository: DEFAULT_REPOSITORY,
    workflow: DEFAULT_WORKFLOW,
    ref: `refs/tags/v${version}`,
  };
  const wantSan = expectedSan(identity);
  const verifier = input.verifier ?? sigstoreVerifier;

  // 1. 选 statement:SLSA v1 + in-toto,恰好一条
  const candidates = selectSlsaCandidates(input.attestationsDoc);
  if (candidates === 'malformed') return fail('bundle', 'attestations document malformed');
  if (candidates.length === 0) return fail('provenance_missing');
  if (candidates.length > 1) return fail('bundle', 'ambiguous: multiple SLSA provenance bundles');
  const cand = candidates[0] as Candidate;

  // 2. 深拷贝后验签;payload 字符串在验签前捕获(之后只用这份)
  let bundle: unknown;
  try {
    bundle = JSON.parse(JSON.stringify(cand.bundle));
  } catch (e) {
    return fail('bundle', errText(e));
  }
  const payloadB64 = cand.payloadB64;

  // 自查:必须带时间戳证据(与 sigstore 内部 timestampThreshold=1 互为双保险)
  const ts = readTimestampEvidence(cand.bundle);
  if (ts === undefined || !ts.hasEvidence) return fail('bundle', 'no timestamp evidence in bundle');

  const base: Omit<ProvenanceVerifierOptions, 'tufForceCache'> = {
    certificateIssuer: FULCIO_ISSUER_GITHUB_ACTIONS,
    certificateIdentityURI: `^${escapeRegExp(wantSan)}$`,
    tufCachePath: input.tuf.cachePath,
    tufMirrorURL: input.tuf.mirrorURL ?? DEFAULT_TUF_MIRROR,
    timeout: input.tuf.timeoutMs ?? DEFAULT_TUF_TIMEOUT_MS,
    retry: input.tuf.retries ?? DEFAULT_TUF_RETRIES,
  };

  const attempt = async (forceCache: boolean): Promise<ProvenanceResult | VerifiedSigner> => {
    try {
      const signer = await verifier(bundle, { ...base, tufForceCache: forceCache });
      return signer ?? {};
    } catch (e) {
      return classifyVerifyError(e);
    }
  };
  let verified = await attempt(input.tuf.forceCache === true);
  if (
    'ok' in verified &&
    !verified.ok &&
    verified.reason === 'tuf_unreachable' &&
    input.tuf.fallbackToCache === true &&
    input.tuf.forceCache !== true
  ) {
    verified = await attempt(true);
  }
  if ('ok' in verified) return verified;

  // 3. 复核已验签身份:精确相等(sigstore 的 SAN 匹配是未锚定正则)
  if (verified.subjectAlternativeName !== wantSan) {
    return fail(
      'provenance_identity',
      `signer SAN mismatch: ${String(verified.subjectAlternativeName)}`,
    );
  }
  if (verified.issuer !== FULCIO_ISSUER_GITHUB_ACTIONS) {
    return fail('provenance_identity', `signer issuer mismatch: ${String(verified.issuer)}`);
  }

  // 4. statement 内容(同一份已验签 payload)
  const st = parseStatement(payloadB64);
  if (st === undefined) return fail('bundle', 'statement not decodable');
  if (st['_type'] !== IN_TOTO_STATEMENT_TYPE || st['predicateType'] !== SLSA_PREDICATE_TYPE) {
    return fail('bundle', 'statement type mismatch');
  }
  const subjects = st['subject'];
  if (!Array.isArray(subjects) || subjects.length === 0) return fail('bundle', 'no subject');
  const wantName = expectedSubjectName(pkgName, version);
  let named = 0;
  for (const sj of subjects as unknown[]) {
    if (!isRecord(sj) || typeof sj['name'] !== 'string' || !isRecord(sj['digest'])) {
      return fail('bundle', 'subject malformed');
    }
    if (sj['name'] !== wantName) continue;
    named++;
    const d = sj['digest']['sha512'];
    if (typeof d !== 'string' || d.toLowerCase() !== sha) {
      return fail('integrity', 'subject sha512 does not match tarball');
    }
  }
  if (named === 0) return fail('provenance_identity', `no subject named ${wantName}`);

  // 5. predicate.workflow 与 SAN 一致
  const wf = readWorkflow(st['predicate']);
  if (wf === undefined) return fail('bundle', 'predicate workflow missing');
  if (
    wf.repository !== identity.repository ||
    wf.path !== identity.workflow ||
    wf.ref !== identity.ref
  ) {
    return fail('provenance_identity', 'predicate workflow does not match pinned identity');
  }

  return {
    ok: true,
    reason: 'ok',
    subjectAlternativeName: wantSan,
    integratedTimeMs: ts.integratedTimeMs,
  };
}

function readWorkflow(
  predicate: unknown,
): { repository: string; path: string; ref: string } | undefined {
  if (!isRecord(predicate)) return undefined;
  const bd = predicate['buildDefinition'];
  const ep = isRecord(bd) ? bd['externalParameters'] : undefined;
  const wf = isRecord(ep) ? ep['workflow'] : undefined;
  if (!isRecord(wf)) return undefined;
  const { repository, path, ref } = wf;
  if (typeof repository !== 'string' || typeof path !== 'string' || typeof ref !== 'string') {
    return undefined;
  }
  return { repository, path, ref };
}
