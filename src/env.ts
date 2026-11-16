import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const env = process.env;
export const HOME = homedir();

// appended: homebrew's pnpm must not shadow the corepack one a login shell resolves
env.PATH = `${env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`;
// the first tmux client fixes the server environment for every service it will ever run
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR']) delete env[k];
// node comes from the login shells wt runs pnpm in; nvm via BASH_ENV costs every bash ~1 s
delete env.BASH_ENV;
// hook and gui environments carry no locale, and cocoapods dies on ASCII-8BIT paths
if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
env.ANDROID_HOME ||= join(HOME, 'Library/Android/sdk');
for (const d of ['platform-tools', 'emulator', 'cmdline-tools/latest/bin']) env.PATH += `:${env.ANDROID_HOME}/${d}`;

// state and logs; repo configs and the config file live in CONFIG_DIR
export const WT_HOME = env.WT_HOME || join(env.XDG_STATE_HOME || join(HOME, '.local/state'), 'wt');
export const CONFIG_DIR = env.WT_CONFIG || join(env.XDG_CONFIG_HOME || join(HOME, '.config'), 'wt');
export const REPOS_DIR = join(CONFIG_DIR, 'repos');
// the launcher wt re-runs itself through, inside tmux and login shells
export const SELF = env.WT_SELF || join(import.meta.dir, '..', 'wt');
// worktrunk's binary, installed under this name so wt keeps its own
export const CORE = env.WT_CORE || 'wtcore';
env.WORKTRUNK_CONFIG_PATH ||= join(import.meta.dir, '..', 'worktrunk.toml');

// state and config from before wt used XDG directories move once
const OLD_HOME = join(HOME, '.claude/wt');
if (!env.WT_HOME && existsSync(OLD_HOME) && !existsSync(WT_HOME)) {
  mkdirSync(dirname(WT_HOME), { recursive: true });
  renameSync(OLD_HOME, WT_HOME);
  if (existsSync(join(WT_HOME, 'config')) && !existsSync(join(CONFIG_DIR, 'config'))) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    renameSync(join(WT_HOME, 'config'), join(CONFIG_DIR, 'config'));
  }
}
mkdirSync(WT_HOME, { recursive: true, mode: 0o700 });

// KEY=value lines; the file was sourced by the bash wt, so quotes are stripped
export function readConfig(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export const config = readConfig(join(CONFIG_DIR, 'config'));
// the config file's settings reach every command wt runs, as if exported
for (const [k, v] of Object.entries(config)) env[k] ??= v;
