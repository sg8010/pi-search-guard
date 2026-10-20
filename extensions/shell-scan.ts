/**
 * Shared shell-aware scanning helpers for the search guards.
 *
 * The model writes shell one-liners, not shell scripts, so a full parser would
 * be overkill (and would misread ordinary quoted text often enough to be worse
 * than the simple scanner below). Instead we track quote state and report a
 * command name only when it sits in command position.
 */

/** A command invocation found in a command, plus the offset of that token. */
export interface CommandSegment {
	/** the matched command name, e.g. "find" or "grep" */
	name: string;
	/** absolute offset of the command name token within the original command */
	offset: number;
	/** everything after the command name, up to the next command separator */
	args: string;
}

const WRAPPERS = new Set(["command", "sudo", "env", "nice", "nohup", "timeout", "stdbuf"]);

// ---------------------------------------------------------------------------
// Heredocs
//
// A heredoc body is data, not shell code: in
//
//   git commit -F - <<'EOF'
//   find -> bfs
//   EOF
//
// that `find` is text to be written, not a command to run. The scanner below
// would otherwise read it as a command. So before scanning we blank out heredoc
// bodies, preserving length (and therefore every offset).
//
// An unquoted delimiter (`<<EOF`) still expands command substitutions in the
// body, so `$(...)` and backtick regions are kept; everything else is data.

interface Heredoc {
	delimiter: string;
	/** true when the delimiter was quoted, which makes the whole body literal */
	literal: boolean;
	/** `<<-` strips leading tabs from the terminator line */
	stripTabs: boolean;
}

/** Replace a range with spaces, keeping length. Newlines stay put. */
function blank(chars: string[], from: number, to: number): void {
	for (let i = from; i < to && i < chars.length; i++) {
		if (chars[i] !== "\n") chars[i] = " ";
	}
}

/**
 * Read the delimiter after a `<<` / `<<-` operator at `open`. Returns null when
 * this `<<` is not a heredoc, e.g. an arithmetic shift in `$((1 << 2))`.
 */
function readHeredocOperator(
	command: string,
	open: number,
): { heredoc: Heredoc; next: number } | null {
	let j = open + 2;
	let stripTabs = false;
	if (command[j] === "-") {
		stripTabs = true;
		j++;
	}
	while (command[j] === " " || command[j] === "\t") j++;

	let delimiter = "";
	let literal = false;
	if (command[j] === "'" || command[j] === '"') {
		const quote = command[j];
		const end = command.indexOf(quote, j + 1);
		if (end === -1) return null;
		delimiter = command.slice(j + 1, end);
		literal = true;
		j = end + 1;
	} else if (command[j] === "\\") {
		delimiter = command[j + 1] ?? "";
		literal = true;
		j += 2;
	} else {
		let k = j;
		while (k < command.length && !/[\s;|&()<>\n\r]/.test(command[k])) k++;
		delimiter = command.slice(j, k);
		j = k;
	}

	if (delimiter.length === 0) return null;
	// In `$((1 << 2))` the word after `<<` is followed by the arithmetic close paren.
	if (command[j] === ")") return null;
	return { heredoc: { delimiter, literal, stripTabs }, next: j };
}

/** Index of the `)` matching the `(` at `open`, quote-aware; -1 when unclosed. */
function matchParen(text: string, open: number, to: number): number {
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	for (let i = open; i < to; i++) {
		const ch = text[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = !inDouble;
			continue;
		}
		if (inDouble) continue;
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Ranges [start, end) of command substitutions `$(...)` and backticks in text. */
function substitutionRanges(text: string, from: number, to: number): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (let i = from; i < to; i++) {
		const ch = text[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const end = matchParen(text, i + 1, to);
			if (end !== -1) {
				ranges.push([i, end + 1]);
				i = end;
			}
			continue;
		}
		if (ch === "`") {
			let k = i + 1;
			while (k < to && text[k] !== "`") {
				if (text[k] === "\\") k++;
				k++;
			}
			if (k < to) {
				ranges.push([i, k + 1]);
				i = k;
			}
		}
	}
	return ranges;
}

/** Blank one heredoc body; returns the offset just past its terminator line. */
function maskHeredocBody(command: string, chars: string[], start: number, hd: Heredoc): number {
	let lineStart = start;
	while (lineStart <= command.length) {
		let lineEnd = command.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = command.length;
		let line = command.slice(lineStart, lineEnd);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const probe = hd.stripTabs ? line.replace(/^\t+/, "") : line;

		if (probe === hd.delimiter) {
			blank(chars, lineStart, lineEnd);
			return lineEnd < command.length ? lineEnd + 1 : lineEnd;
		}

		if (hd.literal) {
			blank(chars, lineStart, lineEnd);
		} else {
			// Keep `$(...)` / backticks, blank the literal text around them.
			let cursor = lineStart;
			for (const [s, e] of substitutionRanges(command, lineStart, lineEnd)) {
				blank(chars, cursor, s);
				cursor = e;
			}
			blank(chars, cursor, lineEnd);
		}

		if (lineEnd >= command.length) return command.length;
		lineStart = lineEnd + 1;
	}
	return command.length;
}

/**
 * Blank out heredoc bodies so they are not read as shell code. Length is
 * preserved, so offsets into the result match the original command.
 */
export function maskHeredocBodies(command: string): string {
	if (!command.includes("<<")) return command;
	const chars = command.split("");
	let inSingle = false;
	let inDouble = false;
	const pending: Heredoc[] = [];

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = !inDouble;
			continue;
		}
		if (!inDouble && ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const op = readHeredocOperator(command, i);
			if (op) {
				pending.push(op.heredoc);
				i = op.next - 1;
				continue;
			}
		}
		if (ch === "\n" && pending.length > 0) {
			let cursor = i + 1;
			while (pending.length > 0) {
				cursor = maskHeredocBody(command, chars, cursor, pending.shift() as Heredoc);
			}
			i = cursor - 1;
		}
	}
	return chars.join("");
}

/**
 * Locate every `name` that actually executes as a command.
 *
 * Only reports a name when it sits in command position: at the start, or right
 * after ; | & ( ` newline, which covers:   cmd; grep ..   a | grep ..
 * $(grep ..)   `grep ..` and the wrapper forms `command grep`, `sudo grep`, ...
 *
 * Plain text inside quotes (e.g. echo "grep -r /") is skipped, but command
 * substitution inside double quotes ("$(grep ..)") is still detected.
 */
export function findCommandSegments(rawCommand: string, names: ReadonlySet<string>): CommandSegment[] {
	// Heredoc bodies are data; blank them first, keeping offsets intact.
	const command = maskHeredocBodies(rawCommand);
	const out: CommandSegment[] = [];
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle) continue;

		// match a command name as a whole word
		let name: string | null = null;
		for (const candidate of names) {
			if (!command.startsWith(candidate, i)) continue;
			const next = command[i + candidate.length];
			if (next !== undefined && !/[\s;|&)`\n\r]/.test(next)) continue;
			name = candidate;
			break;
		}
		if (name === null) continue;

		// walk back over blanks/escapes to the previous significant char
		let j = i - 1;
		while (j >= 0 && (command[j] === " " || command[j] === "\t" || command[j] === "\\")) j--;
		const prev = j >= 0 ? command[j] : "";

		let inCommandPosition = prev === "" || /[;|&(`\n\r]/.test(prev);
		if (!inCommandPosition && /[\w-]/.test(prev)) {
			// maybe a wrapper word: `command grep`, `sudo grep`, ...
			let w = j;
			while (w >= 0 && /[\w-]/.test(command[w])) w--;
			const word = command.slice(w + 1, j + 1);
			if (WRAPPERS.has(word)) {
				inCommandPosition = true;
			} else if (/^\d+[smhd]?$/.test(word)) {
				// `timeout 20 grep ...` — skip the duration and look for the wrapper
				let w2 = w;
				while (w2 >= 0 && (command[w2] === " " || command[w2] === "\t")) w2--;
				let w3 = w2;
				while (w3 >= 0 && /[\w-]/.test(command[w3])) w3--;
				inCommandPosition = WRAPPERS.has(command.slice(w3 + 1, w2 + 1));
			}
		}
		if (!inCommandPosition) continue;

		// Inside double quotes only a command substitution is live, i.e. "$(grep ..)".
		if (inDouble && prev !== "(" && prev !== "`") continue;

		// arguments run to the next command separator
		let k = i + name.length;
		while (k < command.length && !/[;|&\n\r)`]/.test(command[k])) k++;

		out.push({ name, offset: i, args: command.slice(i + name.length, k) });
		i = k - 1;
	}
	return out;
}

/**
 * Dominant root paths that make a scan effectively unbounded when walked
 * recursively: `/`, `//`, `~`, `~/`, `$HOME`, `${HOME}`, and globs of those.
 */
export function isUnboundedRootToken(token: string): boolean {
	const cleaned = token.replace(/^["']|["']$/g, "");
	if (cleaned === "/" || cleaned === "//") return true;
	if (/^\/\*+$/.test(cleaned)) return true;
	if (cleaned === "~" || cleaned === "~/" || /^~\/\*+$/.test(cleaned)) return true;
	if (cleaned === "$HOME" || cleaned === "${HOME}") return true;
	if (cleaned === "$HOME/" || cleaned === "${HOME}/") return true;
	if (/^\$(?:\{)?HOME(?:\})?\/\*+$/.test(cleaned)) return true;
	return false;
}
