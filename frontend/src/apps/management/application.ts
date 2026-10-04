import { onCleanup } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import type { QueryClient } from '@tanstack/solid-query';
import type { ManagedRoomDirectory, ServerIdentity } from '../../contracts/server';

export const REFRESH_INTERVAL_MS = 5000;

export interface ManagementData {
  identity: ServerIdentity;
  directory: ManagedRoomDirectory;
}
export interface ManagementPorts {
  load(signal: AbortSignal): Promise<ManagementData>;
}
export class ManagementUnavailableError extends Error {}
export function managesRooms(identity: ServerIdentity): boolean {
  return !identity.expired && ['owner', 'admin'].includes(identity.role);
}
export function moderates(identity: ServerIdentity): boolean {
  return managesRooms(identity) || (!identity.expired && identity.role === 'moderator');
}

export type ManagementContext = ReturnType<typeof createManagement>;
export function createManagement(ports: ManagementPorts, client: QueryClient) {
  const query = createQuery(
    () => ({
      queryKey: ['management'],
      queryFn: ({ signal }) => ports.load(signal),
      refetchInterval: REFRESH_INTERVAL_MS,
    }),
    () => client,
  );
  const state = {
    // Temporary outages preserve drafts, but any error blocks administrative writes.
    get data() {
      return query.error && !(query.error instanceof ManagementUnavailableError)
        ? null
        : (query.data ?? null);
    },
    get loading() {
      return query.isFetching;
    },
    get error() {
      return query.error?.message ?? '';
    },
  };
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  async function refresh() {
    if (disposed) return;
    await client.cancelQueries({ queryKey: ['management'] });
    await query.refetch();
  }
  return { state, refresh };
}
