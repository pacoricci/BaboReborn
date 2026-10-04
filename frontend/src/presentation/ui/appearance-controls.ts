import { currentContent } from '../../content/runtime';
import { isAppearance } from '../../player/appearance';
import type { Appearance } from '../../player/appearance';
import './appearance-controls.css';

import { readAppearance, appearanceStorageKey } from './appearance-settings';

export function appearanceControls(host: HTMLElement, changed: (appearance: Appearance) => void) {
  let value = readAppearance();
  host.innerHTML = `<fieldset class="appearance-controls"><legend>Appearance</legend>
    <label>Skin<select aria-label="Skin"></select></label>
    <label>Color 1<input type="color" aria-label="Skin color 1"></label>
    <label>Color 2<input type="color" aria-label="Skin color 2"></label>
    <label>Color 3<input type="color" aria-label="Skin color 3"></label>
  </fieldset>`;
  const select = host.querySelector('select')!;
  for (const skin of currentContent().skins) select.add(new Option(skin.name, skin.id));
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(appearanceStorageKey()) ?? 'null');
    if (isAppearance(saved) && saved.template !== value.template) {
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = 'Your previous skin is unavailable. Choose another skin.';
      host.append(message);
    }
  } catch {
    /* Preferences are optional. */
  }
  const colors = Array.from(host.querySelectorAll('input'));
  select.value = value.template;
  colors.forEach((input, i) => {
    input.value = value.colors[i]!;
  });
  host.addEventListener('change', (event) => {
    if (event.target !== select && !colors.some((input) => input === event.target)) return;
    const next: unknown = { template: select.value, colors: colors.map((c) => c.value) };
    if (!isAppearance(next)) return;
    value = next;
    try {
      localStorage.setItem(appearanceStorageKey(), JSON.stringify(value));
    } catch {
      /* Optional. */
    }
    changed(value);
  });
  return {
    get value() {
      return value;
    },
  };
}
