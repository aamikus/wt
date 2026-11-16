import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state, profiles and the default repo live in a throwaway dir, never in ~/.claude/wt
const root = mkdtempSync(join(tmpdir(), 'wt-test-'));
process.env.WT_HOME = join(root, 'home');
process.env.WT_PROFILES = join(root, 'profiles');
process.env.WT_REPO = join(root, 'default-repo');

// wtcore reads this config instead of ~/.config/worktrunk: the user config's hooks minus wt up
const wt = join(import.meta.dir, '..', 'wt');
process.env.WORKTRUNK_CONFIG_PATH = join(root, 'worktrunk.toml');
writeFileSync(
  process.env.WORKTRUNK_CONFIG_PATH,
  `worktree-path = "{{ repo_path }}/.claude/worktrees/{{ branch | sanitize }}"

[post-start]
copy = "wtcore step copy-ignored --require-include"

[pre-remove]
env = "${wt} _purge {{ worktree_path }}"
`,
);
