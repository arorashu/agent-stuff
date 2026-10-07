import {
  deliveryStatusFromTurnStatus,
  getTurnId,
  waitForTurnReadback,
} from "./thread-delivery.mjs";

function senderLabel(flags, name) {
  if (!flags.has(name)) return null;
  const value = flags.get(name);
  if (typeof value !== "string" || !value || value !== value.trim() ||
      value.length > 128 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\[\]|]/u.test(value)) {
    throw new Error(`--${name} must be 1-128 characters, with no surrounding whitespace, controls, line breaks, [, ], or |`);
  }
  return value;
}

export function prepareThreadSend(flags) {
  const threadId = flags.get("thread-id");
  const message = flags.get("message");
  if (typeof threadId !== "string" || !threadId || typeof message !== "string" || !message) {
    throw new Error("thread send requires --thread-id and --message");
  }
  const alias = senderLabel(flags, "sender-alias");
  const taskId = senderLabel(flags, "sender-task-id");
  if (taskId !== null && alias === null) {
    throw new Error("--sender-task-id requires --sender-alias");
  }
  const waitValue = flags.get("wait-ms");
  const waitMs = waitValue === undefined || waitValue === true ? 120000 : Number(waitValue);
  if (!Number.isFinite(waitMs)) throw new Error("--wait-ms must be a number");
  const prefix = alias === null ? "" : `[Agent: ${alias}${taskId === null ? "" : ` | Task: ${taskId}`}] `;
  // Only the complete matching prefix, including its separator, is idempotent.
  const text = !prefix || message.startsWith(prefix) ? message : prefix + message;
  return { threadId, message: text, waitMs };
}

export async function sendThreadMessage(client, { threadId, message, waitMs }) {
  const start = await client.request("turn/start", { threadId, input: [{ type: "text", text: message }] }, 30000);
  const turnId = getTurnId(start.turn);
  let completed = null;
  try {
    completed = await client.waitForNotification(
      (event) => event.method === "turn/completed" &&
        event.params?.threadId === threadId &&
        getTurnId(event.params?.turn) === turnId,
      Math.min(waitMs, 10000),
    );
  } catch (err) {
    completed = { error: String(err.message ?? err) };
  }
  const readback = await waitForTurnReadback(client, {
    threadId,
    turnId,
    token: message,
    timeoutMs: waitMs,
    terminalOnly: true,
  });
  const readbackStatus = readback?.status ?? null;
  return {
    threadId,
    turnId,
    start,
    completed,
    readback,
    confirmedStatus: readbackStatus,
    deliveryState: readbackStatus ? deliveryStatusFromTurnStatus(readbackStatus) : "unconfirmed",
  };
}
