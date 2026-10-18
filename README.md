# pi-search-guard

Two Pi extensions that change how the model searches the filesystem.

- **find-guard** hooks `tool_call`, rewrites bounded `find` calls to [bfs](https://github.com/tavianator/bfs), and refuses filesystem-wide scans.
- **grep-guard** refuses recursive and directory-searching `grep` and points the model at [ripgrep](https://github.com/BurntSushi/ripgrep); single files and stdin filters are left alone.

Both exist because a single unguarded command looks harmless and costs minutes. This one took **12 minutes 14 seconds** in a real session:

```bash
find / -name "libcudnn.so.9*" 2>/dev/null | head
```

And this one, run from the home directory, spent minutes matching strings inside `node_modules`, npm cache blobs, session logs and binaries before the user interrupted it:

```bash
grep -rl "frontend-design" .
```

## find-guard

### Behavior

| Command | Result |
|---|---|
| `find / -name x` | Blocked, with alternatives |
| `find ~ -name x` | Blocked, with alternatives |
| `find $HOME -name x` | Blocked, with alternatives |
| `find / -maxdepth 2 -name x` | Rewritten to bfs |
| `find ~/.cache/uv -maxdepth 3 -iname 'torch-*'` | Rewritten to bfs |
| `find . -name '*.py'` | Rewritten to bfs |
| `ls`, anything without `find` | Untouched |

The rule is simple: a root of `/`, `~`, `$HOME`, or `${HOME}` without a `-maxdepth` cap is refused. Everything else is rewritten.

### Why block instead of just speeding up

A full-filesystem scan spends most of its time in `/proc`, `/sys`, `/mnt`, and cache directories. Making it 4x faster still leaves minutes of waiting, and the result is rarely useful. Refusing the command and returning the tool result that explains the alternatives gets the model to a better approach faster than a faster wrong approach does.

The block reason is returned to the model as the tool result, so it can adapt:

```text
Blocked: unbounded filesystem-wide `find` (root `/` or `$HOME` without `-maxdepth`).

Scanning the whole filesystem walks /proc, /sys, /mnt and every cache dir; on this
machine a `find /` run took over 12 minutes. Do not retry it as-is. Instead:

  * Narrow the roots, e.g. `find /usr/local/cuda /usr/lib /opt /home -name 'libcudnn.so*' 2>/dev/null`
  * Add a depth cap, e.g. `find ~ -maxdepth 4 -name 'libcudnn.so*' 2>/dev/null`
  * Use a package index instead of scanning: `ldconfig -p | rg cudnn`
  * Use the locator db when available: `locate 'libcudnn.so.9'`
```

### Why bfs

bfs is a drop-in replacement for GNU find. It accepts the same flags, resolves `-name` globs the same way, and honors the same default behavior for hidden files and gitignored paths. On a `/usr` tree of 137,373 entries:

| Command | Time |
|---|---|
| `find /usr -type f` | 1.22 s |
| `bfs /usr -type f` | 0.31 s |

bfs also stays single-threaded, which was faster than `-j20` on the same tree.

The rewrite is invisible to the model. Only the output changes.

## grep-guard

### Behavior

This environment standardises on ripgrep for searching directories, so a `grep` that walks or targets a directory is refused and the model is told to use `rg`:

- **recursive**: `grep -r` / `-R` / `--recursive` / `-d recurse`
- **a directory operand**: `grep foo src/`, `grep foo .`, `grep foo ~/.cache`

Everything else is left alone: a single file (`grep foo file.txt`), a glob (`grep foo *.py`), a path that does not exist, and stdin filters (`ps aux | grep python`). Directory detection resolves each operand against the effective cwd (a `cd` earlier in the command counts), expands `~`/`$HOME`, and stats it; globs and missing paths are treated as files. The guard never rewrites the command: the model writes the rg command itself.

| Command | Result |
|---|---|
| `grep -rn x src` | Blocked (recursive) |
| `grep x src/` | Blocked (directory operand) |
| `grep x .` | Blocked (directory operand) |
| `grep x file.txt` | Allowed (single file) |
| `grep x *.py` | Allowed (glob) |
| `grep x missing.txt` | Allowed (unknown path) |
| `ps aux \| grep python` | Allowed (stdin filter) |
| `grep foo` | Allowed (reads stdin) |
| `rg -n x src` | Untouched |
| `echo "grep -rn x ."` | Untouched (data, not a command) |
| any `grep` when rg is absent | Allowed through (fallback) |

### Why block instead of rewrite

`bfs` is a faithful drop-in for `find`; `rg` is **not** a drop-in for `grep`. Several flags share a spelling with a different meaning, so a silent substitution can corrupt the search:

| Flag | GNU grep | ripgrep |
|---|---|---|
| `-r` | recursive | `--replace` (takes a value) |
| `-h` | no filename | print help |
| `-E` | extended regexp | `--encoding` (takes a value) |
| `-s` | suppress error messages | `--case-sensitive` (overrides `-i`) |
| `-L` | files without match | `--follow` |
| `-z` | null data | `--search-zip` |
| `-U` / `-u` | binary / unbuffered | multiline / `--unrestricted` |

Rather than maintain a whitelist of translatable flags and risk changing results, grep-guard refuses and hands the model both the translation patterns and the collision list. The model keeps control of what the command means.

The reason returned to the model:

```text
Blocked: this environment uses ripgrep for recursive and directory searches — use `rg`.

Single-file grep is left alone; this gate only covers `grep -r` and `grep … dir`.

rg is recursive by default, faster, and skips binary files. Translate directly:

  grep -rn foo dir        ->  rg -n foo dir
  grep -rl foo dir        ->  rg -l foo dir
  grep -rE 'a|b' dir      ->  rg 'a|b' dir
  grep -rF foo dir        ->  rg -F foo dir
  grep -r --include='*.py' foo dir  ->  rg -g '*.py' foo dir

Piping into grep is left alone, but rg works there too:  cmd | grep x  ->  cmd | rg x

Do not just swap the name — rg reuses several letters with other meanings:
  -r = --replace (takes a value)   -h = help     -E = --encoding
  -s = --case-sensitive            -L = --follow -z = --search-zip
rg skips hidden and .gitignored paths by default; add --hidden --no-ignore
to search them the way `grep -r` does.
```

## Install

Install both backends first. Without `bfs`, find-guard only blocks; without `rg`, grep-guard lets `grep` through.

```bash
sudo apt install bfs ripgrep    # Debian, Ubuntu
brew install bfs ripgrep        # macOS
```

Then install the extensions:

```bash
pi install git:github.com/sg8010/pi-search-guard
```

Or load them for a single run:

```bash
pi -e ./extensions/find-guard.ts -e ./extensions/grep-guard.ts
```

After installing from a local path, run `/reload` in Pi.

## Disable

```bash
PI_FIND_GUARD=off pi     # disable find-guard
PI_GREP_GUARD=off pi     # disable grep-guard
```

## Test

```bash
npm test
npm run typecheck
```

## Scope

The extensions only intercept Pi's built-in `bash` tool. Commands you type yourself, and processes a script starts internally, are not affected.

Command detection uses a small shell-aware scanner shared by both guards rather than a full parser. It tracks single and double quote state, and reports a command only in command position. It handles:

```text
find . -name x              echo a; find . -name x
ls | grep foo               echo "$(grep -rn x .)"
echo `grep -rn x .`         cd /tmp && grep -rn x .
command grep -rn x .        sudo grep -rn x /
timeout 20 grep -rn x .     grep -rn x . 2>/dev/null | head
```

It ignores a command name appearing as data (`echo "find /"`, `grep find file`) and as a path (`/usr/bin/find`).

Two things can defeat the scanner: obfuscated command names such as `f""ind /`, and `eval 'find /'`. Detecting those reliably requires a full shell parser, which would misread ordinary quoted text often enough to be worse than the current tradeoff.

Each guard's `tool_call` handler failure blocks the tool as a fail-safe, so a broken extension cannot silently let scans through.

## Note on output order

GNU find walks depth-first; bfs walks breadth-first. The set of matched files is identical, but a command that consumes the stream such as `find . -name x | head` may select different lines. This is the one behavioral difference the rewrite introduces.

## License

MIT
