import type { ModelNode } from '../assets/model-assets';

export function animateKnifeModel(model: ModelNode, extension: number): void {
  const amount = Math.max(0, Math.min(1, extension));
  model.setEnabled(amount > 0);
  for (let i = 0; i < 8; i++) {
    const part = model.parts.get(`blade-${i}`);
    if (!part) continue;
    const radius = 0.18 * amount;
    part.scaling.set(amount, 1, amount);
    const angle = (i * Math.PI) / 4;
    part.position.x = Math.sin(angle) * radius;
    part.position.z = Math.cos(angle) * radius;
  }
}
