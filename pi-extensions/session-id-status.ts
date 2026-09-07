/** Displays the current Pi session ID in the default footer. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "session-id";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_ID,
			ctx.ui.theme.fg("dim", `session ${ctx.sessionManager.getSessionId()}`),
		);
	});
}
