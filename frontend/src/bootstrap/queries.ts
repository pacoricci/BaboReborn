import { QueryClient } from '@tanstack/solid-query';
import { onCleanup } from 'solid-js';

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        networkMode: 'always',
        gcTime: 0,
        refetchOnWindowFocus: 'always',
        refetchOnReconnect: 'always',
      },
      // Commands fail at the transport instead of being queued for a later reconnect.
      mutations: { retry: false, networkMode: 'always' },
    },
  });
}

/** Each document owns its cache; account changes never reuse another page's authority. */
export function createPageQueries() {
  const client = createAppQueryClient();
  client.mount();
  const restore = () => void client.refetchQueries({ type: 'active' });
  window.addEventListener('pageshow', restore);
  onCleanup(() => {
    window.removeEventListener('pageshow', restore);
    client.unmount();
    client.clear();
  });
  return client;
}
