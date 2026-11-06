import { expect, test, type Page } from '@playwright/test';

// SAVE-01..10 plan: docs/saved-cron-test-cases.md. IPC is synthetic; real persistence
// and reservation invariants are exercised by saved_cron.rs/session_saved_cron.rs tests.
async function fixture(page: Page, options: { active?: boolean; supported?: boolean } = {}) {
  await page.goto('/');
  await page.clock.install({ time: new Date('2030-01-02T03:04:05Z') });
  await page.evaluate(async options => {
    const state = window as any; const { createCronManager } = await import('/src/cron-manager.ts');
    document.querySelector('#cron-dialog')?.remove();
    const f = state.savedCronFixture = {
      session: { id: 'session-a', generation: 1, threadId: 'thread-a', title: '저장 예약 대화', active: options.active ?? true },
      saved: [] as any[], calls: [] as any[], reply: 'applied', failSave: false, failRegister: false,
      hold: false, release: () => {},
      runtime: { supported: options.supported ?? true, connected: true, scope: 'cliLifetime', hasMore: false, jobs: [] as any[] },
    };
    state.newSavedCronManager = () => createCronManager({
      async call(command: string, args: any) {
        f.calls.push(structuredClone({ command, args }));
        if (command === 'saved_cron_list') return structuredClone(f.saved.filter(item => item.threadId === args.threadId));
        if (command === 'saved_cron_save') {
          if (f.failSave) throw Error('SYNTHETIC_SAVE_FAILURE');
          const previous = f.saved.find(item => item.id === args.id);
          if (previous?.registration) throw Error('registered definition');
          const item = { ...args, id: args.id ?? crypto.randomUUID(), registration: null };
          if (previous) f.saved[f.saved.indexOf(previous)] = item; else f.saved.push(item);
          return structuredClone(item);
        }
        if (command === 'saved_cron_delete') { f.saved = f.saved.filter(item => item.id !== args.id); return; }
        if (command === 'saved_cron_register') {
          const item = f.saved.find(item => item.id === args.definitionId);
          if (item.threadId !== f.session.threadId || args.threadId !== item.threadId || item.registration) throw Error('wrong target or duplicate');
          item.registration = { sessionId: args.id, generation: args.generation, requestId: crypto.randomUUID(), jobId: '7', state: 'pending' };
          if (f.hold) { f.hold = false; await new Promise<void>(resolve => { f.release = resolve; }); }
          if (f.failRegister) { item.registration.state = 'unknown'; throw Error('SYNTHETIC_TIMEOUT'); }
          item.registration = f.reply === 'notApplied' || f.reply === 'unsupported' ? null : { ...item.registration, state: f.reply === 'applied' ? 'registered' : 'unknown' };
          return { status: f.reply };
        }
        if (command === 'cron_request') return structuredClone(f.runtime);
        throw Error('unexpected command');
      }, notify() {},
    });
    state.savedCronManager = state.newSavedCronManager(); await state.savedCronManager.open(f.session);
  }, options);
}
async function waitIdle(page: Page) { await expect(page.locator('#cron-dialog')).toHaveAttribute('aria-busy', 'false'); }
async function registers(page: Page) { return page.evaluate(() => (window as any).savedCronFixture.calls.filter((call: any) => call.command === 'saved_cron_register')); }
async function save(page: Page, prompt = '  전체 작업\n🐈 둘째 줄  ') {
  await page.locator('.cron-prompt').fill(prompt); await page.locator('.cron-save').click(); await waitIdle(page);
}

test('종료된 CLI에서도 전체 정의를 저장하고 새 manager에서 복원하며 자동 등록하지 않는다', async ({ page }) => {
  await fixture(page, { active: false }); await save(page);
  await expect(page.locator('.cron-saved-job')).toHaveCount(1);
  expect(await registers(page)).toEqual([]);
  await page.locator('.cron-close').click();
  await page.evaluate(async () => {
    const state = window as any; await state.savedCronManager.beginExit(); document.querySelector('#cron-dialog')?.remove();
    state.savedCronManager = state.newSavedCronManager(); await state.savedCronManager.open(state.savedCronFixture.session);
  });
  await page.getByRole('button', { name: '원문·일정 편집', exact: true }).click();
  await expect(page.locator('.cron-prompt')).toHaveValue('  전체 작업\n🐈 둘째 줄  ');
  await expect(page.locator('.cron-add')).toBeDisabled();
  expect(await registers(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).savedCronFixture.calls.some((c: any) => c.command === 'cron_request'))).toBe(false);
});

test('미지원 CLI에서도 정의를 관리하며 저장 삭제는 runtime remove를 보내지 않는다', async ({ page }) => {
  await fixture(page, { supported: false }); await save(page);
  await expect(page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '저장 정의 삭제', exact: true }).click(); await waitIdle(page);
  await expect(page.locator('.cron-saved-job')).toHaveCount(0);
  expect(await registers(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).savedCronFixture.calls.filter((c: any) => c.command === 'cron_request').every((c: any) => c.args.request.type === 'list'))).toBe(true);
});

test('저장 후 명시적 등록은 한 번만 수행하고 창 재개방 뒤 같은 정의를 재등록하지 않는다', async ({ page }) => {
  await fixture(page); await save(page);
  await page.evaluate(() => { (window as any).savedCronFixture.hold = true; });
  const register = page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true });
  await register.click(); await expect(register).toBeDisabled();
  await register.evaluate((button: HTMLButtonElement) => button.click());
  expect(await registers(page)).toHaveLength(1);
  await page.evaluate(() => (window as any).savedCronFixture.release()); await waitIdle(page);
  await page.locator('.cron-close').click();
  await page.evaluate(async () => { const state = window as any; await state.savedCronManager.open(state.savedCronFixture.session); });
  await expect(register).toBeDisabled();
  expect((await registers(page))[0].args).toEqual({ id: 'session-a', generation: 1, definitionId: expect.any(String), threadId: 'thread-a' });
  await page.getByRole('button', { name: '저장 정의 삭제', exact: true }).click(); await waitIdle(page);
  expect(await page.evaluate(() => (window as any).savedCronFixture.calls.some((c: any) => c.args.request?.type === 'remove'))).toBe(false);
});

test('저장 실패는 등록 무전송이고 timeout은 저장 정의와 중복 차단을 유지한다', async ({ page }) => {
  await fixture(page); await page.locator('.cron-prompt').fill('보존할 원문');
  await page.evaluate(() => { (window as any).savedCronFixture.failSave = true; });
  await page.locator('.cron-add').click(); await waitIdle(page);
  expect(await registers(page)).toEqual([]); await expect(page.locator('.cron-prompt')).toHaveValue('보존할 원문');
  await page.evaluate(() => { Object.assign((window as any).savedCronFixture, { failSave: false, failRegister: true }); });
  await page.locator('.cron-add').click(); await waitIdle(page);
  await expect(page.locator('.cron-saved')).toContainText('결과 미확인');
  await expect(page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true })).toBeDisabled();
  await page.clock.fastForward(20_001); await waitIdle(page);
  expect(await registers(page)).toHaveLength(1);
  expect(await page.locator('#cron-dialog').textContent()).not.toContain('SYNTHETIC_TIMEOUT');
});

test('다른 대화에는 정의가 나타나지 않고 같은 대화의 새 CLI에서는 수동 등록한다', async ({ page }) => {
  await fixture(page); await save(page);
  await page.locator('.cron-close').click();
  await page.evaluate(async () => { const state = window as any; state.savedCronFixture.session = { ...state.savedCronFixture.session, id: 'session-b', generation: 2, threadId: 'thread-b' }; await state.savedCronManager.open(state.savedCronFixture.session); });
  await expect(page.locator('.cron-saved-job')).toHaveCount(0); expect(await registers(page)).toEqual([]);
  await page.locator('.cron-close').click();
  await page.evaluate(async () => { const state = window as any; state.savedCronFixture.session.threadId = 'thread-a'; await state.savedCronManager.open(state.savedCronFixture.session); });
  await page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true }).click(); await waitIdle(page);
  expect((await registers(page))[0].args).toMatchObject({ id: 'session-b', generation: 2, threadId: 'thread-a' });
});

test('이전 팝업의 늦은 실제 close 이벤트는 새 CLI 팝업의 세션과 저장 정의를 지우지 않는다', async ({ page }) => {
  await fixture(page); await save(page);
  await page.evaluate(async () => {
    const state = window as any; const dialog = document.querySelector('#cron-dialog') as HTMLDialogElement;
    // open closes an already-open dialog and immediately reopens it. Wait for
    // that actual queued close event so the failing order is deterministic.
    const previousClose = new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), { once: true }));
    state.savedCronFixture.session = { ...state.savedCronFixture.session, id: 'session-restarted', generation: 3, title: '다시 시작한 예약 대화' };
    await state.savedCronManager.open(state.savedCronFixture.session);
    await previousClose;
  });
  await expect(page.locator('#cron-dialog')).toBeVisible();
  await expect(page.locator('.cron-session')).toHaveText('세션: 다시 시작한 예약 대화');
  await expect(page.locator('.cron-saved-job')).toHaveCount(1);
  await expect(page.locator('.cron-prompt')).toBeEnabled();
  expect(await registers(page)).toEqual([]);
  await page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true }).click(); await waitIdle(page);
  expect(await registers(page)).toHaveLength(1);
  expect((await registers(page))[0].args).toMatchObject({ id: 'session-restarted', generation: 3, threadId: 'thread-a' });
  await page.evaluate(async () => {
    const dialog = document.querySelector('#cron-dialog') as HTMLDialogElement;
    const closed = new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), { once: true }));
    dialog.close(); await closed;
  });
  await expect(page.locator('.cron-session')).toHaveText('');
  await expect(page.locator('.cron-saved-job')).toHaveCount(0);
});

test('만료된 단발 정의는 새 시각으로 같은 정의를 수정할 때까지 등록하지 않는다', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).savedCronFixture; f.saved = [{ id: 'expired', threadId: 'thread-a', prompt: '일시 작업 원문', schedule: { type: 'at', atUnixMs: 1 }, registration: null }]; });
  await page.locator('.cron-refresh').click(); await waitIdle(page);
  await expect(page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '새 실행 시각 지정', exact: true }).click();
  await page.locator('.cron-time').fill('2031-01-02T12:34:56');
  await page.locator('.cron-save').click(); await waitIdle(page);
  await expect(page.locator('.cron-saved-job')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '이 CLI에 수동 등록', exact: true })).toBeEnabled();
  expect(await registers(page)).toEqual([]);
});
