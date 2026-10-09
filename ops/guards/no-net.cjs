'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- 经 NODE_OPTIONS=--require 预加载的 CJS 垫片,只能用 require */
// A8 运行期零网络垫片:`NODE_OPTIONS=--require ops/guards/no-net.cjs`。
// 覆盖:net / tls / http / https / http2 / dns(含 dns/promises)/ dgram / 全局 fetch / undici(若可解析)
//       / child_process 启动 curl|wget|nc|ncat|ssh|scp|telnet|ftp。
// 被拦时抛 Error(code='ENO_NET'),并向 stderr 写一行 `[no-net] blocked <api>`(即使调用方吞掉异常也留痕);
// 若设了 KIT_NO_NET_LOG,同时追加写入该文件。
// 作用域:只管运行期命令(build/check/redact/signals);安装/audit/spike 属开发期,不要给它们加这个垫片。
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const NET_BINARIES = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'telnet',
  'ftp',
]);
const NET_WORDS = /(^|[\s;&|()`'"/])(curl|wget|nc|ncat|netcat|ssh|scp|sftp|telnet|ftp)(\s|$)/;

function blocked(api) {
  const msg = `[no-net] blocked ${api}`;
  try {
    process.stderr.write(msg + '\n');
    if (process.env.KIT_NO_NET_LOG) fs.appendFileSync(process.env.KIT_NO_NET_LOG, msg + '\n');
  } catch {
    /* 留痕失败也要照样拦 */
  }
  const e = new Error(`网络访问被 no-net 垫片拒绝:${api}`);
  e.code = 'ENO_NET';
  return e;
}

function deny(obj, name, label) {
  if (!obj || typeof obj[name] !== 'function') return;
  const fn = function () {
    throw blocked(label || name);
  };
  try {
    Object.defineProperty(obj, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    /* 不可改的属性忽略 */
  }
}

function denyAsync(obj, name, label) {
  if (!obj || typeof obj[name] !== 'function') return;
  const fn = function () {
    return Promise.reject(blocked(label || name));
  };
  try {
    Object.defineProperty(obj, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    /* ignore */
  }
}

// ---- net / tls / http / https / http2 / dgram ----
const net = require('node:net');
for (const n of ['connect', 'createConnection']) deny(net, n, `net.${n}`);
if (net.Socket && net.Socket.prototype) {
  deny(net.Socket.prototype, 'connect', 'net.Socket#connect');
}
const tls = require('node:tls');
deny(tls, 'connect', 'tls.connect');
const http = require('node:http');
for (const n of ['request', 'get']) deny(http, n, `http.${n}`);
const https = require('node:https');
for (const n of ['request', 'get']) deny(https, n, `https.${n}`);
// 直接 new ClientRequest(url) 也是出网面
deny(http, 'ClientRequest', 'http.ClientRequest');
const http2 = require('node:http2');
deny(http2, 'connect', 'http2.connect');
const dgram = require('node:dgram');
deny(dgram, 'createSocket', 'dgram.createSocket');

// ---- dns ----
const dns = require('node:dns');
for (const n of [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
  'resolvePtr',
  'resolveNaptr',
  'resolveSoa',
  'resolveCaa',
  'reverse',
]) {
  deny(dns, n, `dns.${n}`);
}
if (dns.Resolver && dns.Resolver.prototype) {
  for (const n of Object.getOwnPropertyNames(dns.Resolver.prototype)) {
    if (/^(resolve|reverse)/.test(n)) deny(dns.Resolver.prototype, n, `dns.Resolver#${n}`);
  }
}
const dnsp = dns.promises;
if (dnsp.Resolver && dnsp.Resolver.prototype) {
  for (const n of Object.getOwnPropertyNames(dnsp.Resolver.prototype)) {
    if (/^(resolve|reverse)/.test(n))
      denyAsync(dnsp.Resolver.prototype, n, `dns.promises.Resolver#${n}`);
  }
}
for (const n of [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
  'resolvePtr',
  'resolveNaptr',
  'resolveSoa',
  'resolveCaa',
  'reverse',
]) {
  denyAsync(dnsp, n, `dns.promises.${n}`);
}

// ---- 全局 fetch 家族(undici 内置) ----
for (const n of ['fetch']) {
  if (typeof globalThis[n] === 'function') {
    Object.defineProperty(globalThis, n, {
      value: function () {
        return Promise.reject(blocked('fetch'));
      },
      writable: true,
      configurable: true,
    });
  }
}
for (const n of ['WebSocket', 'EventSource']) {
  if (typeof globalThis[n] === 'function') {
    Object.defineProperty(globalThis, n, {
      value: function () {
        throw blocked(n);
      },
      writable: true,
      configurable: true,
    });
  }
}

// ---- undici(若项目里装了):通过 Module._load 钩住 require('undici') ----
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/(^|[\\/])undici($|[\\/])/.test(String(request))) throw blocked(`require(${request})`);
  return origLoad.call(this, request, parent, isMain);
};

// ---- child_process:启动联网二进制 ----
const cp = require('node:child_process');
// 能"转手"启动别的程序的包装器 / 能直接写网络代码的解释器
const WRAPPERS = new Set([
  'env',
  'xargs',
  'nohup',
  'command',
  'exec',
  'sudo',
  'time',
  'timeout',
  'busybox',
  'nice',
]);
const INTERPRETERS = /^(python[0-9.]*|perl|ruby|php|lua|osascript|pwsh|powershell)$/;
const CODE_NET_WORDS =
  /(socket|urllib|requests|http\.client|httplib|net\/http|LWP|IO::Socket|Net::|fetch\(|XMLHttpRequest|curl_)/;
function checkSpawn(file, args, label) {
  const base = path.basename(String(file || ''));
  if (NET_BINARIES.has(base)) throw blocked(`${label}(${base})`);
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (WRAPPERS.has(base) && argv.some((a) => NET_BINARIES.has(path.basename(a)))) {
    throw blocked(`${label}(${base} 包装联网命令)`);
  }
  if (INTERPRETERS.test(base) && CODE_NET_WORDS.test(argv.join(' '))) {
    throw blocked(`${label}(${base} 内联网络代码)`);
  }
  if (base === 'node' || base === 'bun' || base === 'deno') {
    // 子 node 若没带本垫片,等于绕开:要求显式继承(NODE_OPTIONS 由调用方保证),这里只拦内联联网代码
    if (
      /(require\(['"]node:)?(net|tls|https?|http2|dns|dgram)['"]\)|fetch\(/.test(argv.join(' '))
    ) {
      throw blocked(`${label}(${base} 内联网络代码)`);
    }
  }
  const all = [String(file || ''), ...argv].join(' ');
  if (
    (base === 'sh' || base === 'bash' || base === 'zsh' || base === 'dash') &&
    NET_WORDS.test(all)
  ) {
    throw blocked(`${label}(shell: 含联网命令)`);
  }
}
function wrapSpawn(name) {
  const orig = cp[name];
  if (typeof orig !== 'function') return;
  cp[name] = function (file, args) {
    const a = Array.isArray(args) ? args : [];
    checkSpawn(file, a, `child_process.${name}`);
    return orig.apply(this, arguments);
  };
}
for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) wrapSpawn(n);
for (const n of ['exec', 'execSync']) {
  const orig = cp[n];
  if (typeof orig !== 'function') continue;
  cp[n] = function (command) {
    if (NET_WORDS.test(String(command))) throw blocked(`child_process.${n}(含联网命令)`);
    return orig.apply(this, arguments);
  };
}

// ESM 命名导入也要看到被替换的函数
try {
  Module.syncBuiltinESMExports();
} catch {
  /* 老版本没有就算了 */
}
