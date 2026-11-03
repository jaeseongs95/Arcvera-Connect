import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, capability: unknown = true, holdStatus = false) {
  await page.addInitScript(({ capability, holdStatus }) => {
    const state = window as any; state.isTauri = true;
    const callbacks = new Map<number, any>(); let callback = 0;
    const f = state.capabilityFixture = {
      calls: [] as any[], snapshot: { revision: 1, connected: true, guiConnected: false, active: false, canCompact: false, compacting: false, tokenUsageFresh: false } as any,
      holdStatus, releaseStatus: () => {}, attachFailure: false, detachFailure: false, holdDetach: false, releaseDetach: () => {},
    };
    if (capability !== 'absent') f.snapshot.passiveSubscriptionSupported = capability;
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    state.__TAURI_INTERNALS__ = {
      transformCallback(handler: any) { callbacks.set(++callback, handler); return callback; }, unregisterCallback() {},
      async invoke(command: string, args: any = {}) {
        f.calls.push({ command, args });
        if (command === 'plugin:event|listen') return callback;
        if (command.startsWith('plugin:event|')) return null;
        if (command === 'get_ui_language') return 'ko';
        if (command === 'load_layout') return { version: 1, columns: 1, sessions: [] };
        if (command === 'list_projects') return [];
        if (command === 'list_sessions') return [{ id: 'capability-session', generation: 1, title: '지원 확인 세션', cwd: 'D:\\Work', threadId: 'synthetic-thread', state: 'idle', active: true }];
        if (command === 'cron_request') return { supported: false, connected: false, jobs: [], hasMore: false, reason: 'unsupported' };
        if (command === 'conversation_request') {
          const type = args.request.type;
          if (type === 'contextStatus') {
            const snapshot = structuredClone(f.snapshot);
            if (f.holdStatus) { f.holdStatus = false; await new Promise<void>(resolve => { f.releaseStatus = resolve; }); }
            return snapshot;
          }
          if (type === 'attach') {
            if (f.attachFailure) throw Error('PRIVATE_ATTACH_CAUSE_NEVER_REAL');
            return { threadId: 'synthetic-thread', activeTurnKnown: true, activeTurnId: null };
          }
          if (type === 'detach') {
            if (f.holdDetach) await new Promise<void>(resolve => { f.releaseDetach = resolve; });
            if (f.detachFailure) throw Error('PRIVATE_DETACH_CAUSE_NEVER_REAL');
            return {};
          }
          if (type === 'poll') return { events: [], pendingRequests: [], connected: true, gap: false };
          if (['page', 'items', 'models'].includes(type)) return { data: [], nextCursor: null };
          return {};
        }
        return null;
      },
    };
  }, { capability, holdStatus });
  await page.goto('/');
  const card = page.locator('.terminal-card[data-id="capability-session"]');
  await expect(card).toBeVisible();
  return card;
}

for (const capability of ['absent', false, 'true', null]) {
  test(`대화 버튼은 미지원 선언 ${JSON.stringify(capability)}에서 숨고 터미널 입력은 유지한다`, async ({ page }) => {
    const card = await fixture(page, capability);
    await expect(card.locator('.context-usage')).toBeEnabled();
    await expect(card.locator('.conversation-toggle')).toBeHidden();
    await card.locator('.xterm-helper-textarea').press('p');
    await expect.poll(() => page.evaluate(() => (window as any).capabilityFixture.calls.some((c: any) => c.command === 'session_write' && c.args.data === 'p'))).toBe(true);
    const passiveCalls = await page.evaluate(() => (window as any).capabilityFixture.calls.filter((c: any) => c.command === 'conversation_request' && c.args.request.type !== 'contextStatus'));
    expect(passiveCalls).toEqual([]);
  });
}

test('대화 버튼은 초기 숨김 뒤 같은 상태 조회의 true 선언에서만 나타난다', async ({ page }) => {
  const card = await fixture(page, true, true);
  await expect.poll(() => page.evaluate(() => (window as any).capabilityFixture.calls.filter((c: any) => c.command === 'conversation_request').length)).toBe(1);
  await expect(card.locator('.conversation-toggle')).toBeHidden();
  await page.evaluate(() => (window as any).capabilityFixture.releaseStatus());
  await expect(card.locator('.conversation-toggle')).toBeVisible();
  await card.locator('.conversation-toggle').click();
  await expect(card.locator('.conversation-input')).toBeEnabled();
  const calls = await page.evaluate(() => (window as any).capabilityFixture.calls.filter((c: any) => c.command === 'conversation_request' && c.args.request.type === 'attach'));
  expect(calls).toHaveLength(1);
});

test('Attach 실패 후 Detach 확인 전에는 입력을 보호하고 성공 뒤 터미널을 복원한다', async ({ page }) => {
  const card = await fixture(page);
  await page.evaluate(() => { const f = (window as any).capabilityFixture; f.attachFailure = true; f.holdDetach = true; });
  await card.locator('.conversation-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).capabilityFixture.calls.filter((c: any) => c.args.request?.type === 'detach').length)).toBe(1);
  await expect(card.locator('.conversation-host')).toBeVisible();
  await card.locator('.xterm-helper-textarea').evaluate((node: HTMLTextAreaElement) => { node.dispatchEvent(new InputEvent('input', { data: 'blocked', inputType: 'insertText', bubbles: true })); });
  expect(await page.evaluate(() => (window as any).capabilityFixture.calls.some((c: any) => c.command === 'session_write'))).toBe(false);
  await page.evaluate(() => (window as any).capabilityFixture.releaseDetach());
  await expect(card.locator('.conversation-host')).toBeHidden();
  await expect(card.locator('.terminal-host')).toBeVisible();
  await expect(card.locator('.conversation-toggle')).toHaveAttribute('aria-pressed', 'false');
  await card.locator('.xterm-helper-textarea').press('r');
  await expect.poll(() => page.evaluate(() => (window as any).capabilityFixture.calls.some((c: any) => c.command === 'session_write' && c.args.data === 'r'))).toBe(true);
  const html = await page.locator('body').evaluate(node => node.outerHTML);
  expect(html).not.toContain('PRIVATE_ATTACH_CAUSE_NEVER_REAL');
});

test('Attach와 Detach가 모두 실패하면 초안과 화면을 보존하며 자동 전송과 터미널 입력을 막는다', async ({ page }) => {
  const card = await fixture(page);
  await card.locator('.conversation-toggle').click();
  await card.locator('.conversation-input').fill('다시 보내면 안 되는 초안');
  await card.locator('.conversation-toggle').click();
  await expect(card.locator('.terminal-host')).toBeVisible();
  await page.evaluate(() => { const f = (window as any).capabilityFixture; f.attachFailure = true; f.detachFailure = true; });
  await card.locator('.conversation-toggle').click();
  await expect(card.locator('.conversation-host')).toBeVisible();
  await expect(card.locator('.terminal-host')).toBeHidden();
  await expect(card.locator('.conversation-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('.conversation-input')).toHaveValue('다시 보내면 안 되는 초안');
  await expect(card.locator('.conversation-input')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).capabilityFixture.calls.filter((c: any) => c.args.request?.type === 'detach').length)).toBe(1);
  const calls = await page.evaluate(() => (window as any).capabilityFixture.calls);
  expect(calls.filter((c: any) => c.command === 'session_write' || c.args.request?.type === 'send')).toEqual([]);
  const html = await page.locator('body').evaluate(node => node.outerHTML);
  expect(html).not.toContain('PRIVATE_ATTACH_CAUSE_NEVER_REAL'); expect(html).not.toContain('PRIVATE_DETACH_CAUSE_NEVER_REAL');
});
