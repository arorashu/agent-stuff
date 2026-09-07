import sessionIdStatus from "./session-id-status.ts";
import workTimer from "./work-timer.ts";

type Handler = (event: unknown, ctx: TestContext) => void | Promise<void>;

type Status = [key: string, text: string | undefined];

interface TestContext {
	hasUI: boolean;
	ui: {
		theme: { fg: (_color: string, text: string) => string };
		setStatus: (key: string, text: string | undefined) => void;
		notify: (message: string, type: string) => void;
	};
	sessionManager: { getSessionId: () => string };
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function register(factory: typeof workTimer | typeof sessionIdStatus) {
	const handlers = new Map<string, Handler>();
	factory({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
	return handlers;
}

function context(hasUI: boolean, statuses: Status[], notices: string[]): TestContext {
	return {
		hasUI,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (key, text) => statuses.push([key, text]),
			notify: (message) => notices.push(message),
		},
		sessionManager: { getSessionId: () => "test-session-id" },
	};
}

const originalNow = Date.now;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

try {
	let now = 0;
	let intervalStarts = 0;
	let intervalClears = 0;
	let intervalCallback: (() => void) | undefined;
	let intervalDelay: number | undefined;
	Date.now = () => now;
	globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
		assert(typeof callback === "function", "work timer must use a callback interval");
		intervalStarts++;
		intervalCallback = callback;
		intervalDelay = delay;
		return intervalStarts as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((_: ReturnType<typeof setInterval>) => {
		intervalClears++;
	}) as typeof clearInterval;

	const statuses: Status[] = [];
	const notices: string[] = [];
	const timerHandlers = register(workTimer);
	const timerCtx = context(true, statuses, notices);
	const agentStart = timerHandlers.get("agent_start");
	const agentSettled = timerHandlers.get("agent_settled");
	const sessionShutdown = timerHandlers.get("session_shutdown");
	assert(agentStart && agentSettled && sessionShutdown, "work timer must register lifecycle handlers");
	assert(!timerHandlers.has("agent_end"), "work timer must wait for agent_settled, not agent_end");

	await agentStart({}, timerCtx);
	assert(intervalDelay === 500, "work timer must update the footer every 500 ms");
	assert(intervalCallback, "work timer must retain a live-update callback");
	now = 1_000;
	intervalCallback();
	assert(statuses.at(-1)?.[1] === "⏱ 0:01", "interval callback must update the live footer duration");

	now = 1_200;
	await agentStart({}, timerCtx); // Simulates a retry or queued follow-up.
	assert(intervalStarts === 1, "retries must not start a second work timer");

	now = 1_700;
	await agentSettled({}, timerCtx);
	assert(intervalClears === 1, "settling must stop the work timer");
	assert(notices.at(-1) === "Work time: 0:01", "settling must emit the final UI-only duration");
	assert(statuses.at(-1)?.[1] === "✓ 0:01", "settling must retain the final footer duration");

	await sessionShutdown({}, timerCtx);
	assert(statuses.at(-1)?.[1] === undefined, "shutdown must clear the work-timer status");

	const headlessStatuses: Status[] = [];
	const headlessNotices: string[] = [];
	const headlessCtx = context(false, headlessStatuses, headlessNotices);
	await agentStart({}, headlessCtx);
	now = 2_700;
	await agentSettled({}, headlessCtx);
	assert(intervalStarts === 1, "headless runs must not start a footer update interval");
	assert(headlessStatuses.length === 0 && headlessNotices.length === 0, "headless runs must not emit UI output");

	const sessionStatuses: Status[] = [];
	const sessionNotices: string[] = [];
	const sessionHandlers = register(sessionIdStatus);
	const sessionStart = sessionHandlers.get("session_start");
	assert(sessionStart, "session status must register session_start");
	await sessionStart({}, context(true, sessionStatuses, sessionNotices));
	assert(sessionStatuses.at(-1)?.[0] === "session-id", "session status must use its own footer key");
	assert(sessionStatuses.at(-1)?.[1] === "session test-session-id", "session status must show the session ID");

	const headlessSessionStatuses: Status[] = [];
	await sessionStart({}, context(false, headlessSessionStatuses, []));
	assert(headlessSessionStatuses.length === 0, "headless session start must not emit UI output");

	console.log("pi extension behavior tests passed");
} finally {
	Date.now = originalNow;
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
}
