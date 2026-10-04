// Only mutate standard Anthropic Messages payloads. Other Pi adapters retain
// their native prefix caching and reasoning serialization unchanged.
export function cachePayload(payload) {
  if (!Array.isArray(payload?.messages) || !('max_tokens' in payload)) return payload;
  const copy = structuredClone(payload);
  let content;
  for (const message of copy.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const index = message.content.findIndex(p => p.type === 'text' && p.text.startsWith('<chat>\n'));
    if (index >= 0) { content = { message, index, text: message.content[index].text }; break; }
  }
  if (!content) return payload;
  // Four breakpoints total: three inside the view, plus automatic request end.
  delete copy.cache_control;
  for (const tool of copy.tools ?? []) delete tool.cache_control;
  for (const block of Array.isArray(copy.system) ? copy.system : []) delete block.cache_control;
  for (const message of copy.messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) delete block.cache_control;
  }
  const pieces = [];
  let last = 0;
  for (const mark of [50000, 80000, 100000]) {
    if (mark >= content.text.length) continue;
    const cut = content.text.lastIndexOf('\n', mark) + 1;
    if (cut <= last) continue;
    pieces.push({ type: 'text', text: content.text.slice(last, cut), cache_control: { type: 'ephemeral' } });
    last = cut;
  }
  if (last < content.text.length) pieces.push({ type: 'text', text: content.text.slice(last) });
  content.message.content.splice(content.index, 1, ...pieces);
  copy.cache_control = { type: 'ephemeral' };
  return copy;
}

export function capText(text, limit = 30000) {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const marker = `\n[OptChat: tool output truncated; ${chars.length} characters originally]\n`;
  const half = Math.floor((limit - marker.length) / 2);
  return chars.slice(0, half).join('') + marker + chars.slice(-half).join('');
}

export function messageEntries(message) {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
  if (message.role === 'assistant') return content.flatMap(p => {
    if (p.type === 'text' && p.text) return [{ kind: 'talk', text: p.text }];
    if (p.type === 'toolCall') return [{ kind: 'tool', text: `${p.name} ${JSON.stringify(p.arguments)}` }];
    return []; // Thinking and encrypted reasoning stay in-turn only.
  });
  const text = content.map(p => p.type === 'text' ? p.text : p.type === 'image' ? '[Image attachment: not archived by this text-only launcher]' : '').filter(Boolean).join('\n');
  if (message.role === 'user') return [{ kind: 'user', text }];
  if (message.role === 'toolResult') return [{ kind: 'echo', text: capText(`${message.toolName}${message.isError ? ' (error)' : ''}: ${text}`) }];
  return [];
}
