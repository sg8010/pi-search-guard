# pi-find-guard

A Pi extension that makes the model's `find` commands safe by default.

It hooks `tool_call` and inspects every `bash` command before it executes. Bounded searches are rewritten to [bfs](https://github.com/tavianator/bfs); filesystem-wide scans are refused with an explanation and a list of narrower alternatives.

The extension exists because a single unguarded command like this:

```bash
find / -name "libcudnn.so.9*" 2>/dev/null | head
```

took **12 minutes 14 seconds** in a real session. Nothing in the command looks dangerous, and the model has no reason to avoid it.

## Behavior

| Command | Result |
|---|---|
| `find / -name x` | Blocked, with alternatives |
| `find ~ -name x` | Blocked, with alternatives |
| `find $HOME -name x` | Blocked, with alternatives |
| `find / -maxdepth 2 -name x` | Rewritten to bfs |
| `find ~/.cache/uv -maxdepth 3 -iname 'torch-*'` | Rewritten to bfs |
| `find . -name '*.py'` | Rewritten to bfs |
| `ls`, `grep`, anything without `find` | Untouched |

The rule is simple: a root of `/`, `~`, `$HOME`, or `${HOME}` without a `-maxdepth` cap is refused. Everything else is rewritten.

## Why block instead of just speeding up

A full-filesystem scan spends most of its time in `/proc`, `/sys`, `/mnt`, and cache directories. Making it 4x faster still leaves minutes of waiting, and the result is rarely useful. Refusing the command and returning the tool result that explains the alternatives gets the model to a better approach faster than a faster wrong approach does.

The block reason is returned to the model as the tool result, so it can adapt:

```text
Blocked: unbounded filesystem-wide `find` (root `/` or `$HOME` without `-maxdepth`).

Scanning the whole filesystem walks /proc, /sys, /mnt and every cache dir; on this
machine a `find /` run took over 12 minutes. Do not retry it as-is. Instead:

  * Narrow the roots, e.g. `find /usr/local/cuda /usr/lib /opt /home -name 'libcudnn.so*' 2>/dev/null`
  * Add a depth cap, e.g. `find ~ -maxdepth 4 -name 'libcudnn.so*' 2>/dev/null`
  * Use a package index instead of scanning: `ldconfig -p | grep cudnn`
  * Use the locator db when available: `locate 'libcudnn.so.9'`
```

## Why bfs

bfs is a drop-in replacement for GNU find. It accepts the same flags, resolves `-name` globs the same way, and honors the same default behavior for hidden files and gitignored paths. On a `/usr` tree of 137,373 entries:

| Command | Time |
|---|---|
| `find /usr -type f` | 1.22 s |
| `bfs /usr -type f` | 0.31 s |

bfs also stays single-threaded, which was faster than `-j20` on the same tree.

The rewrite is invisible to the model. Only the output changes.

## Install

Install bfs first. The rewrite is skipped when bfs is absent, and only blocking remains active.

```bash
sudo apt install bfs          # Debian, Ubuntu
brew install bfs              # macOS
```

Then install the extension:

```bash
pi install git:github.com/sg8010/pi-find-guard
```

Or load it for a single run:

```bash
pi -e ./extensions/find-guard.ts
```

After installing from a local path, run `/reload` in Pi.

## Disable

```bash
PI_FIND_GUARD=off pi
```

## Test

```bash
node --experimental-strip-types --test test/find-guard.test.ts
```

## Scope

The extension only intercepts Pi's built-in `bash` tool. Commands you type yourself, and processes a script starts internally, are not affected.

Command detection uses a small shell-aware scanner rather than a full parser. It tracks single and double quote state, and reports `find` only in command position. It handles:

```text
find . -name x              echo a; find . -name x
ls | find . -name x         echo "$(find /tmp -maxdepth 1)"
echo `find /tmp`            cd /tmp && find . -name x
command find . -name x      sudo find / -name x
```

It ignores `find` appearing as data (`echo "find /"`, `grep find file`) and as a path (`/usr/bin/find`).

Two things can defeat the scanner: obfuscated command names such as `f""ind /`, and `eval 'find /'`. Detecting those reliably requires a full shell parser, which would misread ordinary quoted text often enough to be worse than the current tradeoff.

A `tool_call` handler failure blocks the tool as a fail-safe, so a broken extension cannot silently let scans through.

## Note on output order

GNU find walks depth-first; bfs walks breadth-first. The set of matched files is identical, but a command that consumes the stream such as `find . -name x | head` may select different lines. This is the one behavioral difference the rewrite introduces.

## License

MIT
