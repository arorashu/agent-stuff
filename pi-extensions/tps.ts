/**
 * TPS (Tokens Per Second) Extension
 *
 * Displays real-time streaming speed in the footer during model generation.
 * Shows per-message TPS and session-average TPS, both persistent.
 * Toggle with /tps.
 *
 * Footer row 3 layout (alpha-sorted by status key):
 *   avg 55.6   42.3 t/s (399 tok)
 *   └─ tps-avg ─┘ └── tps-msg ───────┘
 *
 * Usage: drop in ~/.pi/agent/extensions/ and restart pi, or
 * pi -e ~/.pi/agent/extensions/tps.ts
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_AVG = "tps-avg";
const STATUS_PER_MSG = "tps-msg"; // "avg" < "msg" alphabetically

export default function (pi: ExtensionAPI) {
	let enabled = true;

	// Per-message tracking
	let messageStartTime: number | null = null;
	let tokenCount = 0;
	let lastRenderTime: number | null = null;
	let currentTps = 0;

	// Session-wide accumulators (reset on new session)
	let sessionOutputTokens = 0;
	let sessionGenTimeMs = 0;

	function clearPerMessage(ctx?: { ui: { setStatus: (id: string, text: string | undefined) => void } }) {
		messageStartTime = null;
		tokenCount = 0;
		lastRenderTime = null;
		currentTps = 0;
		if (ctx) ctx.ui.setStatus(STATUS_PER_MSG, undefined);
	}

	function formatTps(tps: number): string {
		if (tps >= 100) return tps.toFixed(0);
		if (tps >= 10) return tps.toFixed(1);
		return tps.toFixed(1);
	}

	function renderAvg(ctx: { ui: { setStatus: (id: string, text: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } }) {
		if (sessionGenTimeMs > 0) {
			const avg = sessionOutputTokens / (sessionGenTimeMs / 1000);
			ctx.ui.setStatus(STATUS_AVG, ctx.ui.theme.fg("dim", `avg ${formatTps(avg)}`));
		} else {
			ctx.ui.setStatus(STATUS_AVG, undefined);
		}
	}

	function updateSessionAvg(outputTokens: number, genTimeMs: number) {
		sessionOutputTokens += outputTokens;
		sessionGenTimeMs += genTimeMs;
	}

	// Reset on new session
	pi.on("session_start", async (_event, ctx) => {
		clearPerMessage(ctx);
		sessionOutputTokens = 0;
		sessionGenTimeMs = 0;
		ctx.ui.setStatus(STATUS_AVG, undefined);
	});

	// Begin tracking on assistant message start
	pi.on("message_start", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		clearPerMessage();
		messageStartTime = performance.now();
		tokenCount = 0;
		lastRenderTime = null;
		currentTps = 0;

		// Show waiting indicator in per-message slot
		ctx.ui.setStatus(STATUS_PER_MSG, ctx.ui.theme.fg("dim", "… t/s"));
	});

	// Count tokens and update display during streaming
	pi.on("message_update", async (_event, ctx) => {
		if (!enabled) return;
		if (!messageStartTime) return;

		tokenCount++;
		const now = performance.now();

		// Throttle rendering to ~4 updates/sec (every 250ms) to avoid terminal flicker
		if (lastRenderTime && now - lastRenderTime < 250) return;
		lastRenderTime = now;

		const elapsed = (now - messageStartTime) / 1000;
		if (elapsed > 0.05) {
			currentTps = tokenCount / elapsed;
		}

		ctx.ui.setStatus(STATUS_PER_MSG, ctx.ui.theme.fg("accent", `${formatTps(currentTps)} t/s`));
	});

	// Final TPS on message completion
	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		const endTime = performance.now();
		const startTime = messageStartTime ?? endTime;

		const outputTokens = (event.message as AssistantMessage).usage?.output ?? tokenCount;
		const genTimeMs = endTime - startTime;
		const elapsed = genTimeMs / 1000;
		const finalTps = elapsed > 0.01 ? outputTokens / elapsed : 0;

		// Update session-wide totals and render persistent avg
		updateSessionAvg(outputTokens, genTimeMs);
		renderAvg(ctx);

		// Show per-message final in ephemeral slot
		const tokenStr = outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : `${outputTokens}`;
		ctx.ui.setStatus(
			STATUS_PER_MSG,
			ctx.ui.theme.fg("success", `${formatTps(finalTps)} t/s`)
				+ ctx.ui.theme.fg("dim", ` (${tokenStr} tok)`),
		);

		// Reset per-message tracking (avg slot is NOT cleared)
		messageStartTime = null;
		tokenCount = 0;
		lastRenderTime = null;
		currentTps = 0;
	});

	// Handle aborted/cancelled streams
	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled) return;
		if (messageStartTime && tokenCount > 0) {
			const genTimeMs = performance.now() - messageStartTime;
			const elapsed = genTimeMs / 1000;
			if (elapsed > 0.05) {
				// Include partial generation in session totals
				updateSessionAvg(tokenCount, genTimeMs);
				renderAvg(ctx);

				const partialTps = tokenCount / elapsed;
				ctx.ui.setStatus(STATUS_PER_MSG, ctx.ui.theme.fg("warning", `${formatTps(partialTps)} t/s (partial)`));
			}
		}
		messageStartTime = null;
		tokenCount = 0;
		lastRenderTime = null;
		currentTps = 0;
	});

	// Toggle command
	pi.registerCommand("tps", {
		description: "Toggle tokens-per-second display in footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				ctx.ui.notify("TPS display enabled", "info");
			} else {
				ctx.ui.setStatus(STATUS_PER_MSG, undefined);
				ctx.ui.setStatus(STATUS_AVG, undefined);
				ctx.ui.notify("TPS display disabled", "info");
			}
		},
	});
}
