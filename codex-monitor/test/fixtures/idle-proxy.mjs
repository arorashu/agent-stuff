#!/usr/bin/env node
// Idle stand-in for a "codex" app-server proxy that never completes the
// WebSocket upgrade. Used via CODEX_MONITOR_CODEX_BIN by the unhandled
// rejection regression test; exits on the default SIGTERM. The interval is
// intentionally referenced so the process stays alive until signaled, and the
// shebang + executable bit let AppServerClient spawn it directly.
setInterval(() => {}, 1000);
