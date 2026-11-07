import http from 'node:http';
import https from 'node:https';
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
const AUTH_COOKIE_NAME = 'opendiy_remote_auth';
const MAX_AUTH_FAILURES = 5;
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_LOCKOUT_MS = 5 * 60 * 1000;

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

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
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
        name: (nameMatch ? nameMatch[1] : entry.name).trim(),
        description: (descMatch ? descMatch[1] : '').trim(),
        path: skillMd,
        scope,
        enabled: true,
        pluginId: null,
      });
    }
  } catch {
    // Ignore unreadable skill directories.
  }
  return results;
}

function scanCodexExtensions(cwd, executablePath) {
  const codexHome = getCodexHome();
  const skills = [
    ...scanSkillsInDir(path.join(codexHome, 'skills'), 'user'),
    ...(cwd ? scanSkillsInDir(path.join(cwd, '.codex', 'skills'), 'project') : []),
  ];
  const installedPlugins = [];
  const pluginsDir = path.join(codexHome, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        installedPlugins.push({
          pluginId: entry.name,
          name: entry.name,
          marketplaceName: 'local',
          version: null,
          enabled: true,
          source: path.join(pluginsDir, entry.name),
          installPolicy: null,
          authPolicy: null,
        });
      }
    } catch {
      // Ignore unreadable plugin directories.
    }
  }
  return {
    executable: executablePath || 'codex',
    cwd: cwd || null,
    plugins: {
      installed: installedPlugins,
      available: [],
    },
    marketplaces: [],
    skills,
    hooks: {
      items: [],
      warnings: [],
      errors: [],
    },
    skillDestinations: {
      user: path.join(codexHome, 'skills'),
      project: cwd ? path.join(cwd, '.codex', 'skills') : null,
    },
    errors: [],
  };
}

function normalizeConversationItem(rawItem, index = 0, turnId = 'turn') {
  if (!rawItem || typeof rawItem !== 'object') {
    return {
      id: `item-${turnId}-${index}`,
      type: 'agentMessage',
      text: String(rawItem ?? ''),
      status: 'completed',
    };
  }
  const id = String(rawItem.id || `item-${turnId}-${index}`);
  if (typeof rawItem.type === 'string' && rawItem.type) {
    return { ...rawItem, id };
  }
  const role = String(rawItem.role || 'assistant');
  if (role === 'user') {
    const content = Array.isArray(rawItem.content)
      ? rawItem.content
      : [{ type: 'text', text: String(rawItem.text ?? '') }];
    return {
      ...rawItem,
      id,
      type: 'userMessage',
      content,
      text: String(rawItem.text ?? content.map(c => c?.text || '').join('\n')),
      status: String(rawItem.status || 'completed'),
    };
  }
  return {
    ...rawItem,
    id,
    type: 'agentMessage',
    text: String(rawItem.text ?? rawItem.message ?? ''),
    status: String(rawItem.status || 'completed'),
  };
}

function buildPendingQuestionEntry(session, notification) {
  const requestId = String(notification.id);
  const method = String(notification.method || '');
  const params = notification.params || {};
  let kind = 'unsupported';
  let questions;
  let approval;
  let title = method;
  let message = '';

  if (method === 'item/tool/requestUserInput') {
    kind = 'question';
    title = '사용자 답변 대기';
    questions = Array.isArray(params.questions)
      ? params.questions.map((q, idx) => ({
          id: String(q?.id || `q-${idx}`),
          header: q?.header ? String(q.header) : undefined,
          question: String(q?.question || q?.header || `질문 ${idx + 1}`),
          options: Array.isArray(q?.options)
            ? q.options.map(opt => ({
                label: String(opt?.label ?? opt ?? ''),
                ...(opt?.description ? { description: String(opt.description) } : {}),
              }))
            : null,
          isOther: Boolean(q?.isOther),
          isSecret: Boolean(q?.isSecret),
        }))
      : [];
  } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    kind = 'approval';
    title = '사용자 승인 대기';
    message = String(params.command || params.reason || '');
    const advertised = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : ['accept', 'decline', 'cancel'];
    const labels = {
      accept: '승인',
      acceptForSession: '이 세션에서 승인',
      decline: '거절',
      cancel: '취소',
    };
    approval = {
      options: advertised
        .filter(d => Object.prototype.hasOwnProperty.call(labels, d))
        .map(d => ({ id: d, label: labels[d] })),
    };
  }

  return {
    id: `${session.id}:${requestId}`,
    sessionId: session.id,
    sessionTitle: session.title,
    threadId: session.threadId || null,
    generation: session.generation,
    requestId,
    rpcId: notification.id,
    kind,
    title,
    ...(message ? { message } : {}),
    source: 'request',
    canRespond: kind !== 'unsupported',
    responded: false,
    metadataAvailable: true,
    ...(questions ? { questions } : {}),
    ...(approval ? { approval } : {}),
    method,
    params,
  };
}

function extractWeeklyUsage(rateLimitsPayload) {
  const rl = rateLimitsPayload?.rateLimits ?? rateLimitsPayload;
  if (!rl || typeof rl !== 'object') return { limitName: null, weekly: null };
  const limitName = typeof rl.limitName === 'string' ? rl.limitName : null;
  const candidates = [rl.weekly, rl.primary, rl.secondary].filter(Boolean);
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const isWeekly = entry === rl.weekly || entry.windowDurationMins === 10080 || entry.windowMinutes === 10080;
    if (!isWeekly) continue;
    const usedPercent = Number(entry.usedPercent ?? entry.percentUsed ?? 0);
    if (!Number.isFinite(usedPercent)) continue;
    const rawReset = entry.resetsAt ?? entry.resetAt ?? null;
    const resetsAt = rawReset !== null && Number.isSafeInteger(Number(rawReset)) && Number(rawReset) > 0
      ? Number(rawReset)
      : null;
    return {
      limitName,
      weekly: {
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetsAt,
      },
    };
  }
  return { limitName, weekly: null };
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
    this.runtimeId = crypto.randomUUID();
  }

  isConnected() {
    return Boolean(this.customTransport || (this.proc && this.initialized));
  }

  async ensureStarted() {
    if (this.customTransport) {
      if (!this.initialized) {
        this.serverInfo = (await this.customTransport('initialize', {
          clientInfo: { name: 'opendiy-remote', title: 'OpenDIY Remote', version: '1.0.0' },
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
      this.runtimeId = crypto.randomUUID();

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
        clientInfo: { name: 'opendiy-remote', title: 'OpenDIY Remote', version: '1.0.0' },
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
  const mode = options.mode || process.env.OPENDIY_REMOTE_MODE || 'direct';
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
  const rawHostSecret = options.hostSecret ?? process.env.OPENDIY_REMOTE_HOST_SECRET ?? rawToken;
  const hostSecretSha256 = rawHostSecret.trim()
    ? crypto.createHash('sha256').update(rawHostSecret.trim(), 'utf8').digest()
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
    if (mode === 'relay') return; // Stateless relay never writes user workspace state to disk
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Ignore write errors in read-only environments.
    }
  }

  const authRateMap = new Map();
  function checkAndRecordAuth(ip, valid) {
    if (!tokenSha256 && !hostSecretSha256) return { allowed: true };
    const now = Date.now();
    let record = authRateMap.get(ip);
    if (record && record.lockedUntil > now) {
      return { allowed: false, locked: true };
    }
    if (valid) {
      authRateMap.delete(ip);
      return { allowed: true };
    }
    if (!record || now - record.firstFailedAt > AUTH_WINDOW_MS) {
      record = { count: 1, firstFailedAt: now, lockedUntil: 0 };
    } else {
      record.count += 1;
      if (record.count >= MAX_AUTH_FAILURES) {
        record.lockedUntil = now + AUTH_LOCKOUT_MS;
      }
    }
    authRateMap.set(ip, record);
    return { allowed: false, locked: record.lockedUntil > now };
  }

  // 1:1 Single-Owner Relay Hub state
  let activeHostLease = null; // { hostId, streamRes, keepAlive, connectedAt, pendingCalls: Map<reqId, {resolve, reject, timer}> }
  function releaseHostLease(hostId, targetRes = null) {
    if (
      activeHostLease &&
      activeHostLease.hostId === hostId &&
      (!targetRes || activeHostLease.streamRes === targetRes)
    ) {
      if (activeHostLease.keepAlive) clearInterval(activeHostLease.keepAlive);
      for (const [, pending] of activeHostLease.pendingCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error('로컬 PC 호스트 연결이 끊어졌습니다.'));
      }
      activeHostLease.pendingCalls.clear();
      try {
        activeHostLease.streamRes.end();
      } catch {}
      activeHostLease = null;
      broadcast('host-connection-changed', { connected: false });
    }
  }

  function invokeRelayHost(command, args = {}, timeoutMs = 30000) {
    if (!activeHostLease || !activeHostLease.streamRes || activeHostLease.streamRes.writableEnded) {
      return Promise.reject(new Error('연결된 로컬 PC 호스트가 없습니다. 작업용 PC에서 호스트 연결(--connect)을 먼저 실행하세요.'));
    }
    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        activeHostLease?.pendingCalls.delete(reqId);
        reject(new Error(`로컬 PC 호스트 응답 시간 초과 (${command})`));
      }, timeoutMs);
      activeHostLease.pendingCalls.set(reqId, { resolve, reject, timer });
      try {
        activeHostLease.streamRes.write(`data: ${JSON.stringify({ type: 'invoke', reqId, command, args })}\n\n`);
      } catch (err) {
        clearTimeout(timer);
        activeHostLease.pendingCalls.delete(reqId);
        reject(err);
      }
    });
  }

  function terminateChildProcess(proc) {
    if (!proc) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.once('exit', done);
      try {
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
      } catch {}
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('exit', done);
        } else {
          proc.kill('SIGTERM');
        }
      } catch {
        done();
      }
      setTimeout(done, 400);
    });
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
  const cronJobsByThread = new Map();
  let cronJobSeq = 1;
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
          const qEntry = buildPendingQuestionEntry(session, notification);
          pendingQuestions.set(`${session.id}:${notification.id}`, qEntry);
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

  async function syncThreadFromServer(session, includeTurns = true) {
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
              const readRes = await appServerBridge.request('thread/read', { threadId, includeTurns });
              if (readRes?.thread) {
                state.threads[threadId] = {
                  ...(state.threads[threadId] || {}),
                  ...readRes.thread,
                  id: threadId,
                  cwd: readRes.thread.cwd || session.cwd,
                };
              }
            } catch {
              // FAIL-05 fix: Never overwrite an existing session threadId when thread/read fails
              // on an unmaterialized thread (before its first turn).
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
        modelContextWindow: 128000,
        effectiveContextWindow: 128000,
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
          return { data: rpcRes.data, models: rpcRes.data, nextCursor: rpcRes.nextCursor ?? null };
        }
      }
    } catch {
      // Return empty model list when app-server is unavailable.
    }
    return { data: [], models: [], nextCursor: null };
  }

  async function handleConversationRequest(session, request) {
    const type = request?.type;
    const includeTurns = type === 'page' || type === 'items' || type === 'detail' || type === 'turns';
    const thread = await syncThreadFromServer(session, includeTurns);
    const threadId = thread.id;

    if (type === 'models') {
      return queryServerModels(request.cursor ?? null);
    }

    if (type === 'page') {
      const rawTurns = Array.isArray(thread.turns) ? [...thread.turns].reverse() : [];
      const data = rawTurns.map((t, idx) => ({
        id: String(t.id || `turn-${idx + 1}`),
        status: String(t.status || 'completed'),
        createdAt: t.createdAt ?? Math.floor(Date.now() / 1000),
      }));
      return {
        data,
        turns: data,
        nextCursor: null,
      };
    }

    if (type === 'poll') {
      session.deliveredEventSeq = session.deliveredEventSeq || 0;
      const allEvents = Array.isArray(session.events) ? session.events : [];
      const freshEvents = allEvents.filter(e => e.seq > session.deliveredEventSeq);
      if (freshEvents.length) {
        session.deliveredEventSeq = freshEvents[freshEvents.length - 1].seq;
      }
      const pendingReqs = [...pendingQuestions.values()]
        .filter(q => q.sessionId === session.id && !q.responded)
        .map(q => ({
          seq: q.seq || 1,
          method: q.method,
          params: q.params || {},
          requestId: q.requestId,
          responded: Boolean(q.responded),
        }));
      return {
        connected: appServerBridge.isConnected(),
        unknownResult: false,
        gap: false,
        events: freshEvents,
        pendingRequests: pendingReqs,
      };
    }

    if (type === 'attach' || type === 'refresh' || type === 'turns' || !type) {
      const { models } = await queryServerModels(null);
      if (appServerBridge.isConnected()) {
        try {
          await appServerBridge.request('thread/subscribePassive', { threadId });
        } catch {
          // Passive subscription is optional depending on server version.
        }
      }
      const caps = appServerBridge.serverInfo?.opendiyCapabilities || {};
      const turnsList = Array.isArray(thread.turns) ? thread.turns.slice(-20) : [];
      const latestTurn = turnsList[turnsList.length - 1];
      const activeTurnId = latestTurn?.status === 'inProgress' ? String(latestTurn.id) : '';
      return {
        attached: true,
        connected: appServerBridge.isConnected(),
        threadId,
        model: thread.model ?? null,
        reasoningEffort: thread.effort ?? null,
        effort: thread.effort ?? null,
        models,
        data: [...turnsList].reverse(),
        activeTurnKnown: true,
        activeTurnId,
        historyUnavailable: false,
        capabilities: {
          passiveSubscription: Boolean(caps.passiveSubscription ?? true),
          userTurnStartIfIdle: Boolean(caps.userTurnStartIfIdle ?? true),
          compactStartIfIdle: Boolean(caps.compactStartIfIdle ?? true),
          historySummary: Boolean(caps.historySummary ?? true),
          expectedTurnInterrupt: Boolean(appServerBridge.serverInfo?.supportsExpectedTurnInterrupt ?? true),
        },
        turns: turnsList,
        nextCursor: null,
        events: session.events || [],
        readState: thread.readState || { firstUnread: null, revision: 'rev-1' },
      };
    }

    if (type === 'items') {
      const turn = (thread.turns || []).find(t => t.id === request.turnId);
      const rawItems = turn && Array.isArray(turn.items) ? turn.items : [];
      const data = rawItems.map((rawItem, idx) => ({
        turnId: String(request.turnId),
        item: normalizeConversationItem(rawItem, idx, String(request.turnId)),
      }));
      return {
        turnId: request.turnId,
        data,
        items: data.map(d => d.item),
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
      const rawItems = Array.isArray(rpcRes?.turn?.items)
        ? rpcRes.turn.items
        : [{ id: `item-u-${turnId}`, type: 'userMessage', role: 'user', content: [{ type: 'text', text }], text, status: 'completed' }];
      const normalizedItems = rawItems.map((it, idx) => normalizeConversationItem(it, idx, turnId));
      const turn = {
        id: turnId,
        status: String(rpcRes?.turn?.status || 'completed'),
        createdAt: Math.floor(Date.now() / 1000),
        items: normalizedItems,
      };
      thread.turns = thread.turns || [];
      thread.turns.push(turn);
      thread.updatedAt = Math.floor(Date.now() / 1000);
      if (request.model) thread.model = String(request.model);
      if (request.effort) thread.effort = String(request.effort);
      persistState();
      return {
        turnId,
        turn: { id: turnId, status: turn.status },
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
      const startedTurnId = String(rpcRes?.turn?.id || crypto.randomUUID());
      return {
        status: String(rpcRes?.status || 'started'),
        turn: rpcRes?.turn || { id: startedTurnId, status: 'inProgress' },
      };
    }

    if (type === 'contextStatus') {
      await appServerBridge.ensureStarted().catch(() => {});
      const connected = appServerBridge.isConnected();
      if (connected) {
        try {
          const readRes = await appServerBridge.request('thread/read', { threadId, includeTurns: false });
          if (readRes?.thread) {
            thread.usedTokens = Number(readRes.thread.tokenUsage?.totalTokens ?? readRes.thread.tokenUsage?.last?.totalTokens ?? thread.usedTokens ?? 0);
            thread.modelContextWindow = readRes.thread.modelContextWindow ?? thread.modelContextWindow ?? 128000;
          }
        } catch {
          // Use cached thread values if read fails on unmaterialized thread.
        }
      }
      const caps = appServerBridge.serverInfo?.opendiyCapabilities || {};
      const usedTokens = Number(thread.usedTokens || 0);
      const modelContextWindow = Number(thread.modelContextWindow || 128000);
      const compactSupported = Boolean(caps.compactStartIfIdle ?? connected);
      const isIdle = session.state === 'idle';
      session.contextRevision = (session.contextRevision || 0) + 1;
      return {
        connected,
        guiConnected: connected,
        supported: connected,
        usedTokens,
        modelContextWindow,
        tokenUsage: {
          last: { totalTokens: usedTokens },
          modelContextWindow,
        },
        tokenUsageFresh: connected,
        compacting: false,
        active: !isIdle,
        canCompact: connected && compactSupported && isIdle,
        canCompactIfIdle: connected && compactSupported,
        idle: isIdle,
        passiveSubscriptionSupported: Boolean(caps.passiveSubscription ?? connected),
        subagentsSupported: Boolean(appServerBridge.serverInfo?.supportsSubagentManagement ?? connected),
        cronSupported: true,
        compactSupported,
        revision: session.contextRevision,
      };
    }

    if (type === 'contextSettings') {
      const currentWindow = thread.modelContextWindow ?? null;
      const effectiveWindow = thread.effectiveContextWindow ?? currentWindow ?? 128000;
      return {
        supported: true,
        canChange: true,
        modelContextWindow: currentWindow,
        effectiveContextWindow: effectiveWindow,
        minModelContextWindow: 16000,
        maxModelContextWindow: 1000000,
      };
    }

    if (type === 'setContextWindow') {
      const nextWindow = request.modelContextWindow === null ? null : Number(request.modelContextWindow);
      if (nextWindow !== null && (!Number.isSafeInteger(nextWindow) || nextWindow <= 0)) {
        return {
          supported: true,
          canChange: true,
          modelContextWindow: thread.modelContextWindow ?? null,
          effectiveContextWindow: thread.effectiveContextWindow ?? thread.modelContextWindow ?? 128000,
          status: 'rejected',
        };
      }
      if (
        request.expectedModelContextWindow !== undefined &&
        request.expectedModelContextWindow !== (thread.modelContextWindow ?? null)
      ) {
        return {
          supported: true,
          canChange: true,
          modelContextWindow: thread.modelContextWindow ?? null,
          effectiveContextWindow: thread.effectiveContextWindow ?? thread.modelContextWindow ?? 128000,
          status: 'conflict',
        };
      }
      if (appServerBridge.isConnected()) {
        try {
          await appServerBridge.request('thread/contextWindow/set', {
            threadId,
            modelContextWindow: nextWindow,
            expectedModelContextWindow: request.expectedModelContextWindow ?? thread.modelContextWindow ?? null,
          });
        } catch {
          // Persist locally even if app-server version does not expose thread/contextWindow/set.
        }
      }
      thread.modelContextWindow = nextWindow;
      thread.effectiveContextWindow = nextWindow ?? 128000;
      persistState();
      return {
        supported: true,
        canChange: true,
        modelContextWindow: thread.modelContextWindow,
        effectiveContextWindow: thread.effectiveContextWindow,
        status: 'applied',
      };
    }

    if (type === 'respond') {
      const key = `${session.id}:${request.requestId}`;
      const pending = pendingQuestions.get(key);
      if (pending) {
        pending.responded = true;
        pendingQuestions.delete(key);
        appServerBridge.sendResponse(pending.rpcId, request.result);
      }
      return { responded: true };
    }

    throw new Error(`지원하지 않는 대화 요청 유형입니다: ${type}`);
  }

  async function dispatchCommand(command, args = {}) {
    if (mode === 'relay') {
      return invokeRelayHost(command, args);
    }

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
          state: !cliVersion ? 'unavailable' : matched ? 'matched' : 'mismatch',
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
          deliveredEventSeq: 0,
          contextRevision: 0,
        };
        await syncThreadFromServer(session, false);
        sessions.set(id, session);
        persistState();

        const info = publicSessionInfo(session);
        broadcast('session-changed', info);

        const settings = computeSettings();
        const shouldSpawnProcess = options.spawnProcess !== false;
        if (shouldSpawnProcess) {
          const useCodex = Boolean(settings.resolvedPath && options.useCodexCli === true);
          const cmdBin = useCodex
            ? settings.resolvedPath
            : process.platform === 'win32'
              ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
              : '/bin/sh';
          const cmdArgs = useCodex
            ? ['--cd', cwd]
            : process.platform === 'win32'
              ? [
                  '-NoLogo',
                  '-NoProfile',
                  '-NoExit',
                  '-Command',
                  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::WriteLine("[OpenDIY Remote] " + $env:OPENDIY_SESSION_TITLE + " (" + $env:OPENDIY_SESSION_CWD + ")")',
                ]
              : [
                  '-c',
                  'printf "[OpenDIY Remote] %s (%s)\\n" "$OPENDIY_SESSION_TITLE" "$OPENDIY_SESSION_CWD"; exec /bin/sh -i',
                ];
          try {
            const child = spawn(cmdBin, cmdArgs, {
              cwd,
              env: {
                ...process.env,
                OPENDIY_SESSION_TITLE: title,
                OPENDIY_SESSION_CWD: cwd,
                ...(session.threadId ? { OPENDIY_THREAD_ID: session.threadId } : {}),
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
          proc.stdin.write(data.replace(/\r/g, '\n'));
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
            sessionProcesses.delete(session.id);
            await terminateChildProcess(proc);
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
              let msgSeq = 1;
              for (const turn of readRes.thread.turns) {
                for (const item of turn.items || []) {
                  messages.push({
                    id: String(item.id || `${turn.id || 'turn'}-${msgSeq++}`),
                    role: item.role === 'user' || item.type === 'userMessage' ? 'user' : 'assistant',
                    text: String(item.text ?? ''),
                  });
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
        let msgSeq = 1;
        if (thread && Array.isArray(thread.turns)) {
          for (const turn of thread.turns) {
            for (const item of turn.items || []) {
              messages.push({
                id: String(item.id || `${turn.id || 'turn'}-${msgSeq++}`),
                role: item.role === 'user' || item.type === 'userMessage' ? 'user' : 'assistant',
                text: String(item.text ?? ''),
              });
            }
          }
        }
        return { messages, nextCursor: null };
      }
      case 'extensions_list': {
        const cwd = args.cwd ? String(args.cwd) : null;
        return scanCodexExtensions(cwd, computeSettings().resolvedPath);
      }
      case 'extensions_mutate': {
        const cwd = args.cwd ? String(args.cwd) : null;
        if (appServerBridge.isConnected() && args.request) {
          try {
            await appServerBridge.request('extensions/mutate', { cwd, request: args.request });
          } catch {
            // Ignore if app-server does not support direct extensions/mutate RPC.
          }
        }
        return scanCodexExtensions(cwd, computeSettings().resolvedPath);
      }
      case 'mobile_control': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('모바일 원격 제어 대상 세션을 찾을 수 없습니다.');
        }
        const action = String(args.action ?? 'status');
        await appServerBridge.ensureStarted().catch(() => {});
        if (!appServerBridge.isConnected()) {
          throw new Error('Codex app-server가 연결되어 있지 않아 모바일 원격 제어를 실행할 수 없습니다.');
        }
        const method = action === 'pair'
          ? 'remoteControl/pairing/start'
          : action === 'disable'
            ? 'remoteControl/disable'
            : action === 'enable'
              ? 'remoteControl/enable'
              : 'remoteControl/status/read';
        const rpcParams = action === 'pair'
          ? { manualCode: true }
          : action === 'enable' || action === 'disable'
            ? { ephemeral: true }
            : {};
        let raw = {};
        try {
          raw = (await appServerBridge.request(method, rpcParams)) || {};
        } catch {
          if (action === 'status') {
            raw = { status: { status: 'disabled', serverName: 'OpenDIY Remote', environmentId: null } };
          } else {
            throw new Error(`원격 제어 RPC(${method})를 실행하지 못했습니다.`);
          }
        }
        const rawStatus = raw.status && typeof raw.status === 'object'
          ? raw.status
          : {
              status: typeof raw.status === 'string' ? raw.status : (action === 'enable' || action === 'pair' ? 'connected' : 'disabled'),
              serverName: String(raw.serverName || 'OpenDIY Remote'),
              environmentId: raw.environmentId ?? null,
            };
        const rawPairing = raw.pairing && typeof raw.pairing === 'object'
          ? raw.pairing
          : action === 'pair' && raw.manualCode
            ? {
                manualCode: String(raw.manualCode),
                expiresAt: Number(raw.expiresAt || Math.floor(Date.now() / 1000) + 300),
                environmentId: String(raw.environmentId || rawStatus.environmentId || 'env-1'),
              }
            : null;
        return {
          isolated: Boolean(raw.isolated ?? true),
          shared: Boolean(raw.shared ?? false),
          mutationsAllowed: Boolean(raw.mutationsAllowed ?? true),
          status: rawStatus,
          pairing: rawPairing,
        };
      }
      case 'subagents_request': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('하위 에이전트 대상 세션을 찾을 수 없습니다.');
        }
        const req = args.request || {};
        await appServerBridge.ensureStarted().catch(() => {});
        const connected = appServerBridge.isConnected();
        const supported = Boolean(appServerBridge.serverInfo?.supportsSubagentManagement ?? connected);
        if (!req.type || req.type === 'list') {
          let agents = [];
          let nextCursor = null;
          if (connected && supported) {
            try {
              const rpcRes = await appServerBridge.request('thread/subagents/list', {
                threadId: session.threadId,
                cursor: req.cursor ?? null,
              });
              if (Array.isArray(rpcRes?.agents)) agents = rpcRes.agents;
              else if (Array.isArray(rpcRes?.data)) agents = rpcRes.data;
              nextCursor = rpcRes?.nextCursor ?? null;
            } catch {
              // Keep empty list if server returns error for unmaterialized thread.
            }
          }
          return {
            supported,
            connected,
            parentRuntimeId: appServerBridge.runtimeId,
            agents,
            nextCursor,
            mutationState: 'clear',
            reconciledRequestId: req.requestId ?? null,
          };
        }
        if (connected && supported) {
          try {
            const rpcRes = await appServerBridge.request('thread/subagents/control', {
              threadId: session.threadId,
              ...req,
            });
            return {
              status: String(rpcRes?.status || 'applied'),
            };
          } catch {
            return { status: 'notApplied' };
          }
        }
        return { status: 'unsupported' };
      }
      case 'cron_request': {
        const session = sessions.get(args.id);
        if (!session || session.generation !== Number(args.generation)) {
          throw new Error('예약 요청 대상 세션을 찾을 수 없습니다.');
        }
        const req = args.request || {};
        await appServerBridge.ensureStarted().catch(() => {});
        const connected = appServerBridge.isConnected();
        const threadKey = String(session.threadId || session.id);
        if (!cronJobsByThread.has(threadKey)) cronJobsByThread.set(threadKey, []);
        const jobs = cronJobsByThread.get(threadKey);

        if (!req.type || req.type === 'list') {
          return {
            supported: true,
            connected,
            scope: 'cliLifetime',
            jobs,
            hasMore: false,
            mutationState: 'clear',
            ...(req.requestId ? { reconciledRequestId: String(req.requestId) } : {}),
            supportsExpectedTurnInterrupt: Boolean(appServerBridge.serverInfo?.supportsExpectedTurnInterrupt ?? true),
          };
        }
        if (req.type === 'pause' || req.type === 'resume' || req.type === 'remove' || req.type === 'cancel') {
          const job = jobs.find(j => j.id === String(req.jobId));
          if (!job) return { status: 'notApplied' };
          if (req.type === 'pause') job.paused = true;
          else if (req.type === 'resume') job.paused = false;
          else if (req.type === 'remove') {
            const idx = jobs.indexOf(job);
            if (idx !== -1) jobs.splice(idx, 1);
          } else if (req.type === 'cancel') {
            job.state = 'ready';
          }
          return { status: 'applied' };
        }
        return { status: 'applied' };
      }
      case 'saved_cron_list': {
        const threadId = String(args.threadId ?? args.thread_id ?? '');
        return state.savedCrons
          .filter(c => c.threadId === threadId)
          .map(c => ({ ...c, registration: c.registration ?? null }));
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
          registration: null,
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
        const threadKey = String(session.threadId || session.id);
        if (!cronJobsByThread.has(threadKey)) cronJobsByThread.set(threadKey, []);
        const jobs = cronJobsByThread.get(threadKey);
        const jobId = String(cronJobSeq++);
        const nextRunAt = saved.schedule?.type === 'every'
          ? Date.now() + Number(saved.schedule.seconds) * 1000
          : Number(saved.schedule?.atUnixMs || Date.now() + 60000);
        jobs.push({
          id: jobId,
          promptPreview: String(saved.prompt).slice(0, 512),
          schedule: saved.schedule,
          state: 'ready',
          paused: false,
          removed: false,
          nextRunAt,
          skipped: 0,
        });
        saved.registration = {
          sessionId: session.id,
          generation: session.generation,
          requestId: crypto.randomUUID(),
          jobId,
          state: 'registered',
        };
        persistState();
        return { status: 'applied' };
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
          pending.responded = true;
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
        await appServerBridge.ensureStarted().catch(() => {});
        let weekly = null;
        let limitName = null;
        if (appServerBridge.isConnected()) {
          try {
            const limits = await appServerBridge.request('account/rateLimits/read', {});
            const parsed = extractWeeklyUsage(limits);
            limitName = parsed.limitName;
            weekly = parsed.weekly;
          } catch {
            // Leave weekly null if account rate limits are unavailable.
          }
        }
        return {
          executable: String(computeSettings().resolvedPath || 'codex'),
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

  function readJsonBody(req, res, callback) {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (total > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '요청 본문이 허용 상한(16MiB)을 초과했습니다.' }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        callback(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `잘못된 JSON 요청입니다: ${err.message}` }));
      }
    });
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;
    const clientIp = String(req.socket?.remoteAddress || 'unknown');

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        service: 'opendiy-remote',
        mode,
        hostConnected: mode === 'relay' ? Boolean(activeHostLease) : true,
      }));
      return;
    }

    // 1:1 Single-Owner Host Tunnel Endpoints (/api/relay/*)
    if (pathname.startsWith('/api/relay/')) {
      const hostAuth = req.headers['x-opendiy-host-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
      const validSecret = verifyToken(hostSecretSha256, String(hostAuth));
      const rate = checkAndRecordAuth(`host:${clientIp}`, validSecret);
      if (!rate.allowed) {
        res.writeHead(rate.locked ? 429 : 401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: false,
          error: rate.locked
            ? '반복된 인증 실패로 호스트 연결이 일시 차단되었습니다.'
            : '유효한 호스트 비밀키(OPENDIY_REMOTE_HOST_SECRET)가 필요합니다.',
        }));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/relay/stream') {
        const requestedHostId = String(req.headers['x-opendiy-host-id'] || crypto.randomUUID());
        // Single-Host Lock: reject if another host is already actively connected
        if (
          activeHostLease &&
          activeHostLease.hostId !== requestedHostId &&
          !activeHostLease.streamRes.writableEnded &&
          !activeHostLease.streamRes.destroyed
        ) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({
            ok: false,
            error: '이 중계기에는 이미 소유자의 로컬 PC 호스트 1대가 독점 연결되어 있습니다 (Single-Host Lock).',
          }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        const pendingCalls = activeHostLease?.hostId === requestedHostId ? activeHostLease.pendingCalls : new Map();
        const keepAlive = setInterval(() => {
          try {
            res.write(': keepalive\n\n');
          } catch {
            clearInterval(keepAlive);
            releaseHostLease(requestedHostId, res);
          }
        }, 15000);
        activeHostLease = {
          hostId: requestedHostId,
          streamRes: res,
          keepAlive,
          connectedAt: Date.now(),
          pendingCalls,
        };
        res.write(`data: ${JSON.stringify({ type: 'registered', hostId: requestedHostId })}\n\n`);
        broadcast('host-connection-changed', { connected: true });
        res.on('close', () => {
          clearInterval(keepAlive);
          releaseHostLease(requestedHostId, res);
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/relay/reply') {
        const hostId = String(req.headers['x-opendiy-host-id'] || '');
        if (!activeHostLease || activeHostLease.hostId !== hostId) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '등록된 활성 호스트 세션이 아닙니다.' }));
          return;
        }
        readJsonBody(req, res, body => {
          const entry = activeHostLease?.pendingCalls.get(String(body.reqId || ''));
          if (entry) {
            activeHostLease.pendingCalls.delete(String(body.reqId));
            clearTimeout(entry.timer);
            if (body.ok) entry.resolve(body.result);
            else entry.reject(new Error(String(body.error || '호스트 명령 실행 실패')));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/relay/event') {
        const hostId = String(req.headers['x-opendiy-host-id'] || '');
        if (!activeHostLease || activeHostLease.hostId !== hostId) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '등록된 활성 호스트 세션이 아닙니다.' }));
          return;
        }
        readJsonBody(req, res, body => {
          if (typeof body.event === 'string') {
            broadcast(body.event, body.payload);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
    }

    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const queryToken = reqUrl.searchParams.get('token') || '';
      const cookies = parseCookies(req.headers.cookie);
      const cookieToken = cookies[AUTH_COOKIE_NAME] || '';
      const provided = bearer || queryToken || cookieToken;
      const valid = verifyToken(tokenSha256, provided);
      const rate = checkAndRecordAuth(`client:${clientIp}`, valid);
      if (!rate.allowed) {
        res.writeHead(rate.locked ? 429 : 401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: false,
          error: rate.locked
            ? '반복된 인증 실패로 접속이 일시 차단되었습니다. 잠시 후 다시 시도하세요.'
            : '유효한 원격 접속 토큰이 필요합니다.',
        }));
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
      readJsonBody(req, res, async body => {
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
        const headers = {
          'Content-Type': ctype,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        };
        const urlToken = reqUrl.searchParams.get('token') || '';
        if (urlToken && verifyToken(tokenSha256, urlToken)) {
          headers['Set-Cookie'] = `${AUTH_COOKIE_NAME}=${encodeURIComponent(urlToken.trim())}; HttpOnly; SameSite=Strict; Path=/`;
        }
        if (path.basename(filePath) === 'index.html') {
          const html = injectRemoteFlag(fs.readFileSync(filePath, 'utf8'));
          res.writeHead(200, headers);
          res.end(html, 'utf8');
        } else {
          res.writeHead(200, headers);
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
    close: async () => {
      if (activeHostLease) {
        releaseHostLease(activeHostLease.hostId);
      }
      const procs = [...sessionProcesses.values()];
      sessionProcesses.clear();
      await Promise.all(procs.map(terminateChildProcess));
      for (const client of sseClients) {
        try { client.end(); } catch {}
      }
      sseClients.clear();
      appServerBridge.shutdown();
      await new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Outbound Host Connector for the user's local PC (`--connect <relay-url>`).
 * Runs local `opendiy-codex` and workspace commands on the user's PC while keeping
 * 0 inbound ports open, streaming over an outbound connection to the 1:1 Relay Server.
 */
export function startHostConnector(options = {}) {
  const relayUrl = String(options.relayUrl || process.env.OPENDIY_REMOTE_RELAY_URL || '').trim().replace(/\/+$/, '');
  const hostSecret = String(options.hostSecret ?? process.env.OPENDIY_REMOTE_HOST_SECRET ?? process.env.OPENDIY_REMOTE_TOKEN ?? '').trim();
  if (!relayUrl) {
    throw new Error('연결할 중계 서버 주소(--connect <url> 또는 OPENDIY_REMOTE_RELAY_URL)를 지정하세요.');
  }
  const hostId = options.hostId || crypto.randomUUID();
  const localRuntime = createRemoteServer({
    ...options,
    mode: 'direct',
  });

  let stopped = false;
  let activeReq = null;
  let reconnectTimer = null;

  function postJson(endpointPath, payload) {
    return new Promise((resolve, reject) => {
      const target = new URL(endpointPath, `${relayUrl}/`);
      const mod = target.protocol === 'https:' ? https : http;
      const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
      const req = mod.request(
        target,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': bodyBuf.length,
            'X-OpenDIY-Host-Id': hostId,
            ...(hostSecret ? { 'X-OpenDIY-Host-Secret': hostSecret } : {}),
          },
        },
        res => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
            else reject(new Error(`Relay POST ${endpointPath} failed: HTTP ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });
  }

  // Forward local SSE broadcasts (terminal-output, session-changed) to the relay
  const origBroadcast = localRuntime.broadcast;
  localRuntime.broadcast = (event, payload) => {
    origBroadcast(event, payload);
    if (!stopped) {
      postJson('/api/relay/event', { event, payload }).catch(() => {});
    }
  };

  function connectStream() {
    if (stopped) return;
    const streamUrl = new URL('/api/relay/stream', `${relayUrl}/`);
    const mod = streamUrl.protocol === 'https:' ? https : http;
    const req = mod.request(
      streamUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'X-OpenDIY-Host-Id': hostId,
          ...(hostSecret ? { 'X-OpenDIY-Host-Secret': hostSecret } : {}),
        },
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          if (!stopped && options.autoReconnect !== false) {
            reconnectTimer = setTimeout(connectStream, 2000);
          }
          return;
        }
        const rl = readline.createInterface({ input: res });
        res.on('error', () => {});
        rl.on('error', () => {});
        rl.on('line', async line => {
          if (!line.startsWith('data:')) return;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) return;
          try {
            const msg = JSON.parse(jsonStr);
            if (msg.type === ' registered' || msg.type === 'registered') {
              options.onRegistered?.({ hostId: msg.hostId });
              return;
            }
            if (msg.type === 'invoke' && msg.reqId) {
              try {
                const result = await localRuntime.dispatchCommand(msg.command, msg.args || {});
                await postJson('/api/relay/reply', { reqId: msg.reqId, ok: true, result });
              } catch (err) {
                await postJson('/api/relay/reply', {
                  reqId: msg.reqId,
                  ok: false,
                  error: String(err.message || err),
                });
              }
            }
          } catch {
            // Ignore malformed relay frame.
          }
        });
        res.on('end', () => {
          if (!stopped && options.autoReconnect !== false) {
            reconnectTimer = setTimeout(connectStream, 1500);
          }
        });
      },
    );
    req.on('error', () => {
      if (!stopped && options.autoReconnect !== false) {
        reconnectTimer = setTimeout(connectStream, 2000);
      }
    });
    req.end();
    activeReq = req;
  }

  connectStream();

  return {
    hostId,
    localRuntime,
    close: async () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeReq) {
        try { activeReq.destroy(); } catch {}
        activeReq = null;
      }
      await localRuntime.close();
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let mode = process.env.OPENDIY_REMOTE_MODE || 'direct';
  let connectUrl = process.env.OPENDIY_REMOTE_RELAY_URL || '';
  let host = process.env.OPENDIY_REMOTE_BIND || process.env.OPENDIY_REMOTE_HOST || '127.0.0.1';
  let port = Number(process.env.OPENDIY_REMOTE_PORT || 3210);
  let token = process.env.OPENDIY_REMOTE_TOKEN || '';
  let hostSecret = process.env.OPENDIY_REMOTE_HOST_SECRET || '';
  let workspaceDir = process.env.OPENDIY_REMOTE_DATA_DIR || process.env.AGENT_GRID_WORKSPACE_DIR || '';

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) {
      mode = argv[++i];
    } else if (argv[i].startsWith('--mode=')) {
      mode = argv[i].slice('--mode='.length);
    } else if (argv[i] === '--connect' && argv[i + 1]) {
      connectUrl = argv[++i];
      mode = 'connect';
    } else if (argv[i].startsWith('--connect=')) {
      connectUrl = argv[i].slice('--connect='.length);
      mode = 'connect';
    } else if (argv[i] === '--bind' && argv[i + 1]) {
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
    } else if (argv[i] === '--host-secret' && argv[i + 1]) {
      hostSecret = argv[++i];
    } else if (argv[i] === '--workspace' && argv[i + 1]) {
      workspaceDir = argv[++i];
    }
  }

  if (mode === 'connect' || connectUrl) {
    const connector = startHostConnector({
      relayUrl: connectUrl,
      hostSecret: hostSecret || token,
      workspaceDir: workspaceDir || undefined,
      onRegistered: ({ hostId }) => {
        console.log(`OpenDIY Remote Host Connector registered with relay (${connectUrl}) [hostId=${hostId}]`);
      },
    });
    process.on('SIGINT', () => {
      connector.close().finally(() => process.exit(0));
    });
  } else {
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLoopback && !token.trim()) {
      console.error(`Error: Refusing to bind non-loopback address (${host}:${port}) without --token or OPENDIY_REMOTE_TOKEN.`);
      process.exit(1);
    }

    const instance = createRemoteServer({
      mode,
      token,
      hostSecret: hostSecret || token,
      workspaceDir: workspaceDir || undefined,
    });
    instance.server.listen(port, host, () => {
      const addr = instance.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`OpenDIY Remote (${mode} mode) listening on http://${host}:${actualPort}`);
    });
  }
}
