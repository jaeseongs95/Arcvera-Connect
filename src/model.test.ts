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
    JSON.stringify({ timestamp: '2026-11-08T02:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: `Process exited with code 0\nOutput:\nM src/main.ts\n${hugeOutput}` } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:06Z', type: 'event_msg', payload: { type: 'agent_message', message: '작업을 재개했습니다.' } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:07Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 120000 }, last_token_usage: { total_tokens: 228000 }, model_context_window: 380000 } } }),
    JSON.stringify({ timestamp: '2026-11-08T02:00:08Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
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
    assert.equal(pageRes.data.length >= 1, true);

    const itemsRes = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'items', turnId: pageRes.data[0].id },
    });
    assert.equal(itemsRes.items.some((it: any) => it.type === 'userMessage' && it.text.includes('중단된 지점부터')), true);
    const cmdItem = itemsRes.items.find((it: any) => it.type === 'commandExecution');
    assert.equal(Boolean(cmdItem), true);
    assert.equal(cmdItem.truncated, true);
    assert.equal(cmdItem.aggregatedOutput.length, 16384);

    const detailRes = await relayInvoke('conversation_request', {
      id: 'sess-desktop',
      generation: 1,
      request: { type: 'detail', turnId: pageRes.data[0].id, itemId: cmdItem.id, offset: 16384 },
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
