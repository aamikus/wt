import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepoProfile } from './profile.ts';
import { capture, lines, run, say, shq } from './util.ts';
import type { Wt } from './worktree.ts';

const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export const packageManager = (dir: string) => LOCKFILES.find(([f]) => existsSync(join(dir, f)))?.[1];

// any repo without a profile of its own: its .env files and its dev script
export const generic: RepoProfile = {
  name: 'generic',
  profiles: { dev: ['dev'] },
  describe: 'bare, code (.env files from the main checkout, then install),\ndev (code, then the dev script with PORT set, and APP_ENV when wt up gets one)',
  services: { dev: { port: (k) => 3000 + k, reserves: true } },
  logs: 'pane',

  // a worktree lacks the main checkout's gitignored .env files; --directory keeps git from
  // walking ignored trees like node_modules
  async setup(w: Wt) {
    const ignored = lines(capture('git', ['-C', w.repo, 'ls-files', '-oi', '--exclude-standard', '--directory']).stdout);
    for (const f of ignored.filter((f) => /(^|\/)\.env[^/]*$/.test(f))) {
      if (existsSync(join(w.path, f))) continue;
      mkdirSync(dirname(join(w.path, f)), { recursive: true });
      copyFileSync(join(w.repo, f), join(w.path, f));
      say(`setup: copied ${f}`);
    }
    const pm = packageManager(w.path);
    if (!pm) {
      say('setup: no lockfile, nothing to install');
      return 0;
    }
    say(`setup: ${pm} install`);
    return run(pm, ['install'], { cwd: w.path });
  },

  dev(w, services, ports) {
    if (!services.includes('dev')) return;
    const pm = packageManager(w.path);
    if (!pm) {
      say('dev: no lockfile, so no dev script to run');
      return false;
    }
    if (!JSON.parse(readFileSync(join(w.path, 'package.json'), 'utf8')).scripts?.dev) {
      say('dev: package.json has no dev script');
      return false;
    }
    const appEnv = process.env.APP_ENV ? ` APP_ENV=${shq(process.env.APP_ENV)}` : '';
    return `PORT=${ports.listen('dev')}${appEnv} exec ${pm} run dev`;
  },
};
