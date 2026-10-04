import { currentContent } from '../content/runtime';
import * as tuning from '../gameconfig/tuning';
import { PROTOCOL } from '../contracts/session';

import type { ServerInfo } from '../contracts/server';
import { isRoomDetails } from '../contracts/server';
import { isMode } from '../contracts/mode';
export type { ServerInfo } from '../contracts/server';

function tuningValues(): Record<string, number | boolean> {
  const title = (name: string) => name[0]!.toUpperCase() + name.slice(1);
  return Object.fromEntries(
    Object.entries(tuning).flatMap(([group, fields]) => {
      const prefix = group
        .split('_')
        .map((part) => title(part.toLowerCase()))
        .join('');
      return Object.entries(fields).map(([key, value]) => [prefix + title(key), value]);
    }),
  );
}

let profile: Promise<string> | undefined;
export function gameProfile(): Promise<string> {
  // Canonical binary64 values avoid language-specific decimal serialization.
  return (profile ??= (async () => {
    const values = tuningValues();
    const data = new DataView(new ArrayBuffer(8));
    const canonical = Object.keys(values)
      .sort()
      .map((key) => {
        const value = values[key]!;
        let encoded: string;
        if (typeof value === 'boolean') encoded = value ? 'b1' : 'b0';
        else {
          data.setFloat64(0, value);
          encoded =
            'n' +
            Array.from(new Uint8Array(data.buffer), (v) => v.toString(16).padStart(2, '0')).join(
              '',
            );
        }
        return `${key}=${encoded}\n`;
      })
      .join('');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
  })());
}

export function parseServerInfo(raw: unknown): ServerInfo {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid server information.');
  const s = raw as ServerInfo;
  if (
    s.schema !== 1 ||
    !isMode(s.mode) ||
    ![s.name, s.map].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 80) ||
    !Number.isSafeInteger(s.protocol) ||
    typeof s.profile !== 'string' ||
    !/^[a-f0-9]{64}$/.test(s.profile) ||
    !Number.isSafeInteger(s.occupied) ||
    !Number.isSafeInteger(s.capacity) ||
    s.occupied < 0 ||
    s.capacity < 2 ||
    s.capacity > 16 ||
    s.occupied > s.capacity ||
    !isRoomDetails(s.details, s.occupied)
  )
    throw new Error('Invalid server information.');
  return s;
}

export function availability(info: ServerInfo, expectedProfile: string): string | null {
  if (info.protocol !== PROTOCOL)
    return 'This room uses a different game version. Reload the game and try again.';
  if (info.profile !== expectedProfile) return 'This room uses incompatible gameplay settings.';
  if (info.occupied >= info.capacity) return 'Room full. Retry when a slot is available.';
  return null;
}

function probeServer(address: URL): Promise<ServerInfo> {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    url.searchParams.delete('v');
    url.searchParams.delete('profile');
    url.searchParams.set('info', '1');
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error?: Error, info?: ServerInfo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(info!);
    };
    const timer = setTimeout(
      () => finish(new Error('Server unreachable. Check the address or try again.')),
      4000,
    );
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 8192)
          throw new Error('Invalid server information.');
        finish(undefined, parseServerInfo(JSON.parse(event.data)));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid server information.'));
      }
    });
    socket.addEventListener('error', () =>
      finish(new Error('Server unreachable. Check the address or try again.')),
    );
    socket.addEventListener('close', () =>
      finish(new Error('This server is unavailable or needs an update.')),
    );
  });
}

export async function prepareConnection(address: URL): Promise<{ url: URL; info: ServerInfo }> {
  const [info, expected] = await Promise.all([probeServer(address), gameProfile()]);
  const problem = availability(info, expected);
  if (problem) throw new Error(problem);
  const url = new URL(address);
  url.searchParams.delete('info');
  url.searchParams.set('v', String(PROTOCOL));
  url.searchParams.set('profile', expected);
  url.searchParams.set('content', currentContent().revision);
  return { url, info };
}
