/**
 * `rsi hooks --print --agent <a>`(contracts R20-15.1 / R20-15.25):只输出**形状表生成的固定内容**(钩子片段、pi 扩展源码、键路径、事件名),
 * 不读不写任何文件、不看 `[rsi]` 状态。绝对路径只用 `~/` 相对写法。
 */
import {
  entriesOf,
  sourceOf,
  type HookShape,
  type HookVariant,
} from '../../contracts/rsi-hooks.js';
import { variantJsonSpecs } from './entries.js';

export function renderPrint(shape: HookShape, variant: HookVariant, verified: boolean): string {
  const head = [
    `# agent-kit rsi hooks --print --agent ${shape.agent}`,
    `# shape=${shape.shape_version} variant=${variant} evidence=${shape.evidence} verified=${verified ? 'yes' : 'no'}`,
  ];
  const tail: string[] = [`# 失败与退出码处理:${shape.failure_handling}`];
  if (shape.trust_step !== null) tail.push(`# 信任步骤:${shape.trust_step}`);
  if (!verified) {
    tail.push(
      '# 形状尚未核实:--install --write 对它会退 4 shape_unverified;请按上面的内容自行合并。',
    );
  }
  if (shape.kind === 'file') {
    const src = sourceOf(shape, variant);
    if (src === null) throw new Error('shape has no such variant');
    return [
      ...head,
      `# 把下面的内容保存为 ~/${shape.target_rel}(整个文件由 kit 生成,不合并):`,
      src.endsWith('\n') ? src.slice(0, -1) : src,
      ...tail,
      '',
    ].join('\n');
  }
  const specs = variantJsonSpecs(shape, variant);
  if (specs === null || entriesOf(shape, variant) === null)
    throw new Error('shape has no such variant');
  const hooks: Record<string, unknown[]> = {};
  for (const s of specs) (hooks[s.event] ??= []).push(s.wrapper);
  return [
    ...head,
    `# 把下面 hooks 里的每个数组元素追加到 ~/${shape.target_rel} 的同名事件数组里(没有就新建);不要改动文件里的其它内容:`,
    JSON.stringify({ hooks }, null, 2),
    ...tail,
    '',
  ].join('\n');
}
