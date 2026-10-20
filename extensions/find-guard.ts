/**
 * Find Guard
 *
 * Two mechanisms, applied to every `bash` tool call before it runs:
 *
 *   1. REWRITE  — plain `find` becomes `bfs` when bfs is installed. bfs is
 *                 syntax-compatible with GNU find and measured ~4x faster on
 *                 large trees.
 *   2. BLOCK     — an unbounded full-filesystem scan (`find /` or `find ~`
 *                 without `-maxdepth`) is refused, and the model is told why
 *                 plus what to do instead.
 *
 * Disable at any time with PI_FIND_GUARD=off.
 */

import { findCommandSegments, isUnboundedRootToken } from "./shell-scan.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// bfs discovery

function findBfsBinary(): string | null {
	const candidates = [
		"/usr/bin/bfs",
		"/usr/local/bin/bfs",
		"/bin/bfs",
		"/opt/homebrew/bin/bfs",
		join(homedir(), ".local", "bin", "bfs"),
		join(homedir(), ".pi", "agent", "bin", "bfs"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Pure analysis helpers (exported so they can be unit-tested)

/** A `find` invocation found in a command, plus the offset of that token. */
export interface FindSegment {
	text: string;
	/** absolute offset of the `find` token within the original command */
	findOffset: number;
	/** everything after the `find` token */
	args: string;
}

const FIND_NAMES: ReadonlySet<string> = new Set(["find"]);

/**
 * Locate every `find` that actually executes as a command.
 *
 * This is a deliberately small shell-aware scanner, not a full parser. It walks
 * the string tracking single/double quote state, and only reports `find` when it
 * sits in command position: at the start, or right after ; | & ( ` newline,
 * which covers:   cmd; find ..   a | find ..   $(find ..)   `find ..`
 * and the wrapper forms `command find`, `sudo find`, `env find`, `nice find`.
 *
 * Plain text inside quotes (e.g. echo "find / -name x") is skipped, but command
 * substitution inside double quotes ("$(find ..)") is still detected.
 */
export function findFindSegments(command: string): FindSegment[] {
	return findCommandSegments(command, FIND_NAMES).map((s) => ({
		text: command.slice(s.offset, s.offset + s.name.length + s.args.length),
		findOffset: s.offset,
		args: s.args,
	}));
}

/**
 * Dominant root paths that make a scan effectively unbounded when not capped by
 * -maxdepth: `/`, `//`, `~`, `~/`, `$HOME`, `${HOME}`, and globs of those.
 */
export function isUnboundedRoot(args: string): boolean {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	// Collect leading non-option tokens (find allows several start paths).
	const roots: string[] = [];
	for (const t of tokens) {
		if (t.startsWith("-")) break;
		roots.push(t);
	}
	if (roots.length === 0) return false; // `find -name x` defaults to `.` — bounded
	return roots.some((r) => isUnboundedRootToken(r));
}

export function hasMaxDepth(args: string): boolean {
	return /(^|\s)-maxdepth\s+\d+/.test(args);
}

export interface Analysis {
	/** Replacement command, or null when nothing needed changing. */
	rewritten: string | null;
	/** Non-null when the call must be refused. */
	blockReason: string | null;
}

const BLOCK_REASON = [
	"Blocked: unbounded filesystem-wide `find` (root `/` or `$HOME` without `-maxdepth`).",
	"",
	"Scanning the whole filesystem walks /proc, /sys, /mnt and every cache dir; on this",
	"machine a `find /` run took over 12 minutes. Do not retry it as-is. Instead:",
	"",
	"  * Narrow the roots, e.g. `find /usr/local/cuda /usr/lib /opt /home -name 'libcudnn.so*' 2>/dev/null`",
	"  * Add a depth cap, e.g. `find ~ -maxdepth 4 -name 'libcudnn.so*' 2>/dev/null`",
	"  * Use a package index instead of scanning: `ldconfig -p | rg cudnn`",
	"  * Use the locator db when available: `locate 'libcudnn.so.9'`",
].join("\n");

/**
 * Decide what to do with one bash command.
 *
 * @param bfsPath absolute path to bfs, or null when bfs is unavailable
 */
export function analyzeCommand(command: string, bfsPath: string | null): Analysis {
	const finds = findFindSegments(command);

	const unbounded = finds.filter((f) => isUnboundedRoot(f.args) && !hasMaxDepth(f.args));
	if (unbounded.length > 0) {
		return { rewritten: null, blockReason: BLOCK_REASON };
	}

	if (finds.length === 0) {
		return { rewritten: null, blockReason: null };
	}

	if (bfsPath) {
		// Replace each `find` token from the end so earlier offsets stay valid.
		let out = command;
		for (const f of [...finds].sort((a, b) => b.findOffset - a.findOffset)) {
			out = out.slice(0, f.findOffset) + bfsPath + out.slice(f.findOffset + 4);
		}
		return { rewritten: out, blockReason: null };
	}

	return { rewritten: null, blockReason: null };
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	if (process.env.PI_FIND_GUARD === "off") return;

	const bfsPath = findBfsBinary();
	if (!bfsPath) {
		pi.on("session_start", async (_e, ctx) => {
			ctx.ui.notify(
				"find-guard: bfs not found, only unbounded-scan blocking is active (install: sudo apt install bfs)",
				"warning",
			);
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;

		const { rewritten, blockReason } = analyzeCommand(command, bfsPath);

		if (blockReason) {
			ctx.ui.notify("find-guard: blocked unbounded `find` scan", "warning");
			// Blocking is a fail-safe: the reason is returned to the model.
			return { block: true, reason: blockReason };
		}

		// The rewrite is silent: it changes only how the search runs, not its result.
		if (rewritten !== null && rewritten !== command) {
			event.input.command = rewritten;
		}

		return undefined;
	});
}
