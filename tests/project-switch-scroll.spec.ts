import { test, expect, type Page, type Locator } from '@playwright/test';

const card = (page: Page, id = 'alpha') => page.locator(`.terminal-card[data-id="${id}"]`);
const tab = (page: Page, name: string) => page.locator('#project-tabs [role=tab]').filter({ hasText: new RegExp(`^${name}\\s`) });
const gap = (node: Locator) => node.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);

async function workspace(page: Page) {
  if (process.env.PROJECT_SCROLL_MUTATION) await page.route('**/src/main.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    const original = body;
    body = body.replace('visibleOrder().filter((id) => projectChanged || scrollExisting || !previousVisible.has(id))', 'visibleOrder()');
    expect(body, 'isolated mutation must change the served module').not.toBe(original);
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => {
    const w = window as any; w.isTauri = true;
    const callbacks = new Map<number, any>(); const listeners = new Map<string, any>(); let callback = 0;
    const sessions = ['alpha', 'beta'].map(id => ({ id, generation: 1, title: id, cwd: `D:\\${id}`, threadId: `thread-${id}`, state: 'idle', active: true }));
    const f = w.scrollFixture = { calls: [] as any[], holdItems: false, pending: [] as (() => void)[],
      release() { f.pending.splice(0).forEach(done => done()); },
      emit(event: string, payload: any) { listeners.get(event)?.({ payload }); },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback(handler: any) { callbacks.set(++callback, handler); return callback; }, unregisterCallback() {},
      async invoke(command: string, args: any = {}) {
        f.calls.push({ command, args });
        if (command === 'plugin:event|listen') { listeners.set(args.event, callbacks.get(args.handler)); return callback; }
        if (command.startsWith('plugin:event|')) return null;
        if (command === 'get_ui_language') return 'ko';
        if (command === 'load_layout') return { version: 1, columns: 1, sessions: [] };
        if (command === 'list_sessions') return sessions;
        if (command === 'list_projects') return sessions.map(s => ({ id: s.id, name: s.id, cwd: s.cwd, createdAt: 1, favorite: false }));
        if (command === 'conversation_request') {
          const type = args.request.type;
          if (type === 'contextStatus') return { revision: 1, passiveSubscriptionSupported: true, connected: true, guiConnected: false, compacting: false, tokenUsageFresh: false };
          if (type === 'attach') return { threadId: `thread-${args.id}`, activeTurnKnown: true, activeTurnId: null };
          if (type === 'page') return { data: [{ id: 'turn', status: 'completed' }], nextCursor: null };
          if (type === 'items') {
            if (f.holdItems) await new Promise<void>(resolve => f.pending.push(resolve));
            return { data: Array.from({ length: 30 }, (_, i) => ({ turnId: 'turn', item: { id: `item-${i}`, type: 'agentMessage', text: `message ${i}\n` + 'content\n'.repeat(5) } })), nextCursor: null };
          }
          if (type === 'models') return { data: [], nextCursor: null };
          if (type === 'poll') return { events: [], pendingRequests: [], connected: true, gap: false };
          return {};
        }
        return null;
      },
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  await expect(tab(page, 'alpha')).toBeVisible();
}

async function terminalHistory(page: Page) {
  await page.evaluate(() => (window as any).scrollFixture.emit('terminal-output', { id: 'alpha', generation: 1, seq: 1, data: Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\r\n') + '\r\nLATEST_MARKER' }));
  await expect.poll(() => page.evaluate(() => (window as any).scrollFixture.calls.some((c: any) => c.command === 'session_output_ack' && c.args.id === 'alpha'))).toBe(true);
}

test('PS-1 newly revealed terminal reaches bottom without stealing project tab focus', async ({ page }) => {
  await workspace(page); await terminalHistory(page);
  await tab(page, 'alpha').click();
  const rows = card(page).locator('.xterm-rows');
  await expect(rows).toContainText('LATEST_MARKER');
  await card(page).locator('.xterm-helper-textarea').press('Shift+PageUp');
  await expect(rows).not.toContainText('LATEST_MARKER');
  await tab(page, 'beta').click(); await tab(page, 'alpha').click();
  await expect(rows).toContainText('LATEST_MARKER');
  await expect(tab(page, 'alpha')).toBeFocused();
});

test('PS-6 switching from all projects to an already visible project still reveals the latest message', async ({ page }) => {
  await workspace(page); await terminalHistory(page);
  const rows = card(page).locator('.xterm-rows');
  await expect(rows).toContainText('LATEST_MARKER');
  await card(page).locator('.xterm-helper-textarea').press('Shift+PageUp');
  await expect(rows).not.toContainText('LATEST_MARKER');
  await tab(page, 'alpha').click();
  await expect(rows).toContainText('LATEST_MARKER');
  await expect(tab(page, 'alpha')).toBeFocused();
});

test('PS-7 switching from all projects resets an already visible structured conversation to its latest message', async ({ page }) => {
  await workspace(page); await card(page).locator('.conversation-toggle').click();
  const messages = card(page).locator('.conversation-messages');
  await expect(messages.locator('article')).toHaveCount(30);
  await messages.evaluate(el => el.scrollTop = 0);
  await card(page).locator('.conversation-input').fill('preserved draft');
  await tab(page, 'alpha').click();
  await expect.poll(() => gap(messages)).toBeLessThan(2);
  await expect(card(page).locator('.conversation-input')).toHaveValue('preserved draft');
  await expect(tab(page, 'alpha')).toBeFocused();
});

test('PS-2 same project reselection and session state updates preserve reading position', async ({ page }) => {
  await workspace(page); await terminalHistory(page); await tab(page, 'alpha').click();
  const rows = card(page).locator('.xterm-rows');
  await expect(rows).toContainText('LATEST_MARKER');
  await card(page).locator('.xterm-helper-textarea').press('Shift+PageUp');
  await expect(rows).not.toContainText('LATEST_MARKER');
  await tab(page, 'alpha').click();
  await page.evaluate(() => (window as any).scrollFixture.emit('session-changed', { id: 'alpha', generation: 1, title: 'alpha', cwd: 'D:\\alpha', threadId: 'thread-alpha', state: 'idle', active: true }));
  await page.evaluate(() => (window as any).scrollFixture.emit('terminal-output', { id: 'alpha', generation: 1, seq: 2, data: '\r\nAFTER_RESELECT' }));
  await expect.poll(() => page.evaluate(() => (window as any).scrollFixture.calls.some((c: any) => c.command === 'session_output_ack' && c.args.seq === 2))).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(rows).not.toContainText('LATEST_MARKER');
  await expect(rows).not.toContainText('AFTER_RESELECT');
});

test('PS-3 delayed structured history reaches bottom after project switch and retains draft and tab focus', async ({ page }) => {
  await workspace(page); await tab(page, 'alpha').click(); await card(page).locator('.conversation-toggle').click();
  const messages = card(page).locator('.conversation-messages');
  await expect(messages.locator('article')).toHaveCount(30);
  await card(page).locator('.conversation-input').fill('preserved draft');
  await messages.evaluate(el => el.scrollTop = 0);
  await tab(page, 'beta').click();
  await page.evaluate(() => (window as any).scrollFixture.holdItems = true);
  await tab(page, 'alpha').click();
  await expect.poll(() => page.evaluate(() => (window as any).scrollFixture.pending.length)).toBe(1);
  await page.evaluate(() => { const f = (window as any).scrollFixture; f.holdItems = false; f.release(); });
  await expect(messages.locator('article')).toHaveCount(30);
  await expect.poll(() => gap(messages)).toBeLessThan(2);
  await expect(card(page).locator('.conversation-input')).toHaveValue('preserved draft');
  await expect(tab(page, 'alpha')).toBeFocused();
  await messages.evaluate(el => el.scrollTop = 0);
  await tab(page, 'alpha').click();
  await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBe(0);
});

test('PS-4 late hidden response is discarded and only the current selection scrolls', async ({ page }) => {
  await workspace(page); await tab(page, 'alpha').click(); await card(page).locator('.conversation-toggle').click();
  await expect(card(page).locator('.conversation-message')).toHaveCount(30);
  await tab(page, 'beta').click();
  await page.evaluate(() => (window as any).scrollFixture.holdItems = true);
  await tab(page, 'alpha').click();
  await expect.poll(() => page.evaluate(() => (window as any).scrollFixture.pending.length)).toBe(1);
  await tab(page, 'beta').click();
  await page.evaluate(() => { const f = (window as any).scrollFixture; f.holdItems = false; f.release(); });
  await expect(card(page).locator('.conversation-message')).toHaveCount(0);
  await expect(tab(page, 'beta')).toBeFocused();
  await tab(page, 'alpha').click();
  await expect(card(page).locator('.conversation-message')).toHaveCount(30);
  await expect.poll(() => gap(card(page).locator('.conversation-messages'))).toBeLessThan(2);
});


test('PS-5 closing a session while history is pending rejects its late response', async ({ page }) => {
  await workspace(page); await tab(page, 'alpha').click(); await card(page).locator('.conversation-toggle').click();
  await expect(card(page).locator('.conversation-message')).toHaveCount(30);
  await tab(page, 'beta').click();
  await page.evaluate(() => (window as any).scrollFixture.holdItems = true);
  await tab(page, 'alpha').click();
  await expect.poll(() => page.evaluate(() => (window as any).scrollFixture.pending.length)).toBe(1);
  await page.evaluate(() => (window as any).scrollFixture.emit('session-changed', { id: 'alpha', generation: 1, title: 'alpha', cwd: 'D:\\alpha', threadId: 'thread-alpha', state: 'exited', active: false }));
  await card(page).locator('.stop').click();
  await expect(card(page)).toHaveCount(0);
  await tab(page, 'beta').click();
  await page.evaluate(() => { const f = (window as any).scrollFixture; f.holdItems = false; f.release(); });
  await expect(card(page)).toHaveCount(0);
  await expect(tab(page, 'beta')).toBeFocused();
});
