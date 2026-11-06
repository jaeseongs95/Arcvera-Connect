import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, supported = true) {
  await page.goto('/');
  await page.evaluate(async supported => {
    const w = window as any;
    const { createContextControls } = await import('/src/context-controls.ts');
    const host = document.createElement('div'); host.id = 'window-fixture'; host.className = 'context-controls';
    document.body.append(host); const statusHost = document.createElement('span'); document.body.append(statusHost);
    const f = w.windowFixture = { supported, reads: 0, writes: [] as any[], notices: [] as string[], hold: false, release: () => {}, fail: false, holdSettings: false, releaseSettings: () => {}, conflict: false, rejected: false,
      settings: { supported: true, modelContextWindow: null, effectiveContextWindow: 258400, canChange: true }, preparations: 0 };
    w.windowControls = createContextControls({ host, statusHost, sessionId: 'session-a', generation: 11,
      async call(command: string, args: any) {
        if (command !== 'conversation_request' || args.id !== 'session-a' || args.generation !== 11) throw Error('다른 세션 호출');
        switch (args.request.type) {
          case 'contextStatus': f.reads++; return { connected: true, guiConnected: false, tokenUsageFresh: true, tokenUsage: { last: { totalTokens: 1000 }, modelContextWindow: 258400 }, canCompact: false, compacting: false, active: false };
          case 'contextSettings': {
            const result = f.supported ? structuredClone(f.settings) : { supported: false };
            if (f.holdSettings) { f.holdSettings = false; await new Promise<void>(resolve => { f.releaseSettings = resolve; }); }
            return result;
          }
          case 'setContextWindow':
            f.writes.push(structuredClone(args.request));
            if (f.hold) await new Promise<void>(resolve => { f.release = resolve; });
            if (f.fail) throw Error('PRIVATE_NEVER_RENDER');
            if (f.rejected) return { ...f.settings, status: 'rejected' };
            if (f.conflict) return { ...f.settings, modelContextWindow: 200000, status: 'conflict' };
            f.settings.modelContextWindow = args.request.modelContextWindow;
            f.settings.effectiveContextWindow = args.request.modelContextWindow === null ? 258400 : Math.min(258400, Math.floor(args.request.modelContextWindow * .95));
            return { ...f.settings, status: 'applied' };
          default: throw Error('허용하지 않은 호출');
        }
      },
      async prepare() { f.preparations++; }, async compact() { throw Error('압축 호출'); },
      notify(ko: string) { f.notices.push(ko); },
    });
    w.windowControls.setVisible(true);
  }, supported);
  await expect(page.locator('#window-fixture .context-usage')).toBeEnabled();
}

test('아이콘에서 해당 세션만 조절하고 실효값·다음 turn·기본값 복원을 구분한다', async ({ page }) => {
  await fixture(page); await page.locator('#window-fixture .context-usage').click();
  const dialog = page.getByRole('dialog', { name: '세션 컨텍스트 크기' });
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('258,400'); await expect(dialog).toContainText('다음 turn');
  await dialog.getByLabel('요청 컨텍스트 크기 (토큰)').fill('100000'); await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toContainText('95,000');
  expect(await page.evaluate(() => (window as any).windowFixture.writes)).toEqual([{ type: 'setContextWindow', modelContextWindow: 100000, expectedModelContextWindow: null }]);
  await dialog.getByRole('button', { name: '기본값 복원' }).click(); await expect(dialog).toContainText('258,400');
  expect(await page.evaluate(() => (window as any).windowFixture.writes.at(-1))).toEqual({ type: 'setContextWindow', modelContextWindow: null, expectedModelContextWindow: 100000 });
  expect(await page.evaluate(() => (window as any).windowFixture.preparations)).toBe(0);
});

test('공식·미지원 CLI는 조절 UI 없이 사용량을 새로고침한다', async ({ page }) => {
  await fixture(page, false); await page.locator('#window-fixture .context-usage').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).windowFixture.reads)).toBeGreaterThanOrEqual(2);
});

test('잘못된 정수는 전송하지 않고 닫기는 변경하지 않는다', async ({ page }) => {
  await fixture(page); await page.locator('#window-fixture .context-usage').click();
  const dialog = page.getByRole('dialog'); const input = dialog.getByLabel('요청 컨텍스트 크기 (토큰)');
  for (const value of ['', '-1', '0', '1.5', '9007199254740992', 'abc']) {
    await input.fill(value); await dialog.getByRole('button', { name: '적용', exact: true }).click();
    expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(0);
  }
  await dialog.getByRole('button', { name: '닫기' }).click(); await expect(dialog).toHaveCount(0);
});

test('변경 대기 중 중복 요청·닫은 화면의 늦은 결과와 알림을 차단한다', async ({ page }) => {
  await fixture(page); await page.locator('#window-fixture .context-usage').click();
  await page.evaluate(() => { (window as any).windowFixture.hold = true; });
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('요청 컨텍스트 크기 (토큰)').fill('100000');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '기본값 복원' })).toBeDisabled();
  await dialog.getByRole('button', { name: '닫기' }).click();
  await page.evaluate(() => { const w = window as any; w.windowControls.setVisible(false); w.windowControls.setVisible(true); w.windowFixture.release(); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).windowFixture.notices.length)).toBe(0);
});

test('결과 불명은 자동 재전송하지 않고 편집 화면을 닫는다', async ({ page }) => {
  await fixture(page); await page.locator('#window-fixture .context-usage').click();
  await page.evaluate(() => { (window as any).windowFixture.fail = true; });
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('요청 컨텍스트 크기 (토큰)').fill('100000');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).windowFixture.notices.join(' '))).toContain('자동으로 다시');
  expect(await page.locator('body').innerHTML()).not.toContain('PRIVATE_NEVER_RENDER');
});

test('세션 숨김과 폐기 뒤 돌아온 설정 조회로 편집창을 열지 않는다', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).windowFixture.holdSettings = true; });
  await page.locator('#window-fixture .context-usage').click();
  await page.evaluate(() => { const w = window as any; w.windowControls.setVisible(false); w.windowControls.setVisible(true); w.windowFixture.releaseSettings(); });
  await expect(page.locator('#window-fixture .context-usage')).toBeEnabled(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => { (window as any).windowFixture.holdSettings = true; });
  await page.locator('#window-fixture .context-usage').click();
  await page.evaluate(() => { const w = window as any; w.windowControls.dispose(); w.windowFixture.releaseSettings(); });
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(0);
});

test('오래된 편집값은 서버 현재값으로 바꾸고 자동으로 덮어쓰지 않는다', async ({ page }) => {
  await fixture(page); await page.locator('#window-fixture .context-usage').click();
  await page.evaluate(() => { (window as any).windowFixture.conflict = true; });
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('요청 컨텍스트 크기 (토큰)').fill('100000');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toContainText('다른 곳에서 설정이 바뀌어');
  await expect(dialog.getByLabel('요청 컨텍스트 크기 (토큰)')).toHaveValue('200000');
  expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(1);
});

test('누락된 설정·변경 차단·잘못된 숫자는 지원으로 보정하지 않는다', async ({ page }) => {
  await fixture(page);
  for (const settings of [{ supported: true }, { supported: true, canChange: true, modelContextWindow: null },
    { supported: true, canChange: false, modelContextWindow: null, effectiveContextWindow: 1000 },
    { supported: true, canChange: true, modelContextWindow: -1, effectiveContextWindow: 1000 },
    { supported: 'true', canChange: true, modelContextWindow: null, effectiveContextWindow: 1000 }]) {
    await page.evaluate(settings => { (window as any).windowFixture.settings = settings; }, settings);
    await page.locator('#window-fixture .context-usage').click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(0);
});

test('서버의 명시적 크기 거절은 결과 불명과 구분하고 다른 값의 편집을 허용한다', async ({ page }) => {
  await fixture(page); await page.locator('#window-fixture .context-usage').click();
  await page.evaluate(() => { (window as any).windowFixture.rejected = true; });
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('요청 컨텍스트 크기 (토큰)').fill('100000');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toContainText('서버가 요청한 크기를 거절'); await expect(dialog.getByRole('button', { name: '적용', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).windowFixture.notices.length)).toBe(0);
  await page.evaluate(() => { (window as any).windowFixture.rejected = false; });
  await dialog.getByLabel('요청 컨텍스트 크기 (토큰)').fill('90000'); await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toContainText('서버가 적용을 확인');
  expect(await page.evaluate(() => (window as any).windowFixture.writes.length)).toBe(2);
});
