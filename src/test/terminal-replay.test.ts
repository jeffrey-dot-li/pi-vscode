import assert from "node:assert/strict";
import test from "node:test";
import { Terminal } from "@xterm/headless";
import { TerminalReplay } from "../terminal-replay";

test("serializes a PTY screen and exposes an exact output watermark", async () => {
	const replay = new TerminalReplay(20, 4, 10);
	assert.equal(replay.write("first\r\n\x1b[31msecond\x1b[0m"), 1);
	assert.equal(replay.write("\r\nthird\x1b[2;4H!"), 2);

	const snapshot = await replay.snapshot();
	assert.equal(snapshot.sequence, 2);

	const restored = new Terminal({ cols: 20, rows: 4, scrollback: 10 });
	await write(restored, snapshot.data);
	assert.equal(restored.buffer.active.getLine(0)?.translateToString(true), "first");
	assert.equal(restored.buffer.active.getLine(1)?.translateToString(true), "sec!nd");
	assert.equal(restored.buffer.active.getLine(2)?.translateToString(true), "third");
	assert.equal(restored.buffer.active.cursorX, 4);
	assert.equal(restored.buffer.active.cursorY, 1);

	restored.dispose();
	replay.dispose();
});

test("snapshot waits for writes queued while xterm is parsing", async () => {
	const replay = new TerminalReplay(12, 3, 3);
	for (let index = 0; index < 20; index++) replay.write(`${index}\r\n`);
	const snapshot = await replay.snapshot();
	assert.equal(snapshot.sequence, 20);
	assert.ok(snapshot.data.includes("19"));
	replay.dispose();
});

test("replays Kitty keyboard mode that addon-serialize does not preserve", async () => {
	const replay = new TerminalReplay();
	replay.write("\x1b[>7");
	replay.write("uhello");
	const snapshot = await replay.snapshot();
	assert.ok(snapshot.data.includes("\x1b[>7u"));
	const restored = kittyTerminal();
	await write(restored, snapshot.data);
	assert.equal(kittyFlags(restored), 7);
	replay.dispose();
});

for (const [order, output] of [
	["pushed before entering the alternate screen", "\x1b[>7u\x1b[?1049hfullscreen"],
	["pushed on the alternate screen", "\x1b[?1049h\x1b[>7ufullscreen"],
] as const) {
	test(`replays Kitty keyboard flags on the screen they were ${order}`, async () => {
		// xterm keeps separate flags for the normal and alternate screens. Pi's fullscreen
		// TUI reads plain ESC CR as Shift+Enter once Kitty is negotiated, so replaying the
		// push onto the wrong screen turned Option+Enter into a newline.
		const replay = new TerminalReplay(20, 4, 10);
		replay.write(output);
		const live = kittyTerminal();
		await write(live, output);

		const restored = kittyTerminal();
		await write(restored, (await replay.snapshot()).data);
		assert.equal(restored.buffer.active.type, "alternate");
		assert.equal(kittyFlags(restored), kittyFlags(live));
		await write(live, "\x1b[?1049l");
		await write(restored, "\x1b[?1049l");
		assert.equal(kittyFlags(restored), kittyFlags(live));
		replay.dispose();
	});
}

test("replays the SGR mouse encoding that addon-serialize does not preserve", async () => {
	const replay = new TerminalReplay();
	// Pi's fullscreen TUI: alt screen plus button/drag tracking, focus and SGR encoding,
	// with the sequence split across two PTY data callbacks.
	replay.write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?10");
	replay.write("04h\x1b[?1006htranscript");
	const enabled = (await replay.snapshot()).data;
	assert.ok(enabled.includes("\x1b[?1002h"), "tracking mode is replayed");
	assert.ok(enabled.endsWith("\x1b[?1006h"), "SGR encoding is replayed after the tracking mode");

	replay.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l");
	assert.ok(!(await replay.snapshot()).data.includes("\x1b[?1006h"), "disabling SGR encoding is honoured");

	replay.write("\x1b[?1002;1006h");
	assert.ok((await replay.snapshot()).data.endsWith("\x1b[?1006h"), "combined DECSET parameters are tracked");
	replay.dispose();
});

test("maps every hard-wrapped path fragment back to the complete native terminal link", async () => {
	const replay = new TerminalReplay(24, 5, 10);
	const target = "/workspace/docs/architecture/native-terminal.md";
	const width = 22;
	const rows = [];
	for (let offset = 0; offset < target.length; offset += width) rows.push(` ${target.slice(offset, offset + width)} `);
	replay.write(rows.join("\r\n"));

	for (let index = 0; index < rows.length; index++) {
		assert.deepEqual(await replay.linksForLine(rows[index]), [
			{ startIndex: 1, length: Math.min(width, target.length - index * width), target, kind: "file" },
		]);
	}
	replay.dispose();
});

function write(terminal: Terminal, data: string): Promise<void> {
	return new Promise((resolve) => terminal.write(data, resolve));
}

function kittyTerminal(): Terminal {
	return new Terminal({ cols: 20, rows: 4, scrollback: 10, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
}

/** Active Kitty keyboard flags; xterm exposes them only on its core service. */
function kittyFlags(terminal: Terminal): number {
	return (terminal as unknown as { _core: { coreService: { kittyKeyboard: { flags: number } } } })._core.coreService
		.kittyKeyboard.flags;
}
