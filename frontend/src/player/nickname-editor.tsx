import { createSignal, For } from 'solid-js';
import { editNicknameColors } from './nickname';
import { Nickname } from '../ui/nickname';
import { Dialog } from '../ui/dialog';
import type { PreferencesApplication } from './preferences';

const PALETTE = [
  ['White', 'edf2ef'],
  ['Silver', 'b8c2cc'],
  ['Red', 'ff3344'],
  ['Coral', 'ff7777'],
  ['Orange', 'ff8844'],
  ['Gold', 'ffbb33'],
  ['Yellow', 'ffdd55'],
  ['Lime', 'bbef55'],
  ['Green', '77dd88'],
  ['Mint', '55ddbb'],
  ['Cyan', '55ddff'],
  ['Blue', '7799ff'],
  ['Violet', '9977ff'],
  ['Purple', 'bb88ff'],
  ['Pink', 'ff88cc'],
] as const;

export function NicknameEditor(props: { app: PreferencesApplication; close: () => void }) {
  const [text, setText] = createSignal(props.app.state.settings.nickname);
  const [colors, setColors] = createSignal(props.app.state.settings.nicknameColors ?? '');
  const [range, setRange] = createSignal<[number, number]>([0, 0]);
  const [custom, setCustom] = createSignal('#ffffff');
  let input!: HTMLInputElement;
  const select = () => setRange([input.selectionStart ?? 0, input.selectionEnd ?? 0]);
  function paint(color: string) {
    const [start, end] = range();
    const tokens = Array.from(
      { length: text().length },
      (_, i) => colors().slice(i * 6, i * 6 + 6) || '------',
    );
    for (
      let i = start === end ? 0 : start;
      i < Math.min(end === start ? tokens.length : end, tokens.length);
      i++
    )
      tokens[i] = color;
    setColors(tokens.join(''));
  }
  return (
    <Dialog
      id="nickname-editor"
      labelledBy="nickname-editor-title"
      fallbackFocus="edit-nickname"
      cancel={props.close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const nickname = text().trim();
          const start = text().length - text().trimStart().length;
          const error = props.app.nickname(
            nickname,
            colors().slice(start * 6, (start + nickname.length) * 6),
          );
          input.setCustomValidity(error);
          if (input.reportValidity()) props.close();
        }}
      >
        <h2 id="nickname-editor-title">Edit nickname</h2>
        <label for="advanced-nickname">Nickname</label>
        <input
          id="advanced-nickname"
          ref={(element) => {
            input = element;
          }}
          value={text()}
          required
          maxlength="20"
          onSelect={select}
          onKeyUp={select}
          onClick={select}
          onInput={(event) => {
            const next = event.currentTarget.value;
            setColors(editNicknameColors(text(), next, colors()));
            setText(next);
            event.currentTarget.setCustomValidity('');
            select();
          }}
          aria-describedby="nickname-color-help"
        />
        <div class="nickname-preview" aria-label="Nickname preview">
          <Nickname text={text()} colors={colors()} />
        </div>
        <p id="nickname-color-help" class="muted">
          Select letters to color a part. With no selection, color the whole name.
        </p>
        <div class="nickname-palette" role="group" aria-label="Nickname colors">
          <For each={PALETTE}>
            {([name, value]) => (
              <button
                type="button"
                aria-label={name}
                title={name}
                style={{ '--swatch': `#${value}` }}
                onClick={() => paint(value)}
              />
            )}
          </For>
          <label class="nickname-custom" title="Custom color">
            <input
              type="color"
              aria-label="Custom color"
              value={custom()}
              onInput={(event) => {
                setCustom(event.currentTarget.value);
                paint(event.currentTarget.value.slice(1));
              }}
            />
            <span aria-hidden="true">+</span>
          </label>
        </div>
        <button class="nickname-reset" type="button" onClick={() => setColors('')}>
          Reset colors
        </button>
        <div class="nickname-actions">
          <button type="button" onClick={props.close}>
            Cancel
          </button>
          <button type="submit" class="primary">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
