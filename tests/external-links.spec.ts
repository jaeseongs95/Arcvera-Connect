import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

async function setup(page: Page) {
  await page.addInitScript(() => {
    const state = window as any;
    state.externalTest = { calls: [], errors: [], fail: false, providerDisposals: 0 };
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command !== 'open_external_url') throw Error(`Unexpected command ${command}`);
      state.externalTest.calls.push(args.url);
      if (state.externalTest.fail) throw Error('NATIVE_BROWSER_LAUNCH_FAILED');
    } };
  });
  await page.goto('/?demo');
  await page.evaluate(async () => {
    const { appendLinkifiedText, openExternalUrl, installTerminalExternalLinks } = await import('/src/external-links.ts');
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const state = (window as any).externalTest;
    const host = document.createElement('section'); host.id = 'external-fixture';
    host.style.cssText = 'position:fixed;inset:10px;z-index:99999;background:#141820;color:white;padding:20px;'; document.body.append(host);
    state.append = (text: string) => { const node = document.createElement('p'); host.append(node); appendLinkifiedText(node, text, (error: Error) => state.errors.push(error.message)); return node; };
    state.open = openExternalUrl;
    const terminalHost = document.createElement('div'); terminalHost.id = 'external-terminal'; host.append(terminalHost);
    const terminal = state.terminal = new Terminal({ cols: 40, rows: 12, fontSize: 16, fontFamily: 'Consolas, monospace', allowProposedApi: false });
    terminal.open(terminalHost);
    const register = terminal.registerLinkProvider.bind(terminal);
    terminal.registerLinkProvider = (provider: any) => { state.provider = provider; const registration = register(provider); return { dispose() { state.providerDisposals++; registration.dispose(); } }; };
    state.links = installTerminalExternalLinks(terminal, (error: Error) => state.errors.push(error.message));
    state.write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
    state.atLine = (y: number) => new Promise<any[]>(resolve => state.provider.provideLinks(y, resolve));
  });
}

async function cellClick(page: Page, x: number, y: number) {
  const screen = page.locator('#external-terminal .xterm-screen');
  const rect = (await screen.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 40 * (x - 0.5), rect.y + rect.height / 12 * (y - 0.5));
  await page.mouse.click(rect.x + rect.width / 40 * (x - 0.5), rect.y + rect.height / 12 * (y - 0.5));
}

test('EL-01/04/09 본문·radio 링크는 명시 pointer/keyboard 활성화만 native로 보내고 원문을 보존한다', async ({ page }) => {
  await setup(page);
  const text = 'forum https://community.openai.com/c/codex/37). https://예시.한국/경로?q=한글&b=2#부분 https://example.com/a_(b). <img src=x onerror=alert(1)>';
  await page.evaluate(text => {
    const state = (window as any).externalTest; const node = state.append(text); node.id = 'body-links';
    const label = document.createElement('label'); const radio = document.createElement('input'); radio.type = 'radio'; radio.id = 'link-radio'; label.append(radio);
    const form = document.createElement('form'); form.onsubmit = () => { throw Error('Unexpected submit'); }; form.append(label); document.querySelector('#external-fixture')!.append(form);
  }, text);
  await page.evaluate(async () => { const { appendLinkifiedText } = await import('/src/external-links.ts'); appendLinkifiedText(document.querySelector('#link-radio')!.parentElement!, 'https://example.com/radio'); });
  const body = page.locator('#body-links');
  await expect(body).toHaveText(text);
  await expect(body.locator('a')).toHaveCount(3);
  await body.locator('a').first().hover();
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual([]);
  await body.locator('a').first().click();
  await body.locator('a').nth(1).focus(); await page.keyboard.press('Enter');
  await body.locator('a').nth(2).click();
  await page.locator('#external-fixture label a').click();
  await expect(page.locator('#link-radio')).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual([
    'https://community.openai.com/c/codex/37', new URL('https://예시.한국/경로?q=한글&b=2#부분').href,
    'https://example.com/a_(b)', 'https://example.com/radio',
  ]);
  await expect(page).toHaveURL(/\/?\?demo$/);
  await expect(body.locator('img')).toHaveCount(0);
});

test('EL-05/06 공개 opener는 위험 URL을 거절하고 native 실패를 callback에 전달한다', async ({ page }) => {
  await setup(page);
  const rejected = await page.evaluate(async () => {
    const state = (window as any).externalTest; const rejected: string[] = [];
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows', 'data:text/html,x', 'mailto:a@example.com', ' https://example.com', 'https://example.com\n', 'https://example.com/%00', 'https://example.com/%0a', 'https://example.com/%7F', 'https://example.com/%c2%9f', 'https://example.com\\path', 'https:///path', 'https://?q=a', 'https://', 'https://[invalid', 'https://example.com:99999/']) {
      try { await state.open(url); } catch { rejected.push(url); }
    }
    return rejected.length;
  });
  expect(rejected).toBe(16);
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual([]);
  await page.evaluate(() => { const state = (window as any).externalTest; state.fail = true; state.append('https://example.com/failure'); });
  await page.locator('#external-fixture p a').click();
  await expect.poll(() => page.evaluate(() => (window as any).externalTest.errors)).toEqual(['NATIVE_BROWSER_LAUNCH_FAILED']);
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual(['https://example.com/failure']);
});

test('EL-03/04 xterm 일반 URL은 wide/surrogate 셀과 wrapped 줄 모두 정확한 URL을 클릭한다', async ({ page }) => {
  await setup(page);
  const url = 'https://example.com/경로/long-path?a=1&b=한글#part';
  const range = await page.evaluate(async url => {
    const state = (window as any).externalTest;
    await state.write(`한글 😀 (${url}).\r\n`);
    const first = await state.atLine(1); const second = await state.atLine(2);
    return { first: first.map((l: any) => ({ text: l.text, range: l.range })), second: second.map((l: any) => l.text) };
  }, url);
  expect(range.first).toHaveLength(1); expect(range.second).toEqual([url]);
  // xterm's default Unicode 6 provider gives this emoji one cell; CJK use two.
  expect(range.first[0].text).toBe(url); expect(range.first[0].range.start).toEqual({ x: 9, y: 1 });
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual([]);
  await cellClick(page, 16, 1); await cellClick(page, 4, 2);
  await expect.poll(() => page.evaluate(() => (window as any).externalTest.calls)).toEqual([new URL(url).href, new URL(url).href]);
  await expect(page.locator('#external-terminal .xterm')).toHaveAttribute('title', url);
});

test('EL-02/05/06/07 OSC8 uses the shared opener, reports failure, and disposes stale callbacks', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const state = (window as any).externalTest;
    await state.write('\u001b]8;;https://community.openai.com/c/codex/37\u0007Community forum\u001b]8;;\u0007\r\n');
  });
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual([]);
  await cellClick(page, 4, 1);
  await expect.poll(() => page.evaluate(() => (window as any).externalTest.calls)).toEqual(['https://community.openai.com/c/codex/37']);
  await page.evaluate(() => { (window as any).externalTest.fail = true; });
  await cellClick(page, 7, 1);
  await expect.poll(() => page.evaluate(() => (window as any).externalTest.errors)).toEqual(['NATIVE_BROWSER_LAUNCH_FAILED']);
  const result = await page.evaluate(async () => {
    const state = (window as any).externalTest; const stale = state.terminal.options.linkHandler;
    const before = state.calls.length;
    stale.activate(new MouseEvent('click'), 'javascript:alert(1)');
    await new Promise(resolve => queueMicrotask(resolve));
    const rejected = state.calls.length === before;
    state.links.dispose(); state.links.dispose();
    stale.activate(new MouseEvent('click'), 'https://example.com/stale');
    const afterDispose = await state.atLine(1);
    return { rejected, before, after: state.calls.length, disposals: state.providerDisposals, afterDispose, handler: state.terminal.options.linkHandler ?? null };
  });
  expect(result).toEqual({ rejected: true, before: 2, after: 2, disposals: 1, afterDispose: undefined, handler: null });
  expect(await page.context().pages()).toHaveLength(1);
});

test('EL-08 실제 대화 렌더러는 본문 링크 검색·native 클릭과 코드 원문·복사를 보존한다', async ({ page, context }) => {
  await setup(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const { createConversation } = await import('/src/conversation.ts');
    const state = (window as any).externalTest;
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async text => { state.copiedText = text; await writeText(text); };
    const host = document.createElement('div'); host.id = 'external-conversation';
    document.querySelector('#external-fixture')!.replaceChildren(host);
    const text = '본문 https://example.com/searchable?x=1&y=2\n```text\nhttps://example.com/code\n<img src=x onerror="window.injected=true">\n```';
    state.conversation = createConversation({ sessionId: 'external-conversation', generation: 1, host,
      onLinkError(error: Error) { state.errors.push(error.message); },
      async call(_command: string, args: any) {
        switch (args.request.type) {
          case 'attach': return { threadId: 'external-thread', owner: 'gui', activeTurnKnown: true, activeTurnId: null };
          case 'page': return { data: [{ id: 'external-turn', status: 'completed' }], nextCursor: null };
          case 'items': return { data: [{ turnId: 'external-turn', item: { id: 'external-message', type: 'agentMessage', text } }], nextCursor: null };
          case 'models': return { data: [], nextCursor: null };
          case 'poll': return { events: [], pendingRequests: [{ seq: 1, requestId: 'external-question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'link-answer', question: '질문 https://example.com/question', options: [{ label: 'https://example.com/choice', description: '설명 https://example.com/description' }] }] } }], connected: true, gap: false };
          case 'detach': return {};
          default: throw Error('Unexpected fixture request');
        }
      },
    });
    await state.conversation.setVisible(true);
  });
  const host = page.locator('#external-conversation'); const body = host.locator('.conversation-content');
  await expect(body.locator('a')).toHaveCount(1);
  await expect(body.locator('code')).toHaveText('https://example.com/code\n<img src=x onerror="window.injected=true">\n');
  await expect(body.locator('code a, img')).toHaveCount(0);
  await host.locator('.conversation-search-input').fill('searchable');
  await expect(host.locator('.conversation-search-result')).toContainText('일치 메시지 1개');
  await body.locator('a').click();
  expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual(['https://example.com/searchable?x=1&y=2']);
  await host.getByRole('button', { name: '코드 복사', exact: true }).click();
  const original = 'https://example.com/code\n<img src=x onerror="window.injected=true">\n';
  expect(await page.evaluate(() => (window as any).externalTest.copiedText)).toBe(original);
  // Windows clipboard readback converts LF to CRLF; the write payload is exact.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(original);
  await test.step('EL-11 구조화 질문·option 링크는 응답과 선택을 바꾸지 않는다', async () => {
    const request = host.locator('.conversation-request');
    await request.locator('label > a').click();
    await request.locator('.conversation-option-links a').first().click();
    await request.locator('.conversation-option-links a').nth(1).click();
    await expect(request.locator('select')).toHaveValue('');
    expect(await page.evaluate(() => (window as any).externalTest.calls)).toEqual(['https://example.com/searchable?x=1&y=2', 'https://example.com/question', 'https://example.com/choice', 'https://example.com/description']);
  });
  await page.evaluate(async () => { await (window as any).externalTest.conversation.dispose({ sessionEnded: true }); });
});

test('EL-12 main terminal-output → pointer → native opener → 실패 toast 제품 경로', async ({ page }) => {
  // Read-only baseline injection keeps red/green isolated from the working tree.
  if (process.env.EXTERNAL_LINK_BASELINE === '1') {
    const original = execFileSync('git', ['show', '22551c6:src/main.ts'], { encoding: 'utf8' });
    await page.route('**/src/main.ts', async route => {
      const response = await route.fetch();
      // Vite transforms imports; remove only the new terminal installation from
      // that response to reproduce the original missing provider/OSC8 handler.
      const current = await response.text();
      const body = current.replace(/const links = installTerminalExternalLinks\([^\n]+\);/g, 'const links = { dispose() {} };');
      if (!original.includes('const terminal = new Terminal(') || body === current) throw Error('Baseline terminal boundary missing');
      await route.fulfill({ response, body });
    });
  }
  await page.addInitScript(() => {
    const state = window as any; state.isTauri = true;
    let callback = 0; const callbacks = new Map<number, (value: any) => void>(); const listeners = new Map<string, (value: any) => void>();
    state.mainLinks = { calls: [], fail: false, output(data: string) { listeners.get('terminal-output')!({ event: 'terminal-output', id: 1, payload: { id: 'link-main', generation: 1, seq: 1, data } }); } };
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    state.__TAURI_INTERNALS__ = {
      transformCallback(handler: (value: any) => void) { callbacks.set(++callback, handler); return callback; }, unregisterCallback() {},
      async invoke(command: string, args: any = {}) {
        if (command === 'plugin:event|listen') { listeners.set(args.event, callbacks.get(args.handler)!); return callback; }
        if (command.startsWith('plugin:event|')) return callback;
        if (command === 'get_ui_language') return 'ko';
        if (command === 'set_ui_language') return { show: 'OpenDIY Desktop 열기', exit: '종료…' };
        if (command === 'load_layout') return { version: 1, columns: 2, sessions: [] };
        if (command === 'list_sessions') return [{ id: 'link-main', title: 'Link terminal', cwd: 'D:\\link-fixture', generation: 1, state: 'idle', active: true }];
        if (command === 'list_projects') return [];
        if (command === 'list_pending_questions') return [];
        if (command === 'open_external_url') { state.mainLinks.calls.push(args.url); if (state.mainLinks.fail) throw Error('NATIVE_BROWSER_LAUNCH_FAILED'); }
        return null;
      },
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  const terminal = page.locator('.terminal-card[data-id="link-main"] .xterm');
  await expect(terminal).toBeVisible();
  await page.evaluate(() => (window as any).mainLinks.output('https://community.openai.com/c/codex/37\r\n'));
  await expect(terminal.locator('.xterm-rows')).toContainText('community.openai.com');
  const row = terminal.locator('.xterm-rows > div').first(); const rect = (await row.boundingBox())!;
  const span = row.locator('span').first(); const spanRect = (await span.boundingBox())!;
  await page.mouse.click(spanRect.x + Math.min(30, spanRect.width / 2), rect.y + rect.height / 2);
  await expect.poll(() => page.evaluate(() => (window as any).mainLinks.calls)).toEqual(['https://community.openai.com/c/codex/37']);
  await page.evaluate(() => { (window as any).mainLinks.fail = true; });
  await page.mouse.click(spanRect.x + Math.min(30, spanRect.width / 2), rect.y + rect.height / 2);
  await expect(page.locator('.toast.error')).toContainText('외부 링크 열기 실패');
  expect(await page.context().pages()).toHaveLength(1);
});

test('EL-13/14 실제 xterm의 wrapped 공백·긴 token 탐색과 좌표 생성은 상한을 지킨다', async ({ page }) => {
  await setup(page);
  const probes = await page.evaluate(async () => {
    const state = (window as any).externalTest; const terminal = state.terminal;
    terminal.options.scrollback = 10000;
    const probe = async (y: number) => {
      const buffer = terminal.buffer.active; const original = buffer.getLine.bind(buffer);
      const metrics = { rows: 0, cells: 0 };
      buffer.getLine = (row: number) => {
        metrics.rows++;
        const line = original(row); if (!line) return line;
        return new Proxy(line, { get(target, key) {
          if (key === 'getCell') return (...args: any[]) => { metrics.cells++; return target.getCell(...args); };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      try { return { y, links: (await state.atLine(y)).map((link: any) => link.text), metrics }; }
      finally { buffer.getLine = original; }
    };
    // Erasing a filled wrapped row leaves zero trimmed characters while keeping
    // its wrap metadata, as terminal applications can do while redrawing output.
    await state.write((' '.repeat(40) + '\u001b[1K').repeat(3000) + 'https://example.com/bounded');
    const blank = await probe(terminal.buffer.active.baseY + terminal.buffer.active.cursorY + 1);
    terminal.reset();
    await state.write((' '.repeat(40) + '\u001b[1K').repeat(6000) + 'https://example.com/bounded');
    const doubledBlank = await probe(terminal.buffer.active.baseY + terminal.buffer.active.cursorY + 1);
    terminal.reset();
    const long = 'https://example.com/' + 'a'.repeat(12000) + 'https://other.example/short';
    await state.write(long + ' https://example.com/nearby');
    const lastY = terminal.buffer.active.baseY + terminal.buffer.active.cursorY + 1;
    const last = await probe(lastY);
    const middle = await probe(Math.floor(lastY / 2));
    terminal.reset();
    const nearbyWrapped = 'https://example.com/' + 'nearby'.repeat(12);
    await state.write(long + ' ' + nearbyWrapped);
    const crossing = await probe(Math.floor((long.length + 1) / 40) + 1);
    return { blank, doubledBlank, last, middle, crossing, nearbyWrapped };
  });
  console.log('EL-13/14 actual xterm probe:', JSON.stringify(probes));
  expect(probes.blank.links).toEqual(['https://example.com/bounded']);
  expect(probes.blank.metrics.cells).toBeLessThanOrEqual(8192);
  expect(probes.blank.metrics.rows).toBeLessThanOrEqual(430);
  expect(probes.doubledBlank.links).toEqual(['https://example.com/bounded']);
  expect(probes.doubledBlank.metrics).toEqual(probes.blank.metrics);
  expect(probes.last.links).toEqual(['https://example.com/nearby']);
  expect(probes.middle.links).toEqual([]);
  expect(probes.crossing.links).toEqual([probes.nearbyWrapped]);
  for (const probe of [probes.last, probes.middle, probes.crossing]) expect(probe.metrics.cells).toBeLessThanOrEqual(8192);
});
