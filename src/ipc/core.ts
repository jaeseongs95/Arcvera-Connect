export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const state = window as unknown as Record<string, unknown>;
  return Boolean(state.isTauri);
}

export async function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const state = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, payload?: Record<string, unknown>) => Promise<T>;
    };
  };
  if (!state.__TAURI_INTERNALS__ || typeof state.__TAURI_INTERNALS__.invoke !== 'function') {
    throw new Error(`IPC bridge is not initialized for command: ${command}`);
  }
  return state.__TAURI_INTERNALS__.invoke(command, args);
}
