# npm 首发(`@chovizzz/agent-kit@0.1.0`):准备状态与用户待办

本文只写「准备但不发」。发布动作(`NPM_TOKEN`、打 tag)由用户亲手做;代理不执行 `npm publish`、不推 tag、不改仓库 settings。

## 1. 现状(2026-10-22 实测)

- npm 上已有 `0.0.0-stage` 与 `0.1.0-rc.0`;dist-tag:`latest` = `0.0.0-stage`,`rc` = `0.1.0-rc.0`。`0.1.0-rc.0` 带 provenance(见 `test/update/fixtures/att-rc0.json`),所以 `@chovizzz` scope 存在、发布链路曾经跑通。
- GitHub 仓库是 PUBLIC(provenance 的前提)。`package.json` 已有 `repository`(指向本仓库)、`publishConfig.access=public`、`engines.node>=22`、`bin.agent-kit=dist/cli.js`、`files` 白名单。
- **`package.json` / `src/contracts/meta.ts` 的 `KIT_VERSION` / `kit.toml` 三处版本仍是 `0.1.0-rc.0`**。此时推 `v0.1.0` 会在 `check-publish --tag` 一步红(fail-closed,不会误发)。见 §3。
- **`latest` 现在指向 `0.0.0-stage`。** 发布稳定版 `0.1.0` 会把 `latest` 自动移到 `0.1.0`;带 `-` 后缀的版本只进 `rc`(`release.yml` 的发布步骤已按此分流)。

## 2. 干净检出里已核对的结果(javis,Node 22 / pnpm 10.33 / npm 10)

`pnpm install --frozen-lockfile --ignore-scripts`、`pnpm run build`、`node scripts/build-payload.mjs`、`node scripts/check-publish.mjs` 均退出 0。`npm pack --dry-run --json`:

| 项                | 值                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tarball           | `chovizzz-agent-kit-0.1.0-rc.0.tgz`,905213 B(解包 3198752 B),20 个文件                                                                                                                                                      |
| 文件分布          | `dist/`(`cli.js` 577 B 薄入口、`main.js` 1.2 MB 单文件打包、`provenance.js`、`chunks/` 7 个、`THIRD_PARTY_LICENSES`)、`payload/`(`manifest.json` + `files/` 4 个)、`integrity.json`、`package.json`、`README.md`、`LICENSE` |
| 白名单外文件      | 无。没有 `.state`、测试夹具、`.env`、`*.pem`、`*.jsonl`、`out/`、`src/`、`test/`                                                                                                                                            |
| 路径 / 用户名泄漏 | 全包扫描 `/Users/`、`/home/<name>`、构建机用户名:只命中 `main.js` 里的合成占位 `/Users/someone/...`(脱敏种子夹具,`check-publish` 明确放行)                                                                                  |
| 运行时依赖        | 无(`dependencies` 为空,第三方代码已打进 `main.js`,`THIRD_PARTY_LICENSES` 覆盖)                                                                                                                                              |
| bin               | `dist/cli.js` 首行 `#!/usr/bin/env node`;tarball 内模式 644 是正常的,npm 安装时会给 bin 链接加可执行位                                                                                                                      |

冒烟(临时目录 + 假 HOME,`npm install --ignore-scripts ./tarball`):`agent-kit --version` 输出 `0.1.0-rc.0`,`agent-kit check --help` 正常,`npx --no-install agent-kit --version` 正常;假 HOME 里只有 npm 自己的日志;真实 HOME 前后快照一致。

## 3. 打 tag 之前要先合入的「版本提升」提交(待定夺,本分支没做)

`0.1.0-rc.0` 的字符串散在生成物与测试夹具里(`out/` 的技能文件、`test/build/golden/*/tree.txt`、`test/update/*` 若干),提升版本是一个独立变更集,不是改一行。建议单独一个 PR:

1. 同时改 `package.json` 的 `version`、`src/contracts/meta.ts` 的 `KIT_VERSION`、`kit.toml` 的 `version`(`check-publish` 会核对三处一致);
2. 重新生成 `out/` 与 golden(`pnpm run golden:update`,并按 release-checklist §3 确认 `out/` 已随源码重生成);测试里把 `0.1.0-rc.0` 当作「被更新的旧版本」的夹具不要误改;
3. 全量门禁 + A10 + 远端 CI 全绿后合入 main。

## 4. 本分支对发布工作流做的修复

| 文件                             | 改动                                                                                                                       | 原因                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.github/workflows/release.yml`  | `id-token: write` 从工作流级挪到 `publish` job 级                                                                          | 最小权限;工作流级写法对以后新增的 job 是默认放开的                                                          |
| 同上                             | 新增 `environment: npm-publish`                                                                                            | 可挂 required reviewers 与 tag 部署规则;`NPM_TOKEN` 可存成环境 secret,只有走该环境的任务读得到              |
| 同上                             | 新增第一步:tag 提交必须是 `origin/main` 的祖先                                                                             | `on.push.tags: v*` 只管 tag 名,不管 tag 打在哪;没有这步,任何人从未审分支打 `v*` tag 都会触发带 token 的发布 |
| 同上                             | 补齐与 `ci.yml` 相同的验收脚本(A1 A2 A3 A4 A8 A9 A10 A14 A15、P1 的 A18 A19 A23)并加上 A11(依赖 audit / 精确版本 / 许可证) | 原来发布前只跑 vitest / lint / check,少了 `ci.yml` 里的验收门;发布路径不应比 PR 路径的门更少                |
| `.github/workflows/dist-tag.yml` | 新增 `environment: npm-publish`                                                                                            | token 存环境 secret 后该工作流才读得到;同样受 required reviewers 约束                                       |

核对过、无需改的:所有 action 按提交 SHA 钉版;不使用 `pull_request_target`;仅 `v*` tag 触发;`NODE_AUTH_TOKEN` 只注入最后一步 `npm publish`,安装与测试步骤拿不到;`pnpm install` 带 `--ignore-scripts`;`npm publish --provenance --access public --ignore-scripts` 是唯一的发布命令且在最后,前置门禁红则不会尝试发布;npm 对同一版本号拒绝二次发布,不会覆盖。publish 开始后若报红(例如响应丢失),版本可能已经发布,先 `npm view` 核对再决定是否重跑。

**不要重命名 `release.yml`**:客户端的 provenance 校验把工作流路径 `.github/workflows/release.yml` 与 ref `refs/tags/v<版本>` 钉死在代码里(`src/update/provenance.ts`)。

## 4.1 评审指出、本分支未做的残余风险(Pi GPT-6.1 Sol,供应链视角)

- **单 job 内 token 与项目代码同处一个 runner**:`NPM_TOKEN` 只注入最后一步,但安装 / 测试 / 验收脚本与发布在同一 runner 上跑,`id-token: write` 也覆盖整个 job。更稳的做法是拆成「验证 job(只读)」与「发布 job(持凭据,不再跑项目代码,只发布验证 job 产出的同一个 tarball)」。本分支只做了加 `--ignore-scripts`,拆 job 与「检查 tarball 本体再发同一个 tarball」留作后续(首发后与 Trusted Publishing 一并做)。
- **tag 提交里的 workflow 文件就是被执行的文件**:祖先检查写在 workflow 里,旧提交上的 tag 不受它约束。真正的边界是 §6.2 的 tag ruleset(限制谁能建 `v*` tag)+ 环境 required reviewers + 保护 `main`(禁止 force-push),这三条必须配,不能只靠 workflow 里的检查。
- **祖先检查允许 main 历史上的任意旧提交**:没有要求等于 main 当前 HEAD;tag 之前的自查(§6.3)和审批人看清 tag 指向哪个提交是补充。
- **`dist-tag` 手动运行**:该工作流绑定同一个环境,环境的部署规则必须同时允许 `main` 分支与 `v*` tag(见 §6.2),否则从 main 手动运行会被环境拒绝。

## 5. 待定夺(代理不拍板)

- **许可证(已做)**:`package.json` 的 `license` 改为 `MIT`,`LICENSE` 换成标准 MIT 全文,版权行 `Copyright (c) 2026 chovizzz`(GitHub 仓库所有者名);`check-publish` 新增 `LICENSE_FIELD` / `LICENSE_TEXT` 两项检查。**仍待你定**:版权行要不要换成真实姓名或公司名(改的话只改 `LICENSE` 里那一行即可,检查允许版权行不同)。
- **长期去掉 `NPM_TOKEN`**:npm 支持 Trusted Publishing(用 GitHub OIDC 免 token 发布)。首发后可以评估;本分支没有实现,因为需要先在 npm 包设置里登记工作流。

## 6. 用户亲手做的清单

### 6.1 确认 npm 侧

1. 登录 www.npmjs.com,打开包页面 `@chovizzz/agent-kit`,确认你的账号在 Settings 里有 Read and write(rc.0 是你发的,通常已满足)。
2. 本机 `npm whoami` 登录的账号应对 `@chovizzz/agent-kit` 有发布权(包页面 Settings 里能看到维护者)。
3. 创建发布用 token:头像 → Access Tokens → Generate New Token → Granular Access Token:
   - Token name:`agent-kit-ci-publish`;
   - Expiration:90 天内(到期前要换);
   - Packages and scopes:Permissions 选 Read and write,只选 `@chovizzz/agent-kit` 这一个包(不要选 All packages);
   - Organizations:不勾任何权限;
   - 若账号开了「发布需要 2FA」,token 页面上有 bypass 2FA 的勾选项时需要勾上,否则 CI 无法发布;另在包页面 Settings → Publishing access 确认选的是允许「granular token 绕过 2FA」的那一档,选成「禁止 token 发布」的那档时勾了 bypass 也发不了;
   - 生成后立刻复制(只显示一次),放进下一步的 secret,不要贴到聊天或文件里。

### 6.2 GitHub 侧

1. 仓库 Settings → Environments → New environment,名字 `npm-publish`(必须一字不差,工作流里写死)。
2. 在该环境里:
   - Required reviewers:勾选并加上你自己(或第二个人)。首发建议开,tag 推上去后要到 Actions 页面点 Approve 才会发;
   - Deployment branches and tags:选 Selected branches and tags,添加两条规则:Ref type 选 Tag、Name pattern 填 `v*`(发布用);Ref type 选 Branch、Name pattern 填 `main`(只为让手动运行的 `dist-tag` 工作流能通过环境检查);
   - Environment secrets → Add secret:Name `NPM_TOKEN`,Value 粘贴 6.1 的 token。
3. (可选,更严)Settings → Secrets and variables → Actions 里不要再放一份仓库级 `NPM_TOKEN`,避免其他任务读到。
4. Settings → Rules → Rulesets → New ruleset → New tag ruleset:
   - Ruleset Name:`protect-release-tags`;Enforcement status:Active;
   - Target tags:Add target → Include by pattern → `v*`;
   - Rules 勾选:Restrict creations、Restrict updates、Restrict deletions;
   - Bypass list:Add bypass → 选界面里提供的 Repository admin 角色(或你所在的团队 / 角色),否则你自己也建不了 tag;
   - 保存。效果:bypass 名单之外的人不能建、改、删 `v*` tag。注意 bypass 对该 ruleset 的所有规则同时生效,即 bypass 者也能移动 / 删除 tag;想做到「能建不能改删」需拆成两个 ruleset,第二个(Restrict updates + Restrict deletions)不设 bypass;
   - 另确认 `main` 的分支保护含「禁止 force-push」「禁止删除」。
5. `main` 的分支保护已在位(直接推 main 会被拒),发布前的版本提升必须走 PR。

### 6.3 发布前自查(本机或 javis 均可)

1. 版本提升 PR(§3)已合入 `main`,`main` 上 CI 全绿。
2. 在干净检出里:`git switch main && git pull --ff-only`,然后 `pnpm install --frozen-lockfile --ignore-scripts && pnpm run build && node scripts/build-payload.mjs && node scripts/check-publish.mjs --tag v0.1.0`,必须退出 0。
3. `npm view @chovizzz/agent-kit versions dist-tags --json` 确认 `0.1.0` 尚不存在。

### 6.4 首发 tag(只写命令,由你执行)

```sh
git switch main && git pull --ff-only
git tag -s v0.1.0 -m "agent-kit 0.1.0"
git push origin v0.1.0
```

推完后到仓库 Actions 页面找 `release` 运行;若配了 required reviewers,点 Review deployments → 勾选 `npm-publish` → Approve and deploy。tag 打错了:先别让它跑完,在 Approve 之前点 Reject;已发布则走 §7。

### 6.5 首发后验证

1. `npm view @chovizzz/agent-kit version dist-tags --json`:`latest` 应为 `0.1.0`,`rc` 仍为 `0.1.0-rc.0`。
2. 包页面 www.npmjs.com 上应显示 Provenance 徽标(Built and signed on GitHub Actions),并链回 `release` 工作流的运行。
3. 在空目录里真实安装并验签:

   ```sh
   mkdir /tmp/ak-verify && cd /tmp/ak-verify && npm init -y
   npm install @chovizzz/agent-kit@0.1.0
   npm audit signatures
   npx agent-kit --version
   ```

   `npm audit signatures` 应报告 registry 签名与 provenance attestations 均已验证。

4. 用已装的 `0.1.0-rc.0` 跑一次 `agent-kit update`(只看计划、不写盘的用法以 `agent-kit update --help` 为准),确认能发现 `0.1.0` 且 provenance 校验通过。

## 7. 回滚 / 撤回

- 优先用 `npm deprecate`:`npm deprecate @chovizzz/agent-kit@0.1.0 "原因,请升级到 0.1.1"`。版本仍可安装,但安装时会提示;撤销用空字符串:`npm deprecate @chovizzz/agent-kit@0.1.0 ""`。
- `npm unpublish` 限制:发布后 72 小时内且没有其他包依赖时可自助撤回;超过 72 小时仍可能自助撤回,但要同时满足 npm 的条件(无依赖者、上周下载量很低、单一维护者,具体阈值以 npm 当时的政策为准),不满足只能联系 npm 支持。被撤回的版本号永远不能再用,所以修复要发新版本(`0.1.1`)。不建议 unpublish。
- 把 `latest` 指回旧版本:仓库 Actions → `dist-tag` → Run workflow,version 填 `0.0.0-stage`(或其他已存在版本),tag 填 `latest`;或本机 `npm dist-tag add @chovizzz/agent-kit@<版本> latest`(需要登录)。该工作流需要 `npm-publish` 环境的审批。
- token 疑似泄漏:npmjs.com → Access Tokens 删除该 token;GitHub 环境 secret 删除并重建;再检查包页面的发布历史。
