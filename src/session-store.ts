import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const NEW_SESSION_TITLE = "New Session";

export interface PiSession {
	id: string;
	path: string;
	title: string;
	/** Working directory recorded in the transcript header (the folder Pi ran in). */
	cwd: string;
	createdAtMs: number;
	/**
	 * When the user last sent a prompt (falls back to creation time). Unlike the file
	 * mtime, this does not move while an agent streams output, so it gives the session
	 * list a stable order instead of reshuffling every time a running session writes.
	 */
	lastPromptAtMs: number;
	mtimeMs: number;
}

export interface SessionSearchOptions {
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	sessionDir?: string;
}

interface SessionHeader {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
}

interface CachedSession extends PiSession {
	size: number;
}

const MAX_CONCURRENT_SESSION_READS = 8;
const sessionCache = new Map<string, CachedSession>();

export function encodeWorkspaceDirectory(cwd: string): string {
	const normalized = resolve(cwd);
	return `--${normalized.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Sessions whose recorded cwd is one of `cwds` (each folder of a multi-root workspace),
 * newest prompt first.
 */
export async function listWorkspaceSessions(
	cwds: string | readonly string[],
	options: SessionSearchOptions = {},
): Promise<PiSession[]> {
	const search = await sessionSearch(cwds, options);
	const matches = await Promise.all(search.directories.map((directory) => readSessions(directory, search.cwds)));
	const unique = new Map<string, PiSession>();
	for (const session of matches.flat()) unique.set(session.path, session);
	return [...unique.values()].sort(compareSessions);
}

/** A session persists as its JSONL transcript plus a sidecar directory of the same name. */
export async function deleteSessionFiles(path: string): Promise<void> {
	if (!path.endsWith(".jsonl")) throw new Error(`Not a session transcript: ${path}`);
	await fs.rm(path, { force: true });
	await fs.rm(path.slice(0, -".jsonl".length), { recursive: true, force: true });
	sessionCache.delete(path);
}

export async function sessionDirectoriesForWorkspace(
	cwds: string | readonly string[],
	options: SessionSearchOptions = {},
): Promise<string[]> {
	return (await sessionSearch(cwds, options)).directories;
}

async function sessionSearch(
	cwds: string | readonly string[],
	options: SessionSearchOptions,
): Promise<{ cwds: string[]; directories: string[] }> {
	const roots = await Promise.all(
		(typeof cwds === "string" ? [cwds] : [...cwds]).map((cwd) => fs.realpath(cwd).catch(() => resolve(cwd))),
	);
	const workspaceCwds = [...new Set(roots)];
	const env = options.env ?? process.env;
	const agentDir = expandHome(options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const configuredSessionDir = options.sessionDir ?? env.PI_CODING_AGENT_SESSION_DIR;
	const directories = configuredSessionDir
		? [expandHome(configuredSessionDir)]
		: workspaceCwds.flatMap((cwd) => [
				join(agentDir, "sessions", encodeWorkspaceDirectory(cwd)),
				join(agentDir, "session", encodeWorkspaceDirectory(cwd)),
			]);
	return { cwds: workspaceCwds, directories: [...new Set(directories)] };
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return resolve(value);
}

async function readSessions(directory: string, cwds: readonly string[]): Promise<PiSession[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(directory, entry.name));
		return readSessionsWithConcurrency(paths, cwds);
	} catch {
		return [];
	}
}

async function readSessionsWithConcurrency(paths: string[], cwds: readonly string[]): Promise<PiSession[]> {
	const sessions: PiSession[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < paths.length) {
			const path = paths[next++];
			if (!path) continue;
			try {
				const session = await readSession(path, cwds);
				if (session) sessions.push(session);
			} catch {
				// A session may be deleted or still being written while we scan it.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(paths.length, MAX_CONCURRENT_SESSION_READS) }, worker));
	return sessions;
}

async function readSession(path: string, cwds: readonly string[]): Promise<PiSession | undefined> {
	const stat = await fs.stat(path);
	const inWorkspace = (cwd: string) => cwds.some((candidate) => samePath(cwd, candidate));
	const cached = sessionCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return inWorkspace(cached.cwd) ? cached : undefined;
	}

	const parsed = await parseSession(path);
	if (!parsed || !inWorkspace(parsed.cwd)) return undefined;
	const createdAtMs = sessionCreatedAt(parsed.header, stat.birthtimeMs || stat.mtimeMs);
	const session: CachedSession = {
		id: parsed.id,
		path,
		title: parsed.title,
		cwd: parsed.cwd,
		createdAtMs,
		lastPromptAtMs: parsed.lastPromptAtMs ?? createdAtMs,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
	};
	sessionCache.set(path, session);
	return session;
}

async function parseSession(
	path: string,
): Promise<{ header: SessionHeader; id: string; cwd: string; title: string; lastPromptAtMs?: number } | undefined> {
	let header: SessionHeader | undefined;
	let lastPromptAtMs: number | undefined;
	let sessionInfoName: string | undefined;
	let firstUserText: string | undefined;
	const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		const entry = parseLine(line);
		if (!entry) continue;
		if (!header) {
			if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") return undefined;
			header = entry;
			continue;
		}
		if (entry.type === "session_info") sessionInfoName = sessionTitle(entry.name) ?? sessionInfoName;
		if (entry.type === "message" && isUserMessage(entry.message)) {
			const promptAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			if (Number.isFinite(promptAt) && (lastPromptAtMs === undefined || promptAt > lastPromptAtMs)) lastPromptAtMs = promptAt;
			if (!firstUserText) {
				const text = extractUserMessageText(entry.message.content);
				if (text.trim()) firstUserText = text;
			}
		}
	}
	if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
	return {
		header,
		id: header.id,
		cwd: header.cwd,
		title: sessionInfoName ?? (firstUserText ? deriveTitle(firstUserText) : NEW_SESSION_TITLE),
		lastPromptAtMs,
	};
}

function parseLine(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const entry = JSON.parse(line) as unknown;
		return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function sessionTitle(name: unknown): string | undefined {
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function isUserMessage(message: unknown): message is { role: unknown; content: unknown } {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "user";
}

function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function deriveTitle(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}

function sessionCreatedAt(header: SessionHeader, fallback: number): number {
	const timestamp = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

/** Newest prompt first; ties (and sessions never prompted) fall back to creation time, then id. */
export function compareSessions(a: PiSession, b: PiSession): number {
	return b.lastPromptAtMs - a.lastPromptAtMs || b.createdAtMs - a.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function samePath(a: string, b: string): boolean {
	const left = resolve(a);
	const right = resolve(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
