import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const sessions = [
  { id: 'flow-a', title: 'Flow Alpha', cwd: 'D:\\Work\\Alpha', generation: 7, state: 'idle', active: true, threadId: 'flow-thread-a' },
  { id: 'flow-b', title: 'Flow Beta', cwd: 'D:\\Work\\Beta', generation: 7, state: 'idle', active: true, threadId: 'flow-thread-b' },
];
const card = (page: Page, id = 'flow-a') => page.locator(`.terminal-card[data-id="${id}"]`);
const input = (page: Page) => card(page).locator('.xterm-helper-textarea');

function directAcknowledgements(body: string) {
  const start = body.indexOf('function ack(output)'); const end = body.indexOf('async function resolveOrphan', start);
  if (start < 0 || end < 0) throw new Error('기준판 ACK 함수 경계를 찾지 못했습니다.');
  return body.slice(0, start) + `function ack(output) { if (native) void call('session_output_ack', { id: output.id, generation: output.generation, seq: output.seq }).catch(error => notifyError('출력 확인 전송 실패', 'Could not acknowledge output', error)); }\n` + body.slice(end);
}

async function workspace(page: Page, fixtureSessions = sessions) {
  await page.addInitScript(sessions => {
    const state = window as any; state.isTauri = true;
    let callback = 0;
    const callbacks = new Map<number, (value: any) => void>();
    const listeners = new Map<string, (value: any) => void>();
    const writes: (() => void)[] = []; const resizes: (() => void)[] = []; const metadata: (() => void)[] = [];
    state.flow = { calls: [], sent: [], holdWrites: false, holdResize: false, holdMetadata: false, activeWrites: 0, maxWrites: 0, activeResizes: 0, maxResizes: 0,
      releaseWrites() { this.holdWrites = false; for (const release of writes.splice(0)) release(); },
      releaseResize() { this.holdResize = false; for (const release of resizes.splice(0)) release(); },
      releaseMetadata(info: any = {}) { Object.assign(sessions.find(item => item.id === info.id) ?? {}, info); this.holdMetadata = false; for (const release of metadata.splice(0)) release(); },
      emit(info: any) { Object.assign(sessions.find(item => item.id === info.id)!, info); listeners.get('session-changed')!({ event: 'session-changed', id: 1, payload: sessions.find(item => item.id === info.id) }); },
      output(info: any) { listeners.get('terminal-output')!({ event: 'terminal-output', id: 1, payload: info }); },
    };
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    state.__TAURI_INTERNALS__ = {
      transformCallback(handler: (value: any) => void) { callbacks.set(++callback, handler); return callback; },
      unregisterCallback() {},
      async invoke(command: string, args: any = {}) {
        const flow = state.flow; flow.calls.push({ command, args });
        if (command === 'plugin:event|listen') { listeners.set(args.event, callbacks.get(args.handler)!); return callback; }
        if (command.startsWith('plugin:event|')) return callback;
        if (command === 'get_ui_language') return 'ko';
        if (command === 'set_ui_language') return { show: 'OpenDIY Desktop 열기', exit: '종료…' };
        if (command === 'load_layout') return { version: 1, columns: 2, sessions: [] };
        if (command === 'list_sessions') { if (flow.holdMetadata) await new Promise<void>(resolve => metadata.push(resolve)); return sessions; }
        if (command === 'list_projects') return sessions.map(item => ({ id: item.id, name: item.title, cwd: item.cwd, createdAt: 1 }));
        if (command === 'session_write') {
          if (new TextEncoder().encode(args.data).byteLength > 64 * 1024) throw Error('Native input limit');
          flow.activeWrites++; flow.maxWrites = Math.max(flow.maxWrites, flow.activeWrites);
          try { if (flow.holdWrites && args.id === 'flow-a') await new Promise<void>(resolve => writes.push(resolve)); flow.sent.push(args); }
          finally { flow.activeWrites--; }
        }
        if (command === 'session_resize' && args.id === 'flow-a') {
          flow.activeResizes++; flow.maxResizes = Math.max(flow.maxResizes, flow.activeResizes);
          try { if (flow.holdResize) await new Promise<void>(resolve => resizes.push(resolve)); }
          finally { flow.activeResizes--; }
        }
        return null;
      },
    };
  }, fixtureSessions);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  await expect(card(page)).toBeVisible();
  await input(page).focus();
}

async function startingWorkspace(page: Page) {
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch(); let body = await response.text();
    if (process.env.TERMINAL_STARTUP_BASELINE === '1') {
      const original = ts.transpileModule(execFileSync('git', ['show', '93f66e10cc1fe99166f1db84ec5cfc128116db6f:src/main.ts'], { encoding: 'utf8' }), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      const portion = (source: string) => {
        const start = source.indexOf('function receiveOutput('); const end = source.indexOf('function renderCounts(', start);
        if (start < 0 || end < 0) throw Error('원래 receiveOutput 경계를 찾지 못했습니다.');
        return { start, end, text: source.slice(start, end) };
      };
      const current = portion(body); body = body.slice(0, current.start) + portion(original).text + body.slice(current.end);
    }
    await route.fulfill({ response, body: body + '\nwindow.__flowTerminals = terminals; window.__flowCanType = canType; window.__flowPending = pending;\n' });
  });
  await workspace(page, [{ ...sessions[0], state: 'starting' }]);
  await page.evaluate(() => {
    const state = window as any; state.flow.holdMetadata = true; state.parserWrites = [];
    const terminal = state.__flowTerminals.get('flow-a').terminal; const write = terminal.write.bind(terminal);
    terminal.write = (data: string, parsed?: () => void) => { if (data) state.parserWrites.push(data); return write(data, parsed); };
    state.parseBarrier = () => new Promise<void>(resolve => terminal.write('', resolve));
  });
}

for (const liveMetadata of ['Changed', 'list_sessions']) {
  test(`N7 ${liveMetadata}: starting 출력 parse를 보류하고 live 뒤 실제 xterm CPR을 정확히 한 번 전달한다`, async ({ page }) => {
    await startingWorkspace(page);
    await input(page).press('x');
    const before = await page.evaluate(async () => {
      const state = window as any; const terminal = state.__flowTerminals.get('flow-a').terminal;
      state.flow.output({ id: 'flow-a', generation: 7, seq: 1, data: 'N7-BEFORE\u001b[3;9H\u001b[6nN7-AFTER' });
      await state.parseBarrier();
      return { canType: state.__flowCanType('flow-a'), disableStdin: terminal.options.disableStdin, parsed: state.parserWrites, sent: state.flow.sent,
        acks: state.flow.calls.filter((call: any) => call.command === 'session_output_ack') };
    });
    expect(before).toEqual({ canType: false, disableStdin: true, parsed: [], sent: [], acks: [] });
    await page.evaluate(liveMetadata => {
      const state = window as any;
      if (liveMetadata === 'Changed') state.flow.emit({ id: 'flow-a', state: 'idle', active: true });
      else state.flow.releaseMetadata({ id: 'flow-a', state: 'idle', active: true });
    }, liveMetadata);
    await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => ({ id: item.id, generation: item.generation, data: item.data })))).toEqual([{ id: 'flow-a', generation: 7, data: '\u001b[3;9R' }]);
    await expect.poll(() => page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_output_ack').map((call: any) => call.args))).toEqual([{ id: 'flow-a', generation: 7, seq: 1 }]);
    await page.evaluate(async () => { const state = window as any; state.flow.releaseMetadata(); await state.parseBarrier(); });
    expect(await page.evaluate(() => { const state = window as any; return { canType: state.__flowCanType('flow-a'), disableStdin: state.__flowTerminals.get('flow-a').terminal.options.disableStdin, parsed: state.parserWrites.length, sent: state.flow.sent.length, pending: state.__flowPending.size }; })).toEqual({ canType: true, disableStdin: false, parsed: 1, sent: 1, pending: 0 });
    await input(page).press('z');
    await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['\u001b[3;9R', 'z']);
  });
}

test('N7 stale generation·중복 seq·startup overflow·stopped tail과 ACK 정책을 보존한다', async ({ page }) => {
  await startingWorkspace(page);
  const before = await page.evaluate(async () => {
    const state = window as any;
    state.flow.output({ id: 'flow-a', generation: 6, seq: 100, data: 'STALE-MUST-NOT-PARSE' });
    for (let duplicate = 0; duplicate < 2; duplicate++) state.flow.output({ id: 'flow-a', generation: 7, seq: 1, data: 'STOP-TAIL\u001b[3;9H\u001b[6n' });
    state.flow.output({ id: 'flow-a', generation: 7, seq: 3, data: 'x'.repeat(524289) });
    await state.parseBarrier();
    const buffered = state.__flowPending.get('flow-a') ?? [];
    return { parsed: state.parserWrites.map((data: string) => ({ length: data.length, prefix: data.slice(0, 80) })), pending: buffered.map((part: any) => [part.generation, part.seq]), bytes: buffered.reduce((sum: number, part: any) => sum + part.data.length, 0), acks: state.flow.calls.filter((call: any) => call.command === 'session_output_ack').map((call: any) => call.args) };
  });
  expect(before.parsed).toEqual([]);
  expect(before.pending).toEqual([[7, 1], [7, 1]]);
  expect(before.bytes).toBeLessThanOrEqual(524288);
  expect(before.acks).toEqual([{ id: 'flow-a', generation: 6, seq: 100 }, { id: 'flow-a', generation: 7, seq: 3 }]);
  await expect(page.locator('.toast.error')).toContainText('버퍼 한도를 초과');
  await page.evaluate(async () => { const state = window as any; state.flow.emit({ id: 'flow-a', state: 'stopped', active: false }); state.flow.releaseMetadata(); await state.parseBarrier(); });
  expect(await page.evaluate(() => { const state = window as any; return { parsed: state.parserWrites, sent: state.flow.sent, pending: state.__flowPending.size, canType: state.__flowCanType('flow-a'), disableStdin: state.__flowTerminals.get('flow-a').terminal.options.disableStdin }; })).toEqual({ parsed: ['STOP-TAIL\u001b[3;9H\u001b[6n'], sent: [], pending: 0, canType: false, disableStdin: true });
});

test('N7 32키에서도 기존 startup 세션 frame은 보존하고 33번째 새 키만 거절한다', async ({ page }) => {
  await startingWorkspace(page);
  const snapshot = await page.evaluate(async () => {
    const state = window as any;
    state.flow.output({ id: 'flow-a', generation: 7, seq: 1, data: 'FIRST' });
    for (let index = 0; index < 31; index++) state.flow.output({ id: `startup-orphan-${index}`, generation: 7, seq: 1, data: 'OWN-FIXTURE' });
    state.flow.output({ id: 'flow-a', generation: 7, seq: 2, data: 'SECOND' });
    state.flow.output({ id: 'startup-orphan-33', generation: 7, seq: 1, data: 'MUST-BE-REFUSED' });
    await state.parseBarrier();
    return { keys: state.__flowPending.size, existing: state.__flowPending.get('flow-a')?.map((part: any) => part.seq), refused: state.__flowPending.has('startup-orphan-33'), parsed: state.parserWrites,
      acks: state.flow.calls.filter((call: any) => call.command === 'session_output_ack').map((call: any) => call.args) };
  });
  expect(snapshot).toEqual({ keys: 32, existing: [1, 2], refused: false, parsed: [], acks: [{ id: 'startup-orphan-33', generation: 7, seq: 1 }] });
  await expect(page.locator('.toast.error')).toContainText('버퍼 한도를 초과');
  await page.evaluate(async () => { const state = window as any; state.flow.emit({ id: 'flow-a', state: 'idle', active: true }); state.flow.releaseMetadata(); await state.parseBarrier(); });
  await expect.poll(() => page.evaluate(() => (window as any).__flowPending.size)).toBe(0);
  expect(await page.evaluate(() => (window as any).parserWrites)).toEqual(['FIRST', 'SECOND']);
});

test('Shift+Enter sends the CLI newline key once while plain Enter and IME keep their own input', async ({ page }) => {
  await workspace(page);
  await input(page).press('Shift+Enter');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['\u001b\r']);
  await input(page).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['\u001b\r', '\r']);
  await input(page).evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, shiftKey: true, isComposing: true, bubbles: true }));
  });
  await input(page).press('a');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['\u001b\r', '\r', 'a']);
});

test('held native input retains at most128 operations, preserves order and resumes stdin after drain', async ({ page }) => {
  await workspace(page);
  await page.evaluate(() => { (window as any).flow.holdWrites = true; });
  const typed = 'abcdefghij'.repeat(20);
  await input(page).pressSequentially(typed);
  expect(await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_write').length)).toBe(1);
  await page.evaluate(() => (window as any).flow.releaseWrites());
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.length)).toBe(128);
  expect(await page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data).join(''))).toBe(typed.slice(0, 128));
  await expect(card(page)).toHaveAttribute('data-input-paused', 'false');
  await expect(card(page)).toHaveAttribute('data-input-pending', '0');
  await input(page).press('z');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.at(-1)?.data)).toBe('z');
  expect(await page.evaluate(() => (window as any).flow.maxWrites)).toBe(1);
});

test('held Unicode pastes are bounded by256KiB including the inflight payload without truncating accepted text', async ({ page }) => {
  await workspace(page);
  const payload = '한😀'.repeat(9362) + 'ab'; // 65,536 UTF-8 bytes, whole code points.
  expect(new TextEncoder().encode(payload).byteLength).toBe(64 * 1024);
  await page.evaluate(() => { (window as any).flow.holdWrites = true; });
  for (let index = 0; index < 6; index++) await page.keyboard.insertText(payload);
  await page.evaluate(() => (window as any).flow.releaseWrites());
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.length)).toBe(4);
  const sent = await page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data));
  expect(sent).toEqual([payload, payload, payload, payload]);
  await expect(card(page)).toHaveAttribute('data-input-bytes', '0');
});

test('oversized input is rejected in full before IPC and a smaller retry remains usable', async ({ page }) => {
  await workspace(page);
  await page.keyboard.insertText('한😀'.repeat(9363));
  expect(await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_write'))).toEqual([]);
  await expect(page.locator('.toast.error')).toContainText('한 번에 64KiB 이하');
  await page.keyboard.insertText('작은 입력');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['작은 입력']);
});

test('project and generation changes discard pending input and cannot write to hidden or replacement sessions', async ({ page }) => {
  await workspace(page);
  await page.evaluate(() => { (window as any).flow.holdWrites = true; });
  await input(page).press('x'); await input(page).press('q');
  await page.locator('#project-tabs [role=tab]').filter({ hasText: 'Flow Beta' }).click();
  await page.evaluate(() => (window as any).flow.releaseWrites());
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['x']);
  await expect(card(page)).toBeHidden();
  await page.locator('#project-tabs [role=tab]').filter({ hasText: 'Flow Alpha' }).click();
  await input(page).focus();
  await page.evaluate(() => { (window as any).flow.holdWrites = true; });
  await input(page).press('y'); await input(page).press('o');
  await page.evaluate(() => (window as any).flow.emit({ id: 'flow-a', generation: 8 }));
  await input(page).press('n');
  await page.evaluate(() => (window as any).flow.releaseWrites());
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => [item.generation, item.data]))).toEqual([[7, 'x'], [7, 'y'], [8, 'n']]);
});

test('disposing a terminal clears pending input while its one inflight request completes', async ({ page }) => {
  await workspace(page);
  await page.evaluate(() => { (window as any).flow.holdWrites = true; });
  await input(page).press('x'); await input(page).press('q');
  await page.evaluate(() => (window as any).flow.emit({ id: 'flow-a', state: 'stopped', active: false }));
  await card(page).getByLabel('이 세션 종료').click();
  await expect(card(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).flow.releaseWrites());
  await expect.poll(() => page.evaluate(() => (window as any).flow.activeWrites)).toBe(0);
  expect(await page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['x']);
});

test('an already reaped error session closes without a process-stop prompt or native stop', async ({ page }) => {
  await workspace(page);
  await page.evaluate(() => (window as any).flow.emit({ id: 'flow-a', state: 'error', active: false }));
  let prompts = 0;
  page.on('dialog', async dialog => { prompts++; await dialog.dismiss(); });
  await card(page).getByLabel('이 세션 종료').click();
  await expect(card(page)).toHaveCount(0);
  expect(prompts).toBe(0);
  expect(await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_stop'))).toEqual([]);
});

test('held native resize keeps one request and the latest pending geometry, not an IPC chain', async ({ page }) => {
  await page.clock.install();
  await workspace(page);
  await expect.poll(() => page.evaluate(() => (window as any).flow.calls.some((call: any) => call.command === 'session_resize' && call.args.id === 'flow-a'))).toBe(true);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const fitViewport = async (width: number) => {
    await page.setViewportSize({ width, height: 1000 });
    // Observe real layout before advancing the fit frame and its60ms debounce.
    // Wall-clock sleeps do not establish either of those completion boundaries.
    await card(page).locator('.terminal-host').evaluate(host => new Promise<void>(resolve => {
      const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(host);
    }));
    await page.clock.runFor(80);
  };
  await fitViewport(1440);
  await page.evaluate(() => { const flow = (window as any).flow; flow.calls = []; flow.holdResize = true; flow.maxResizes = 0; });
  await fitViewport(1600);
  for (let index = 1; index <= 8; index++) {
    await fitViewport(1600 + index * 40);
    expect(await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_resize' && call.args.id === 'flow-a').length)).toBe(1);
  }
  // The other equal-width column sends freely and supplies the final geometry.
  expect(await card(page).locator('.terminal-host').evaluate(host => host.clientWidth)).toBe(await card(page, 'flow-b').locator('.terminal-host').evaluate(host => host.clientWidth));
  const latest = await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_resize' && call.args.id === 'flow-b').at(-1).args);
  await page.evaluate(() => (window as any).flow.releaseResize());
  await expect.poll(() => page.evaluate(() => (window as any).flow.activeResizes)).toBe(0);
  const sizes = await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_resize' && call.args.id === 'flow-a').map((call: any) => call.args));
  expect(sizes).toHaveLength(2);
  expect(sizes[1]).toEqual({ ...latest, id: 'flow-a' });
  expect(sizes[1].cols).toBeGreaterThan(sizes[0].cols);
  expect(sizes.map((item: any) => item.generation)).toEqual([7, 7]);
  expect(await page.evaluate(() => (window as any).flow.maxResizes)).toBe(1);
});

test('queue disposal releases cancelled payload objects before its inflight request finishes', async ({ page }) => {
  await workspace(page);
  const initial = await page.evaluate(async () => {
    const modulePath = '/src/terminal-flow.ts';
    const { TerminalInputQueue, TerminalResizeQueue } = await import(modulePath);
    const probe: any = { sent: [], resized: [] };
    const gate = new Promise<void>(resolve => { probe.release = resolve; });
    probe.input = new TerminalInputQueue(async (value: any) => { await gate; probe.sent.push(value.data); }, () => {});
    probe.active = probe.input.enqueue({ data: 'inflight' });
    // Return from a synchronous fixture scope before GC. A top-level async
    // loop can itself retain its final local, independently of the queue.
    function fill(queue: any) {
      const refs = []; const promises = [];
      for (let index = 0; index < 127; index++) { const value = { data: 'pending-' + index }; refs.push(new WeakRef(value)); promises.push(queue.enqueue(value)); }
      return { refs, promises };
    }
    const pending = fill(probe.input); probe.inputRefs = pending.refs;
    probe.input.dispose(); await Promise.allSettled(pending.promises);
    probe.resize = new TerminalResizeQueue(async (value: any) => { await gate; probe.resized.push(value); }, (error: unknown) => { throw error; });
    probe.resize.enqueue({ cols: 80, rows: 24 });
    function sizes(queue: any) {
      const refs = [];
      for (let index = 0; index < 1000; index++) { const value = { cols: 81 + index, rows: 24 }; refs.push(new WeakRef(value)); queue.enqueue(value); }
      return refs;
    }
    probe.resizeRefs = sizes(probe.resize); probe.resize.dispose();
    (window as any).queueLifetime = probe;
    return { size: probe.input.size, bytes: probe.input.byteLength };
  });
  expect(initial).toEqual({ size: 1, bytes: 8 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
  expect(await page.evaluate(() => {
    const probe = (window as any).queueLifetime;
    return [...probe.inputRefs, ...probe.resizeRefs].filter(reference => reference.deref() !== undefined).length;
  })).toBe(0);
  await page.evaluate(() => (window as any).queueLifetime.release());
  await expect.poll(() => page.evaluate(() => (window as any).queueLifetime.input.size)).toBe(0);
  expect(await page.evaluate(() => (window as any).queueLifetime.sent)).toEqual(['inflight']);
  expect(await page.evaluate(() => (window as any).queueLifetime.resized)).toEqual([{ cols: 80, rows: 24 }]);
  await cdp.detach();
});

test('cumulative output acknowledgements follow parse completion, preserve generations and retain no payload', async ({ page }) => {
  await workspace(page);
  expect(await page.evaluate(async () => {
    const modulePath = '/src/terminal-flow.ts';
    const { TerminalOutputAcknowledgements } = await import(modulePath);
    const sent: any[] = [];
    const queue = new TerminalOutputAcknowledgements((value: any) => sent.push(value));
    queue.enqueue({ id: 'a', generation: 7, seq: 1, data: 'not retained' });
    queue.enqueue({ id: 'a', generation: 7, seq: 128 });
    queue.enqueue({ id: 'a', generation: 7, seq: 2 });
    queue.enqueue({ id: 'a', generation: 8, seq: 1 });
    queue.enqueue({ id: 'b', generation: 7, seq: 5 });
    const before = sent.length;
    await Promise.resolve();
    const first = [...sent];
    queue.enqueue({ id: 'a', generation: 8, seq: 2 });
    await Promise.resolve();
    return { before, first, last: sent.at(-1) };
  })).toEqual({ before: 0, first: [{ id: 'a', generation: 7, seq: 128 }, { id: 'a', generation: 8, seq: 1 }, { id: 'b', generation: 7, seq: 5 }], last: { id: 'a', generation: 8, seq: 2 } });
});

test('parsed output acknowledges the final sequence without releasing a held later frame', async ({ page }) => {
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch();
    let body = await response.text();
    if (process.env.TERMINAL_ACK_BASELINE === '1') body = directAcknowledgements(body);
    await route.fulfill({ response, body: body + '\nwindow.__flowTerminals = terminals;\n' });
  });
  await workspace(page);
  await page.evaluate(() => {
    const state = window as any; const terminal = state.__flowTerminals.get('flow-a').terminal;
    const write = terminal.write.bind(terminal);
    state.heldOutput = [];
    terminal.write = (data: string, parsed: () => void) => data === 'held-later' ? state.heldOutput.push(() => write(data, parsed)) : write(data, parsed);
    for (let seq = 1; seq <= 128; seq++) state.flow.output({ id: 'flow-a', generation: 7, seq, data: seq === 128 ? 'held-later' : `row-${seq}\r\n` });
  });
  await expect.poll(() => page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_output_ack').at(-1)?.args.seq)).toBe(127);
  expect(await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_output_ack').length)).toBeLessThan(127);
  expect(await page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_output_ack').some((call: any) => call.args.seq === 128))).toBe(false);
  await page.evaluate(() => { for (const release of (window as any).heldOutput) release(); });
  await expect.poll(() => page.evaluate(() => (window as any).flow.calls.filter((call: any) => call.command === 'session_output_ack').at(-1)?.args.seq)).toBe(128);
});

test('replacement generation clears already queued parser output before rendering new output', async ({ page }) => {
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nwindow.__flowTerminals = terminals;\n' });
  });
  await workspace(page);
  const lines = await page.evaluate(async () => {
    const state = window as any;
    state.flow.output({ id: 'flow-a', generation: 7, seq: 1, data: 'obsolete-generation\r\n' });
    state.flow.emit({ id: 'flow-a', generation: 8 });
    state.flow.output({ id: 'flow-a', generation: 8, seq: 1, data: 'current-generation\r\n' });
    const terminal = state.__flowTerminals.get('flow-a').terminal;
    await new Promise<void>(resolve => terminal.write('', resolve));
    return Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true)).join('\n');
  });
  expect(lines).toContain('current-generation');
  expect(lines).not.toContain('obsolete-generation');
});

// Optional comparison uses the real app and xterm in Chromium, with a bounded
// synthetic native transport. It does not represent Windows WebView or real IME.
test('terminal replay comparison', async ({ browser }, testInfo) => {
  test.skip(process.env.TERMINAL_PERF_REPLAY !== '1', '명시적으로 켜는 비교 측정입니다.');
  test.setTimeout(180000);
  const results = [];
  for (const count of [1, 8]) for (let repeat = 0; repeat < 3; repeat++) for (const variant of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // Other agents may edit this checkout while measuring. A Vite hot reload
    // would replace the measured document midway through a sample.
    await page.routeWebSocket('**', () => {});
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch(); let body = await response.text();
      if (variant === 'baseline') body = directAcknowledgements(body);
      await route.fulfill({ response, body: body + '\nwindow.__flowTerminals = terminals;\n' });
    });
    const fixture = Array.from({ length: count }, (_, index) => ({ ...sessions[0], id: index ? `flow-${index}` : 'flow-a', title: `부하 ${index}`, threadId: `flow-thread-${index}` }));
    await workspace(page, fixture);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const beforeMetrics = await cdp.send('Performance.getMetrics');
    const heapBefore = beforeMetrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value;
    const result = await page.evaluate(async ({ count }) => {
      const state = window as any; const flow = state.flow;
      const views = [...state.__flowTerminals.values()] as any[];
      const ids = [...state.__flowTerminals.keys()] as string[];
      const textarea = views[0].terminal.textarea as HTMLTextAreaElement;
      const seq = new Map(ids.map(id => [id, 0]));
      // Give scrolling real history in every terminal, using parsed completion.
      await Promise.all(views.map(view => new Promise<void>(resolve => view.terminal.write(('초기 줄 ' + 'x'.repeat(100) + '\r\n').repeat(1200), resolve))));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      flow.calls = { push() {} }; flow.sent.length = 0;
      const original = state.__TAURI_INTERNALS__.invoke;
      const outstanding = new Map(ids.map(id => [id, 0]));
      const acknowledged = new Map(ids.map(id => [id, 0]));
      const inputTimes: number[] = []; const inputDelay: number[] = []; const ackDelay: number[] = []; const emitted = new Map<string, Map<number, number>>();
      let acknowledgements = 0; let maxOutstanding = 0;
      state.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
        if (command === 'session_write' && args.id === ids[0]) inputDelay.push(performance.now() - inputTimes.shift()!);
        if (command === 'session_output_ack') {
          acknowledgements++;
          const times = emitted.get(args.id)!;
          const before = acknowledged.get(args.id)!;
          for (let number = before + 1; number <= args.seq; number++) { ackDelay.push(performance.now() - times.get(number)!); times.delete(number); }
          acknowledged.set(args.id, args.seq); outstanding.set(args.id, seq.get(args.id)! - args.seq);
        }
        return original(command, args);
      };
      const frames: number[] = []; let running = true; let last = performance.now();
      const frame = (now: number) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      const started = performance.now();
      let chunks = 0; let typed = 0; let scrolls = 0; let maxInputPending = 0;
      const line = '\x1b[32m출력 ' + 'x'.repeat(70) + '\x1b[0m\r\n';
      const targetChunks = 128 * 96; const targetInputs = 128; const targetScrolls = 96;
      const outputTimer = setInterval(() => {
        for (const id of ids) {
          const remaining = Math.min(128 - outstanding.get(id)!, targetChunks - seq.get(id)!);
          const times = emitted.get(id) ?? new Map(); emitted.set(id, times);
          for (let index = 0; index < remaining; index++) {
            const next = seq.get(id)! + 1; seq.set(id, next); outstanding.set(id, outstanding.get(id)! + 1);
            times.set(next, performance.now()); chunks++;
            flow.output({ id, generation: 7, seq: next, data: line });
          }
          maxOutstanding = Math.max(maxOutstanding, outstanding.get(id)!);
        }
      }, 8);
      const typingTimer = setInterval(() => {
        if (typed >= targetInputs) return;
        textarea.focus(); inputTimes.push(performance.now());
        textarea.value = String.fromCharCode(97 + (typed++ % 26));
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textarea.value }));
        maxInputPending = Math.max(maxInputPending, Number(views[0].card.dataset.inputPending));
      }, 12);
      const scrollTimer = setInterval(() => { if (scrolls < targetScrolls) views[0].terminal.scrollLines(scrolls++ % 2 ? 3 : -3); }, 16);
      while (chunks < count * targetChunks || typed < targetInputs || scrolls < targetScrolls) {
        if (performance.now() - started > 15000) throw new Error('고정량 replay 완료 제한 시간을 초과했습니다.');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      clearInterval(outputTimer); clearInterval(typingTimer); clearInterval(scrollTimer);
      const produceMs = performance.now() - started;
      await Promise.all(views.map(view => new Promise<void>(resolve => view.terminal.write('', resolve))));
      await Promise.resolve(); running = false;
      const sorted = (values: number[]) => values.filter(Number.isFinite).sort((a, b) => a - b);
      const stats = (values: number[]) => { const ordered = sorted(values); return { samples: ordered.length, p50: ordered[Math.floor(ordered.length * .5)] ?? 0, p95: ordered[Math.floor(ordered.length * .95)] ?? 0, max: ordered.at(-1) ?? 0 }; };
      return { count, produceMs, completeMs: performance.now() - started, chunks, bytes: chunks * new TextEncoder().encode(line).length, acknowledgements, maxOutstanding, typed, sent: flow.sent.length, scrolls, maxInputPending, inputMs: stats(inputDelay), frameMs: stats(frames), parsedAckMs: stats(ackDelay), remaining: [...outstanding.values()], heapBytes: (performance as any).memory?.usedJSHeapSize ?? null, raw: { inputMs: inputDelay, frameMs: frames } };
    }, { count });
    expect(result.remaining).toEqual(Array(count).fill(0));
    expect(result.sent).toBe(result.typed);
    expect(result.maxOutstanding).toBeLessThanOrEqual(128);
    await cdp.send('HeapProfiler.collectGarbage');
    const afterMetrics = await cdp.send('Performance.getMetrics');
    const heapAfter = afterMetrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value;
    results.push({ variant, repeat, ...result, heapBeforeGcBytes: heapBefore, heapAfterGcBytes: heapAfter, retainedHeapDeltaBytes: heapAfter - heapBefore });
    await writeFile(testInfo.outputPath(`${count}-${repeat}-${variant}.json`), JSON.stringify(results.at(-1), null, 2), 'utf8');
    const { raw: _raw, ...summary } = results.at(-1)!;
    console.log(JSON.stringify({ terminalReplaySample: summary }));
    await cdp.detach();
    await page.close();
  }
  const reportPath = testInfo.outputPath('terminal-replay.json');
  await writeFile(reportPath, JSON.stringify({ schema: 'terminal-replay-v1', browser: browser.version(), platform: process.platform, scope: 'Chromium synthetic native IPC; real app and xterm; ACK baseline only; no WebView, actual CLI or physical IME claim', results }, null, 2), 'utf8');
  await testInfo.attach('terminal-replay.json', { path: reportPath, contentType: 'application/json' });
});

// Real xterm selection/keyboard/clipboard; only the native IPC transport is synthetic.
async function questionTerminal(page: Page, mouseMode: boolean) {
  await page.route('**/src/main.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nwindow.__flowTerminals = terminals;\n' });
  });
  await workspace(page);
  return page.evaluate(async mouseMode => {
    const state = window as any;
    const terminal = state.__flowTerminals.get('flow-a').terminal;
    await new Promise<void>(resolve => terminal.write('\x1b[?1049h\x1b[?2004h' + (mouseMode ? '\x1b[?1000h\x1b[?1006h' : '') + '\x1b[HQueued follow-up inputs\r\nQuestion fixture: first line\r\nQuestion fixture: second line', resolve));
    state.flow.sent = [];
    const box = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width / terminal.cols, height: box.height / terminal.rows };
  }, mouseMode);
}

for (const mouseMode of [false, true]) {
  test(`question terminal drag and Ctrl+C copy without interrupting CLI (mouse mode ${mouseMode})`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const cell = await questionTerminal(page, mouseMode);
    if (mouseMode) await page.keyboard.down('Shift');
    await page.mouse.move(cell.x + cell.width * .1, cell.y + cell.height * .5);
    await page.mouse.down();
    await page.mouse.move(cell.x + cell.width * 28.1, cell.y + cell.height * 1.5, { steps: 8 });
    await page.mouse.up();
    if (mouseMode) await page.keyboard.up('Shift');
    const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
    const selectedText = `Queued follow-up inputs${lineEnding}Question fixture: first line`;
    await expect.poll(() => page.evaluate(() => (window as any).__flowTerminals.get('flow-a').terminal.getSelection())).toBe(selectedText);
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText);
    expect(await page.evaluate(() => (window as any).flow.sent)).toEqual([]);
    await page.keyboard.press('Control+Shift+c');
    expect(await page.evaluate(() => (window as any).flow.sent)).toEqual([]);
    await page.evaluate(() => (window as any).__flowTerminals.get('flow-a').terminal.clearSelection());
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['\x03']);
  });
}

test('question terminal Ctrl+V and Ctrl+Shift+V paste Unicode once with bracketed paste and no submit', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await questionTerminal(page, true);
  await page.evaluate(() => navigator.clipboard.writeText('합성 답변 😀\nsecond line'));
  await page.keyboard.press('Control+v');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(['\x1b[200~합성 답변 😀\rsecond line\x1b[201~']);
  await page.keyboard.press('Control+Shift+v');
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data))).toEqual(Array(2).fill('\x1b[200~합성 답변 😀\rsecond line\x1b[201~'));
});

test('question terminal keeps CLI mouse clicks and wheel reports outside Shift selection', async ({ page }) => {
  const cell = await questionTerminal(page, true);
  await page.mouse.click(cell.x + cell.width * 5.5, cell.y + cell.height * .5);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => page.evaluate(() => (window as any).flow.sent.map((item: any) => item.data).slice(0, 3))).toEqual(['\x1b[<0;6;1M', '\x1b[<0;6;1m', '\x1b[<65;6;1M']);
  expect(await page.evaluate(() => (window as any).__flowTerminals.get('flow-a').terminal.getSelection())).toBe('');
});
