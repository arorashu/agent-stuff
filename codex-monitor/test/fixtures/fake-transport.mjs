export class RpcError extends Error {}
export async function withClient(socket, fn) {
  let sent = null;
  const client = {
    async request(method, params) {
      if (method === "thread/list") return { data: [] };
      if (method === "turn/start") {
        sent = params;
        return { turn: { id: "fake-turn", status: "inProgress" }, capturedPayload: params };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "fake-turn", status: "completed", items: sent.input }] };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
    async waitForNotification(predicate) {
      const event = { method: "turn/completed", params: { threadId: sent.threadId, turn: { id: "fake-turn" } } };
      if (!predicate(event)) throw new Error("Notification predicate did not match");
      return event;
    },
  };
  return fn(client);
}
