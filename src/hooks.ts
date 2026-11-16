import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORE, SELF, WT_HOME } from './env.ts';
import { summary } from './inspect.ts';
import { defaultRepo, profileFor } from './profile.ts';
import { get, touch } from './state.ts';
import { cmdDown } from './up.ts';
import { capture, die, out, stamp } from './util.ts';
import { resolve, worktreeAt, type Wt } from './worktree.ts';
import { idleMinutes } from './idle.ts';

const RULES =
  'wt owns dev servers, the simulator and the emulator in this worktree: never start them yourself, use `wt up <profile>`, `wt restart`, `wt logs <service>`, `wt ls`.';

const HOOKS_LOG = join(WT_HOME, 'hooks.log');

export function payload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function field(json: Record<string, unknown>, ...keys: string[]) {
  for (const k of keys) {
    const v = json[k];
    if (typeof v === 'string' && v) return v;
  }
}

export async function hookSessionStart(raw: string) {
  const cwd = field(payload(raw), 'cwd');
  const p = cwd && worktreeAt(cwd);
  if (!p) return 0;
  const n = p.name;
  // a worktree's first session installs it, so an agent never works in one without deps
  if (!get(n, 'profiles')) {
    capture(SELF, ['up', p.path]);
    if (get(n, 'profiles') === 'code') {
      const more = Object.keys(profileFor(p.repo, p.path).profiles).map((x) => `\`wt up ${x}\``);
      const add = `${more.slice(0, -1).join(', ')}${more.length > 1 ? ' or ' : ''}${more.at(-1)}`;
      out(`wt: installing dependencies in the background (\`wt logs up\`). profile code runs no dev servers; ${add} adds them.\n${RULES}\n`);
      return 0;
    }
  }
  if (get(n, 'asleep')) wake(p);
  const cur = get(n, 'profiles');
  if (!cur || cur === 'bare') return 0;
  const st = get(n, 'setup');
  if (st === 'running') out(`⏳ wt setup still running — \`wt logs ${n} up\`\n`);
  else if (st && st !== '0') out(`❌ wt setup failed with exit ${st} — \`wt logs ${n} up\`\n`);
  out(`wt: environment "${cur}": ${summary(n)}. ${RULES}\n`);
  return 0;
}

function wake(w: Wt) {
  capture(SELF, ['up', w.path]);
  out(`wt: this worktree's environment had stopped after ${idleMinutes()} idle minutes; it is restarting in the background (\`wt logs up\`).\n`);
}

// every prompt is activity; one in a worktree whose environment idled away wakes it
export function hookPrompt(raw: string) {
  const cwd = field(payload(raw), 'cwd');
  const w = cwd && worktreeAt(cwd);
  if (!w || !get(w.name, 'profiles')) return 0;
  touch(w.name);
  if (get(w.name, 'asleep')) wake(w);
  return 0;
}

export function hookRemove(raw: string) {
  appendFileSync(HOOKS_LOG, `${stamp()} ${raw.trim()}\n`);
  const json = payload(raw);
  const p = field(json, 'worktree_path', 'path', 'worktreePath');
  const n = field(json, 'worktree_name', 'name');
  const w = p ? worktreeAt(p) : n ? resolve(n) : undefined;
  if (!w || !existsSync(w.path)) return 0;
  // removal refuses uncommitted work and keeps an unmerged branch; pre-remove purges the environment
  const r = capture(CORE, ['remove', w.path, '--foreground'], { cwd: w.repo });
  appendFileSync(HOOKS_LOG, r.stdout + r.stderr);
  process.stderr.write(r.stderr);
  if (!r.code) return 0;
  cmdDown(w.name, true);
  return 1;
}

export function hookCreate(raw: string) {
  appendFileSync(HOOKS_LOG, `${stamp()} ${raw.trim()}\n`);
  const json = payload(raw);
  const n = field(json, 'name', 'worktree_name') ?? die('WorktreeCreate payload has no name');
  const repo = field(json, 'cwd') ?? defaultRepo();
  const git = (...a: string[]) => capture('git', a, { cwd: repo });
  // the remote's default branch, freshly fetched; without one wtcore picks the base
  const head = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const base = head.code ? 'origin/main' : head.stdout.trim();
  capture('git', ['fetch', '--quiet', 'origin', base.replace(/^origin\//, '')], { cwd: repo, stdio: ['ignore', 2, 2] });
  const create = git('show-ref', '--verify', '--quiet', `refs/heads/${n}`).code
    ? ['--create', n, ...(git('rev-parse', '--verify', '--quiet', base).code ? [] : ['--base', base])]
    : [n];
  // claude reads the new path as the only stdout line, so wtcore's progress stays on stderr
  const r = capture(CORE, ['switch', ...create, '--no-cd', '--format=json'], { cwd: repo, stdio: ['ignore', 'pipe', 2] });
  if (r.code) return 1;
  out(`${(JSON.parse(r.stdout) as { path: string }).path}\n`);
  return 0;
}
