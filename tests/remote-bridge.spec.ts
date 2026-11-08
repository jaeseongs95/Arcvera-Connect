import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteServer, startHostConnector } from '../server/remote-server.mjs';

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

    // BLKR-03: Visible terminal card and host on mobile must have non-zero flex height (>300px on 844px viewport)
    const firstCardBox = await page.locator('.terminal-card:visible').boundingBox();
    const firstHostBox = await page.locator('.terminal-card:visible .terminal-host').boundingBox();
    expect(firstCardBox).not.toBeNull();
    expect(firstHostBox).not.toBeNull();
    expect(firstCardBox!.height).toBeGreaterThan(300);
    expect(firstHostBox!.height).toBeGreaterThan(240);

    // Tapping the second pill switches the full-screen card to CLI 담당 with non-zero height
    await sessionBar.locator('.mobile-session-pill', { hasText: 'CLI 담당' }).click();
    await expect(page.locator('.terminal-card:visible')).toHaveCount(1);
    await expect(page.locator('.terminal-card:visible .terminal-title')).toHaveText('CLI 담당');
    const secondCardBox = await page.locator('.terminal-card:visible').boundingBox();
    expect(secondCardBox).not.toBeNull();
    expect(secondCardBox!.height).toBeGreaterThan(300);
  } finally {
    await remote.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('relay + host connector mode renders mirrored desktop terminal rollout on initial load, survives page reload (F5), and executes interactive terminal input (BLKR-01 & BLKR-02)', async ({ page }) => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-relay-mirror-e2e-'));
  const desktopDbPath = path.join(tmpRoot, 'workspace.sqlite3');
  const codexHomeDir = path.join(tmpRoot, 'codex-home');
  const projDir = path.join(tmpRoot, '개발자');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(codexHomeDir, { recursive: true });

  const rolloutPath = path.join(codexHomeDir, 'rollout-relay-1.jsonl');
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: '중단된 지점부터 이어서 작업해줘.' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', message: '릴레이 미러링 복원 완료했습니다.' },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  const stateDb = new DatabaseSync(path.join(codexHomeDir, 'state_5.sqlite'));
  stateDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model TEXT, reasoning_effort TEXT);');
  stateDb
    .prepare('INSERT INTO threads (id, rollout_path, model, reasoning_effort) VALUES (?, ?, ?, ?)')
    .run('thread-relay-1', rolloutPath, 'gpt-5.4', 'xhigh');
  stateDb.close();

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
      columns: 1,
      columnSizes: [1],
      rowSizes: [1],
      sessions: [
        { id: 'sess-relay-1', name: 'desktop 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-relay-1', runtimeKind: 'codex' },
      ],
    }),
  );
  desktopDb.prepare('INSERT INTO session_metadata (id, generation, metadata, updated_at) VALUES (?, 1, ?, 1700000100)').run(
    'sess-relay-1',
    JSON.stringify({ id: 'sess-relay-1', name: 'desktop 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-relay-1', runtimeKind: 'codex', state: 'running' }),
  );
  desktopDb.close();

  const relay = createRemoteServer({
    mode: 'relay',
    workspaceDir: path.join(tmpRoot, 'relay-workspace'),
    token: 'relay-user-token',
    hostSecret: 'relay-connector-secret',
    allowPathDiscovery: false,
  });
  await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', () => resolve()));
  const relayAddr = relay.server.address() as { port: number };
  const relayOrigin = `http://127.0.0.1:${relayAddr.port}`;

  let rpcNotificationListener: ((msg: any) => void) | null = null;
  const connector = startHostConnector({
    relayUrl: relayOrigin,
    hostSecret: 'relay-connector-secret',
    workspaceDir: path.join(tmpRoot, 'host-workspace'),
    desktopDbPath,
    codexHomeDir,
    allowPathDiscovery: false,
    rpcTransport: Object.assign(
      async (method: string, params: any) => {
        if (method === 'initialize') {
          return {
            userAgent: 'codex-app-server/e2e-relay',
            opendiyCapabilities: {
              passiveSubscription: true,
              userTurnStartIfIdle: true,
              compactStartIfIdle: true,
              historySummary: true,
            },
          };
        }
        if (method === 'thread/read' && params?.includeTurns === true) {
          throw new Error('thread/read with includeTurns: true must not block mirrored rollout history');
        }
        if (method === 'thread/resume') {
          return { thread: { id: params.threadId, turns: [] }, model: 'gpt-5.4', reasoningEffort: 'xhigh' };
        }
        if (method === 'turn/start') {
          const promptText = params?.input?.[0]?.text || '';
          setTimeout(() => {
            rpcNotificationListener?.({
              method: 'item/completed',
              params: {
                threadId: params.threadId,
                turnId: 'turn-relay-e2e-1',
                item: {
                  id: 'item-relay-e2e-1',
                  type: 'agentMessage',
                  text: `E2E 릴레이 응답: ${promptText}`,
                },
              },
            });
          }, 30);
          return { turn: { id: 'turn-relay-e2e-1', status: 'inProgress' } };
        }
        return {};
      },
      {
        subscribe(fn: (msg: any) => void) {
          rpcNotificationListener = fn;
          return () => {
            if (rpcNotificationListener === fn) rpcNotificationListener = null;
          };
        },
      },
    ),
  });

  try {
    await expect
      .poll(async () => {
        const res = await fetch(`${relayOrigin}/api/health`);
        const body = (await res.json()) as any;
        return body.hostConnected;
      })
      .toBe(true);

    // BLKR-02: Initial visit in relay mode renders mirrored rollout transcript inside xterm
    await page.goto(`${relayOrigin}/?token=relay-user-token`);
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
    const card = page.locator('.terminal-card').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.xterm-rows')).toContainText('중단된 지점부터 이어서 작업해줘.');
    await expect(card.locator('.xterm-rows')).toContainText('릴레이 미러링 복원 완료했습니다.');

    // REMOTE-BLKR-06: Stale state="running" in session_metadata is reconciled to "입력 가능" (idle) when latest turn is completed
    await expect(card.locator('.session-state')).toHaveText('입력 가능');

    // REMOTE-BLKR-05: Structured conversation toggle (☷) loads history immediately without heavy thread/read timeout
    await card.locator('.conversation-toggle').click();
    await expect(card.locator('.conversation-host')).toBeVisible();
    await expect(card.locator('.conversation-message')).toHaveCount(2, { timeout: 2000 });
    await expect(card.locator('.conversation-message').first()).toContainText('중단된 지점부터 이어서 작업해줘.');
    await expect(card.locator('.conversation-message').nth(1)).toContainText('릴레이 미러링 복원 완료했습니다.');
    await expect(card.locator('.conversation-input')).toBeEnabled();
    await card.locator('.conversation-toggle').click();

    // BLKR-02: Browser refresh (F5) in relay mode preserves and re-renders the mirrored terminal snapshot
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
    await expect(card.locator('.xterm-rows')).toContainText('중단된 지점부터 이어서 작업해줘.');
    await expect(card.locator('.xterm-rows')).toContainText('릴레이 미러링 복원 완료했습니다.');

    // BLKR-01: Typing a command into the mirrored terminal and pressing Enter executes a turn and streams the response
    await card.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('원격 입력 테스트');
    await page.keyboard.press('Enter');
    await expect(card.locator('.xterm-rows')).toContainText('E2E 릴레이 응답: 원격 입력 테스트');
  } finally {
    await connector.close();
    await relay.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
