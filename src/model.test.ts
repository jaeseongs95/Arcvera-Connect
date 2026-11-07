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
  const { injectRemoteFlag, verifyToken, createRemoteServer } = await import('../server/remote-server.mjs');

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

  const instance = createRemoteServer({
    workspaceDir: path.join(tmpRoot, 'workspace'),
    token: 'test-token-xyz',
    embeddedOnly: true,
  });

  await new Promise<void>(resolve => instance.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = instance.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { ok: true, service: 'opendiy-remote' });

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

    const chosenFolder = await invoke('choose_project_folder', { path: projDir });
    assert.equal(chosenFolder, projDir);
    const chosenProj = await invoke('choose_project', { cwd: projDir });
    assert.equal(chosenProj.id, imported.id);
    assert.equal(await invoke('open_external_url', { url: 'https://github.com/jaeseongs95/opendiy-remote' }), null);
    await assert.rejects(() => invoke('open_external_url', { url: 'javascript:alert(1)' }));

    await invoke('session_stop', { id: started.id, generation: started.generation });
    const remaining = await invoke('list_sessions');
    assert.equal(remaining.length, 0);
  } finally {
    await instance.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
