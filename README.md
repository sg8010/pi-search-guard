# pi-search-guard

两个 Pi 扩展，用来改变模型搜索文件系统的方式。

- **find-guard** 挂钩 `tool_call`，把带上限的 `find` 调用改写成 [bfs](https://github.com/tavianator/bfs)，并拒绝全盘扫描。
- **grep-guard** 拒绝递归或针对目录的 `grep`，并引导模型改用 [ripgrep](https://github.com/BurntSushi/ripgrep)；单文件搜索和标准输入过滤不受影响。

做这两个扩展的原因很简单：一条没有约束的命令看起来毫无害处，代价却是几分钟。下面这条命令在一次真实会话里跑了 **12 分 14 秒**：

```bash
find / -name "libcudnn.so.9*" 2>/dev/null | head
```

下面这条在家目录里执行，在 `node_modules`、npm 缓存文件、会话日志和二进制文件中匹配字符串，直到用户手动中断：

```bash
grep -rl "frontend-design" .
```

## find-guard

### 行为

| 命令 | 结果 |
|---|---|
| `find / -name x` | 拦截，并给出替代方案 |
| `find ~ -name x` | 拦截，并给出替代方案 |
| `find $HOME -name x` | 拦截，并给出替代方案 |
| `find / -maxdepth 2 -name x` | 改写为 bfs |
| `find ~/.cache/uv -maxdepth 3 -iname 'torch-*'` | 改写为 bfs |
| `find . -name '*.py'` | 改写为 bfs |
| `ls`，以及任何不含 `find` 的命令 | 不改动 |

规则很简单：搜索起点是 `/`、`~`、`$HOME` 或 `${HOME}`，且没有 `-maxdepth` 限制，就拒绝；其他情况一律改写。

### 为什么是拦截而不是加速

全盘扫描的时间大多花在 `/proc`、`/sys`、`/mnt` 和各处缓存目录上。即使快上 4 倍，等待时间仍然以分钟计，而结果往往没什么用。拦截命令并返回解释替代方案的工具结果，能让模型更快走到更好的做法，比一个更快的错误做法更有价值。

拦截原因会作为工具结果返回给模型，模型可以据此调整：

```text
Blocked: unbounded filesystem-wide `find` (root `/` or `$HOME` without `-maxdepth`).

Scanning the whole filesystem walks /proc, /sys, /mnt and every cache dir; on this
machine a `find /` run took over 12 minutes. Do not retry it as-is. Instead:

  * Narrow the roots, e.g. `find /usr/local/cuda /usr/lib /opt /home -name 'libcudnn.so*' 2>/dev/null`
  * Add a depth cap, e.g. `find ~ -maxdepth 4 -name 'libcudnn.so*' 2>/dev/null`
  * Use a package index instead of scanning: `ldconfig -p | rg cudnn`
  * Use the locator db when available: `locate 'libcudnn.so.9'`
```

### 为什么选 bfs

bfs 可以直接替代 GNU find。它接受同样的参数，以同样的方式解析 `-name` 通配符，对隐藏文件和被 gitignore 的路径也保持同样的默认行为。在一棵含 137,373 个条目的 `/usr` 目录树上：

| 命令 | 耗时 |
|---|---|
| `find /usr -type f` | 1.22 s |
| `bfs /usr -type f` | 0.31 s |

bfs 保持单线程运行，在同一棵目录树上比 `-j20` 更快。

改写是静默的：不弹通知，对模型也不可见，只有输出会变。

## grep-guard

### 行为

本环境统一用 ripgrep 搜索目录，因此遍历目录或指向目录的 `grep` 会被拒绝，并告知模型改用 `rg`：

- **递归**：`grep -r` / `-R` / `--recursive` / `-d recurse`
- **操作数是目录**：`grep foo src/`、`grep foo .`、`grep foo ~/.cache`

其他情况都不动：单文件（`grep foo file.txt`）、通配符（`grep foo *.py`）、不存在的路径，以及标准输入过滤（`ps aux | grep python`）。目录判断会结合命令中此前的 `cd`，把每个操作数相对当前工作目录解析，展开 `~`/`$HOME` 后再做 stat；通配符和不存在的路径按文件处理。该守卫从不改写命令，rg 命令由模型自己写。

| 命令 | 结果 |
|---|---|
| `grep -rn x src` | 拦截（递归） |
| `grep x src/` | 拦截（操作数是目录） |
| `grep x .` | 拦截（操作数是目录） |
| `grep x file.txt` | 放行（单文件） |
| `grep x *.py` | 放行（通配符） |
| `grep x missing.txt` | 放行（路径未知） |
| `ps aux \| grep python` | 放行（标准输入过滤） |
| `grep foo` | 放行（读取标准输入） |
| `rg -n x src` | 不改动 |
| `echo "grep -rn x ."` | 不改动（是数据，不是命令） |
| 未安装 rg 时的任何 `grep` | 放行（回退） |

### 为什么是拦截而不是改写

`bfs` 是 `find` 的忠实替代品，`rg` 则**不是** `grep` 的替代品。不少参数的拼写相同而含义不同，静默替换可能让搜索结果出错：

| 参数 | GNU grep | ripgrep |
|---|---|---|
| `-r` | 递归 | `--replace`（需要取值） |
| `-h` | 不显示文件名 | 打印帮助 |
| `-E` | 扩展正则 | `--encoding`（需要取值） |
| `-s` | 不显示错误信息 | `--case-sensitive`（覆盖 `-i`） |
| `-L` | 列出不匹配的文件 | `--follow` |
| `-z` | 空字符分隔数据 | `--search-zip` |
| `-U` / `-u` | 二进制 / 无缓冲 | 多行模式 / `--unrestricted` |

与其维护一份可翻译参数的白名单、承担改变搜索结果的风险，grep-guard 选择拒绝，并把翻译写法和冲突参数一并交给模型。命令的含义仍由模型掌控。

返回给模型的原因：

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

## 安装

先装好两个后端。没有 `bfs` 时 find-guard 只能拦截；没有 `rg` 时 grep-guard 会放行 `grep`。

```bash
sudo apt install bfs ripgrep    # Debian, Ubuntu
brew install bfs ripgrep        # macOS
```

然后安装扩展：

```bash
pi install git:github.com/sg8010/pi-search-guard
```

或者只加载一次：

```bash
pi -e ./extensions/find-guard.ts -e ./extensions/grep-guard.ts
```

从本地路径安装后，在 Pi 里运行 `/reload`。

## 关闭

```bash
PI_FIND_GUARD=off pi     # 关闭 find-guard
PI_GREP_GUARD=off pi     # 关闭 grep-guard
```

## 测试

```bash
npm test
npm run typecheck
```

## 适用范围

扩展只拦截 Pi 内置的 `bash` 工具。你自己输入的命令，以及脚本内部启动的进程，都不受影响。

命令识别由两个守卫共用的一个小型、感知 shell 语法的扫描器完成，而不是完整的解析器。它跟踪单引号和双引号状态，只在命令位置报告命令。它能处理：

```text
find . -name x              echo a; find . -name x
ls | grep foo               echo "$(grep -rn x .)"
echo `grep -rn x .`         cd /tmp && grep -rn x .
command grep -rn x .        sudo grep -rn x /
timeout 20 grep -rn x .     grep -rn x . 2>/dev/null | head
```

它会忽略作为数据出现的命令名（`echo "find /"`、`grep find file`）和作为路径出现的命令名（`/usr/bin/find`）。

它还会把 heredoc 正文当作数据：

```text
cat <<'EOF'
find / -name x        # 正文，不会被拦截或改写
EOF
```

定界符加引号（`<<'EOF'`）时整个正文都是字面文本；不加引号（`<<EOF`）时正文仍会做命令替换，因此其中的 `$(...)` 和反引号会被检查。

有两种情况能绕过扫描器：经过混淆的命令名，例如 `f""ind /`；以及 `eval 'find /'`。可靠地识别它们需要完整的 shell 解析器，而那样的解析器会经常误判普通的带引号文本，得不偿失。

每个守卫的 `tool_call` 处理函数一旦出错，就按故障安全原则拦截该工具，这样坏掉的扩展不会悄悄放过扫描。

## 关于输出顺序

GNU find 按深度优先遍历，bfs 按广度优先遍历。匹配到的文件集合完全相同，但会消耗流的命令（例如 `find . -name x | head`）可能选中不同的行。这是改写引入的唯一行为差异。

## 许可证

MIT
