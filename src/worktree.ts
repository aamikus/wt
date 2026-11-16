import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as absolute } from 'node:path';
import { WT_HOME } from './env.ts';
import { registry } from './profile.ts';
import { get, names } from './state.ts';
import { capture, die, lines } from './util.ts';

export interface Wt {
  repo: string;
  name: string;
  path: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  locked?: string;
  prunable?: string;
}

export const canonical = (p: string) => existsSync(p) ? realpathSync(p) : absolute(p);

function gitWorktrees(cwd: string) {
  const r = capture('git', ['worktree', 'list', '--porcelain', '-z'], { cwd });
  if (r.code) return [];
  return r.stdout.split('\0\0').filter(Boolean).map((block) => {
    const fields = block.split('\0');
    const field = (key: string) => fields.find((f) => f.startsWith(`${key} `))?.slice(key.length + 1);
    const flag = (key: string) => fields.includes(key) ? '' : field(key);
    return {
      path: canonical(field('worktree')!),
      branch: field('branch')?.replace(/^refs\/heads\//, ''),
      head: field('HEAD'),
      detached: fields.includes('detached'),
      locked: flag('locked'),
      prunable: flag('prunable'),
    };
  });
}

// the main checkout or bare repository owning a directory
export function repoHere(cwd = process.cwd()) {
  return gitWorktrees(cwd)[0]?.path;
}

export const wtPath = (repo: string, name: string) => join(repo, '.claude/worktrees', name);

// the linked worktree containing a path, wherever it lives
export function worktreeAt(p: string): Wt | undefined {
  if (!existsSync(p)) return;
  const cwd = canonical(statSync(p).isDirectory() ? p : dirname(p));
  const repo = repoHere(cwd);
  if (!repo) return;
  return worktreesOf(repo)
    .filter((w) => cwd === w.path || cwd.startsWith(`${w.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

// the linked worktree containing a path or, outside any, the main checkout
export function checkoutAt(p: string): Wt | undefined {
  const w = worktreeAt(p);
  if (w || !existsSync(p)) return w;
  const cwd = canonical(statSync(p).isDirectory() ? p : dirname(p));
  const main = gitWorktrees(cwd)[0];
  if (main && (cwd === main.path || cwd.startsWith(`${main.path}/`))) {
    return { repo: main.path, name: basename(main.path).replace(/[^a-zA-Z0-9_-]/g, '-'), ...main };
  }
}

// git lists the main checkout first; a profile's base checkout and dev-client builder are wt's
// own, not the user's
export function worktreesOf(repo: string): Wt[] {
  const own = registry.flatMap((p) => [p.base, p.mobile?.builder]).filter((b): b is string => !!b).map(canonical);
  const entries = gitWorktrees(repo).slice(1).filter((e) => !own.includes(e.path));
  const saved = names().map((name) => ({ name, repo: get(name, 'repo'), path: get(name, 'path') }));
  // a directory named after the repo, as codex lays worktrees out, takes its parent's name
  const dirName = (p: string) => (basename(p) === basename(repo) ? basename(dirname(p)) : basename(p)).replace(/[^a-zA-Z0-9_-]/g, '-');
  return entries.map((entry) => {
    const existing = saved.find((s) => s.repo === repo && s.path && canonical(s.path) === entry.path);
    const base = dirName(entry.path);
    const collision = entries.filter((w) => dirName(w.path) === base).length > 1
      || saved.some((s) => s.name === base && (s.repo !== repo || !s.path || canonical(s.path) !== entry.path));
    const name = existing?.name ?? (collision ? `${base}-${createHash('sha256').update(entry.path).digest('hex').slice(0, 8)}` : base);
    return { repo, name, ...entry };
  });
}

const REPOS = join(WT_HOME, 'repos');

const listedRepos = () => (existsSync(REPOS) ? lines(readFileSync(REPOS, 'utf8')) : []);

export function registerRepo(repo: string) {
  if (!listedRepos().includes(repo)) appendFileSync(REPOS, `${repo}\n`);
}

// every repo wt has run in, has a profile for, or keeps an environment of
export function knownRepos() {
  const all = [...registry.map((p) => p.repo), ...listedRepos(), ...names().map((n) => get(n, 'repo'))];
  return [...new Set(all)].filter((r): r is string => !!r && existsSync(r));
}

// a worktree from its name, a path inside it, or the current directory
export function findWorktree(a?: string, cwd = process.cwd()): Wt | undefined {
  const arg = a || cwd;
  if (!a || isAbsolute(arg) || arg.startsWith('./') || arg.startsWith('../')) return checkoutAt(absolute(cwd, arg));
  const repo = names().includes(arg) ? get(arg, 'repo') : '';
  if (repo) return { repo, name: arg, path: get(arg, 'path') || wtPath(repo, arg) };
  const here = repoHere(cwd);
  const repos = [...new Set([here, ...knownRepos()])].filter((r): r is string => !!r);
  for (const r of repos) {
    const matches = worktreesOf(r).filter((w) => w.name === arg || w.branch === arg || basename(w.path) === arg);
    if (matches.length > 1) die(`ambiguous worktree ${arg}: ${matches.map((w) => w.path).join(', ')}`);
    if (matches[0]) return matches[0];
  }
  if (existsSync(absolute(cwd, arg))) return checkoutAt(absolute(cwd, arg));
}

export function resolve(a?: string, cwd = process.cwd()): Wt {
  return findWorktree(a, cwd) ?? die(a ? `unknown worktree: ${a}` : 'not inside a git checkout, pass a name');
}
