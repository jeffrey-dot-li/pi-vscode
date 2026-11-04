(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.PiSessionView = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	const MINUTE_MS = 60 * 1000;
	const HOUR_MS = 60 * MINUTE_MS;
	const DAY_MS = 24 * HOUR_MS;
	const ARCHIVE_GROUP = "Archive";
	const RECENCY_GROUPS = ["Today", "Yesterday", "Last 7 Days", "Last 30 Days", "Older"];

	// The host sends updatedAtMs as the time of the user's last prompt (not the file
	// mtime, which moves on every streamed write and made the list reshuffle constantly).
	function sessionTimestamp(session) {
		const updated = session && session.updatedAtMs;
		if (typeof updated === "number" && Number.isFinite(updated)) return updated;
		const created = session && session.createdAtMs;
		return typeof created === "number" && Number.isFinite(created) ? created : 0;
	}

	// Stable order: last prompt, then creation time, then id, so equal timestamps never swap.
	function compareSessions(a, b) {
		const created = (session) => (session && Number.isFinite(session.createdAtMs) ? session.createdAtMs : 0);
		const id = (session) => String((session && session.id) || "");
		return (
			sessionTimestamp(b) - sessionTimestamp(a) ||
			created(b) - created(a) ||
			(id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0)
		);
	}

	function formatAge(timestampMs, nowMs) {
		if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) return "";
		const elapsed = nowMs - timestampMs;
		if (elapsed < MINUTE_MS) return "now";
		if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
		if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
		const days = Math.floor(elapsed / DAY_MS);
		return days < 365 ? `${days}d ago` : `${Math.floor(days / 365)}y ago`;
	}

	function startOfDay(timestampMs) {
		const date = new Date(timestampMs);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	}

	function recencyGroup(timestampMs, nowMs) {
		const days = Math.round((startOfDay(nowMs) - startOfDay(timestampMs)) / DAY_MS);
		if (days <= 0) return "Today";
		if (days === 1) return "Yesterday";
		if (days <= 7) return "Last 7 Days";
		if (days <= 30) return "Last 30 Days";
		return "Older";
	}

	function matchesQuery(session, query) {
		const needle = String(query || "").trim().toLowerCase();
		if (!needle) return true;
		// Searching a folder name (e.g. "tax") finds that folder's sessions in multi-root workspaces.
		return [session && session.title, session && session.folder].some((text) =>
			String(text || "").toLowerCase().includes(needle),
		);
	}

	function sessionActionAvailable(session) {
		const state = session && session.state;
		return state !== "starting" && state !== "working";
	}

	function groupSessions(sessions, options) {
		const settings = options || {};
		const nowMs = Number.isFinite(settings.nowMs) ? settings.nowMs : 0;
		const ordered = (sessions || [])
			.filter((session) => matchesQuery(session, settings.query))
			.slice()
			.sort(compareSessions);

		const buckets = new Map();
		for (const session of ordered) {
			const title = session.archived ? ARCHIVE_GROUP : recencyGroup(sessionTimestamp(session), nowMs);
			const bucket = buckets.get(title);
			if (bucket) bucket.push(session);
			else buckets.set(title, [session]);
		}

		return RECENCY_GROUPS.concat(ARCHIVE_GROUP)
			.filter((title) => buckets.has(title))
			.map((title) => ({ title, sessions: buckets.get(title) }));
	}

	return { ARCHIVE_GROUP, compareSessions, formatAge, groupSessions, matchesQuery, recencyGroup, sessionActionAvailable, sessionTimestamp };
});
