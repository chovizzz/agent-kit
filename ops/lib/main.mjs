// 入口:node ops/lib/main.mjs [run|selftest|snap|diff|lists-check] [选项]。ops/zero-write-check.sh 是它的薄封装。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, HELP, checkLists, loadLists, parseArgs, runZeroWrite } from './zero-write.mjs';
import { runSelfTest } from './selftest.mjs';
import { diffSnapshots, resolveHome, takeSnapshot } from './snapshot.mjs';

const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

function summarize(report) {
  for (const f of report.findings)
    out(`FINDING ${f.code} ${JSON.stringify({ ...f, code: undefined })}`);
  for (const n of report.notes ?? []) out(`NOTE ${n}`);
  out(`stats ${JSON.stringify(report.stats ?? {})}`);
}

function main(argv) {
  let sub = 'run';
  if (['run', 'selftest', 'snap', 'diff', 'lists-check'].includes(argv[0])) sub = argv.shift();
  if (sub === 'diff') {
    if (argv.length !== 2) {
      err('用法:main.mjs diff <before.json> <after.json>');
      return EXIT.USAGE;
    }
    const d = diffSnapshots(
      JSON.parse(fs.readFileSync(argv[0], 'utf8')),
      JSON.parse(fs.readFileSync(argv[1], 'utf8')),
    );
    out(JSON.stringify(d, null, 2));
    return d.count > 0 ? EXIT.FAIL : EXIT.OK;
  }
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err(String(e.message));
    err(HELP);
    return EXIT.USAGE;
  }
  if (o.help) {
    out(HELP);
    return EXIT.OK;
  }
  if (o.selftest || sub === 'selftest') return runSelfTest(o, out);
  try {
    if (sub === 'snap') {
      const home = resolveHome(o.home);
      const lists = loadLists(o, home);
      const snap = takeSnapshot({
        home,
        managedText: lists.managedText,
        volatileText: lists.volatileText,
        adapterTargets: lists.adapterTargets,
        homeWatch: lists.homeWatch,
      });
      const dest = o.outRoot ? path.join(o.outRoot, 'snapshot.json') : undefined;
      if (dest) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, JSON.stringify(snap, null, 2) + '\n');
        out(`snapshot ${dest} ${JSON.stringify(snap.stats)}`);
      } else out(JSON.stringify(snap, null, 2));
      return EXIT.OK;
    }
    if (sub === 'lists-check') {
      const home = resolveHome(o.home);
      const problems = checkLists(o, loadLists(o, home));
      for (const p of problems) out(`FINDING ${p.code} ${JSON.stringify(p)}`);
      out(`lists-check: ${problems.length} 个问题`);
      return problems.length ? EXIT.LISTS_REJECTED : EXIT.OK;
    }
    const { exit, report } = runZeroWrite(o, out);
    summarize(report);
    return exit;
  } catch (e) {
    err(`ERROR ${e.message}`);
    return EXIT.NOT_RUN;
  }
}

process.exitCode = main(process.argv.slice(2));
