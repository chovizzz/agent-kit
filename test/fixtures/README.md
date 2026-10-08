# test/fixtures

约定(各块新增 fixture 时遵守):

- **一律合成**:不得放真实会话内容、真实密钥、真实客户名。含「秘密」的种子与合成会话由生成器在运行时拼装并写到 `$KIT_TMP`(或 `.state/test-tmp`),**仓库里不存在完整的假密钥字面量,也不存在含秘密的 `.jsonl`**(A10;避免触发 GitHub push protection)。
- 每个 fixture 目录带 `expect.json`,断言**诊断码**(`code`),不断言 message。负向 fixture 必须配对一个正向控制 fixture,防止负向断言静默变空。
- `lint-violations/`:B01 的反向对照样本,每个文件故意违反一条 io 限制;正常 `pnpm run lint` 与 `tsconfig.json` 都跳过它,`test/lint/violations.test.ts` 逐个检查必须被拦。
  新增样本时,同时在该测试的 `EXPECTED` 表里登记(表与目录必须一一对应)。
- 需要 git 仓库的 fixture 用脚本化构造(`test/helpers/make-repo.ts`,B04),建在 `$KIT_TMP` 下,环境卫生见 `docs/contracts.md` §4.4。
