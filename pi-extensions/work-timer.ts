/**
 * Work Timer Extension
 *
 * Shows how long the agent has been working since the last user message
 * in the footer status line (via ctx.ui.setStatus).
 *
 * - While the agent is running: live elapsed timer, e.g. "⏱ 0:03"
 * - When the agent finishes: final duration, e.g. "✓ 0:12"
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "work-timer";
const UPDATE_MS = 500;

const DEBUG = process.env.WORK_TIMER_DEBUG === "1";
function debug(...args: unknown[]) {
	if (DEBUG) console.error("[work-timer]", ...args);
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
	let startTime = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = false;

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		running = false;
	};

	const updateStatus = (ctx: ExtensionContext, final = false) => {
		const elapsed = Math.max(0, Date.now() - startTime);
		const time = formatDuration(elapsed);
		debug(final ? "final" : "status", elapsed, time);

		if (!ctx.hasUI) return;

		const theme = ctx.ui.theme;
		if (final) {
			const icon = theme.fg("success", "✓");
			const text = theme.fg("dim", ` ${time}`);
			ctx.ui.setStatus(STATUS_KEY, icon + text);
		} else {
			const icon = theme.fg("accent", "⏱");
			const text = theme.fg("text", ` ${time}`);
			ctx.ui.setStatus(STATUS_KEY, icon + text);
		}
	};

	const startTimer = (ctx: ExtensionContext) => {
		stopTimer();
		startTime = Date.now();
		running = true;
		debug("start", startTime);
		updateStatus(ctx);
		timer = setInterval(() => {
			updateStatus(ctx);
		}, UPDATE_MS);
	};

	// Agent started working on the latest user message.
	pi.on("agent_start", async (_event, ctx) => {
		startTimer(ctx);
	});

	// Agent finished; freeze the final duration in the status line.
	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		updateStatus(ctx, true);
	});

	// NOTE: We intentionally do NOT reset on steering messages.
	// The timer measures the total agent work time for the current run.
	// A queued follow-up naturally starts its own next run, so the timer resets
	// only when the next `agent_start` fires.

	// Cleanup when the session shuts down or reloads.
	pi.on("session_shutdown", async () => {
		stopTimer();
	});
}
