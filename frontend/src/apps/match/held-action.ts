// Preserve a tap until one simulation command consumes it, even between frames.
export class HeldAction {
  private held = false;
  private pending = false;
  press(): void {
    this.held = true;
    this.pending = true;
  }
  release(): void {
    this.held = false;
  }
  get active(): boolean {
    return this.held || this.pending;
  }
  consume(): void {
    this.pending = false;
  }
  clear(): void {
    this.held = false;
    this.pending = false;
  }
}
