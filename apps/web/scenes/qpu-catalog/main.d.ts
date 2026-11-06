export interface QpuCatalogOptions {
  /** Device id (snapshot resource_id) to select at start. */
  select?: string | null;
  /** Draw only this device (snapshot resource_id), centred, lit and framed as a portrait. */
  focus?: string | null;
  /** Hold the camera at this time in seconds instead of animating (reduced motion). */
  frozenAt?: number | null;
}
export interface QpuCatalogHandle {
  setSelected(deviceId: string | null): boolean;
  dispose(): void;
}
export const devices: { id: string; name: string; vendor: string; provider: string; qubits: number }[];
export function candidateToDevice(candidateId: string): string | null;
export function mount(container: HTMLElement, options?: QpuCatalogOptions): QpuCatalogHandle;
