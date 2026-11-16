import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config, HOME, REPOS_DIR } from './env.ts';
import { configRepo, devCommand, fromConfig, generic, isWeb, workspacePackages, type RepoConfig } from './config.ts';
import { get, names } from './state.ts';
import { canonical, knownRepos, type Wt } from './worktree.ts';
import { die } from './util.ts';

export interface Service {
  pkg?: string;
  port?: (slot: number) => number;
  // its port is part of every slot's reservation
  reserves?: boolean;
  // the same port in every slot
  fixed?: boolean;
  device?: 'sim' | 'emu';
  // the health path of a service the repo's base checkout can serve to every worktree that
  // has not changed it
  share?: string;
  // a stable offset inside the slot's app-server port block
  portOffset?: number;
  // takes a port from that block, having none of its own
  autoPort?: boolean;
  command?(w: Wt, ports: Ports): string | undefined | false;
  // the variables its process gets; writes the env files the service reads
  env?(w: Wt, ports: Ports): Record<string, string>;
  // a command run once per worktree before the service first starts
  setup?: string;
}

// where a service listens, and where its clients reach it: the two differ for a service the
// slot proxy fronts
export interface Ports {
  listen(s: string): number;
  addr(s: string): number;
}

// an expo dev client: built once per native fingerprint, run on a simulator and an emulator
export interface Mobile {
  appId: string;
  scheme: string;
  appDir: string;
  // the xcode workspace, scheme and product name
  iosApp: string;
  template: string;
  device: string;
  avdImage: string;
  avdDevice: string;
  cacheDir: string;
  builder: string;
  builderDerived: string;
  // commands the builder runs after mirroring a worktree, then the expo prebuild per platform
  builderSetup: string[];
  prebuild: { ios: string; android: string };
  metro: string;
  // services an emulator reaches through adb reverse
  reverse: string[];
  // a bash script that signs the app in on a new device, given the device as $1 and sim or emu as $2
  login?: string;
}

export interface RepoProfile {
  name: string;
  // the main checkout; the generic profile has none
  repo?: string;
  // profiles beyond bare and code, each a list of services
  profiles: Record<string, string[]>;
  services: Record<string, Service>;
  // turbo: per-task output from turbo's --log-file; pane: the dev window's output in dev.log
  logs: 'turbo' | 'pane';
  // a checkout on the default branch that runs the shared services
  base?: string;
  setup(w: Wt): Promise<number>;
  // a run's command, undefined when nothing runs, false when it cannot run. pkgs: for a turbo
  // repo, the packages whose dev task this run starts
  dev(w: Wt, services: string[], ports: Ports, pkgs: string[]): string | undefined | false;
  mobile?: Mobile;
}

export const BASE_PROFILES = ['bare', 'code'];

export const registry: RepoProfile[] = [];

// a repo's config is REPOS_DIR/<name>.toml; one for a repo this machine has no checkout of is skipped
export function loadProfiles(dir = REPOS_DIR, candidates = knownRepos()) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.toml')).sort()) {
    let cfg: RepoConfig;
    try {
      cfg = Bun.TOML.parse(readFileSync(join(dir, f), 'utf8')) as RepoConfig;
    } catch (e) {
      die(`${join(dir, f)}: ${(e as Error).message}`);
    }
    if (cfg.repo === undefined && cfg.remote === undefined) die(`${join(dir, f)}: set repo or remote`);
    const repo = configRepo(cfg, candidates);
    if (repo) registry.push(fromConfig(basename(f, '.toml'), cfg, dir, repo));
  }
}

export const profileFor = (repo: string, path = repo) => {
  const profile = registry.find((p) => p.repo === repo) ?? generic;
  return discoverApps(profile, path);
};

// the port-block offset key of a service
export const offsetKey = (name: string, s: Service) => s.pkg ?? `service:${name}`;

// adds the checkout's workspace packages that have a dev script as services, each in its own
// window; in a turbo repo a configured package without a web server joins the shared turbo run
// instead. a service without a port of its own that listens takes one from the slot's port block,
// at an offset kept stable per worktree
function discoverApps(profile: RepoProfile, path: string): RepoProfile {
  const services: Record<string, Service> = { ...profile.services };
  const profiles = { ...profile.profiles };
  const state = names().find((n) => get(n, 'path') && canonical(get(n, 'path')) === canonical(path));
  const offsets: Record<string, number> = JSON.parse(state ? get(state, 'ports') || '{}' : '{}');
  const blockPort = (name: string, s: Service): Service => {
    const offset = (offsets[offsetKey(name, s)] ??= Math.max(-1, ...Object.values(offsets)) + 1);
    return { ...s, port: (slot) => 10000 + slot * 1000 + offset, portOffset: offset, autoPort: false, reserves: true };
  };
  for (const pkg of workspacePackages(path)) {
    if (!pkg.dev) continue;
    const app = basename(pkg.dir);
    const existing = Object.entries(services).find(([, s]) => s.pkg === pkg.name)?.[0];
    const service = existing ?? app;
    const mobile = service === profile.mobile?.metro
      ? Object.values(profiles).find((p) => p.includes(service))?.filter((s) => !services[s]?.device)
      : undefined;
    profiles[app] ??= profiles[service] ?? mobile ?? [service];
    profiles[service] ??= profiles[app];
    const web = isWeb(pkg.dev);
    const own = services[service];
    if (own?.command || (own && !web && profile.logs === 'turbo')) continue;
    let s: Service = { ...own, pkg: pkg.name, autoPort: !own?.port && (web || !!own?.autoPort) };
    if (s.autoPort) s = blockPort(service, s);
    const listens = !!s.port;
    services[service] = {
      ...s,
      command: (w, ports) => {
        const port = listens ? ports.listen(service) : undefined;
        // a configured service's env carries its port itself
        const env = s.env ? s.env(w, ports) : port === undefined ? {} : { PORT: String(port) };
        return devCommand(path, pkg.dir, pkg.dev!, env, port);
      },
    };
  }
  for (const [name, s] of Object.entries(services)) if (s.autoPort) services[name] = blockPort(name, s);
  return { ...profile, profiles, services };
}

// the configured repository used outside any checkout
export const defaultRepo = () => process.env.WT_REPO || config.WT_REPO || registry[0]?.repo || HOME;

export const profileNames = (rp: RepoProfile) => [...BASE_PROFILES, ...Object.keys(rp.profiles)];

export const allProfiles = () => [...registry.map((p) => p.repo ? discoverApps(p, p.repo) : p), generic];

// services that run in the dev window, devices aside
export const allServiceNames = () => [
  ...new Set(allProfiles().flatMap((p) => Object.entries(p.services).filter(([, s]) => !s.device).map(([k]) => k))),
];

export function servicesOf(rp: RepoProfile, profiles: string) {
  const out: string[] = [];
  for (const p of profiles.split(' ')) for (const s of rp.profiles[p] ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

// union of the current profiles and new ones; bare only survives on its own
export function mergedProfiles(current: string, add: string[]) {
  const out: string[] = [];
  for (const p of [...current.split(' '), ...add]) if (p && p !== 'bare' && !out.includes(p)) out.push(p);
  return out.join(' ') || 'bare';
}

export const portOf = (rp: RepoProfile, s: string, slot: number) => rp.services[s]?.port?.(slot);

export const appWindow = (service: string) => `app-${service}`;

// an instance behind the proxy listens this far above the port its clients use; the base
// checkout takes slot 0's
export const OWN = 1000;

export const shareable = (rp: RepoProfile, services: string[]) =>
  rp.base ? services.filter((s) => rp.services[s]?.share) : [];

export function worktreePorts(rp: RepoProfile, slot: number): Ports {
  const addr = (s: string) => rp.services[s]!.port!(slot);
  return { addr, listen: (s) => (rp.base && rp.services[s]?.share ? addr(s) + OWN : addr(s)) };
}

export function basePorts(rp: RepoProfile): Ports {
  const p = (s: string) => rp.services[s]!.port!(0) + OWN;
  return { addr: p, listen: p };
}

// the ports slot k reserves across every repo
export function slotPorts(k: number) {
  const profiles = allProfiles();
  const ports = profiles.flatMap((p) =>
    Object.values(p.services)
      .filter((s) => s.reserves && s.port)
      .flatMap((s) => (p.base && s.share ? [s.port!(k), s.port!(k) + OWN] : [s.port!(k)])),
  );
  if (profiles.some((p) => Object.values(p.services).some((s) => s.portOffset !== undefined))) {
    ports.push(...Array.from({ length: 1000 }, (_, offset) => 10000 + k * 1000 + offset));
  }
  return [...new Set(ports)];
}
