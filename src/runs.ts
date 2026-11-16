import { join } from 'node:path';
import { WT_HOME } from './env.ts';
import { appWindow, type Ports, type RepoProfile } from './profile.ts';
import { del, get, put } from './state.ts';
import { newWindow, tmux, winState } from './tmux.ts';
import { devPackages } from './turbo.ts';
import { say, shq } from './util.ts';
import type { Wt } from './worktree.ts';

// tmux starts a window from its server's environment, not this process's; PATH carries the
// caller's node and package managers into shells whose profile does not set them up
export const fwdEnv = () =>
  Object.entries(process.env)
    .filter(([k]) => k === 'PATH' || k === 'APP_ENV' || (k.startsWith('WT_') && k !== 'WT_SELF' && k !== 'WT_LOGIN'))
    .map(([k, v]) => ` ${k}=${shq(v ?? '')}`)
    .join('');

export const words = (s: string) => s.split(' ').filter(Boolean);

// a run of some services in its own window of session w.name, with its state under st. in a
// turbo repo it starts the dev task of every package its services need, except the roots of
// other services and packages another live run in the checkout already watches. the window
// starts on a placeholder so remain-on-exit holds a crashed run on screen
export async function startRun(w: Wt, st: string, rp: RepoProfile, win: string, services: string[], ports: Ports, runs: string[]) {
  let pkgs: string[] = [];
  const roots = services.map((s) => rp.services[s]?.pkg).filter((p): p is string => !!p);
  const app = services.length === 1 && win === appWindow(services[0]) ? rp.services[services[0]] : undefined;
  if (app?.command) pkgs = roots;
  else if (rp.logs === 'turbo' && roots.length) {
    const all = await devPackages(w.path, roots);
    if (!all) {
      say(`${win}: turbo could not plan the run`);
      return false;
    }
    const elsewhere = Object.entries(rp.services)
      .filter(([s, v]) => v.pkg && !services.includes(s))
      .map(([, v]) => v.pkg);
    const taken = runs.filter((r) => r !== win && winState(w.name, r) === 'alive').flatMap((r) => words(get(st, `run.${r}`)));
    const separate = services.filter((s) => rp.services[s]?.command).map((s) => rp.services[s]?.pkg);
    pkgs = all.filter((p) => !elsewhere.includes(p) && !taken.includes(p) && !separate.includes(p));
  }
  const cmd = app?.command ? app.command(w, ports) : rp.dev(w, services.filter((s) => !rp.services[s]?.command), ports, pkgs);
  const t = `=${w.name}:${win}`;
  const state = winState(w.name, win);
  if (!cmd) {
    if (cmd === undefined && state !== 'none') {
      tmux('kill-window', '-t', t);
      del(st, `${win}.cmd`, `run.${win}`);
    }
    return cmd !== false;
  }
  if (state === 'alive' && get(st, `${win}.cmd`) === cmd) {
    say(`${win}: already running`);
    return true;
  }
  if (state === 'none') {
    newWindow(w, win, 'sleep 86400');
    tmux('set-option', '-w', '-t', t, 'remain-on-exit', 'on');
  }
  if (rp.logs === 'pane' || app?.command) tmux('pipe-pane', '-o', '-t', t, `cat >>${shq(join(WT_HOME, st, `${win}.log`))}`);
  put(st, `${win}.cmd`, cmd);
  put(st, `run.${win}`, pkgs.join(' '));
  tmux('respawn-pane', '-k', '-t', t, `env${fwdEnv()} bash -lc ${shq(cmd)}`);
  say(`${win}: ${cmd}`);
  return true;
}
