import { existsSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SELF, WT_HOME } from './env.ts';
import { portOf, type Mobile, type RepoProfile } from './profile.ts';
import { del, get, has, put } from './state.ts';
import { winState } from './tmux.ts';
import { taskText, turboLog } from './turbolog.ts';
import { alive, capture, detach, now, ok, run, say, sleep } from './util.ts';
import type { Wt } from './worktree.ts';

export const AVD_HOME = process.env.ANDROID_AVD_HOME || join(process.env.HOME!, '.android/avd');

export type Platform = 'ios' | 'android';

export function fingerprint(dir: string, m: Mobile, plat: Platform) {
  const app = join(dir, m.appDir);
  const r = capture(join(app, 'node_modules/.bin/fingerprint'), ['fingerprint:generate', '--platform', plat], { cwd: app });
  try {
    return (JSON.parse(r.stdout) as { hash?: string }).hash || undefined;
  } catch {
    return;
  }
}

// the pnpm store a checkout links to when it lies outside the checkout; autolinked module paths
// enter the fingerprint, so such a checkout's hash only reproduces where that store sits at the same relative path
export function foreignDeps(dir: string) {
  const store = join(dir, 'node_modules/.pnpm');
  if (!existsSync(store)) return;
  const real = realpathSync(store);
  return real.startsWith(`${realpathSync(dir)}/`) ? undefined : real;
}

// a fingerprint's cached dev client
export const devClient = (m: Mobile, fp: string, plat: Platform) =>
  join(m.cacheDir, fp, plat === 'android' ? 'app-debug.apk' : `${m.iosApp}.app`);

// ---------------------------------------------------------------- simulator

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

// simctl list takes ~2 s, so callers that ask repeatedly load it once
export function simDevices(): SimDevice[] {
  try {
    const j = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', '-j']).stdout) as { devices: Record<string, SimDevice[]> };
    return Object.values(j.devices).flat();
  } catch {
    return [];
  }
}

export const simUdidByName = (name: string, devs = simDevices()) =>
  devs.find((d) => d.name === name && d.isAvailable)?.udid;

export const simState = (udid: string, devs = simDevices()) => devs.find((d) => d.udid === udid)?.state ?? '';

export async function ensureTemplate(m: Mobile) {
  if (simUdidByName(m.template)) return true;
  const rts = JSON.parse(capture('xcrun', ['simctl', 'list', 'runtimes', '-j']).stdout) as {
    runtimes: { platform: string; isAvailable: boolean; identifier: string }[];
  };
  const rt = rts.runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable).at(-1)?.identifier ?? '';
  say(`sim: creating template ${m.template} (${m.device}, ${rt})`);
  const c = capture('xcrun', ['simctl', 'create', m.template, m.device, rt]);
  if (c.code) return false;
  const u = c.stdout.trim();
  if (!ok('xcrun', ['simctl', 'bootstatus', u, '-b'])) return false;
  // a custom-scheme openurl otherwise stops on an "open in …?" prompt nothing can tap
  capture('xcrun', ['simctl', 'spawn', u, 'defaults', 'write', 'com.apple.launchservices.schemeapproval',
    `com.apple.CoreSimulator.CoreSimulatorBridge-->${m.scheme}`, '-string', m.appId]);
  capture('xcrun', ['simctl', 'shutdown', u]);
  return true;
}

// the worktree's simulator, cloning the template the first time it needs one
export async function simFor(w: Wt, m: Mobile) {
  const have = get(w.name, 'sim');
  if (have && simState(have)) return have;
  if (!(await ensureTemplate(m))) return;
  say(`sim: cloning ${m.template} as ${w.name}`);
  const c = capture('xcrun', ['simctl', 'clone', simUdidByName(m.template) ?? '', w.name]);
  if (c.code) return;
  const udid = c.stdout.trim();
  put(w.name, 'sim', udid);
  del(w.name, 'sim.fp', 'sim.login');
  return udid;
}

export const boot = (udid: string) => ok('xcrun', ['simctl', 'bootstatus', udid, '-b']);

// ---------------------------------------------------------------- emulator

const emulatorSerials = () =>
  capture('adb', ['devices']).stdout.split('\n').map((l) => l.split(/\s+/)[0]).filter((s) => s.startsWith('emulator-'));

export const avdName = (serial: string) =>
  capture('adb', ['-s', serial, 'emu', 'avd', 'name']).stdout.split('\n')[0]?.replace(/\r/g, '').trim() ?? '';

// the avds of the running emulators
export const runningAvds = () => emulatorSerials().map(avdName);

// the serial of the running emulator of an avd
export const emuSerial = (avd: string) => emulatorSerials().find((s) => avdName(s) === avd);

// the worktree's avd, created the first time it needs an emulator
export function avdFor(w: Wt, m: Mobile) {
  if (get(w.name, 'emu') && existsSync(join(AVD_HOME, `${w.name}.ini`))) return true;
  say(`emu: creating avd ${w.name} (${m.avdDevice}, ${m.avdImage})`);
  const c = capture('avdmanager', ['create', 'avd', '-n', w.name, '-k', m.avdImage, '-d', m.avdDevice], { input: 'no\n' });
  if (c.code) return false;
  // host keyboard input and host gpu rendering
  const cfg = join(AVD_HOME, `${w.name}.avd/config.ini`);
  const kvs = ['hw.keyboard=yes', 'hw.gpu.enabled=yes', 'hw.gpu.mode=auto'];
  const keep = readFileSync(cfg, 'utf8').split('\n').filter((l) => l && !kvs.some((kv) => l.startsWith(kv.split('=')[0] + '=')));
  writeFileSync(cfg, [...keep, ...kvs].join('\n') + '\n');
  put(w.name, 'emu', w.name);
  del(w.name, 'emu.fp', 'emu.login');
  return true;
}

// the worktree's emulator serial, booting it if it is not running. its own session: the
// emulator shuts down on the hangup when the up window closes, nohup or not. emu kill
// saves a quickboot snapshot, so only the first boot is cold
export async function emuBoot(w: Wt) {
  let pid: number | undefined;
  if (!emuSerial(w.name)) {
    say(`emu: booting ${w.name}`);
    pid = detach('emulator', ['-avd', w.name, '-no-boot-anim'], { log: openSync(join(WT_HOME, w.name, 'emu.log'), 'w') });
  }
  for (let i = 0; i < 600; i++) {
    const s = emuSerial(w.name);
    if (s && capture('adb', ['-s', s, 'shell', 'getprop', 'sys.boot_completed']).stdout.trim() === '1') return s;
    if (pid && !alive(pid)) break;
    await sleep(1000);
  }
  say(`emu: ${w.name} did not boot (log: ${join(WT_HOME, w.name, 'emu.log')})`);
}

// localhost inside the emulator is the emulator itself, and reverse rules die with it
export function emuReverse(rp: RepoProfile, serial: string, slot: number) {
  for (const s of rp.mobile!.reverse) {
    const p = portOf(rp, s, slot);
    if (!ok('adb', ['-s', serial, 'reverse', `tcp:${p}`, `tcp:${p}`])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- app

// a device is a simulator udid or an emulator serial
export function openUrl(m: Mobile, device: string, url: string) {
  if (device.startsWith('emulator-'))
    return ok('adb', ['-s', device, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, m.appId]);
  return ok('xcrun', ['simctl', 'openurl', device, url]);
}

export const openApp = (m: Mobile, device: string, port: number) =>
  openUrl(m, device, `${m.scheme}://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${port}`);

async function metroUp(port: number) {
  try {
    const r = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(2000) });
    return (await r.text()).includes('running');
  } catch {
    return false;
  }
}

async function waitMetro(w: Wt, port: number) {
  for (let i = 0; i < 900; i++) {
    if (await metroUp(port)) return true;
    if (winState(w.name, 'dev') === 'dead') {
      say('dev: the turbo run exited, its error stays on screen in `wt attach`');
      return false;
    }
    await sleep(1000);
  }
  say(`dev: metro on :${port} not ready after 15 min`);
  return false;
}

export function bundledCount(w: Wt, rp: RepoProfile) {
  const pkg = rp.services[rp.mobile!.metro]?.pkg;
  const f = turboLog(w.path, pkg);
  if (!f) return 0;
  return taskText(f, pkg).filter((l) => l.includes('Bundled')).length;
}

// the js app only takes deep links once its bundle is served, which under load takes minutes
async function waitBundled(w: Wt, rp: RepoProfile, seen: number) {
  for (let i = 0; i < 900; i++) {
    if (bundledCount(w, rp) > seen) return true;
    await sleep(1000);
  }
  return false;
}

// the worktree's dev client for a platform, built on a cache miss
async function devClientFor(w: Wt, m: Mobile, tag: string, plat: Platform) {
  const fp = fingerprint(w.path, m, plat);
  if (!fp) {
    say(`${tag}: fingerprint failed`);
    return;
  }
  const app = devClient(m, fp, plat);
  if (existsSync(app)) return { fp, app };
  say(`${tag}: no cached dev client for ${fp}, building (log: ${join(WT_HOME, 'builder.log')})`);
  if (await run(SELF, ['build', plat, w.name], { quiet: true })) {
    say(`${tag}: build failed`);
    return;
  }
  return { fp, app };
}

// opens the dev client on the worktree's metro, then signs it in once per device
async function launch(w: Wt, rp: RepoProfile, slot: number, device: string, tag: string) {
  const m = rp.mobile!;
  const port = portOf(rp, m.metro, slot)!;
  say(`${tag}: waiting for metro on :${port}`);
  if (!(await waitMetro(w, port))) return false;
  const seen = bundledCount(w, rp);
  // under heavy load simctl openurl times out
  for (let i = 1; i <= 5; i++) {
    if (openApp(m, device, port)) break;
    if (i === 5) {
      say(`${tag}: could not open the app on :${port}, retry with wt open`);
      return false;
    }
    say(`${tag}: opening the app failed, retrying`);
    await sleep(5000);
  }
  say(`${tag}: app opened on :${port}`);
  if (!m.login || has(w.name, `${tag}.login`)) return true;
  if (!(await waitBundled(w, rp, seen))) say(`${tag}: no bundle served after 15 min`);
  if (await run('bash', ['-c', m.login, 'login', device, tag], { cwd: w.path })) say(`${tag}: continuing signed out`);
  else put(w.name, `${tag}.login`, now());
  return true;
}

export async function upSim(w: Wt, rp: RepoProfile, slot: number) {
  const m = rp.mobile!;
  const dc = await devClientFor(w, m, 'sim', 'ios');
  if (!dc) return false;
  const udid = await simFor(w, m);
  if (!udid) return false;
  boot(udid);
  if (get(w.name, 'sim.fp') !== dc.fp) {
    say('sim: installing dev client');
    if (!ok('xcrun', ['simctl', 'install', udid, dc.app])) return false;
    put(w.name, 'sim.fp', dc.fp);
  }
  return launch(w, rp, slot, udid, 'sim');
}

export async function upEmu(w: Wt, rp: RepoProfile, slot: number) {
  const m = rp.mobile!;
  const dc = await devClientFor(w, m, 'emu', 'android');
  if (!dc || !avdFor(w, m)) return false;
  const serial = await emuBoot(w);
  if (!serial) return false;
  if (get(w.name, 'emu.fp') !== dc.fp) {
    say('emu: installing dev client');
    if (!ok('adb', ['-s', serial, 'install', '-r', dc.app])) return false;
    put(w.name, 'emu.fp', dc.fp);
  }
  if (!emuReverse(rp, serial, slot)) return false;
  return launch(w, rp, slot, serial, 'emu');
}

// xcode DerivedData dirs and the workspace each was built from
export function derivedData() {
  const root = join(process.env.HOME!, 'Library/Developer/Xcode/DerivedData');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  } catch {}
  return dirs.flatMap((dir) => {
    const r = capture('plutil', ['-extract', 'WorkspacePath', 'raw', join(dir, 'info.plist')]);
    return r.code ? [] : [{ dir, workspace: r.stdout.trim() }];
  });
}

// everything a worktree's devices leave behind: the simulator, the emulator and its avd
export function purgeDevices(n: string) {
  const paths: string[] = [];
  const u = get(n, 'sim');
  if (u) {
    capture('xcrun', ['simctl', 'shutdown', u]);
    capture('xcrun', ['simctl', 'delete', u]);
  }
  if (get(n, 'emu')) {
    const s = emuSerial(n);
    if (s) capture('adb', ['-s', s, 'emu', 'kill']);
    paths.push(join(AVD_HOME, `${n}.avd`), join(AVD_HOME, `${n}.ini`));
  }
  return paths;
}
