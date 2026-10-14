import { z } from 'zod';
import {
  KebabIdSchema,
  RelPathSchema,
  RenderAgentIdSchema,
  SemverSchema,
  Sha256Schema,
} from './common.js';
import { LayerSchema, StrengthSchema } from './atom.js';
import { ChannelNameSchema } from './config.js';
import { ConfidenceSchema } from './render.js';
import { isHomeWritePath } from './sync.js';

/**
 * S0 追加(sync / doctor / update,docs/contracts.md §19):随 npm 包分发的预渲染产物。
 * 包内布局(S2 实装):`payload/manifest.json`(PayloadManifest)、`payload/files/<agent>/<target>/<relPath>`、
 * 包根 `integrity.json`(PayloadIntegrity)。`payload_sha256` = `canonicalJson(PayloadManifest)` 字节的 sha256。
 */

/**
 * 文件类别。`rules` / `skill` / `subagent` 是 instructions 类(纯文本指令);
 * 其余一律 `executable`(hook、settings、会执行命令的配置等)——未知类别也必须按 executable 归类,
 * `auto_sync=safe` 对 executable 恒拒(§19.6)。
 */
export const PAYLOAD_KINDS = ['rules', 'skill', 'subagent', 'executable'] as const;
export const PayloadKindSchema = z.enum(PAYLOAD_KINDS);
export type PayloadKind = z.infer<typeof PayloadKindSchema>;
export const INSTRUCTION_KINDS: readonly PayloadKind[] = ['rules', 'skill', 'subagent'];

export const PayloadAtomSchema = z.strictObject({
  id: KebabIdSchema,
  layer: LayerSchema,
  /** `auto_sync=safe` 据此判断「不含 must」 */
  strength: StrengthSchema,
});

export const PayloadFileSchema = z
  .strictObject({
    agent: RenderAgentIdSchema,
    target: z.enum(['home', 'project']),
    /** target=home 时是 HOME 相对路径,且必须落在 HOME_WRITE_TABLE 内(契约层拒绝表外路径) */
    path: RelPathSchema,
    mode: z.enum(['owned', 'managed-block']),
    /** mode=managed-block 时必填,owned 时不得出现 */
    block_id: KebabIdSchema.optional(),
    kind: PayloadKindSchema,
    confidence: ConfidenceSchema,
    conditional: z.string().min(1).optional(),
    /** owned:文件全文的哈希;managed-block:块体的哈希(口径同 src/render/managed-block.ts) */
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
    /** 相对 `payload/` 的存放位置 */
    payload_path: RelPathSchema,
    atoms: z.array(PayloadAtomSchema),
  })
  .superRefine((f, ctx) => {
    if ((f.mode === 'managed-block') !== (f.block_id !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['block_id'],
        message: 'block_id 必须且只能出现在 mode=managed-block 的文件上',
      });
    }
    if (f.target === 'home' && !isHomeWritePath(f.path, 'adapter')) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'target=home 的路径必须落在 HOME_WRITE_TABLE 的 adapter 条目内',
      });
    }
  });
export type PayloadFile = z.infer<typeof PayloadFileSchema>;

/** 托管块 id 改名之类的迁移;由 sync 计划器执行,同样受漂移规则约束。 */
export const PayloadMigrationSchema = z.strictObject({
  kind: z.literal('rename_block'),
  path: RelPathSchema,
  from_block_id: KebabIdSchema,
  to_block_id: KebabIdSchema,
  since_version: SemverSchema,
});

const fileKey = (f: Pick<PayloadFile, 'agent' | 'target' | 'path'>): string =>
  `${f.agent}/${f.target}/${f.path}`;

export const PayloadManifestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kit_version: SemverSchema,
    channel: ChannelNameSchema,
    /** 按 `<agent>/<target>/<path>` 字节序排列,键唯一 */
    files: z.array(PayloadFileSchema),
    migrations: z.array(PayloadMigrationSchema).default([]),
    skippedLayers: z.array(z.strictObject({ layer: LayerSchema, reason: z.string() })),
  })
  .superRefine((m, ctx) => {
    for (let i = 1; i < m.files.length; i++) {
      const prev = fileKey(m.files[i - 1] as PayloadFile);
      const cur = fileKey(m.files[i] as PayloadFile);
      if (!(prev < cur)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i],
          message: 'files 必须按 <agent>/<target>/<path> 严格升序(排序且键唯一)',
        });
        break;
      }
    }
  });
export type PayloadManifest = z.infer<typeof PayloadManifestSchema>;

/** 包根 `integrity.json`:包内每个文件(不含它自己)的逐文件哈希。外部锚点 = 它自身的 sha256,记在 update/state.json。 */
export const PayloadIntegritySchema = z
  .strictObject({
    schema_version: z.literal(1),
    kit_version: SemverSchema,
    algorithm: z.literal('sha256'),
    /** 按 path 字节序严格升序;不得包含 `integrity.json` 自身 */
    files: z.array(
      z.strictObject({
        path: RelPathSchema,
        sha256: Sha256Schema,
        bytes: z.number().int().nonnegative(),
      }),
    ),
  })
  .superRefine((m, ctx) => {
    for (let i = 0; i < m.files.length; i++) {
      const cur = (m.files[i] as { path: string }).path;
      if (cur === 'integrity.json') {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'path'],
          message: 'integrity.json 不得包含自身',
        });
      }
      if (i > 0 && !((m.files[i - 1] as { path: string }).path < cur)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'path'],
          message: 'files 必须按 path 严格升序(排序且唯一)',
        });
        break;
      }
    }
  });
export type PayloadIntegrity = z.infer<typeof PayloadIntegritySchema>;
