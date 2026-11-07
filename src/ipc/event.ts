import { invoke } from './core';

export type UnlistenFn = () => void;

export interface EventMessage<T = unknown> {
  event: string;
  id: number;
  payload: T;
}

export async function listen<T = unknown>(
  event: string,
  handler: (event: EventMessage<T>) => void,
): Promise<UnlistenFn> {
  const state = window as unknown as {
    __TAURI_INTERNALS__?: {
      transformCallback: (cb: (value: EventMessage<T>) => void, once?: boolean) => number;
      unregisterCallback?: (id: number) => void;
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener?: (event: string, eventId: number) => void;
    };
  };
  if (!state.__TAURI_INTERNALS__ || typeof state.__TAURI_INTERNALS__.transformCallback !== 'function') {
    throw new Error(`Event bridge is not initialized for event: ${event}`);
  }
  const handlerId = state.__TAURI_INTERNALS__.transformCallback(handler, false);
  const eventId = await invoke<number>('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: handlerId,
  });
  return () => {
    state.__TAURI_INTERNALS__?.unregisterCallback?.(handlerId);
    state.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, eventId);
    void invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
  };
}
