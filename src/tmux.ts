import { capture, ok } from './util.ts';
import type { Wt } from './worktree.ts';

export const sessAlive = (n: string) => ok('tmux', ['has-session', '-t', `=${n}`]);

export function winState(n: string, win: string): 'alive' | 'dead' | 'none' {
  const r = capture('tmux', ['list-windows', '-t', `=${n}`, '-F', '#{window_name} #{pane_dead}']);
  for (const l of r.stdout.split('\n')) {
    const [name, dead] = l.split(' ');
    if (name === win) return dead === '1' ? 'dead' : 'alive';
  }
  return 'none';
}

// opens a window running a command, creating the worktree's session on first use
export function newWindow(w: Wt, win: string, cmd: string) {
  if (sessAlive(w.name)) {
    capture('tmux', ['new-window', '-d', '-t', `=${w.name}:`, '-n', win, '-c', w.path, cmd]);
  } else {
    capture('tmux', ['new-session', '-d', '-s', w.name, '-n', win, '-c', w.path, '-x', '220', '-y', '50', cmd]);
    capture('tmux', ['set-option', '-t', `=${w.name}:`, 'mouse', 'on']);
  }
}

export const tmux = (...args: string[]) => capture('tmux', args);
