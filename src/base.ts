import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WT_HOME } from './env.ts';
import { basePorts, shareable, type RepoProfile } from './profile.ts';
import { startRun } from './runs.ts';
import { del, get, lock, names, put, unlock } from './state.ts';
import { sessAlive, tmux, winState } from './tmux.ts';
import { alive, capture, exec, lines, run, say, trash } from './util.ts';
import type { Wt } from './worktree.ts';

export const baseSession = (rp: RepoProfile) => `wt-base-${rp.name}`;
// a dot dir stays out of names(), so clean never takes the base for a worktree that is gone
export const baseState = (rp: RepoProfile) => `.base-${rp.name}`;
export const baseWt = (rp: RepoProfile): Wt => ({ repo: rp.repo!, name: baseSession(rp), path: rp.base! });

// the default branch, as origin/<name>
export const defaultRef = (repo: string) =>
  capture('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo }).stdout.trim() || 'origin/main';

const MANIFEST = /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json)$/;

// brings the base checkout to a commit that contains mb, the merge-base of a worktree it will
// serve, and starts its run. it moves only forward, to the default branch, so it is never
// older than the code calling it. false when it cannot serve that worktree
export async function ensureBase(rp: RepoProfile, mb: string) {
  const b = baseWt(rp);
  const st = baseState(rp);
  const ref = defaultRef(rp.repo!);
  const l = join(WT_HOME, st, 'state');
  // a first setup takes minutes, and every sharer waits on it
  await lock(l, 3600);
  try {
    // a base pruned as a merged worktree leaves behind what its run kept writing
    if (existsSync(b.path) && !existsSync(join(b.path, '.git'))) {
      say(`base: ${b.path} is no longer a git worktree, recreating it`);
      trash([b.path]);
    }
    if (!existsSync(b.path)) {
      say(`base: creating ${b.path} at ${ref}`);
      if (await run('git', ['worktree', 'add', '-q', '--detach', b.path, ref], { cwd: rp.repo })) return false;
      del(st, 'setup');
    }
    // locked, so clean never prunes it as a merged worktree
    capture('git', ['worktree', 'lock', '--reason', 'wt base checkout', b.path], { cwd: rp.repo });
    if ((await exec('git', ['merge-base', '--is-ancestor', mb, 'HEAD'], { cwd: b.path })).code) {
      const changed = lines((await exec('git', ['diff', '--name-only', 'HEAD', ref], { cwd: b.path })).stdout);
      const reinstall = changed.some((f) => MANIFEST.test(f));
      say(`base: moving to ${ref}${reinstall ? ', dependencies changed' : ''}`);
      if (reinstall) del(st, 'setup');
      if (await run('git', ['checkout', '-q', '--detach', ref], { cwd: b.path })) return false;
      if ((await exec('git', ['merge-base', '--is-ancestor', mb, 'HEAD'], { cwd: b.path })).code) return false;
    }
    if (get(st, 'setup') !== '0') {
      if (winState(b.name, 'dev') !== 'none') tmux('kill-window', '-t', `=${b.name}:dev`);
      put(st, 'setup', 'running');
      const rc = await rp.setup(b);
      put(st, 'setup', rc);
      if (rc) {
        say(`base: setup failed with exit ${rc}`);
        return false;
      }
    }
    if (winState(b.name, 'dev') === 'alive') return true;
    return await startRun(b, st, rp, 'dev', shareable(rp, Object.keys(rp.services)), basePorts(rp), []);
  } finally {
    unlock(l);
  }
}

// stops the base run once no worktree shares it
export function baseSync(rp: RepoProfile) {
  if (!rp.base || !sessAlive(baseSession(rp))) return;
  const sharing = names().some((n) => {
    const pid = Number(get(n, 'share.pid'));
    return get(n, 'repo') === rp.repo && get(n, 'shares') && pid > 0 && alive(pid);
  });
  if (sharing) return;
  tmux('kill-session', '-t', `=${baseSession(rp)}`);
  del(baseState(rp), 'dev.cmd', 'run.dev');
  say('base: stopped, no worktree shares it');
}
