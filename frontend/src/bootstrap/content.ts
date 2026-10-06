import { setPreferenceScope } from '../presentation/ui/preference-scope';
import { startWithContent as start } from '../content/runtime';
import type { ServerContext } from '../network/context';
import { resolveServer } from '../network/context';
import { initializeIdentity } from '../network/identity';
export async function startWithContent(
  run: (context: ServerContext | undefined) => void | Promise<void>,
): Promise<void> {
  try {
    const context = await resolveServer();
    setPreferenceScope(context?.id ?? 'portal');
    if (context) await initializeIdentity();
    await start(() => run(context), location.origin);
  } catch (error) {
    const message = document.getElementById('content-status') ?? document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = error instanceof Error ? error.message : String(error);
    const back = document.createElement('a');
    back.href = '/rooms';
    back.textContent = ' Return to rooms';
    message.append(back);
    if (location.pathname.startsWith('/manage/')) {
      const login = document.createElement('a');
      login.href = `/auth/login?${new URLSearchParams({ return: location.pathname })}`;
      login.textContent = ' Sign in';
      message.append(login);
    }
    if (!message.isConnected) document.body.prepend(message);
  }
}
