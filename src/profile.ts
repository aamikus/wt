import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, HOME, PROFILES_DIR } from './env.ts';
import { generic } from './generic.ts';
import { get, names } from './state.ts';
import { canonical, type Wt } from './worktree.ts';
import { shq } from './util.ts';

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
  command?(w: Wt, ports: Ports): string | undefined | false;
  env?(ports: Ports): Record<string, string>;
}

// where a service listens, and where its clients reach it: the two differ for a service the
// slot proxy fronts
export interface Ports {
  listen(s: string): number;
  addr(s: string): number;
}

export interface Login {
  enabled(): boolean;
  run(w: Wt, device: string, tag: string, openUrl: (device: string, url: string) => boolean): Promise<boolean>;
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
  builderSetup: string[][];
  prebuild: { ios: string[]; android: string[] };
  metro: string;
  // services an emulator reaches through adb reverse
  reverse: string[];
  login?: Login;
}

export interface RepoProfile {
  name: string;
  // the main checkout; the generic profile has none
  repo?: string;
  // profiles beyond bare and code, each a list of services
  profiles: Record<string, string[]>;
  describe: string;
  services: Record<string, Service>;
  // turbo: per-task output from turbo's --log-file; pane: the dev window's output in dev.log
  logs: 'turbo' | 'pane';
  // a checkout on the default branch that runs the shared services
  base?: string;
  setup(w: Wt): Promise<number>;
  // a run's command, undefined when nothing runs, false when it cannot run. pkgs: for a turbo
  // repo, the packages whose dev task this run starts
  dev(w: Wt, services: string[], ports: Ports, pkgs: string[]): string | undefined | false;
  validate?(services: string[]): string | undefined;
  mobile?: Mobile;
}

export const BASE_PROFILES = ['bare', 'code'];

export const registry: RepoProfile[] = [];

export async function loadProfiles(dir = PROFILES_DIR) {
  if (!existsSync(dir)) return;
  for (const d of readdirSync(dir).sort()) {
    const f = join(dir, d, 'index.ts');
    if (existsSync(f)) registry.push((await import(f)).default as RepoProfile);
  }
}

export const profileFor = (repo: string, path = repo) => {
  const profile = registry.find((p) => p.repo === repo) ?? generic;
  return discoverApps(profile, path);
};

function discoverApps(profile: RepoProfile, path: string): RepoProfile {
  const dir = join(path, 'apps');
  if (profile.logs !== 'turbo' || !existsSync(dir)) return profile;
  const services: Record<string, Service> = { ...profile.services };
  const profiles = { ...profile.profiles };
  const state = names().find((n) => get(n, 'path') && canonical(get(n, 'path')) === canonical(path));
  const offsets: Record<string, number> = JSON.parse(state ? get(state, 'ports') || '{}' : '{}');
  for (const app of readdirSync(dir).sort()) {
    const manifest = join(dir, app, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; scripts?: { dev?: string } };
    if (!pkg.name || !pkg.scripts?.dev) continue;
    const existing = Object.entries(services).find(([, s]) => s.pkg === pkg.name)?.[0];
    const service = existing ?? app;
    const mobile = service === profile.mobile?.metro
      ? Object.values(profiles).find((p) => p.includes(service))?.filter((s) => !services[s]?.device)
      : undefined;
    profiles[app] ??= profiles[service] ?? mobile ?? [service];
    profiles[service] ??= profiles[app];
    const vite = /^vite\b/.test(pkg.scripts.dev) && !/^vite\s+build\b/.test(pkg.scripts.dev);
    const web = /^next\s+dev\b/.test(pkg.scripts.dev) || vite;
    if (existing && !web) continue;
    let offset: number | undefined;
    if (web) {
      offset = offsets[pkg.name] ?? Math.max(-1, ...Object.values(offsets)) + 1;
      offsets[pkg.name] = offset;
    }
    services[service] = {
      ...services[service],
      pkg: pkg.name,
      port: offset === undefined ? undefined : (slot) => 10000 + slot * 1000 + offset,
      portOffset: offset,
      fixed: false,
      reserves: web,
      command(_w, ports) {
        const port = web ? ports.listen(service) : undefined;
        const env = { ...(port === undefined ? {} : { PORT: String(port) }), ...services[service].env?.(ports) };
        const prefix = Object.entries(env).map(([k, v]) => `${k}=${shq(v)} `).join('');
        return `${prefix}exec pnpm --filter ${shq(pkg.name!)} dev${port === undefined ? '' : ` --port ${port}${vite ? ' --strictPort' : ''}`}`;
      },
    };
  }
  return {
    ...profile,
    profiles,
    services,
  };
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
