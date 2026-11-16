import { spawn } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SELF, WT_HOME } from './env.ts';
import { derivedData, emuSerial, purgeDevices, upEmu, upSim } from './devices.ts';
import { summary } from './inspect.ts';
import { baseSync } from './base.ts';
import { stopLeftovers } from './procs.ts';
import { startWatcher } from './idle.ts';
import {
  defaultRepo,
  appWindow,
  mergedProfiles,
  profileFor,
  profileNames,
  servicesOf,
  shareable,
  worktreePorts,
  type RepoProfile,
} from './profile.ts';
import { fwdEnv, startRun, words } from './runs.ts';
import { startShare } from './share.ts';
import { listening, slotFor } from './slots.ts';
import { del, get, lock, put, runningUp, touch, unlock } from './state.ts';
import { newWindow, winState } from './tmux.ts';
import { buildDependencies } from './turbo.ts';
import { capture, die, now, ok, say, shq, sleep, tee, trash } from './util.ts';
import { findWorktree, repoHere, resolve, worktreeAt, type Wt } from './worktree.ts';

const stateLock = (n: string) => join(WT_HOME, n, 'state');

async function setup(w: Wt, rp: RepoProfile) {
  if (get(w.name, 'setup') === '0') return true;
  put(w.name, 'setup', 'running');
  const rc = await rp.setup(w);
  put(w.name, 'setup', rc);
  if (rc) say(`setup: failed with exit ${rc}`);
  return rc === 0;
}

// a slot's ports can be taken after allocation by servers wt does not own
function slotFree(w: Wt, rp: RepoProfile, slot: number, svcs: string[]) {
  if (['dev', 'share', ...svcs.filter((s) => rp.services[s]?.command).map(appWindow)].some((win) => winState(w.name, win) === 'alive')) return true;
  const ports = worktreePorts(rp, slot);
  return !svcs.some((s) => {
    const svc = rp.services[s];
    return svc?.port && !svc.fixed && [ports.addr(s), ports.listen(s)].some(listening);
  });
}

export function upRequest(args: string[], cwd = process.cwd()) {
  const current = worktreeAt(cwd);
  const repo = current?.repo ?? repoHere(cwd) ?? defaultRepo();
  const local = profileFor(repo, current?.path ?? repo);
  const known = new Set([...profileNames(local), ...Object.keys(local.services)]);
  const targets = args.flatMap((arg, index) => {
    if (known.has(arg)) return [];
    const w = findWorktree(arg, cwd);
    return w ? [{ w, index }] : [];
  });
  if (targets.length > 1) die('pass only one worktree selector');
  const w = targets[0]?.w ?? resolve(undefined, cwd);
  const rp = profileFor(w.repo, w.path);
  const profs: string[] = [];
  const own: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (index === targets[0]?.index) continue;
    if (profileNames(rp).includes(arg)) profs.push(arg);
    else if (!rp.services[arg]?.share) die(`unknown profile or service: ${arg} (profiles: ${profileNames(rp).join(' ')})`);
    if (rp.services[arg]?.share) own.push(arg);
  }
  return { w, rp, profs, own };
}

export async function cmdUp(args: string[]) {
  const { w, rp, profs, own } = upRequest(args);
  const names = profileNames(rp).join(' ');
  if (!existsSync(w.path)) die(`no worktree at ${w.path} (profiles: ${names})`);
  // state and the tmux session are keyed by name alone
  const owner = get(w.name, 'repo');
  if (owner && owner !== w.repo) die(`${w.name} is taken by a worktree of ${owner}`);
  for (const a of profs) if (!profileNames(rp).includes(a)) die(`no profile ${a} in ${w.repo} (profiles: ${names})`);
  if (!profs.length && !get(w.name, 'profiles')) profs.push('code');
  const svcs = servicesOf(rp, mergedProfiles(get(w.name, 'profiles'), profs));
  const err = rp.validate?.(svcs);
  if (err) die(err);
  for (const s of own) if (!shareable(rp, svcs).includes(s)) die(`${s} is not a shared service of this worktree's profiles, so it always runs here`);

  await lock(stateLock(w.name));
  let slot: number | undefined;
  let cur: string;
  try {
    put(w.name, 'repo', w.repo);
    put(w.name, 'path', w.path);
    const ports: Record<string, number> = JSON.parse(get(w.name, 'ports') || '{}');
    for (const s of Object.values(rp.services)) if (s.pkg && s.portOffset !== undefined) ports[s.pkg] = s.portOffset;
    put(w.name, 'ports', JSON.stringify(ports));
    put(w.name, 'profiles', mergedProfiles(get(w.name, 'profiles'), profs));
    del(w.name, 'asleep');
    touch(w.name);
    if (own.length) put(w.name, 'own', [...new Set([...words(get(w.name, 'own')), ...own])].join(' '));
    cur = get(w.name, 'profiles');
    if (runningUp(w.name)) {
      say(`${w.name}: an up is already running and will pick up: ${cur}`);
      return 0;
    }
    if (cur === 'bare') {
      say(`${w.name}: bare, nothing to set up`);
      return 0;
    }
    if (servicesOf(rp, cur).length) slot = await slotFor(w.name);
    put(w.name, 'up.pid', `starting:${now()}`);
    newWindow(w, 'up', `WT_LOGIN=1${fwdEnv()} bash -lc ${shq(`${SELF} _up ${w.name}`)}`);
  } finally {
    unlock(stateLock(w.name));
  }
  say(`${w.name}: starting ${cur}${slot ? ` on slot ${slot}` : ''}`);
  if (!process.stdout.isTTY) {
    say(`follow with: wt logs ${w.name} up -f`);
    return 0;
  }
  await followUp(w.name);
  return 0;
}

// prints the up window's log from now on until its pass ends
async function followUp(n: string) {
  const log = join(WT_HOME, n, 'up.log');
  const off = existsSync(log) ? statSync(log).size : 0;
  const t = spawn('tail', ['-c', `+${off + 1}`, '-F', log], { stdio: ['ignore', 'inherit', 'ignore'] });
  // an interrupted up must not leave its follower running
  process.on('SIGINT', () => {
    t.kill();
    process.exit(130);
  });
  while (runningUp(n)) await sleep(1000);
  await sleep(500);
  t.kill();
}

// orchestrates a worktree's profiles inside its tmux up window, repeating while profiles
// were added during a pass
export async function cmdInternalUp(name: string) {
  const w = resolve(name);
  const rp = profileFor(w.repo, w.path);
  put(w.name, 'up.pid', process.pid);
  tee(join(WT_HOME, w.name, 'up.log'));
  let rc: number;
  for (;;) {
    rc = 0;
    const snap = get(w.name, 'profiles');
    const svcs = servicesOf(rp, snap);
    say(`up: ${snap}`);
    if (!(await setup(w, rp))) rc = 1;
    else if (svcs.length) {
      let slot = await slotFor(w.name);
      if (!slotFree(w, rp, slot, svcs)) {
        say(`slot ${slot}: a port was taken by another process, moving to a free slot`);
        del(w.name, 'slot');
        slot = await slotFor(w.name);
      }
      const shared = shareable(rp, svcs);
      const direct = svcs.filter((s) => !shared.includes(s));
      const apps = direct.filter((s) => rp.services[s]?.command);
      const runs = ['dev', ...shared, ...apps.map(appWindow)];
      const ports = worktreePorts(rp, slot);
      const roots = apps.map((s) => rp.services[s].pkg).filter((p): p is string => !!p);
      if (!(await buildDependencies(w.path, roots))) rc = 1;
      else {
        if (!(await startRun(w, w.name, rp, 'dev', direct, ports, runs))) rc = 1;
        for (const s of apps) if (!(await startRun(w, w.name, rp, appWindow(s), [s], ports, runs))) rc = 1;
        if (shared.length) startShare(w);
        startWatcher(w);
        const devices = svcs.map((s) => rp.services[s]?.device);
        if (devices.includes('sim') && !(await upSim(w, rp, slot))) rc = 1;
        if (devices.includes('emu') && !(await upEmu(w, rp, slot))) rc = 1;
      }
    }
    await lock(stateLock(w.name));
    const done = rc !== 0 || get(w.name, 'profiles') === snap;
    if (done) del(w.name, 'up.pid');
    unlock(stateLock(w.name));
    if (done) break;
  }
  say(rc ? 'up: failed, see above' : `up: ready — ${summary(w.name)}`);
  if (!rc) {
    const ports = worktreePorts(rp, Number(get(w.name, 'slot')));
    for (const s of servicesOf(rp, get(w.name, 'profiles'))) if (rp.services[s]?.port) say(`${s}: http://localhost:${ports.addr(s)}`);
  }
  return rc;
}

export function cmdDown(name?: string, quiet = false) {
  const w = resolve(name);
  const tell = quiet ? () => {} : say;
  if (ok('tmux', ['kill-session', '-t', `=${w.name}`])) tell(`${w.name}: stopped tmux session`);
  del(w.name, 'up.pid', 'shares', 'share.pid');
  baseSync(profileFor(w.repo));
  const u = get(w.name, 'sim');
  if (u && ok('xcrun', ['simctl', 'shutdown', u])) tell(`${w.name}: shut down simulator`);
  if (get(w.name, 'emu')) {
    const s = emuSerial(w.name);
    if (s && ok('adb', ['-s', s, 'emu', 'kill'])) tell(`${w.name}: shut down emulator`);
  }
  return 0;
}

// everything wt owns for a worktree: tmux session, simulator, avd, DerivedData, state
export function purge(name: string, cwd = process.cwd(), path?: string) {
  if (!name || name.includes('/')) die('purge needs a name');
  const w = findWorktree(name, cwd) ?? (path ? { name, path, repo: repoHere(cwd)! } : resolve(name, cwd));
  capture('tmux', ['kill-session', '-t', `=${w.name}`]);
  stopLeftovers([w.path]);
  const paths = purgeDevices(w.name);
  for (const d of derivedData()) if (d.workspace.startsWith(`${w.path}/`)) paths.push(d.dir);
  trash(paths);
  rmSync(join(WT_HOME, w.name), { recursive: true, force: true });
  baseSync(profileFor(w.repo));
}
