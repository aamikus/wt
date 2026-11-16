// an environment nobody uses for idle minutes stops (wt down), marked asleep; the next prompt
// or session start in its worktree wakes it with wt up
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, HOME, SELF } from './env.ts';
import { bundledCount, emuSerial, simDevices, simState } from './devices.ts';
import { AGENTS, profileDirs, readProcs, readSessions, sessionDirs, under } from './procs.ts';
import { profileFor, type RepoProfile } from './profile.ts';
import { get, put, runningUp } from './state.ts';
import { attached, newWindow, winState } from './tmux.ts';
import { capture, detach, lines, now, say, shq, sleep } from './util.ts';
import { resolve, type Wt } from './worktree.ts';
import { fwdEnv } from './runs.ts';

export const idleMinutes = () => Number(process.env.WT_IDLE_MINUTES ?? config.WT_IDLE_MINUTES ?? 240);

// apps whose frontmost window shows a simulator or an emulator
const DEVICE_APPS = ['Simulator', 'qemu-system-aarch64'];
// keyboard or mouse input this recent counts while a device app is frontmost
const INPUT_S = 120;
// cpu an agent process burns per sample while it works, for agents without a session file;
// an idle claude session stays under it
const AGENT_CPU_S = 3;

export interface Probe {
  bundled: number;
  // the newest a claude session in the worktree did something or was looked at
  sessionAt: number;
  agentCpu: number;
  // the user has the session open or is interacting with one of this worktree's devices
  focused: boolean;
}

// records a sample and says whether the worktree has gone limitS without activity
export function tick(n: string, p: Probe, t = now(), limitS = idleMinutes() * 60) {
  const lastCpu = Number(get(n, 'idle.cpu') || p.agentCpu);
  const busy =
    runningUp(n) ||
    p.focused ||
    p.bundled > Number(get(n, 'idle.bundled') || 0) ||
    p.sessionAt > Number(get(n, 'idle.session') || 0) ||
    p.agentCpu - lastCpu >= AGENT_CPU_S;
  put(n, 'idle.bundled', p.bundled);
  put(n, 'idle.session', p.sessionAt);
  put(n, 'idle.cpu', p.agentCpu);
  if (busy || !get(n, 'active')) put(n, 'active', t);
  return t - Number(get(n, 'active')) >= limitS;
}

// ps prints cpu time as [[hh:]mm:]ss.ss
const seconds = (s: string) => s.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);

function agentCpu(dir: string) {
  const pids = readProcs()
    .filter((p) => AGENTS.includes(p.cmd) && under(p.cwd, dir))
    .map((p) => p.pid);
  if (!pids.length) return 0;
  return lines(capture('ps', ['-o', 'time=', '-p', pids.join(',')]).stdout).reduce((s, l) => s + seconds(l.trim()), 0);
}

// desktop sessions of every app profile say when they last acted or were focused; a cli
// session's transcript sits under its starting directory, so only one started in the worktree is found
export function sessionAt(dir: string, home = HOME) {
  // one profile's unreadable file must not hide the other profiles' sessions
  const desk = sessionDirs(home)
    .flatMap((d) => readSessions([d]) ?? [])
    .filter((s) => under(s.cwd, dir) || s.folders.some((f) => under(f, dir)))
    .map((s) => s.active);
  const cli = profileDirs(home, '.claude', join('projects', dir.replace(/[^A-Za-z0-9]/g, '-'))).flatMap((t) =>
    readdirSync(t, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => statSync(join(t, f)).mtimeMs / 1000),
  );
  return Math.floor(Math.max(0, ...desk, ...cli));
}

function userOnDevice(n: string) {
  const front = capture('lsappinfo', ['info', '-only', 'name', capture('lsappinfo', ['front']).stdout.trim()]).stdout;
  if (!DEVICE_APPS.some((a) => front.includes(`"${a}"`))) return false;
  const idle = /"HIDIdleTime" = (\d+)/.exec(capture('ioreg', ['-c', 'IOHIDSystem', '-d', '4']).stdout)?.[1];
  if (!idle || Number(idle) / 1e9 >= INPUT_S) return false;
  const u = get(n, 'sim');
  return (!!u && simState(u, simDevices()) === 'Booted') || (!!get(n, 'emu') && !!emuSerial(n));
}

function probe(w: Wt, rp: RepoProfile): Probe {
  return {
    bundled: rp.mobile ? bundledCount(w, rp) : 0,
    sessionAt: sessionAt(w.path),
    agentCpu: agentCpu(w.path),
    focused: attached(w.name) || userOnDevice(w.name),
  };
}

// the watcher window, once per tmux session
export function startWatcher(w: Wt) {
  if (idleMinutes() <= 0 || winState(w.name, 'idle') !== 'none') return;
  newWindow(w, 'idle', `env${fwdEnv()} ${shq(SELF)} _idle ${shq(w.name)}`);
}

export async function cmdIdle(name: string) {
  const w = resolve(name);
  const rp = profileFor(w.repo, w.path);
  for (;;) {
    await sleep(60_000);
    if (!tick(w.name, probe(w, rp))) continue;
    put(w.name, 'asleep', now());
    say(`idle: nothing used ${w.name} for ${idleMinutes()} min, stopping it`);
    // down kills this window's session, so it runs outside it
    detach(SELF, ['down', w.name]);
    return 0;
  }
}
