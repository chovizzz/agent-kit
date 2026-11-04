/**
 * D-AU1 / D-AU2:eslint 授权块——`src/update/{installed,auto-install,signal-code}.ts` 是钩子入口闭包里的零网络只读构件,
 * 比 `src/update/**` 的默认再收紧:不得引用 net.ts / 启动器 / home-fs / sigstore / runSelf / 网络模块 / fetch。
 * 对照:同样的代码放进 install.ts / launcher.ts / 其它 update 文件(既有放行)仍不报错——这条收窄只落在这三个文件上。
 */
import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/tmp.js';

const eslint = new ESLint({ cwd: REPO_ROOT });
const lintAs = async (code: string, rel: string) => {
  const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
  return res!.messages.filter((m) => m.ruleId?.startsWith('no-restricted'));
};

const NET_IMP = "import { httpGet } from '../io/net.js';\nexport const g = httpGet;\n";
const NET_REX = "export { httpGet } from '../io/net.js';\n";
const NET_DYN = "export const l = () => import('../io/net.js');\n";
const HF_IMP = "import { writeHome } from '../io/home-fs.js';\nexport const w = writeHome;\n";
const LCH_IMP = "import { launch } from './launcher.js';\nexport const g = launch;\n";
const LCH_DYN = "export const l = () => import('./launcher.js');\n";
const RS_IMP = "import { runSelf } from '../io/exec.js';\nexport const r = runSelf;\n";
const SIG = "import { verify } from 'sigstore';\nexport const v = verify;\n";
const FETCH = 'export const g = () => fetch("https://example.invalid");\n';
const HTTPS = "import { request } from 'node:https';\nexport const r = request;\n";

const ZERO_NET = [
  'src/update/installed.ts',
  'src/update/auto-install.ts',
  'src/update/signal-code.ts',
];

describe('D-AU 零网络只读构件的 lint 授权块', () => {
  it('net / home-fs / 启动器 / runSelf / sigstore / fetch / 网络模块一律被拦(import / re-export / 动态 import)', async () => {
    for (const [name, code] of Object.entries({
      net: NET_IMP,
      netRex: NET_REX,
      netDyn: NET_DYN,
      homeFs: HF_IMP,
      launcher: LCH_IMP,
      launcherDyn: LCH_DYN,
      runSelf: RS_IMP,
      sigstore: SIG,
      fetch: FETCH,
      https: HTTPS,
    })) {
      for (const where of ZERO_NET) {
        expect((await lintAs(code, where)).length, `${where}: ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('对照:收窄只落在这三个文件上——install.ts 仍可引 net / home-fs,其它 update 文件仍可引 net', async () => {
    expect(await lintAs(NET_IMP, 'src/update/install.ts')).toEqual([]);
    expect(await lintAs(HF_IMP, 'src/update/install.ts')).toEqual([]);
    expect(await lintAs(NET_IMP, 'src/update/policy.ts')).toEqual([]);
    expect(await lintAs(NET_IMP, 'src/update/worker.ts')).toEqual([]);
  });

  it('正向:这三个文件引用普通模块是干净的', async () => {
    const ok = "import { probePath } from '../io/probe.js';\nexport const p = probePath;\n";
    for (const where of ZERO_NET) expect(await lintAs(ok, where), where).toEqual([]);
  });
});
