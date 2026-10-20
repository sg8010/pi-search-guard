/**
 * Tests for find-guard's pure analysis logic.
 *
 *   node --experimental-strip-types --test test/find-guard.test.ts
 *   bun test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	analyzeCommand,
	findFindSegments,
	hasMaxDepth,
	isUnboundedRoot,
} from "../extensions/find-guard.ts";

const BFS = "/usr/bin/bfs";

// The command that motivated this extension: a full-filesystem scan that took
// 12m14s in a real session.
const REAL_COMMAND = [
	`find / -name "libcudnn.so.9*" 2>/dev/null | head`,
	`echo "--- nvidia pip pkgs ---"`,
	`ls ~/.cache/uv/archive-v0/ | head -3 >/dev/null`,
	`find ~/.cache/uv -maxdepth 3 -iname "nvidia_cudnn*" -o -maxdepth 3 -iname "nvidia-cudnn*" 2>/dev/null | head`,
	`echo "--- torch? ---"`,
	`find ~/.cache/uv -maxdepth 3 -iname "torch-*" 2>/dev/null | head -5`,
].join("; ");

// ---------------------------------------------------------------------------
// Unbounded-root detection

test("isUnboundedRoot flags whole-filesystem roots", () => {
	for (const args of [
		"/ -name x",
		"/",
		"// -name x",
		"~ -name x",
		"~/",
		"$HOME -name x",
		"${HOME} -name x",
		"/* -name x",
	]) {
		assert.equal(isUnboundedRoot(args), true, `expected unbounded: ${args}`);
	}
});

test("isUnboundedRoot allows scoped roots", () => {
	for (const args of [
		"-name x",
		". -name x",
		"/tmp -name x",
		"/usr /opt -name x",
		"~/.cache/uv -maxdepth 3 -iname x",
		"/usr/local/cuda -name x",
	]) {
		assert.equal(isUnboundedRoot(args), false, `expected bounded: ${args}`);
	}
});

test("hasMaxDepth detects a numeric depth cap", () => {
	assert.equal(hasMaxDepth("-maxdepth 3"), true);
	assert.equal(hasMaxDepth("-name x"), false);
	assert.equal(hasMaxDepth("-maxdepth"), false);
});

// ---------------------------------------------------------------------------
// Command-position detection

test("finds find in every command position", () => {
	for (const cmd of [
		"find . -name x",
		"echo a; find . -name x",
		"ls | find . -name x",
		'echo "$(find /tmp -maxdepth 1)"',
		"echo `find /tmp -maxdepth 1`",
		"echo a\nfind . -name x",
		"command find . -name x",
		"sudo find / -name x",
		"env find . -name x",
		"nice find . -name x",
		"cd /tmp && find . -name x",
	]) {
		assert.equal(findFindSegments(cmd).length, 1, `expected one find in: ${cmd}`);
	}
});

test("does not match find as data rather than a command", () => {
	for (const cmd of [
		'echo "find / -name x"',
		"echo 'find / -name x'",
		"finder . -name x",
		"echo find",
		"/usr/bin/find . -name x",
		"grep find file",
	]) {
		assert.equal(findFindSegments(cmd).length, 0, `expected no find in: ${cmd}`);
	}
});

test("detects every find in a chain", () => {
	assert.equal(findFindSegments("find /tmp -maxdepth 1; find /var -maxdepth 2").length, 2);
	assert.equal(findFindSegments(REAL_COMMAND).length, 3);
});

// ---------------------------------------------------------------------------
// Heredocs: bodies are data, not commands

test("ignores find in a quoted heredoc body", () => {
	const cmd = ["git commit -F - <<'EOF'", "find -> bfs 改写改为静默", "EOF"].join("\n");
	assert.equal(findFindSegments(cmd).length, 0);
	assert.equal(analyzeCommand(cmd, BFS).rewritten, null);
});

test("ignores find in an unquoted heredoc body when there is no substitution", () => {
	const cmd = ["cat <<EOF", "find / -name x", "EOF"].join("\n");
	assert.equal(findFindSegments(cmd).length, 0);
	assert.equal(analyzeCommand(cmd, BFS).blockReason, null);
});

test("still finds real commands after a heredoc body", () => {
	const cmd = ["cat <<'EOF'", "find / -name x", "EOF", "find . -name y"].join("\n");
	const segs = findFindSegments(cmd);
	assert.equal(segs.length, 1);
	assert.equal(segs[0].findOffset, cmd.lastIndexOf("find"));
});

test("handles several heredocs on one line", () => {
	const cmd = ["cat <<'A' <<'B'", "find /", "A", "find ~", "B", "find . -name z"].join("\n");
	assert.equal(findFindSegments(cmd).length, 1);
	assert.equal(analyzeCommand(cmd, BFS).rewritten, cmd.replace("find . -name z", `${BFS} . -name z`));
});

test("still inspects command substitution in an unquoted heredoc body", () => {
	const cmd = ["cat <<EOF", "$(find / -name x)", "EOF"].join("\n");
	assert.ok(analyzeCommand(cmd, BFS).blockReason, "expected the substitution to be seen");
});

test("a quoted heredoc body keeps a substitution inert", () => {
	const cmd = ["cat <<'EOF'", "$(find / -name x)", "EOF"].join("\n");
	assert.equal(analyzeCommand(cmd, BFS).blockReason, null);
});

test("does not confuse an arithmetic shift or a herestring with a heredoc", () => {
	assert.equal(findFindSegments("echo $((1 << 2)); find . -name x").length, 1);
	assert.equal(findFindSegments("echo $((1 << x)); find . -name y").length, 1);
	assert.equal(findFindSegments('cat <<< "find /"').length, 0);
	assert.equal(findFindSegments("cat <<< find").length, 0);
});

test("handles <<- tab-stripped terminators and CRLF", () => {
	const tabs = ["cat <<-EOF", "\tfind / -name x", "\tEOF", "find . -name y"].join("\n");
	assert.equal(findFindSegments(tabs).length, 1);

	const crlf = ["cat <<'EOF'", "find / -name x", "EOF", "find . -name y"].join("\r\n");
	assert.equal(findFindSegments(crlf).length, 1);
});

// ---------------------------------------------------------------------------
// analyzeCommand: blocking

test("blocks the real full-filesystem command", () => {
	const { blockReason } = analyzeCommand(REAL_COMMAND, BFS);
	assert.ok(blockReason, "expected the real command to be blocked");
	assert.match(blockReason, /unbounded filesystem-wide/);
	assert.match(blockReason, /maxdepth/, "block reason should suggest a depth cap");
});

test("blocks unbounded roots even when capped elsewhere", () => {
	for (const cmd of [
		"find / -name x",
		"find /",
		"find ~ -name x",
		'find ~/ -name "*.so"',
		"find $HOME -name x",
		"find ${HOME} -name x",
		"x=$(find / -name a)",
		"echo start; find / -name x | head",
	]) {
		assert.ok(analyzeCommand(cmd, BFS).blockReason, `expected block: ${cmd}`);
	}
});

test("allows bounded scans", () => {
	for (const cmd of [
		"find . -name x",
		"find /tmp -name x",
		"find ~ -maxdepth 4 -name x",
		"find / -maxdepth 2 -name x",
		"find /usr/local/cuda -name x",
		"find ~/.cache/uv -maxdepth 3 -iname 'torch-*'",
	]) {
		assert.equal(analyzeCommand(cmd, BFS).blockReason, null, `expected allow: ${cmd}`);
	}
});

// ---------------------------------------------------------------------------
// analyzeCommand: rewriting

test("rewrites bounded find to bfs", () => {
	assert.equal(
		analyzeCommand("find . -name '*.py' | head", BFS).rewritten,
		`${BFS} . -name '*.py' | head`,
	);
	assert.equal(
		analyzeCommand('echo "$(find /tmp -maxdepth 1)"', BFS).rewritten,
		`echo "$(${BFS} /tmp -maxdepth 1)"`,
	);
	assert.equal(
		analyzeCommand("find /tmp -maxdepth 1; find /var -maxdepth 2", BFS).rewritten,
		`${BFS} /tmp -maxdepth 1; ${BFS} /var -maxdepth 2`,
	);
});

test("rewriting preserves the arguments byte for byte", () => {
	const cmd = `find ~/.cache/uv -maxdepth 3 -iname "torch-*" 2>/dev/null | head -5`;
	const { rewritten } = analyzeCommand(cmd, BFS);
	assert.equal(rewritten, cmd.replace("find", BFS));
});

test("leaves find-shaped text inside quotes alone", () => {
	assert.equal(analyzeCommand('echo "find /"', BFS).rewritten, null);
});

test("leaves non-find commands untouched", () => {
	assert.equal(analyzeCommand("ls -la", BFS).rewritten, null);
	assert.equal(analyzeCommand("grep -r foo .", BFS).rewritten, null);
});

// ---------------------------------------------------------------------------
// bfs unavailable: blocking still works, rewriting does not

test("without bfs, bounded scans pass through unchanged", () => {
	const { rewritten, blockReason } = analyzeCommand("find . -name x", null);
	assert.equal(rewritten, null);
	assert.equal(blockReason, null);
});

test("without bfs, unbounded scans are still blocked", () => {
	const { blockReason } = analyzeCommand("find / -name x", null);
	assert.ok(blockReason);
});
