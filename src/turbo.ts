import { join } from 'node:path';
import { exec, lines, run } from './util.ts';

const bin = (dir: string) => join(dir, 'node_modules/.bin/turbo');

export async function buildDependencies(dir: string, roots: string[]) {
  if (!roots.length) return true;
  return (await run(bin(dir), ['run', 'build', ...roots.flatMap((p) => ['-F', `${p}^...`]), '--concurrency=64'], { cwd: dir })) === 0;
}

async function turboJson<T>(dir: string, args: string[]): Promise<T | undefined> {
  const r = await exec(bin(dir), args, { cwd: dir });
  if (r.code) return;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return;
  }
}

// the packages whose dev task a run over these roots and their dependencies starts
export async function devPackages(dir: string, roots: string[]) {
  if (!roots.length) return [];
  const plan = await turboJson<{ tasks: { task: string; package: string }[] }>(dir, [
    'run',
    'dev',
    ...roots.flatMap((p) => ['-F', `${p}...`]),
    '--dry=json',
  ]);
  return plan?.tasks.filter((t) => t.task === 'dev').map((t) => t.package);
}

export interface Pkg {
  name: string;
  path: string;
}

const LOCKFILE = /^(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/;
// root files every package runs with
const GLOBAL = /^(package\.json|pnpm-workspace\.yaml|turbo\.jsonc?)$/;

// the packages these changed files belong to, or 'all'. the lockfile marks nothing: it moves
// with the manifest that marks its own package, and a base runs on its own install. other
// files outside every package, like docs or ci config, do not reach a running server
export function touched(files: string[], pkgs: Pkg[]): string[] | 'all' {
  const deepest = [...pkgs].sort((a, b) => b.path.length - a.path.length);
  const out = new Set<string>();
  for (const f of files) {
    if (LOCKFILE.test(f)) continue;
    const p = deepest.find((p) => f.startsWith(`${p.path}/`));
    if (p) out.add(p.name);
    else if (GLOBAL.test(f)) return 'all';
  }
  return [...out];
}

// every package changed since ref, committed or not, and every package that depends on one
export async function affected(dir: string, ref: string) {
  const [diff, untracked, ls] = await Promise.all([
    exec('git', ['diff', '--name-only', '--no-renames', ref], { cwd: dir }),
    exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir }),
    turboJson<{ packages: { items: Pkg[] } }>(dir, ['ls', '--output=json']),
  ]);
  if (diff.code || untracked.code || !ls) return;
  const pkgs = ls.packages.items;
  const hit = touched([...lines(diff.stdout), ...lines(untracked.stdout)], pkgs);
  if (hit === 'all') return pkgs.map((p) => p.name);
  if (!hit.length) return [];
  const deps = await turboJson<{ packages: { items: Pkg[] } }>(dir, ['ls', ...hit.map((n) => `--filter=...${n}`), '--output=json']);
  return deps?.packages.items.map((p) => p.name);
}
