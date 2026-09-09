const DEFAULT_DELIVERY_READBACK_WAIT_MS = 30000;
const TURN_SUCCESS_STATUSES = new Set(["completed", "success", "succeeded"]);
const TURN_FAILURE_STATUSES = new Set(["failed", "failure", "error", "systemError", "cancelled", "canceled", "interrupted"]);
const TURN_ACTIVE_STATUSES = new Set(["active", "inProgress", "running", "queued", "pending"]);

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function threadStatusType(threadOrStatus) {
  const status = threadOrStatus?.status ?? threadOrStatus;
  if (!status) return "unknown";
  if (typeof status === "string") return status;
  if (typeof status.type === "string") return status.type;
  if (typeof status.status === "string") return status.status;
  return "unknown";
}

export function getThreadId(thread) {
  return thread?.id ?? thread?.threadId ?? thread?.thread?.id ?? thread?.thread?.threadId;
}

export function getTurnId(turn) {
  return turn?.id ?? turn?.turnId ?? turn?.turn?.id ?? turn?.turn?.turnId;
}

export function itemText(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof item.command === "string") return item.command;
  return "";
}

export function turnContainsText(turn, needle) {
  const haystack = JSON.stringify(turn);
  return haystack.includes(needle);
}

export async function readThread(client, threadId) {
  const result = await client.request("thread/read", { threadId, includeTurns: false });
  return result.thread ?? result;
}

export async function recentTurns(client, threadId, limit = 20) {
  const result = await client.request("thread/turns/list", {
    threadId,
    limit,
    sortDirection: "desc",
    itemsView: "summary",
  });
  return result.data ?? result.turns ?? result.items ?? [];
}

export function findTurn(turns, { turnId = null, token = null } = {}) {
  return turns.find((turn) => {
    if (turnId && getTurnId(turn) === turnId) return true;
    if (token && turnContainsText(turn, token)) return true;
    return false;
  }) ?? null;
}

export function deliveryStatusFromTurnStatus(status) {
  if (TURN_SUCCESS_STATUSES.has(status)) return "delivered";
  if (TURN_FAILURE_STATUSES.has(status)) return "failed";
  if (TURN_ACTIVE_STATUSES.has(status)) return "waiting_turn_completion";
  return "waiting_turn_readback";
}

export async function findDeliveryTurn(client, threadId, { turnId = null, token = null, limit = 25 } = {}) {
  if (!turnId && !token) return null;
  const turns = await recentTurns(client, threadId, limit);
  const turn = findTurn(turns, { turnId, token });
  if (!turn) return null;
  return {
    turn,
    turnId: getTurnId(turn),
    status: threadStatusType(turn),
    tokenFound: token ? turnContainsText(turn, token) : false,
  };
}

export async function waitForTurnReadback(client, {
  threadId,
  turnId = null,
  token = null,
  timeoutMs = DEFAULT_DELIVERY_READBACK_WAIT_MS,
  intervalMs = 1000,
  terminalOnly = false,
} = {}) {
  const started = nowMs();
  let last = null;
  do {
    last = await findDeliveryTurn(client, threadId, { turnId, token });
    if (last) {
      const state = deliveryStatusFromTurnStatus(last.status);
      if (!terminalOnly || state === "delivered" || state === "failed") {
        return last;
      }
    }
    if (timeoutMs <= 0) {
      return last;
    }
    await sleep(intervalMs);
  } while (nowMs() - started < timeoutMs);
  return last;
}

export function applyDeliveryTurnResult(monitor, result, { now = nowMs() } = {}) {
  const status = result?.status ?? "unknown";
  const deliveryState = deliveryStatusFromTurnStatus(status);
  monitor.delivery = monitor.delivery ?? {};
  if (result?.turnId) monitor.delivery.turn_id = result.turnId;
  monitor.delivery.completed_status = status;
  monitor.delivery.readback_at = nowIso();
  monitor.delivery_state = deliveryState;
  monitor.updated_at = nowIso();
  if (deliveryState === "delivered") {
    monitor.delivered_at = nowIso();
    delete monitor.delivery_error;
    delete monitor.next_delivery_attempt_at_ms;
  } else if (deliveryState === "failed") {
    monitor.delivery_error = `delivery turn ${result?.turnId ?? monitor.delivery.turn_id ?? "unknown"} ended with status ${status}`;
    delete monitor.next_delivery_attempt_at_ms;
  } else {
    monitor.next_delivery_attempt_at_ms = now + 5000;
  }
  return deliveryState;
}
