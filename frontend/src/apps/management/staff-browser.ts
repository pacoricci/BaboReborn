import { serverAPI } from '../../network/identity';
import type { Audit, Operation, Person, StaffPorts, StaffRole } from './staff-application';
import type { Restriction } from '../../contracts/server';
export function browserStaffPorts(): StaffPorts {
  return {
    async load(manage, signal) {
      const [people, restrictions, events, roles] = await Promise.all([
        serverAPI<Person[]>('/api/v1/admin/participants', 'GET', undefined, signal),
        serverAPI<Restriction[]>('/api/v1/admin/sanctions', 'GET', undefined, signal),
        serverAPI<Audit[]>('/api/v1/admin/events', 'GET', undefined, signal),
        manage
          ? serverAPI<StaffRole[]>('/api/v1/admin/roles', 'GET', undefined, signal)
          : Promise.resolve([]),
      ]);
      return { people, restrictions, events, roles };
    },
    room: (id, signal) => serverAPI(`/api/v1/admin/rooms/${id}`, 'GET', undefined, signal),
    async saveRoom(id, config) {
      if (id)
        return serverAPI<Operation>(`/api/v1/admin/rooms/${id}`, 'PUT', {
          config,
          confirm: true,
        });
      await serverAPI('/api/v1/admin/rooms', 'POST', { config });
      return null;
    },
    renameRoom: (id, name) => serverAPI(`/api/v1/admin/rooms/${id}`, 'PATCH', { name }),
    closeRoom: (id) => serverAPI(`/api/v1/admin/rooms/${id}`, 'DELETE', { confirm: true }),
    kick: (target) => serverAPI('/api/v1/admin/kick', 'POST', { target }),
    ban: (target, minutes, reason) =>
      serverAPI('/api/v1/admin/sanctions', 'POST', {
        target,
        minutes,
        ...(reason ? { reason } : {}),
      }),
    saveRole: (account, role) => serverAPI('/api/v1/admin/roles', 'POST', { account, role }),
    revoke: (id) => serverAPI(`/api/v1/admin/sanctions/${id}`, 'DELETE'),
    operation: (id, signal) =>
      serverAPI(`/api/v1/admin/operations/${id}`, 'GET', undefined, signal),
    wait: (milliseconds, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        signal.addEventListener('abort', finish, { once: true });
      }),
  };
}
