import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteServer } from '../server/remote-server.mjs';

test('remote browser bridge renders REMOTE WORKSPACE and bridges project, session, terminal SSE, and conversation RPCs', async ({ page }) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-e2e-'));
  const projDir = path.join(tmpRoot, 'remote-alpha');
  fs.mkdirSync(projDir, { recursive: true });

  const remote = createRemoteServer({
    workspaceDir: path.join(tmpRoot, 'workspace'),
    token: 'e2e-secret-token',
    allowPathDiscovery: false,
    rpcTransport: async (method: string, params: any) => {
      if (method === 'initialize') {
        return {
          userAgent: 'codex-app-server/e2e',
          opendiyCapabilities: {
            passiveSubscription: true,
            userTurnStartIfIdle: true,
            compactStartIfIdle: true,
            historySummary: true,
          },
          supportsSubagentManagement: true,
          supportsExpectedTurnInterrupt: true,
        };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'e2e-thread-1', cwd: params.cwd } };
      }
      if (method === 'model/list') {
        return { data: [], nextCursor: null };
      }
      return {};
    },
  });

  await new Promise<void>(resolve => remote.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = remote.server.address() as { port: number };
  const apiOrigin = `http://127.0.0.1:${addr.port}`;

  try {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(`${apiOrigin}/?token=e2e-secret-token`);
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#mode-label')).toHaveText('원격 작업 공간');

    await page.locator('#new-session').click();
    await page.getByLabel('세션 이름', { exact: true }).fill('원격 브라우저 세션');
    await page.getByLabel('프로젝트 경로', { exact: true }).fill(projDir);
    await page.getByRole('button', { name: '세션 시작 →', exact: true }).click();

    const card = page.locator('.terminal-card').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.terminal-title')).toHaveText('원격 브라우저 세션');
    await expect(card.locator('.xterm-rows')).toContainText('원격 브라우저 세션');
    await expect(card.locator('.conversation-toggle')).toBeVisible();
    await expect(card.locator('.subagents-open')).toBeVisible();

    await card.locator('.conversation-toggle').click();
    await expect(card.locator('.conversation-host')).toBeVisible();
    await expect(card.locator('.conversation-status')).toContainText('연결됨');

    expect(errors).toEqual([]);
  } finally {
    await remote.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
