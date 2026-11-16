import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
export const HOME = homedir();

// appended: homebrew's pnpm must not shadow the corepack one a login shell resolves
env.PATH = `${env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`;
// the first tmux client fixes the server environment for every service it will ever run
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR']) delete env[k];
// node comes from the login shells wt runs pnpm in; nvm via BASH_ENV costs every bash ~1 s
delete env.BASH_ENV;
// hook and gui environments carry no locale, and cocoapods dies on ASCII-8BIT paths
env.LANG ||= 'en_US.UTF-8';
env.LC_ALL ||= 'en_US.UTF-8';
env.ANDROID_HOME ||= join(HOME, 'Library/Android/sdk');
for (const d of ['platform-tools', 'emulator', 'cmdline-tools/latest/bin']) env.PATH += `:${env.ANDROID_HOME}/${d}`;

export const WT_HOME = env.WT_HOME || join(HOME, '.claude/wt');
// the launcher wt re-runs itself through, inside tmux and login shells
export const SELF = env.WT_SELF || join(import.meta.dir, '..', 'wt');
// worktrunk's binary, installed under this name so wt keeps its own
export const CORE = env.WT_CORE || 'wtcore';
export const PROFILES_DIR = env.WT_PROFILES || join(import.meta.dir, '..', 'profiles');
env.WORKTRUNK_CONFIG_PATH ||= join(import.meta.dir, '..', 'worktrunk.toml');

mkdirSync(WT_HOME, { recursive: true });

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

export const config = readConfig(join(WT_HOME, 'config'));
