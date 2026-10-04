import { afterEach } from 'node:test';
import { createRoot } from 'solid-js';
import { notifyManager } from '@tanstack/solid-query';
import type { QueryClient } from '@tanstack/solid-query';
import { createAppQueryClient } from '../../src/bootstrap/queries';

// Keep observer delivery deterministic; HTTP completion remains asynchronous.
notifyManager.setScheduler(queueMicrotask);
const scopes: (() => void)[] = [];
afterEach(() => {
  for (const dispose of scopes.splice(0)) dispose();
});
export function queryScope<T>(factory: (client: QueryClient) => T) {
  const client = createAppQueryClient();
  return createRoot((disposeRoot) => {
    const dispose = () => {
      disposeRoot();
      client.clear();
    };
    scopes.push(dispose);
    return { value: factory(client), dispose, client };
  });
}
export async function flushQueries() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
