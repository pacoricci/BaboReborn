// Browser-free animation state. Inputs describe accepted/predicted actions, never trigger them.
import type { WeaponVisual } from '../view';
const unit = (value: number) => Math.max(0, Math.min(1, value));
export class EquipmentMotion {
  rotor = 0;
  rotorSpeed = 0;
  kick = 0;
  charge = 0;
  reloadTilt = 0;
  shield = 0;
  private primary = '';
  private life: number | undefined;
  private shotLife = 0;
  shot(): void {
    this.shotLife = 0.16;
  }
  reset(): void {
    this.rotor = 0;
    this.rotorSpeed = 0;
    this.kick = 0;
    this.charge = 0;
    this.reloadTilt = 0;
    this.shield = 0;
    this.shotLife = 0;
    this.primary = '';
    this.life = undefined;
  }
  update(
    primary: string,
    life: number | undefined,
    visible: boolean,
    visual: WeaponVisual | undefined,
    shield: boolean,
    dt: number,
  ): void {
    if (!visible) {
      this.reset();
      return;
    }
    if (this.primary && (this.primary !== primary || this.life !== life)) this.reset();
    this.primary = primary;
    this.life = life;
    const step = Math.max(0, Math.min(dt, 0.1));
    const age = visual?.shotAge ?? (this.shotLife > 0 ? 0.16 - this.shotLife : Infinity);
    this.shotLife = Math.max(0, this.shotLife - step);
    this.kick = age < 0.16 ? Math.sin(unit(age / 0.16) * Math.PI) * 0.045 : 0;
    const spinning = primary === 'chain' && age < 0.15;
    const target = spinning ? 25 : 0,
      rate = spinning ? 22 : 8;
    const decay = Math.exp(-step * rate);
    this.rotor =
      (this.rotor + target * step + ((this.rotorSpeed - target) * (1 - decay)) / rate) %
      (Math.PI * 2);
    this.rotorSpeed = target + (this.rotorSpeed - target) * decay;
    this.charge = primary === 'photon' ? unit(visual?.charge ?? 0) : 0;
    const reload = primary === 'shotgun' ? unit(visual?.reload ?? 0) : 0;
    this.reloadTilt = reload > 0 ? Math.sin(reload * Math.PI) * 0.22 : 0;
    this.shield += ((shield ? 1 : 0) - this.shield) * (1 - Math.exp(-step * (shield ? 30 : 22)));
    if (this.shield < 0.005) this.shield = 0;
  }
}
