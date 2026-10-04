// @ts-check
// Logout and account deletion also end open game pages in this browser.
if (document.body.dataset.sessionEnded === 'true') {
  const channel = new BroadcastChannel('baboreborn.account');
  channel.postMessage('signed-out');
  channel.close();
}
document.getElementById('copy-account-id')?.addEventListener('click', () => {
  const value = document.getElementById('account-id')?.textContent ?? '';
  const status = document.getElementById('copy-account-status');
  void navigator.clipboard.writeText(value).then(
    () => {
      if (status) status.textContent = 'Account ID copied.';
    },
    () => {
      if (status) status.textContent = 'Select and copy the ID above.';
    },
  );
});
