import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SELF, WT_HOME } from './env.ts';
import { devClient, ensureTemplate, fingerprint, foreignDeps, simUdidByName, type Platform } from './devices.ts';
import { profileFor, registry, type Mobile } from './profile.ts';
import { lock, unlock } from './state.ts';
import { capture, die, interactive, ok, out, run, say, stamp, tee } from './util.ts';
import { resolve, worktreeAt } from './worktree.ts';

async function builderSync(m: Mobile, repo: string, src: string) {
  if (!existsSync(join(m.builder, '.git'))) {
    say(`build: creating builder worktree ${m.builder}`);
    if (!ok('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', m.builder, 'HEAD'])) return false;
    if (!ok('git', ['-C', repo, 'worktree', 'lock', '--reason', 'wt dev-client builder', m.builder])) return false;
  }
  say(`build: mirroring ${src}`);
  const head = capture('git', ['-C', src, 'rev-parse', 'HEAD']).stdout.trim();
  if (!ok('git', ['-C', m.builder, 'checkout', '--quiet', '--force', '--detach', head])) return false;
  capture('git', ['-C', m.builder, 'clean', '-fdq']);
  const changed =
    capture('git', ['diff', '-z', '--name-only', '--diff-filter=d', 'HEAD'], { cwd: src }).stdout +
    capture('git', ['ls-files', '-z', '-o', '--exclude-standard'], { cwd: src }).stdout;
  if (!ok('rsync', ['-a', '--from0', '--files-from=-', `${src}/`, `${m.builder}/`], { input: changed })) return false;
  for (const f of capture('git', ['diff', '-z', '--name-only', '--diff-filter=D', 'HEAD'], { cwd: src }).stdout.split('\0')) {
    if (f) rmSync(join(m.builder, f), { force: true });
  }
  say('build: installing dependencies');
  for (const c of m.builderSetup) if (await run(c[0], c.slice(1), { cwd: m.builder })) return false;
  return true;
}

// moves a built dev client into the cache under its fingerprint
function cache(m: Mobile, fp: string, built: string) {
  const tmp = join(m.cacheDir, `.tmp-${fp}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  if (!ok('ditto', [built, join(tmp, basename(built))])) return false;
  const sha = capture('git', ['-C', m.builder, 'rev-parse', '--short', 'HEAD']).stdout.trim();
  writeFileSync(join(tmp, 'built'), `${stamp()} ${sha}\n`);
  renameSync(tmp, join(m.cacheDir, fp));
  say(`build: cached ${fp}`);
  return true;
}

const prebuildEnv = { CI: '1', EXPO_NO_GIT_STATUS: '1' };

function tail(file: string, re: RegExp, n: number, after = 0) {
  const ls = readFileSync(file, 'utf8').split('\n');
  const hits: string[] = [];
  ls.forEach((l, i) => {
    if (re.test(l)) hits.push(...ls.slice(i, i + 1 + after));
  });
  for (const l of hits.slice(-n)) out(`${l}\n`);
}

async function buildApp(m: Mobile, fp: string) {
  const dir = join(m.builder, m.appDir);
  const xlog = join(WT_HOME, 'xcodebuild.log');
  if (!(await ensureTemplate(m))) return false;
  say('build: expo prebuild --clean');
  if (await run(m.prebuild.ios[0], m.prebuild.ios.slice(1), { cwd: dir, env: prebuildEnv })) return false;
  // prebuild reports a failed pod install without failing
  if (!existsSync(join(dir, 'ios', `${m.iosApp}.xcworkspace`))) {
    say('build: prebuild produced no workspace, pod install failed above');
    return false;
  }
  say(`build: xcodebuild (log: ${xlog})`);
  const r = capture('bash', ['-c', 'exec "$@" >"$0" 2>&1', xlog, 'xcodebuild', '-workspace', `${m.iosApp}.xcworkspace`,
    '-scheme', m.iosApp, '-configuration', 'Debug', '-destination', `id=${simUdidByName(m.template)}`,
    '-derivedDataPath', m.builderDerived, 'build'], { cwd: join(dir, 'ios'), env: { RCT_NO_LAUNCH_PACKAGER: '1' } });
  if (r.code) {
    tail(xlog, /error:|BUILD FAILED/, 20);
    return false;
  }
  return cache(m, fp, join(m.builderDerived, `Build/Products/Debug-iphonesimulator/${m.iosApp}.app`));
}

// arm64 only, the one abi the emulators run; --no-daemon so a rare build leaves no jvm behind
async function buildApk(m: Mobile, fp: string) {
  const dir = join(m.builder, m.appDir);
  const glog = join(WT_HOME, 'gradle.log');
  say('build: expo prebuild --clean (android)');
  if (await run(m.prebuild.android[0], m.prebuild.android.slice(1), { cwd: dir, env: prebuildEnv })) return false;
  say(`build: gradle assembleDebug (log: ${glog})`);
  const r = capture('bash', ['-c', 'exec "$@" >"$0" 2>&1', glog, './gradlew', '--no-daemon', ':app:assembleDebug',
    '-PreactNativeArchitectures=arm64-v8a'], { cwd: join(dir, 'android') });
  if (r.code) {
    tail(glog, /What went wrong|error:/, 30, 5);
    return false;
  }
  return cache(m, fp, join(dir, 'android/app/build/outputs/apk/debug/app-debug.apk'));
}

export async function cmdBuild(args: string[]) {
  // pnpm only resolves to a working version through the login shell's PATH
  if (!process.env.WT_LOGIN) return interactive('bash', ['-lc', 'WT_LOGIN=1 exec "$0" build "$@"', SELF, ...args]);
  let plat: Platform = 'ios';
  let n = '';
  for (const a of args) {
    if (a === 'ios' || a === 'android') plat = a;
    else n = a;
  }
  let src: string;
  let repo: string;
  if (n || worktreeAt(process.cwd())) {
    const w = resolve(n);
    if (!profileFor(w.repo).mobile) die(`${w.name} is not a worktree of a repo with a dev client`);
    src = w.path;
    repo = w.repo;
  } else {
    repo = registry.find((p) => p.mobile)?.repo ?? die('no profile has a dev client');
    src = repo;
  }
  const m = profileFor(repo).mobile!;
  tee(join(WT_HOME, 'builder.log'));
  const deps = foreignDeps(src);
  if (deps) die(`${src} links node_modules to ${deps}, so its fingerprint cannot be reproduced; in ${src} run: find . -name node_modules -prune -exec rm -rf {} + && pnpm install`);
  const l = join(WT_HOME, '.builder');
  await lock(l, 3600);
  try {
    const want = fingerprint(src, m, plat) ?? die(`fingerprint failed for ${src}`);
    if (existsSync(devClient(m, want, plat))) {
      say(`build: ${plat} ${want} already cached`);
      return 0;
    }
    say(`build: ${plat} ${want} for ${src}`);
    if (!(await builderSync(m, repo, src))) die('builder sync failed');
    const got = fingerprint(m.builder, m, plat);
    if (got !== want) die(`builder fingerprint ${got} does not reproduce ${want}`);
    if (!(await (plat === 'android' ? buildApk(m, want) : buildApp(m, want)))) die('build failed');
    return 0;
  } finally {
    unlock(l);
  }
}
