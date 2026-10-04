// M mirrors Esc, so it only yields to controls where letters type text or pick options.
const TYPING =
  'textarea, select, [contenteditable], input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"])';

export function isMenuShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === 'Escape' ||
    (event.code === 'KeyM' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !(event.target instanceof Element && event.target.closest(TYPING)))
  );
}
