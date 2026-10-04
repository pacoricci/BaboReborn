// Cosmetic world-space rotation, deliberately independent of aim and simulation state.
export class Rolling {
  x = 0;
  y = 0;
  z = 0;
  w = 1;
  private lastX = 0;
  private lastY = 0;
  private life: number | undefined;
  private sampled = false;
  reset(): void {
    this.x = this.y = this.z = 0;
    this.w = 1;
    this.sampled = false;
  }
  update(x: number, y: number, life: number | undefined, visible: boolean, dt: number): void {
    if (!visible || life !== this.life) this.reset();
    const dx = x - this.lastX,
      dz = y - this.lastY,
      distance = Math.hypot(dx, dz);
    // Re-anchor after suspension or a large correction; never animate a teleport.
    if (visible && this.sampled && dt <= 0.25 && distance > 0 && distance <= 1) {
      // Original PlayerUpdate.cpp: PI radians per world unit. Y-up presentation axes.
      const half = (Math.PI * distance) / 2,
        s = Math.sin(half) / distance;
      const ax = dz * s,
        az = -dx * s,
        aw = Math.cos(half);
      const qx = aw * this.x + ax * this.w - az * this.y;
      const qy = aw * this.y + az * this.x - ax * this.z;
      const qz = aw * this.z + ax * this.y + az * this.w;
      const qw = aw * this.w - ax * this.x - az * this.z;
      const norm = Math.hypot(qx, qy, qz, qw);
      this.x = qx / norm;
      this.y = qy / norm;
      this.z = qz / norm;
      this.w = qw / norm;
    }
    this.lastX = x;
    this.lastY = y;
    this.life = life;
    this.sampled = visible;
  }
}
