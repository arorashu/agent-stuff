import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
const mode = process.argv[2];
const watcher = watch(new URL(import.meta.url));
let upgraded = false;
let buffer = Buffer.alloc(0);
function textFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length >= 126) throw new Error('Fixture response too large');
  process.stdout.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
}
process.stdin.on('data', data => {
  if (mode === 'timeout') return;
  buffer = Buffer.concat([buffer, data]);
  if (!upgraded) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    if (mode === 'bad-handshake' || mode === 'ignore-term') {
      process.stdout.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      buffer = Buffer.alloc(0);
      return;
    }
    const key = buffer.subarray(0, end).toString().match(/Sec-WebSocket-Key: ([^\r]+)/)[1];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    process.stdout.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    buffer = buffer.subarray(end + 4);
    upgraded = true;
    if (mode === 'early-close') {
      process.stdout.write(Buffer.from([0x88, 0x00]));
      return;
    }
  }
  while (buffer.length >= 2) {
    const opcode = buffer[0] & 15;
    let length = buffer[1] & 127;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    }
    if (length === 127) throw new Error('Fixture does not support large frames');
    if (buffer.length < offset + 4 + length) return;
    const mask = buffer.subarray(offset, offset + 4);
    const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    buffer = buffer.subarray(offset + 4 + length);
    if (opcode !== 1) continue;
    const request = JSON.parse(body.toString());
    if (request.id !== undefined) textFrame({ id: request.id, result: { ok: true } });
  }
});
process.on('SIGTERM', () => {
  if (mode === 'ignore-term') return;
  watcher.close();
  process.exit(0);
});
