import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, promises as fs, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as pty from "node-pty";
import * as vscode from "vscode";
import {
	createForkedSession,
	appendSessionName,
	createNativeDraftFile,
	listSessionUserMessages,
	prepareRewindSession,
	removeNativeDraftFile,
	resolveSessionSnapshot,
	restoreWorktreeSnapshot,
	rewriteSessionFile,
	sanitizeSessionName,
	worktreeDiffersFromSnapshot,
} from "./session-actions";
import {
	deleteSessionFiles,
	listWorkspaceSessions,
	NEW_SESSION_TITLE,
	compareSessions,
	samePath,
	sessionDirectoriesForWorkspace,
	type PiSession,
} from "./session-store";
import {
	becameIdle,
	PiStatusBridge,
	type PiForkRequest,
	type PiPanelRequest,
	type PiSessionState,
	type PiStatusReport,
} from "./status-bridge";
import { piCommandArgs, piTuiModeArgs, win32Spawn } from "./pi-command";
import { formatSelectionReference } from "./selection-reference";
import { PiPseudoterminal } from "./native-terminal";
import { httpUrl, resolveFileLink } from "./terminal-links";
import { TerminalReplay } from "./terminal-replay";
import { closeOpened, normalizeViewState, setArchived, setPinned, type PiViewState } from "./view-state";
import { normalizePiTerminalCopy } from "./terminal-copy";

interface RunningSession {
	tabId: string;
	sessionId: string;
	/** Folder Pi runs in; one of the workspace folders. */
	cwd: string;
	startedAtMs: number;
	title: string;
	path?: string;
	leafId?: string;
	/** True only while this session is bound to the shared Terminal Editor. */
	attached: boolean;
	/** Agent-created panels run without joining the opened list. */
	unlisted?: boolean;
	process: pty.IPty;
	replay: TerminalReplay;
	cols: number;
	rows: number;
}

interface StartSessionOptions {
	draftFile?: string;
	nativeDraftFile?: string;
	reportError?: boolean;
	/** Agent-created panels open in the background without stealing focus. */
	noFocus?: boolean;
	/** Run the session without creating a Terminal Editor presentation. */
	noPresentation?: boolean;
	/** Passed to `pi --model` for agent-created panels. */
	model?: string;
	/** Keep this session out of the opened list (agent-created panels). */
	unlisted?: boolean;
	/**
	 * Folder to run Pi in. Defaults to the cwd recorded for the session (transcript
	 * header or restored tab), so only brand-new sessions need to pass it.
	 */
	cwd?: string;
}

interface WorkspaceRoot {
	name: string;
	path: string;
}

/** Every folder of the (possibly multi-root) workspace, in workspace order. */
function workspaceRoots(): WorkspaceRoot[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter((folder) => folder.uri.scheme === "file" && Boolean(folder.uri.fsPath))
		.map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}

interface PanelWaiter {
	tabId: string;
	resolve: () => void;
}

class PiTerminalLink extends vscode.TerminalLink {
	constructor(
		startIndex: number,
		length: number,
		readonly kind: "file" | "url",
		readonly target: string,
		/** Relative file links resolve against the folder of the session that printed them. */
		readonly cwd: string,
	) {
		super(startIndex, length, target);
	}
}

type SessionHistoryAction = "fork" | "rewind";

type ClientMessage =
	| { type: "ready" }
	| { type: "new" }
	| { type: "customize" }
	| { type: "refresh" }
	| { type: "resume"; id: string }
	| { type: "detach"; id: string }
	| { type: "shutdown"; id: string }
	| { type: "delete"; id: string }
	| { type: "archive"; id: string; archived: boolean }
	| { type: "pin"; id: string; pinned: boolean }
	| { type: "close"; id: string }
	| { type: "rename"; id: string }
	| { type: "load-user-messages"; action: SessionHistoryAction; id: string; requestId: string }
	| { type: "session-history-action"; action: SessionHistoryAction; id: string; entryId?: string };

const PI_VIEW_ID = "piAgent.view";
const PI_CONTAINER_COMMAND = "workbench.view.extension.piAgent";
const PI_CLOSE_SESSION_OR_VIEW_COMMAND = "piAgent.closeSessionOrView";
const PI_VIEW_STATE_KEY = "piAgent.viewState";
const PI_LAST_FOLDER_KEY = "piAgent.lastNewSessionFolder";
const PI_FORK_DRAFT_FILE_ENV = "PI_VSCODE_FORK_DRAFT_FILE";
const PI_NATIVE_DRAFT_FILE_ENV = "PI_VSCODE_DRAFT_FILE";
const SESSION_ACTION_DISABLED_MESSAGE = "Available until session is done";
const DEFAULT_PI_COMMAND = "pi";
/** Like herdr's agent prompt stall check: a prompted panel must show activity within this window. */
const PANEL_STALL_MS = 15_000;
const PANEL_READY_TIMEOUT_MS = 30_000;
const DEFAULT_PANEL_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_PANEL_WAIT_TIMEOUT_MS = 2 * 3_600_000;
let ptyPrepared = false;
let piViewProvider: PiViewProvider | undefined;
/** Command resolved by auto-detection; used until the user sets piAgent.command explicitly. */
let resolvedPiCommand: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const provider = new PiViewProvider(context.extensionUri, context.workspaceState);
	piViewProvider = provider;
	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(PI_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("piAgent.open", () => provider.open()),
		vscode.commands.registerCommand("piAgent.newSession", () => provider.newSession()),
		vscode.commands.registerCommand("piAgent.toggleTerminal", () => provider.toggleTerminal()),
		vscode.commands.registerCommand("piAgent.searchSessions", () => provider.searchSessions()),
		vscode.commands.registerCommand("piAgent.addSelectionToPrompt", () => provider.addSelectionToPrompt()),
		vscode.commands.registerCommand("piAgent.nextSession", () => provider.cycleSession(1)),
		vscode.commands.registerCommand("piAgent.previousSession", () => provider.cycleSession(-1)),
		vscode.commands.registerCommand(PI_CLOSE_SESSION_OR_VIEW_COMMAND, () => provider.closeSessionOrView()),
		vscode.commands.registerCommand("piAgent.copyTerminalSelection", () => provider.copyTerminalSelection()),
	);
}

export function deactivate(): void {
	piViewProvider?.dispose();
	piViewProvider = undefined;
}

/** The workspace folder of the focused editor, if it belongs to one. */
function activeEditorRoot(): string | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (!activeEditor) return undefined;
	const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
	return folder?.uri.scheme === "file" && folder.uri.fsPath ? folder.uri.fsPath : undefined;
}

class PiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private manager: PiSessionManager | undefined;
	private disposed = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly memento: vscode.Memento,
	) {}

	async open(): Promise<void> {
		if (!workspaceRoots().length) {
			await vscode.window.showErrorMessage("Pi needs an open workspace folder.");
			return;
		}

		await vscode.commands.executeCommand(PI_CONTAINER_COMMAND);
		this.view?.show();
		this.createManager();
	}

	closeSessionOrView(): void {
		this.manager?.closeActiveSessionOrView();
	}

	/** Show the next (1) or previous (-1) open session, like ⌘⇧] / ⌘⇧[ between editors. */
	async cycleSession(step: 1 | -1): Promise<void> {
		if (!this.manager) {
			await this.open();
			return;
		}
		this.manager.cycleSession(step);
	}

	/**
	 * Insert a text reference to the active editor's selections (absolute path plus
	 * one-based lines/columns) into the shown Pi session's prompt and focus it, like
	 * Cursor's Cmd+I. Nothing is submitted.
	 */
	async addSelectionToPrompt(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const document = editor.document;
		if (document.isUntitled || document.uri.scheme === "untitled") {
			void vscode.window.showInformationMessage("Save the file first so Pi can reference it by path.");
			return;
		}
		const path = document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString();
		const reference = formatSelectionReference(path, editor.selections, (line) => document.lineAt(line).text.length);
		if (!this.manager) await this.open();
		await this.manager?.insertIntoPrompt(`${reference} `);
	}

	/** Reveal the session list on its All sessions page with the search box focused. */
	async searchSessions(): Promise<void> {
		await this.open();
		this.manager?.showPage("all");
	}

	/** Show or hide the session terminal editor, like toggling the bottom terminal panel. */
	async toggleTerminal(): Promise<void> {
		if (!this.manager) {
			// Opening the view restores (and presents) the sessions that were open.
			await this.open();
			return;
		}
		await this.manager.toggleTerminal();
	}

	async copyTerminalSelection(): Promise<void> {
		if (this.manager) await this.manager.copyTerminalSelection();
		else await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
	}

	async newSession(): Promise<void> {
		if (!this.manager) {
			await this.open();
			return;
		}
		void this.manager.startNewSession();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		if (this.disposed) return;
		this.view = webviewView;
		this.createManager();
		this.manager?.attachView(webviewView);
		webviewView.onDidDispose(() => {
			if (this.view !== webviewView) return;
			this.view = undefined;
			this.manager?.detachView(webviewView);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.manager?.dispose();
		this.manager = undefined;
		this.view = undefined;
	}

	private createManager(): void {
		if (this.disposed || this.manager) return;
		if (!workspaceRoots().length) {
			if (this.view) this.view.webview.html = "<!doctype html><body>Open a workspace folder to use Pi.</body>";
			return;
		}

		this.manager = new PiSessionManager(this.extensionUri, this.memento);
	}
}

class PiSessionManager implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly viewDisposables: vscode.Disposable[] = [];
	private readonly sessions = new Map<string, RunningSession>();
	private readonly history = new Map<string, PiSession>();
	/** Names given to running sessions Pi has not written to disk yet. */
	private readonly renamedTitles = new Map<string, string>();
	private readonly sessionStates = new Map<string, PiSessionState>();
	private readonly statusSequences = new Map<string, { sourceId: string; seq: number }>();
	private readonly historyWatchers = new Map<string, FSWatcher>();
	private readonly tabStates = new Map<string, { state: PiSessionState; changedAtMs: number }>();
	private readonly panelWaiters = new Set<PanelWaiter>();
	private readonly replacingProcesses = new Set<pty.IPty>();
	private readonly sessionActions = new Set<string>();
	private readonly pendingStarts: Array<{ id: string; sessionPath?: string; options?: StartSessionOptions }> = [];
	private readonly statusBridge: PiStatusBridge;
	private viewState: PiViewState;
	private terminal: vscode.Terminal | undefined;
	private pseudoterminal: PiPseudoterminal | undefined;
	private presentedSession: RunningSession | undefined;
	private terminalEditorGroup: vscode.TabGroup | undefined;
	private terminalEditorViewColumn: vscode.ViewColumn | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private recoveringStart = false;
	private historyWatchSyncing = false;
	private statusBridgeReady = false;
	private view: vscode.WebviewView | undefined;
	private viewReady = false;
	private disposed = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly memento: vscode.Memento,
	) {
		this.viewState = normalizeViewState(this.memento.get(PI_VIEW_STATE_KEY));
		this.statusBridge = new PiStatusBridge(
			(report) => this.handleStatusReport(report),
			(request) => this.handleForkRequest(request),
			(request) => this.handlePanelRequest(request),
		);
		vscode.workspace.onDidChangeConfiguration(
			(event) => {
				if (event.affectsConfiguration("piAgent.closeBehavior")) this.postCloseBehavior();
			},
			undefined,
			this.disposables,
		);
		vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refreshHistory(), undefined, this.disposables);
		vscode.window.onDidChangeActiveTerminal(
			(terminal) => {
				const session = terminal ? this.sessionForTerminal(terminal) : undefined;
				if (session && terminal) {
					this.setFocusedSession(session.tabId);
					const group = vscode.window.tabGroups.activeTabGroup;
					if (group.activeTab?.input instanceof vscode.TabInputTerminal) {
						this.terminalEditorGroup = group;
						this.terminalEditorViewColumn = group.viewColumn;
						void vscode.commands.executeCommand("workbench.action.lockEditorGroup");
					}
				}
				this.postActiveSession(session?.tabId);
			},
			undefined,
			this.disposables,
		);
		this.disposables.push(
			vscode.window.registerTerminalLinkProvider({
				provideTerminalLinks: (context) => {
					const session = this.sessionForTerminal(context.terminal);
					if (!session) return [];
					return session.replay.linksForLine(context.line).then((links) =>
						links.map(
							(link) => new PiTerminalLink(link.startIndex, link.length, link.kind, link.target, session.cwd),
						),
					);
				},
				handleTerminalLink: (link) => {
					const piLink = link as PiTerminalLink;
					return this.openLink(piLink.kind, piLink.target, piLink.cwd);
				},
			}),
		);

		// Restore sessions only after the initial history read. Until both the status bridge
		// and history are ready, keep starts queued so a user action cannot race restoreSessions
		// and launch the same persisted session twice.
		const historyReady = this.refreshHistory().catch(() => undefined);
		void this.statusBridge
			.start()
			.catch((error) => vscode.window.showWarningMessage(`Pi session status unavailable: ${errorMessage(error)}`))
			.finally(async () => {
				if (this.disposed) return;
				await historyReady;
				if (this.disposed) return;
				this.statusBridgeReady = true;
				this.restoreSessions();
				for (const pending of this.pendingStarts.splice(0)) {
					this.startSession(pending.id, pending.sessionPath, pending.options);
				}
			});
	}

	attachView(view: vscode.WebviewView): void {
		if (this.disposed) return;
		this.clearViewDisposables();
		this.view = view;
		this.viewReady = false;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
		};
		view.webview.html = webviewHtml(view.webview, this.extensionUri);
		this.viewDisposables.push(
			view.webview.onDidReceiveMessage((message: unknown) => void this.receive(message)),
		);
	}

	detachView(view: vscode.WebviewView): void {
		if (this.view !== view) return;
		this.view = undefined;
		this.viewReady = false;
		this.clearViewDisposables();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		for (const waiter of [...this.panelWaiters]) waiter.resolve();
		for (const watcher of this.historyWatchers.values()) watcher.close();
		this.historyWatchers.clear();
		void this.statusBridge.dispose();
		if (this.presentedSession) this.closePresentation(this.presentedSession);
		for (const session of this.sessions.values()) {
			session.process.kill();
			session.replay.dispose();
		}
		this.sessions.clear();
		this.pendingStarts.length = 0;
		this.clearViewDisposables();
		for (const disposable of this.disposables) disposable.dispose();
	}

	private async receive(message: unknown): Promise<void> {
		if (!isClientMessage(message) || this.disposed) return;
		switch (message.type) {
			case "ready":
				this.viewReady = true;
				this.postHistory();
				this.flushPendingPage();
				this.postCloseBehavior();
				this.postActiveSession(this.activeSession()?.tabId);
				break;
			case "new":
				await this.startNewSession();
				break;
			case "customize":
				await vscode.commands.executeCommand("workbench.action.openSettings", "piAgent");
				break;
			case "detach":
				this.detachSession(message.id);
				break;
			case "shutdown":
				this.shutdownSession(message.id);
				break;
			case "delete":
				await this.deleteSession(message.id);
				break;
			case "archive":
				this.archiveSession(message.id, message.archived);
				break;
			case "pin":
				this.viewState = setPinned(this.viewState, message.id, message.pinned);
				this.persistViewState();
				this.postHistory();
				break;
			case "close":
				this.closeSession(message.id);
				break;
			case "rename":
				await this.renameSession(message.id);
				break;
			case "load-user-messages":
				await this.loadUserMessages(message.action, message.id, message.requestId);
				break;
			case "session-history-action":
				await this.runSessionHistoryAction(message.action, message.id, message.entryId);
				break;
			case "refresh":
				await this.refreshHistory();
				break;
			case "resume":
				this.resumeSession(message.id);
				break;
		}
	}

	private clearViewDisposables(): void {
		for (const disposable of this.viewDisposables.splice(0)) disposable.dispose();
	}

	private async openLink(kind: "file" | "url", target: string, cwd: string): Promise<void> {
		try {
			if (kind === "url") {
				const url = httpUrl(target);
				if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
				return;
			}

			const file = resolveFileLink(target, cwd);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
			let selection: vscode.Range | undefined;
			if (file.line !== undefined) {
				const line = Math.min(file.line, document.lineCount - 1);
				const column = Math.min(file.column ?? 0, document.lineAt(line).range.end.character);
				selection = new vscode.Range(line, column, line, column);
			}
			await vscode.window.showTextDocument(document, { preview: true, selection });
		} catch {
			// Terminal output can refer to files that no longer exist.
		}
	}

	/** A new session asks which workspace folder to run in when there is more than one. */
	async startNewSession(): Promise<void> {
		const cwd = await this.pickFolder();
		if (!cwd || this.disposed) return;
		this.startSession(randomUUID(), undefined, { cwd });
	}

	private async pickFolder(): Promise<string | undefined> {
		const roots = workspaceRoots();
		if (roots.length <= 1) return roots[0]?.path;
		// Offer the focused editor's folder, then the last folder picked, first.
		const preferred = [activeEditorRoot(), this.memento.get<string>(PI_LAST_FOLDER_KEY)].filter(
			(path): path is string => Boolean(path),
		);
		const rank = (root: WorkspaceRoot) => {
			const index = preferred.findIndex((path) => samePath(path, root.path));
			return index < 0 ? preferred.length : index;
		};
		const ordered = roots
			.map((root, index) => ({ root, index }))
			.sort((a, b) => rank(a.root) - rank(b.root) || a.index - b.index)
			.map(({ root }) => root);
		const active = activeEditorRoot();
		const picked = await vscode.window.showQuickPick(
			ordered.map((root) => ({
				label: root.name,
				description: root.path,
				detail: active && samePath(active, root.path) ? "Folder of the active editor" : undefined,
				path: root.path,
			})),
			{ title: "New Pi Session", placeHolder: "Folder to run Pi in", matchOnDescription: true },
		);
		if (picked) await this.memento.update(PI_LAST_FOLDER_KEY, picked.path);
		return picked?.path;
	}

	/** Folder for a session being (re)started: its transcript's cwd, else its restored tab's, else the first folder. */
	private cwdForSession(id: string, sessionPath: string | undefined): string | undefined {
		const saved =
			this.history.get(id) ??
			(sessionPath ? [...this.history.values()].find((session) => samePath(session.path, sessionPath)) : undefined);
		return (
			saved?.cwd ??
			this.openSessionFor(id)?.cwd ??
			this.viewState.openSessions.find((record) => record.id === id)?.cwd ??
			workspaceRoots()[0]?.path
		);
	}

	/** Display name of the workspace folder a session runs in. */
	private folderName(cwd: string): string | undefined {
		// Transcripts record the realpath; a symlinked workspace folder will not match it exactly.
		return workspaceRoots().find((root) => samePath(root.path, cwd))?.name ?? basename(cwd);
	}

	/**
	 * Opened sessions come back as a list, like VS Code's Open Editors, but nothing is
	 * launched: each one starts when it is clicked, so a window with many opened
	 * sessions opens instantly. Entries Pi never wrote to disk (sessions closed before
	 * their first prompt) cannot be resumed and are dropped.
	 */
	private restoreSessions(): void {
		const kept = this.viewState.openSessions.filter((record) => record.path || this.history.has(record.id));
		if (kept.length !== this.viewState.openSessions.length) {
			this.viewState = { ...this.viewState, openSessions: kept };
			void this.memento.update(PI_VIEW_STATE_KEY, this.viewState);
		}
		this.postHistory();
	}

	private resumeSession(id: string): void {
		const openSession = this.openSessionFor(id);
		if (openSession) {
			this.openPresentation(openSession, false);
			return;
		}
		const session = this.history.get(id);
		if (session) this.startSession(id, session.path);
	}

	/** Closing a tab leaves Pi running; the session can be reopened from the list. */
	private detachSession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session || !session.attached) return;
		session.attached = false;
		this.closePresentation(session);
		this.persistViewState();
		this.postHistory();
	}

	private shutdownSession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session) return;
		this.sessions.delete(tabId);
		this.statusSequences.delete(tabId);
		this.sessionStates.set(session.sessionId, "inactive");
		this.noteTabState(tabId, "inactive");
		this.closePresentation(session);
		session.process.kill();
		session.replay.dispose();
		this.persistViewState();
		this.postHistory();
	}

	/** Deleting is keyed by session id, not tab id: a session can be deleted without a live tab. */
	private async deleteSession(sessionId: string): Promise<void> {
		const title = this.history.get(sessionId)?.title ?? this.openSessionFor(sessionId)?.title ?? NEW_SESSION_TITLE;
		const choice = await vscode.window.showWarningMessage(
			`Delete session "${title}"?`,
			{ modal: true, detail: "Pi stops and this session's saved files are removed from disk. This cannot be undone." },
			"Delete",
		);
		if (choice !== "Delete" || this.disposed) return;

		// ponytail: deletes right after the kill; wait for process exit only if Pi is seen re-creating the transcript.
		const open = this.openSessionFor(sessionId);
		if (open) this.shutdownSession(open.tabId);
		const path = this.history.get(sessionId)?.path ?? open?.path;
		try {
			if (path) await deleteSessionFiles(path);
		} catch (error) {
			// The next refresh restores whatever survived on disk.
			void vscode.window.showErrorMessage(`Could not delete "${title}": ${errorMessage(error)}`);
			return;
		}
		if (this.disposed) return;
		this.history.delete(sessionId);
		this.renamedTitles.delete(sessionId);
		this.sessionStates.delete(sessionId);
		this.viewState = closeOpened(setArchived(this.viewState, sessionId, false), sessionId);
		this.persistViewState();
		this.postHistory();
	}

	/** Remove a session from the opened list; only opened sessions may run, so it stops too. */
	private closeSession(sessionId: string): void {
		const open = this.openSessionFor(sessionId);
		if (open) this.shutdownSession(open.tabId);
		this.viewState = closeOpened(this.viewState, sessionId);
		this.persistViewState();
		this.postHistory();
	}

	// Archiving files the session under Archive and closes it (stopping Pi).
	private archiveSession(sessionId: string, archived: boolean): void {
		if (archived) this.closeSession(sessionId);
		this.viewState = setArchived(this.viewState, sessionId, archived);
		this.persistViewState();
		this.postHistory();
	}

	/** A running session renames itself through Pi (so its in-memory state agrees); a saved one is renamed on disk. */
	private async renameSession(sessionId: string): Promise<void> {
		const current = this.titleForSession(sessionId, this.openSessionFor(sessionId)?.title);
		const input = await vscode.window.showInputBox({
			title: "Rename Session",
			value: current,
			valueSelection: [0, current.length],
			prompt: "Session name shown in the Pi session list",
			validateInput: (value) => (sanitizeSessionName(value) ? undefined : "Enter a name."),
		});
		if (input === undefined || this.disposed) return;
		const name = sanitizeSessionName(input);
		if (!name || name === current) return;

		const open = this.openSessionFor(sessionId);
		try {
			if (open) {
				if (this.sessionStates.get(sessionId) === "starting") throw new Error("Wait for Pi to finish starting.");
				if (!this.statusBridge.sendControl(open.tabId, { type: "rename", sessionId, name })) {
					throw new Error("This Pi process cannot be renamed from VS Code; use /name in its terminal.");
				}
			} else {
				const path = this.history.get(sessionId)?.path;
				if (!path) throw new Error("Session not found.");
				await appendSessionName(path, name);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not rename "${current}": ${errorMessage(error)}`);
			return;
		}
		if (this.disposed) return;
		// Show the name now; the history watcher picks up what Pi writes to disk.
		const saved = this.history.get(sessionId);
		if (saved) this.history.set(sessionId, { ...saved, title: name });
		else this.renamedTitles.set(sessionId, name);
		this.syncSessionTitles();
		this.postHistory();
	}

	private async loadUserMessages(action: SessionHistoryAction, sessionId: string, requestId: string): Promise<void> {
		try {
			const source = this.sessionActionSource(sessionId);
			this.assertSessionActionAvailable(source.open);
			const messages = await listSessionUserMessages(source.path, source.open?.leafId);
			this.post({ type: "user-messages", action, sessionId, requestId, messages });
		} catch (error) {
			this.post({ type: "user-messages", action, sessionId, requestId, error: errorMessage(error), messages: [] });
		}
	}

	private async runSessionHistoryAction(
		action: SessionHistoryAction,
		sessionId: string,
		entryId?: string,
	): Promise<void> {
		if (this.sessionActions.has(sessionId)) return;
		this.sessionActions.add(sessionId);
		try {
			if (action === "fork") await this.forkSession(sessionId, entryId);
			else await this.rewindSessionToMessage(sessionId, entryId!);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not ${action} session: ${errorMessage(error)}`);
		} finally {
			this.sessionActions.delete(sessionId);
		}
	}

	private async forkSession(sessionId: string, entryId?: string): Promise<void> {
		const source = this.sessionActionSource(sessionId);
		this.assertSessionActionAvailable(source.open);
		let forked: Awaited<ReturnType<typeof createForkedSession>> | undefined;
		let draftFile: string | undefined;
		try {
			forked = await createForkedSession(source.path, entryId, source.title, source.open?.leafId);
			if (forked.draft) draftFile = await createNativeDraftFile(forked.draft);
			await this.refreshHistory();
			const failure = this.startSession(forked.id, forked.path, {
				nativeDraftFile: draftFile,
				reportError: false,
				cwd: source.cwd,
			});
			if (failure) throw new Error(failure);
		} catch (error) {
			if (draftFile) await removeNativeDraftFile(draftFile).catch(() => undefined);
			if (forked) await deleteSessionFiles(forked.path).catch(() => undefined);
			await this.refreshHistory();
			throw error;
		}
	}

	private async rewindSessionToMessage(sessionId: string, entryId: string): Promise<void> {
		let source = this.sessionActionSource(sessionId);
		this.assertSessionActionAvailable(source.open);
		let prepared = await prepareRewindSession(source.path, entryId, source.title, source.open?.leafId);
		const snapshot = await resolveSessionSnapshot(source.path, entryId);
		let revertCode = false;
		if (snapshot && (await worktreeDiffersFromSnapshot(source.cwd, snapshot))) {
			const choice = await vscode.window.showWarningMessage(
				"Submit from a previous message?",
				{
					modal: true,
					detail: "Submitting from a previous message will revert file changes to before this message and clear the messages after this one.",
				},
				"Don't Revert",
				"Revert",
			);
			if (!choice || this.disposed) return;
			revertCode = choice === "Revert";
		}

		// The user can submit from the terminal while the confirmation is open. Re-read
		// and re-check immediately before stopping or rewriting the session.
		source = this.sessionActionSource(sessionId);
		this.assertSessionActionAvailable(source.open);
		prepared = await prepareRewindSession(source.path, entryId, source.title, source.open?.leafId);
		const originalContents = await fs.readFile(source.path, "utf8");
		const draftFile = await createNativeDraftFile(prepared.draft);
		const tabId = source.open?.tabId ?? sessionId;
		let stopped = false;
		let rewritten = false;
		try {
			if (source.open) {
				await this.stopSessionForReplacement(source.open);
				stopped = true;
			}
			if (revertCode && snapshot) await restoreWorktreeSnapshot(source.cwd, snapshot);
			await rewriteSessionFile(source.path, prepared.contents);
			rewritten = true;
			await this.refreshHistory();
			const failure = this.startSession(tabId, source.path, { nativeDraftFile: draftFile, reportError: false });
			if (failure) throw new Error(failure);
		} catch (error) {
			await removeNativeDraftFile(draftFile).catch(() => undefined);
			if (rewritten) await rewriteSessionFile(source.path, originalContents).catch(() => undefined);
			const current = this.sessions.get(tabId);
			if (stopped && (!current || current.process === source.open?.process)) {
				this.startSession(tabId, source.path, { reportError: false });
			} else if (!stopped && current?.process === source.open?.process) {
				this.sessionStates.set(sessionId, "idle");
				this.postHistory();
			}
			await this.refreshHistory();
			throw error;
		}
	}

	private sessionActionSource(sessionId: string): {
		path: string;
		title: string;
		cwd: string;
		open: RunningSession | undefined;
	} {
		const open = this.openSessionFor(sessionId);
		const saved = this.history.get(sessionId);
		const path = saved?.path ?? open?.path;
		if (!path) throw new Error("Send a message before using this action.");
		const cwd = saved?.cwd ?? open?.cwd ?? this.cwdForSession(sessionId, path);
		if (!cwd) throw new Error("Pi needs an open workspace folder.");
		return { path, title: saved?.title ?? open?.title ?? NEW_SESSION_TITLE, cwd, open };
	}

	private assertSessionActionAvailable(open: RunningSession | undefined): void {
		if (!open || this.sessionStates.get(open.sessionId) === "idle") return;
		throw new Error(SESSION_ACTION_DISABLED_MESSAGE);
	}

	private async stopSessionForReplacement(session: RunningSession): Promise<void> {
		const process = session.process;
		this.replacingProcesses.add(process);
		this.sessionStates.set(session.sessionId, "starting");
		this.postHistory();
		await new Promise<void>((resolvePromise, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let listener: pty.IDisposable | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				listener?.dispose();
				this.replacingProcesses.delete(process);
				if (error) reject(error);
				else resolvePromise();
			};
			listener = process.onExit(() => finish());
			timer = setTimeout(() => finish(new Error("Timed out while stopping the Pi session.")), 5_000);
			try {
				process.kill();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		this.closePresentation(session);
		session.replay.dispose();
	}

	private setFocusedSession(tabId: string): void {
		const session = this.sessions.get(tabId);
		if (!session) return;
		if (session.attached && this.viewState.focusedSessionId === session.sessionId) return;
		session.attached = true;
		this.viewState = { ...this.viewState, focusedSessionId: session.sessionId };
		this.persistViewState();
		this.postActiveSession(tabId);
	}

	/** Opened sessions persist by id; every running listed session is (or becomes) one. */
	private persistViewState(): void {
		if (this.disposed) return;
		const records = new Map(this.viewState.openSessions.map((record) => [record.id, record]));
		for (const session of this.sessions.values()) {
			if (session.unlisted) continue;
			const previous = records.get(session.sessionId);
			records.set(session.sessionId, {
				...previous,
				id: session.sessionId,
				...(session.path ? { path: session.path } : {}),
				cwd: session.cwd,
			});
		}
		this.viewState = normalizeViewState({ ...this.viewState, openSessions: [...records.values()] });
		void this.memento.update(PI_VIEW_STATE_KEY, this.viewState);
	}

	private async handleForkRequest(request: PiForkRequest): Promise<void> {
		if (this.disposed) throw new Error("The Pi view is closed");
		const source = this.sessions.get(request.tabId);
		if (!source || source.sessionId !== request.sourceSessionId) {
			throw new Error("The source session is no longer open");
		}
		if (request.sessionId === request.sourceSessionId || this.openSessionFor(request.sessionId)) {
			throw new Error("The forked session is already open");
		}

		await this.refreshHistory();
		if (this.disposed) throw new Error("The Pi view is closed");
		const forked = this.history.get(request.sessionId);
		if (!forked || resolve(forked.path) !== resolve(request.sessionPath)) {
			throw new Error("The forked session is not available in this workspace");
		}

		const failure = this.startSession(request.sessionId, forked.path, {
			draftFile: request.draftFile,
			reportError: false,
			cwd: forked.cwd,
		});
		if (failure) throw new Error(failure);
	}

	private async handlePanelRequest(request: PiPanelRequest): Promise<unknown> {
		switch (request.action) {
			case "create":
				return this.panelCreate(request.model, request.tabId);
			case "prompt":
				return this.panelPrompt(request.tabId, request.text);
			case "wait":
				return request.tabIds
					? this.panelWaitAll(request.tabIds, request.sinceMs, request.timeoutMs)
					: this.panelWait(request.tabId, request.sinceMs, request.timeoutMs);
			case "list":
				return this.panelList();
		}
	}

	/** Like `herdr agent start`: open a background tab and answer once its Pi accepts input. */
	private async panelCreate(
		model: string | undefined,
		callerTabId: string | undefined,
	): Promise<{ tabId: string; sessionId: string }> {
		const id = randomUUID();
		// A panel runs in its caller's folder; older panel packages do not send the caller.
		const cwd = (callerTabId ? this.sessions.get(callerTabId)?.cwd : undefined) ?? workspaceRoots()[0]?.path;
		const failure = this.startSession(id, undefined, {
			noFocus: true,
			noPresentation: true,
			reportError: false,
			model,
			cwd,
			unlisted: true,
		});
		if (failure) throw new Error(failure);
		const deadline = Date.now() + PANEL_READY_TIMEOUT_MS;
		for (;;) {
			if (this.disposed) throw new Error("The Pi view is closed");
			const current = this.tabStates.get(id);
			if (current && (current.state === "idle" || current.state === "working")) {
				return { tabId: id, sessionId: id };
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Panel ${id} did not become ready within ${PANEL_READY_TIMEOUT_MS / 1000}s`);
			await Promise.race([this.waitForTabChange(id), sleep(remaining)]);
		}
	}

	/** Bracketed paste keeps newlines literal in Pi's editor; Enter submits after the paste closes. */
	private async panelPrompt(tabId: string | undefined, text: string | undefined): Promise<{ tabId: string; promptedAtMs: number }> {
		if (!tabId || !text) throw new Error("panel prompt requires tabId and text");
		const session = this.sessions.get(tabId);
		if (!session) throw new Error(`No open panel ${tabId}`);
		session.process.write(`\x1b[200~${text}\x1b[201~`);
		await sleep(100);
		session.process.write("\r");
		return { tabId, promptedAtMs: Date.now() };
	}

	private async panelWait(
		tabId: string | undefined,
		sinceMs: number | undefined,
		timeoutMs: number | undefined,
	): Promise<{ tabId: string; state: PiSessionState; settled: boolean }> {
		if (!tabId) throw new Error("panel wait requires a tabId");
		const result = await this.panelWaitAll([tabId], sinceMs, timeoutMs);
		const panel = result.panels[0];
		return { tabId, state: panel.state, settled: panel.settled };
	}

	/** Fan-in wait: resolves when every listed panel settles (idle after sinceMs, or exits). */
	private async panelWaitAll(
		tabIds: string[],
		sinceMs: number | undefined,
		timeoutMs: number | undefined,
	): Promise<{ settled: boolean; panels: Array<{ tabId: string; state: PiSessionState; settled: boolean }> }> {
		for (const tabId of tabIds) {
			if (!this.sessions.has(tabId) && this.tabStates.get(tabId)?.state !== "inactive") {
				throw new Error(`No open panel ${tabId}`);
			}
		}
		const timeout = clamp(Math.round(timeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS), 1_000, MAX_PANEL_WAIT_TIMEOUT_MS);
		const deadline = Date.now() + timeout;
		const stallDeadline = sinceMs === undefined ? undefined : sinceMs + PANEL_STALL_MS;
		for (;;) {
			if (this.disposed) {
				return { settled: false, panels: tabIds.map((tabId) => ({ tabId, state: "inactive", settled: false })) };
			}
			const now = Date.now();
			const panels = tabIds.map((tabId) => {
				const current = this.tabStates.get(tabId);
				const state = current?.state ?? "starting";
				const settled =
					(state === "idle" || state === "inactive") &&
					(sinceMs === undefined || (current !== undefined && current.changedAtMs >= sinceMs));
				if (
					stallDeadline !== undefined &&
					now >= stallDeadline &&
					state === "idle" &&
					current !== undefined &&
					current.changedAtMs < sinceMs!
				) {
					throw new Error(
						`Panel ${tabId} showed no activity within ${PANEL_STALL_MS / 1000}s of the prompt; ` +
							"it may be busy or showing a dialog. Inspect the panel before retrying.",
					);
				}
				return { tabId, state, settled };
			});
			if (panels.every((panel) => panel.settled)) return { settled: true, panels };
			const remaining = deadline - now;
			if (remaining <= 0) return { settled: false, panels };
			await Promise.race([...tabIds.map((tabId) => this.waitForTabChange(tabId)), sleep(remaining)]);
		}
	}

	private panelList(): Array<{ tabId: string; sessionId: string; title: string; state: PiSessionState }> {
		return [...this.sessions.values()].map((session) => ({
			tabId: session.tabId,
			sessionId: session.sessionId,
			title: session.title,
			state: this.tabStates.get(session.tabId)?.state ?? "starting",
		}));
	}

	private noteTabState(tabId: string, state: PiSessionState): void {
		if (this.tabStates.get(tabId)?.state === state) return;
		this.tabStates.set(tabId, { state, changedAtMs: Date.now() });
		for (const waiter of [...this.panelWaiters]) {
			if (waiter.tabId === tabId) waiter.resolve();
		}
	}

	private waitForTabChange(tabId: string): Promise<void> {
		return new Promise((resolve) => {
			const waiter: PanelWaiter = {
				tabId,
				resolve: () => {
					this.panelWaiters.delete(waiter);
					resolve();
				},
			};
			this.panelWaiters.add(waiter);
		});
	}

	private startSession(id: string, sessionPath?: string, options: StartSessionOptions = {}): string | undefined {
		if (!this.statusBridgeReady) {
			this.pendingStarts.push({ id, sessionPath, options });
			return undefined;
		}
		const command = vscode.workspace.getConfiguration("piAgent").get<string>("command", DEFAULT_PI_COMMAND).trim();
		if (!command) {
			const failure = "Set piAgent.command to the pi executable.";
			if (options.reportError !== false) void vscode.window.showErrorMessage(failure);
			return failure;
		}
		const cwd = options.cwd ?? this.cwdForSession(id, sessionPath);
		if (!cwd) {
			const failure = "Pi needs an open workspace folder.";
			if (options.reportError !== false) void vscode.window.showErrorMessage(failure);
			return failure;
		}
		// Recovery retries reuse these options; pin the folder so a retry cannot drift.
		options = { ...options, cwd };

		let spawnedProcess: pty.IPty | undefined;
		let replay: TerminalReplay | undefined;
		try {
			preparePty();
			const tabId = id;
			const cols = 80;
			const rows = 24;
			const args = piCommandArgs(vscode.workspace.getConfiguration("piAgent").get<unknown>("commandArgs"));
			args.push(...(sessionPath ? ["--session", sessionPath] : ["--session-id", id]));
			if (options.model) args.push("--model", options.model);
			if (this.statusBridge.isListening) args.push("--extension", piStatusExtensionPath(this.extensionUri));
			args.push(
				...piTuiModeArgs(
					vscode.workspace.getConfiguration("piAgent").get<string>("tuiMode"),
					this.statusBridge.isListening,
				),
			);
			const draftEnvironment = options.nativeDraftFile
				? { [PI_NATIVE_DRAFT_FILE_ENV]: options.nativeDraftFile }
				: options.draftFile
					? { [PI_FORK_DRAFT_FILE_ENV]: options.draftFile }
					: {};
			const file = effectivePiCommand(command);
			const spawn = process.platform === "win32" ? win32Spawn(file, args) : { file, args };
			const scrollback = clamp(
				vscode.workspace.getConfiguration("terminal.integrated").get<number>("scrollback", 1000),
				0,
				100_000,
			);
			replay = new TerminalReplay(cols, rows, scrollback);
			const child = pty.spawn(spawn.file, spawn.args, {
				cwd,
				name: "xterm-256color",
				cols,
				rows,
				env: { ...terminalEnvironment(), ...this.statusBridge.environmentFor(tabId), ...draftEnvironment },
			});
			spawnedProcess = child;
			const title = this.titleForSession(id);
			const session: RunningSession = {
				tabId,
				sessionId: id,
				cwd,
				startedAtMs: Date.now(),
				title,
				path: sessionPath,
				attached: options.noPresentation !== true,
				...(options.unlisted ? { unlisted: true } : {}),
				process: child,
				replay,
				cols,
				rows,
			};
			this.sessions.set(tabId, session);
			this.statusSequences.delete(tabId);
			this.sessionStates.set(id, "starting");
			this.noteTabState(tabId, "starting");
			child.onData((data) => {
				const sequence = replay!.write(data);
				if (this.presentedSession === session) this.pseudoterminal?.write(data, sequence);
				this.refreshSoon();
			});
			child.onExit(({ exitCode }) => this.handleExit(tabId, child, exitCode));
			if (options.noPresentation !== true) this.openPresentation(session, options.noFocus === true);
			this.persistViewState();
			this.postHistory();
			this.refreshSoon();
			return undefined;
		} catch (error) {
			this.sessions.delete(id);
			this.sessionStates.delete(id);
			this.statusSequences.delete(id);
			spawnedProcess?.kill();
			replay?.dispose();
			const failure = `Could not start pi: ${errorMessage(error)}`;
			if (options.reportError !== false) {
				// Auto-detect pi (PATH, npm global dir) and restart; only prompt when that fails.
				void this.recoverStart(id, sessionPath, options, failure);
			}
			return failure;
		}
	}

	private openPresentation(session: RunningSession, preserveFocus: boolean): void {
		if (this.disposed || this.sessions.get(session.tabId) !== session) return;
		if (this.presentedSession && this.presentedSession !== session) this.presentedSession.attached = false;
		this.presentedSession = session;
		session.attached = true;

		let terminal = this.terminal;
		let pseudoterminal = this.pseudoterminal;
		if (terminal && pseudoterminal) {
			pseudoterminal.switchBackend(this.terminalBackend(session, pseudoterminal), session.title);
		} else {
			const existingGroups = new Set(vscode.window.tabGroups.all);
			const viewColumn =
				this.terminalEditorViewColumn ?? this.reusableEmptyEditorGroup() ?? vscode.ViewColumn.Beside;
			pseudoterminal = new PiPseudoterminal({
				replay: () => session.replay.snapshot(),
				input: (data) => {
					if (this.presentedSession === session && data.length <= 1024 * 1024) session.process.write(data);
				},
				resize: (cols, rows) => this.resizeSession(session, cols, rows),
				close: () => this.handlePresentationClosed(pseudoterminal!),
			});
			terminal = vscode.window.createTerminal({
				name: session.title,
				pty: pseudoterminal,
				location: {
					viewColumn,
					preserveFocus,
				},
				iconPath: new vscode.ThemeIcon("terminal"),
				isTransient: true,
			});
			this.pseudoterminal = pseudoterminal;
			this.terminal = terminal;
			this.rememberTerminalEditorGroup(terminal, true, existingGroups, viewColumn);
		}
		terminal.show(preserveFocus);
		if (!preserveFocus) {
			this.setFocusedSession(session.tabId);
		}
		this.persistViewState();
		this.postHistory();
	}

	private reusableEmptyEditorGroup(): vscode.ViewColumn | undefined {
		const activeColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
		const emptyGroups = vscode.window.tabGroups.all.filter((group) => group.tabs.length === 0);
		return (
			emptyGroups
				.filter((group) => group.viewColumn >= activeColumn)
				.sort((left, right) => left.viewColumn - right.viewColumn)[0] ??
			emptyGroups.sort((left, right) => right.viewColumn - left.viewColumn)[0]
		)?.viewColumn;
	}

	private terminalBackend(session: RunningSession, pseudoterminal: PiPseudoterminal) {
		return {
			replay: () => session.replay.snapshot(),
			input: (data: string) => {
				if (this.presentedSession === session && data.length <= 1024 * 1024) session.process.write(data);
			},
			resize: (cols: number, rows: number) => this.resizeSession(session, cols, rows),
			close: () => this.handlePresentationClosed(pseudoterminal),
		};
	}

	private rememberTerminalEditorGroup(
		terminal: vscode.Terminal,
		lock: boolean,
		existingGroups: ReadonlySet<vscode.TabGroup>,
		expectedColumn: vscode.ViewColumn,
	): void {
		let subscription: vscode.Disposable | undefined;
		let timer: NodeJS.Timeout | undefined;
		const finish = () => {
			subscription?.dispose();
			if (timer) clearTimeout(timer);
		};
		const locate = () => {
			if (this.disposed || this.terminal !== terminal) return finish();
			const active = vscode.window.tabGroups.activeTabGroup;
			const group =
				(vscode.window.activeTerminal === terminal && active.activeTab?.input instanceof vscode.TabInputTerminal
					? active
					: vscode.window.tabGroups.all.find(
							(candidate) =>
								candidate.activeTab?.input instanceof vscode.TabInputTerminal &&
								(!existingGroups.has(candidate) || candidate.viewColumn === expectedColumn),
						));
			if (!group) return;
			this.terminalEditorGroup = group;
			this.terminalEditorViewColumn = group.viewColumn;
			finish();
			// The command targets the active group. Background terminals rely on
			// VS Code's built-in terminal-editor auto-lock instead of stealing focus.
			if (lock && group.isActive) void vscode.commands.executeCommand("workbench.action.lockEditorGroup");
		};
		subscription = vscode.window.tabGroups.onDidChangeTabs(locate);
		timer = setTimeout(finish, 2_000);
		queueMicrotask(locate);
	}

	private handlePresentationClosed(pseudoterminal: PiPseudoterminal): void {
		if (this.pseudoterminal !== pseudoterminal) return;
		const session = this.presentedSession;
		this.pseudoterminal = undefined;
		this.terminal = undefined;
		this.presentedSession = undefined;
		this.closeEmptyTerminalEditorGroup();
		if (!session) return;
		session.attached = false;
		if (this.disposed || this.sessions.get(session.tabId) !== session) return;
		if (this.replacingProcesses.has(session.process)) return;
		const stop = vscode.workspace.getConfiguration("piAgent").get<string>("closeBehavior", "detach") === "stop";
		if (stop) this.shutdownSession(session.tabId);
		else {
			this.persistViewState();
			this.postHistory();
			this.postActiveSession(this.activeSession()?.tabId);
		}
	}

	private closePresentation(session: RunningSession, exitCode?: number): void {
		if (this.presentedSession !== session) return;
		const terminal = this.terminal;
		const pseudoterminal = this.pseudoterminal;
		this.presentedSession = undefined;
		this.terminal = undefined;
		this.pseudoterminal = undefined;
		pseudoterminal?.end(exitCode);
		terminal?.dispose();
		this.closeEmptyTerminalEditorGroup();
	}

	private closeEmptyTerminalEditorGroup(): void {
		const group = this.terminalEditorGroup;
		this.terminalEditorGroup = undefined;
		this.terminalEditorViewColumn = undefined;
		if (!group) return;
		let subscription: vscode.Disposable | undefined;
		let timer: NodeJS.Timeout | undefined;
		const finish = () => {
			subscription?.dispose();
			if (timer) clearTimeout(timer);
		};
		const closeIfEmpty = () => {
			if (!vscode.window.tabGroups.all.includes(group)) return finish();
			if (group.tabs.length !== 0) return;
			finish();
			void vscode.window.tabGroups.close(group, true);
		};
		subscription = vscode.window.tabGroups.onDidChangeTabs(closeIfEmpty);
		timer = setTimeout(finish, 2_000);
		queueMicrotask(closeIfEmpty);
	}

	private resizeSession(session: RunningSession, cols: number, rows: number): void {
		if (this.sessions.get(session.tabId) !== session) return;
		const nextCols = clamp(Math.round(cols), 2, 1000);
		const nextRows = clamp(Math.round(rows), 1, 500);
		if (session.cols === nextCols && session.rows === nextRows) return;
		session.cols = nextCols;
		session.rows = nextRows;
		session.replay.resize(nextCols, nextRows);
		try {
			session.process.resize(nextCols, nextRows);
		} catch {
			// The process may have exited between VS Code's resize event and this write.
		}
	}

	/**
	 * A session failed to spawn. Try to locate pi automatically; if that fails, ask the user
	 * for its executable (browse or type) and restart with it saved to piAgent.command.
	 */
	private async recoverStart(
		id: string,
		sessionPath: string | undefined,
		options: StartSessionOptions,
		failure: string,
	): Promise<void> {
		if (this.disposed || this.recoveringStart) return;
		this.recoveringStart = true;
		try {
			const configured = vscode.workspace.getConfiguration("piAgent").get<string>("command", DEFAULT_PI_COMMAND).trim();
			// Only auto-detect the default bare name; an explicit path is the user's own choice.
			if (configured === DEFAULT_PI_COMMAND && !resolvedPiCommand) {
				const found = await detectPiCommand();
				if (found && !this.disposed) {
					resolvedPiCommand = found;
					const retry = this.startSession(id, sessionPath, { ...options, reportError: false });
					if (!retry) return;
					failure = retry;
				}
			}
			await this.promptForPiLocation(id, sessionPath, options, failure);
		} finally {
			this.recoveringStart = false;
		}
	}

	private async promptForPiLocation(
		id: string,
		sessionPath: string | undefined,
		options: StartSessionOptions,
		failure: string,
	): Promise<void> {
		if (this.disposed) return;
		const action = await vscode.window.showErrorMessage(
			`${failure}\nInstall pi with \"npm install -g @earendil-works/pi-coding-agent\" (Git Bash is required on Windows), or point to an existing executable.`,
			"Locate pi...",
			"Install pi",
		);
		if (!action || this.disposed) return;
		if (action === "Install pi") {
			await vscode.env.openExternal(vscode.Uri.parse("https://pi.dev"));
			return;
		}

		const browse = "Browse for the pi executable";
		const manual = "Enter the path manually";
		const method = await vscode.window.showQuickPick(
			[
				{ label: browse, detail: "Open a file picker and select the pi executable" },
				{ label: manual, detail: "Type the absolute path to the pi executable" },
			],
			{ placeHolder: "How do you want to provide the pi executable?" },
		);
		let chosen: string | undefined;
		if (method?.label === browse) {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectMany: false,
				openLabel: "Select pi executable",
				title: "Select the pi executable",
			});
			chosen = picked?.[0]?.fsPath;
		} else if (method?.label === manual) {
			chosen = await vscode.window.showInputBox({
				prompt: "Absolute path to the pi executable",
				placeHolder:
					process.platform === "win32" ? "C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd" : "/usr/local/bin/pi",
				validateInput: (value) => {
					const path = value.trim();
					if (!path) return "Enter a path";
					return existsSync(path) ? undefined : "File not found";
				},
			});
		}
		const path = chosen?.trim();
		if (!path || this.disposed) return;
		await vscode.workspace.getConfiguration("piAgent").update("piAgent.command", path, vscode.ConfigurationTarget.Global);
		resolvedPiCommand = undefined;
		const retry = this.startSession(id, sessionPath, { ...options, reportError: false });
		if (retry) void vscode.window.showErrorMessage(retry);
	}

	private handleExit(tabId: string, process: pty.IPty, exitCode: number): void {
		if (this.replacingProcesses.has(process)) return;
		const session = this.sessions.get(tabId);
		if (this.disposed || session?.process !== process) return;
		this.sessions.delete(tabId);
		this.statusSequences.delete(tabId);
		this.sessionStates.set(session.sessionId, "inactive");
		this.noteTabState(tabId, "inactive");
		session.attached = false;
		this.closePresentation(session, exitCode);
		session.replay.dispose();
		this.persistViewState();
		this.postHistory();
		if (exitCode !== 0) void vscode.window.showWarningMessage(`Pi exited with code ${exitCode}.`);
		this.refreshSoon();
	}

	private async refreshHistory(): Promise<void> {
		const sessions = await listWorkspaceSessions(workspaceRoots().map((root) => root.path));
		if (this.disposed) return;
		this.history.clear();
		for (const session of sessions) this.history.set(session.id, session);
		this.syncSessionTitles();
		this.postHistory();
		void this.syncHistoryWatchers();
	}

	private handleStatusReport(report: PiStatusReport): void {
		const session = this.sessions.get(report.tabId);
		if (!session) return;
		const previous = this.statusSequences.get(report.tabId);
		if (previous?.sourceId === report.sourceId && previous.seq >= report.seq) return;
		this.statusSequences.set(report.tabId, { sourceId: report.sourceId, seq: report.seq });
		const previousState = this.sessionStates.get(session.sessionId);
		if (session.sessionId !== report.sessionId) {
			// Pi switched this tab to another session (/new, /resume, a fork): the tab's
			// opened entry, including its pin, follows the tab.
			const previousId = session.sessionId;
			if (!session.unlisted && !this.viewState.openSessions.some((record) => record.id === report.sessionId)) {
				this.viewState = {
					...this.viewState,
					openSessions: this.viewState.openSessions.map((record) =>
						record.id === previousId ? { id: report.sessionId, ...(record.pinned ? { pinned: true as const } : {}) } : record,
					),
				};
			}
			this.sessionStates.set(session.sessionId, "inactive");
			session.sessionId = report.sessionId;
			session.startedAtMs = Date.now();
			session.title = this.titleForSession(report.sessionId);
			this.postSessionMeta(session);
			this.persistViewState();
		}
		if (report.sessionPath && report.sessionPath !== session.path) {
			session.path = report.sessionPath;
			this.persistViewState();
		}
		session.leafId = report.leafId;
		this.sessionStates.set(report.sessionId, report.state);
		this.noteTabState(report.tabId, report.state);
		if (becameIdle(previousState, report.state)) this.post({ type: "attention" });
		this.postHistory();
	}

	private openSessionFor(sessionId: string): RunningSession | undefined {
		return [...this.sessions.values()].find((session) => session.sessionId === sessionId);
	}

	private titleForSession(sessionId: string, fallback = NEW_SESSION_TITLE): string {
		return this.history.get(sessionId)?.title ?? this.renamedTitles.get(sessionId) ?? fallback;
	}

	private syncSessionTitles(): void {
		for (const session of this.sessions.values()) this.setSessionTitle(session, this.titleForSession(session.sessionId));
	}

	private setSessionTitle(session: RunningSession, title: string): void {
		if (session.title === title) return;
		session.title = title;
		if (this.presentedSession === session) this.pseudoterminal?.rename(title);
	}

	private postSessionMeta(session: RunningSession): void {
		if (this.presentedSession === session) this.pseudoterminal?.rename(session.title);
	}

	private async syncHistoryWatchers(): Promise<void> {
		if (this.disposed || this.historyWatchSyncing) return;
		this.historyWatchSyncing = true;
		try {
			const directories = new Set(await sessionDirectoriesForWorkspace(workspaceRoots().map((root) => root.path)));
			if (this.disposed) return;
			for (const [directory, watcher] of this.historyWatchers) {
				if (directories.has(directory)) continue;
				watcher.close();
				this.historyWatchers.delete(directory);
			}
			for (const directory of directories) {
				if (this.historyWatchers.has(directory)) continue;
				try {
					const watcher = watch(directory, { persistent: false }, () => this.refreshSoon());
					watcher.on("error", () => {
						if (this.historyWatchers.get(directory) !== watcher) return;
						watcher.close();
						this.historyWatchers.delete(directory);
						this.refreshSoon();
					});
					this.historyWatchers.set(directory, watcher);
				} catch {
					// Pi creates a workspace session directory on startup; the next refresh retries this watch.
				}
			}
		} finally {
			this.historyWatchSyncing = false;
		}
	}

	private postHistory(): void {
		const archived = new Set(this.viewState.archivedSessionIds);
		const openedRecords = new Map(this.viewState.openSessions.map((record) => [record.id, record]));
		const openedFlags = (id: string) => {
			const record = openedRecords.get(id);
			return { opened: Boolean(record), pinned: record?.pinned === true };
		};
		// Label sessions with their folder only when the workspace has several.
		const labelled = workspaceRoots().length > 1;
		const folder = (cwd: string) => (labelled ? this.folderName(cwd) : undefined);
		const sessions = [...this.history.values()].map(({ id, title, cwd, createdAtMs, lastPromptAtMs }) => {
			const openSession = this.openSessionFor(id);
			return {
				id,
				title,
				folder: folder(cwd),
				...openedFlags(id),
				createdAtMs,
				updatedAtMs: lastPromptAtMs,
				archived: archived.has(id),
				tabId: openSession?.tabId,
				attached: openSession?.attached === true,
				state: this.sessionStates.get(id) ?? (openSession ? "starting" : "inactive"),
			};
		});
		for (const session of this.sessions.values()) {
			if (this.history.has(session.sessionId)) continue;
			sessions.push({
				id: session.sessionId,
				title: session.title,
				folder: folder(session.cwd),
				...(session.unlisted ? { opened: false, pinned: false } : openedFlags(session.sessionId)),
				createdAtMs: session.startedAtMs,
				updatedAtMs: session.startedAtMs,
				archived: archived.has(session.sessionId),
				tabId: session.tabId,
				attached: session.attached,
				state: this.sessionStates.get(session.sessionId) ?? "starting",
			});
		}
		sessions.sort(
			(a, b) => b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		this.post({ type: "history", sessions });
	}

	private refreshSoon(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshHistory();
		}, 500);
	}

	private postCloseBehavior(): void {
		const stop = vscode.workspace.getConfiguration("piAgent").get<string>("closeBehavior", "detach") === "stop";
		this.post({ type: "close-behavior", stop });
	}

	private post(message: object): void {
		if (this.disposed || !this.viewReady || !this.view) return;
		void this.view.webview.postMessage(message);
	}

	/**
	 * The open sessions in the order the sidebar lists them: pinned first, then the
	 * rest, each by last prompt (ties: creation time, then id).
	 */
	private openedSessionOrder(): string[] {
		const sortKey = (id: string) => {
			const saved = this.history.get(id);
			const running = this.openSessionFor(id);
			const updated = saved?.lastPromptAtMs ?? running?.startedAtMs ?? 0;
			const created = saved?.createdAtMs ?? running?.startedAtMs ?? 0;
			return { updated, created };
		};
		return [...this.viewState.openSessions]
			.sort((a, b) => {
				if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
				const left = sortKey(a.id);
				const right = sortKey(b.id);
				return right.updated - left.updated || right.created - left.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
			})
			.map((record) => record.id);
	}

	/** Show the next or previous open session, wrapping; one that is not running starts. */
	cycleSession(step: 1 | -1): void {
		const order = this.openedSessionOrder();
		if (!order.length) return;
		const current = this.presentedSession?.sessionId ?? this.viewState.focusedSessionId;
		const index = current ? order.indexOf(current) : -1;
		const next = index < 0 ? (step > 0 ? 0 : order.length - 1) : (index + step + order.length) % order.length;
		const id = order[next];
		if (!id || (id === current && this.presentedSession)) return;
		const running = this.openSessionFor(id);
		if (running) {
			this.openPresentation(running, false);
			return;
		}
		const saved = this.history.get(id);
		const record = this.viewState.openSessions.find((entry) => entry.id === id);
		const path = saved?.path ?? record?.path;
		if (path) this.startSession(id, path);
	}

	/** Switch the webview between its Open sessions and All sessions pages. */
	showPage(page: "open" | "all"): void {
		this.pendingPage = page;
		this.flushPendingPage();
	}

	private pendingPage: "open" | "all" | undefined;

	private flushPendingPage(): void {
		if (!this.pendingPage || !this.viewReady || !this.view) return;
		this.post({ type: "show-page", page: this.pendingPage });
		this.pendingPage = undefined;
	}

	closeActiveSessionOrView(): void {
		void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
	}

	/**
	 * Hide the session terminal editor if it is showing; otherwise show the last focused
	 * running session, else resume the most recent session, else start a new one.
	 * Hiding leaves Pi running and keeps the session in the set restored after a reload.
	 */
	async toggleTerminal(): Promise<void> {
		const shown = this.presentedSession;
		if (shown && this.terminal) {
			this.closePresentation(shown);
			this.postHistory();
			this.postActiveSession(undefined);
			return;
		}
		const running = [...this.sessions.values()];
		const target =
			running.find((session) => session.sessionId === this.viewState.focusedSessionId) ??
			running.sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
		if (target) {
			this.openPresentation(target, false);
			return;
		}
		// Nothing running: resume the last focused opened session, else the most recent
		// opened one, else the most recent session at all, else start a new one.
		const opened = new Set(this.viewState.openSessions.map((record) => record.id));
		const focused = this.viewState.focusedSessionId;
		const archived = new Set(this.viewState.archivedSessionIds);
		const candidates = [...this.history.values()].filter((session) => !archived.has(session.id)).sort(compareSessions);
		const recent =
			(focused && opened.has(focused) ? this.history.get(focused) : undefined) ??
			candidates.find((session) => opened.has(session.id)) ??
			candidates[0];
		if (recent) this.startSession(recent.id, recent.path);
		else await this.startNewSession();
	}

	/**
	 * Paste text into the Pi prompt of the shown session, showing (or resuming) one
	 * as Toggle Terminal would when none is shown, then focus its terminal.
	 */
	async insertIntoPrompt(text: string): Promise<void> {
		let session = this.presentedSession;
		if (!session) {
			await this.toggleTerminal();
			session = this.presentedSession;
		}
		if (!session) return;
		this.openPresentation(session, false);
		if (!(await this.waitUntilReady(session.tabId))) {
			void vscode.window.showWarningMessage("Pi did not become ready; the selection reference was not inserted.");
			return;
		}
		if (!this.sessions.has(session.tabId)) return;
		// Bracketed paste so Pi inserts the text literally, without submitting.
		session.process.write(`\x1b[200~${text}\x1b[201~`);
	}

	private async waitUntilReady(tabId: string): Promise<boolean> {
		const deadline = Date.now() + PANEL_READY_TIMEOUT_MS;
		for (;;) {
			if (this.disposed || !this.sessions.has(tabId)) return false;
			const current = this.tabStates.get(tabId);
			if (current && (current.state === "idle" || current.state === "working")) return true;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await Promise.race([this.waitForTabChange(tabId), sleep(Math.min(remaining, 500))]);
		}
	}

	async copyTerminalSelection(): Promise<void> {
		const session = this.activeSession();
		await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
		if (!session) return;
		const copied = await vscode.env.clipboard.readText();
		const normalized = normalizePiTerminalCopy(copied, session.cols);
		if (normalized !== copied) await vscode.env.clipboard.writeText(normalized);
	}

	private sessionForTerminal(terminal: vscode.Terminal): RunningSession | undefined {
		return this.terminal === terminal ? this.presentedSession : undefined;
	}

	private activeSession(): RunningSession | undefined {
		const terminal = vscode.window.activeTerminal;
		return terminal ? this.sessionForTerminal(terminal) : undefined;
	}

	private postActiveSession(tabId: string | undefined): void {
		// Keybindings (⌘⇧[ / ⌘⇧]) target Pi sessions only while its terminal is the active one.
		const active = Boolean(this.terminal) && vscode.window.activeTerminal === this.terminal;
		void vscode.commands.executeCommand("setContext", "piAgent.sessionTerminalActive", active);
		this.post({ type: "active-session", ...(tabId ? { tabId } : {}) });
	}
}

function preparePty(): void {
	if (ptyPrepared || process.platform === "win32") return;
	ptyPrepared = true;
	const packageDir = dirname(require.resolve("node-pty/package.json"));
	for (const helper of [
		join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
		join(packageDir, "build", "Release", "spawn-helper"),
	]) {
		try {
			chmodSync(helper, 0o755);
		} catch {
			// A source or Windows install may not have this helper.
		}
	}
}

function piStatusExtensionPath(extensionUri: vscode.Uri): string {
	return vscode.Uri.joinPath(extensionUri, "resources", "pi-vscode-status.ts").fsPath;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalEnvironment(): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

/** An explicit piAgent.command wins; the auto-detected path only fills in the default. */
function effectivePiCommand(configured: string): string {
	return configured === DEFAULT_PI_COMMAND ? (resolvedPiCommand ?? configured) : configured;
}

async function detectPiCommand(): Promise<string | undefined> {
	return process.platform === "win32" ? detectPiCommandWindows() : detectPiCommandUnix();
}

async function detectPiCommandWindows(): Promise<string | undefined> {
	const where = await runCapture("cmd.exe", ["/d", "/s", "/c", "where pi"]);
	for (const line of where.split(/\r?\n/)) {
		const hit = line.trim();
		if (hit && existsSync(hit)) return hit;
	}
	// npm's global dir may be missing from a GUI-launched VS Code PATH (nvm, fnm, custom prefix).
	const appData = process.env.APPDATA;
	const npmShim = appData ? join(appData, "npm", "pi.cmd") : undefined;
	return npmShim && existsSync(npmShim) ? npmShim : undefined;
}

async function detectPiCommandUnix(): Promise<string | undefined> {
	const which = await runCapture("which", ["pi"]);
	for (const line of which.split("\n")) {
		const hit = line.trim();
		if (hit && existsSync(hit)) return hit;
	}
	// GUI-launched VS Code may miss shell-profile PATH entries (Homebrew, custom npm prefix).
	for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin")]) {
		const candidate = join(dir, "pi");
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function runCapture(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
	return new Promise((resolvePromise) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
			resolvePromise(error ? "" : stdout);
		});
	});
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isClientMessage(value: unknown): value is ClientMessage {
	if (!value || typeof value !== "object" || !("type" in value)) return false;
	const message = value as Record<string, unknown>;
	if (typeof message.type !== "string") return false;
	if (
		message.type === "ready" ||
		message.type === "refresh" ||
		message.type === "new" ||
		message.type === "customize"
	) {
		return true;
	}
	if (message.type === "archive") return typeof message.id === "string" && typeof message.archived === "boolean";
	if (message.type === "pin") return nonEmptyBoundedString(message.id, 512) && typeof message.pinned === "boolean";
	if (message.type === "close") return nonEmptyBoundedString(message.id, 512);
	if (message.type === "load-user-messages") {
		return (
			isSessionHistoryAction(message.action) &&
			nonEmptyBoundedString(message.id, 512) &&
			nonEmptyBoundedString(message.requestId, 512)
		);
	}
	if (message.type === "session-history-action") {
		return (
			isSessionHistoryAction(message.action) &&
			nonEmptyBoundedString(message.id, 512) &&
			(message.entryId === undefined || nonEmptyBoundedString(message.entryId, 512)) &&
			(message.action !== "rewind" || nonEmptyBoundedString(message.entryId, 512))
		);
	}
	if (message.type === "rename") return nonEmptyBoundedString(message.id, 512);
	if (message.type === "detach" || message.type === "shutdown" || message.type === "delete") {
		return typeof message.id === "string";
	}
	return message.type === "resume" && typeof message.id === "string";
}

function isSessionHistoryAction(value: unknown): value is SessionHistoryAction {
	return value === "fork" || value === "rewind";
}

function nonEmptyBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const uri = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
	const nonce = randomUUID();
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${uri("media", "main.css")}">
	<title>Pi</title>
</head>
<body>
	<div id="app">
		<main id="sidebar" aria-label="Pi sessions">
			<div id="sidebar-header">
				<button id="back" class="icon-button" type="button" title="Back to open sessions (Esc)" aria-label="Back to open sessions"></button>
				<h1 id="page-title">Open sessions</h1>
				<button id="customize" class="icon-button" type="button" title="Customize Pi settings" aria-label="Customize Pi settings"></button>
				<button id="refresh" class="icon-button" type="button" title="Refresh sessions" aria-label="Refresh sessions"></button>
			</div>
			<div id="search-field">
				<span class="search-icon" aria-hidden="true"></span>
				<input id="search" type="text" placeholder="Search all sessions..." aria-label="Search all sessions" autocomplete="off" spellcheck="false">
			</div>
			<nav id="sidebar-actions" aria-label="Session actions">
				<button id="new-session" class="sidebar-action" type="button">
					<span class="action-label">New session</span>
				</button>
				<button id="all-sessions" class="sidebar-action" type="button" title="All sessions for this workspace, with search">
					<span class="action-label">Search all sessions</span>
				</button>
			</nav>
			<div id="session-list"></div>
		</main>
	</div>
	<div id="menu" role="menu" hidden></div>
	<div id="message-dialog" class="dialog-scrim" hidden>
		<section class="message-dialog-card" role="dialog" aria-modal="true" aria-labelledby="message-dialog-title" aria-describedby="message-dialog-description">
			<header class="message-dialog-header">
				<h2 id="message-dialog-title"></h2>
				<p id="message-dialog-description"></p>
			</header>
			<div id="message-dialog-list" class="message-dialog-list" role="radiogroup" aria-label="User messages"></div>
			<footer class="message-dialog-footer">
				<button id="message-dialog-cancel" class="dialog-button" type="button">Cancel</button>
				<button id="message-dialog-submit" class="dialog-button primary" type="button" disabled></button>
			</footer>
		</section>
	</div>
	<script nonce="${nonce}" src="${uri("media", "session-view.js")}"></script>
	<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
}
