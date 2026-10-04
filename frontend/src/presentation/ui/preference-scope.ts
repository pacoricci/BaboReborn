// Match and management pages use an installation scope; player and editor pages use portal.
let scope = 'portal';
export function setPreferenceScope(serverID: string): void {
  scope = serverID;
}
export function preferenceScope(): string {
  return scope;
}
