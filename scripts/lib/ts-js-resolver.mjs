/**
 * Node 模块解析钩子:相对路径的 `./x.js` 找不到时回退到 `./x.ts`(仓库的 TS 源码按 NodeNext 写 `.js` 说明符)。
 * 只给离线工具脚本用(经 `scripts/lib/ts-register.mjs` 注册);不用于产品代码。
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (
      e !== null &&
      typeof e === 'object' &&
      e.code === 'ERR_MODULE_NOT_FOUND' &&
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js')
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw e;
  }
}
