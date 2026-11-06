export interface QpuHeroOptions {
  /** Where the cryostat's axis sits across the width, 0 to 1 (default 0.5). */
  focusX?: number;
  /** Render one still moment at this time in seconds instead of animating. */
  frozenAt?: number | null;
  /** Start the animation at this time in seconds (default 0). */
  startAt?: number;
}
export function mount(container: HTMLElement, options?: QpuHeroOptions): { dispose(): void };
