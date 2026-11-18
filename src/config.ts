// a repo's wt config, from REPOS_DIR/<name>.toml, as a RepoProfile; with no config a repo runs
// the generic one
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { HOME } from './env.ts';
import { managed, writeEnv } from './envfiles.ts';
import type { Mobile, Ports, RepoProfile, Service } from './profile.ts';
import { capture, lines, run, say, shq } from './util.ts';
import type { Wt } from './worktree.ts';

interface ServiceConfig {
  package?: string;
  dir?: string;
  port?: number;
  fixed?: boolean;
  health?: string;
  command?: string;
  env?: Record<string, string>;
  files?: Record<string, Record<string, string>>;
  setup?: string;
  device?: 'sim' | 'emu';
}

type MobileConfig = Omit<Mobile, 'template' | 'cacheDir' | 'builder' | 'builderDerived' | 'builderSetup' | 'reverse'> &
  Partial<Pick<Mobile, 'template' | 'builderSetup' | 'reverse'>> & { cache?: string; builder?: string; derived?: string };

export interface RepoConfig {
  // the main checkout's path, or its origin remote such as owner/name, matched wherever it is cloned
  repo?: string;
  remote?: string;
  base?: boolean | string;
  copy?: string[];
  install?: boolean;
  setup?: string[];
  profiles?: Record<string, string[]>;
  services?: Record<string, ServiceConfig>;
  mobile?: MobileConfig;
}

const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export const packageManager = (dir: string) => LOCKFILES.find(([f]) => existsSync(join(dir, f)))?.[1];

const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

export const isVite = (script: string) => /^vite\b/.test(script) && !/^vite\s+build\b/.test(script);
export const isWeb = (script: string) => isVite(script) || /^next\s+dev\b/.test(script);

// host/owner/name from any form of a git remote url
export const remoteId = (url: string) =>
  url.trim().replace(/\.git$/, '').replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(':', '/');

// the checkout a config is for: its repo path, or the first candidate whose origin matches its remote
export function configRepo(c: RepoConfig, candidates: string[]) {
  if (c.repo !== undefined) return real(expand(c.repo));
  const want = c.remote?.replace(/\.git$/, '');
  if (!want) return;
  return candidates.find((r) => {
    const id = remoteId(capture('git', ['-C', r, 'remote', 'get-url', 'origin']).stdout);
    return id === want || id.endsWith(`/${want}`);
  });
}

// the workspace packages under root: the pnpm, npm, yarn or bun workspace globs, else apps/*
export function workspacePackages(root: string) {
  if (!existsSync(root)) return [];
  let globs: string[] | undefined;
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    globs = (Bun.YAML.parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: string[] })?.packages;
  } else if (existsSync(join(root, 'package.json'))) {
    const ws = readJson(join(root, 'package.json')).workspaces;
    globs = Array.isArray(ws) ? ws : ws?.packages;
  }
  const dirs = new Set<string>();
  for (const g of (globs ?? ['apps/*']).filter((g) => !g.startsWith('!'))) {
    for (const f of new Bun.Glob(`${g.replace(/\/$/, '')}/package.json`).scanSync({ cwd: root })) {
      if (!f.includes('node_modules/')) dirs.add(dirname(f));
    }
  }
  return [...dirs].sort().map((dir) => {
    const pkg = readJson(join(root, dir, 'package.json')) as { name?: string; scripts?: { dev?: string } };
    return { dir, name: pkg.name ?? basename(dir), dev: pkg.scripts?.dev };
  });
}

// the package manager's dev script in dir, with env and, for a web server, its port
export function devCommand(root: string, dir: string, script: string, env: Record<string, string>, port?: number) {
  const pm = packageManager(root) ?? 'npm';
  const flags = port !== undefined && isWeb(script) ? `${pm === 'npm' ? ' --' : ''} --port ${port}${isVite(script) ? ' --strictPort' : ''}` : '';
  const prefix = Object.entries(env).map(([k, v]) => `${k}=${shq(v)} `).join('');
  return `cd ${shq(dir)} && ${prefix}exec ${pm} run dev${flags}`;
}

// {port} is the service's own port, {<service>.port} and {<service>.url} where another one is
// reached, {config} the directory of the repo's config
function fill(s: string, self: string, ports: Ports | undefined, configDir: string) {
  return s.replace(/\{([\w-]+)(?:\.(port|url))?\}/g, (m, name: string, part?: string) => {
    if (name === 'config' && !part) return configDir;
    if (!ports) return m;
    if (name === 'port' && !part) return String(ports.listen(self));
    if (part === 'port') return String(ports.addr(name));
    if (part === 'url') return `http://localhost:${ports.addr(name)}`;
    return m;
  });
}

function service(name: string, c: ServiceConfig, configDir: string): Service {
  const own = (o?: Record<string, string>) => Object.values(o ?? {}).some((v) => v.includes('{port}'));
  // a port no variable or file names reaches the process as PORT
  const env = c.port !== undefined || !c.device ? { ...(own(c.env) || Object.values(c.files ?? {}).some(own) ? {} : { PORT: '{port}' }), ...c.env } : c.env;
  const fillAll = (o: Record<string, string>, ports: Ports) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v, name, ports, configDir)]));
  const s: Service = {
    pkg: c.package,
    port: c.port === undefined ? undefined : c.fixed ? () => c.port! : (k) => c.port! + k,
    autoPort: c.port === undefined && !c.device,
    reserves: c.port !== undefined,
    fixed: c.fixed,
    share: c.health,
    device: c.device,
    setup: c.setup && fill(c.setup, name, undefined, configDir),
    command: c.command
      ? (w, ports) => `${Object.entries(s.env!(w, ports)).map(([k, v]) => `export ${k}=${shq(v)}; `).join('')}${fill(c.command!, name, ports, configDir)}`
      : c.dir === undefined ? undefined : (w, ports) => {
      const manifest = join(w.path, c.dir!, 'package.json');
      const script: string | undefined = existsSync(manifest) ? readJson(manifest).scripts?.dev : undefined;
      if (!script) {
        say(`${name}: ${join(c.dir!, 'package.json')} has no dev script`);
        return false;
      }
      return devCommand(w.path, c.dir!, script, s.env!(w, ports), s.port && ports.listen(name));
    },
    env(w, ports) {
      for (const [file, vars] of Object.entries(c.files ?? {})) writeEnv(w.path, file, fillAll(vars, ports));
      return fillAll(env ?? {}, ports);
    },
  };
  return s;
}

// a .env-like gitignored file or directory of the main checkout matching a copy glob; a file wt
// manages holds the main checkout's ports and is written afresh by the worktree's own services
function copyIgnored(w: Wt, globs: string[]) {
  // --directory keeps git from walking ignored trees like node_modules
  const ignored = lines(capture('git', ['-C', w.repo, 'ls-files', '-oi', '--exclude-standard', '--directory']).stdout);
  const matchers = globs.map((g) => new Bun.Glob(g));
  for (const f of ignored.map((f) => f.replace(/\/$/, ''))) {
    if (!matchers.some((m) => m.match(f)) || existsSync(join(w.path, f))) continue;
    const dir = statSync(join(w.repo, f)).isDirectory();
    if (!dir && managed(join(w.repo, f))) continue;
    mkdirSync(dirname(join(w.path, f)), { recursive: true });
    if (dir) cpSync(join(w.repo, f), join(w.path, f), { recursive: true });
    else copyFileSync(join(w.repo, f), join(w.path, f));
    say(`setup: copied ${f}`);
  }
}

export function fromConfig(name: string, c: RepoConfig, configDir: string, repo?: string): RepoProfile {
  const turbo = !!repo && ['turbo.json', 'turbo.jsonc'].some((f) => existsSync(join(repo, f)));
  const services = Object.fromEntries(Object.entries(c.services ?? {}).map(([k, s]) => [k, service(k, s, configDir)]));
  const m = c.mobile;
  return {
    name,
    repo,
    // each service is a profile of its own, too
    profiles: { ...Object.fromEntries(Object.entries(c.services ?? {}).filter(([, s]) => !s.device).map(([k]) => [k, [k]])), ...c.profiles },
    services,
    logs: turbo ? 'turbo' : 'pane',
    base: c.base === true ? join(repo!, '.claude/worktrees/.wt-base') : typeof c.base === 'string' ? expand(c.base) : undefined,

    async setup(w) {
      copyIgnored(w, c.copy ?? ['**/.env*']);
      const pm = packageManager(w.path);
      if (c.install !== false && pm) {
        say(`setup: ${pm} install`);
        const rc = await run(pm, ['install'], { cwd: w.path });
        if (rc) return rc;
      }
      for (const cmd of c.setup ?? []) {
        say(`setup: ${cmd}`);
        const rc = await run('bash', ['-c', fill(cmd, '', undefined, configDir)], { cwd: w.path });
        if (rc) return rc;
      }
      return 0;
    },

    // a turbo repo's services without a window of their own share one turbo run over their packages
    dev(w, svcs, ports, pkgs) {
      if (!turbo || !pkgs.length) return;
      const env = Object.assign({}, ...svcs.map((s) => services[s]?.env?.(w, ports) ?? {})) as Record<string, string>;
      const prefix = Object.entries(env).map(([k, v]) => `${k}=${shq(v)} `).join('');
      // every dev task is persistent and turbo refuses a concurrency at or below their count
      return `${prefix}exec ./node_modules/.bin/turbo run dev ${pkgs.map((p) => `-F ${shq(p)}`).join(' ')} --concurrency=64 --ui=tui --log-file`;
    },

    mobile: m && {
      ...m,
      template: m.template ?? 'wt-template',
      cacheDir: expand(m.cache ?? join(HOME, '.cache/wt/dev-clients', name)),
      builder: expand(m.builder ?? join(repo!, '.claude/worktrees/.wt-builder')),
      builderDerived: expand(m.derived ?? join(HOME, 'Library/Developer/Xcode/DerivedData', `wt-builder-${name}`)),
      builderSetup: m.builderSetup ?? [`${packageManager(repo!) ?? 'npm'} install`],
      reverse: m.reverse ?? [],
      login: m.login && fill(m.login, '', undefined, configDir),
    },
  };
}

// any repo without a config: its .env files, its install and its root dev script
export const generic = fromConfig('generic', { services: { dev: { dir: '.', port: 3000 } }, profiles: { dev: ['dev'] } }, '');
