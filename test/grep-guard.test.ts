/**
 * Tests for grep-guard.
 *
 *   node --experimental-strip-types --test test/grep-guard.test.ts
 *   bun test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	analyzeCommand,
	BLOCK_REASON,
	findGatedGrep,
	hasDirectoryOperand,
	isGlob,
	parseGrepCall,
	resolveOperand,
	type StatKind,
} from "../extensions/grep-guard.ts";

const RG = "/usr/bin/rg";
const CWD = "/proj";
const HOME = "/home/u";

const TREE: Record<string, StatKind> = {
	"/proj": "dir",
	"/proj/src": "dir",
	"/proj/a.txt": "file",
	"/proj/b.txt": "file",
	"/home/u": "dir",
	"/home/u/.cache": "dir",
	"/home/u/.pi": "dir",
};
const stat = (p: string): StatKind => TREE[p] ?? "none";

// ---------------------------------------------------------------------------
// Classification: recursion and operands

test("detects recursion in every form", () => {
	for (const args of [
		"-r foo",
		"-R foo",
		"-rn foo .",
		"-nr foo .",
		"--recursive foo",
		"--dereference-recursive foo",
		"-d recurse foo",
		"--directories=recurse foo",
	]) {
		assert.equal(parseGrepCall(args).recursive, true, `expected recursive: ${args}`);
	}
});

test("splits operands into pattern and paths", () => {
	assert.deepEqual(parseGrepCall("foo").paths, []);
	assert.deepEqual(parseGrepCall("foo -").paths, []);
	assert.deepEqual(parseGrepCall("foo a.txt").paths, ["a.txt"]);
	assert.deepEqual(parseGrepCall("foo a.txt b.txt").paths, ["a.txt", "b.txt"]);
	assert.deepEqual(parseGrepCall("-e foo file.txt").paths, ["file.txt"]);
	assert.deepEqual(parseGrepCall("-f pats").paths, []);
	assert.deepEqual(parseGrepCall("-m 3 foo").paths, []);
	assert.deepEqual(parseGrepCall("--include=*.py foo dir").paths, ["dir"]);
});

// ---------------------------------------------------------------------------
// Directory detection

test("isGlob spots shell globs", () => {
	for (const g of ["*.py", "a?.txt", "[ab].c", "{a,b}"]) assert.equal(isGlob(g), true, g);
	for (const f of ["a.txt", "src", ".", "~/x"]) assert.equal(isGlob(f), false, f);
});

test("resolveOperand expands ~/$HOME and resolves relative paths", () => {
	assert.equal(resolveOperand("~/x", CWD, HOME), "/home/u/x");
	assert.equal(resolveOperand("$HOME/x", CWD, HOME), "/home/u/x");
	assert.equal(resolveOperand("~", CWD, HOME), "/home/u");
	assert.equal(resolveOperand("src", CWD, HOME), "/proj/src");
	assert.equal(resolveOperand("/abs", CWD, HOME), "/abs");
});

test("hasDirectoryOperand only fires on existing directories", () => {
	assert.equal(hasDirectoryOperand(["a.txt"], CWD, HOME, stat), false);
	assert.equal(hasDirectoryOperand(["a.txt", "b.txt"], CWD, HOME, stat), false);
	assert.equal(hasDirectoryOperand(["src"], CWD, HOME, stat), true);
	assert.equal(hasDirectoryOperand(["."], CWD, HOME, stat), true);
	assert.equal(hasDirectoryOperand(["~/.cache"], CWD, HOME, stat), true);
	assert.equal(hasDirectoryOperand(["missing"], CWD, HOME, stat), false); // unknown -> treated as file
	assert.equal(hasDirectoryOperand(["*.py"], CWD, HOME, stat), false); // glob -> unknowable
});

// ---------------------------------------------------------------------------
// The gate

test("gates recursive and directory searches", () => {
	const cases: Array<[string, "recursive" | "directory"]> = [
		["grep -rn x src", "recursive"],
		["grep -r x a.txt", "recursive"], // recursion wins even over a file
		["grep x src/", "directory"],
		["grep x src", "directory"],
		["grep x .", "directory"],
		["grep x ~/.cache", "directory"],
		["egrep x src", "directory"],
		["cd /home/u && grep x .cache", "directory"],
		["ps aux | grep bar; grep x src", "directory"],
	];
	for (const [cmd, reason] of cases) {
		const hit = findGatedGrep(cmd, CWD, HOME, stat);
		assert.equal(hit?.reason, reason, cmd);
		assert.ok(hit?.name, cmd);
	}
});

test("lets single files, globs, stdin and data through", () => {
	for (const cmd of [
		"grep x a.txt",
		"grep x a.txt b.txt",
		"grep x missing.txt",
		"grep x '*.py'",
		"grep foo",
		"grep -e foo",
		"ps aux | grep python",
		"ldconfig -p | grep cudnn",
		`echo "grep -rn x ."`,
		"/usr/bin/grep -rn x .",
		"rg -n x src",
	]) {
		assert.equal(findGatedGrep(cmd, CWD, HOME, stat), null, `expected pass: ${cmd}`);
	}
});

test("treats heredoc bodies as data", () => {
	const quoted = ["cat <<'EOF'", "grep -rn x src", "EOF"].join("\n");
	assert.equal(findGatedGrep(quoted, CWD, HOME, stat), null);

	const unquoted = ["cat <<EOF", "grep x .", "EOF", "grep x a.txt"].join("\n");
	assert.equal(findGatedGrep(unquoted, CWD, HOME, stat), null);
});

// ---------------------------------------------------------------------------
// analyzeCommand

test("analyzeCommand blocks gated greps and allows the rest", () => {
	for (const cmd of ["grep -rn x src", "grep x src/", "grep x ."]) {
		const { blocked, blockReason } = analyzeCommand(cmd, RG, CWD, HOME, stat);
		assert.equal(blocked, true, `expected block: ${cmd}`);
		assert.match(blockReason ?? "", /ripgrep/);
	}
	for (const cmd of ["grep x a.txt", "ps aux | grep python", "grep foo"]) {
		assert.equal(analyzeCommand(cmd, RG, CWD, HOME, stat).blocked, false, `expected pass: ${cmd}`);
	}
});

test("allows grep through when rg is not installed", () => {
	const { blocked, blockReason } = analyzeCommand("grep -rn x src", null, CWD, HOME, stat);
	assert.equal(blocked, false);
	assert.equal(blockReason, null);
});

test("the block reason explains the translation and the flag collisions", () => {
	assert.match(BLOCK_REASON, /rg -n foo dir/);
	assert.match(BLOCK_REASON, /cmd \| grep x/);
	for (const flag of ["--replace", "--encoding", "--case-sensitive", "--follow"]) {
		assert.match(BLOCK_REASON, new RegExp(flag), `expected ${flag} in the block reason`);
	}
	assert.match(BLOCK_REASON, /--hidden --no-ignore/);
});
