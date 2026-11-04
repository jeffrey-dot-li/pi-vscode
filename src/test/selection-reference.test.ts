import assert from "node:assert/strict";
import test from "node:test";
import { formatSelectionReference, type ReferenceRange } from "../selection-reference";

const lines = ["const a = 1;", "", "function f() {", "  return a;", "}"];
const lineLength = (line: number) => lines[line]?.length ?? 0;
const range = (sl: number, sc: number, el: number, ec: number): ReferenceRange => ({
	start: { line: sl, character: sc },
	end: { line: el, character: ec },
});
const format = (...ranges: ReferenceRange[]) => formatSelectionReference("/repo/a.ts", ranges, lineLength);

test("a cursor without a selection references its line", () => {
	assert.equal(format(range(3, 4, 3, 4)), "/repo/a.ts:4");
});

test("whole-line selections reference line numbers only", () => {
	assert.equal(format(range(2, 0, 4, 1)), "/repo/a.ts:3-5");
	assert.equal(format(range(0, 0, 0, 12)), "/repo/a.ts:1");
	// Shift+Down style: ends at column 0 of the following line.
	assert.equal(format(range(2, 0, 4, 0)), "/repo/a.ts:3-4");
	assert.equal(format(range(3, 0, 4, 0)), "/repo/a.ts:4");
});

test("partial selections include one-based, inclusive columns", () => {
	assert.equal(format(range(3, 9, 3, 10)), "/repo/a.ts:4:10-4:10");
	assert.equal(format(range(0, 6, 3, 8)), "/repo/a.ts:1:7-4:8");
	assert.equal(format(range(0, 6, 2, 0)), "/repo/a.ts:1:7-2:1");
});

test("multiple selections are ordered and deduplicated", () => {
	assert.equal(format(range(3, 0, 3, 11), range(0, 0, 0, 12), range(3, 0, 3, 11)), "/repo/a.ts:1 /repo/a.ts:4");
});
