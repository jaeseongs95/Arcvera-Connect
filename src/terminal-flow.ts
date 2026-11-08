export const MAX_INPUT_OPERATIONS = 128;
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_INPUT_MESSAGE_BYTES = 64 * 1024;

// Native output acknowledgement is cumulative. xterm calls write callbacks in
// parser order within a bounded parsing turn, so acknowledge its last completed
// sequence once after that turn. Never delay terminal.write or input itself.
type OutputAcknowledgement = { id: string; generation: number; seq: number };
export class TerminalOutputAcknowledgements {
  private pending = new Map<string, Map<number, OutputAcknowledgement>>();
  private scheduled = false;
  private send: (output: OutputAcknowledgement) => void;
  constructor(send: (output: OutputAcknowledgement) => void) {
    this.send = send;
  }
  enqueue(output: OutputAcknowledgement) {
    let generations = this.pending.get(output.id);
    if (!generations) { generations = new Map(); this.pending.set(output.id, generations); }
    const previous = generations.get(output.generation);
    if (previous) previous.seq = Math.max(previous.seq, output.seq);
    else generations.set(output.generation, { id: output.id, generation: output.generation, seq: output.seq });
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      const completed = this.pending;
      this.pending = new Map(); this.scheduled = false;
      for (const generations of completed.values()) for (const value of generations.values()) this.send(value);
    });
  }
}

export class InputQueueError extends Error {
  readonly reason: 'message' | 'full' | 'cancelled';
  constructor(reason: 'message' | 'full' | 'cancelled') {
    super(`Terminal input ${reason}`);
    this.reason = reason;
  }
}

// Stop counting at the native per-message ceiling without allocating another
// UTF-8 copy of an arbitrarily large clipboard string. Lone surrogates use U+FFFD.
function inputBytes(text: string) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const point = text.codePointAt(index)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (point > 0xffff) index++;
    if (bytes > MAX_INPUT_MESSAGE_BYTES) break;
  }
  return bytes;
}

export class TerminalInputQueue<T extends { data: string }> {
  private pending: { value: T; bytes: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  private active = false;
  private count = 0;
  private bytes = 0;
  private pressure = false;
  private closed = false;
  private send: (value: T) => Promise<void>;
  private changed: () => void;
  constructor(send: (value: T) => Promise<void>, changed: () => void) {
    this.send = send;
    this.changed = changed;
  }
  get size() { return this.count; }
  get byteLength() { return this.bytes; }
  get paused() { return this.pressure; }
  get disposed() { return this.closed; }

  enqueue(value: T): Promise<void> {
    if (this.closed) return Promise.reject(new InputQueueError('cancelled'));
    const bytes = inputBytes(value.data);
    if (bytes > MAX_INPUT_MESSAGE_BYTES) return Promise.reject(new InputQueueError('message'));
    if (this.count >= MAX_INPUT_OPERATIONS || this.bytes + bytes > MAX_INPUT_BYTES) {
      this.pressure = this.count > 0; this.changed();
      return Promise.reject(new InputQueueError('full'));
    }
    this.count++; this.bytes += bytes;
    this.pressure = this.count >= MAX_INPUT_OPERATIONS || this.bytes >= MAX_INPUT_BYTES;
    const result = new Promise<void>((resolve, reject) => this.pending.push({ value, bytes, resolve, reject }));
    this.changed(); void this.pump(); return result;
  }

  cancelPending() {
    for (const entry of this.pending) { this.count--; this.bytes -= entry.bytes; entry.reject(new InputQueueError('cancelled')); }
    // The suspended pump can retain the shift() receiver across await. Clear
    // that same array rather than replacing it and leaving its entries alive.
    this.pending.length = 0; this.pressure = false; this.changed();
  }
  dispose() { this.closed = true; this.cancelPending(); }

  private async pump() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.pending.length) {
        const first = this.pending.shift()!;
        const batch = [first];
        let combinedData = first.value.data;
        let combinedBytes = first.bytes;
        const firstRec = first.value as Record<string, unknown>;
        while (this.pending.length) {
          const next = this.pending[0];
          const nextRec = next.value as Record<string, unknown>;
          if (
            nextRec.generation !== firstRec.generation ||
            nextRec.selectionVersion !== firstRec.selectionVersion ||
            combinedBytes + next.bytes > MAX_INPUT_MESSAGE_BYTES
          ) {
            break;
          }
          this.pending.shift();
          batch.push(next);
          combinedData += next.value.data;
          combinedBytes += next.bytes;
        }
        const mergedValue = batch.length === 1 ? first.value : ({ ...first.value, data: combinedData } as T);
        try {
          await this.send(mergedValue);
          for (const entry of batch) entry.resolve();
        } catch (error) {
          for (const entry of batch) entry.reject(error);
        } finally {
          this.count -= batch.length;
          this.bytes -= combinedBytes;
          this.pressure = this.count >= MAX_INPUT_OPERATIONS || this.bytes >= MAX_INPUT_BYTES;
          this.changed();
        }
      }
    } finally { this.active = false; }
  }
}

// Geometry is replaceable state, unlike input. Never queue every resize while
// one native request is held: only the newest unsent geometry matters.
export class TerminalResizeQueue<T> {
  private pending?: T;
  private active = false;
  private closed = false;
  private send: (value: T) => Promise<void>;
  private failed: (error: unknown) => void;
  constructor(send: (value: T) => Promise<void>, failed: (error: unknown) => void) {
    this.send = send;
    this.failed = failed;
  }
  enqueue(value: T) { if (!this.closed) { this.pending = value; void this.pump(); } }
  cancelPending() { this.pending = undefined; }
  dispose() { this.closed = true; this.cancelPending(); }
  private async pump() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.pending !== undefined) {
        const value = this.pending; this.pending = undefined;
        try { await this.send(value); } catch (error) { this.failed(error); }
      }
    } finally { this.active = false; }
  }
}
