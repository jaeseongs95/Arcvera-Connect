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

    // Remote branding & interactive directory browser modal (FINDING-03)
    await expect(page.locator('.brand-name small')).toHaveText('Remote');
    await expect(page.locator('#exit')).toHaveText('로그아웃');
    await expect(page.locator('#mobile-control-open')).toBeHidden();

    await page.locator('#project-import').click();
    const pathDialog = page.locator('dialog.remote-path-dialog');
    await expect(pathDialog).toBeVisible();
    await pathDialog.locator('.remote-path-cancel-btn').click();

    expect(errors).toEqual([]);
  } finally {
    await remote.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('mobile viewport (390x844) renders dedicated mobile UI with slide-over drawer, horizontal session switcher pills, and single-session focus on mirrored desktop sessions', async ({ page }) => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-mobile-e2e-'));
  const desktopDbPath = path.join(tmpRoot, 'workspace.sqlite3');
  const projDir = path.join(tmpRoot, '개발자');
  fs.mkdirSync(projDir, { recursive: true });

  const desktopDb = new DatabaseSync(desktopDbPath);
  desktopDb.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, cwd TEXT, canonical_cwd TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE workspace_layout (id INTEGER PRIMARY KEY, layout TEXT NOT NULL);
    CREATE TABLE session_metadata (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  desktopDb.prepare('INSERT INTO projects (id, cwd, canonical_cwd, name, created_at, favorite) VALUES (?, ?, ?, ?, ?, ?)').run(
    'proj-dev',
    projDir,
    projDir.toLowerCase(),
    '개발자',
    1700000000,
    1,
  );
  desktopDb.prepare('INSERT INTO workspace_layout (id, layout) VALUES (1, ?)').run(
    JSON.stringify({
      version: 1,
      columns: 2,
      columnSizes: [1, 1],
      rowSizes: [1, 1],
      sessions: [
        { id: 'sess-desktop', name: 'desktop 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-desktop-1', runtimeKind: 'codex' },
        { id: 'sess-cli', name: 'CLI 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-cli-1', runtimeKind: 'codex' },
      ],
    }),
  );
  desktopDb.prepare('INSERT INTO session_metadata (id, generation, metadata, updated_at) VALUES (?, 1, ?, 1700000100)').run(
    'sess-desktop',
    JSON.stringify({ id: 'sess-desktop', name: 'desktop 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-desktop-1', runtimeKind: 'codex' }),
  );
  desktopDb.prepare('INSERT INTO session_metadata (id, generation, metadata, updated_at) VALUES (?, 1, ?, 1700000100)').run(
    'sess-cli',
    JSON.stringify({ id: 'sess-cli', name: 'CLI 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-cli-1', runtimeKind: 'codex' }),
  );
  desktopDb.close();

  const remote = createRemoteServer({
    workspaceDir: path.join(tmpRoot, 'workspace'),
    desktopDbPath,
    token: 'mobile-secret-token',
    allowPathDiscovery: false,
  });

  await new Promise<void>(resolve => remote.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = remote.server.address() as { port: number };
  const apiOrigin = `http://127.0.0.1:${addr.port}`;

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${apiOrigin}/?token=mobile-secret-token`);
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');

    // No horizontal overflow on mobile (min-width: 800px removed)
    const bodyWidth = await page.evaluate(() => document.body.clientWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);

    // Hamburger menu toggle is visible on mobile and opens the slide-over sidebar drawer
    const menuBtn = page.locator('#mobile-menu-toggle');
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    await expect(page.locator('.sidebar')).toHaveClass(/mobile-open/);
    await expect(page.locator('#projects')).toContainText('개발자');

    // Close drawer via exposed right area of backdrop
    await page.locator('#mobile-drawer-backdrop').click({ position: { x: 340, y: 200 } });
    await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);

    // Mobile session bar displays both mirrored sessions and single-session focus renders 1 visible card at a time
    const sessionBar = page.locator('#mobile-session-bar');
    await expect(sessionBar).toBeVisible();
    await expect(sessionBar.locator('.mobile-session-pill')).toHaveCount(2);
    await expect(page.locator('.terminal-card:visible')).toHaveCount(1);
    await expect(page.locator('.terminal-card:visible .terminal-title')).toHaveText('desktop 담당');

    // Tapping the second pill switches the full-screen card to CLI 담당
    await sessionBar.locator('.mobile-session-pill', { hasText: 'CLI 담당' }).click();
    await expect(page.locator('.terminal-card:visible')).toHaveCount(1);
    await expect(page.locator('.terminal-card:visible .terminal-title')).toHaveText('CLI 담당');
  } finally {
    await remote.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
