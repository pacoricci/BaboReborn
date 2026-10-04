// WebSocket text is UTF-8 on the wire, but JavaScript string.length counts UTF-16.
// These are application bytes before compression, not transport traffic.
export function payloadBytes(text: string | ArrayBuffer | Uint8Array): number {
  if (typeof text !== 'string') return text.byteLength;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
