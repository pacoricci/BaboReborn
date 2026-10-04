export function installDevelopmentTools(parent: HTMLElement): void {
  const details = document.createElement('details');
  details.className = 'developer-tools';

  const summary = document.createElement('summary');
  summary.textContent = 'Development tools';
  details.append(summary);

  for (const [href, label] of [
    ['/practice.html', 'Open practice range →'],
    ['/devtools/browser/', 'Open development tool index →'],
  ] as const) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    details.append(link, document.createElement('br'));
  }

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Available from the local Vite development server only.';
  details.append(note);
  parent.append(details);
}
