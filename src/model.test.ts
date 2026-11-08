import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptOutput, chooseSavedSessions, parseLayout, projectGroups, sessionProjectKey, savedSessionMetadata, updateSession, type SessionInfo, type ProjectInfo } from './model.ts';

const base: SessionInfo = { id: 'owned', generation: 2, title: 'test', cwd: 'C:\\work', state: 'running', active: true };

test('restart metadata preserves explicit intent and identity while excluding terminal output and coercions', () => {
  const session = { ...base, sessionId: base.id, threadId: 'saved-thread', resumeOnStartup: true, output: 'private conversation', seq: 123 };
  const metadata = savedSessionMetadata(session);
  assert.deepEqual(metadata, { title: 'test', cwd: 'C:\\work', sessionId: 'owned', threadId: 'saved-thread', resumeOnStartup: true });
  assert.deepEqual(parseLayout({ version: 1, sessions: [metadata] })?.sessions, [metadata]);
  assert.deepEqual(parseLayout({ version: 1, sessions: [{ ...metadata, resumeOnStartup: 'true', sessionId: 42 }] })?.sessions, [{ title: 'test', cwd: 'C:\\work', threadId: 'saved-thread' }]);
});

test('logical project ownership overrides cwd while legacy sessions match only the exact Windows folder', () => {
  const projects: ProjectInfo[] = [{ id: 'folder', name: '폴더', cwd: 'D:\\Work\\Alpha', createdAt: 1, favorite: false }, { id: 'logical', name: '논리 묶음', cwd: null, createdAt: 2, favorite: true }, { id: 'empty', name: '빈 프로젝트', cwd: null, createdAt: 3, favorite: false }];
  const legacy = { ...base, cwd: '\\\\?\\D:\\work\\ALPHA\\' };
  assert.equal(sessionProjectKey(legacy, projects), 'id:folder');
  assert.equal(sessionProjectKey({ ...legacy, projectId: null, projectAssigned: true }, projects), 'unassigned');
  assert.equal(sessionProjectKey({ ...legacy, projectId: 'logical', projectAssigned: true }, projects), 'id:logical');
  assert.equal(sessionProjectKey({ ...legacy, projectId: 'deleted', projectAssigned: true }, projects), 'unassigned');
  assert.equal(sessionProjectKey({ ...legacy, cwd: 'D:\\Work\\Alphabet' }, projects), 'cwd:d:\\work\\alphabet');
  const groups = projectGroups(projects, [legacy, { ...legacy, id: 'moved', projectId: 'logical', projectAssigned: true }, { ...legacy, id: 'unassigned', projectId: null, projectAssigned: true }]);
  assert.deepEqual(groups.map(({ key, count }) => ({ key, count })), [{ key: 'id:logical', count: 1 }, { key: 'id:folder', count: 1 }, { key: 'id:empty', count: 0 }, { key: 'unassigned', count: 1 }]);
});

test('saved layout and restored metadata preserve authoritative project membership including explicit unassigned', () => {
  const sessions = [{ title: '미분류', cwd: 'D:\\work', projectId: null, projectAssigned: true, projectRevision: 4 }, { title: '논리 묶음', cwd: 'D:\\other', threadId: 'thread-1', projectId: 'logical', projectAssigned: true }, { title: '이전 기록', cwd: 'D:\\legacy' }];
  assert.deepEqual(parseLayout({ version: 1, sessions })?.sessions, sessions);
  assert.deepEqual(chooseSavedSessions(undefined, [{ ...base, state: 'restored', projectId: null, projectAssigned: true }]), [{ title: base.title, cwd: base.cwd, projectId: null, projectAssigned: true }]);
});

test('delayed membership metadata cannot undo a move while newer session status and generation still update', () => {
  const moved = { ...base, projectId: null, projectAssigned: true, projectRevision: 4, seq: 9 };
  const updated = updateSession(moved, { ...base, state: 'waiting', projectId: 'previous', projectAssigned: true, projectRevision: 3 });
  assert.equal(updated.state, 'waiting');
  assert.equal(updated.projectId, null);
  assert.equal(updated.projectAssigned, true);
  assert.equal(updated.projectRevision, 4);
  assert.equal(updated.seq, 9);
  assert.equal(updateSession(moved, { ...base, projectId: 'latest', projectAssigned: true, projectRevision: 5 }).projectId, 'latest');
  assert.equal(updateSession(moved, { ...base, generation: 3, projectId: 'new-process', projectRevision: 0 }).projectId, 'new-process');
});

test('late process generations and duplicate output cannot replace or write to the current terminal', () => {
  const current = { ...base, seq: 10 };
  assert.equal(updateSession(current, { ...base, generation: 1, state: 'stopped' }), current);
  assert.equal(updateSession(current, { ...base, state: 'idle' }).seq, 10);
  assert.equal(updateSession(current, { ...base, generation: 3 }).seq, -1);
  const finished = updateSession(current, { ...base, state: 'error', active: false });
  assert.equal(updateSession(finished, { ...base, state: 'idle', active: true }), finished);
  assert.equal(updateSession(finished, { ...base, generation: 3, state: 'starting', active: true }).active, true);
  for (const output of [
    { id: base.id, generation: 1, seq: 11, data: 'old process' },
    { id: base.id, generation: 3, seq: 11, data: 'future process' },
    { id: base.id, generation: 2, seq: 10, data: 'duplicate' },
    { id: 'external', generation: 2, seq: 11, data: 'not owned' },
  ]) assert.equal(acceptOutput(current, output), false);
  assert.equal(acceptOutput(current, { id: base.id, generation: 2, seq: 11, data: 'new' }), true);
});

test('persisted layout is bounded and restores metadata without starting any process', () => {
  assert.equal(parseLayout(null), undefined);
  assert.equal(parseLayout({ version: 2, sessions: [] }), undefined);
  const parsed = parseLayout({ version: 1, columns: 99, columnSizes: [NaN, -10, 1e9], sessions: [{ title: 'a', cwd: 'C:\\a', threadId: 't' }, { title: 1 }] });
  assert.equal(parsed?.columns, 4);
  assert.deepEqual(parsed?.columnSizes, [1, 0.2, 10]);
  assert.deepEqual(parsed?.sessions, [{ title: 'a', cwd: 'C:\\a', threadId: 't' }]);
  assert.equal(parseLayout({ version: 1, columns: NaN, sessions: [] })?.columns, 2);
});

test('an explicitly empty saved workspace stays empty; only a missing layout falls back to restored metadata', () => {
  const history = [{ ...base, state: 'restored', threadId: 'historical-thread' }, { ...base, id: 'live', state: 'running' }];
  const empty = parseLayout({ version: 1, columns: 2, sessions: [] });
  assert.deepEqual(chooseSavedSessions(empty, history), []);
  assert.deepEqual(chooseSavedSessions(undefined, history), [{ title: base.title, cwd: base.cwd, threadId: 'historical-thread' }]);
  const saved = parseLayout({ version: 1, sessions: [{ title: 'kept', cwd: 'C:\\kept' }] });
  assert.deepEqual(chooseSavedSessions(saved, history), [{ title: 'kept', cwd: 'C:\\kept' }]);
});

test('terminal rows stay bounded at 32 while saved metadata uses a separate 512-entry budget', () => {
  const sessions = Array.from({ length: 32 }, (_, index) => ({ title: `session-${index}`, cwd: `C:\\project-${index}`, threadId: `thread-${index}` }));
  const rowSizes = Array.from({ length: 32 }, (_, index) => 1 + index / 32);
  const value = { version: 1, columns: 1, columnSizes: [1], rowSizes, sessions };
  const restored = parseLayout(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(restored?.sessions, sessions);
  assert.deepEqual(restored?.rowSizes, rowSizes);
  const oversized = parseLayout({ ...value, rowSizes: [...rowSizes, 2, 3], sessions: [...sessions, { title: 'overflow', cwd: 'C:\\overflow', threadId: 'overflow' }] });
  assert.equal(oversized?.sessions.length, 33);
  assert.equal(parseLayout({ ...value, sessions: Array.from({ length: 512 }, () => sessions[0]) })?.sessions.length, 512);
  assert.throws(() => parseLayout({ ...value, sessions: Array.from({ length: 513 }, () => sessions[0]) }), RangeError);
  assert.deepEqual(oversized?.rowSizes, rowSizes);
});

test('delayed preparation snapshots cannot disable an activated session in the same generation', () => {
  for (const state of ['idle', 'running', 'waiting', 'unknown', 'error', 'stopping']) {
    const current = { ...base, state, seq: 17, projectId: 'newer', projectAssigned: true, projectRevision: 4 };
    const delayed = { ...base, state: 'starting', threadId: 'resolved-thread', projectId: 'older', projectAssigned: true, projectRevision: 3 };
    const updated = updateSession(current, delayed);
    assert.equal(updated.state, state, 'preparing must not supersede '+state);
    assert.equal(updated.threadId, 'resolved-thread');
    assert.equal(updated.seq, 17);
    assert.equal(updated.projectId, 'newer');
    assert.equal(updated.projectRevision, 4);
    assert.equal(updateSession(current, { ...delayed, generation: 3 }).state, 'starting');
  }
  const preparing = { ...base, state: 'starting', seq: -1 };
  assert.equal(updateSession(undefined, preparing).state, 'starting');
  assert.equal(updateSession(preparing, { ...preparing, threadId: 'resolved-thread' }).threadId, 'resolved-thread');
  assert.equal(updateSession(preparing, { ...base, state: 'idle' }).state, 'idle');
});

test('remote server injects browser flag, enforces token auth, and bridges session/conversation RPC + SSE', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const http = await import('node:http');
  const {
    injectRemoteFlag,
    verifyToken,
    createRemoteServer,
    startHostConnector,
    normalizeRelayBaseUrl,
    RELAY_COMMAND_ALLOWLIST,
    RELAY_BLOCKED_COMMANDS,
    RELAY_EVENT_ALLOWLIST,
  } = await import('../server/remote-server.mjs');

  assert.equal(normalizeRelayBaseUrl('wss://relay.example.com/'), 'https://relay.example.com');
  assert.equal(normalizeRelayBaseUrl('ws://127.0.0.1:3210/api/relay/stream'), 'http://127.0.0.1:3210');
  assert.equal(RELAY_COMMAND_ALLOWLIST.includes('start_session'), true);
  assert.equal(RELAY_BLOCKED_COMMANDS.includes('complete_exit'), true);
  assert.equal(RELAY_EVENT_ALLOWLIST.includes('session-output'), true);

  const html = injectRemoteFlag('<!doctype html><html><head><title>OpenDIY</title></head><body></body></html>');
  assert.equal(html.includes('window.__OPENDIY_REMOTE__=true'), true);
  assert.equal(injectRemoteFlag(html), html);

  const secretHash = crypto.createHash('sha256').update('secret-123', 'utf8').digest();
  assert.equal(verifyToken(null, ''), true);
  assert.equal(verifyToken(secretHash, 'secret-123'), true);
  assert.equal(verifyToken(secretHash, 'wrong-token'), false);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-unit-'));
  const projDir = path.join(tmpRoot, 'project-alpha');
  fs.mkdirSync(projDir, { recursive: true });

  const rpcCalls: Array<{ method: string; params: any }> = [];
  const instance = createRemoteServer({
    workspaceDir: path.join(tmpRoot, 'workspace'),
    token: 'test-token-xyz',
    allowPathDiscovery: false,
    spawnProcess: false,
    rpcTransport: async (method: string, params: any) => {
      rpcCalls.push({ method, params });
      if (method === 'initialize') {
        return {
          userAgent: 'codex-app-server/test',
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
        return { thread: { id: 'rpc-thread-001', cwd: params.cwd } };
      }
      if (method === 'model/list') {
        return { data: [{ id: 'runtime-model-1', label: 'Runtime Model 1', efforts: ['low', 'medium', 'high'] }], nextCursor: null };
      }
      if (method === 'thread/subscribePassive') {
        return { subscribed: true };
      }
      if (method === 'turn/start') {
        return {
          turn: {
            id: 'rpc-turn-001',
            status: 'completed',
            items: [
              { id: 'u-1', role: 'user', text: params.input?.[0]?.text ?? '', status: 'completed' },
              { id: 'a-1', role: 'assistant', text: 'app-server response', status: 'completed' },
            ],
          },
        };
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: params.threadId,
            cwd: projDir,
            tokenUsage: { totalTokens: 4096 },
            modelContextWindow: 128000,
          },
        };
      }
      return {};
    },
  });

  await new Promise<void>(resolve => instance.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = instance.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { ok: true, service: 'opendiy-remote', mode: 'direct', hostConnected: true });

    const unauthRes = await fetch(`${baseUrl}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'get_ui_language', args: {} }),
    });
    assert.equal(unauthRes.status, 401);

    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
      const res = await fetch(`${baseUrl}/api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-xyz',
        },
        body: JSON.stringify({ command, args }),
      });
      const payload = (await res.json()) as { ok: boolean; result?: any; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      return payload.result;
    };

    assert.equal(await invoke('get_ui_language'), 'ko');
    const imported = await invoke('import_project', { cwd: projDir });
    assert.equal(imported.name, 'project-alpha');
    assert.equal(typeof imported.createdAt, 'number');

    const started = await invoke('start_session', {
      request: { title: '원격 테스트 세션', cwd: projDir, projectId: imported.id, projectAssigned: true },
    });
    assert.equal(started.title, '원격 테스트 세션');
    assert.equal(started.projectId, imported.id);

    const attached = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'attach' },
    });
    assert.equal(attached.attached, true);
    assert.equal(attached.connected, true);

    const sent = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'send', text: '원격 브리지 점검' },
    });
    assert.equal(sent.status, 'completed');
    assert.equal(sent.turns.length, 1);

    const modelsReply = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'models' },
    });
    assert.equal(Array.isArray(modelsReply.data), true);
    assert.equal(modelsReply.data.length, 1);

    const pageReply = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'page' },
    });
    assert.equal(Array.isArray(pageReply.data), true);
    assert.equal(pageReply.data.length, 1);

    const itemsReply = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'items', turnId: pageReply.data[0].id },
    });
    assert.equal(Array.isArray(itemsReply.data), true);
    assert.equal(itemsReply.data[0].turnId, pageReply.data[0].id);
    assert.equal(typeof itemsReply.data[0].item.type, 'string');
    assert.equal(typeof itemsReply.data[0].item.id, 'string');

    const ctxStatus = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'contextStatus' },
    });
    assert.equal(ctxStatus.connected, true);
    assert.equal(ctxStatus.tokenUsageFresh, true);
    assert.equal(ctxStatus.tokenUsage.last.totalTokens, 4096);
    assert.equal(ctxStatus.tokenUsage.modelContextWindow, 128000);
    assert.equal(ctxStatus.passiveSubscriptionSupported, true);
    assert.equal(ctxStatus.subagentsSupported, true);
    assert.equal(ctxStatus.cronSupported, true);
    assert.equal(ctxStatus.compactSupported, true);

    const ctxSettings = await invoke('conversation_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'contextSettings' },
    });
    assert.equal(ctxSettings.supported, true);
    assert.equal(ctxSettings.canChange, true);

    const extSnap = await invoke('extensions_list', { cwd: projDir });
    assert.equal(Array.isArray(extSnap.errors), true);
    assert.equal(typeof extSnap.skillDestinations, 'object');
    assert.equal(Array.isArray(extSnap.plugins.installed), true);
    assert.equal(Array.isArray(extSnap.hooks.items), true);

    const cronList = await invoke('cron_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'list' },
    });
    assert.equal(cronList.scope, 'cliLifetime');
    assert.equal(cronList.connected, true);
    assert.equal(Array.isArray(cronList.jobs), true);

    const subagentList = await invoke('subagents_request', {
      id: started.id,
      generation: started.generation,
      request: { type: 'list' },
    });
    assert.equal(subagentList.connected, true);
    assert.equal(Array.isArray(subagentList.agents), true);
    assert.equal(typeof subagentList.parentRuntimeId, 'string');

    const mobileReply = await invoke('mobile_control', {
      id: started.id,
      generation: started.generation,
      action: 'status',
    });
    assert.equal(typeof mobileReply.isolated, 'boolean');
    assert.equal(typeof mobileReply.mutationsAllowed, 'boolean');
    assert.equal(typeof mobileReply.status?.status, 'string');

    // Verify 1:1 Single-Owner Relay Hub + Outbound Host Connector
    const relayInstance = createRemoteServer({
      mode: 'relay',
      workspaceDir: path.join(tmpRoot, 'relay-workspace'),
      token: 'relay-client-token',
      hostSecret: 'relay-host-secret',
      allowPathDiscovery: false,
      spawnProcess: false,
    });
    await new Promise<void>(resolve => relayInstance.server.listen(0, '127.0.0.1', () => resolve()));
    const relayPort = (relayInstance.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${relayPort}`;

    let registeredHostId = '';
    const connector = startHostConnector({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      hostSecret: 'relay-host-secret',
      workspaceDir: path.join(tmpRoot, 'host-workspace'),
      allowPathDiscovery: false,
      spawnProcess: false,
      autoReconnect: false,
      onRegistered: ({ hostId }: { hostId: string }) => {
        registeredHostId = hostId;
      },
    });
    for (let i = 0; i < 30 && !registeredHostId; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(Boolean(registeredHostId), true);

    // Second host attempting to attach to the 1:1 relay must be rejected with 409 Single-Host Lock
    const duplicateHostRes = await fetch(`${relayUrl}/api/relay/stream`, {
      headers: {
        'X-OpenDIY-Host-Id': 'intruder-host-id',
        'X-OpenDIY-Host-Secret': 'relay-host-secret',
      },
    });
    assert.equal(duplicateHostRes.status, 409);

    // Client invoking via the relay hits the connected local host
    const relayInvokeRes = await fetch(`${relayUrl}/api/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer relay-client-token',
      },
      body: JSON.stringify({ command: 'get_ui_language', args: {} }),
    });
    const relayInvokePayload = (await relayInvokeRes.json()) as { ok: boolean; result?: any };
    assert.equal(relayInvokePayload.ok, true);
    assert.equal(relayInvokePayload.result, 'ko');

    // Blocked command (e.g. complete_exit) must be rejected by relay allowlist
    const blockedCmdRes = await fetch(`${relayUrl}/api/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer relay-client-token',
      },
      body: JSON.stringify({ command: 'complete_exit', args: {} }),
    });
    assert.equal(blockedCmdRes.status, 400);
    const blockedCmdPayload = (await blockedCmdRes.json()) as { ok: boolean; error?: string };
    assert.equal(blockedCmdPayload.ok, false);

    // Duplicate/late reqId reply is handled idempotently (200 OK, ignored: true)
    const dupReplyRes = await fetch(`${relayUrl}/api/relay/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenDIY-Host-Id': registeredHostId,
        'X-OpenDIY-Host-Secret': 'relay-host-secret',
      },
      body: JSON.stringify({ reqId: 'unknown-or-settled-req-id', ok: true, result: null }),
    });
    assert.equal(dupReplyRes.status, 200);
    assert.deepEqual(await dupReplyRes.json(), { ok: true, ignored: true });

    // Disallowed event name is rejected with 400 EVENT_NOT_ALLOWED
    const badEventRes = await fetch(`${relayUrl}/api/relay/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenDIY-Host-Id': registeredHostId,
        'X-OpenDIY-Host-Secret': 'relay-host-secret',
      },
      body: JSON.stringify({ event: 'arbitrary-untrusted-event', payload: {} }),
    });
    assert.equal(badEventRes.status, 400);

    await connector.close();
    const healthAfterClose = (await (await fetch(`${relayUrl}/api/health`)).json()) as { hostConnected: boolean };
    assert.equal(healthAfterClose.hostConnected, false);
    await relayInstance.close();

    // Google OAuth 2.0 (OIDC) login + allowed-email allowlist verification
    let mockOAuthEmail = 'owner@jaeseong.dev';
    let mockOAuthVerified = true;
    const mockGoogleServer = http.createServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'mock-google-access-token' }));
        return;
      }
      if (req.url === '/userinfo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ email: mockOAuthEmail, email_verified: mockOAuthVerified }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const mockGooglePort = await new Promise<number>(resolve => {
      mockGoogleServer.listen(0, '127.0.0.1', () => {
        const addr = mockGoogleServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const fakeDistDir = path.join(tmpRoot, 'dist');
    fs.mkdirSync(fakeDistDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDistDir, 'index.html'), '<!doctype html><html><head><title>OpenDIY</title></head><body></body></html>', 'utf8');

    const oauthRelay = createRemoteServer({
      mode: 'relay',
      distDir: fakeDistDir,
      token: 'fallback-token',
      hostSecret: 'relay-host-secret',
      googleClientId: 'test-google-client-id',
      googleClientSecret: 'test-google-client-secret',
      allowedEmail: 'owner@jaeseong.dev',
      googleOAuthTokenUrl: `http://127.0.0.1:${mockGooglePort}/token`,
      googleOAuthUserInfoUrl: `http://127.0.0.1:${mockGooglePort}/userinfo`,
    });
    const oauthPort = await new Promise<number>(resolve => {
      oauthRelay.server.listen(0, '127.0.0.1', () => {
        const addr = oauthRelay.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    const oauthBase = `http://127.0.0.1:${oauthPort}`;

    // Unauthenticated root visit returns the Google Sign-In Gate page
    const gateRes = await fetch(`${oauthBase}/`);
    assert.equal(gateRes.status, 200);
    const gateHtml = await gateRes.text();
    assert.equal(gateHtml.includes('/auth/google'), true);

    // Redirects to Google OAuth with state parameter
    const startAuthRes = await fetch(`${oauthBase}/auth/google`, { redirect: 'manual' });
    assert.equal(startAuthRes.status, 302);
    const redirectLoc = new URL(startAuthRes.headers.get('location') || '');
    const stateVal = redirectLoc.searchParams.get('state') || '';
    assert.equal(stateVal.length > 10, true);

    // Non-owner Google account is rejected with 403
    mockOAuthEmail = 'intruder@example.com';
    const intruderRes = await fetch(
      `${oauthBase}/auth/google/callback?code=test-code&state=${encodeURIComponent(stateVal)}`,
      { redirect: 'manual' },
    );
    assert.equal(intruderRes.status, 403);

    // Owner Google account succeeds (302 + signed session cookie) and unlocks workspace
    const startAuthRes2 = await fetch(`${oauthBase}/auth/google`, { redirect: 'manual' });
    const stateVal2 = new URL(startAuthRes2.headers.get('location') || '').searchParams.get('state') || '';
    mockOAuthEmail = 'owner@jaeseong.dev';
    const ownerRes = await fetch(
      `${oauthBase}/auth/google/callback?code=test-code-2&state=${encodeURIComponent(stateVal2)}`,
      { redirect: 'manual' },
    );
    assert.equal(ownerRes.status, 302);
    const oauthCookie = (ownerRes.headers.get('set-cookie') || '').split(';')[0];
    assert.equal(oauthCookie.startsWith('opendiy_remote_auth='), true);

    const authedIndexRes = await fetch(`${oauthBase}/`, { headers: { Cookie: oauthCookie } });
    const authedHtml = await authedIndexRes.text();
    assert.equal(authedHtml.includes('window.__OPENDIY_REMOTE__=true;'), true);

    await oauthRelay.close();
    await new Promise<void>(resolve => mockGoogleServer.close(() => resolve()));

    const chosenFolder = await invoke('choose_project_folder', { path: projDir });
    assert.equal(chosenFolder, projDir);
    const chosenProj = await invoke('choose_project', { cwd: projDir });
    assert.equal(chosenProj.id, imported.id);
    assert.equal(await invoke('open_external_url', { url: 'https://github.com/jaeseongs95/opendiy-remote' }), null);
    await assert.rejects(() => invoke('open_external_url', { url: 'javascript:alert(1)' }));

    // list_directory RPC returns directories and files for remote browser path picker
    fs.writeFileSync(path.join(projDir, 'sample.txt'), 'hello');
    const dirListing = await invoke('list_directory', { path: projDir, includeFiles: true });
    assert.equal(dirListing.currentPath, projDir);
    assert.equal(Array.isArray(dirListing.entries), true);
    assert.equal(dirListing.entries.some((e: any) => e.name === 'sample.txt' && e.isDirectory === false), true);

    await invoke('session_stop', { id: started.id, generation: started.generation });
    const remaining = await invoke('list_sessions');
    assert.equal(remaining.length, 0);
  } finally {
    await instance.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('remote server mirrors OpenDIY Desktop workspace.sqlite3 projects, active sessions, rollout turns, terminal-output over relay, and executes cron timers', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { createRemoteServer, startHostConnector } = await import('../server/remote-server.mjs');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-desktop-sync-'));
  const desktopDbPath = path.join(tmpRoot, 'workspace.sqlite3');
  const codexHomeDir = path.join(tmpRoot, '.codex');
  fs.mkdirSync(codexHomeDir, { recursive: true });
  const projDir = path.join(tmpRoot, '개발자');
  fs.mkdirSync(projDir, { recursive: true });

  // 1. Create mock OpenDIY Desktop workspace.sqlite3 matching real schema
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
  const layoutPayload = {
    version: 1,
    columns: 2,
    columnSizes: [1, 1],
    rowSizes: [1, 1],
    sessions: [
      { id: 'sess-desktop', name: 'desktop 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-desktop-1', runtimeKind: 'codex' },
      { id: 'sess-cli', name: 'CLI 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-cli-1', runtimeKind: 'codex' },
    ],
  };
  desktopDb.prepare('INSERT INTO workspace_layout (id, layout) VALUES (1, ?)').run(JSON.stringify(layoutPayload));
  desktopDb.prepare('INSERT INTO session_metadata (id, generation, metadata, updated_at) VALUES (?, 1, ?, 1700000100)').run(
    'sess-desktop',
    JSON.stringify({ id: 'sess-desktop', name: 'desktop 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-desktop-1', runtimeKind: 'codex', state: 'running', active: true }),
  );
  desktopDb.prepare('INSERT INTO session_metadata (id, generation, metadata, updated_at) VALUES (?, 1, ?, 1700000100)').run(
    'sess-cli',
    JSON.stringify({ id: 'sess-cli', name: 'CLI 담당', cwd: projDir, projectId: 'proj-dev', resumeSessionId: 'thread-cli-1', runtimeKind: 'codex', state: 'running', active: true }),
  );
  desktopDb.close();

  // 2. Create mock ~/.codex/state_5.sqlite and rollout JSONL file
  const rolloutFile = path.join(codexHomeDir, 'rollout-desktop.jsonl');
  const hugeOutput = 'A'.repeat(25000);
  const rolloutLines = [
    JSON.stringify({ timestamp: '2026-11-08T02:00:00Z', type: 'session_meta', payload: { id: 'thread-desktop-1', cwd: projDir } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: projDir, model: 'GPT-6.1-Sol', effort: 'xhigh' } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1', model_context_window: 380000 } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: '중단된 지점부터 이어서 작업해줘.' } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: JSON.stringify({ cmd: 'git status --short' }) } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:04.5Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { id: 'call-1', type: 'CommandExecution', command: ['git', 'status', '--short'], status: 'completed' } } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: `Process exited with code 0\nOutput:\nM src/main.ts\n${hugeOutput}` } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:06Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { id: 'msg-assistant-1', type: 'AgentMessage', content: [{ type: 'Text', text: '작업을 재개했습니다.' }] } } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:06.5Z', type: 'response_item', payload: { type: 'message', id: 'msg-assistant-1', role: 'assistant', content: [{ type: 'output_text', text: '작업을 재개했습니다.' }] } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:07Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 120000 }, last_token_usage: { total_tokens: 228000 }, model_context_window: 380000 } } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:08Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:09Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { id: 'msg-assistant-2', type: 'AgentMessage', content: [{ type: 'Text', text: '두 번째 턴 응답입니다.' }] } } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:09.5Z', type: 'response_item', payload: { type: 'message', id: 'msg-assistant-2', role: 'assistant', content: [{ type: 'output_text', text: '두 번째 턴 응답입니다.' }] } }),
  ];
  fs.writeFileSync(rolloutFile, rolloutLines.join('\n') + '\n', 'utf8');

  const codexDb = new DatabaseSync(path.join(codexHomeDir, 'state_5.sqlite'));
  codexDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT NOT NULL DEFAULT '',
      model TEXT,
      reasoning_effort TEXT
    );
  `);
  codexDb.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, first_user_message, model, reasoning_effort)
    VALUES (?, ?, ?, ?, 'cli', 'openai', ?, 'desktop 담당', 'workspace-write', 'never', 228000, '중단된 지점부터 이어서 작업해줘.', 'GPT-6.1-Sol', 'xhigh')
  `).run('thread-desktop-1', rolloutFile, 1700000000, 1700000100, projDir);
  codexDb.close();

  let cronTurnStarted = false;
  const relayInstance = createRemoteServer({
    mode: 'relay',
    workspaceDir: path.join(tmpRoot, 'relay-workspace'),
    token: 'relay-sync-token',
    hostSecret: 'relay-sync-secret',
  });

  const relayPort = await new Promise<number>(resolve => {
    relayInstance.server.listen(0, '127.0.0.1', () => {
      const addr = relayInstance.server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  const relayBase = `http://127.0.0.1:${relayPort}`;

  let registered = false;
  const connector = startHostConnector({
    relayUrl: relayBase,
    hostSecret: 'relay-sync-secret',
    workspaceDir: path.join(tmpRoot, 'host-workspace'),
    desktopDbPath,
    codexHomeDir,
    allowPathDiscovery: false,
    spawnProcess: false,
    autoReconnect: false,
    onRegistered: () => {
      registered = true;
    },
    rpcTransport: async (method: string, params: any) => {
      if (method === 'thread/read' && params?.includeTurns === true) {
        throw new Error('REMOTE-BLKR-05: thread/read(includeTurns: true) must not be called when rollout turns are available');
      }
      if (method === 'turn/start') {
        cronTurnStarted = true;
        return {
          turn: {
            id: 'cron-turn-1',
            status: 'completed',
            items: [
              { id: 'u-1', type: 'userMessage', role: 'user', text: params?.input?.[0]?.text || '' },
              { id: 'a-1', type: 'agentMessage', role: 'assistant', text: '원격 터미널 프롬프트 응답 완료' },
            ],
          },
        };
      }
      return {};
    },
  });
  for (let i = 0; i < 30 && !registered; i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(registered, true);

  try {
    const relayInvoke = async (cmd: string, args: Record<string, any> = {}) => {
      const res = await fetch(`${relayBase}/api/invoke`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer relay-sync-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: cmd, args }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      return body.result;
    };

    // Verify projects, layout, and active sessions mirrored from workspace.sqlite3
    const projects = await relayInvoke('list_projects');
    assert.equal(projects.some((p: any) => p.name === '개발자' && p.cwd === projDir), true);

    const layout = await relayInvoke('load_layout');
    assert.equal(layout.sessions.length, 2);

    // Connect SSE stream to verify terminal-output forwarding over relay (FINDING-04)
    const sseController = new AbortController();
    const sseRes = await fetch(`${relayBase}/api/events?token=relay-sync-token`, {
      signal: sseController.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const readPump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // aborted
      }
    })();

    const sessions = await relayInvoke('list_sessions');
    assert.equal(sessions.length, 2);
    const desktopSess = sessions.find((s: any) => s.title === 'desktop 담당' && s.threadId === 'thread-desktop-1');
    assert.equal(Boolean(desktopSess), true);
    // REMOTE-BLKR-06: Even though session_metadata had stale state:'running', completed rollout turn reconciles session.state to 'idle'
    assert.equal(desktopSess.state, 'idle');
    assert.equal(sessions.some((s: any) => s.title === 'CLI 담당' && s.threadId === 'thread-cli-1'), true);

    const ctxStatusMirrored = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'contextStatus' },
    });
    assert.equal(ctxStatusMirrored.idle, true);
    assert.equal(ctxStatusMirrored.canCompact, true);

    // Verify conversation_request (attach + page + items + detail) returns rollout turns/items quickly without heavy thread/read
    const attachRes = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'attach' },
    });
    assert.equal(attachRes.threadId, 'thread-desktop-1');
    assert.equal(attachRes.model, 'GPT-6.1-Sol');
    assert.equal(attachRes.turns.length >= 1, true);

    const pageRes = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'page' },
    });
    // REMOTE-BLKR-09: Rollout lines with multiple assistant turns split into discrete turns (>= 2)
    assert.equal(pageRes.data.length >= 2, true);
    const firstTurnId = pageRes.data[pageRes.data.length - 1].id;

    const itemsRes = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'items', turnId: firstTurnId },
    });
    // REMOTE-BLKR-08: Verify 0 duplicate item IDs even when response_item + event_msg(item_completed) share the same id
    const seenIds = new Set(itemsRes.items.map((it: any) => it.id));
    assert.equal(seenIds.size, itemsRes.items.length);
    assert.equal(itemsRes.items.some((it: any) => it.type === 'userMessage' && it.text.includes('중단된 지점부터')), true);
    const cmdItem = itemsRes.items.find((it: any) => it.type === 'commandExecution');
    assert.equal(Boolean(cmdItem), true);
    assert.equal(cmdItem.truncated, true);
    assert.equal(cmdItem.aggregatedOutput.length, 16384);

    const detailRes = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'detail', turnId: firstTurnId, itemId: cmdItem.id, offset: 16384 },
    });
    assert.equal(detailRes.totalBytes > 25000, true);
    assert.equal(detailRes.text.includes('AAAA'), true);

    // Wait briefly for scheduleMirroredSessionSnapshots to emit terminal-output over relay SSE
    for (let i = 0; i < 25 && !sseBuffer.includes('terminal-output'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(sseBuffer.includes('terminal-output'), true);
    assert.equal(sseBuffer.includes('desktop 담당'), true);

    // BLKR-01: Verify typing into mirrored session via session_write triggers turn/start and emits response to terminal
    cronTurnStarted = false;
    await relayInvoke('session_write', {
      id: 'sess-desktop',
      generation: 1,
      data: '원격 터미널에서 직접 입력\r',
    });
    assert.equal(cronTurnStarted, true);
    for (let i = 0; i < 25 && !sseBuffer.includes('원격 터미널 프롬프트 응답 완료'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(sseBuffer.includes('원격 터미널 프롬프트 응답 완료'), true);

    // BLKR-02: Verify newly connected SSE client (e.g. browser refresh) immediately receives cached terminal-output buffer
    const refreshController = new AbortController();
    const refreshRes = await fetch(`${relayBase}/api/events?token=relay-sync-token`, {
      signal: refreshController.signal,
    });
    assert.equal(refreshRes.status, 200);
    const refreshReader = refreshRes.body!.getReader();
    let refreshBuf = '';
    const refreshPump = (async () => {
      try {
        while (true) {
          const { done, value } = await refreshReader.read();
          if (done) break;
          refreshBuf += decoder.decode(value, { stream: true });
        }
      } catch {}
    })();
    for (let i = 0; i < 20 && !refreshBuf.includes('desktop 담당'); i++) {
      await new Promise(r => setTimeout(r, 40));
    }
    assert.equal(refreshBuf.includes('desktop 담당'), true);
    refreshController.abort();
    await refreshPump;

    // Verify cron_request schedules and fires a real timer (FINDING-05)
    cronTurnStarted = false;
    await relayInvoke('cron_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'add', prompt: '주기적 상태 점검', schedule: { type: 'every', seconds: 1 } },
    });
    for (let i = 0; i < 25 && !cronTurnStarted; i++) {
      await new Promise(r => setTimeout(r, 80));
    }
    assert.equal(cronTurnStarted, true);

    sseController.abort();
    await readPump;
  } finally {
    await connector.close();
    await relayInstance.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('TerminalInputQueue coalesces rapid typing bursts over high-RTT links into a single batch send', async () => {
  const { TerminalInputQueue } = await import('./terminal-flow.ts');
  const sentBatches: Array<{ data: string; generation: number; selectionVersion: number }> = [];
  let releaseFirstSend!: () => void;
  const firstSendBarrier = new Promise<void>(resolve => {
    releaseFirstSend = resolve;
  });

  const queue = new TerminalInputQueue<{ data: string; generation: number; selectionVersion: number }>(
    async value => {
      sentBatches.push(value);
      if (sentBatches.length === 1) {
        await firstSendBarrier;
      }
    },
    () => {},
    { coalesce: true },
  );

  const p1 = queue.enqueue({ data: '안', generation: 1, selectionVersion: 1 });
  const p2 = queue.enqueue({ data: '녕', generation: 1, selectionVersion: 1 });
  const p3 = queue.enqueue({ data: '하', generation: 1, selectionVersion: 1 });
  const p4 = queue.enqueue({ data: '세', generation: 1, selectionVersion: 1 });
  const p5 = queue.enqueue({ data: '요', generation: 1, selectionVersion: 1 });
  const p6 = queue.enqueue({ data: '\r', generation: 1, selectionVersion: 1 });

  releaseFirstSend();
  await Promise.all([p1, p2, p3, p4, p5, p6]);

  assert.equal(sentBatches.length, 2);
  assert.equal(sentBatches[0].data, '안');
  assert.equal(sentBatches[1].data, '녕하세요\r');
  assert.equal(queue.size, 0);
  assert.equal(queue.byteLength, 0);
});

test('Host Connector OAuth login flow (--connect without --host-secret), slash_commands_list, catalog_list filtering, and Korean wide-char backspace', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRemoteServer, startHostConnector } = await import('../server/remote-server.mjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-oauth-slash-catalog-'));
  const projA = path.join(tmpRoot, 'proj-alpha');
  const projJeoneon = path.join(tmpRoot, '전언');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projJeoneon, { recursive: true });

  const codexHome = path.join(tmpRoot, '.codex');
  const skillsDir = path.join(codexHome, 'skills', 'my-custom-skill');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'SKILL.md'),
    '---\nname: my-custom-skill\ndescription: Custom test skill for slash palette\n---\n# Skill\n',
    'utf8',
  );

  // Create state_5.sqlite with >100 recent threads in projA and 1 older thread in projJeoneon
  const { DatabaseSync } = await import('node:sqlite');
  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  const sdb = new DatabaseSync(stateDbPath);
  sdb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      cwd TEXT,
      title TEXT,
      name TEXT,
      first_user_message TEXT,
      archived INTEGER DEFAULT 0
    );
  `);
  const insertStmt = sdb.prepare(
    'INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, name, first_user_message, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
  );
  for (let i = 1; i <= 120; i++) {
    insertStmt.run(
      `thread-alpha-${i}`,
      '',
      1790000000 + i,
      1794000000 + i,
      `\\\\?\\${projA}`,
      `Alpha task ${i}`,
      null,
      `Alpha prompt ${i}`,
    );
  }
  // Older thread in '전언' project (rank > 80 so old LIMIT 80 bug would drop it!)
  insertStmt.run(
    'thread-jeoneon-target',
    '',
    1780000000,
    1785000000,
    `\\\\?\\${projJeoneon}`,
    'Automation: 전체 Dot 답변 폴더 감시\nMultiple lines should be trimmed to single line',
    '전체 Dot 답변 폴더 감시',
    '첫 메시지',
  );
  sdb.close();

  // Mock Google OAuth token & userinfo HTTP server
  const http = await import('node:http');
  const mockGoogleServer = http.createServer((req, res) => {
    if (req.url === '/token' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock-google-access-token' }));
      return;
    }
    if (req.url === '/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'owner@example.com', email_verified: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => mockGoogleServer.listen(0, '127.0.0.1', resolve));
  const googleAddr = mockGoogleServer.address() as { port: number };
  const googleBase = `http://127.0.0.1:${googleAddr.port}`;

  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  const relayInstance = createRemoteServer({
    mode: 'relay',
    workspaceDir: path.join(tmpRoot, 'relay-ws'),
    googleClientId: 'mock-client-id',
    googleClientSecret: 'mock-client-secret',
    allowedEmail: 'owner@example.com',
    googleOAuthTokenUrl: `${googleBase}/token`,
    googleOAuthUserInfoUrl: `${googleBase}/userinfo`,
    allowPathDiscovery: false,
  });

  let connector: any = null;
  try {
    const relayPort = await new Promise<number>(resolve => {
      relayInstance.server.listen(0, '127.0.0.1', () => {
        const addr = relayInstance.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    const relayBase = `http://127.0.0.1:${relayPort}`;

    // Start Host Connector WITHOUT --host-secret, intercepting onOAuthPrompt to simulate user completing Google OAuth in browser
    let openedAuthUrl = '';
    let registeredPromiseResolve!: () => void;
    const registeredPromise = new Promise<void>(resolve => {
      registeredPromiseResolve = resolve;
    });
    const oauthCachePath = path.join(tmpRoot, 'host-oauth-token.json');
    connector = startHostConnector({
      relayUrl: relayBase,
      hostSecret: '',
      oauthCacheFile: oauthCachePath,
      oauthPollIntervalMs: 150,
      openBrowser: false,
      silent: true,
      workspaceDir: path.join(tmpRoot, 'host-ws'),
      codexHomeDir: codexHome,
      spawnProcess: false,
      allowPathDiscovery: false,
      onRegistered: () => {
        registeredPromiseResolve();
      },
      onOAuthPrompt: ({ loginUrl }: { loginUrl: string }) => {
        openedAuthUrl = loginUrl;
        void (async () => {
          // 1. Follow /auth/google?cli_session=... to get Google redirect URL with server-side state nonce
          const step1 = await fetch(loginUrl, { redirect: 'manual' });
          assert.equal(step1.status, 302);
          const loc = new URL(step1.headers.get('location')!);
          const stateParam = loc.searchParams.get('state')!;
          assert.equal(Boolean(stateParam), true);
          // 2. Call /auth/google/callback?code=mock-code&state=...
          const step2 = await fetch(
            `${relayBase}/auth/google/callback?code=mock-code&state=${encodeURIComponent(stateParam)}`,
          );
          assert.equal(step2.status, 200);
          const html = await step2.text();
          assert.equal(html.includes('로컬 PC 호스트 인증 완료'), true);
        })();
      },
    });

    await registeredPromise;
    assert.equal(openedAuthUrl.includes('/auth/google?cli_session='), true);
    assert.equal(fs.existsSync(oauthCachePath), true);
    const cachedTokenMap = JSON.parse(fs.readFileSync(oauthCachePath, 'utf8'));
    const cachedTokenData = cachedTokenMap[relayBase];
    assert.equal(Boolean(cachedTokenData?.token?.startsWith('oauth.')), true);

    const relayInvoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      const res = await fetch(`${relayBase}/api/invoke`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cachedTokenData.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: cmd, args }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      return body.result;
    };

    // 1. Verify catalog_list finds '전언' session even when >100 newer sessions exist in another project
    const catalogJeoneon = await relayInvoke('catalog_list', {
      request: { cwd: projJeoneon, query: '' },
    });
    assert.equal(catalogJeoneon.sessions.length, 1);
    assert.equal(catalogJeoneon.sessions[0].id, 'thread-jeoneon-target');
    assert.equal(catalogJeoneon.sessions[0].title, '전체 Dot 답변 폴더 감시');

    // 2. Verify slash_commands_list returns built-in slash commands + custom skill
    const slashRes = await relayInvoke('slash_commands_list', { cwd: projJeoneon });
    assert.equal(Array.isArray(slashRes.commands), true);
    assert.equal(slashRes.commands.some((c: any) => c.command === '/compact'), true);
    assert.equal(slashRes.commands.some((c: any) => c.command === '/status'), true);
    assert.equal(slashRes.commands.some((c: any) => c.command === '/my-custom-skill' && c.category === 'skill'), true);

    // 3. Start a session and test Korean wide-char backspace + /status slash command in session_write
    const started = await relayInvoke('start_session', {
      request: { title: '한글 및 슬래시 테스트', cwd: projJeoneon, threadId: 'thread-jeoneon-target' },
    });
    assert.equal(started.lineBufferedInput, true);

    const sseController = new AbortController();
    const sseRes = await fetch(`${relayBase}/api/events`, {
      headers: { Authorization: `Bearer ${cachedTokenData.token}` },
      signal: sseController.signal,
    });
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuf += decoder.decode(value, { stream: true });
        }
      } catch {}
    })();

    // Type '가나' then Backspace ('\u007f') -> should erase wide char with '\b \b\b \b'
    await relayInvoke('session_write', {
      id: started.id,
      generation: started.generation,
      data: '가나\u007f',
    });
    for (let i = 0; i < 15 && !sseBuf.includes('\\b \\b\\b \\b'); i++) {
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(sseBuf.includes('\\b \\b\\b \\b'), true);

    // Clear line with Ctrl+C and execute /status
    await relayInvoke('session_write', {
      id: started.id,
      generation: started.generation,
      data: '\u0003/status\r',
    });
    for (let i = 0; i < 20 && !sseBuf.includes('세션 상태'); i++) {
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(sseBuf.includes('세션 상태'), true);

    sseController.abort();
    await pump;
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (connector) await connector.close();
    await relayInstance.close();
    await new Promise<void>(resolve => mockGoogleServer.close(() => resolve()));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('Auto-update (T-0003) and live session state sync / Desktop parity (D-0008)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const {
    compareSemver,
    fetchLatestReleaseInfo,
    performSelfUpdate,
    createRemoteServer,
    startHostConnector,
  } = await import('../server/remote-server.mjs');

  assert.equal(compareSemver('1.2.0', '1.1.0'), 1);
  assert.equal(compareSemver('1.1.0', '1.1.0'), 0);
  assert.equal(compareSemver('1.1.0', '1.2.0'), -1);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-update-parity-'));
  try {
    // 1. Create a fake release bundle tar.gz for v9.9.9
    const bundleStaging = path.join(tmpRoot, 'bundle-src');
    fs.mkdirSync(path.join(bundleStaging, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(bundleStaging, 'server'), { recursive: true });
    fs.mkdirSync(path.join(bundleStaging, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(bundleStaging, 'package.json'), JSON.stringify({ name: 'opendiy-remote', version: '9.9.9' }, null, 2));
    fs.writeFileSync(path.join(bundleStaging, 'dist', 'index.html'), '<!doctype html><html><body>v9.9.9</body></html>');
    fs.writeFileSync(path.join(bundleStaging, 'server', 'remote-server.mjs'), '// v9.9.9 server\n');
    fs.writeFileSync(path.join(bundleStaging, 'scripts', 'install-relay.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(bundleStaging, 'README.md'), '# v9.9.9\n');
    fs.writeFileSync(path.join(bundleStaging, 'README.ko.md'), '# v9.9.9 ko\n');

    const bundleTarGz = path.join(tmpRoot, 'opendiy-remote-v9.9.9-relay-bundle.tar.gz');
    execFileSync('tar', ['-czf', bundleTarGz, '-C', bundleStaging, 'package.json', 'dist', 'server', 'scripts', 'README.md', 'README.ko.md']);
    const tarBytes = fs.readFileSync(bundleTarGz);
    const tarSha256 = crypto.createHash('sha256').update(tarBytes).digest('hex');

    // Create install target root with v1.1.0
    const installRoot = path.join(tmpRoot, 'install-root');
    fs.mkdirSync(path.join(installRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(installRoot, 'server'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'opendiy-remote', version: '1.1.0' }, null, 2));
    fs.writeFileSync(path.join(installRoot, 'dist', 'index.html'), '<!doctype html><html><body>v1.1.0</body></html>');
    fs.writeFileSync(path.join(installRoot, 'server', 'remote-server.mjs'), '// v1.1.0 server\n');

    const mockFetch = async (url: string) => {
      if (url.endsWith('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v9.9.9',
            html_url: 'https://github.com/jaeseongs95/opendiy-remote/releases/tag/v9.9.9',
            body: 'Auto-update test release',
            published_at: '2026-11-08T13:00:00Z',
            assets: [
              {
                name: 'opendiy-remote-v9.9.9-relay-bundle.tar.gz',
                browser_download_url: 'https://mock.local/opendiy-remote-v9.9.9-relay-bundle.tar.gz',
                size: tarBytes.length,
                digest: `sha256:${tarSha256}`,
              },
            ],
          }),
        } as any;
      }
      if (url === 'https://mock.local/opendiy-remote-v9.9.9-relay-bundle.tar.gz') {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarBytes.buffer.slice(tarBytes.byteOffset, tarBytes.byteOffset + tarBytes.byteLength),
        } as any;
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const checkInfo = await fetchLatestReleaseInfo({
      rootDir: installRoot,
      releaseApiUrl: 'https://mock.local/releases/latest',
      fetchFn: mockFetch,
    });
    assert.equal(checkInfo.currentVersion, '1.1.0');
    assert.equal(checkInfo.latestVersion, '9.9.9');
    assert.equal(checkInfo.updateAvailable, true);
    assert.equal(checkInfo.sha256, tarSha256);

    // Verify SHA-256 mismatch rejection
    await assert.rejects(
      () =>
        performSelfUpdate({
          rootDir: installRoot,
          releaseApiUrl: 'https://mock.local/releases/latest',
          fetchFn: async (url: string) => {
            if (url.endsWith('/releases/latest')) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  tag_name: 'v9.9.9',
                  assets: [
                    {
                      name: 'opendiy-remote-v9.9.9-relay-bundle.tar.gz',
                      browser_download_url: 'https://mock.local/opendiy-remote-v9.9.9-relay-bundle.tar.gz',
                      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                    },
                  ],
                }),
              } as any;
            }
            return mockFetch(url);
          },
          scheduleRestart: false,
        }),
      /무결성 검증 실패/,
    );

    // 2. Test D-0008 live session state sync + Desktop parity + Relay/Host update coordination
    const desktopDbPath = path.join(tmpRoot, 'workspace.sqlite3');
    const codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const projCwd = path.join(tmpRoot, 'proj');
    fs.mkdirSync(projCwd, { recursive: true });

    const rolloutPath = path.join(codexHome, 'rollout-live.jsonl');
    const rolloutLines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-1', model_context_window: 285000 } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn-live-1', message: '진행상황 확인해줘' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-live-1',
          item: {
            id: 'msg-commentary-1',
            type: 'AgentMessage',
            phase: 'commentary',
            content: [{ type: 'Text', text: '네이티브 본시험 결과를 확인하겠습니다.' }],
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'ctc-1',
          call_id: 'call-live-1',
          name: 'exec',
          input: 'gh run view 4248358002 --repo jaeseongs95/opendiy-desktop',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          id: 'ctco-1',
          call_id: 'call-live-1',
          output: [{ type: 'input_text', text: 'conclusion: success\nline2\nline3\nline4' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 3487294112 },
            last_token_usage: { total_tokens: 176700 },
            model_context_window: 285000,
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 90,
              window_minutes: 10080,
              resets_at: 1794379004,
            },
          },
        },
      }),
    ];
    fs.writeFileSync(rolloutPath, rolloutLines.join('\n') + '\n', 'utf8');

    const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        cwd TEXT,
        title TEXT,
        tokens_used INTEGER,
        model TEXT,
        reasoning_effort TEXT
      );
    `);
    const nowSec = Math.floor(Date.now() / 1000);
    stateDb
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('thread-desktop-live', rolloutPath, nowSec - 60, nowSec, projCwd, 'desktop 담당', 3487294112, 'gpt-6.1-sol', 'high');
    stateDb.close();

    const ddb = new DatabaseSync(desktopDbPath);
    ddb.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, cwd TEXT, canonical_cwd TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE workspace_layout (id INTEGER PRIMARY KEY, layout TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE session_metadata (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    ddb.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('proj-dev', projCwd, projCwd, '개발자', nowSec, 0);
    ddb.prepare('INSERT INTO workspace_layout VALUES (1, ?, ?)').run(
      JSON.stringify({
        version: 1,
        columns: 2,
        columnSizes: [1, 1],
        rowSizes: [1, 1],
        sessions: [
          {
            sessionId: 'sess-desktop-live',
            title: 'desktop 담당',
            cwd: projCwd,
            threadId: 'thread-desktop-live',
            projectId: 'proj-dev',
            projectAssigned: true,
          },
        ],
      }),
      nowSec,
    );
    ddb.prepare('INSERT INTO session_metadata VALUES (?, 1, ?, ?)').run(
      'sess-desktop-live',
      JSON.stringify({
        id: 'sess-desktop-live',
        generation: 1,
        title: 'desktop 담당',
        cwd: projCwd,
        threadId: 'thread-desktop-live',
        projectId: 'proj-dev',
        projectAssigned: true,
        state: 'running',
        active: true,
      }),
      nowSec,
    );
    ddb.close();

    const relayInstallRoot = path.join(tmpRoot, 'relay-install-root');
    fs.cpSync(installRoot, relayInstallRoot, { recursive: true });

    const relayServer = createRemoteServer({
      mode: 'relay',
      token: 'tok-parity',
      hostSecret: 'sec-parity',
      workspaceDir: path.join(tmpRoot, 'relay-ws'),
      updateRootDir: relayInstallRoot,
      releaseApiUrl: 'https://mock.local/releases/latest',
      updateFetchFn: mockFetch,
      scheduleRestartOnUpdate: false,
      allowPathDiscovery: false,
    });
    const relayPort = await new Promise<number>(resolve => {
      relayServer.server.listen(0, '127.0.0.1', () => {
        const addr = relayServer.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    const relayBase = `http://127.0.0.1:${relayPort}`;

    let hostRegisteredResolve!: () => void;
    const hostRegistered = new Promise<void>(r => { hostRegisteredResolve = r; });
    const connector = startHostConnector({
      relayUrl: relayBase,
      hostSecret: 'sec-parity',
      workspaceDir: path.join(tmpRoot, 'host-ws'),
      desktopDbPath,
      codexHomeDir: codexHome,
      updateRootDir: installRoot,
      releaseApiUrl: 'https://mock.local/releases/latest',
      updateFetchFn: mockFetch,
      scheduleRestartOnUpdate: false,
      spawnProcess: false,
      allowPathDiscovery: false,
      silent: true,
      onRegistered: () => hostRegisteredResolve(),
    });

    try {
      await hostRegistered;
      const invokeRelay = async (cmd: string, args: Record<string, unknown> = {}) => {
        const res = await fetch(`${relayBase}/api/invoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok-parity',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command: cmd, args }),
        });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.ok, true);
        return body.result;
      };

      // A. D-0008: Session with commentary message + custom_tool_call is 'running', NOT 'idle'!
      const sessionsList = await invokeRelay('list_sessions');
      assert.equal(sessionsList.length, 1);
      assert.equal(sessionsList[0].id, 'sess-desktop-live');
      assert.equal(sessionsList[0].state, 'running');

      // B. Desktop Parity: contextStatus returns last_token_usage.total_tokens (176700 / 285000 = 62%) and connected=true
      const ctxStatus = await invokeRelay('conversation_request', {
        id: 'sess-desktop-live',
        generation: 1,
        request: { type: 'contextStatus' },
      });
      assert.equal(ctxStatus.connected, true);
      assert.equal(ctxStatus.tokenUsageFresh, true);
      assert.equal(ctxStatus.usedTokens, 176700);
      assert.equal(ctxStatus.modelContextWindow, 285000);
      assert.equal(Math.round((ctxStatus.usedTokens / ctxStatus.modelContextWindow) * 100), 62);
      assert.equal(ctxStatus.passiveSubscriptionSupported, true);
      assert.equal(ctxStatus.subagentsSupported, true);
      assert.equal(ctxStatus.compactSupported, true);

      // C. Desktop Parity: weekly_usage reads rate_limits from rollout when app-server is not connected
      const weekly = await invokeRelay('weekly_usage', { manual: true });
      assert.equal(weekly.weekly.usedPercent, 90);
      assert.equal(weekly.weekly.resetsAt, 1794379004);

      // D. Desktop Parity: subagents_request returns connected=true and valid parentRuntimeId
      const subagents = await invokeRelay('subagents_request', {
        id: 'sess-desktop-live',
        generation: 1,
        request: { type: 'list' },
      });
      assert.equal(subagents.supported, true);
      assert.equal(subagents.connected, true);
      assert.equal(typeof subagents.parentRuntimeId, 'string');

      // D-0009: conversation_request attach & poll and cron_request list return connected=true for mirrored sessions even without live app-server
      const convAttach = await invokeRelay('conversation_request', {
        id: 'sess-desktop-live',
        generation: 1,
        request: { type: 'attach' },
      });
      assert.equal(convAttach.attached, true);
      assert.equal(convAttach.connected, true);

      const convPoll = await invokeRelay('conversation_request', {
        id: 'sess-desktop-live',
        generation: 1,
        request: { type: 'poll' },
      });
      assert.equal(convPoll.connected, true);

      const cronList = await invokeRelay('cron_request', {
        id: 'sess-desktop-live',
        generation: 1,
        request: { type: 'list' },
      });
      assert.equal(cronList.supported, true);
      assert.equal(cronList.connected, true);

      // E. T-0003: check_for_updates and apply_update across Relay + Host Connector
      const updateCheck = await invokeRelay('check_for_updates');
      assert.equal(updateCheck.updateAvailable, true);
      assert.equal(updateCheck.latestVersion, '9.9.9');
      assert.equal(updateCheck.relayVersion, '1.1.0');
      assert.equal(updateCheck.hostVersion, '1.1.0');

      const updateApplied = await invokeRelay('apply_update', { target: 'both' });
      assert.equal(updateApplied.updated, true);
      assert.equal(updateApplied.version, '9.9.9');
      assert.equal(updateApplied.relay.updated, true);
      assert.equal(updateApplied.host.updated, true);

      const updatedHostPkg = JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
      const updatedRelayPkg = JSON.parse(fs.readFileSync(path.join(relayInstallRoot, 'package.json'), 'utf8'));
      assert.equal(updatedHostPkg.version, '9.9.9');
      assert.equal(updatedRelayPkg.version, '9.9.9');
    } finally {
      await connector.close();
      await relayServer.close();
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});
