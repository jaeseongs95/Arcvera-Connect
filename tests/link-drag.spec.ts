import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { transformWithEsbuild } from 'vite';

async function setup(page: Page) {
  if (process.env.LINK_DRAG_BASELINE === '1') {
    const revision = process.env.LINK_DRAG_BASELINE_REVISION ?? '6e453bf';
    const baseline = execFileSync('git', ['show', `${revision}:src/external-links.ts`], { encoding: 'utf8' });
    await page.route('**/src/external-links.ts', async route => {
      const response = await route.fetch();
      const current = await response.text();
      const specifier = current.match(/import\s*\{\s*invoke\s*\}\s*from\s*["']([^"']+)["']/)?.[1];
      if (!specifier) throw Error('Vite external opener import missing');
      const compiled = await transformWithEsbuild(baseline, 'external-links.ts', { loader: 'ts', target: 'esnext' });
      await route.fulfill({ response, body: compiled.code.replace(/(["'])@tauri-apps\/api\/core\1/, JSON.stringify(specifier)) });
    });
  }
  await page.addInitScript(() => {
    const state = window as any;
    state.linkDrag = { calls: [], errors: [], drags: [] };
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== 'open_external_url') throw Error(`Unexpected command ${command}`);
      state.linkDrag.calls.push(args.url);
    } };
    document.addEventListener('dragstart', event => {
      const target = event.target as HTMLElement;
      queueMicrotask(() => state.linkDrag.drags.push({ tag: target.tagName, className: target.className, prevented: event.defaultPrevented }));
    }, true);
  });
  await page.goto('/?demo');
  await page.evaluate(async () => {
    const { appendLinkifiedText, installTerminalExternalLinks } = await import('/src/external-links.ts');
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const state = (window as any).linkDrag;
    const host = document.createElement('section'); host.id = 'link-drag-fixture';
    host.style.cssText = 'position:fixed;inset:80px 20px;z-index:99999;background:#141820;color:white;padding:20px;font:16px monospace;';
    document.body.append(host);
    const body = document.createElement('p'); body.id = 'drag-body'; appendLinkifiedText(body, 'https://example.com/body-link-long-enough'); host.append(body);
    const text = document.createElement('p'); text.id = 'drag-text'; text.textContent = 'selectable ordinary body text'; host.append(text);
    const label = document.createElement('label'); label.id = 'drag-label';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.id = 'drag-radio'; label.append(radio);
    appendLinkifiedText(label, 'https://example.com/question-link-long-enough'); host.append(label);
    const terminalHost = document.createElement('div'); terminalHost.id = 'drag-terminal'; host.append(terminalHost);
    const terminal = state.terminal = new Terminal({ cols: 80, rows: 6, fontSize: 16, fontFamily: 'Consolas, monospace' }); terminal.open(terminalHost);
    state.links = installTerminalExternalLinks(terminal, (error: Error) => state.errors.push(error.message));
    await new Promise<void>(resolve => terminal.write('https://example.com/terminal-long-link\r\n\u001b]8;;https://example.com/osc8\u0007OSC8 visible long link text\u001b]8;;\u0007', resolve));
  });
}

async function terminalPoint(page: Page, column: number, row: number) {
  const rect = (await page.locator('#drag-terminal .xterm-screen').boundingBox())!;
  return { x: rect.x + rect.width / 80 * (column - 0.5), y: rect.y + rect.height / 6 * (row - 0.5) };
}

test('LD-01 body/radio link drag never opens; a new click and Enter each open once', async ({ page }) => {
  await setup(page);
  for (const selector of ['#drag-body a', '#drag-label a']) {
    await page.evaluate(() => { window.getSelection()?.removeAllRanges(); (window as any).linkDrag.calls = []; });
    const link = page.locator(selector); const rect = (await link.boundingBox())!;
    await page.mouse.move(rect.x + 8, rect.y + rect.height / 2);
    await page.mouse.down(); await page.mouse.move(rect.x + 43, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    console.log('LD-01 gesture', JSON.stringify(await page.evaluate(selector => ({ selector, selection: window.getSelection()?.toString(), calls: (window as any).linkDrag.calls, drags: (window as any).linkDrag.drags }), selector)));
    expect(await page.evaluate(() => (window as any).linkDrag.drags.filter((event: any) => !event.prevented)), 'native anchor drag must not begin').toEqual([]);
    await expect(page.locator('.terminal-card.dragging')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).linkDrag.calls), 'a link drag gesture must not invoke the opener').toEqual([]);
    await expect(page.locator('#drag-radio')).not.toBeChecked();
    // Returning to the starting point is still a drag, not a fresh click.
    await page.mouse.move(rect.x + 8, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + 43, rect.y + rect.height / 2, { steps: 8 });
    await page.mouse.move(rect.x + 8, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    expect(await page.evaluate(() => (window as any).linkDrag.calls), 'a returning drag must not invoke the opener').toEqual([]);
    // A previous drag must not suppress a new activation.
    await link.click(); expect(await page.evaluate(() => (window as any).linkDrag.calls)).toHaveLength(1);
    await link.focus(); await page.keyboard.press('Enter'); expect(await page.evaluate(() => (window as any).linkDrag.calls)).toHaveLength(2);
    await page.mouse.move(rect.x + 8, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + 10, rect.y + rect.height / 2); await page.mouse.up();
    expect(await page.evaluate(() => (window as any).linkDrag.calls), 'a 2px click wobble remains an activation').toHaveLength(3);
    await expect(page.locator('#drag-radio')).not.toBeChecked();
  }
  expect(await page.evaluate(() => (window as any).linkDrag.errors)).toEqual([]);
});

test('LD-02 ordinary body selection and direct radio selection remain available', async ({ page }) => {
  await setup(page);
  const points = await page.locator('#drag-text').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect();
    return { start: { x: rect.left, y: rect.top + rect.height / 2 }, end: { x: rect.right, y: rect.top + rect.height / 2 } };
  });
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 12 }); await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('selectable ordinary body text');
  await page.locator('#drag-radio').check(); await expect(page.locator('#drag-radio')).toBeChecked();
  expect(await page.evaluate(() => (window as any).linkDrag.calls)).toEqual([]);
});

test('LD-03 xterm plain/OSC8 selection does not open links; a new click opens once', async ({ page }) => {
  await setup(page);
  for (const row of [1, 2]) for (const shift of [true, false]) {
    await page.evaluate(async shift => {
      const state = (window as any).linkDrag; state.calls = []; state.terminal.clearSelection();
      // Shift forces selection when a TUI enables mouse reporting. With mouse
      // reporting off xterm uses Shift to extend an existing selection instead.
      await new Promise<void>(resolve => state.terminal.write(shift ? '\u001b[?1000h' : '\u001b[?1000l', resolve));
    }, shift);
    const start = await terminalPoint(page, 3, row); const end = await terminalPoint(page, 17, row);
    await page.mouse.move(start.x, start.y);
    await expect(page.locator('#drag-terminal .xterm')).toHaveAttribute('title', row === 1 ? 'https://example.com/terminal-long-link' : 'https://example.com/osc8');
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
    expect(await page.evaluate(() => (window as any).linkDrag.terminal.getSelection()), 'xterm text selection remains available').not.toBe('');
    expect(await page.evaluate(() => (window as any).linkDrag.calls), 'a selection gesture is not a link activation').toEqual([]);
    await page.mouse.click(start.x, start.y);
    expect(await page.evaluate(() => (window as any).linkDrag.calls)).toEqual([row === 1 ? 'https://example.com/terminal-long-link' : 'https://example.com/osc8']);
    await expect(page.locator('.terminal-card.dragging')).toHaveCount(0);
  }
});

test('LD-04 real session drag handle still reorders demo cards', async ({ page }) => {
  await setup(page); await page.locator('#link-drag-fixture').evaluate(element => element.remove());
  // Use the actual grid selector from the rendered product instead of a fixture handle.
  const actualCards = page.locator('.terminal-card');
  const before = await actualCards.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id));
  expect(before.length).toBeGreaterThan(1);
  const first = actualCards.nth(0); const second = actualCards.nth(1);
  const handle = (await first.locator('.drag-handle').boundingBox())!; const target = (await second.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 20, { steps: 12 });
  await expect(first).toHaveClass(/dragging/); await page.mouse.up();
  const after = await actualCards.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id));
  expect(after).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(page.locator('.terminal-card.dragging')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).linkDrag.drags.some((event: any) => event.className === 'drag-handle' && !event.prevented))).toBe(true);
});
