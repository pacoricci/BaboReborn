const REGISTRY_TIMEOUT_MS = 10_000;

export interface ServerRelease {
  installed: string;
  recommended: string;
  status:
    'unknown' | 'current' | 'compatible' | 'update_available' | 'update_required' | 'incompatible';
  checkedAt: string | null;
  differences: { contract: string; expected: string; received: string }[];
  notesUrl: string;
}
export interface Server {
  release?: ServerRelease;
  role: string;
  assignmentVerified: boolean;
  id: string;
  name: string;
  region: string;
  origin: string;
  owner: string;
  revision: number;
  appliedRevision: number;
  publicKey: string;
  status: string;
  online: boolean;
  compatible: boolean;
  lastVerifiedAt: string | null;
  error?: string;
  candidateOrigin?: string;
  transferExpiresAt?: string;
  transferTo?: string;
  transferAccepted: boolean;
}
export const registryErrors: Record<string, string> = {
  invalid_server_data:
    'Check the name (100 characters), region (80 characters) and public HTTPS address.',
  stale_revision:
    'This server changed while you were editing. Close settings and reopen them to review its latest details.',
  operation_pending:
    'The server is still applying its previous change. Wait for confirmation, then retry.',
  origin_already_registered:
    'This public address already belongs to a registered server. Open its settings instead.',
  invalid_transfer: 'Enter the recipient’s 32-character Account ID from their Account page.',
  account_not_found: 'That account was not found. Ask the recipient to copy their Account ID.',
  transfer_pending: 'Resolve the ownership transfer before changing the installation.',
  pending_registration_limit:
    'You have 10 unassociated installations. Associate or remove one before registering another.',
};
export async function registryAPI<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REGISTRY_TIMEOUT_MS)])
      : AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const code = String(
      result && typeof result === 'object' && 'error' in result ? result.error : 'Request failed',
    );
    throw new Error(
      response.status === 401
        ? 'Your session ended. Sign in again from Account.'
        : (registryErrors[code] ?? code.replaceAll('_', ' ')),
    );
  }
  return result as T;
}
export function serverState(server: Server): string {
  if (server.candidateOrigin) return 'Verifying new address';
  if (server.publicKey && server.revision !== server.appliedRevision) return 'Applying changes';
  if (server.release?.status === 'update_required') return 'Update required';
  if (server.release?.status === 'incompatible') return 'Incompatible version';
  if (server.online)
    return server.release?.status === 'update_available' ? 'Online · update available' : 'Online';
  if (server.status === 'pending' && !server.publicKey) return 'Awaiting association';
  return server.compatible ? 'Offline' : 'Verification required';
}

export function releaseSummary(release: ServerRelease): string {
  const versions = `Installed: ${release.installed || 'unknown'} · Recommended: ${release.recommended}`;
  if (release.status === 'unknown') return `${versions} · Awaiting verification`;
  if (release.status === 'update_required') return `${versions} · Update to restore compatibility`;
  if (release.status === 'incompatible') return `${versions} · Contracts do not match this central`;
  if (release.status === 'update_available') return `${versions} · Update available`;
  return versions;
}
