import { test, expect, type Page } from '@playwright/test';

async function settings(page: Page, options: { holdPreview?: boolean; holdApply?: boolean; holdSelection?: boolean; canApply?: boolean; state?: 'matched' | 'mismatch' | 'stopped' | 'embedded' | 'unconfirmed' | 'unavailable'; outcome?: string; success?: boolean; status?: string; rejectApply?: boolean; malformed?: boolean } = {}) {
  await page.addInitScript(options => {
    const state = window as any; state.isTauri = true;
    let callback = 0;
    const fixture = state.transitionFixture = {
      calls: [] as { command: string; args: any }[], releasePreview: () => {}, releaseApply: () => {}, releaseSelection: () => {},
      preview: {
        pair: { cliVersion: 'R33-cli', selectedServerExecutable: 'D:\\runtime\\codex-app-server.exe', selectedServerVersion: 'R33-server', managedCliExecutable: 'D:\\runtime\\codex.exe', managedVersion: 'R28-server', runningVersion: options.state === 'stopped' ? null : 'R28-server', socketPath: 'D:\\fixture\\server.sock', state: options.state ?? 'mismatch', message: null },
        canApply: options.canApply ?? true, reason: options.canApply === false ? '선택한 R32 CLI는 --no-force를 지원하지 않습니다.' : null,
        fingerprint: 'candidate-A', packageRoot: 'D:\\runtime',
      },
      result: { status: options.status ?? 'updated', success: options.success ?? true, outcome: options.outcome ?? 'updated', message: null },
      settings: { savedPath: null, resolvedPath: 'D:\\runtime\\codex.exe', source: 'path', error: null, appServer: { savedPath: null, resolvedPath: 'D:\\runtime\\codex-app-server.exe', source: 'sibling', error: null, kind: 'standalone' } },
    };
    state.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback() {},
      async invoke(command: string, args: any = {}) {
        fixture.calls.push({ command, args });
        if (command.startsWith('plugin:event|')) return callback;
        if (command === 'get_ui_language') return 'ko';
        if (command === 'set_ui_language') return {};
        if (command === 'load_layout') return { version: 1, columns: 2, sessions: [] };
        if (command === 'list_projects' || command === 'list_sessions') return [];
        if (command === 'get_codex_settings') return fixture.settings;
        if (['choose_codex_executable', 'set_codex_executable', 'choose_app_server_executable', 'set_app_server_executable'].includes(command)) {
          if (options.holdSelection) await new Promise<void>(resolve => { fixture.releaseSelection = resolve; });
          fixture.preview.fingerprint += '-new'; fixture.preview.pair.cliVersion = 'new-cli';
          return fixture.settings;
        }
        if (command === 'runtime_transition_preview') {
          const reply = structuredClone(fixture.preview);
          if (options.holdPreview) await new Promise<void>(resolve => { fixture.releasePreview = resolve; });
          return reply;
        }
        if (command === 'apply_runtime_transition') {
          if (options.holdApply) await new Promise<void>(resolve => { fixture.releaseApply = resolve; });
          if (options.rejectApply) throw new Error('연결 응답을 받지 못했습니다');
          if (options.malformed) return { success: true, outcome: 'updated' };
          if (fixture.result.status === 'updated' && fixture.result.success && fixture.result.outcome === 'updated') {
            fixture.preview.pair.managedVersion = fixture.preview.pair.runningVersion = 'R33-server';
            fixture.preview.pair.state = 'matched';
          }
          return fixture.result;
        }
        return null;
      },
    };
  }, options);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#settings-open').click(); await page.locator('#codex-settings-open').click();
}
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).transitionFixture.calls.filter((call: any) => call.command === command), command);
const controls = ['#codex-executable-choose', '#codex-executable-reset', '#app-server-executable-choose', '#app-server-executable-reset', '.transition-preview'];
async function confirm(page: Page) {
  await page.locator('.transition-preview').click();
  await page.locator('.transition-align').click();
  await page.locator('.transition-acknowledge').check();
  await page.locator('.transition-apply').click();
}

test('명시 조회와 작업 종료 확인 전에는 적용하지 않고 확인 후 한 번만 실행한다', async ({ page }, testInfo) => {
  await settings(page, { holdApply: true });
  expect(await calls(page, 'runtime_transition_preview')).toHaveLength(0);
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
  await page.locator('.transition-preview').click();
  await expect(page.locator('.transition-details dd')).toHaveText(['R33-cli', 'D:\\runtime\\codex-app-server.exe', 'R33-server', 'D:\\runtime\\codex.exe', 'R28-server', 'R28-server']);
  await page.locator('.transition-align').click();
  await expect(page.locator('.transition-confirmation')).toBeVisible();
  await expect(page.locator('.transition-warning')).toContainText('선택한 서버가 포함된 전체 패키지를 공유 서버에 적용합니다');
  await expect(page.locator('.transition-warning')).toContainText('관리 CLI 실행 경로는 다를 수 있습니다');
  await expect(page.locator('.transition-warning')).toContainText('취소할 수 없으며');
  await expect(page.locator('.transition-warning')).toContainText('미확인일 수 있습니다');
  await expect(page.locator('.transition-acknowledge-label')).toContainText('모바일');
  await expect(page.locator('.transition-apply')).toBeDisabled();
  await page.locator('.transition-apply').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
  await page.setViewportSize({ width: 800, height: 540 });
  await page.locator('.transition-acknowledge').check();
  await page.locator('.transition-apply').scrollIntoViewIfNeeded();
  await expect(page.locator('.transition-apply')).toBeInViewport();
  const overflow = await page.locator('#codex-settings-dialog').evaluate(node => node.scrollWidth - node.clientWidth);
  expect(overflow).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('runtime-transition-confirm-ko.png'), fullPage: true });
  await page.locator('.transition-apply').click();
  await expect.poll(async () => (await calls(page, 'apply_runtime_transition')).length).toBe(1);
  expect(await calls(page, 'apply_runtime_transition')).toEqual([{ command: 'apply_runtime_transition', args: { confirmed: true, fingerprint: 'candidate-A' } }]);
  for (const selector of controls) await expect(page.locator(selector)).toBeDisabled();
  await page.evaluate(() => {
    for (const selector of ['.transition-apply', '.transition-preview', '#app-server-executable-choose']) document.querySelector<HTMLButtonElement>(selector)!.click();
  });
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(1);
  expect(await calls(page, 'choose_app_server_executable')).toHaveLength(0);
  await page.evaluate(() => (window as any).transitionFixture.releaseApply());
  await expect(page.locator('.transition-status')).toHaveText('서버 전환과 새 버전 연결 검사가 완료되었습니다.');
  await page.locator('.transition-preview').click();
  await expect(page.locator('.transition-details dd').last()).toHaveText('R33-server');
  await expect(page.locator('.transition-align')).toBeHidden();
});

test('R32 안전 전환 미지원과 일치·확인 불가 상태는 실행을 차단한다', async ({ page }) => {
  await settings(page, { canApply: false });
  await page.locator('.transition-preview').click();
  await expect(page.locator('.transition-reason')).toHaveText('선택한 R32 CLI는 --no-force를 지원하지 않습니다.');
  await expect(page.locator('.transition-align')).toBeDisabled();
  for (const state of ['matched', 'unavailable']) {
    await page.evaluate(state => { (window as any).transitionFixture.preview.pair.state = state; }, state);
    await page.locator('.transition-preview').click();
    await expect(page.locator('.transition-align')).toBeHidden();
  }
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
});

for (const options of [
  { success: false, outcome: 'failed' }, { success: false, outcome: 'unknown' },
  { success: false, outcome: 'updated' }, { success: true, outcome: 'unknown' },
  { rejectApply: true }, { malformed: true }, { status: 'shutdownOutcomeUnknown' },
]) {
  test(`실패·결과 불명·불완전 응답은 성공으로 표시하거나 자동 재시도하지 않는다 ${JSON.stringify(options)}`, async ({ page }) => {
    await settings(page, options);
    await confirm(page);
    await expect(page.locator('.transition-status')).toContainText('미확인');
    await expect(page.locator('.transition-status')).not.toContainText('완료되었습니다');
    await expect(page.locator('.transition-details dd').last()).toHaveText('미확인');
    await expect(page.locator('.transition-preview')).toBeEnabled();
    expect(await calls(page, 'apply_runtime_transition')).toHaveLength(1);
    expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
    await page.locator('.transition-preview').click();
    await expect(page.locator('.transition-details dd').last()).toHaveText('R28-server');
    expect(await calls(page, 'apply_runtime_transition')).toHaveLength(1);
  });
}

for (const selector of controls.slice(0, 4)) {
  test(`후보 변경 ${selector}은 이전 확인과 fingerprint를 폐기한다`, async ({ page }) => {
    await settings(page);
    await page.locator('.transition-preview').click(); await page.locator('.transition-align').click();
    await page.locator('.transition-acknowledge').check();
    await page.locator(selector).click();
    await expect(page.locator('.transition-confirmation')).toBeHidden();
    await expect(page.locator('.transition-details')).toBeHidden();
    expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
    expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
    await confirm(page);
    await expect.poll(async () => (await calls(page, 'apply_runtime_transition')).length).toBe(1);
    expect((await calls(page, 'apply_runtime_transition'))[0].args).toEqual({ confirmed: true, fingerprint: 'candidate-A-new' });
  });
}

test('닫기와 재열기는 이전 확인을 취소하고 새 조회 전까지 적용하지 않는다', async ({ page }) => {
  await settings(page);
  await page.locator('.transition-preview').click(); await page.locator('.transition-align').click();
  await page.locator('.transition-acknowledge').check();
  await page.locator('#codex-settings-close').click(); await page.locator('#codex-settings-open').click();
  await expect(page.locator('.transition-confirmation')).toBeHidden();
  await expect(page.locator('.transition-details')).toBeHidden();
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
  expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
});

test('조회 중 닫기·재열기와 언어 변경은 오래된 결과를 버리고 중복 조회를 막는다', async ({ page }, testInfo) => {
  await settings(page, { holdPreview: true });
  await page.locator('.transition-preview').click();
  for (const selector of controls) await expect(page.locator(selector)).toBeDisabled();
  await page.locator('#codex-settings-close').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#codex-settings-open').click();
  await expect(page.locator('.transition-preview')).toHaveText('Check server versions');
  await expect(page.locator('.transition-preview')).toBeDisabled();
  expect(await calls(page, 'get_codex_settings')).toHaveLength(1);
  await page.evaluate(() => (window as any).transitionFixture.releasePreview());
  await expect(page.locator('.transition-preview')).toBeEnabled();
  await expect(page.locator('.transition-details')).toBeHidden();
  expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
  await page.locator('.transition-preview').click();
  await page.evaluate(() => (window as any).transitionFixture.releasePreview());
  await page.locator('.transition-align').click();
  await expect(page.locator('.transition-apply')).toBeDisabled();
  await expect(page.locator('.transition-warning')).toContainText('cannot be canceled');
  await expect(page.locator('.transition-acknowledge-label')).toContainText('will not start new work');
  await page.locator('.transition-apply').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('runtime-transition-confirm-en.png'), fullPage: true });
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
});

test('전환 중 닫기·재열기는 요청을 취소하거나 재적용하지 않고 새 조회를 요구한다', async ({ page }) => {
  await settings(page, { holdApply: true });
  await confirm(page);
  await page.locator('#codex-settings-close').click(); await page.locator('#codex-settings-open').click();
  for (const selector of controls) await expect(page.locator(selector)).toBeDisabled();
  expect(await calls(page, 'get_codex_settings')).toHaveLength(1);
  await page.evaluate(() => (window as any).transitionFixture.releaseApply());
  await expect(page.locator('.transition-preview')).toBeEnabled();
  await expect(page.locator('.transition-details')).toBeHidden();
  await expect(page.locator('.transition-status')).not.toContainText('완료되었습니다');
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(1);
  expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
  await page.locator('.transition-preview').click();
  await expect(page.locator('.transition-details dd').last()).toHaveText('R33-server');
});

test('확인 화면의 언어 전환은 동의와 후보를 보존하고 돌아가기는 적용하지 않는다', async ({ page }) => {
  await settings(page);
  await page.locator('.transition-preview').click(); await page.locator('.transition-align').click();
  await page.locator('.transition-acknowledge').check();
  await page.evaluate(() => { const select = document.querySelector<HTMLSelectElement>('#language-select')!; select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.locator('.transition-acknowledge')).toBeChecked();
  await expect(page.locator('.transition-apply')).toHaveText('Confirm and transition server');
  await expect(page.locator('.transition-apply')).toBeEnabled();
  await page.locator('.transition-cancel').click();
  await expect(page.locator('.transition-confirmation')).toBeHidden();
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
  expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
});


test('실행 파일 선택이 진행 중이면 전환 조회를 막고 이전 확인을 즉시 취소한다', async ({ page }) => {
  await settings(page, { holdSelection: true });
  await page.locator('.transition-preview').click(); await page.locator('.transition-align').click();
  await page.locator('.transition-acknowledge').check();
  await page.locator('#app-server-executable-choose').click();
  await expect(page.locator('.transition-confirmation')).toBeHidden();
  await expect(page.locator('.transition-preview')).toBeDisabled();
  await page.locator('.transition-preview').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await calls(page, 'runtime_transition_preview')).toHaveLength(1);
  expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
  await page.evaluate(() => (window as any).transitionFixture.releaseSelection());
  await expect(page.locator('.transition-preview')).toBeEnabled();
  await expect(page.locator('.transition-details')).toBeHidden();
});


for (const canApply of [true, false]) {
  test(`꺼진 서버의 현재 버전을 추정하지 않고 canApply=${canApply} 판정을 따른다`, async ({ page }) => {
    await settings(page, { state: 'stopped', canApply });
    await page.locator('.transition-preview').click();
    await expect(page.locator('.transition-status')).toHaveText('서버가 꺼져 있음');
    await expect(page.locator('.transition-details dd').last()).toHaveText('미확인');
    if (canApply) {
      await expect(page.locator('.transition-align')).toBeEnabled();
      await page.locator('.transition-align').click();
      expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
      await page.locator('.transition-acknowledge').check();
      await page.locator('.transition-apply').click();
      await expect.poll(async () => (await calls(page, 'apply_runtime_transition')).length).toBe(1);
    } else {
      await expect(page.locator('.transition-align')).toBeDisabled();
      expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
    }
  });
}

for (const canApply of [true, false]) {
  test(`연결 미확인 상태는 읽기 성공으로 표시하되 canApply=${canApply}와 무관하게 전환을 차단한다`, async ({ page }) => {
    await settings(page, { state: 'unconfirmed', canApply });
    await page.locator('.transition-preview').click();
    await expect(page.locator('.transition-status')).toHaveText('현재 서버 연결 상태를 확인하지 못했습니다. 서버 버전을 다시 확인하세요.');
    await expect(page.locator('.transition-details dd').first()).toHaveText('R33-cli');
    await expect(page.locator('.transition-align')).toBeHidden();
    await expect(page.locator('.transition-align')).toBeDisabled();
    await page.locator('.transition-align').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await expect(page.locator('.transition-confirmation')).toBeHidden();
    await expect(page.locator('.transition-apply')).toBeDisabled();
    expect(await calls(page, 'apply_runtime_transition')).toHaveLength(0);
  });
}

test('명시적 개별 서버 방식은 공유 서버 전환을 제안하지 않는다', async ({ page }) => {
  await settings(page, { state: 'embedded', canApply: false });
  await page.evaluate(() => {
    const value = (window as any).transitionFixture.preview;
    value.reason = '이 CLI는 내장된 개별 서버를 사용하므로 공유 서버를 전환할 필요가 없습니다.';
    value.pair.managedCliExecutable = value.pair.managedVersion = value.pair.runningVersion = value.pair.socketPath = null;
  });
  await page.locator('.transition-preview').click();
  await expect(page.locator('.transition-status')).toHaveText('이 CLI는 내장된 개별 서버를 사용합니다.');
  await expect(page.locator('.transition-align')).toBeHidden();
  expect(await calls(page, 'apply_runtime_transition')).toEqual([]);
});
