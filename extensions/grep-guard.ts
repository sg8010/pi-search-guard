/**
 * Grep Guard
 *
 * A policy gate, not a rewriter. This environment standardises on ripgrep for
 * searching directories, so a `grep` that walks or targets a directory is
 * refused and the model is told to use `rg` instead.
 *
 * What is gated:
 *   - recursive grep:  grep -r / -R / --recursive / -d recurse
 *   - a directory operand:  grep foo src/   grep foo .   grep foo ~/.cache
 * What is left alone:
 *   - a single file (or several):  grep foo file.txt
 *   - globs and paths that do not exist (we cannot tell what they are)
 *   - stdin filters:  ps aux | grep python
 *
 * Directory detection resolves the operand against the effective cwd (a `cd`
 * earlier in the same command counts) and stats it. `rg` is not a drop-in for
 * `grep` (`rg -r` is `--replace`, `rg -h` prints help, `rg -E` is `--encoding`),
 * so nothing is rewritten: the model writes the rg command itself. If rg is not
 * installed, grep is allowed through. Disable the gate with PI_GREP_GUARD=off.
 */

import { findCommandSegments } from "./shell-scan.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// rg discovery

function findRgBinary(): string | null {
	const candidates = [
		"/usr/bin/rg",
		"/usr/local/bin/rg",
		"/bin/rg",
		"/opt/homebrew/bin/rg",
		join(homedir(), ".local", "bin", "rg"),
		join(homedir(), ".cargo", "bin", "rg"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Pure analysis helpers (exported so they can be unit-tested)

const GREP_NAMES: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep"]);
const CD_NAMES: ReadonlySet<string> = new Set(["cd"]);

export interface Token {
	/** the token exactly as written, quotes and all */
	raw: string;
	/** the token with quoting and escapes resolved */
	value: string;
	kind: "option" | "operand" | "redir";
}

function isRedirection(raw: string): boolean {
	return /^(?:\d+|&)?>>?|^<{1,3}/.test(raw);
}

/** Split an argument string into tokens, keeping raw spelling and resolving values. */
export function tokenizeArgs(args: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < args.length) {
		while (i < args.length && /\s/.test(args[i])) i++;
		if (i >= args.length) break;
		const start = i;
		let value = "";
		let inSingle = false;
		let inDouble = false;
		while (i < args.length && (inSingle || inDouble || !/\s/.test(args[i]))) {
			const ch = args[i];
			if (ch === "'" && !inDouble) {
				inSingle = !inSingle;
				i++;
				continue;
			}
			if (ch === '"' && !inSingle) {
				inDouble = !inDouble;
				i++;
				continue;
			}
			if (ch === "\\" && !inSingle && i + 1 < args.length) {
				value += args[i + 1];
				i += 2;
				continue;
			}
			value += ch;
			i++;
		}
		const raw = args.slice(start, i);
		const kind: Token["kind"] = isRedirection(raw)
			? "redir"
			: !raw.startsWith("'") && !raw.startsWith('"') && value.startsWith("-") && value !== "-"
				? "option"
				: "operand";
		tokens.push({ raw, value, kind });
	}
	return tokens;
}

// short flags that take a value: -e PAT -f FILE -m N -A N -B N -C N -d ACTION
const SHORT_VALUE = new Set("efmABCd".split(""));
// long flags that take a value
const LONG_VALUE = new Set([
	"regexp",
	"file",
	"max-count",
	"after-context",
	"before-context",
	"context",
	"directories",
	"include",
	"exclude",
	"exclude-dir",
	"exclude-from",
	"label",
	"binary-files",
	"devices",
]);

export interface GrepCall {
	/** recurses into directories */
	recursive: boolean;
	/** file/directory operands, excluding `-` (stdin) */
	paths: string[];
}

/**
 * Classify one grep invocation. Walks the options with their arity, then splits
 * the remaining operands into pattern (only when -e/-f were not used) and paths.
 * `-` counts as stdin, not a path.
 */
export function parseGrepCall(args: string): GrepCall {
	const tokens = tokenizeArgs(args);
	let recursive = false;
	let patternFromOption = false;
	let endOfOpts = false;
	const operands: string[] = [];

	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t.kind === "redir") {
			i++;
			continue;
		}
		if (!endOfOpts && t.kind === "option") {
			const v = t.value;
			if (v === "--") {
				endOfOpts = true;
				i++;
				continue;
			}
			if (v.startsWith("--")) {
				const eq = v.indexOf("=");
				const name = eq >= 0 ? v.slice(2, eq) : v.slice(2);
				if (name === "recursive" || name === "dereference-recursive") recursive = true;
				if (name === "directories") {
					const val = eq >= 0 ? v.slice(eq + 1) : tokens[i + 1]?.value;
					if (val === "recurse") recursive = true;
					if (eq < 0 && val !== undefined) i++;
				} else if (LONG_VALUE.has(name)) {
					if (name === "regexp" || name === "file") patternFromOption = true;
					if (eq < 0) i++; // consume a separate value
				}
				i++;
				continue;
			}

			// short option cluster, e.g. -rni
			const body = v.slice(1);
			for (let b = 0; b < body.length; b++) {
				const c = body[b];
				if (c === "r" || c === "R") {
					recursive = true;
					continue;
				}
				if (c === "d") {
					const rest = body.slice(b + 1) || tokens[i + 1]?.value;
					if (rest === "recurse") recursive = true;
					if (!body.slice(b + 1) && tokens[i + 1]) i++;
					b = body.length;
					continue;
				}
				if (SHORT_VALUE.has(c)) {
					if (c === "e" || c === "f") patternFromOption = true;
					if (body.slice(b + 1).length === 0) i++;
					b = body.length;
					continue;
				}
			}
			i++;
			continue;
		}

		operands.push(t.value);
		i++;
	}

	const pathOperands = patternFromOption ? operands : operands.slice(1);
	return { recursive, paths: pathOperands.filter((p) => p !== "-") };
}

/** True for shell globs, whose expansion (file vs directory) is unknowable here. */
export function isGlob(path: string): boolean {
	return /[?*[\]{}]/.test(path);
}

/** Expand a literal `~` / `$HOME` prefix and resolve the rest against cwd. */
export function resolveOperand(path: string, cwd: string, home: string): string {
	if (path === "~" || path === "$HOME" || path === "${HOME}") return home;
	for (const prefix of ["~/", "$HOME/", "${HOME}/"]) {
		if (path.startsWith(prefix)) return join(home, path.slice(prefix.length));
	}
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/** How the guard sees a path: a directory, a file, or unknown/nonexistent. */
export type StatKind = "dir" | "file" | "none";
export type StatFn = (absolutePath: string) => StatKind;

const defaultStat: StatFn = (p) => {
	try {
		return statSync(p).isDirectory() ? "dir" : "file";
	} catch {
		return "none";
	}
};

/** True when at least one operand names an existing directory. */
export function hasDirectoryOperand(
	paths: string[],
	cwd: string,
	home: string,
	stat: StatFn = defaultStat,
): boolean {
	return paths.some((p) => {
		if (isGlob(p)) return false; // cannot know what a glob expands to
		return stat(resolveOperand(p, cwd, home)) === "dir";
	});
}

/**
 * Working directory a command will run in, accounting for any `cd` earlier in
 * the same one-liner. Falls back to `base`; `cd -` is ignored.
 */
export function effectiveCwd(command: string, upto: number, base: string, home: string): string {
	let cwd = base;
	for (const cd of findCommandSegments(command, CD_NAMES)) {
		if (cd.offset >= upto) break;
		const target = tokenizeArgs(cd.args).find((t) => t.kind === "operand")?.value;
		if (!target || target === "-") continue;
		cwd = resolveOperand(target, cwd, home);
	}
	return cwd;
}

/**
 * The first grep-family command that walks or targets a directory, or null when
 * every grep is a file or stdin search.
 */
export function findGatedGrep(
	command: string,
	cwd: string,
	home: string,
	stat: StatFn = defaultStat,
): { name: string; reason: "recursive" | "directory" } | null {
	for (const seg of findCommandSegments(command, GREP_NAMES)) {
		const call = parseGrepCall(seg.args);
		if (call.recursive) return { name: seg.name, reason: "recursive" };
		const effCwd = effectiveCwd(command, seg.offset, cwd, home);
		if (hasDirectoryOperand(call.paths, effCwd, home, stat)) {
			return { name: seg.name, reason: "directory" };
		}
	}
	return null;
}

export interface Analysis {
	/** whether the tool call must be refused */
	blocked: boolean;
	/** explanation returned to the model, or null when nothing was found */
	blockReason: string | null;
	/** human-readable note for the notification line */
	notes: string[];
}

export const BLOCK_REASON = [
	"Blocked: this environment uses ripgrep for recursive and directory searches — use `rg`.",
	"",
	"Single-file grep is left alone; this gate only covers `grep -r` and `grep … dir`.",
	"",
	"rg is recursive by default, faster, and skips binary files. Translate directly:",
	"",
	"  grep -rn foo dir        ->  rg -n foo dir",
	"  grep -rl foo dir        ->  rg -l foo dir",
	"  grep -rE 'a|b' dir      ->  rg 'a|b' dir",
	"  grep -rF foo dir        ->  rg -F foo dir",
	"  grep -r --include='*.py' foo dir  ->  rg -g '*.py' foo dir",
	"",
	"Piping into grep is left alone, but rg works there too:  cmd | grep x  ->  cmd | rg x",
	"",
	"Do not just swap the name — rg reuses several letters with other meanings:",
	"  -r = --replace (takes a value)   -h = help     -E = --encoding",
	"  -s = --case-sensitive            -L = --follow -z = --search-zip",
	"rg skips hidden and .gitignored paths by default; add --hidden --no-ignore",
	"to search them the way `grep -r` does.",
].join("\n");

/**
 * Decide what to do with one bash command. Only the gate lives here; there is
 * no rewrite branch.
 *
 * @param rgPath absolute path to rg, or null when rg is unavailable
 * @param cwd    working directory the bash tool will run in
 * @param home   the user's home directory
 * @param stat   how to classify a path (injectable for tests)
 */
export function analyzeCommand(
	command: string,
	rgPath: string | null,
	cwd: string = process.cwd(),
	home: string = homedir(),
	stat: StatFn = defaultStat,
): Analysis {
	const hit = findGatedGrep(command, cwd, home, stat);
	if (hit === null) return { blocked: false, blockReason: null, notes: [] };
	if (!rgPath) {
		// No rg: refusing grep would leave the model with no search tool at all.
		return { blocked: false, blockReason: null, notes: [] };
	}
	return {
		blocked: true,
		blockReason: BLOCK_REASON,
		notes: [`blocked ${hit.name} (${hit.reason}): use rg`],
	};
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (process.env.PI_GREP_GUARD === "off") return;

	const rgPath = findRgBinary();
	if (!rgPath) {
		pi.on("session_start", async (_e, ctx) => {
			ctx.ui.notify(
				"grep-guard: rg not found, `grep` is allowed through (install: sudo apt install ripgrep)",
				"warning",
			);
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;

		const { blocked, blockReason, notes } = analyzeCommand(command, rgPath);
		if (!blocked) return undefined;

		ctx.ui.notify(`grep-guard: ${notes.join(", ")}`, "warning");
		return { block: true, reason: blockReason ?? BLOCK_REASON };
	});
}
