import { For } from 'solid-js';
import { nicknameRuns } from '../player/nickname';
export function Nickname(props: { text: string; colors?: string | undefined }) {
  return (
    <span class="nickname">
      <For each={nicknameRuns(props.text, props.colors)}>
        {(run) => (
          <span
            style={{
              color: run.color || undefined,
              'text-shadow': run.color ? '0 1px 2px #10171b, 0 0 2px #10171b' : undefined,
            }}
          >
            {run.text}
          </span>
        )}
      </For>
    </span>
  );
}
export function paintNickname(element: HTMLElement, text: string, colors?: string): void {
  const key = text + ':' + (colors ?? '');
  if (element.dataset.nickname === key) return;
  element.dataset.nickname = key;
  element.replaceChildren(
    ...nicknameRuns(text, colors).map((run) => {
      const span = document.createElement('span');
      span.textContent = run.text;
      if (run.color) {
        span.style.color = run.color;
        span.style.textShadow = '0 1px 2px #10171b, 0 0 2px #10171b';
      }
      return span;
    }),
  );
}
