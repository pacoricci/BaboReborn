import { createPageQueries } from '../../bootstrap/queries';
import { onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { serverContext } from '../../network/context';
import { watchAccount } from '../../network/identity';
import { startWithContent } from '../../bootstrap/content';
import { createManagement } from './application';
import { browserManagementPorts } from './browser-ports';
import { createStaff } from './staff-application';
import { browserStaffPorts } from './staff-browser';
import { Staff } from './staff-view';
import '../../ui/menu.css';
import './style.css';

void startWithContent(() => {
  const unmount = render(() => {
    const client = createPageQueries();
    const context = createManagement(browserManagementPorts(), client);
    const staff = createStaff(context, browserStaffPorts(), client);
    const state = context.state;
    onCleanup(watchAccount(() => void context.refresh()));
    return (
      <>
        <header class="management-header product-topbar">
          <a class="brand product-brand" href="/" aria-label="BaboReborn rooms">
            BABO<span>REBORN</span>
          </a>
          <nav class="product-nav" aria-label="Management navigation">
            <a href="/">Rooms</a>
            <a href="/character">Character</a>
            <a href="/options">Options</a>
          </nav>
          <nav class="product-account" aria-label="Account and management">
            <a href="/manage/servers" aria-current="page">
              Servers
            </a>
            <a href="/account">Account</a>
          </nav>
        </header>
        <main class="management-main">
          <div class="management-heading server-heading">
            <a class="back-link" href="/manage/servers">
              ← Servers
            </a>
            <div>
              <p class="eyebrow">Server administration</p>
              <h1 id="management-title" tabIndex={-1}>
                {serverContext().name}
              </h1>
            </div>
          </div>
          <p class="feedback error" role="alert">
            {state.error}
          </p>
          <Show when={state.error}>
            <Show when={!state.data}>
              <a href={`/auth/login?${new URLSearchParams({ return: location.pathname })}`}>
                Sign in
              </a>{' '}
            </Show>
            <button onClick={() => void context.refresh()}>Retry access</button>
          </Show>
          <Staff app={staff} active={true} />
        </main>
      </>
    );
  }, document.getElementById('management-root')!);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) unmount();
  });
});
