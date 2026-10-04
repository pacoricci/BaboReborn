import { onCleanup, onMount } from 'solid-js';
import type { JSX } from 'solid-js';

/** Native modal semantics supply focus trapping and Escape; the component owns its lifetime. */
export function Dialog(props: {
  id?: string;
  labelledBy: string;
  fallbackFocus?: string;
  cancel(): void;
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  let previous: HTMLElement | null = null;
  onMount(() => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  });
  onCleanup(() => {
    dialog.close();
    if (previous?.isConnected && !previous.matches(':disabled') && previous.getClientRects().length)
      previous.focus({ preventScroll: true });
    else if (props.fallbackFocus)
      document.getElementById(props.fallbackFocus)?.focus({ preventScroll: true });
  });
  return (
    <dialog
      ref={(element) => {
        dialog = element;
      }}
      id={props.id}
      aria-labelledby={props.labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        props.cancel();
      }}
    >
      {props.children}
    </dialog>
  );
}
