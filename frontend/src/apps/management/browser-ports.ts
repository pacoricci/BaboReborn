import { readIdentity, serverAPI, ServerAPIError } from '../../network/identity';
import { parseManagedRooms } from './directory';
import { moderates, ManagementUnavailableError } from './application';
import type { ManagementPorts } from './application';
export function browserManagementPorts(): ManagementPorts {
  return {
    async load(signal) {
      let identity;
      try {
        identity = await readIdentity(signal);
      } catch (error) {
        throw new ManagementUnavailableError(
          error instanceof Error ? error.message : 'Server unavailable.',
        );
      }
      if (!moderates(identity))
        throw new Error(
          identity.expired ? 'Sign in again to manage this server.' : 'Staff access is required.',
        );
      let directory;
      try {
        directory = parseManagedRooms(
          await serverAPI('/api/v1/admin/rooms', 'GET', undefined, signal),
        );
      } catch (error) {
        if (error instanceof ServerAPIError && [401, 403].includes(error.status)) throw error;
        throw new ManagementUnavailableError(
          'Connection interrupted. Your draft is preserved. Retry when the server is available.',
        );
      }
      return { identity, directory };
    },
  };
}
