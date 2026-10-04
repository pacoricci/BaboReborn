import { isMenuShortcut } from './menu-shortcut';
import { defaultBindings } from '../../player/game-options';
import type { Bindings, Action } from '../../player/game-options';
// Keyboard/pointer adapter. Session scheduling consumes the same input object each tick.
import type { Input } from '../../core/simulation';
import { HeldAction } from './held-action';
interface InputHandlers {
  help(): void;
  suspend(): void;
  play(): void;
  dead(): boolean;
  respawn(): void;
}
export class OnlineInput {
  active = false;
  showScores = false;
  pickupID = 0;
  pointer = { x: innerWidth / 2, y: innerHeight / 2 };
  pointerKnown = false;
  readonly keys = new Set<string>();
  readonly input: Input = { x: 0, y: 0, aim: { x: 18, y: 18 }, fire: false };
  private readonly fire = new HeldAction();
  private readonly secondary = new HeldAction();
  private readonly lifetime = new AbortController();
  constructor(
    canvas: HTMLCanvasElement,
    crosshair: HTMLElement,
    handlers: InputHandlers,
    private bindings: () => Bindings = () => defaultBindings,
  ) {
    const options = { signal: this.lifetime.signal };
    window.addEventListener('blur', () => handlers.suspend(), options);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) handlers.suspend();
      },
      options,
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (
          e.code === 'KeyH' &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !(
            e.target instanceof Element &&
            e.target.closest('input, textarea, select, [contenteditable]')
          )
        ) {
          e.preventDefault();
          if (!e.repeat) handlers.help();
          return;
        }
        if (isMenuShortcut(e)) {
          if (e.repeat) return;
          e.preventDefault();
          if (this.active) handlers.suspend();
          else handlers.play();
          return;
        }
        if (this.active && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (this.action(e.code) || e.code.startsWith('Arrow')) {
            e.preventDefault();
            if (!e.repeat) this.press(e.code, handlers);
          }
        }
      },
      options,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        this.unpress(e.code);
      },
      options,
    );
    // Babylon cancels pointerdown, suppressing compatibility mouse events.
    // Chorded button changes arrive as pointermove with a non-negative button.
    const pointerButton = (e: PointerEvent) => {
      if (!this.active || e.button < 0 || e.button > 2) return;
      e.preventDefault();
      const mask = e.button === 0 ? 1 : e.button === 2 ? 2 : 4;
      const code = `Mouse${e.button}`;
      if (!(e.buttons & mask)) this.unpress(code);
      else this.press(code, handlers);
    };
    canvas.addEventListener(
      'pointermove',
      (e) => {
        pointerButton(e);
        this.pointer = { x: e.clientX, y: e.clientY };
        this.pointerKnown = true;
        crosshair.style.left = `${this.pointer.x}px`;
        crosshair.style.top = `${this.pointer.y}px`;
      },
      options,
    );
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (this.active && e.button >= 0 && e.button <= 2) {
          canvas.setPointerCapture(e.pointerId);
        }
      },
      options,
    );
    canvas.addEventListener('pointerdown', pointerButton, options);
    window.addEventListener(
      'pointerup',
      (e) => {
        for (const [button, mask] of [
          [0, 1],
          [1, 4],
          [2, 2],
        ] as const)
          if (!(e.buttons & mask)) this.unpress(`Mouse${button}`);
      },
      options,
    );
    // Browser defaults must stay suppressed even when an auxiliary click targets HUD content.
    const preventGameplayDefault = (e: MouseEvent) => {
      if (this.active || e.target === canvas) e.preventDefault();
    };
    window.addEventListener('auxclick', preventGameplayDefault, { ...options, capture: true });
    window.addEventListener('contextmenu', preventGameplayDefault, { ...options, capture: true });
    canvas.addEventListener('pointercancel', () => handlers.suspend(), options);
    canvas.addEventListener(
      'lostpointercapture',
      () => {
        // Normal mouse release also loses capture: keep held keyboard movement.
        for (const code of ['Mouse0', 'Mouse1', 'Mouse2']) this.unpress(code);
      },
      options,
    );
  }
  private action(code: string): Action | undefined {
    return (Object.keys(defaultBindings) as Action[]).find(
      (action) => this.bindings()[action] === code,
    );
  }
  private press(code: string, handlers: InputHandlers): void {
    if (this.keys.has(code)) return;
    this.keys.add(code);
    switch (this.action(code)) {
      case 'fire':
        if (handlers.dead()) handlers.respawn();
        else {
          this.fire.press();
          this.input.fire = this.fire.active;
        }
        break;
      case 'secondary':
        this.secondary.press();
        break;
      case 'grenade':
        if (!handlers.dead()) this.input.grenade = true;
        break;
      case 'molotov':
        if (!handlers.dead()) this.input.molotov = true;
        break;
      case 'pickup':
        this.input.pickup = this.pickupID;
        break;
      case 'scores':
        this.showScores = true;
        break;
    }
  }
  private unpress(code: string): void {
    this.keys.delete(code);
    switch (this.action(code)) {
      case 'fire':
        this.fire.release();
        this.input.fire = this.fire.active;
        break;
      case 'secondary':
        this.secondary.release();
        break;
      case 'scores':
        this.showScores = false;
        break;
    }
  }
  dispose(): void {
    this.active = false;
    this.release();
    this.lifetime.abort();
  }
  sample(): void {
    this.input.x =
      Number(this.keys.has(this.bindings().right) || this.keys.has('ArrowRight')) -
      Number(this.keys.has(this.bindings().left) || this.keys.has('ArrowLeft'));
    this.input.y =
      Number(this.keys.has(this.bindings().up) || this.keys.has('ArrowUp')) -
      Number(this.keys.has(this.bindings().down) || this.keys.has('ArrowDown'));
    this.input.fire = this.fire.active;
    this.input.secondary = this.secondary.active;
  }
  consume(): void {
    this.fire.consume();
    this.input.fire = this.fire.active;
    this.secondary.consume();
    this.input.secondary = this.secondary.active;
    this.input.grenade = false;
    this.input.molotov = false;
    this.input.pickup = 0;
  }
  clearActions(): void {
    this.fire.clear();
    this.input.fire = false;
    this.secondary.clear();
    this.consume();
  }
  release(): void {
    this.keys.clear();
    this.showScores = false;
    this.input.x = 0;
    this.input.y = 0;
    this.clearActions();
  }
}
