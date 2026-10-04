import { createSignal, onCleanup } from 'solid-js';
import { openPackage } from '../../content/local-package';
import type { LocalPackage } from '../../content/local-package';

/** The owner releases both replaced packages and late completions after unmount. */
export function LocalPackagePicker(props: {
  kind: 'skin' | 'theme';
  selected(value: LocalPackage | null): void;
}) {
  const [message, setMessage] = createSignal('');
  const [active, setActive] = createSignal<LocalPackage | null>(null);
  let generation = 0;
  let input!: HTMLInputElement;
  const clear = () => {
    ++generation;
    props.selected(null);
    active()?.dispose();
    setActive(null);
    setMessage('');
    input.value = '';
  };
  async function select(files: readonly File[]) {
    const ticket = ++generation;
    setMessage('Loading preview…');
    try {
      const value = await openPackage(files, props.kind);
      if (ticket !== generation) {
        value.dispose();
        return;
      }
      const previous = active();
      try {
        props.selected(value);
        setActive(value);
        previous?.dispose();
      } catch (error) {
        value.dispose();
        throw error;
      }
      setMessage('Preview only. Ask the server owner to add it before using it in matches.');
    } catch (error) {
      if (ticket === generation) setMessage(error instanceof Error ? error.message : String(error));
    }
  }
  onCleanup(() => {
    ++generation;
    active()?.dispose();
  });
  return (
    <details class="package-preview">
      <summary>Try a custom {props.kind}</summary>
      <label>
        Choose a {props.kind} folder
        <input
          ref={(element) => {
            input = element;
            element.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          aria-label={`Choose a ${props.kind} folder`}
          onChange={(event) => {
            void select(Array.from(event.currentTarget.files ?? []));
          }}
        />
      </label>
      <button type="button" hidden={!active()} onClick={clear}>
        Close preview
      </button>
      <p role="status">{message()}</p>
    </details>
  );
}
