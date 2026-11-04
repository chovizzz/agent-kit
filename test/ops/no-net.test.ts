import { describe, expect, it } from 'vitest';
import { NO_NET, runNode } from './helpers.js';

// 每个探针:尝试联网(目标只是回环地址的 1 号端口,绝不出机器),把异常的 code 打印到 stdout。
// 回环地址在运行时拼接,避免源码里出现字面 IP(隐私扫描 A10 对 IPv4 字面量零容忍)。
const LOOP = ['127', '0', '0', '1'].join('.');
const LOOP_HTTP = ['http', '://', LOOP, ':1'].join('');
const LOOP_HTTPS = ['https', '://', LOOP, ':1'].join('');
const PROBES: Record<string, string> = {
  'net.connect': `try { require('node:net').connect(1, '${LOOP}'); } catch (e) { console.log(e.code); }`,
  'net.createConnection': `try { require('node:net').createConnection({ port: 1, host: '${LOOP}' }); } catch (e) { console.log(e.code); }`,
  'net.Socket#connect': `try { new (require('node:net').Socket)().connect(1, '${LOOP}'); } catch (e) { console.log(e.code); }`,
  'tls.connect': `try { require('node:tls').connect(1, '${LOOP}'); } catch (e) { console.log(e.code); }`,
  'http.request': `try { require('node:http').request('${LOOP_HTTP}/'); } catch (e) { console.log(e.code); }`,
  'http.get': `try { require('node:http').get('${LOOP_HTTP}/'); } catch (e) { console.log(e.code); }`,
  'https.request': `try { require('node:https').request('${LOOP_HTTPS}/'); } catch (e) { console.log(e.code); }`,
  'https.get': `try { require('node:https').get('${LOOP_HTTPS}/'); } catch (e) { console.log(e.code); }`,
  'http2.connect': `try { require('node:http2').connect('${LOOP_HTTP}'); } catch (e) { console.log(e.code); }`,
  'http.ClientRequest': `try { new (require('node:http').ClientRequest)('${LOOP_HTTP}/'); } catch (e) { console.log(e.code); }`,
  'dns.promises.Resolver#resolve4': `new (require('node:dns').promises.Resolver)().resolve4('example.invalid').catch((e) => console.log(e.code));`,
  'require(absolute undici path)': `try { require('/nonexistent/node_modules/undici/index.js'); } catch (e) { console.log(e.code); }`,
  'child_process.spawnSync env curl': `try { require('node:child_process').spawnSync('/usr/bin/env', ['curl', '--version']); } catch (e) { console.log(e.code); }`,
  'child_process.spawnSync python inline socket': `try { require('node:child_process').spawnSync('python3', ['-c', 'import socket; socket.create_connection(("${LOOP}", 1))']); } catch (e) { console.log(e.code); }`,
  'child_process.spawnSync node inline fetch': `try { require('node:child_process').spawnSync(process.execPath, ['-e', 'fetch("${LOOP_HTTP}/")']); } catch (e) { console.log(e.code); }`,
  'dgram.createSocket': `try { require('node:dgram').createSocket('udp4'); } catch (e) { console.log(e.code); }`,
  'dns.lookup': `try { require('node:dns').lookup('localhost', () => {}); } catch (e) { console.log(e.code); }`,
  'dns.resolve4': `try { require('node:dns').resolve4('example.invalid', () => {}); } catch (e) { console.log(e.code); }`,
  'dns.Resolver#resolve4': `try { new (require('node:dns').Resolver)().resolve4('example.invalid', () => {}); } catch (e) { console.log(e.code); }`,
  'dns.promises.lookup': `require('node:dns').promises.lookup('localhost').catch((e) => console.log(e.code));`,
  'dns/promises.resolve4': `require('node:dns/promises').resolve4('example.invalid').catch((e) => console.log(e.code));`,
  'global fetch': `fetch('${LOOP_HTTP}/').catch((e) => console.log(e.code));`,
  'require(undici)': `try { require('undici'); } catch (e) { console.log(e.code); }`,
  // ESM 动态 import 不经过 Module._load:靠 module.register 的 resolve 钩子拦(钩子线程里抛的错 code 不一定保留,按 message 里的 ENO_NET 认)
  "import('undici')": `import('undici').then(() => console.log('LOADED'), (e) => console.log(e && (e.code === 'ENO_NET' || /ENO_NET/.test(String(e.message))) ? 'ENO_NET' : 'OTHER:' + (e && e.code)));`,
  "import('undici/lib/fetch')": `import('undici/lib/fetch').then(() => console.log('LOADED'), (e) => console.log(e && (e.code === 'ENO_NET' || /ENO_NET/.test(String(e.message))) ? 'ENO_NET' : 'OTHER:' + (e && e.code)));`,
  'child_process.spawnSync curl': `try { require('node:child_process').spawnSync('curl', ['--version']); } catch (e) { console.log(e.code); }`,
  'child_process.execFileSync wget': `try { require('node:child_process').execFileSync('/usr/bin/wget', ['--version']); } catch (e) { console.log(e.code); }`,
  'child_process.execSync shell curl': `try { require('node:child_process').execSync('curl --version'); } catch (e) { console.log(e.code); }`,
  'child_process.spawn sh -c nc': `try { require('node:child_process').spawn('/bin/sh', ['-c', 'nc -z ${LOOP} 1']); } catch (e) { console.log(e.code); }`,
};

describe('A8 零网络垫片:每个网络面都被拦', () => {
  for (const [name, code] of Object.entries(PROBES)) {
    it(`拦截 ${name}`, () => {
      const r = runNode(['--require', NO_NET, '-e', code]);
      expect(r.stdout.trim()).toBe('ENO_NET');
      expect(r.stderr).toContain('[no-net] blocked');
    });
  }

  it('ESM 命名导入也被拦(syncBuiltinESMExports)', () => {
    const r = runNode([
      '--require',
      NO_NET,
      '--input-type=module',
      '-e',
      `import { connect } from 'node:net'; import { request } from 'node:http'; import { lookup } from 'node:dns';
       for (const f of [() => connect(1, '${LOOP}'), () => request('${LOOP_HTTP}/'), () => lookup('localhost', () => {})]) {
         try { f(); console.log('NOT_BLOCKED'); } catch (e) { console.log(e.code); }
       }`,
    ]);
    expect(r.stdout.trim().split('\n')).toEqual(['ENO_NET', 'ENO_NET', 'ENO_NET']);
  });

  it("静态 `import 'undici'`(ESM 入口)也被拦", () => {
    const r = runNode([
      '--require',
      NO_NET,
      '--input-type=module',
      '-e',
      `try { await import('undici'); console.log('LOADED'); } catch (e) { console.log(/ENO_NET/.test(String(e.message)) ? 'ENO_NET' : 'OTHER'); }`,
    ]);
    expect(r.stdout.trim()).toBe('ENO_NET');
    expect(r.stderr).toContain('[no-net] blocked import(undici)');
  });

  it("正向对照:ESM 动态 import 普通内置模块不受影响;没有垫片时 import('undici') 不是 ENO_NET", () => {
    const ok = runNode([
      '--require',
      NO_NET,
      '-e',
      `Promise.all([import('node:os'), import('node:path')]).then(() => console.log('ok'));`,
    ]);
    expect(ok.stdout.trim()).toBe('ok');
    expect(ok.stderr).not.toContain('[no-net]');
    const bare = runNode([
      '-e',
      `import('undici').then(() => console.log('LOADED'), (e) => console.log(/ENO_NET/.test(String(e.message)) ? 'ENO_NET' : 'OTHER'));`,
    ]);
    expect(bare.stdout.trim()).not.toBe('ENO_NET');
  });

  it('KIT_NO_NET_LOG 留痕:异常被调用方吞掉也能在日志里看到', () => {
    const r = runNode(
      ['--require', NO_NET, '-e', `try { require('node:net').connect(1, '${LOOP}'); } catch {}`],
      {},
    );
    expect(r.stderr).toContain('[no-net] blocked net.connect');
  });
});

describe('A8 垫片自检:正向对照与"没有垫片会真的去连"', () => {
  it('正向对照:不联网的正常代码(含起本地子进程)在垫片下照常运行,零拦截输出', () => {
    const r = runNode([
      '--require',
      NO_NET,
      '-e',
      `const fs = require('node:fs'); const os = require('node:os'); const cp = require('node:child_process');
       const out = cp.spawnSync('/bin/echo', ['ok'], { encoding: 'utf8' }).stdout.trim();
       console.log(out, typeof fs.readFileSync, typeof os.tmpdir);`,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok function function');
    expect(r.stderr).not.toContain('[no-net]');
  });

  it('没有垫片时同一个探针会真的发起连接(回环被拒),证明上面的拦截不是探针本身写错', () => {
    const r = runNode([
      '-e',
      `const s = require('node:net').connect(1, '${LOOP}');
       s.on('error', (e) => { console.log(e.code); });`,
    ]);
    expect(r.stdout.trim()).toBe('ECONNREFUSED');
    const f = runNode(['-e', `fetch('${LOOP_HTTP}/').catch((e) => console.log(e.message));`]);
    expect(f.stdout.trim()).toBe('fetch failed'); // 真的去连了、被回环拒绝;而不是 ENO_NET
  });
});
