#!/usr/bin/env bash
# installs wt from this checkout: Bun, tmux and worktrunk when missing, wt and wtcore linked into
# WT_BIN_DIR (default ~/.local/bin), shell integration in the login shell's rc file, and the
# agent skill. safe to run again after a git pull
set -euo pipefail

WORKTRUNK_VERSION=0.82.0
# the oldest worktrunk wt runs with, and the git it needs
MIN_WORKTRUNK=0.81.0
MIN_GIT=2.43.0
dir=$(cd "$(dirname "$0")" && pwd -P)
bin=${WT_BIN_DIR:-$HOME/.local/bin}
step() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'wt install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
# whether version $1 is older than $2
older() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1) == "$1" ]]; }
version() { "$@" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

os=$(uname -s)
arch=$(uname -m)
case $os in Darwin | Linux) ;; *) fail "unsupported system $os, wt runs on macOS and Linux" ;; esac
for c in git lsof curl tar; do has "$c" || fail "$c is missing, install it with your package manager"; done
git_v=$(version git)
older "$git_v" "$MIN_GIT" && fail "git $git_v is too old, worktrunk needs $MIN_GIT or newer"
mkdir -p "$bin"

if ! has tmux; then
  if has brew; then step 'installing tmux'; brew install tmux
  else fail 'tmux is missing, install it with your package manager'; fi
fi

if [[ ! -x $HOME/.bun/bin/bun ]] && ! has bun; then
  step 'installing bun'
  curl -fsSL https://bun.sh/install | bash
fi

# worktrunk's binary is also called wt, so it is installed as wtcore
core=$(command -v wtcore || true)
[[ -z $core && -x $bin/wtcore ]] && core=$bin/wtcore
if [[ -n $core ]] && older "$(version "$core")" "$MIN_WORKTRUNK"; then
  [[ $core == "$bin/wtcore" ]] || fail "$core is worktrunk $(version "$core"), wt needs $MIN_WORKTRUNK or newer; upgrade or remove it"
  core=
fi
if [[ -z $core ]]; then
  case $os-$arch in
    Darwin-arm64) target=aarch64-apple-darwin want=6945bc82e0513d0b974c99fb1d30de24e448697fd533ed6b3f442c66a1b3620c ;;
    Darwin-x86_64) target=x86_64-apple-darwin want=d9c87668baa1aad2b44d5bfb08074609c5e4a186a0948dfed6e65d6e6c5a7744 ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl want=b907f891bc051dcfc13fa479194e156b356f434a37103522ea1fe1b7ded899b5 ;;
    Linux-x86_64) target=x86_64-unknown-linux-musl want=d1e38cf36d8c14ef0682a6d6617f8a512b1a971feb3dfa437419d00136e19a3e ;;
    *) fail "no worktrunk build for $os $arch" ;;
  esac
  step "installing worktrunk $WORKTRUNK_VERSION as wtcore"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/wk.tar.xz" "https://github.com/max-sixty/worktrunk/releases/download/v$WORKTRUNK_VERSION/worktrunk-$target.tar.xz"
  if has sha256sum; then got=$(sha256sum "$tmp/wk.tar.xz" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/wk.tar.xz" | cut -d' ' -f1); fi
  [[ $got == "$want" ]] || fail "worktrunk checksum mismatch"
  tar -xJf "$tmp/wk.tar.xz" -C "$tmp"
  install -m 755 "$tmp/worktrunk-$target/wt" "$bin/wtcore"
fi

if [[ -e $bin/wt && $(readlink "$bin/wt" || true) != "$dir/wt" ]]; then
  fail "$bin/wt exists and is not this checkout's wt; move it aside or set WT_BIN_DIR"
fi
ln -sfn "$dir/wt" "$bin/wt"
step "linked $bin/wt"

shell=$(basename "${SHELL:-bash}")
case $shell in
  zsh) rc=${ZDOTDIR:-$HOME}/.zshrc ;;
  # macOS terminals start login shells, which read .bash_profile and not .bashrc
  bash) if [[ $os == Darwin ]]; then rc=$HOME/.bash_profile; else rc=$HOME/.bashrc; fi ;;
  fish) rc=$HOME/.config/fish/conf.d/wt.fish; mkdir -p "$(dirname "$rc")" ;;
  *) rc= ;;
esac
if [[ -z $rc ]]; then
  step "no shell integration for $shell; wt shell-init supports bash, zsh and fish"
elif ! grep -qs 'wt shell-init' "$rc"; then
  {
    printf '\n# wt\n'
    case ":$PATH:" in
      *":$bin:"*) ;;
      *) if [[ $shell == fish ]]; then printf 'fish_add_path "%s"\n' "$bin"; else printf 'export PATH="%s:$PATH"\n' "$bin"; fi ;;
    esac
    if [[ $shell == fish ]]; then printf 'wt shell-init fish | source\n'; else printf 'eval "$(wt shell-init %s)"\n' "$shell"; fi
  } >>"$rc"
  step "added wt to $rc"
fi

for home in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$HOME/.codex"; do
  [[ -d $home ]] || continue
  mkdir -p "$home/skills"
  ln -sfn "$dir/skill" "$home/skills/wt"
  step "linked the wt skill into $home/skills"
done

"$bin/wt" --help >/dev/null || fail 'wt does not run, see the error above'
case ":$PATH:" in
  *":$bin:"*)
    found=$(command -v wt)
    [[ $found == "$bin/wt" ]] || step "warning: $found comes before $bin/wt on PATH; remove it or put $bin first" ;;
esac
step 'done: open a new shell, then run wt up in any git worktree'
