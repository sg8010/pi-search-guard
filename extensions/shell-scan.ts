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
export function findCommandSegments(command: string, names: ReadonlySet<string>): CommandSegment[] {
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
