import { REQUEST_TIMEOUT_MS } from './timing';
// The registry is the only authority for connection destinations. Invitations carry IDs.
export interface ServerContext {
  id: string;
  name: string;
  origin: string;
  publicKey: string;
  online: boolean;
  compatible: boolean;
}
let selected: ServerContext | undefined;
export function serverContext(): ServerContext {
  if (!selected) throw new Error('Open a room or a management page.');
  return selected;
}
export function installServerContext(value: ServerContext): void {
  selected = Object.freeze({ ...value });
}
export async function resolveServer(
  page = new URL(location.href),
): Promise<ServerContext | undefined> {
  let id: string;
  let endpoint: string;
  if (page.pathname.startsWith('/rooms/')) {
    const ref = page.pathname.slice('/rooms/'.length);
    if (!/^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(ref)) throw new Error('Invalid room reference.');
    id = ref.split('.')[0]!;
    endpoint = `/api/v1/rooms/${ref}`;
  } else if (page.pathname.startsWith('/manage/servers/')) {
    id = page.pathname.slice('/manage/servers/'.length);
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid management link.');
    endpoint = `/api/v1/manage/servers/${id}`;
  } else return undefined;
  const response = await fetch(endpoint, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in to open server management.'
        : 'This room or server is unavailable. Please retry later.',
    );
  const result = (await response.json()) as ServerContext & { server: ServerContext };
  const value = page.pathname.startsWith('/rooms/') ? result.server : result;
  const origin = new URL(value.origin);
  const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
  if (
    value.id !== id ||
    typeof value.name !== 'string' ||
    typeof value.publicKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.publicKey) ||
    origin.origin !== value.origin ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && loopback(origin.hostname) && loopback(page.hostname)))
  )
    throw new Error('Invalid registered server address.');
  if (!value.online || !value.compatible)
    throw new Error('This server is offline or needs an update. Return to the room catalog.');
  installServerContext(value);
  return value;
}
export function serverURL(path: string, context = serverContext()): URL {
  const url = new URL(path, context.origin);
  if (url.origin !== context.origin)
    throw new Error('Server resource escaped its registered origin.');
  return url;
}
