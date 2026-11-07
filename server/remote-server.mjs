import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const REMOTE_SCRIPT_TAG = '<script>window.__OPENDIY_REMOTE__=true;</script>';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

export function injectRemoteFlag(html) {
  if (html.includes('__OPENDIY_REMOTE__')) return html;
  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertAt = headIdx + '<head>'.length;
    return html.slice(0, insertAt) + REMOTE_SCRIPT_TAG + html.slice(insertAt);
  }
  return REMOTE_SCRIPT_TAG + html;
}

export function verifyToken(expectedSha256, provided) {
  if (!expectedSha256) return true;
  if (typeof provided !== 'string' || !provided.trim()) return false;
  const actual = crypto.createHash('sha256').update(provided.trim(), 'utf8').digest();
  return actual.length === expectedSha256.length && crypto.timingSafeEqual(actual, expectedSha256);
}

function findExecutableInPath(names) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // Ignore missing path entries.
      }
    }
  }
  return null;
}

function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function resolveCodexBinary(savedPath, allowPathDiscovery = true) {
  if (savedPath) {
    try {
      if (fs.statSync(savedPath).isFile()) {
        return { savedPath, resolvedPath: savedPath, source: 'saved', error: null };
      }
      return { savedPath, resolvedPath: null, source: 'unavailable', error: `지정한 실행 파일을 찾을 수 없습니다: ${savedPath}` };
    } catch (err) {
      return { savedPath, resolvedPath: null, source: 'unavailable', error: String(err.message || err) };
    }
  }
  const envPath = process.env.OPENDIY_CODEX_BIN || process.env.CODEX_EXECUTABLE;
  if (envPath) {
    try {
      if (fs.statSync(envPath).isFile()) {
        return { savedPath: null, resolvedPath: envPath, source: 'environment', error: null };
      }
    } catch {
      // Fall through to PATH discovery.
    }
  }
  if (!allowPathDiscovery) {
    return { savedPath: null, resolvedPath: null, source: 'unavailable', error: null };
  }
  const codexHome = getCodexHome();
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const managedCandidates = [
    path.join(codexHome, 'packages', 'standalone', 'current', 'bin', exeName),
    path.join(codexHome, 'packages', 'standalone', 'current', exeName),
  ];
  for (const candidate of managedCandidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return { savedPath: null, resolvedPath: candidate, source: 'managed', error: null };
      }
    } catch {
      // Continue searching.
    }
  }
  const names = process.platform === 'win32'
    ? ['opendiy-codex-launcher.exe', 'codex.exe']
    : ['opendiy-codex-launcher', 'codex'];
  const fromPath = findExecutableInPath(names);
  if (fromPath) {
    return { savedPath: null, resolvedPath: fromPath, source: 'path', error: null };
  }
  return { savedPath: null, resolvedPath: null, source: 'unavailable', error: 'Codex 실행 파일을 찾을 수 없습니다.' };
}

function resolveAppServerBinary(savedServerPath, cliResolvedPath) {
  if (savedServerPath) {
    try {
      if (fs.statSync(savedServerPath).isFile()) {
        return {
          savedPath: savedServerPath,
          resolvedPath: savedServerPath,
          source: 'saved',
          error: null,
          kind: savedServerPath.toLowerCase().includes('app-server') ? 'standalone' : 'cli',
        };
      }
      return {
        savedPath: savedServerPath,
        resolvedPath: null,
        source: 'unavailable',
        error: `지정한 앱 서버 실행 파일을 찾을 수 없습니다: ${savedServerPath}`,
        kind: 'standalone',
      };
    } catch (err) {
      return { savedPath: savedServerPath, resolvedPath: null, source: 'unavailable', error: String(err.message || err), kind: 'standalone' };
    }
  }
  if (cliResolvedPath) {
    const dir = path.dirname(cliResolvedPath);
    const siblingName = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
    const sibling = path.join(dir, siblingName);
    try {
      if (fs.statSync(sibling).isFile()) {
        return { savedPath: null, resolvedPath: sibling, source: 'sibling', error: null, kind: 'standalone' };
      }
    } catch {
      // Fall back to CLI subcommand `app-server`.
    }
    return { savedPath: null, resolvedPath: cliResolvedPath, source: 'cli', error: null, kind: 'cli' };
  }
  return { savedPath: null, resolvedPath: null, source: 'unavailable', error: null, kind: 'cli' };
}

function readExecutableVersion(binPath) {
  if (!binPath) return null;
  try {
    return execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function scanSkillsInDir(baseDir, scope) {
  const results = [];
  if (!baseDir || !fs.existsSync(baseDir)) return results;
  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(baseDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf8');
      const nameMatch = /^name:\s*(.+)$/m.exec(content);
      const descMatch = /^description:\s*(.+)$/m.exec(content);
      results.push({
        id: `${scope}:${entry.name}`,
        name: (nameMatch ? nameMatch[1] : entry.name).trim(),
        description: (descMatch ? descMatch[1] : '').trim(),
        path: skillMd,
        scope,
        enabled: true,
      });
    }
  } catch {
    // Ignore unreadable skill directories.
  }
  return results;
}

function scanCodexExtensions(cwd) {
  const codexHome = getCodexHome();
  const skills = [
    ...scanSkillsInDir(path.join(codexHome, 'skills'), 'user'),
    ...(cwd ? scanSkillsInDir(path.join(cwd, '.codex', 'skills'), 'workspace') : []),
  ];
  const plugins = [];
  const pluginsDir = path.join(codexHome, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        plugins.push({
          id: entry.name,
          name: entry.name,
          enabled: true,
          path: path.join(pluginsDir, entry.name),
        });
      }
    } catch {
      // Ignore unreadable plugin directories.
    }
  }
  return {
    plugins,
    marketplace: [],
    skills,
    hooks: [],
    warnings: [],
  };
}

class AppServerBridge {
  constructor(getSettings, onNotification, customTransport = null) {
    this.getSettings = getSettings;
    this.onNotification = onNotification;
    this.customTransport = customTransport;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.serverInfo = null;
    this.starting = null;
  }

  isConnected() {
    return Boolean(this.customTransport || (this.proc && this.initialized));
  }

  async ensureStarted() {
    if (this.customTransport) {
      if (!this.initialized) {
        this.serverInfo = (await this.customTransport('initialize', {
          clientInfo: { name: 'opendiy-remote', title: 'OpenDIY Remote', version: '1.3.2' },
          capabilities: { experimentalApi: true, requiredHumanApproval: true },
        })) || {};
        this.initialized = true;
      }
      return this.serverInfo;
    }
    if (this.proc && this.initialized) return this.serverInfo;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    const settings = this.getSettings();
    const server = settings.appServer;
    if (!server.resolvedPath) {
      this.proc = null;
      this.initialized = false;
      this.serverInfo = null;
      return null;
    }

    try {
      const args = server.kind === 'standalone' ? ['--listen', 'stdio://'] : ['app-server', '--listen', 'stdio://'];
      const child = spawn(server.resolvedPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = child;
      this.initialized = false;

      child.on('error', () => {
        if (this.proc === child) {
          this.proc = null;
          this.initialized = false;
        }
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const entry = this.pending.get(msg.id);
            if (entry) {
              this.pending.delete(msg.id);
              clearTimeout(entry.timer);
              if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else entry.resolve(msg.result);
            }
            return;
          }
          if (msg.method) {
            this.onNotification(msg);
          }
        } catch {
          // Ignore non-JSON diagnostic lines.
        }
      });

      child.on('exit', () => {
        if (this.proc === child) {
          this.proc = null;
          this.initialized = false;
          for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('Codex app-server 프로세스가 종료되었습니다.'));
          }
          this.pending.clear();
        }
      });

      const initResult = await this.rawRequest('initialize', {
        clientInfo: { name: 'opendiy-remote', title: 'OpenDIY Remote', version: '1.3.2' },
        capabilities: { experimentalApi: true, requiredHumanApproval: true },
      }, 8000);
      this.sendNotification('initialized', {});
      this.initialized = true;
      this.serverInfo = initResult || {};
      return this.serverInfo;
    } catch (err) {
      this.shutdown();
      throw err;
    }
  }

  sendNotification(method, params = {}) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  sendResponse(id, result) {
    if (this.customTransport) return;
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  rawRequest(method, params = {}, timeoutMs = 15000) {
    if (this.customTransport) {
      return Promise.resolve(this.customTransport(method, params));
    }
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error('Codex app-server가 실행 중이지 않습니다.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 요청 시간 초과 (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async request(method, params = {}, timeoutMs = 15000) {
    await this.ensureStarted();
    if (!this.isConnected()) {
      throw new Error('Codex app-server에 연결할 수 없습니다. 실행 파일 설정을 확인하세요.');
    }
    return this.rawRequest(method, params, timeoutMs);
  }

  shutdown() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // Ignore kill error on exit.
      }
      this.proc = null;
      this.initialized = false;
    }
  }
}

export function createRemoteServer(options = {}) {
  const workspaceDir = path.resolve(
    options.workspaceDir ||
      process.env.OPENDIY_REMOTE_DATA_DIR ||
      process.env.AGENT_GRID_WORKSPACE_DIR ||
      path.join(os.tmpdir(), 'opendiy-remote-workspace'),
  );
  const distDir = path.resolve(options.distDir || process.env.OPENDIY_REMOTE_DIST || path.join(ROOT_DIR, 'dist'));
  const rawToken = options.token ?? process.env.OPENDIY_REMOTE_TOKEN ?? '';
  const tokenSha256 = rawToken.trim()
    ? crypto.createHash('sha256').update(rawToken.trim(), 'utf8').digest()
    : null;

  fs.mkdirSync(workspaceDir, { recursive: true });
  const attachmentsDir = path.join(workspaceDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const stateFile = path.join(workspaceDir, 'workspace-state.json');

  const defaultState = {
    uiLanguage: 'ko',
    codexSavedPath: null,
    appServerSavedPath: null,
    layout: { version: 1, columns: 2, columnSizes: [1, 1], rowSizes: [1, 1], sessions: [] },
    projects: [],
    savedCrons: [],
    threads: {},
  };

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) {
        return { ...defaultState, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
      }
    } catch {
      // Return default state if corrupted.
    }
    return structuredClone(defaultState);
  }

  const state = loadState();
  function persistState() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Ignore write errors in read-only environments.
    }
  }

  const sseClients = new Set();
  function broadcast(event, payload) {
    const frame = `data: ${JSON.stringify({ event, payload })}\n\n`;
    for (const res of [...sseClients]) {
      if (res.writableEnded || res.destroyed || res.writableLength > MAX_SSE_BUFFER_BYTES) {
        try { res.end(); } catch {}
        sseClients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  const sessions = new Map();
  const sessionProcesses = new Map();
  const pendingQuestions = new Map();
  let sessionSeq = 1;

  const allowPathDiscovery = options.allowPathDiscovery !== false && process.env.OPENDIY_REMOTE_NO_PATH_DISCOVERY !== '1';
  function computeSettings() {
    const cli = resolveCodexBinary(state.codexSavedPath, allowPathDiscovery);
    const appServer = resolveAppServerBinary(state.appServerSavedPath, cli.resolvedPath);
    return {
      savedPath: cli.savedPath,
      resolvedPath: cli.resolvedPath,
      source: cli.source,
      error: cli.error,
      appServer,
    };
  }

  function handleServerNotification(notification) {
    for (const session of sessions.values()) {
      const threadId = notification.params?.threadId || notification.params?.thread?.id || session.threadId;
      if (threadId && session.threadId === threadId) {
        session.events = session.events || [];
        session.eventSeq = (session.eventSeq || 0) + 1;
        const entry = {
          seq: session.eventSeq,
          method: notification.method,
          params: notification.params || {},
          ...(notification.id !== undefined ? { requestId: String(notification.id), responded: false } : {}),
        };
        session.events.push(entry);
        if (notification.method === 'item/agentMessage/delta' && notification.params?.delta) {
          emitTerminalOutput(session, String(notification.params.delta));
        }
        if (notification.id !== undefined) {
          pendingQuestions.set(`${session.id}:${notification.id}`, {
            sessionId: session.id,
            generation: session.generation,
            threadId: session.threadId,
            requestId: String(notification.id),
            rpcId: notification.id,
            method: notification.method,
            params: notification.params || {},
          });
        }
      }
    }
  }

  const appServerBridge = new AppServerBridge(
    computeSettings,
    handleServerNotification,
    options.rpcTransport || null,
  );

  function emitTerminalOutput(session, text) {
    session.seq = (session.seq || 0) + 1;
    broadcast('terminal-output', {
      id: session.id,
      generation: session.generation,
      seq: session.seq,
      data: text,
    });
  }

  function publicSessionInfo(session) {
    return {
      id: session.id,
      generation: session.generation,
      title: session.title,
      cwd: session.cwd,
      threadId: session.threadId || null,
      projectId: session.projectId ?? null,
      projectAssigned: Boolean(session.projectAssigned),
      state: session.state,
      active: session.active,
    };
  }

  async function syncThreadFromServer(session) {
    let threadId = session.threadId;
    if (appServerBridge.isConnected() || options.rpcTransport || computeSettings().appServer.resolvedPath) {
      try {
        await appServerBridge.ensureStarted();
        if (appServerBridge.isConnected()) {
          if (!threadId) {
            const started = await appServerBridge.request('thread/start', { cwd: session.cwd });
            if (started?.thread?.id) {
              threadId = String(started.thread.id);
              session.threadId = threadId;
            }
          } else {
            try {
              const readRes = await appServerBridge.request('thread/read', { threadId, includeTurns: true });
              if (readRes?.thread) {
                state.threads[threadId] = {
                  ...(state.threads[threadId] || {}),
                  ...readRes.thread,
                  id: threadId,
                  cwd: readRes.thread.cwd || session.cwd,
                };
              }
            } catch {
              const started = await appServerBridge.request('thread/start', { cwd: session.cwd });
              if (started?.thread?.id) {
                threadId = String(started.thread.id);
                session.threadId = threadId;
              }
            }
          }
        }
      } catch {
        // Preserve existing thread state if app-server is not yet reachable.
      }
    }
    if (!threadId) {
      threadId = crypto.randomUUID();
      session.threadId = threadId;
    }
    if (!state.threads[threadId]) {
      state.threads[threadId] = {
        id: threadId,
        title: session.title,
        cwd: session.cwd,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        model: null,
        effort: null,
        modelContextWindow: null,
        usedTokens: 0,
        turns: [],
        memorySummary: null,
        readState: { firstUnread: null, revision: 'rev-1' },
      };
    }
    return state.threads[threadId];
  }

  async function queryServerModels(cursor = null) {
    try {
      await appServerBridge.ensureStarted();
      if (appServerBridge.isConnected()) {
        const rpcRes = await appServerBridge.request('model/list', { cursor });
        if (Array.isArray(rpcRes?.data)) {
          return { models: rpcRes.data, nextCursor: rpcRes.nextCursor ?? null };
        }
      }
    } catch {
      // Return empty model list when app-server is unavailable.
    }
    return { models: [], nextCursor: null };
  }

  async function handleConversationRequest(session, request) {
    const type = request?.type;
    const thread = await syncThreadFromServer(session);
    const threadId = thread.id;

    if (type === 'models') {
      return queryServerModels(request.cursor ?? null);
    }

    if (type === 'attach' || type === 'refresh' || type === 'turns' || type === 'poll' || type === 'page' || !type) {
      const { models } = await queryServerModels(null);
      if (appServerBridge.isConnected()) {
        try {
          await appServerBridge.request('thread/subscribePassive', { threadId });
        } catch {
          // Passive subscription is optional depending on server version.
        }
      }
      const caps = appServerBridge.serverInfo?.opendiyCapabilities || {};
      return {
        attached: true,
        connected: appServerBridge.isConnected(),
        threadId,
        model: thread.model ?? null,
        effort: thread.effort ?? null,
        models,
        capabilities: {
          passiveSubscription: Boolean(caps.passiveSubscription ?? true),
          userTurnStartIfIdle: Boolean(caps.userTurnStartIfIdle ?? true),
          compactStartIfIdle: Boolean(caps.compactStartIfIdle ?? true),
          historySummary: Boolean(caps.historySummary ?? true),
          expectedTurnInterrupt: Boolean(appServerBridge.serverInfo?.supportsExpectedTurnInterrupt ?? true),
        },
        turns: Array.isArray(thread.turns) ? thread.turns.slice(-20) : [],
        nextCursor: null,
        events: session.events || [],
        readState: thread.readState || { firstUnread: null, revision: 'rev-1' },
      };
    }

    if (type === 'items') {
      const turn = (thread.turns || []).find(t => t.id === request.turnId);
      return {
        turnId: request.turnId,
        items: turn ? turn.items || [] : [],
        nextCursor: null,
      };
    }

    if (type === 'detail') {
      const turn = (thread.turns || []).find(t => t.id === request.turnId);
      const item = (turn?.items || []).find(i => i.id === request.itemId);
      const fullText = String(item?.text ?? '');
      const offset = Number(request.offset || 0);
      return {
        turnId: request.turnId,
        itemId: request.itemId,
        text: fullText.slice(offset, offset + 16384),
        totalBytes: Buffer.byteLength(fullText, 'utf8'),
        nextOffset: offset + 16384 < fullText.length ? offset + 16384 : null,
      };
    }

    if (type === 'detach' || type === 'handoffToTerminal') {
      return { attached: false };
    }

    if (type === 'send') {
      const text = String(request.text ?? request.prompt ?? '').trim();
      if (!text) throw new Error('전송할 메시지를 입력하세요.');
      const inputItems = [{ type: 'text', text }];
      if (Array.isArray(request.attachments)) {
        for (const att of request.attachments) {
          if (att?.path) {
            inputItems.push({ type: att.type === 'localImage' ? 'localImage' : 'file', path: String(att.path) });
          }
        }
      }

      const rpcRes = await appServerBridge.request('turn/start', {
        threadId,
        input: inputItems,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      });

      const turnId = String(rpcRes?.turn?.id || crypto.randomUUID());
      const items = Array.isArray(rpcRes?.turn?.items)
        ? rpcRes.turn.items
        : [{ id: `item-u-${turnId}`, role: 'user', text, status: 'completed' }];
      const turn = {
        id: turnId,
        status: String(rpcRes?.turn?.status || 'completed'),
        createdAt: Math.floor(Date.now() / 1000),
        items,
      };
      thread.turns = thread.turns || [];
      thread.turns.push(turn);
      thread.updatedAt = Math.floor(Date.now() / 1000);
      persistState();
      return {
        turnId,
        status: turn.status,
        turns: thread.turns.slice(-20),
        items: turn.items,
      };
    }

    if (type === 'interrupt') {
      const rpcRes = await appServerBridge.request('turn/interrupt', {
        threadId,
        ...(request.turnId ? { turnId: request.turnId } : {}),
      });
      return rpcRes || { interrupted: true };
    }

    if (type === 'compact') {
      const rpcRes = await appServerBridge.request('thread/compact/startIfIdle', { threadId });
      return rpcRes || { started: true };
    }

    if (type === 'contextStatus') {
      if (appServerBridge.isConnected()) {
        try {
          const readRes = await appServerBridge.request('thread/read', { threadId, includeTurns: false });
          if (readRes?.thread) {
            thread.usedTokens = Number(readRes.thread.tokenUsage?.totalTokens ?? thread.usedTokens ?? 0);
            thread.modelContextWindow = readRes.thread.modelContextWindow ?? thread.modelContextWindow ?? null;
          }
        } catch {
          // Use cached thread values if read fails.
        }
      }
      return {
        supported: appServerBridge.isConnected(),
        usedTokens: Number(thread.usedTokens || 0),
        modelContextWindow: thread.modelContextWindow ?? null,
        canCompactIfIdle: Boolean(appServerBridge.serverInfo?.opendiyCapabilities?.compactStartIfIdle ?? appServerBridge.isConnected()),
        idle: session.state === 'idle',
      };
    }

    if (type === 'contextSettings') {
      return {
        modelContextWindow: thread.modelContextWindow ?? null,
        minModelContextWindow: 16000,
        maxModelContextWindow: 1000000,
      };
    }

    if (type === 'setContextWindow') {
      const nextWindow = request.modelContextWindow === null ? null : Number(request.modelContextWindow);
      if (nextWindow !== null && (!Number.isFinite(nextWindow) || nextWindow < 1024)) {
        throw new Error('유효한 컨텍스트 크기를 입력하세요.');
      }
      if (appServerBridge.isConnected()) {
        await appServerBridge.request('thread/contextWindow/set', {
          threadId,
          modelContextWindow: nextWindow,
          expectedModelContextWindow: request.expectedModelContextWindow ?? thread.modelContextWindow ?? null,
        });
      }
      thread.modelContextWindow = nextWindow;
      persistState();
      return { modelContextWindow: thread.modelContextWindow };
    }

    if (type === 'respond') {
      const key = `${session.id}:${request.requestId}`;
      const pending = pendingQuestions.get(key);
      if (pending) {
        pendingQuestions.delete(key);
        appServerBridge.sendResponse(pending.rpcId, request.result);
      }
      return { responded: true };
    }

    throw new Error(`지원하지 않는 대화 요청 유형입니다: ${type}`);
  }

  async function dispatchCommand(command, args = {}) {
    switch (command) {
      case 'get_ui_language':
        return state.uiLanguage || 'ko';
      case 'set_ui_language': {
        const lang = args.language === 'en' ? 'en' : 'ko';
        state.uiLanguage = lang;
        persistState();
        return {
          show: lang === 'en' ? 'Open OpenDIY Remote' : 'OpenDIY Remote 열기',
          exit: lang === 'en' ? 'Exit…' : '종료…',
        };
      }
      case 'prepare_runtime': {
        const settings = computeSettings();
        if (settings.appServer.resolvedPath || options.rpcTransport) {
          await appServerBridge.ensureStarted();
        }
        return null;
      }
      case 'get_codex_settings':
        return computeSettings();
      case 'set_codex_executable': {
        const nextPath = args.path ? String(args.path).trim() : null;
        if (nextPath && (!path.isAbsolute(nextPath) || !fs.existsSync(nextPath) || !fs.statSync(nextPath).isFile())) {
          throw new Error(`유효한 실행 파일 절대 경로가 아닙니다: ${nextPath}`);
        }
        state.codexSavedPath = nextPath || null;
        persistState();
        return computeSettings();
      }
      case 'set_app_server_executable': {
        const nextPath = args.path ? String(args.path).trim() : null;
        if (nextPath && (!path.isAbsolute(nextPath) || !fs.existsSync(nextPath) || !fs.statSync(nextPath).isFile())) {
          throw new Error(`유효한 앱 서버 실행 파일 절대 경로가 아닙니다: ${nextPath}`);
        }
        state.appServerSavedPath = nextPath || null;
        persistState();
        return computeSettings();
      }
      case 'runtime_compatibility': {
        const settings = computeSettings();
        const cliVersion = readExecutableVersion(settings.resolvedPath);
        const selectedServerVersion = readExecutableVersion(settings.appServer.resolvedPath) || cliVersion;
        if (settings.appServer.resolvedPath || options.rpcTransport) {
          try { await appServerBridge.ensureStarted(); } catch {}
        }
        const caps = appServerBridge.serverInfo?.opendiyCapabilities || {};
        return {
          executable: settings.resolvedPath,
          cliVersion,
          selectedServerExecutable: settings.appServer.resolvedPath,
          selectedServerVersion,
          serverVersion: appServerBridge.serverInfo?.userAgent || selectedServerVersion,
          serverState: appServerBridge.isConnected() ? 'running' : 'stopped',
          subagents: Boolean(appServerBridge.serverInfo?.supportsSubagentManagement),
          compactIfIdle: Boolean(caps.compactStartIfIdle),
          expectedTurnInterrupt: Boolean(appServerBridge.serverInfo?.supportsExpectedTurnInterrupt),
        };
      }
      case 'runtime_pair_status':
      case 'runtime_transition_preview': {
        const settings = computeSettings();
        const cliVersion = readExecutableVersion(settings.resolvedPath);
        const selectedServerVersion = readExecutableVersion(settings.appServer.resolvedPath) || cliVersion;
        const matched = Boolean(cliVersion && selectedServerVersion && cliVersion === selectedServerVersion);
        const pair = {
          cliVersion,
          selectedServerExecutable: settings.appServer.resolvedPath,
          selectedServerVersion,
          managedCliExecutable: settings.resolvedPath,
          managedVersion: cliVersion,
          runningVersion: appServerBridge.serverInfo?.userAgent || selectedServerVersion,
          socketPath: null,
          state: !cliVersion ? 'unavailable' : matched ? 'matched' : 'mismatched',
          message: !cliVersion ? 'Codex 실행 파일을 찾을 수 없습니다.' : null,
        };
        if (command === 'runtime_pair_status') return pair;
        return {
          pair,
          canApply: Boolean(settings.resolvedPath && !matched),
          reason: matched ? null : '선택한 실행 파일로 서버 구성을 동기화할 수 있습니다.',
          fingerprint: crypto.createHash('sha256').update(`${settings.resolvedPath || ''}:${cliVersion || ''}`).digest('hex'),
          packageRoot: settings.resolvedPath ? path.dirname(settings.resolvedPath) : null,
        };
      }
      case 'apply_runtime_transition': {
        if (!args.confirmed) {
          throw new Error('서버 전환 확인이 필요합니다.');
        }
        const settings = computeSettings();
        if (!settings.resolvedPath) {
          throw new Error('전환할 Codex 실행 파일이 설정되어 있지 않습니다.');
        }
        appServerBridge.shutdown();
        await appServerBridge.ensureStarted();
        return { status: 'updated', success: true, outcome: 'updated', message: null };
      }
      case 'load_layout':
        return state.layout;
      case 'save_layout':
        if (args.layout && typeof args.layout === 'object') {
          state.layout = args.layout;
          persistState();
        }
        return null;
      case 'list_projects':
        return state.projects;
      case 'import_project': {
        const cwd = String(args.cwd ?? '').trim();
        if (!cwd || !path.isAbsolute(cwd)) {
          throw new Error('실제로 존재하는 절대 디렉터리 경로를 입력하세요.');
        }
        let stat;
        try {
          stat = fs.statSync(cwd);
        } catch {
          throw new Error(`프로젝트 폴더를 찾을 수 없습니다: ${cwd}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`지정한 경로가 디렉터리가 아닙니다: ${cwd}`);
        }
        const existing = state.projects.find(p => typeof p.cwd === 'string' && p.cwd.toLowerCase() === cwd.toLowerCase());
        if (existing) return existing;
        const project = {
          id: crypto.randomUUID(),
          name: path.basename(cwd) || cwd,
          cwd,
          createdAt: Math.floor(Date.now() / 1000),
          favorite: false,
        };
        state.projects.push(project);
        persistState();
        return project;
      }
      case 'create_project': {
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('프로젝트 이름을 입력하세요.');
        const cwd = args.cwd ? String(args.cwd).trim() : null;
        if (cwd) {
          if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
            throw new Error(`유효한 프로젝트 폴더 경로가 아닙니다: ${cwd}`);
          }
        }
        const project = {
          id: crypto.randomUUID(),
          name,
          cwd: cwd || null,
          createdAt: Math.floor(Date.now() / 1000),
          favorite: false,
        };
        state.projects.push(project);
        persistState();
        return project;
      }
      case 'rename_project': {
        const project = state.projects.find(p => p.id === args.id);
        if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('프로젝트 이름을 입력하세요.');
        project.name = name;
        persistState();
        return project;
      }
      case 'set_project_favorite': {
        const project = state.projects.find(p => p.id === args.id);
        if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
        project.favorite = Boolean(args.favorite);
        persistState();
        return project;
      }
      case 'delete_project': {
        state.projects = state.projects.filter(p => p.id !== args.id);
        persistState();
        return null;
      }
      case 'reorder_project': {
        const idx = state.projects.findIndex(p => p.id === args.id);
        const targetIdx = state.projects.findIndex(p => p.id === (args.targetId ?? args.target_id));
        if (idx !== -1 && targetIdx !== -1 && idx !== targetIdx) {
          const [moved] = state.projects.splice(idx, 1);
          const insertAt = args.after ? targetIdx + (idx < targetIdx ? 0 : 1) : targetIdx - (idx < targetIdx ? 1 : 0);
          state.projects.splice(Math.max(0, insertAt), 0, moved);
          persistState();
        }
        return state.projects;
      }
      case 'start_session': {
        const req = args.request || {};
        const title = String(req.title ?? '').trim() || `세션 ${sessionSeq++}`;
        const cwd = String(req.cwd ?? '').trim();
        if (!cwd || !path.isAbsolute(cwd)) {
          throw new Error('프로젝트 경로는 절대 경로여야 합니다.');
        }
        let stat;
        try {
          stat = fs.statSync(cwd);
        } catch {
          throw new Error(`프로젝트 경로를 찾을 수 없습니다: ${cwd}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`프로젝트 경로가 디렉터리가 아닙니다: ${cwd}`);
        }
        const id = crypto.randomUUID();
        const session = {
          id,
          generation: 1,
          title,
          cwd,
          threadId: req.threadId ? String(req.threadId) : null,
          projectId: req.projectId ?? null,
          projectAssigned: Boolean(req.projectAssigned || req.projectId !== undefined),
          state: 'idle',
          active: true,
          cols: Number(req.cols) || 100,
          rows: Number(req.rows) || 30,
          seq: 0,
          events: [],
          eventSeq: 0,
        };
        await syncThreadFromServer(session);
        sessions.set(id, session);
        persistState();

        const info = publicSessionInfo(session);
        broadcast('session-changed', info);

        const settings = computeSettings();
        const shouldSpawnProcess = options.spawnProcess !== false;
        if (shouldSpawnProcess) {
          const cmdBin = settings.resolvedPath && options.useCodexCli
            ? settings.resolvedPath
            : process.platform === 'win32'
              ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
              : '/bin/sh';
          const cmdArgs = settings.resolvedPath && options.useCodexCli
            ? ['--cd', cwd]
            : process.platform === 'win32'
              ? ['-NoLogo', '-NoProfile', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::WriteLine("[OpenDIY Remote] " + $env:OPENDIY_SESSION_TITLE + " (" + $env:OPENDIY_SESSION_CWD + ")")']
              : ['-c', 'printf "[OpenDIY Remote] %s (%s)\\n" "$OPENDIY_SESSION_TITLE" "$OPENDIY_SESSION_CWD"'];
          try {
            const child = spawn(cmdBin, cmdArgs, {
              cwd,
              env: {
                ...process.env,
                OPENDIY_SESSION_TITLE: title,
                OPENDIY_SESSION_CWD: cwd,
              },
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });
            sessionProcesses.set(id, child);
            child.stdout.on('data', chunk => {
              if (sessions.has(id)) emitTerminalOutput(session, chunk.toString('utf8'));
            });
            child.stderr.on('data', chunk => {
              if (sessions.has(id)) emitTerminalOutput(session, chunk.toString('utf8'));
            });
            child.on('exit', () => {
              sessionProcesses.delete(id);
            });
          } catch (err) {
            emitTerminalOutput(session, `${err.message || err}\r\n`);
          }
        }
        return info;
      }
      case 'list_sessions':
        return [...sessions.values()].map(publicSessionInfo);
      case 'session_write': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('세션을 찾을 수 없거나 세대가 일치하지 않습니다.');
        }
        const data = String(args.data ?? '');
        const proc = sessionProcesses.get(session.id);
        if (proc && proc.stdin && proc.stdin.writable) {
          proc.stdin.write(data.replace(/\r/g, '\r\n'));
        } else {
          emitTerminalOutput(session, data);
        }
        return null;
      }
      case 'session_resize': {
        const session = sessions.get(args.id);
        if (session && session.generation === Number(args.generation)) {
          session.cols = Number(args.cols) || session.cols;
          session.rows = Number(args.rows) || session.rows;
        }
        return null;
      }
      case 'session_stop': {
        const session = sessions.get(args.id);
        if (session && session.generation === Number(args.generation)) {
          session.state = 'stopped';
          session.active = false;
          const proc = sessionProcesses.get(session.id);
          if (proc) {
            try { proc.kill(); } catch {}
            sessionProcesses.delete(session.id);
          }
          broadcast('session-changed', publicSessionInfo(session));
          sessions.delete(session.id);
        }
        return null;
      }
      case 'session_output_ack':
        return null;
      case 'move_session_to_project': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('세션을 찾을 수 없습니다.');
        }
        session.projectId = (args.projectId ?? args.project_id) || null;
        session.projectAssigned = true;
        const info = publicSessionInfo(session);
        broadcast('session-changed', info);
        return info;
      }
      case 'list_external':
        return [];
      case 'catalog_list': {
        if (appServerBridge.isConnected()) {
          try {
            const rpcRes = await appServerBridge.request('thread/list', {
              cursor: args.request?.cursor ?? null,
              cwd: args.request?.cwd ?? undefined,
            });
            if (Array.isArray(rpcRes?.data)) {
              return {
                sessions: rpcRes.data,
                nextCursor: rpcRes.nextCursor ?? null,
              };
            }
          } catch {
            // Fall back to persisted workspace threads.
          }
        }
        const query = String(args.request?.query ?? '').trim().toLowerCase();
        const cwdFilter = args.request?.cwd ? String(args.request.cwd).toLowerCase() : null;
        const allThreads = Object.values(state.threads);
        const filtered = allThreads.filter(t => {
          if (cwdFilter && String(t.cwd || '').toLowerCase() !== cwdFilter) return false;
          if (query && !String(t.title || '').toLowerCase().includes(query) && !String(t.id || '').toLowerCase().includes(query)) return false;
          return true;
        });
        return {
          sessions: filtered.map(t => ({
            id: t.id,
            title: t.title,
            cwd: t.cwd,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            status: 'idle',
          })),
          nextCursor: null,
        };
      }
      case 'catalog_preview': {
        const threadId = String(args.threadId ?? args.thread_id ?? '');
        if (appServerBridge.isConnected() && threadId) {
          try {
            const readRes = await appServerBridge.request('thread/read', { threadId, includeTurns: true });
            if (Array.isArray(readRes?.thread?.turns)) {
              const messages = [];
              for (const turn of readRes.thread.turns) {
                for (const item of turn.items || []) {
                  messages.push({ role: item.role, text: item.text });
                }
              }
              return { messages, nextCursor: null };
            }
          } catch {
            // Fall back to local thread cache.
          }
        }
        const thread = state.threads[threadId];
        const messages = [];
        if (thread && Array.isArray(thread.turns)) {
          for (const turn of thread.turns) {
            for (const item of turn.items || []) {
              messages.push({ role: item.role, text: item.text });
            }
          }
        }
        return { messages, nextCursor: null };
      }
      case 'extensions_list': {
        const cwd = args.cwd ? String(args.cwd) : null;
        return scanCodexExtensions(cwd);
      }
      case 'extensions_mutate': {
        const cwd = args.cwd ? String(args.cwd) : null;
        if (appServerBridge.isConnected() && args.request) {
          await appServerBridge.request('extensions/mutate', { cwd, request: args.request });
        }
        return scanCodexExtensions(cwd);
      }
      case 'mobile_control': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('모바일 원격 제어 대상 세션을 찾을 수 없습니다.');
        }
        const action = String(args.action ?? 'status');
        if (appServerBridge.isConnected()) {
          const method = action === 'pair'
            ? 'remoteControl/pairing/start'
            : action === 'disable'
              ? 'remoteControl/disable'
              : action === 'enable'
                ? 'remoteControl/enable'
                : 'remoteControl/status';
          return appServerBridge.request(method, {});
        }
        throw new Error('Codex app-server가 연결되어 있지 않아 모바일 원격 제어를 실행할 수 없습니다.');
      }
      case 'subagents_request': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('하위 에이전트 대상 세션을 찾을 수 없습니다.');
        }
        const req = args.request || {};
        if (appServerBridge.isConnected()) {
          return appServerBridge.request(`subagent/${req.type || 'list'}`, {
            threadId: session.threadId,
            ...req,
          });
        }
        return { subagents: [], supported: false };
      }
      case 'cron_request': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('예약 요청 대상 세션을 찾을 수 없습니다.');
        }
        const req = args.request || {};
        if (appServerBridge.isConnected()) {
          return appServerBridge.request(`cron/${req.type || 'list'}`, {
            threadId: session.threadId,
            ...req,
          });
        }
        return { jobs: [], supported: false };
      }
      case 'saved_cron_list': {
        const threadId = String(args.threadId ?? args.thread_id ?? '');
        return state.savedCrons.filter(c => c.threadId === threadId);
      }
      case 'saved_cron_save': {
        const id = args.id ? String(args.id) : crypto.randomUUID();
        const threadId = String(args.threadId ?? args.thread_id ?? '');
        const prompt = String(args.prompt ?? '').trim();
        const schedule = args.schedule;
        const entry = {
          id,
          threadId,
          prompt,
          schedule,
          updatedAt: Math.floor(Date.now() / 1000),
        };
        const idx = state.savedCrons.findIndex(c => c.id === id);
        if (idx !== -1) state.savedCrons[idx] = entry;
        else state.savedCrons.push(entry);
        persistState();
        return entry;
      }
      case 'saved_cron_delete': {
        const id = String(args.id ?? '');
        state.savedCrons = state.savedCrons.filter(c => c.id !== id);
        persistState();
        return null;
      }
      case 'saved_cron_register': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('저장 예약을 등록할 세션을 찾을 수 없습니다.');
        }
        const defId = String(args.definitionId ?? args.definition_id ?? '');
        const saved = state.savedCrons.find(c => c.id === defId);
        if (!saved) throw new Error('저장된 예약 항목을 찾을 수 없습니다.');
        if (appServerBridge.isConnected()) {
          return appServerBridge.request('cron/create', {
            threadId: session.threadId,
            prompt: saved.prompt,
            schedule: saved.schedule,
          });
        }
        throw new Error('Codex app-server가 연결되어 있지 않아 예약을 등록할 수 없습니다.');
      }
      case 'conversation_request': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('대화 대상 세션을 찾을 수 없습니다.');
        }
        return handleConversationRequest(session, args.request || {});
      }
      case 'list_pending_questions':
        return { items: [...pendingQuestions.values()], complete: true };
      case 'respond_pending_question': {
        const sessionId = String(args.sessionId ?? args.session_id ?? '');
        const requestId = String(args.requestId ?? args.request_id ?? '');
        const key = `${sessionId}:${requestId}`;
        const pending = pendingQuestions.get(key);
        if (pending) {
          pendingQuestions.delete(key);
          const result = args.answers !== undefined ? { answers: args.answers } : { decision: args.decision };
          appServerBridge.sendResponse(pending.rpcId, result);
        }
        return { responded: true };
      }
      case 'choose_conversation_attachments': {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        const items = [];
        for (const raw of paths.slice(0, 12)) {
          const filePath = String(raw).trim();
          if (!path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            throw new Error(`유효한 첨부 파일 경로가 아닙니다: ${filePath}`);
          }
          const ext = path.extname(filePath).toLowerCase();
          items.push({
            type: ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? 'localImage' : 'file',
            path: filePath,
            name: path.basename(filePath),
          });
        }
        return items;
      }
      case 'conversation_attachment_storage': {
        let totalBytes = 0;
        let totalFiles = 0;
        try {
          for (const entry of fs.readdirSync(attachmentsDir)) {
            const full = path.join(attachmentsDir, entry);
            const st = fs.statSync(full);
            if (st.isFile()) {
              totalFiles++;
              totalBytes += st.size;
            }
          }
        } catch {
          // Ignore empty attachment dir.
        }
        return {
          totalBytes,
          totalFiles,
          limitBytes: 256 * 1024 * 1024,
          draftBytes: totalBytes,
          draftFiles: totalFiles,
          retainedBytes: 0,
          retainedFiles: 0,
          otherBytes: 0,
          otherFiles: 0,
          draftSessions: [],
          omittedSessions: 0,
        };
      }
      case 'stage_conversation_image': {
        const dataUrl = String(args.dataUrl ?? args.data_url ?? '');
        const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl);
        if (!match) {
          throw new Error('클립보드 이미지는 PNG 또는 JPEG 형식이어야 합니다.');
        }
        const ext = match[1] === 'png' ? 'png' : 'jpg';
        const buf = Buffer.from(match[2], 'base64');
        const name = `clipboard-${crypto.randomUUID()}.${ext}`;
        const fullPath = path.join(attachmentsDir, name);
        fs.writeFileSync(fullPath, buf);
        return { type: 'localImage', path: fullPath, name };
      }
      case 'cleanup_conversation_attachment': {
        const target = String(args.path ?? '');
        if (target && target.startsWith(attachmentsDir)) {
          try { fs.unlinkSync(target); } catch {}
        }
        return null;
      }
      case 'weekly_usage': {
        let weekly = null;
        let limitName = null;
        if (appServerBridge.isConnected()) {
          try {
            const limits = await appServerBridge.request('account/rateLimits/read', {});
            if (limits?.rateLimits) {
              limitName = limits.rateLimits.limitName ?? null;
              weekly = limits.rateLimits.weekly ?? null;
            }
          } catch {
            // Leave weekly null if account rate limits are unavailable.
          }
        }
        return {
          executable: computeSettings().resolvedPath,
          observedAt: Date.now(),
          limitName,
          weekly,
        };
      }
      case 'unconfirmed_exit_available':
        return false;
      case 'open_external_url': {
        const url = String(args.url ?? '').trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          throw new Error('외부 링크는 http:// 또는 https:// 주소만 허용됩니다.');
        }
        return null;
      }
      case 'choose_project_folder':
      case 'choose_skill_folder': {
        const raw = String(args.path ?? args.cwd ?? '').trim();
        if (!raw) return null;
        if (!path.isAbsolute(raw) || !fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) {
          throw new Error(`유효한 폴더 경로가 아닙니다: ${raw}`);
        }
        return raw;
      }
      case 'choose_project': {
        const raw = String(args.cwd ?? args.path ?? '').trim();
        if (!raw) return null;
        return dispatchCommand('import_project', { cwd: raw });
      }
      case 'choose_codex_executable': {
        const raw = String(args.path ?? '').trim();
        if (!raw) return null;
        return dispatchCommand('set_codex_executable', { path: raw });
      }
      case 'choose_app_server_executable': {
        const raw = String(args.path ?? '').trim();
        if (!raw) return null;
        return dispatchCommand('set_app_server_executable', { path: raw });
      }
      case 'complete_exit': {
        for (const proc of sessionProcesses.values()) {
          try { proc.kill(); } catch {}
        }
        sessionProcesses.clear();
        for (const session of sessions.values()) {
          session.active = false;
          session.state = 'stopped';
        }
        sessions.clear();
        return null;
      }
      default:
        throw new Error(`지원하지 않는 원격 명령입니다: ${command}`);
    }
  }

  function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.html': return 'text/html; charset=utf-8';
      case '.js':
      case '.mjs': return 'application/javascript; charset=utf-8';
      case '.css': return 'text/css; charset=utf-8';
      case '.json': return 'application/json; charset=utf-8';
      case '.svg': return 'image/svg+xml';
      case '.png': return 'image/png';
      case '.ico': return 'image/x-icon';
      case '.woff2': return 'font/woff2';
      default: return 'application/octet-stream';
    }
  }

  function resolveStaticFile(urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0] || '/').replace(/^\/+/, '');
    const rel = clean || 'index.html';
    const candidate = path.resolve(distDir, rel);
    if (!candidate.startsWith(distDir)) return null;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Fallback to SPA index.html
    }
    const index = path.join(distDir, 'index.html');
    return fs.existsSync(index) ? index : null;
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'opendiy-remote' }));
      return;
    }

    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const queryToken = reqUrl.searchParams.get('token') || '';
      const provided = bearer || queryToken;
      if (!verifyToken(tokenSha256, provided)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: '유효한 원격 접속 토큰이 필요합니다.' }));
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          clearInterval(keepAlive);
          sseClients.delete(res);
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/invoke') {
      const chunks = [];
      let total = 0;
      req.on('data', chunk => {
        total += chunk.length;
        if (total <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on('end', async () => {
        if (total > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '요청 본문이 허용 상한(16MiB)을 초과했습니다.' }));
          return;
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `잘못된 JSON 요청입니다: ${err.message}` }));
          return;
        }
        try {
          const result = await dispatchCommand(String(body.command ?? ''), body.args || {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
        }
      });
      return;
    }

    if (req.method === 'GET') {
      const filePath = resolveStaticFile(pathname);
      if (filePath) {
        const ctype = contentTypeFor(filePath);
        if (path.basename(filePath) === 'index.html') {
          const html = injectRemoteFlag(fs.readFileSync(filePath, 'utf8'));
          res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
          res.end(html, 'utf8');
        } else {
          res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-store' });
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found (Run "npm run build" first to generate dist/)');
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  });

  return {
    server,
    dispatchCommand,
    broadcast,
    close: () =>
      new Promise(resolve => {
        for (const proc of sessionProcesses.values()) {
          try { proc.kill(); } catch {}
        }
        sessionProcesses.clear();
        for (const client of sseClients) {
          try { client.end(); } catch {}
        }
        sseClients.clear();
        appServerBridge.shutdown();
        server.close(() => resolve());
      }),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let host = process.env.OPENDIY_REMOTE_BIND || process.env.OPENDIY_REMOTE_HOST || '127.0.0.1';
  let port = Number(process.env.OPENDIY_REMOTE_PORT || 3210);
  let token = process.env.OPENDIY_REMOTE_TOKEN || '';
  let workspaceDir = process.env.OPENDIY_REMOTE_DATA_DIR || process.env.AGENT_GRID_WORKSPACE_DIR || '';

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bind' && argv[i + 1]) {
      const val = argv[++i];
      const lastColon = val.lastIndexOf(':');
      if (lastColon !== -1) {
        host = val.slice(0, lastColon);
        port = Number(val.slice(lastColon + 1));
      } else {
        host = val;
      }
    } else if (argv[i] === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (argv[i] === '--host' && argv[i + 1]) {
      host = argv[++i];
    } else if (argv[i] === '--token' && argv[i + 1]) {
      token = argv[++i];
    } else if (argv[i] === '--workspace' && argv[i + 1]) {
      workspaceDir = argv[++i];
    }
  }

  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && !token.trim()) {
    console.error(`Error: Refusing to bind non-loopback address (${host}:${port}) without --token or OPENDIY_REMOTE_TOKEN.`);
    process.exit(1);
  }

  const instance = createRemoteServer({
    token,
    workspaceDir: workspaceDir || undefined,
  });
  instance.server.listen(port, host, () => {
    const addr = instance.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`OpenDIY Remote web server listening on http://${host}:${actualPort}`);
  });
}
