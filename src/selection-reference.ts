/** Zero-based position, as in `vscode.Position`. */
export interface ReferencePosition {
	line: number;
	character: number;
}

export interface ReferenceRange {
	start: ReferencePosition;
	end: ReferencePosition;
}

/**
 * Plain-text references to editor selections for Pi's prompt, one-based:
 *
 * - empty selection (cursor):            `/abs/file.ts:12`
 * - whole lines (columns at line edges): `/abs/file.ts:12-20` (or `:12` for one line)
 * - anything else:                       `/abs/file.ts:12:5-20:3` (end column inclusive)
 *
 * A selection ending at column 0 of a later line (as after selecting whole lines
 * with Shift+Down) ends on the previous line. Several selections are joined
 * with spaces, in document order and without duplicates.
 */
export function formatSelectionReference(
	path: string,
	ranges: readonly ReferenceRange[],
	lineLength: (line: number) => number,
): string {
	const sorted = [...ranges].sort(
		(a, b) => a.start.line - b.start.line || a.start.character - b.start.character,
	);
	const references = sorted.map((range) => `${path}:${formatRange(range, lineLength)}`);
	return [...new Set(references)].join(" ");
}

function formatRange(range: ReferenceRange, lineLength: (line: number) => number): string {
	const { start } = range;
	let { end } = range;
	if (start.line === end.line && start.character === end.character) return `${start.line + 1}`;
	if (end.character === 0 && end.line > start.line) {
		end = { line: end.line - 1, character: lineLength(end.line - 1) };
	}
	const wholeLines = start.character === 0 && end.character >= lineLength(end.line);
	if (wholeLines) {
		return start.line === end.line ? `${start.line + 1}` : `${start.line + 1}-${end.line + 1}`;
	}
	// The end position is exclusive, so its zero-based character is the inclusive
	// one-based column of the last selected character.
	const endColumn = Math.max(1, end.character);
	return `${start.line + 1}:${start.character + 1}-${end.line + 1}:${endColumn}`;
}
