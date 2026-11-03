import { test, expect, type Page } from '@playwright/test';

// Exercise the application-level preparation/restore/exit boundary, independently
// of the transition component. No native process or shared server is started.
async function failedStartup(page: Page, result: 'updated' | 'unknown' | 'malformed' | 'wrongStatus', confirmTransition = true) {
  await page.addInitScript(result => {
    const state = window as any; state.isTauri = true;
    let callback = 0;
    const fixture = state.pairStartup = { calls: [] as string[], release: () => {}, preparations: 0 };
    state.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback() {},
      async invoke(command: string, args: any = {}) {
        fixture.calls.push(command);
        if (command.startsWith('plugin:event|')) return callback;
        if (command === 'get_ui_language') return 'ko';
        if (command === 'list_projects' || command === 'list_sessions') return [];
        if (command === 'load_layout') return { version: 1, columns: 2, sessions: [{ title: '보존할 작업', cwd: 'D:\\fixture', threadId: 'saved-thread', resumeOnStartup: true }] };
        if (command === 'get_codex_settings') return {
          savedPath: null, resolvedPath: 'D:\\fixture\\bin\\codex.exe', source: 'path', error: null,
          appServer: { savedPath: null, resolvedPath: 'D:\\fixture\\bin\\codex-app-server.exe', source: 'sibling', kind: 'standalone', error: null },
        };
        if (command === 'prepare_runtime') { if (++fixture.preparations === 1) throw 'CLI와 공유 서버 버전이 다릅니다'; return null; }
        if (command === 'runtime_transition_preview') return {
          pair: { cliVersion: 'R33', selectedServerExecutable: 'D:\\fixture\\bin\\codex-app-server.exe', selectedServerVersion: 'R33', managedCliExecutable: 'D:\\managed\\codex.exe', managedVersion: 'R28', runningVersion: 'R28', socketPath: 'D:\\fixture.sock', state: 'mismatch', message: null },
          canApply: true, fingerprint: 'confirmed-pair', reason: null, packageRoot: 'D:\\fixture',
        };
        if (command === 'apply_runtime_transition') {
          if (!args.confirmed || args.fingerprint !== 'confirmed-pair') throw 'Unconfirmed transition';
          await new Promise<void>(resolve => { fixture.release = resolve; });
          if (result === 'malformed') return { success: true, outcome: 'updated' };
          if (result === 'wrongStatus') return { status: 'shutdownTimedOut', success: true, outcome: 'updated', message: null };
          return { status: result === 'updated' ? 'updated' : 'shutdownOutcomeUnknown', success: result === 'updated', outcome: result, message: null };
        }
        if (command === 'start_session') return { ...args.request, id: 'restored', generation: 1, state: 'idle', active: true };
        return null;
      },
    };
  }, result);
  await page.goto('/');
  await expect(page.locator('#runtime-banner')).toContainText('CLI와 공유 서버 버전이 다릅니다');
  await expect(page.locator('#runtime-settings')).toHaveText('서버 확인·복구');
  await page.locator('#runtime-settings').click();
  await expect(page.locator('.transition-details dd')).toHaveText(['R33', 'D:\\fixture\\bin\\codex-app-server.exe', 'R33', 'D:\\managed\\codex.exe', 'R28', 'R28']);
  expect(await count(page, 'runtime_transition_preview')).toBe(1);
  expect(await count(page, 'apply_runtime_transition')).toBe(0);
  if (!confirmTransition) return;
  await page.locator('.transition-align').click();
  await page.locator('.transition-acknowledge').check();
  await page.locator('.transition-apply').click();
  await expect.poll(() => count(page, 'apply_runtime_transition')).toBe(1);
}

const count = (page: Page, command: string) => page.evaluate(command => (window as any).pairStartup.calls.filter((item: string) => item === command).length, command);

test('시작 실패 복구 진입은 버전을 한 번 조회하고 작업 종료 확인 전에는 전환하지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 540 });
  await failedStartup(page, 'updated', false);
  await expect(page.locator('#runtime-transition-title')).toBeInViewport();
  await expect(page.locator('.transition-align')).toBeVisible();
  await page.locator('.transition-align').click();
  await expect(page.locator('.transition-apply')).toBeDisabled();
  await page.locator('.transition-apply').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await count(page, 'apply_runtime_transition')).toBe(0);
  await page.locator('.transition-acknowledge').check();
  expect(await count(page, 'apply_runtime_transition')).toBe(0);
  await page.locator('.transition-apply').click();
  await expect.poll(() => count(page, 'apply_runtime_transition')).toBe(1);
  expect(await count(page, 'runtime_transition_preview')).toBe(1);
  await page.evaluate(() => (window as any).pairStartup.release());
});

test('버전 불일치에서 확인된 전환 완료 뒤에만 공유 서버를 다시 준비하고 저장 작업을 복원한다', async ({ page }) => {
  await failedStartup(page, 'updated');
  expect(await count(page, 'prepare_runtime')).toBe(1);
  expect(await count(page, 'start_session')).toBe(0);
  await page.evaluate(() => (window as any).pairStartup.release());
  await expect(page.locator('.terminal-title')).toHaveText('보존할 작업');
  expect(await count(page, 'prepare_runtime')).toBe(2);
  expect(await count(page, 'start_session')).toBe(1);
});

test('전환 결과 불명은 자동 준비·복원을 막으며 명시 재시도만 준비를 다시 시작한다', async ({ page }) => {
  await failedStartup(page, 'unknown');
  await page.evaluate(() => (window as any).pairStartup.release());
  await expect(page.locator('.transition-status')).toContainText('미확인');
  await page.locator('#codex-settings-close').click();
  expect(await count(page, 'prepare_runtime')).toBe(1);
  expect(await count(page, 'start_session')).toBe(0);
  await page.locator('#runtime-retry').click();
  await expect(page.locator('.terminal-title')).toHaveText('보존할 작업');
  expect(await count(page, 'apply_runtime_transition')).toBe(1);
  expect(await count(page, 'prepare_runtime')).toBe(2);
});

test('전환 중 종료는 요청 정산을 기다리고 늦은 성공으로 세션을 복원하지 않는다', async ({ page }) => {
  await failedStartup(page, 'updated');
  await page.locator('#codex-settings-close').click();
  await page.locator('#exit').click(); await page.locator('#confirm-exit').click();
  expect(await count(page, 'complete_exit')).toBe(0);
  await page.evaluate(() => (window as any).pairStartup.release());
  await expect.poll(() => count(page, 'complete_exit')).toBe(1);
  expect(await count(page, 'prepare_runtime')).toBe(1);
  expect(await count(page, 'start_session')).toBe(0);
});

for (const result of ['malformed', 'wrongStatus'] as const) test(`불완전하거나 모순된 성공 응답 ${result}은 앱 복원을 열지 않는다`, async ({ page }) => {
  await failedStartup(page, result);
  await page.evaluate(() => (window as any).pairStartup.release());
  await expect(page.locator('.transition-status')).toContainText('미확인');
  await page.locator('#codex-settings-close').click();
  expect(await count(page, 'prepare_runtime')).toBe(1);
  expect(await count(page, 'start_session')).toBe(0);
});
