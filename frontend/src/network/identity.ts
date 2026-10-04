import type { ServerIdentity } from '../contracts/server';
import { serverContext, serverURL } from './context';
import { PROOF_REFRESH_MARGIN_MS, REQUEST_TIMEOUT_MS } from './timing';
export type { ServerIdentity } from '../contracts/server';
const transientGuests = new Map<string, string>();
export function guestIdentity(serverID = serverContext().id): string {
  const key = `baboreborn.guest.v1:${serverID}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
    const value = crypto.randomUUID().replaceAll('-', '');
    localStorage.setItem(key, value);
    return value;
  } catch {
    let value = transientGuests.get(serverID);
    if (!value) {
      value = crypto.randomUUID().replaceAll('-', '');
      transientGuests.set(serverID, value);
    }
    return value;
  }
}
export class ServerAPIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
interface Account {
  account: string;
  expired: boolean;
  loginAvailable: boolean;
}
interface Proof {
  proof: string;
  expiresAt: string;
}
let account: Account | undefined;
let credential: Proof | undefined;
let pending: Promise<void> | undefined;
const listeners = new Set<(proof: string) => void>();
export function onProof(listener: (proof: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export async function initializeIdentity(): Promise<void> {
  const response = await fetch('/api/v1/account', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Account unavailable.');
  account = (await response.json()) as Account;
  credential = undefined;
  // A new document starts as Guest when central has no valid account session.
  if (account.account) {
    try {
      await refreshProof();
    } catch (error) {
      if (!(error instanceof ServerAPIError) || error.status !== 401) throw error;
      account.account = '';
    }
  }
}
async function refreshProof(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch('/identity/v1/access', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: serverContext().id }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) {
      if (account) account.expired = true;
      throw new ServerAPIError('Authentication expired', 401);
    }
    if (!response.ok) throw new Error('Unable to renew access to this server.');
    const result = (await response.json()) as Proof;
    if (typeof result.proof !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)))
      throw new Error('Invalid access proof.');
    credential = result;
    for (const listener of listeners) listener(result.proof);
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
export async function authentication(): Promise<{ proof: string } | { guest: string }> {
  if (!account) await initializeIdentity();
  if (!account?.account) return { guest: guestIdentity() };
  // An active account must leave the match before starting a new Guest session.
  if (account?.expired) throw new ServerAPIError('Authentication expired', 401);
  if (!credential || Date.parse(credential.expiresAt) <= Date.now() + PROOF_REFRESH_MARGIN_MS) {
    try {
      await refreshProof();
    } catch (error) {
      if (!credential || Date.parse(credential.expiresAt) <= Date.now() || account?.expired)
        throw error;
    }
  }
  return { proof: credential!.proof };
}
export async function maintainProof(): Promise<void> {
  await authentication();
}
export async function serverAPI<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const auth = await authentication();
  const response = await fetch(serverURL(path), {
    method,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      ...('proof' in auth
        ? { Authorization: `Bearer ${auth.proof}` }
        : { 'X-Guest-ID': auth.guest }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      result && typeof result === 'object' && 'error' in result
        ? String(result.error)
        : 'Request failed';
    throw new ServerAPIError(message.replaceAll('_', ' '), response.status, result);
  }
  return result as T;
}
export async function readIdentity(signal?: AbortSignal): Promise<ServerIdentity> {
  try {
    return {
      ...(await serverAPI<Omit<ServerIdentity, 'expired'>>('/api/v1/me', 'GET', undefined, signal)),
      central: location.origin,
      expired: false,
    };
  } catch (error) {
    if (!(error instanceof ServerAPIError) || error.status !== 401) throw error;
    return {
      subject: '',
      role: 'player',
      loginAvailable: account?.loginAvailable === true,
      central: location.origin,
      expired: true,
    };
  }
}
export async function signOut(): Promise<void> {
  const response = await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('Unable to sign out.');
  credential = undefined;
  account = { account: '', expired: true, loginAvailable: true };
  const channel = new BroadcastChannel('baboreborn.account');
  channel.postMessage('signed-out');
  channel.close();
}
export function watchAccount(onEnd: () => void): () => void {
  const channel = new BroadcastChannel('baboreborn.account');
  channel.onmessage = () => {
    credential = undefined;
    if (account) account.expired = true;
    onEnd();
  };
  return () => channel.close();
}

export async function publicServerAPI<T>(path: string): Promise<T> {
  const response = await fetch(serverURL(path), {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Server directory unavailable.');
  return (await response.json()) as T;
}
