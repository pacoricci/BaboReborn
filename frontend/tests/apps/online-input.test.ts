import { defaultBindings } from '../../src/player/game-options';
import assert from 'node:assert/strict';
import test from 'node:test';
import { OnlineInput } from '../../src/apps/match/input';

void test('pointer input survives renderer cancellation and chorded button transitions', () => {
  const names = ['window', 'document', 'innerWidth', 'innerHeight'] as const;
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const win = new EventTarget();
  const doc = new EventTarget();
  const canvas = Object.assign(new EventTarget(), { setPointerCapture: () => {} });
  const emit = (target: EventTarget, type: string, button: number, buttons: number) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button,
      buttons,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    target.dispatchEvent(event);
    return event;
  };
  try {
    [win, doc, 800, 600].forEach((value, i) => {
      Object.defineProperty(globalThis, names[i]!, { value, configurable: true });
    });
    // Match Babylon: cancelled pointerdown has no compatibility mousedown.
    canvas.addEventListener('pointerdown', (e) => e.preventDefault());
    let dead = true;
    let respawns = 0;
    let suspends = 0;
    let bindings = { ...defaultBindings };
    const controls = new OnlineInput(
      canvas as unknown as HTMLCanvasElement,
      { style: {} } as HTMLElement,
      {
        suspend: () => {
          suspends++;
          controls.release();
        },
        help: () => {},
        play: () => {},
        dead: () => dead,
        respawn: () => {
          respawns++;
        },
      },
      () => bindings,
    );
    controls.active = true;
    assert.equal(emit(win, 'contextmenu', 2, 2).defaultPrevented, true);
    assert.equal(emit(win, 'auxclick', 1, 0).defaultPrevented, true);
    assert.equal(emit(canvas, 'pointerdown', 0, 1).defaultPrevented, true);
    assert.equal(respawns, 1);
    emit(win, 'pointerup', 0, 0);
    dead = false;
    emit(canvas, 'pointerdown', 0, 1);
    assert.equal(controls.input.fire, true);
    emit(win, 'pointerup', 0, 0);
    controls.sample();
    assert.equal(controls.input.fire, true, 'a mouse tap survives until the next command');
    controls.consume();
    assert.equal(controls.input.fire, false);
    emit(canvas, 'pointerdown', 0, 1);
    emit(canvas, 'pointermove', 2, 3);
    assert.equal(controls.input.grenade, true);
    controls.consume();
    assert.equal(
      controls.input.fire,
      true,
      'holding the button continues firing after consumption',
    );
    emit(canvas, 'pointermove', -1, 3);
    assert.equal(controls.input.grenade, false);
    emit(canvas, 'pointermove', 2, 1);
    assert.equal(controls.input.fire, true);
    emit(canvas, 'pointermove', 1, 5);
    assert.equal(controls.input.molotov, true);
    emit(canvas, 'pointermove', 0, 4);
    assert.equal(controls.input.fire, false);
    emit(win, 'pointerup', 1, 0);
    controls.release();
    controls.active = false;
    assert.equal(emit(win, 'contextmenu', 2, 2).defaultPrevented, false);
    assert.equal(emit(win, 'auxclick', 1, 0).defaultPrevented, false);
    emit(canvas, 'pointerdown', 2, 2);
    assert.equal(controls.input.grenade, false);
    controls.active = true;
    emit(canvas, 'pointerdown', 0, 1);
    win.dispatchEvent(new Event('blur'));
    assert.equal(controls.input.fire, false);
    bindings = {
      ...defaultBindings,
      fire: 'KeyQ',
      secondary: 'Mouse0',
      up: 'KeyZ',
      scores: 'KeyT',
    };
    const key = (type: string, code: string) =>
      win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code }));
    key('keydown', 'KeyZ');
    controls.sample();
    assert.equal(controls.input.y, 1);
    canvas.dispatchEvent(new Event('lostpointercapture'));
    controls.sample();
    assert.equal(
      controls.input.y,
      1,
      'releasing mouse capture must not stop held keyboard movement',
    );
    key('keyup', 'KeyZ');
    controls.sample();
    assert.equal(controls.input.y, 0);
    key('keydown', 'KeyQ');
    assert.equal(controls.input.fire, true);
    key('keyup', 'KeyQ');
    controls.sample();
    assert.equal(controls.input.fire, true, 'a remapped key tap survives until the next command');
    controls.consume();
    assert.equal(controls.input.fire, false);
    key('keydown', 'KeyQ');
    key('keyup', 'KeyQ');
    controls.clearActions();
    controls.sample();
    assert.equal(controls.input.fire, false, 'status changes discard a pending tap');
    emit(canvas, 'pointerdown', 0, 1);
    emit(win, 'pointerup', 0, 0);
    controls.sample();
    assert.equal(controls.input.secondary, true, 'a remapped mouse tap survives until consumed');
    controls.consume();
    assert.equal(controls.input.secondary, false);
    key('keydown', 'KeyT');
    assert.equal(controls.showScores, true);
    key('keyup', 'KeyT');
    assert.equal(controls.showScores, false);
    key('keydown', 'KeyQ');
    key('keydown', 'KeyZ');
    controls.release();
    controls.sample();
    assert.equal(controls.input.y, 0);
    assert.equal(controls.input.fire, false);
    const beforeDispose = suspends;
    controls.dispose();
    controls.dispose();
    controls.pointerKnown = false;
    emit(canvas, 'pointermove', -1, 0);
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(controls.active, false);
    assert.equal(controls.pointerKnown, false);
    assert.equal(suspends, beforeDispose);
  } finally {
    names.forEach((name, i) => {
      const descriptor = saved[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
