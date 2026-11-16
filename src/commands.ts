import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WT_HOME } from './env.ts';
import { boot, emuBoot, emuReverse, openApp } from './devices.ts';
import { allServiceNames, appWindow, portOf, profileFor, servicesOf, shareable } from './profile.ts';
import { words } from './runs.ts';
import { get, names, touch } from './state.ts';
import { sessAlive, target, tmux, winState } from './tmux.ts';
import { followTask, taskText, turboLog } from './turbolog.ts';
import { capture, die, interactive, out, say } from './util.ts';
import { checkoutAt, findWorktree, resolve, type Wt } from './worktree.ts';

// splits args into a worktree and one keyword from an allowed set
function nameAnd(keywords: string[], args: string[]): { w: Wt; kw: string } {
  const here = checkoutAt(process.cwd());
  if (here) keywords = [...keywords, ...Object.keys(profileFor(here.repo, here.path).services)];
  const targets = args.flatMap((arg, index) => {
    if (keywords.includes(arg)) return [];
    const w = findWorktree(arg);
    return w ? [{ w, index }] : [];
  });
  if (targets.length > 1) die('pass only one worktree selector');
  const w = targets[0]?.w ?? resolve();
  keywords = [...keywords, ...Object.keys(profileFor(w.repo, w.path).services)];
  let kw = '';
  for (const [index, arg] of args.entries()) {
    if (index === targets[0]?.index) continue;
    if (!keywords.includes(arg)) die(`unknown service: ${arg}`);
    kw = arg;
  }
  return { w, kw };
}

export function cmdAttach(args: string[]) {
  let { w, kw } = nameAnd([...allServiceNames(), 'dev', 'up'], args);
  if (!sessAlive(w.name)) die(`${w.name} has no tmux session, run wt up`);
  touch(w.name);
  const rp = profileFor(w.repo, w.path);
  if (kw && rp.services[kw]?.command) kw = appWindow(kw);
  if (!kw) {
    const app = servicesOf(rp, get(w.name, 'profiles')).find((s) => rp.services[s]?.command && winState(w.name, appWindow(s)) === 'alive');
    if (app) kw = appWindow(app);
  }
  if (!kw && winState(w.name, 'dev') !== 'none') kw = 'dev';
  const t = target(w.name, kw || undefined);
  return interactive('tmux', process.env.TMUX ? ['switch-client', '-t', t] : ['attach', '-t', t]);
}

const lastLines = (file: string, n: number) => readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').slice(-n);

export async function cmdLogs(args: string[]) {
  const follow = args.includes('-f');
  const kws = [...new Set([...allServiceNames(), 'dev', 'all', 'up', 'share'])];
  const { w, kw } = nameAnd(kws, args.filter((a) => a !== '-f'));
  if (!kw) die(`which log? one of: ${kws.join(' ')}`);
  touch(w.name);
  const rp = profileFor(w.repo, w.path);
  let f = kw === 'up' || kw === 'share' ? join(WT_HOME, w.name, `${kw}.log`) : undefined;
  if (rp.services[kw]?.command) f = join(WT_HOME, w.name, `${appWindow(kw)}.log`);
  if (!f && rp.logs === 'pane') f = join(WT_HOME, w.name, 'dev.log');
  if (kw === 'all') {
    const files = servicesOf(rp, get(w.name, 'profiles'))
      .filter((s) => rp.services[s]?.command)
      .map((s) => join(WT_HOME, w.name, `${appWindow(s)}.log`))
      .filter(existsSync);
    if (files.length) {
      if (follow) return interactive('tail', ['-n', '100', '-F', ...files]);
      for (const file of files) {
        out(`${file}\n`);
        for (const line of lastLines(file, 100)) out(`${line}\n`);
      }
      const log = turboLog(w.path);
      if (log) for (const line of taskText(log).slice(-100)) out(`${line}\n`);
      return 0;
    }
  }
  if (f) {
    if (!existsSync(f)) die(`no log at ${f}`);
    if (follow) return interactive('tail', ['-n', '100', '-F', f]);
    for (const l of lastLines(f, 200)) out(`${l}\n`);
    return 0;
  }
  if (kw === 'dev') die(`dev is not a ${w.repo} service`);
  const svc = rp.services[kw];
  const pkg = kw === 'all' ? undefined : svc?.pkg;
  // a service the worktree has not changed runs in the base checkout
  const dir = rp.base && svc?.share && !words(get(w.name, 'own')).includes(kw) ? rp.base : w.path;
  const log = turboLog(dir, pkg) ?? die(`no turbo log${pkg ? ` with ${pkg}` : ''} in ${dir}`);
  if (follow) return followTask(log, pkg);
  for (const l of taskText(log, pkg).slice(-200)) out(`${l}\n`);
  return 0;
}

// a service name is accepted but every run of the worktree restarts; the base and the proxy
// keep running
export function cmdRestart(args: string[]) {
  const { w } = nameAnd([...allServiceNames(), 'dev'], args);
  const rp = profileFor(w.repo, w.path);
  const wins = ['dev', ...shareable(rp, Object.keys(rp.services)), ...Object.keys(rp.services).filter((s) => rp.services[s]?.command).map(appWindow)].filter((x) => winState(w.name, x) !== 'none');
  if (!wins.length) die(`${w.name} has no dev run, use wt up`);
  touch(w.name);
  for (const x of wins) tmux('respawn-pane', '-k', '-t', target(w.name, x));
  say(`${w.name}: restarted ${wins.join(', ')}`);
  return 0;
}

export function cmdPath(name?: string) {
  out(`${resolve(name).path}\n`);
  return 0;
}

export async function cmdOpen(name?: string) {
  const w = resolve(name);
  const rp = profileFor(w.repo, w.path);
  const udid = get(w.name, 'sim');
  const emu = get(w.name, 'emu');
  if (!rp.mobile || (!udid && !emu)) die(`${w.name} has no simulator or emulator`);
  touch(w.name);
  const slot = Number(get(w.name, 'slot'));
  const port = portOf(rp, rp.mobile.metro, slot)!;
  if (udid) {
    boot(udid);
    openApp(rp.mobile, udid, port);
    say(`${w.name}: app opened on the simulator on :${port}`);
  }
  if (emu) {
    const serial = await emuBoot(w);
    if (!serial || !emuReverse(rp, serial, slot)) die(`${w.name}: the emulator is not reachable`);
    openApp(rp.mobile, serial, port);
    say(`${w.name}: app opened on the emulator on :${port}`);
  }
  return 0;
}

const GRID = `on run argv
  tell application "iTerm2"
    set w to (create window with default profile)
    set zoomed of w to true
    set a to current session of w
    set panes to {a}
    if (count of argv) > 1 then
      tell a to set b to (split vertically with default profile)
      set end of panes to b
    end if
    if (count of argv) > 2 then
      tell a to set c to (split horizontally with default profile)
      set end of panes to c
    end if
    if (count of argv) > 3 then
      tell b to set d to (split horizontally with default profile)
      set end of panes to d
    end if
    repeat with i from 1 to count of argv
      tell item i of panes to write text "wt attach " & item i of argv
    end repeat
  end tell
end run`;

// panes fill top-left, top-right, bottom-left, bottom-right
export function cmdGrid() {
  if (process.platform !== 'darwin') die('grid needs iTerm2 on macOS');
  const sessions = names().filter((n) => sessAlive(n));
  if (!sessions.length) die('no worktree has a tmux session, run wt up');
  capture('osascript', ['-', ...sessions.slice(0, 4)], { input: GRID });
  return 0;
}
