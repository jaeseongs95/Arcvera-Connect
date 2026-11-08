import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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

export const RELAY_PROTOCOL_VERSION = '1.0.0';
export const RELAY_INVOKE_TIMEOUT_MS = 30 * 1000;

export const RELAY_COMMAND_ALLOWLIST = Object.freeze([
  'get_ui_language',
  'set_ui_language',
  'prepare_runtime',
  'get_codex_settings',
  'runtime_compatibility',
  'runtime_pair_status',
  'runtime_transition_preview',
  'load_layout',
  'save_layout',
  'list_projects',
  'import_project',
  'create_project',
  'rename_project',
  'set_project_favorite',
  'delete_project',
  'reorder_project',
  'start_session',
  'list_sessions',
  'session_write',
  'session_resize',
  'session_stop',
  'session_output_ack',
  'move_session_to_project',
  'list_external',
  'catalog_list',
  'catalog_preview',
  'extensions_list',
  'extensions_mutate',
  'mobile_control',
  'subagents_request',
  'cron_request',
  'saved_cron_list',
  'saved_cron_save',
  'saved_cron_delete',
  'saved_cron_register',
  'conversation_request',
  'list_pending_questions',
  'respond_pending_question',
  'choose_conversation_attachments',
  'conversation_attachment_storage',
  'stage_conversation_image',
  'cleanup_conversation_attachment',
  'weekly_usage',
  'choose_project_folder',
  'choose_skill_folder',
  'choose_project',
  'list_directory',
  'slash_commands_list',
  'check_for_updates',
  'apply_update',
]);

export const RELAY_BLOCKED_COMMANDS = Object.freeze([
  'complete_exit',
  'unconfirmed_exit_available',
  'set_codex_executable',
  'set_app_server_executable',
  'choose_codex_executable',
  'choose_app_server_executable',
  'apply_runtime_transition',
  'open_external_url',
]);

export const RELAY_EVENT_ALLOWLIST = Object.freeze([
  'terminal-output',
  'session-output',
  'session-changed',
  'host-connection-changed',
  'runtime-updated',
  'update-available',
  'update-status-changed',
]);

export const GITHUB_REPO_SLUG = 'jaeseongs95/opendiy-remote';

export function parseSemverTuple(rawVersion) {
  const cleaned = String(rawVersion ?? '').trim().replace(/^v/i, '').split('-')[0];
  const parts = cleaned.split('.').map(n => Number.parseInt(n, 10));
  if (parts.length < 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return [parts[0], parts[1], parts[2]];
}

export function compareSemver(a, b) {
  const ta = parseSemverTuple(a);
  const tb = parseSemverTuple(b);
  if (!ta && !tb) return 0;
  if (!ta) return -1;
  if (!tb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (ta[i] !== tb[i]) return ta[i] > tb[i] ? 1 : -1;
  }
  return 0;
}

export function readInstalledVersion(rootDir = ROOT_DIR) {
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '1.0.0').trim().replace(/^v/i, '');
  } catch {
    return '1.0.0';
  }
}

export async function fetchLatestReleaseInfo(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const currentVersion = options.currentVersion
    ? String(options.currentVersion).trim().replace(/^v/i, '')
    : readInstalledVersion(rootDir);
  const repoSlug = options.repoSlug || process.env.OPENDIY_REMOTE_UPDATE_REPO || GITHUB_REPO_SLUG;
  const releaseApiUrl =
    options.releaseApiUrl ||
    process.env.OPENDIY_REMOTE_RELEASE_API_URL ||
    `https://api.github.com/repos/${repoSlug}/releases/latest`;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const res = await fetchFn(releaseApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `opendiy-remote/${currentVersion}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub Release 조회 실패 (HTTP ${res.status})`);
  }
  const release = await res.json();
  const tagName = String(release.tag_name || release.tagName || '').trim();
  const latestVersion = tagName.replace(/^v/i, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const tarAsset =
    assets.find(a => typeof a?.name === 'string' && a.name.endsWith('-relay-bundle.tar.gz')) ||
    assets.find(a => typeof a?.name === 'string' && a.name.endsWith('.tar.gz')) ||
    null;
  const rawDigest = String(tarAsset?.digest || '').trim();
  const sha256 = rawDigest.toLowerCase().startsWith('sha256:')
    ? rawDigest.slice('sha256:'.length).toLowerCase()
    : /^[a-f0-9]{64}$/i.test(rawDigest)
      ? rawDigest.toLowerCase()
      : null;

  const updateAvailable = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
  return {
    currentVersion,
    latestVersion: latestVersion || currentVersion,
    tagName: tagName || `v${currentVersion}`,
    updateAvailable,
    bundleUrl: tarAsset ? String(tarAsset.browser_download_url || tarAsset.url || '') : null,
    bundleName: tarAsset ? String(tarAsset.name || '') : null,
    bundleSize: tarAsset && Number.isFinite(Number(tarAsset.size)) ? Number(tarAsset.size) : null,
    sha256,
    publishedAt: release.published_at || release.created_at || null,
    releaseUrl: release.html_url || release.url || `https://github.com/${repoSlug}/releases/tag/${tagName}`,
    notes: String(release.body || '').trim(),
    checkedAt: Date.now(),
  };
}

let activeUpdatePromise = null;

export async function performSelfUpdate(options = {}) {
  if (activeUpdatePromise) return activeUpdatePromise;
  activeUpdatePromise = (async () => {
    const rootDir = path.resolve(options.rootDir || ROOT_DIR);
    const fetchFn = options.fetchFn || globalThis.fetch;
    const info = options.releaseInfo || (await fetchLatestReleaseInfo({ ...options, rootDir, fetchFn }));
    if (!info.updateAvailable && !options.force) {
      return {
        updated: false,
        alreadyUpToDate: true,
        previousVersion: info.currentVersion,
        version: info.currentVersion,
        tagName: info.tagName,
        restartScheduled: false,
      };
    }
    if (!info.bundleUrl) {
      throw new Error(`릴리스(${info.tagName})에서 업데이트 번들(.tar.gz)을 찾을 수 없습니다.`);
    }

    const bundleRes = await fetchFn(info.bundleUrl, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': `opendiy-remote/${info.currentVersion}`,
      },
    });
    if (!bundleRes.ok) {
      throw new Error(`업데이트 번들 다운로드 실패 (HTTP ${bundleRes.status})`);
    }
    const arrayBuf = await bundleRes.arrayBuffer();
    const bundleBuf = Buffer.from(arrayBuf);
    if (bundleBuf.length < 128) {
      throw new Error('다운로드된 업데이트 번들 크기가 비정상적으로 작습니다.');
    }

    const actualSha256 = crypto.createHash('sha256').update(bundleBuf).digest('hex').toLowerCase();
    if (info.sha256 && actualSha256 !== info.sha256.toLowerCase()) {
      throw new Error(`업데이트 번들 SHA-256 무결성 검증 실패 (기대값: ${info.sha256}, 실제값: ${actualSha256})`);
    }

    const tmpStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendiy-remote-update-'));
    const archivePath = path.join(tmpStageDir, 'bundle.tar.gz');
    const extractDir = path.join(tmpStageDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      fs.writeFileSync(archivePath, bundleBuf);
      execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        stdio: 'pipe',
        timeout: 30000,
        windowsHide: true,
      });

      const extractedPkgPath = path.join(extractDir, 'package.json');
      const extractedServerPath = path.join(extractDir, 'server', 'remote-server.mjs');
      const extractedDistIndex = path.join(extractDir, 'dist', 'index.html');
      if (!fs.existsSync(extractedPkgPath) || !fs.existsSync(extractedServerPath) || !fs.existsSync(extractedDistIndex)) {
        throw new Error('업데이트 번들 구조 검증 실패: 필수 파일(package.json, server/remote-server.mjs, dist/index.html)이 누락되었습니다.');
      }

      const backupDir = path.join(rootDir, '.backup-prev');
      try {
        fs.rmSync(backupDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {}
      fs.mkdirSync(backupDir, { recursive: true });

      const targets = ['dist', 'server', 'scripts', 'package.json', 'README.md', 'README.ko.md'];
      for (const rel of targets) {
        const currentTarget = path.join(rootDir, rel);
        const backupTarget = path.join(backupDir, rel);
        if (fs.existsSync(currentTarget)) {
          fs.cpSync(currentTarget, backupTarget, { recursive: true, force: true });
        }
      }

      try {
        const nextDist = path.join(extractDir, 'dist');
        const targetDist = path.join(rootDir, 'dist');
        if (fs.existsSync(nextDist)) {
          fs.rmSync(targetDist, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          fs.cpSync(nextDist, targetDist, { recursive: true, force: true });
        }
        for (const rel of ['server', 'scripts', 'package.json', 'README.md', 'README.ko.md']) {
          const srcPath = path.join(extractDir, rel);
          const dstPath = path.join(rootDir, rel);
          if (fs.existsSync(srcPath)) {
            fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
          }
        }
      } catch (applyErr) {
        // Rollback from backupDir on partial write failure
        for (const rel of targets) {
          const backupTarget = path.join(backupDir, rel);
          const currentTarget = path.join(rootDir, rel);
          if (fs.existsSync(backupTarget)) {
            try {
              fs.cpSync(backupTarget, currentTarget, { recursive: true, force: true });
            } catch {}
          }
        }
        throw applyErr;
      }

      const installedVersion = readInstalledVersion(rootDir);
      const shouldScheduleRestart = options.scheduleRestart === true;
      if (shouldScheduleRestart) {
        const restartDelayMs = Math.max(100, Number(options.restartDelayMs || 600));
        const timer = setTimeout(() => {
          if (typeof options.onRestart === 'function') {
            options.onRestart();
            return;
          }
          if (process.env.INVOCATION_ID || process.env.OPENDIY_REMOTE_MANAGED_RESTART === '1') {
            process.exit(0);
          } else {
            const child = spawn(process.execPath, process.argv.slice(1), {
              cwd: process.cwd(),
              env: process.env,
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            child.unref();
            process.exit(0);
          }
        }, restartDelayMs);
        timer.unref?.();
      }

      return {
        updated: true,
        alreadyUpToDate: false,
        previousVersion: info.currentVersion,
        version: installedVersion,
        tagName: info.tagName,
        sha256: actualSha256,
        restartScheduled: shouldScheduleRestart,
      };
    } finally {
      try {
        fs.rmSync(tmpStageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {}
    }
  })().finally(() => {
    activeUpdatePromise = null;
  });
  return activeUpdatePromise;
}

const RELAY_COMMAND_SET = new Set(RELAY_COMMAND_ALLOWLIST);
const RELAY_EVENT_SET = new Set(RELAY_EVENT_ALLOWLIST);

export function normalizeRelayBaseUrl(rawUrl) {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    throw new Error('연결할 중계 서버 주소(--connect <url> 또는 OPENDIY_REMOTE_RELAY_URL)를 지정하세요.');
  }
  const normalizedScheme = trimmed
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');
  let parsed;
  try {
    parsed = new URL(normalizedScheme);
  } catch {
    throw new Error(`유효하지 않은 중계 서버 URL입니다: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`지원하지 않는 중계 서버 프로토콜입니다 (${parsed.protocol}): http://, https://, ws://, wss:// 만 허용됩니다.`);
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/api\/relay(?:\/.*)?$/i, '').replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

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
    path.join(codexHome, 'packages', 'app-server-daemon', 'current', 'bin', exeName),
    path.join(codexHome, 'packages', 'app-server-daemon', 'current', exeName),
    path.join(codexHome, 'packages', 'standalone', 'current', 'bin', exeName),
    path.join(codexHome, 'packages', 'standalone', 'current', exeName),
  ];
  for (const candidate of managedCandidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return { savedPath: null, resolvedPath: candidate, source: 'path', error: null };
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

function scanSkillsInDir(baseDir, scope, pluginId = null) {
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
        name: (nameMatch ? nameMatch[1] : entry.name).trim().replace(/^["']|["']$/g, ''),
        description: (descMatch ? descMatch[1] : '').trim().replace(/^["']|["']$/g, ''),
        path: skillMd,
        scope,
        enabled: true,
        pluginId,
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
  const seenPluginKeys = new Set();
  const addPluginFromDir = (pluginDir, marketplaceName = 'local', fallbackId = null, fallbackVer = null) => {
    try {
      const manifestCandidates = [
        path.join(pluginDir, '.codex-plugin', 'plugin.json'),
        path.join(pluginDir, '.gemini-plugin', 'plugin.json'),
        path.join(pluginDir, 'plugin.json'),
      ];
      let manifest = null;
      for (const mp of manifestCandidates) {
        if (fs.existsSync(mp)) {
          manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
          break;
        }
      }
      const pluginId = String(manifest?.id || manifest?.name || fallbackId || path.basename(pluginDir));
      const version = manifest?.version ? String(manifest.version) : fallbackVer;
      const key = `${marketplaceName}:${pluginId}`;
      if (seenPluginKeys.has(key)) return;
      seenPluginKeys.add(key);
      installedPlugins.push({
        pluginId,
        name: String(manifest?.name || pluginId),
        marketplaceName,
        version: version || null,
        enabled: true,
        source: pluginDir,
        installPolicy: null,
        authPolicy: null,
      });
      const skillsSubdir = path.join(pluginDir, 'skills');
      if (fs.existsSync(skillsSubdir)) {
        skills.push(...scanSkillsInDir(skillsSubdir, 'plugin', pluginId));
      }
    } catch {
      // Ignore malformed plugin directory.
    }
  };
  const pluginsDir = path.join(codexHome, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    try {
      const cacheDir = path.join(pluginsDir, 'cache');
      if (fs.existsSync(cacheDir)) {
        for (const mpEntry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
          if (!mpEntry.isDirectory() || mpEntry.name.startsWith('.')) continue;
          const mpPath = path.join(cacheDir, mpEntry.name);
          for (const plugEntry of fs.readdirSync(mpPath, { withFileTypes: true })) {
            if (!plugEntry.isDirectory() || plugEntry.name.startsWith('.') || plugEntry.name.startsWith('plugin-backup-') || plugEntry.name.startsWith('plugin-install-')) continue;
            const plugPath = path.join(mpPath, plugEntry.name);
            const verEntries = fs.readdirSync(plugPath, { withFileTypes: true })
              .filter(e => e.isDirectory() && !e.name.startsWith('.'))
              .map(e => e.name)
              .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            if (verEntries.length > 0) {
              addPluginFromDir(path.join(plugPath, verEntries[0]), mpEntry.name, plugEntry.name, verEntries[0]);
            } else {
              addPluginFromDir(plugPath, mpEntry.name, plugEntry.name, null);
            }
          }
        }
      }
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'cache' || entry.name === 'data') continue;
        addPluginFromDir(path.join(pluginsDir, entry.name), 'local', entry.name, null);
      }
    } catch {
      // Ignore unreadable plugin directories.
    }
  }
  const hookItems = [];
  const hookErrors = [];
  const hooksJsonPath = path.join(codexHome, 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const rawHooks = fs.readFileSync(hooksJsonPath, 'utf8');
      const parsedHooks = JSON.parse(rawHooks);
      const hooksObj = parsedHooks?.hooks && typeof parsedHooks.hooks === 'object' ? parsedHooks.hooks : {};
      const hash = crypto.createHash('sha256').update(rawHooks).digest('hex').slice(0, 16);
      for (const [eventName, groups] of Object.entries(hooksObj)) {
        if (!Array.isArray(groups)) continue;
        groups.forEach((group, gIdx) => {
          const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
          handlers.forEach((h, hIdx) => {
            hookItems.push({
              key: `${eventName}:${gIdx}:${hIdx}`,
              eventName,
              handlerType: h.type === 'mcpTool' || h.type === 'prompt' || h.type === 'agent' ? h.type : 'command',
              command: h.command || h.commandWindows || null,
              server: h.server || null,
              tool: h.tool || null,
              async: Boolean(h.async),
              matcher: group?.matcher || null,
              timeoutSec: Number(h.timeout || 10),
              statusMessage: h.statusMessage || null,
              additionalContextLimit: h.additionalContextLimit ?? null,
              sourcePath: hooksJsonPath,
              source: 'user',
              pluginId: null,
              enabled: true,
              isManaged: false,
              currentHash: hash,
              trustStatus: 'trusted',
            });
          });
        });
      }
    } catch (err) {
      hookErrors.push({ path: hooksJsonPath, message: String(err.message || err) });
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
      items: hookItems,
      warnings: [],
      errors: hookErrors,
    },
    skillDestinations: {
      user: path.join(codexHome, 'skills'),
      project: cwd ? path.join(cwd, '.codex', 'skills') : null,
    },
    errors: [],
  };
}

function normalizeWindowsExtendedPath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}

function getDefaultDesktopDbPath() {
  if (process.env.OPENDIY_DESKTOP_DB_PATH) return process.env.OPENDIY_DESKTOP_DB_PATH;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'io.agentgrid.desktop', 'workspace.sqlite3');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'io.agentgrid.desktop', 'workspace.sqlite3');
  }
  return path.join(os.homedir(), '.local', 'share', 'io.agentgrid.desktop', 'workspace.sqlite3');
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
  const rawType = typeof rawItem.type === 'string' ? rawItem.type : '';
  const lowerType = rawType ? rawType[0].toLowerCase() + rawType.slice(1) : '';
  if (lowerType === 'agentMessage') {
    const textFromContent = Array.isArray(rawItem.content)
      ? rawItem.content.map(c => String(c?.text ?? '')).filter(Boolean).join('\n')
      : '';
    return {
      ...rawItem,
      id,
      type: 'agentMessage',
      text: String(rawItem.text ?? (textFromContent || rawItem.message || '')),
      status: String(rawItem.status || 'completed'),
    };
  }
  if (lowerType === 'userMessage') {
    const content = Array.isArray(rawItem.content)
      ? rawItem.content.map(c => ({ ...c, type: c?.type === 'Text' ? 'text' : (c?.type || 'text'), text: String(c?.text ?? '') }))
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
  if (lowerType === 'commandExecution') {
    const cmdStr = Array.isArray(rawItem.command)
      ? rawItem.command.join(' ')
      : String(rawItem.command ?? '');
    return {
      ...rawItem,
      id,
      type: 'commandExecution',
      command: cmdStr,
      aggregatedOutput: String(rawItem.aggregatedOutput ?? rawItem.aggregated_output ?? ''),
      status: String(rawItem.status || 'completed'),
    };
  }
  if (lowerType === 'fileChange') {
    let changes = rawItem.changes;
    if (changes && !Array.isArray(changes) && typeof changes === 'object') {
      changes = Object.entries(changes).map(([filePath, detail]) => ({
        path: filePath,
        diff: String(detail?.diff ?? detail?.unified_diff ?? detail?.type ?? ''),
      }));
    }
    return {
      ...rawItem,
      id,
      type: 'fileChange',
      changes: Array.isArray(changes) ? changes : [],
      status: String(rawItem.status || 'completed'),
    };
  }
  if (lowerType === 'mcpToolCall') {
    return {
      ...rawItem,
      id,
      type: 'mcpToolCall',
      server: String(rawItem.server || 'mcp'),
      tool: String(rawItem.tool || ''),
      arguments: rawItem.arguments ?? {},
      result: rawItem.result ?? rawItem.error ?? {},
      status: String(rawItem.status || 'completed'),
    };
  }
  if (lowerType === 'reasoning') {
    const summaryArr = Array.isArray(rawItem.summary)
      ? rawItem.summary.map(s => (typeof s === 'string' ? s : String(s?.text ?? '')))
      : Array.isArray(rawItem.summary_text)
        ? rawItem.summary_text.map(s => String(s ?? ''))
        : [];
    return {
      ...rawItem,
      id,
      type: 'reasoning',
      summary: summaryArr,
      content: Array.isArray(rawItem.content) ? rawItem.content : [],
      status: String(rawItem.status || 'completed'),
    };
  }
  if (lowerType) {
    return { ...rawItem, id, type: lowerType };
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

function itemFullDetailText(item) {
  if (!item || typeof item !== 'object') return String(item ?? '');
  const type = String(item.type || '');
  if (type === 'commandExecution') {
    const cmd = String(item.command ?? '');
    const out = String(item._fullAggregatedOutput ?? item.aggregatedOutput ?? '');
    return [cmd, out].filter(Boolean).join('\n\n');
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item._fullChanges ?? item.changes) ? (item._fullChanges ?? item.changes) : [];
    return changes.map(c => `${String(c?.path ?? '')}\n${String(c?.diff ?? '')}`).join('\n\n');
  }
  if (type === 'mcpToolCall') {
    const argsStr = typeof item._fullArgumentsJson === 'string' ? item._fullArgumentsJson : JSON.stringify(item.arguments ?? {});
    const resStr = typeof item._fullResultJson === 'string' ? item._fullResultJson : JSON.stringify(item.result ?? item.error ?? {});
    return `${String(item.server || 'mcp')} / ${String(item.tool || '')}\n${argsStr}\n${resStr}`;
  }
  if (type === 'reasoning') {
    const parts = [...(item._fullSummary ?? item.summary ?? []), ...(item._fullContent ?? item.content ?? [])];
    return parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
  }
  return String(item._fullText ?? item.text ?? item.message ?? '');
}

const ITEM_PREVIEW_LIMIT = 16384;

function serializeItemForPage(item) {
  if (!item || typeof item !== 'object') return item;
  const fullText = itemFullDetailText(item);
  const isTruncated = fullText.length > ITEM_PREVIEW_LIMIT || Boolean(item.truncated);
  const out = { ...item };
  delete out._fullText;
  delete out._fullAggregatedOutput;
  delete out._fullChanges;
  delete out._fullArgumentsJson;
  delete out._fullResultJson;
  delete out._fullSummary;
  delete out._fullContent;
  if (!isTruncated) return out;
  out.truncated = true;
  out.hasMore = true;
  if (out.type === 'agentMessage') {
    out.text = String(out.text ?? '').slice(0, ITEM_PREVIEW_LIMIT);
  } else if (out.type === 'userMessage') {
    const sliced = String(out.text ?? '').slice(0, ITEM_PREVIEW_LIMIT);
    out.text = sliced;
    out.content = [{ type: 'text', text: sliced }];
  } else if (out.type === 'commandExecution') {
    out.aggregatedOutput = String(out.aggregatedOutput ?? '').slice(0, ITEM_PREVIEW_LIMIT);
  } else if (out.type === 'fileChange' && Array.isArray(out.changes)) {
    let budget = ITEM_PREVIEW_LIMIT;
    const boundedChanges = [];
    for (const ch of out.changes) {
      if (budget <= 0) break;
      const diffStr = String(ch?.diff ?? '');
      const slicedDiff = diffStr.slice(0, budget);
      budget -= slicedDiff.length;
      boundedChanges.push({ path: String(ch?.path ?? ''), diff: slicedDiff });
    }
    out.changes = boundedChanges;
  } else if (out.type === 'mcpToolCall') {
    const resJson = JSON.stringify(out.result ?? {});
    if (resJson.length > ITEM_PREVIEW_LIMIT) {
      out.result = { preview: resJson.slice(0, ITEM_PREVIEW_LIMIT), __detail: true };
    }
  }
  return out;
}

const rolloutSummaryCache = new Map(); // threadId -> { rolloutPath, mtimeMs, size, summary }
let latestObservedRateLimits = null;

function readCodexRolloutSummary(threadId, customCodexHome = null) {
  if (!threadId) return null;
  const stateDbPath = path.join(customCodexHome || getCodexHome(), 'state_5.sqlite');
  if (!fs.existsSync(stateDbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare('SELECT * FROM threads WHERE id = ?')
      .get(String(threadId));
    if (!row) return null;
    const rolloutPath = row.rollout_path ? normalizeWindowsExtendedPath(String(row.rollout_path)) : '';
    let st = null;
    if (rolloutPath && fs.existsSync(rolloutPath)) {
      try { st = fs.statSync(rolloutPath); } catch {}
    }
    const cached = rolloutSummaryCache.get(String(threadId));
    if (
      cached &&
      cached.rolloutPath === rolloutPath &&
      cached.size === (st ? st.size : 0) &&
      cached.mtimeMs === (st ? st.mtimeMs : 0) &&
      cached.updatedAt === Number(row.updated_at || 0)
    ) {
      return cached.summary;
    }

    const out = {
      id: String(row.id),
      title: String(row.name || row.title || ''),
      cwd: normalizeWindowsExtendedPath(String(row.cwd || '')),
      model: row.model ? String(row.model) : null,
      effort: row.reasoning_effort ? String(row.reasoning_effort) : null,
      usedTokens: 0,
      cumulativeTokens: Number(row.tokens_used || 0),
      modelContextWindow: 380000,
      rateLimits: null,
      createdAt: Number(row.created_at || Math.floor(Date.now() / 1000)),
      updatedAt: Number(row.updated_at || Math.floor(Date.now() / 1000)),
      turns: [],
      terminalLines: [],
      latestTurnStatus: 'completed',
    };
    out.rolloutPath = rolloutPath;
    out.rolloutSize = st ? st.size : 0;
    out.rolloutMtimeMs = st ? st.mtimeMs : 0;
    if (st && st.size > 0) {
      const readSize = Math.min(2048 * 1024, st.size);
      if (readSize > 0) {
        const fd = fs.openSync(rolloutPath, 'r');
        const buf = Buffer.alloc(readSize);
        try {
          fs.readSync(fd, buf, 0, readSize, st.size - readSize);
        } finally {
          fs.closeSync(fd);
        }
        const rawText = buf.toString('utf8');
        const rawLines = st.size > readSize ? rawText.split('\n').slice(1) : rawText.split('\n');
        const turnsMap = new Map();
        const baseTurnPrefix = `turn-${out.id.slice(0, 8)}`;
        let subTurnSeq = 1;
        let currentTurnId = `${baseTurnPrefix}-${subTurnSeq}`;
        const terminalLines = [];
        const pendingCallMap = new Map();
        let sawExplicitCompletion = false;
        let sawActivitySinceCompletion = false;

        function ensureTurn(tid) {
          if (!turnsMap.has(tid)) {
            turnsMap.set(tid, {
              id: tid,
              status: 'completed',
              createdAt: out.updatedAt,
              items: [],
            });
          }
          return turnsMap.get(tid);
        }

        function startNextSubTurn(explicitId = null) {
          subTurnSeq += 1;
          currentTurnId = explicitId ? `${explicitId}-${subTurnSeq}` : `${baseTurnPrefix}-${subTurnSeq}`;
          return ensureTurn(currentTurnId);
        }

        function explicitIdOrNull(val) {
          return val ? String(val) : null;
        }

        function markTurnActive(targetTurn) {
          sawActivitySinceCompletion = true;
          out.latestTurnStatus = 'inProgress';
          if (targetTurn) targetTurn.status = 'inProgress';
        }

        function upsertTurnItem(turn, item) {
          if (!turn || !item || !item.id) return item;
          const existingIdx = turn.items.findIndex(it => it.id === item.id);
          if (existingIdx !== -1) {
            const prev = turn.items[existingIdx];
            const merged = {
              ...prev,
              ...item,
              text: item.text || prev.text || '',
              aggregatedOutput: item.aggregatedOutput || prev.aggregatedOutput || '',
            };
            turn.items[existingIdx] = merged;
            return merged;
          }
          turn.items.push(item);
          return item;
        }

        for (const line of rawLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            const p = obj.payload || {};
            const explicitTurnId = String(
              p.turn_id ||
                p.internal_chat_message_metadata_passthrough?.turn_id ||
                '',
            );
            if (!turnsMap.size && explicitTurnId) {
              currentTurnId = `${explicitTurnId}-${subTurnSeq}`;
            }
            let turn = ensureTurn(currentTurnId);

            if (
              (obj.type === 'event_msg' && p.type === 'task_started') ||
              obj.type === 'turn_context' ||
              obj.type === 'compacted'
            ) {
              if (turn.items.length > 0) {
                turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
              }
              if (obj.type === 'event_msg' && p.type === 'task_started') {
                markTurnActive(turn);
                if (p.model_context_window) {
                  out.modelContextWindow = Number(p.model_context_window);
                }
              }
            } else if (
              obj.type === 'event_msg' &&
              (p.type === 'task_complete' || p.type === 'turn_complete' || p.type === 'turn_aborted' || p.type === 'error')
            ) {
              sawExplicitCompletion = true;
              sawActivitySinceCompletion = false;
              turn.status = p.type === 'turn_aborted' ? 'interrupted' : 'completed';
              out.latestTurnStatus = turn.status;
            } else if (obj.type === 'event_msg' && p.type === 'token_count') {
              if (p.info?.last_token_usage?.total_tokens) {
                out.usedTokens = Number(p.info.last_token_usage.total_tokens);
              }
              if (p.info?.model_context_window) {
                out.modelContextWindow = Number(p.info.model_context_window);
              }
              if (p.rate_limits && typeof p.rate_limits === 'object') {
                out.rateLimits = p.rate_limits;
                latestObservedRateLimits = {
                  rateLimits: p.rate_limits,
                  observedAt: Date.now(),
                };
              }
            } else if (
              (obj.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'developer')) ||
              (obj.type === 'event_msg' && p.type === 'user_message' && p.message)
            ) {
              const txt = Array.isArray(p.content)
                ? p.content.map(c => String(c?.text ?? '')).join('\n').trim()
                : String(p.message ?? '').trim();
              const isDeveloperWake =
                p.role === 'developer' &&
                (txt.includes('[agent-governance-suite') || txt.includes('peer message'));
              if (isDeveloperWake && turn.items.some(it => it.type === 'agentMessage' || it.type === 'commandExecution' || it.type === 'mcpToolCall')) {
                turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
              }
              if (isDeveloperWake) {
                markTurnActive(turn);
              }
              if (
                p.role !== 'developer' &&
                txt &&
                !txt.startsWith('<hook_prompt') &&
                !txt.startsWith('[AGS 단계 확인]')
              ) {
                if (turn.items.some(it => it.type === 'agentMessage' || it.type === 'commandExecution' || it.type === 'mcpToolCall')) {
                  turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
                }
                markTurnActive(turn);
                const alreadyAdded = turn.items.some(it => it.type === 'userMessage' && it.text === txt);
                if (!alreadyAdded) {
                  const uItem = normalizeConversationItem(
                    { id: p.id || `u-${turn.id}-${turn.items.length}`, type: 'userMessage', role: 'user', text: txt, status: 'completed' },
                    turn.items.length,
                    turn.id,
                  );
                  upsertTurnItem(turn, uItem);
                  terminalLines.push(`\x1b[90m›\x1b[0m \x1b[1m${txt.split('\n')[0].slice(0, 160)}\x1b[0m`);
                }
              }
            } else if (
              obj.type === 'response_item' &&
              (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'reasoning')
            ) {
              markTurnActive(turn);
              if ((p.type === 'function_call' || p.type === 'custom_tool_call') && (p.call_id || p.id)) {
                if (turn.items.length >= 25 || turn.items.some(it => it.type === 'agentMessage')) {
                  turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
                  markTurnActive(turn);
                }
                const callId = String(p.call_id || p.id);
                let cmd = String(p.name || 'command');
                if (p.type === 'custom_tool_call' && typeof p.input === 'string' && p.input.trim()) {
                  const firstInputLine = p.input.trim().split(/\r?\n/)[0].slice(0, 120);
                  cmd = `${cmd}: ${firstInputLine}`;
                } else {
                  try {
                    const parsedArgs = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments;
                    if (parsedArgs?.cmd) cmd = String(parsedArgs.cmd);
                    else if (Array.isArray(parsedArgs?.command)) cmd = parsedArgs.command.join(' ');
                  } catch {}
                }
                const cItem = normalizeConversationItem(
                  { id: callId, type: 'commandExecution', command: cmd, aggregatedOutput: '', status: 'completed' },
                  turn.items.length,
                  turn.id,
                );
                const stored = upsertTurnItem(turn, cItem);
                pendingCallMap.set(callId, stored);
                if (p.type === 'function_call') {
                  terminalLines.push(`\x1b[38;5;114m• Ran\x1b[0m ${cmd.slice(0, 140)}`);
                }
              }
            } else if (
              obj.type === 'response_item' &&
              (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')
            ) {
              markTurnActive(turn);
              if (p.call_id) {
                const target = pendingCallMap.get(String(p.call_id));
                if (target) {
                  if (Array.isArray(p.output)) {
                    target.aggregatedOutput = p.output.map(chunk => String(chunk?.text ?? '')).join('\n');
                  } else {
                    target.aggregatedOutput = String(p.output ?? '');
                  }
                }
              }
            } else if (
              (obj.type === 'event_msg' && p.type === 'agent_message' && p.message) ||
              (obj.type === 'response_item' && p.type === 'message' && p.role === 'assistant')
            ) {
              const txt = Array.isArray(p.content)
                ? p.content.map(c => String(c?.text ?? '')).join('\n').trim()
                : String(p.message ?? '').trim();
              const itemId = String(p.id || `a-${turn.id}-${turn.items.length}`);
              const phase = String(p.phase || '').toLowerCase();
              if (txt && !turn.items.some(it => it.id === itemId || (it.type === 'agentMessage' && it.text === txt))) {
                if (turn.items.some(it => it.type === 'agentMessage')) {
                  turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
                }
                const aItem = normalizeConversationItem(
                  { id: p.id || `a-${turn.id}-${turn.items.length}`, type: 'agentMessage', role: 'assistant', text: txt, status: 'completed' },
                  turn.items.length,
                  turn.id,
                );
                upsertTurnItem(turn, aItem);
                if (phase === 'commentary') {
                  markTurnActive(turn);
                } else {
                  out.latestTurnStatus = 'completed';
                  turn.status = 'completed';
                  sawActivitySinceCompletion = false;
                }
                for (const al of txt.split(/\r?\n/).slice(0, 6)) {
                  terminalLines.push(`\x1b[38;5;252m• ${al}\x1b[0m`);
                }
              }
            } else if (obj.type === 'event_msg' && p.type === 'item_completed' && p.item) {
              if (p.item.type === 'HookPrompt') continue;
              const rawId = p.item.id ? String(p.item.id) : '';
              if (
                (p.item.type === 'AgentMessage' || p.item.type === 'agentMessage') &&
                !turn.items.some(it => it.id === rawId) &&
                turn.items.some(it => it.type === 'agentMessage')
              ) {
                turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
              } else if (
                turn.items.length >= 25 &&
                !turn.items.some(it => it.id === rawId) &&
                turn.items.some(it => it.type === 'agentMessage')
              ) {
                turn = startNextSubTurn(explicitIdOrNull(explicitTurnId));
              }
              const norm = normalizeConversationItem(p.item, turn.items.length, turn.id);
              const alreadyExisted = turn.items.some(it => it.id === norm.id);
              const stored = upsertTurnItem(turn, norm);
              if (stored.type === 'commandExecution' && stored.id) {
                pendingCallMap.set(String(stored.id), stored);
              }
              if (norm.type === 'commandExecution' || norm.type === 'mcpToolCall' || norm.type === 'fileChange' || norm.type === 'reasoning') {
                markTurnActive(turn);
              }
              if (!alreadyExisted) {
                if (norm.type === 'commandExecution' && norm.command) {
                  terminalLines.push(`\x1b[38;5;114m• Ran\x1b[0m ${String(norm.command).slice(0, 140)}`);
                  if (norm.aggregatedOutput) {
                    const allOutLines = String(norm.aggregatedOutput).trim().split(/\r?\n/);
                    const firstOut = allOutLines.slice(0, 3);
                    for (const ol of firstOut) terminalLines.push(`  \x1b[90m└ ${ol.slice(0, 140)}\x1b[0m`);
                    if (allOutLines.length > 3) {
                      terminalLines.push(`  \x1b[90m+ ${allOutLines.length - 3} lines (ctrl+o to expand)\x1b[0m`);
                    }
                  }
                } else if (norm.type === 'mcpToolCall' && norm.tool) {
                  terminalLines.push(`\x1b[38;5;114m• Called\x1b[0m ${norm.server}.${norm.tool}`);
                } else if (norm.type === 'fileChange' && Array.isArray(norm.changes) && norm.changes.length) {
                  terminalLines.push(`\x1b[38;5;114m• Edited\x1b[0m ${norm.changes.map(c => c.path).join(', ')}`);
                } else if (norm.type === 'agentMessage' && norm.text) {
                  const itemPhase = String(p.item.phase || '').toLowerCase();
                  if (itemPhase === 'commentary') {
                    markTurnActive(turn);
                  } else {
                    out.latestTurnStatus = 'completed';
                    turn.status = 'completed';
                    sawActivitySinceCompletion = false;
                  }
                  for (const al of String(norm.text).trim().split(/\r?\n/).slice(0, 6)) {
                    terminalLines.push(`\x1b[38;5;252m• ${al}\x1b[0m`);
                  }
                }
              }
            }
          } catch {
            // Skip truncated or unparseable JSONL line.
          }
        }
        if (out.usedTokens === 0 && out.cumulativeTokens > 0 && out.cumulativeTokens <= out.modelContextWindow * 2) {
          out.usedTokens = out.cumulativeTokens;
        }
        if (sawActivitySinceCompletion) {
          out.latestTurnStatus = 'inProgress';
        }
        // If the rollout file has not been modified for more than 120 seconds, any stale inProgress turn has settled.
        if (out.latestTurnStatus === 'inProgress' && st.mtimeMs && Date.now() - st.mtimeMs > 120 * 1000) {
          out.latestTurnStatus = 'completed';
          for (const t of turnsMap.values()) {
            if (t.status === 'inProgress') t.status = 'completed';
          }
        }
        out.turns = [...turnsMap.values()].filter(t => t.items.length > 0).slice(-50);
        if (out.latestTurnStatus === 'inProgress' && out.turns.length > 0) {
          out.turns[out.turns.length - 1].status = 'inProgress';
        }
        const modelLabel = out.model ? out.model.replace(/^gpt-6\.1-sol$/i, 'GPT-6.1-Sol') : 'GPT-6.1-Sol';
        const effortLabel = out.effort || 'high';
        const winK = Math.round((out.modelContextWindow || 380000) / 1000);
        const weeklyUsedPct = out.rateLimits?.primary?.used_percent ?? latestObservedRateLimits?.rateLimits?.primary?.used_percent;
        const weeklyLeftText = Number.isFinite(Number(weeklyUsedPct))
          ? ` \x1b[90m·\x1b[0m \x1b[38;5;214mweekly ${Math.max(0, 100 - Math.round(Number(weeklyUsedPct)))}% left\x1b[0m`
          : '';
        const tailLines = terminalLines.slice(-250);
        if (out.latestTurnStatus === 'inProgress') {
          tailLines.push('');
          tailLines.push('\x1b[38;5;114m• Working (esc 중단)\x1b[0m');
        }
        tailLines.push('');
        tailLines.push('\x1b[38;5;141m›\x1b[0m \x1b[90mAsk Codex to do anything\x1b[0m');
        tailLines.push(
          `\x1b[38;5;214m${modelLabel} ${effortLabel}\x1b[0m \x1b[90m·\x1b[0m \x1b[38;5;141m${out.title || 'session'}\x1b[0m \x1b[90m· ${winK}K window\x1b[0m${weeklyLeftText}`,
        );
        out.terminalLines = tailLines;
      }
    }
    rolloutSummaryCache.set(String(threadId), {
      rolloutPath,
      size: st ? st.size : 0,
      mtimeMs: st ? st.mtimeMs : 0,
      updatedAt: Number(row.updated_at || 0),
      summary: out,
    });
    return out;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
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
  const rl = rateLimitsPayload?.rateLimits ?? rateLimitsPayload?.rate_limits ?? rateLimitsPayload;
  if (!rl || typeof rl !== 'object') return { limitName: null, weekly: null };
  const limitName =
    typeof rl.limitName === 'string'
      ? rl.limitName
      : typeof rl.limit_name === 'string'
        ? rl.limit_name
        : typeof rl.limit_id === 'string'
          ? rl.limit_id
          : null;
  const candidates = [rl.weekly, rl.primary, rl.secondary].filter(Boolean);
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const isWeekly =
      entry === rl.weekly ||
      entry.windowDurationMins === 10080 ||
      entry.windowMinutes === 10080 ||
      entry.window_minutes === 10080;
    if (!isWeekly) continue;
    const usedPercent = Number(entry.usedPercent ?? entry.percentUsed ?? entry.used_percent ?? 0);
    if (!Number.isFinite(usedPercent)) continue;
    const rawReset = entry.resetsAt ?? entry.resetAt ?? entry.resets_at ?? null;
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

function readLatestRateLimitsFromRollouts(customCodexHome = null) {
  if (latestObservedRateLimits?.rateLimits) {
    return latestObservedRateLimits.rateLimits;
  }
  const stateDbPath = path.join(customCodexHome || getCodexHome(), 'state_5.sqlite');
  if (!fs.existsSync(stateDbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT id FROM threads ORDER BY updated_at DESC LIMIT 5')
      .all();
    db.close();
    db = null;
    for (const r of rows) {
      if (!r?.id) continue;
      const summary = readCodexRolloutSummary(String(r.id), customCodexHome);
      if (summary?.rateLimits) {
        return summary.rateLimits;
      }
    }
  } catch {} finally {
    try { db?.close(); } catch {}
  }
  return null;
}

class AppServerBridge {
  constructor(getSettings, onNotification, customTransport = null) {
    this.getSettings = getSettings;
    this.onNotification = onNotification;
    this.customTransport = customTransport;
    if (customTransport && typeof customTransport.subscribe === 'function') {
      customTransport.subscribe(msg => {
        if (msg && msg.method) this.onNotification(msg);
      });
    }
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

  const googleClientId = String(options.googleClientId ?? process.env.OPENDIY_REMOTE_GOOGLE_CLIENT_ID ?? '').trim();
  const googleClientSecret = String(options.googleClientSecret ?? process.env.OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET ?? '').trim();
  const allowedEmails = new Set(
    String(options.allowedEmail ?? process.env.OPENDIY_REMOTE_ALLOWED_EMAIL ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const googleOAuthEnabled = Boolean(googleClientId && googleClientSecret && allowedEmails.size > 0);
  const googleOAuthTokenUrl = String(options.googleOAuthTokenUrl || 'https://oauth2.googleapis.com/token');
  const googleOAuthUserInfoUrl = String(options.googleOAuthUserInfoUrl || 'https://openidconnect.googleapis.com/v1/userinfo');
  const sessionHmacSecret = crypto
    .createHash('sha256')
    .update(rawToken.trim() || rawHostSecret.trim() || googleClientSecret || crypto.randomBytes(32))
    .digest();
  const oauthStates = new Map(); // state -> { exp: number, cliSessionId: string | null }
  const cliOAuthSessions = new Map(); // cliSessionId -> { status: 'pending' | 'authenticated', token?: string, email?: string, exp: number }

  function signOAuthSessionToken(email, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    const payload = Buffer.from(
      JSON.stringify({
        email: String(email).toLowerCase(),
        exp: Date.now() + ttlMs,
      }),
      'utf8',
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', sessionHmacSecret).update(payload, 'utf8').digest('base64url');
    return `oauth.${payload}.${sig}`;
  }

  function verifyOAuthSessionToken(cookieVal) {
    if (!googleOAuthEnabled || typeof cookieVal !== 'string' || !cookieVal.startsWith('oauth.')) return false;
    const parts = cookieVal.split('.');
    if (parts.length !== 3) return false;
    const [, payload, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', sessionHmacSecret).update(payload, 'utf8').digest('base64url');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return false;
      if (Date.now() > parsed.exp) return false;
      return allowedEmails.has(parsed.email.toLowerCase());
    } catch {
      return false;
    }
  }

  function isClientCredentialValid(provided) {
    if (verifyOAuthSessionToken(provided)) return true;
    if (!tokenSha256 && googleOAuthEnabled) return false;
    return verifyToken(tokenSha256, provided);
  }

  function isHostCredentialValid(provided) {
    if (verifyOAuthSessionToken(provided)) return true;
    if (!hostSecretSha256 && googleOAuthEnabled) return false;
    return verifyToken(hostSecretSha256, provided);
  }

  function renderCliOAuthSuccessPage(email) {
    const safeEmail = String(email).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenDIY Remote — 호스트 커넥터 인증 완료</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0b0f17; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
    }
    .card {
      width: 100%; max-width: 420px; background: #151c28; border: 1px solid #263248;
      border-radius: 14px; padding: 28px 24px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); text-align: center;
    }
    .badge {
      display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px;
      border-radius: 50%; background: rgba(52, 211, 153, 0.16); color: #34d399; font-size: 24px; margin-bottom: 14px;
    }
    h1 { margin: 0 0 8px; font-size: 19px; font-weight: 700; color: #f9fafb; }
    p { margin: 0 0 18px; font-size: 13.5px; color: #9ca3af; line-height: 1.55; }
    .btn {
      display: inline-block; width: 100%; padding: 11px 14px; border-radius: 8px;
      background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="badge" aria-hidden="true">✓</div>
    <h1>로컬 PC 호스트 인증 완료</h1>
    <p><strong>${safeEmail}</strong> 계정으로 로컬 PC(Host Connector)가 인증되었습니다.<br/>터미널 창에서 자동으로 중계 서버 연결이 시작됩니다. 이 탭을 닫으거나 원격 작업 공간으로 이동하세요.</p>
    <a class="btn" href="/">원격 작업 공간 열기</a>
  </main>
</body>
</html>`;
  }

  function renderAuthGatePage({ errorMsg = '' } = {}) {
    const safeErr = String(errorMsg)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenDIY Remote — 로그인</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0b0f17; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 20px;
    }
    .card {
      width: 100%; max-width: 400px; background: #151c28; border: 1px solid #263248;
      border-radius: 14px; padding: 28px 24px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    h1 { margin: 0 0 6px; font-size: 20px; font-weight: 700; color: #f9fafb; }
    p.sub { margin: 0 0 22px; font-size: 13px; color: #9ca3af; line-height: 1.5; }
    .err {
      margin-bottom: 16px; padding: 10px 12px; border-radius: 8px;
      background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5; font-size: 13px;
    }
    .google-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 12px 16px; border-radius: 9px; border: 1px solid #374151;
      background: #ffffff; color: #111827; font-size: 14px; font-weight: 600;
      text-decoration: none; cursor: pointer; transition: opacity 0.15s;
    }
    .google-btn:hover { opacity: 0.92; }
    .divider {
      display: flex; align-items: center; gap: 10px; margin: 18px 0; color: #6b7280; font-size: 12px;
    }
    .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #263248; }
    form { display: flex; flex-direction: column; gap: 10px; }
    input[type="password"] {
      width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #2e3c56;
      background: #0f1520; color: #f3f4f6; font-size: 14px;
    }
    button.tok-btn {
      width: 100%; padding: 11px 14px; border-radius: 8px; border: none;
      background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    button.tok-btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <main class="card">
    <h1>OpenDIY Remote</h1>
    <p class="sub">소유자 전용 1:1 원격 작업 공간입니다. 허용된 계정으로 로그인하세요.</p>
    ${safeErr ? `<div class="err" role="alert">${safeErr}</div>` : ''}
    ${googleOAuthEnabled ? `
      <a class="google-btn" href="/auth/google">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Google 계정으로 로그인
      </a>
    ` : ''}
    ${tokenSha256 ? `
      ${googleOAuthEnabled ? '<div class="divider">또는 접속 토큰 사용</div>' : ''}
      <form method="GET" action="/">
        <input type="password" name="token" placeholder="브라우저 접속 토큰 (--token)" required autocomplete="current-password" />
        <button type="submit" class="tok-btn">토큰으로 접속</button>
      </form>
    ` : ''}
  </main>
</body>
</html>`;
  }

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

  const codexHomeDir = options.codexHomeDir || process.env.CODEX_HOME || null;
  const desktopDbPath =
    options.desktopDbPath === false
      ? null
      : options.desktopDbPath ||
        process.env.OPENDIY_DESKTOP_DB_PATH ||
        (!options.workspaceDir && mode !== 'relay' ? getDefaultDesktopDbPath() : null);

  function syncFromDesktopDatabase() {
    if (!desktopDbPath || mode === 'relay' || !fs.existsSync(desktopDbPath)) return false;
    let db = null;
    try {
      db = new DatabaseSync(desktopDbPath, { readOnly: true });
      const settingsRows = db.prepare('SELECT key, value FROM app_settings').all();
      const settingsMap = new Map();
      const syncedCrons = [];
      for (const r of settingsRows) {
        const k = String(r.key || '');
        const v = String(r.value ?? '');
        settingsMap.set(k, v);
        if (k.startsWith('saved_cron:')) {
          try {
            const parsedCron = JSON.parse(v);
            if (parsedCron && parsedCron.id) syncedCrons.push(parsedCron);
          } catch {}
        }
      }
      if (settingsMap.get('ui_language') === 'en' || settingsMap.get('ui_language') === 'ko') {
        state.uiLanguage = settingsMap.get('ui_language');
      }
      if (settingsMap.get('codex_executable') && !state.codexSavedPath) {
        state.codexSavedPath = normalizeWindowsExtendedPath(settingsMap.get('codex_executable'));
      }
      if (settingsMap.get('app_server_executable') && !state.appServerSavedPath) {
        state.appServerSavedPath = normalizeWindowsExtendedPath(settingsMap.get('app_server_executable'));
      }
      if (syncedCrons.length > 0) {
        const existingIds = new Set(state.savedCrons.map(c => c.id));
        for (const sc of syncedCrons) {
          if (!existingIds.has(sc.id)) state.savedCrons.push(sc);
        }
      }

      const rawProjects = db
        .prepare('SELECT id, cwd, canonical_cwd, name, created_at, favorite FROM projects')
        .all();
      let orderIds = [];
      if (settingsMap.has('project_order')) {
        try {
          const parsedOrder = JSON.parse(settingsMap.get('project_order'));
          if (Array.isArray(parsedOrder)) orderIds = parsedOrder.map(String);
        } catch {}
      }
      const orderRank = new Map(orderIds.map((id, idx) => [id, idx]));
      const mappedProjects = rawProjects.map(p => ({
        id: String(p.id),
        name: String(p.name),
        cwd: p.cwd ? normalizeWindowsExtendedPath(String(p.cwd)) : null,
        createdAt: Number(p.created_at || Math.floor(Date.now() / 1000)),
        favorite: Boolean(p.favorite),
      }));
      mappedProjects.sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        const ra = orderRank.has(a.id) ? orderRank.get(a.id) : 999999;
        const rb = orderRank.has(b.id) ? orderRank.get(b.id) : 999999;
        if (ra !== rb) return ra - rb;
        return a.createdAt - b.createdAt;
      });
      if (mappedProjects.length > 0) {
        state.projects = mappedProjects;
      }

      const layoutRow = db.prepare('SELECT layout FROM workspace_layout WHERE id = 1').get();
      let layoutSessions = [];
      if (layoutRow?.layout) {
        try {
          const parsedLayout = JSON.parse(String(layoutRow.layout));
          if (parsedLayout && typeof parsedLayout === 'object') {
            layoutSessions = Array.isArray(parsedLayout.sessions)
              ? parsedLayout.sessions.map((s, idx) => {
                  const sid = String(s.sessionId || s.id || `mirrored-session-${idx + 1}`);
                  const title = String(s.title || s.name || '세션');
                  const threadId = s.threadId || s.resumeSessionId || undefined;
                  return {
                    ...s,
                    sessionId: sid,
                    title,
                    ...(threadId ? { threadId: String(threadId) } : {}),
                    cwd: normalizeWindowsExtendedPath(String(s.cwd || '')),
                  };
                })
              : [];
            state.layout = {
              version: 1,
              columns: Number(parsedLayout.columns) || 2,
              columnSizes: Array.isArray(parsedLayout.columnSizes) ? parsedLayout.columnSizes : [1, 1],
              rowSizes: Array.isArray(parsedLayout.rowSizes) ? parsedLayout.rowSizes : [1, 1],
              sessions: layoutSessions,
            };
          }
        } catch {}
      }

      const metaRows = db.prepare('SELECT id, generation, metadata, updated_at FROM session_metadata').all();
      const metaById = new Map();
      for (const mr of metaRows) {
        try {
          const m = JSON.parse(String(mr.metadata || '{}'));
          metaById.set(String(mr.id), {
            ...m,
            id: String(mr.id),
            generation: Number(mr.generation || m.generation || 1),
            cwd: normalizeWindowsExtendedPath(String(m.cwd || '')),
          });
        } catch {}
      }

      return { layoutSessions, metaById };
    } catch {
      return false;
    } finally {
      try { db?.close(); } catch {}
    }
  }

  const authRateMap = new Map();
  function checkAndRecordAuth(ip, valid) {
    if (!tokenSha256 && !hostSecretSha256 && !googleOAuthEnabled) return { allowed: true };
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

  function invokeRelayHost(command, args = {}, timeoutMs = RELAY_INVOKE_TIMEOUT_MS) {
    if (command === 'unconfirmed_exit_available') {
      return Promise.resolve(false);
    }
    if (command === 'session_output_ack') {
      return Promise.resolve(null);
    }
    if (!RELAY_COMMAND_SET.has(command)) {
      return Promise.reject(new Error(`원격 중계에서 허용되지 않는 명령입니다: ${command}`));
    }
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
  const relayTerminalBuffers = new Map(); // sessionId -> { id, generation, seq, data }
  function broadcast(event, payload) {
    if (event === 'terminal-output' && payload && typeof payload === 'object' && payload.id) {
      const sid = String(payload.id);
      const chunk = String(payload.data ?? '');
      const prev = relayTerminalBuffers.get(sid);
      let nextData = chunk;
      if (prev && prev.generation === payload.generation && !chunk.includes('\x1b[2J')) {
        nextData = (prev.data + chunk).slice(-262144);
      }
      relayTerminalBuffers.set(sid, {
        id: sid,
        generation: Number(payload.generation || 1),
        seq: Number(payload.seq || 1),
        data: nextData,
      });
    }
    if (typeof options.onBroadcast === 'function') {
      try {
        options.onBroadcast(event, payload);
      } catch {}
    }
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
  const cronTimers = new Map();
  let cronJobSeq = 1;
  let sessionSeq = 1;

  function resolveMirroredSessionState(session, rollout = null, thread = null, desktopMetaState = null) {
    if (!session) return 'idle';
    if (!session.active) return 'stopped';
    const hasPendingApprovalOrQuestion = [...pendingQuestions.values()].some(
      q => q.sessionId === session.id && !q.responded,
    );
    if (hasPendingApprovalOrQuestion || desktopMetaState === 'waiting') {
      return 'waiting';
    }
    if (rollout && typeof rollout.latestTurnStatus === 'string') {
      return rollout.latestTurnStatus === 'inProgress' ? 'running' : 'idle';
    }
    const turns = Array.isArray(rollout?.turns) && rollout.turns.length > 0
      ? rollout.turns
      : Array.isArray(thread?.turns) && thread.turns.length > 0
        ? thread.turns
        : [];
    const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    if (latestTurn) {
      return latestTurn.status === 'inProgress' ? 'running' : 'idle';
    }
    if (desktopMetaState === 'running' && rollout?.rolloutMtimeMs && Date.now() - rollout.rolloutMtimeMs <= 30 * 1000) {
      return 'running';
    }
    return 'idle';
  }

  function updateSessionStateIfChanged(session, nextState) {
    if (!session || !nextState || session.state === nextState) return false;
    session.state = nextState;
    broadcast('session-changed', publicSessionInfo(session));
    return true;
  }

  const explicitlyStoppedMirroredIds = new Set();

  function materializeDesktopSessions() {
    const synced = syncFromDesktopDatabase();
    if (!synced) return;
    const { layoutSessions, metaById } = synced;
    for (const ls of layoutSessions) {
      const id = String(ls.sessionId || ls.id || crypto.randomUUID());
      const meta = metaById.get(id) || {};
      const existing = sessions.get(id);
      const threadId = ls.threadId || ls.resumeSessionId || meta.threadId || meta.resumeSessionId || null;
      const cwd = normalizeWindowsExtendedPath(String(ls.cwd || meta.cwd || os.homedir()));
      const title = String(ls.title || ls.name || meta.title || meta.name || '세션');
      const rollout = threadId ? readCodexRolloutSummary(String(threadId), codexHomeDir) : null;
      const desktopMetaState = typeof meta.state === 'string' ? meta.state : null;
      if (existing) {
        if (!existing.active && explicitlyStoppedMirroredIds.has(id)) {
          continue;
        }
        existing.title = title;
        existing.cwd = cwd;
        existing.projectId = ls.projectId ?? meta.projectId ?? existing.projectId ?? null;
        existing.projectAssigned = Boolean(ls.projectAssigned ?? meta.projectAssigned ?? existing.projectAssigned);
        existing.desktopMetaState = desktopMetaState;
        if (existing.threadId && rollout && state.threads[existing.threadId]) {
          state.threads[existing.threadId].turns = rollout.turns;
          state.threads[existing.threadId].updatedAt = rollout.updatedAt;
          if (rollout.usedTokens > 0) state.threads[existing.threadId].usedTokens = rollout.usedTokens;
        }
        const derivedState = resolveMirroredSessionState(
          existing,
          rollout,
          existing.threadId ? state.threads[existing.threadId] : null,
          desktopMetaState,
        );
        updateSessionStateIfChanged(existing, derivedState);
        continue;
      }
      if (explicitlyStoppedMirroredIds.has(id)) {
        continue;
      }
      const session = {
        id,
        generation: Number(meta.generation || 1),
        title,
        cwd,
        threadId: threadId ? String(threadId) : null,
        projectId: ls.projectId ?? meta.projectId ?? null,
        projectAssigned: Boolean(ls.projectAssigned ?? meta.projectAssigned ?? (ls.projectId !== undefined)),
        state: 'idle',
        active: meta.active !== false,
        cols: 100,
        rows: 30,
        seq: 0,
        events: [],
        eventSeq: 0,
        deliveredEventSeq: 0,
        contextRevision: 0,
        seededRolloutTerminal: false,
        isDesktopMirrored: true,
        desktopMetaState,
        rolloutTerminalLines: [],
        lastRolloutUpdatedAt: 0,
      };
      if (session.threadId && rollout) {
        session.rolloutTerminalLines = rollout.terminalLines || [];
        session.lastRolloutUpdatedAt = rollout.updatedAt || 0;
        session.lastRolloutSize = rollout.rolloutSize || 0;
        session.lastRolloutDigest = JSON.stringify(session.rolloutTerminalLines);
        state.threads[session.threadId] = {
          id: session.threadId,
          title: rollout.title || session.title,
          cwd: rollout.cwd || session.cwd,
          createdAt: rollout.createdAt,
          updatedAt: rollout.updatedAt,
          model: rollout.model,
          effort: rollout.effort,
          modelContextWindow: rollout.modelContextWindow || 380000,
          effectiveContextWindow: rollout.modelContextWindow || 380000,
          usedTokens: rollout.usedTokens || 0,
          turns: rollout.turns,
          memorySummary: null,
          readState: { firstUnread: null, revision: 'rev-1' },
        };
      }
      session.state = resolveMirroredSessionState(
        session,
        rollout,
        session.threadId ? state.threads[session.threadId] : null,
        desktopMetaState,
      );
      sessions.set(id, session);
    }
  }

  materializeDesktopSessions();

  function emitMirroredSessionSnapshot(session, force = false) {
    if (!session || !session.threadId) return false;
    const rollout = readCodexRolloutSummary(session.threadId, codexHomeDir);
    if (rollout) {
      session.lastRolloutUpdatedAt = rollout.updatedAt || session.lastRolloutUpdatedAt || 0;
      session.lastRolloutSize = rollout.rolloutSize || session.lastRolloutSize || 0;
      if (state.threads[session.threadId] && rollout.turns?.length) {
        state.threads[session.threadId].turns = rollout.turns;
        state.threads[session.threadId].updatedAt = rollout.updatedAt;
      }
      if (session.isDesktopMirrored) {
        updateSessionStateIfChanged(
          session,
          resolveMirroredSessionState(session, rollout, state.threads[session.threadId], session.desktopMetaState),
        );
      }
    }
    const lines = rollout?.terminalLines?.length ? rollout.terminalLines : session.rolloutTerminalLines;
    if (!lines || lines.length === 0) return false;
    const digest = JSON.stringify(lines);
    if (!force && session.seededRolloutTerminal && session.lastRolloutDigest === digest) {
      return false;
    }
    session.seededRolloutTerminal = true;
    session.rolloutTerminalLines = lines;
    session.lastRolloutDigest = digest;
    emitTerminalOutput(
      session,
      `\x1b[2J\x1b[H\x1b[38;5;141m╭─ ${session.title} · ${session.cwd}\x1b[0m\r\n` +
        lines.join('\r\n') +
        '\r\n',
    );
    return true;
  }

  let mirroredSnapshotTimer = null;
  function scheduleMirroredSessionSnapshots(force = false) {
    if (mirroredSnapshotTimer) clearTimeout(mirroredSnapshotTimer);
    mirroredSnapshotTimer = setTimeout(() => {
      mirroredSnapshotTimer = null;
      for (const session of sessions.values()) {
        if (!session.isDesktopMirrored || !session.threadId) continue;
        emitMirroredSessionSnapshot(session, force);
      }
    }, 60);
    mirroredSnapshotTimer.unref?.();
  }

  const desktopWatchInterval =
    desktopDbPath && mode !== 'relay'
      ? setInterval(() => {
          try {
            materializeDesktopSessions();
            for (const session of sessions.values()) {
              if (!session.isDesktopMirrored || !session.threadId) continue;
              emitMirroredSessionSnapshot(session, false);
            }
          } catch {}
        }, 1500)
      : null;
  desktopWatchInterval?.unref?.();

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
        if (notification.method === 'turn/started') {
          updateSessionStateIfChanged(session, 'running');
        } else if (notification.method === 'turn/completed' || notification.method === 'error') {
          updateSessionStateIfChanged(session, 'idle');
        }
        if (notification.method === 'item/agentMessage/delta' && notification.params?.delta) {
          session._streamedItemIds = session._streamedItemIds || new Set();
          if (notification.params?.itemId) session._streamedItemIds.add(String(notification.params.itemId));
          emitTerminalOutput(session, String(notification.params.delta));
        } else if (notification.method === 'item/completed' && notification.params?.item && !sessionProcesses.has(session.id)) {
          const item = normalizeConversationItem(notification.params.item, 0, String(notification.params.turnId || 'turn'));
          const alreadyStreamed = session._streamedItemIds?.has(item.id);
          if (item.type === 'agentMessage' && item.text && !alreadyStreamed) {
            const lines = String(item.text).trim().split(/\r?\n/).map(al => `\x1b[38;5;252m• ${al}\x1b[0m`);
            emitTerminalOutput(session, lines.join('\r\n') + '\r\n\x1b[38;5;141m›\x1b[0m ');
          } else if (item.type === 'commandExecution' && item.command) {
            emitTerminalOutput(session, `\x1b[38;5;114m• Ran\x1b[0m ${String(item.command).slice(0, 140)}\r\n`);
          }
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
    const isLineBuffered = Boolean(session.threadId && !sessionProcesses.has(session.id));
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
      lineBufferedInput: isLineBuffered,
    };
  }

  const threadReadInFlight = new Map(); // `${threadId}:${includeTurns}` -> Promise
  const threadReadFullCacheAt = new Map(); // threadId -> unixMs

  async function syncThreadFromServer(session, includeTurns = true) {
    let threadId = session.threadId;
    const rollout = threadId ? readCodexRolloutSummary(threadId, codexHomeDir) : null;
    const hasRolloutTurns = Boolean(rollout && Array.isArray(rollout.turns) && rollout.turns.length > 0);
    const cachedFullAt = threadId ? (threadReadFullCacheAt.get(threadId) || 0) : 0;
    const existingTurns = threadId && Array.isArray(state.threads[threadId]?.turns) ? state.threads[threadId].turns : [];
    const canSkipHeavyRead =
      includeTurns &&
      (hasRolloutTurns || (existingTurns.length > 0 && Date.now() - cachedFullAt < 5000));

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
          } else if (!canSkipHeavyRead) {
            const rpcIncludeTurns = includeTurns && !hasRolloutTurns;
            const flightKey = `${threadId}:${rpcIncludeTurns ? '1' : '0'}`;
            let readPromise = threadReadInFlight.get(flightKey);
            if (!readPromise) {
              readPromise = appServerBridge
                .request('thread/read', { threadId, includeTurns: rpcIncludeTurns })
                .finally(() => {
                  threadReadInFlight.delete(flightKey);
                });
              threadReadInFlight.set(flightKey, readPromise);
            }
            try {
              const readRes = await readPromise;
              if (readRes?.thread) {
                const nextThread = {
                  ...(state.threads[threadId] || {}),
                  ...readRes.thread,
                  id: threadId,
                  cwd: readRes.thread.cwd || session.cwd,
                };
                if (!rpcIncludeTurns && Array.isArray(state.threads[threadId]?.turns) && state.threads[threadId].turns.length > 0) {
                  nextThread.turns = state.threads[threadId].turns;
                }
                state.threads[threadId] = nextThread;
                if (rpcIncludeTurns) {
                  threadReadFullCacheAt.set(threadId, Date.now());
                }
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
    const currentThread = state.threads[threadId];
    const activeRollout = rollout || readCodexRolloutSummary(threadId, codexHomeDir);
    if (activeRollout) {
      if (!currentThread.model && activeRollout.model) currentThread.model = activeRollout.model;
      if (!currentThread.effort && activeRollout.effort) currentThread.effort = activeRollout.effort;
      if (activeRollout.usedTokens > 0) currentThread.usedTokens = activeRollout.usedTokens;
      if (activeRollout.modelContextWindow > 0) {
        currentThread.modelContextWindow = activeRollout.modelContextWindow;
        currentThread.effectiveContextWindow = activeRollout.modelContextWindow;
      }
      if (activeRollout.turns.length > 0) {
        const localExtraTurns = Array.isArray(currentThread.turns)
          ? currentThread.turns.filter(lt => !activeRollout.turns.some(rt => rt.id === lt.id))
          : [];
        currentThread.turns = [...activeRollout.turns, ...localExtraTurns].slice(-50);
      }
      if (!session.seededRolloutTerminal && activeRollout.terminalLines.length > 0) {
        session.seededRolloutTerminal = true;
        emitTerminalOutput(
          session,
          `\x1b[38;5;141m╭─ ${session.title} · ${session.cwd}\x1b[0m\r\n` +
            activeRollout.terminalLines.join('\r\n') +
            '\r\n',
        );
      }
    }
    if (session.isDesktopMirrored) {
      updateSessionStateIfChanged(
        session,
        resolveMirroredSessionState(session, activeRollout, currentThread, session.desktopMetaState),
      );
    }
    return currentThread;
  }

  let cachedModelsResult = null;
  let cachedModelsAt = 0;
  async function queryServerModels(cursor = null) {
    if (!cursor && cachedModelsResult && Date.now() - cachedModelsAt < 30000) {
      return cachedModelsResult;
    }
    try {
      await appServerBridge.ensureStarted();
      if (appServerBridge.isConnected()) {
        const rpcRes = await appServerBridge.request('model/list', { cursor });
        if (Array.isArray(rpcRes?.data)) {
          const res = { data: rpcRes.data, models: rpcRes.data, nextCursor: rpcRes.nextCursor ?? null };
          if (!cursor) {
            cachedModelsResult = res;
            cachedModelsAt = Date.now();
          }
          return res;
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
      const PAGE_SIZE = 30;
      const rawTurns = Array.isArray(thread.turns) ? [...thread.turns].reverse() : [];
      const offset = Math.max(0, Number(request.cursor || 0) || 0);
      const slicedTurns = rawTurns.slice(offset, offset + PAGE_SIZE);
      const data = slicedTurns.map((t, idx) => ({
        id: String(t.id || `turn-${offset + idx + 1}`),
        status: String(t.status || 'completed'),
        createdAt: t.createdAt ?? Math.floor(Date.now() / 1000),
      }));
      const nextCursor = offset + PAGE_SIZE < rawTurns.length ? String(offset + PAGE_SIZE) : null;
      return {
        data,
        turns: data,
        nextCursor,
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
      const effectiveConnected = Boolean(
        appServerBridge.isConnected() ||
          session.isDesktopMirrored ||
          session.threadId ||
          (Array.isArray(thread.turns) && thread.turns.length > 0),
      );
      return {
        connected: effectiveConnected,
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
      const effectiveConnected = Boolean(
        appServerBridge.isConnected() ||
          session.isDesktopMirrored ||
          session.threadId ||
          turnsList.length > 0,
      );
      return {
        attached: true,
        connected: effectiveConnected,
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
      const ITEMS_PAGE_SIZE = 50;
      const turn = (thread.turns || []).find(t => t.id === request.turnId);
      const rawItems = turn && Array.isArray(turn.items) ? turn.items : [];
      const dedupedItems = [];
      const idxById = new Map();
      for (let idx = 0; idx < rawItems.length; idx += 1) {
        const norm = normalizeConversationItem(rawItems[idx], idx, String(request.turnId));
        if (idxById.has(norm.id)) {
          const prevIdx = idxById.get(norm.id);
          const prev = dedupedItems[prevIdx];
          dedupedItems[prevIdx] = {
            ...prev,
            ...norm,
            text: norm.text || prev.text || '',
            aggregatedOutput: norm.aggregatedOutput || prev.aggregatedOutput || '',
          };
        } else {
          idxById.set(norm.id, dedupedItems.length);
          dedupedItems.push(norm);
        }
      }
      const normalizedAll = dedupedItems;
      if (turn) {
        turn._normalizedItems = normalizedAll;
      }
      const reversedAll = [...normalizedAll].reverse();
      const offset = Math.max(0, Number(request.cursor || 0) || 0);
      const pageItems = reversedAll.slice(offset, offset + ITEMS_PAGE_SIZE);
      const data = pageItems.map(item => ({
        turnId: String(request.turnId),
        item: serializeItemForPage(item),
      }));
      const nextCursor = offset + ITEMS_PAGE_SIZE < reversedAll.length ? String(offset + ITEMS_PAGE_SIZE) : null;
      return {
        turnId: request.turnId,
        data,
        items: data.map(d => d.item),
        nextCursor,
      };
    }

    if (type === 'detail') {
      const turn = (thread.turns || []).find(t => t.id === request.turnId);
      const itemsPool = Array.isArray(turn?._normalizedItems)
        ? turn._normalizedItems
        : Array.isArray(turn?.items)
          ? turn.items.map((rawItem, idx) => normalizeConversationItem(rawItem, idx, String(request.turnId)))
          : [];
      const item = itemsPool.find(i => i.id === request.itemId);
      const fullText = itemFullDetailText(item);
      const offset = Math.max(0, Number(request.offset || 0) || 0);
      const sliceEnd = offset + ITEM_PREVIEW_LIMIT;
      return {
        turnId: request.turnId,
        itemId: request.itemId,
        text: fullText.slice(offset, sliceEnd),
        totalBytes: fullText.length,
        nextOffset: sliceEnd < fullText.length ? sliceEnd : null,
      };
    }

    if (type === 'detach' || type === 'handoffToTerminal') {
      return { attached: false };
    }

    if (type === 'slashCommands') {
      return buildSlashCommandsList(session.cwd);
    }

    if (type === 'send') {
      let text = String(request.text ?? request.prompt ?? '').trim();
      if (!text) throw new Error('전송할 메시지를 입력하세요.');
      if (text.startsWith('/')) {
        const slashRes = await executeServerSlashCommand(session, text, { emitToTerminal: !sessionProcesses.has(session.id) });
        if (slashRes.handled) {
          const turnId = `slash-${crypto.randomUUID()}`;
          const turnItems = [
            normalizeConversationItem({ id: `u-${turnId}`, type: 'userMessage', role: 'user', text, status: 'completed' }, 0, turnId),
            ...(slashRes.outputText
              ? [normalizeConversationItem({ id: `a-${turnId}`, type: 'agentMessage', role: 'assistant', text: slashRes.outputText, status: 'completed' }, 1, turnId)]
              : []),
          ];
          const turn = {
            id: turnId,
            status: 'completed',
            createdAt: Math.floor(Date.now() / 1000),
            items: turnItems,
          };
          thread.turns = thread.turns || [];
          thread.turns.push(turn);
          thread.updatedAt = Math.floor(Date.now() / 1000);
          return {
            turnId,
            turn: { id: turnId, status: 'completed' },
            status: 'completed',
            turns: thread.turns.slice(-20),
            items: turn.items,
            slashHandled: true,
          };
        }
        if (slashRes.rewrittenPrompt) {
          text = slashRes.rewrittenPrompt;
        }
      }
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
      updateSessionStateIfChanged(session, turn.status === 'inProgress' ? 'running' : 'idle');
      persistState();
      if (!sessionProcesses.has(session.id)) {
        const outLines = [];
        for (const item of normalizedItems) {
          if (item.type === 'agentMessage' && item.text) {
            for (const al of String(item.text).trim().split(/\r?\n/)) {
              outLines.push(`\x1b[38;5;252m• ${al}\x1b[0m`);
            }
          } else if (item.type === 'commandExecution' && item.command) {
            outLines.push(`\x1b[38;5;114m• Ran\x1b[0m ${String(item.command).slice(0, 140)}`);
          }
        }
        if (outLines.length > 0) {
          emitTerminalOutput(session, outLines.join('\r\n') + '\r\n\x1b[38;5;141m›\x1b[0m ');
        }
      }
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
      if (Array.isArray(thread.turns)) {
        for (const t of thread.turns) {
          if (t.status === 'inProgress' && (!request.turnId || t.id === request.turnId)) {
            t.status = 'interrupted';
          }
        }
      }
      updateSessionStateIfChanged(session, 'idle');
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
      const rpcConnected = appServerBridge.isConnected();
      if (rpcConnected) {
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
      const rollout = threadId ? readCodexRolloutSummary(threadId, codexHomeDir) : null;
      if (rollout) {
        if (rollout.usedTokens > 0) thread.usedTokens = rollout.usedTokens;
        if (rollout.modelContextWindow > 0) thread.modelContextWindow = rollout.modelContextWindow;
        if (Array.isArray(rollout.turns) && rollout.turns.length > 0) {
          thread.turns = rollout.turns;
        }
      }
      if (session.isDesktopMirrored) {
        updateSessionStateIfChanged(
          session,
          resolveMirroredSessionState(session, rollout, thread, session.desktopMetaState),
        );
      }
      const hasRolloutOrMirrored = Boolean(rollout || session.isDesktopMirrored || thread.usedTokens > 0);
      const effectiveConnected = Boolean(rpcConnected || hasRolloutOrMirrored);
      const caps = appServerBridge.serverInfo?.opendiyCapabilities || {};
      const usedTokens = Number(thread.usedTokens || 0);
      const modelContextWindow = Number(thread.modelContextWindow || 380000);
      const compactSupported = Boolean(caps.compactStartIfIdle ?? effectiveConnected);
      const isIdle = session.state === 'idle';
      session.contextRevision = (session.contextRevision || 0) + 1;
      return {
        connected: effectiveConnected,
        guiConnected: effectiveConnected,
        supported: effectiveConnected,
        usedTokens,
        modelContextWindow,
        tokenUsage: {
          last: { totalTokens: usedTokens },
          modelContextWindow,
        },
        tokenUsageFresh: effectiveConnected,
        compacting: false,
        active: !isIdle,
        canCompact: effectiveConnected && compactSupported && isIdle,
        canCompactIfIdle: effectiveConnected && compactSupported,
        idle: isIdle,
        passiveSubscriptionSupported: Boolean(caps.passiveSubscription ?? effectiveConnected),
        subagentsSupported: Boolean(appServerBridge.serverInfo?.supportsSubagentManagement ?? effectiveConnected),
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

  function buildSlashCommandsList(cwd) {
    const builtins = [
      {
        command: '/compact',
        titleKo: '컨텍스트 압축',
        titleEn: 'Compact context',
        descriptionKo: '현재 대화 컨텍스트를 요약·압축하여 토큰 여유 공간을 확보합니다.',
        descriptionEn: 'Summarize and compact the current conversation context.',
        category: 'builtin',
        action: 'compact',
      },
      {
        command: '/status',
        titleKo: '세션·모델·컨텍스트 상태',
        titleEn: 'Session, model & context status',
        descriptionKo: '현재 세션의 모델, 추론 수준, 토큰 사용량, 작업 경로 및 연결 상태를 표시합니다.',
        descriptionEn: 'Show current model, reasoning effort, token usage, working directory, and connection status.',
        category: 'builtin',
        action: 'status',
      },
      {
        command: '/model',
        titleKo: '모델 및 추론 수준 확인·변경',
        titleEn: 'Show or switch model & reasoning effort',
        descriptionKo: '현재 모델/추론 수준을 확인하거나 변경합니다 (예: /model gpt-5.4 high).',
        descriptionEn: 'View or switch model and reasoning effort (e.g., /model gpt-5.4 high).',
        category: 'builtin',
        action: 'model',
      },
      {
        command: '/diff',
        titleKo: 'Git 변경 요약 확인',
        titleEn: 'Show Git status & diff summary',
        descriptionKo: '현재 작업 폴더의 git status 및 git diff --stat 요약을 출력합니다.',
        descriptionEn: 'Display git status and git diff --stat for the session working folder.',
        category: 'builtin',
        action: 'diff',
      },
      {
        command: '/review',
        titleKo: '현재 변경사항 코드 리뷰',
        titleEn: 'Review current changes',
        descriptionKo: '작업 폴더의 변경 사항에 대해 코드 리뷰를 요청합니다.',
        descriptionEn: 'Start a code review turn for the current working directory changes.',
        category: 'builtin',
        action: 'review',
      },
      {
        command: '/clear',
        titleKo: '터미널 화면 지우기',
        titleEn: 'Clear terminal display',
        descriptionKo: '현재 터미널 출력 화면을 깨끗하게 지웁니다.',
        descriptionEn: 'Clear the current terminal screen.',
        category: 'builtin',
        action: 'clear',
      },
      {
        command: '/conversation',
        titleKo: '대화 / 터미널 화면 전환',
        titleEn: 'Toggle conversation / terminal view',
        descriptionKo: '구조화 대화 화면과 터미널 화면을 전환합니다.',
        descriptionEn: 'Switch between structured conversation view and terminal view.',
        category: 'ui',
        action: 'conversation',
      },
      {
        command: '/subagents',
        titleKo: '서브에이전트 관리',
        titleEn: 'Manage subagents',
        descriptionKo: '이 세션의 서브에이전트 관리 창을 엽니다.',
        descriptionEn: 'Open the subagent management dialog for this session.',
        category: 'ui',
        action: 'subagents',
      },
      {
        command: '/cron',
        titleKo: '예약 작업 (Cron) 관리',
        titleEn: 'Manage scheduled jobs (Cron)',
        descriptionKo: '이 세션의 반복·예약 작업(Cron) 설정 창을 엽니다.',
        descriptionEn: 'Open the scheduled jobs (Cron) dialog for this session.',
        category: 'ui',
        action: 'cron',
      },
      {
        command: '/update',
        titleKo: '최신 버전 확인 및 자동 업데이트',
        titleEn: 'Check & apply updates',
        descriptionKo: 'GitHub Releases에서 최신 버전을 확인하고 즉시 업데이트합니다.',
        descriptionEn: 'Check GitHub Releases for a newer version and apply the update.',
        category: 'builtin',
        action: 'update',
      },
      {
        command: '/help',
        titleKo: '슬래시 명령어 및 스킬 목록',
        titleEn: 'List slash commands & skills',
        descriptionKo: '사용 가능한 모든 슬래시(/) 명령어와 설치된 스킬 목록을 출력합니다.',
        descriptionEn: 'Display all available slash commands and installed skills.',
        category: 'builtin',
        action: 'help',
      },
    ];
    const builtinsWithDesc = builtins.map(b => ({
      description: b.descriptionKo,
      title: b.titleKo,
      ...b,
    }));
    const ext = scanCodexExtensions(cwd || null, computeSettings().resolvedPath);
    const seen = new Set(builtins.map(b => b.command));
    const skills = [];
    for (const sk of ext.skills || []) {
      if (!sk || !sk.name) continue;
      const cmd = `/${String(sk.name).trim().replace(/^\/+/, '')}`;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      skills.push({
        command: cmd,
        title: `${sk.name} (${sk.scope === 'project' ? '프로젝트 스킬' : '사용자 스킬'})`,
        titleKo: `${sk.name} (${sk.scope === 'project' ? '프로젝트 스킬' : '사용자 스킬'})`,
        titleEn: `${sk.name} (${sk.scope === 'project' ? 'Project skill' : 'User skill'})`,
        description: sk.description || `${sk.name} 스킬을 호출합니다.`,
        descriptionKo: sk.description || `${sk.name} 스킬을 호출합니다.`,
        descriptionEn: sk.description || `Invoke the ${sk.name} skill.`,
        category: 'skill',
        action: 'skill',
        skillName: sk.name,
      });
    }
    return { commands: [...builtinsWithDesc, ...skills] };
  }

  async function executeServerSlashCommand(session, rawText, { emitToTerminal = true } = {}) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed.startsWith('/')) return { handled: false };
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
    const thread = (session.threadId && state.threads[session.threadId]) || {
      id: session.threadId || 'local',
      title: session.title,
      cwd: session.cwd,
      model: null,
      effort: null,
      modelContextWindow: 128000,
      effectiveContextWindow: 128000,
      usedTokens: 0,
      turns: [],
    };

    const writeTerm = text => {
      if (!emitToTerminal) return;
      const formatted = text
        .split(/\r?\n/)
        .map(line => `\x1b[38;5;252m${line}\x1b[0m`)
        .join('\r\n');
      emitTerminalOutput(session, `${formatted}\r\n\x1b[38;5;141m›\x1b[0m `);
    };

    if (cmd === '/' || cmd === '/help') {
      const { commands } = buildSlashCommandsList(session.cwd);
      const builtins = commands.filter(c => c.category !== 'skill');
      const skills = commands.filter(c => c.category === 'skill');
      const lines = [
        '• 사용 가능한 슬래시(/) 명령어:',
        ...builtins.map(c => `  ${c.command.padEnd(16, ' ')} ${c.titleKo} — ${c.descriptionKo}`),
      ];
      if (skills.length > 0) {
        lines.push('');
        lines.push(`• 설치된 스킬 (${skills.length}개):`);
        for (const s of skills.slice(0, 25)) {
          lines.push(`  ${s.command.padEnd(28, ' ')} ${String(s.descriptionKo).slice(0, 72)}`);
        }
      }
      const outputText = lines.join('\n');
      writeTerm(outputText);
      return { handled: true, outputText };
    }

    if (cmd === '/clear') {
      if (emitToTerminal) {
        emitTerminalOutput(session, '\x1b[2J\x1b[H\x1b[38;5;141m›\x1b[0m ');
      }
      return { handled: true, outputText: '' };
    }

    if (cmd === '/status') {
      const used = Number(thread.usedTokens || 0);
      const win = Number(thread.modelContextWindow || 128000);
      const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0;
      const lines = [
        `• 세션 상태: ${session.title} (${session.state})`,
        `  작업 폴더 : ${session.cwd || '(미지정)'}`,
        `  Thread ID : ${session.threadId || '(없음)'}`,
        `  모델/추론 : ${thread.model || '기본값'} · ${thread.effort || '기본값'}`,
        `  컨텍스트  : ${pct}% (${used.toLocaleString('ko-KR')} / ${win.toLocaleString('ko-KR')} 토큰)`,
      ];
      const outputText = lines.join('\n');
      writeTerm(outputText);
      return { handled: true, outputText };
    }

    if (cmd === '/model') {
      if (rest) {
        const parts = rest.split(/\s+/).filter(Boolean);
        thread.model = parts[0];
        if (parts[1]) thread.effort = parts[1];
        persistState();
        const msg = `• 다음 턴부터 모델 설정이 변경되었습니다: 모델=${thread.model}, 추론=${thread.effort || '기본값'}`;
        writeTerm(msg);
        return { handled: true, outputText: msg };
      }
      const msg = `• 현재 설정된 모델: ${thread.model || '기본값'} · 추론 수준: ${thread.effort || '기본값'} (변경 예: /model gpt-5.4 high)`;
      writeTerm(msg);
      return { handled: true, outputText: msg };
    }

    if (cmd === '/compact') {
      try {
        await appServerBridge.ensureStarted().catch(() => {});
        if (appServerBridge.isConnected() && session.threadId) {
          await appServerBridge.request('thread/compact/startIfIdle', { threadId: session.threadId });
        }
        const msg = '• 컨텍스트 압축(/compact)을 요청했습니다.';
        writeTerm(msg);
        return { handled: true, outputText: msg };
      } catch (err) {
        const msg = `• 컨텍스트 압축 요청 실패: ${err.message || err}`;
        writeTerm(msg);
        return { handled: true, outputText: msg };
      }
    }

    if (cmd === '/diff') {
      try {
        const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd();
        const statusOut = execFileSync('git', ['status', '-s'], { cwd, encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
        const diffOut = execFileSync('git', ['diff', '--stat'], { cwd, encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
        const lines = [
          `• Git 작업 트리 상태 (${cwd}):`,
          statusOut ? statusOut : '  (변경된 파일 없음)',
          ...(diffOut ? ['', '• Git Diff 요약:', diffOut] : []),
        ];
        const outputText = lines.join('\n');
        writeTerm(outputText);
        return { handled: true, outputText };
      } catch (err) {
        const msg = `• Git 상태를 조회할 수 없습니다: ${err.message || err}`;
        writeTerm(msg);
        return { handled: true, outputText: msg };
      }
    }

    if (cmd === '/review') {
      const rewrittenPrompt = rest
        ? `현재 작업 폴더의 변경 사항에 대해 다음 관점으로 코드 리뷰를 수행해 주세요: ${rest}`
        : '현재 작업 폴더의 변경 사항(git diff)을 확인하고 결함, 회귀 위험, 개선점을 코드 리뷰해 주세요.';
      return { handled: false, rewrittenPrompt };
    }

    if (cmd === '/update') {
      try {
        const info = await fetchLatestReleaseInfo({
          rootDir: updateRootDir,
          releaseApiUrl: releaseApiUrl || undefined,
          fetchFn: updateFetchFn,
        });
        if (!info.updateAvailable && rest.toLowerCase() !== 'apply' && rest.toLowerCase() !== 'force') {
          const msg = `• 현재 최신 버전(v${info.currentVersion})을 실행 중입니다.`;
          writeTerm(msg);
          return { handled: true, outputText: msg };
        }
        if (rest.toLowerCase() === 'apply' || rest.toLowerCase() === 'now' || info.updateAvailable) {
          const res = await dispatchCommand('apply_update', { target: 'both' });
          const msg = res.updated
            ? `• v${res.version} 자동 업데이트가 적용되었습니다. 잠시 후 서비스가 재시작됩니다.`
            : `• 현재 최신 버전(v${res.version || info.currentVersion})입니다.`;
          writeTerm(msg);
          return { handled: true, outputText: msg };
        }
      } catch (err) {
        const msg = `• 업데이트 확인/적용 실패: ${err.message || err}`;
        writeTerm(msg);
        return { handled: true, outputText: msg };
      }
    }

    const { commands } = buildSlashCommandsList(session.cwd);
    const matchedSkill = commands.find(c => c.category === 'skill' && c.command.toLowerCase() === cmd);
    if (matchedSkill) {
      const rewrittenPrompt = rest
        ? `$${matchedSkill.skillName} ${rest}`
        : `$${matchedSkill.skillName} 스킬을 적용하여 현재 작업을 진행해 주세요.`;
      return { handled: false, rewrittenPrompt };
    }

    return { handled: false };
  }

  function clearCronTimer(jobId) {
    const entry = cronTimers.get(String(jobId));
    if (entry) {
      if (entry.kind === 'every') clearInterval(entry.handle);
      else clearTimeout(entry.handle);
      cronTimers.delete(String(jobId));
    }
  }

  function scheduleCronJob(session, job, fullPrompt) {
    clearCronTimer(job.id);
    const promptText = String(fullPrompt || job.promptPreview || '').trim();
    const runOnce = async () => {
      if (job.removed || !sessions.has(session.id)) {
        clearCronTimer(job.id);
        return;
      }
      if (job.paused) {
        if (job.schedule?.type === 'every') {
          job.nextRunAt = Date.now() + Math.max(1, Number(job.schedule.seconds || 60)) * 1000;
        }
        return;
      }
      if (job.state === 'running') {
        job.skipped = Number(job.skipped || 0) + 1;
        return;
      }
      job.state = 'running';
      try {
        if (promptText) {
          await handleConversationRequest(session, { type: 'send', text: promptText });
        }
      } catch {
        // Keep schedule alive even if an individual turn fails.
      } finally {
        if (job.schedule?.type === 'every') {
          job.state = 'ready';
          job.nextRunAt = Date.now() + Math.max(1, Number(job.schedule.seconds || 60)) * 1000;
        } else {
          job.state = 'finished';
          job.nextRunAt = null;
          clearCronTimer(job.id);
        }
      }
    };

    if (job.schedule?.type === 'every') {
      const intervalMs = Math.max(1000, Number(job.schedule.seconds || 60) * 1000);
      const handle = setInterval(() => {
        void runOnce();
      }, intervalMs);
      handle.unref?.();
      cronTimers.set(String(job.id), { kind: 'every', handle });
    } else if (job.schedule?.type === 'at') {
      const delayMs = Math.max(50, Number(job.schedule.atUnixMs || Date.now() + 1000) - Date.now());
      const handle = setTimeout(() => {
        void runOnce();
      }, delayMs);
      handle.unref?.();
      cronTimers.set(String(job.id), { kind: 'at', handle });
    }
  }

  const updateRootDir = path.resolve(options.updateRootDir || ROOT_DIR);
  const releaseApiUrl = options.releaseApiUrl || process.env.OPENDIY_REMOTE_RELEASE_API_URL || '';
  const updateFetchFn = options.updateFetchFn || globalThis.fetch;

  async function dispatchCommand(command, args = {}) {
    if (mode === 'relay') {
      if (command === 'check_for_updates') {
        const relayInfo = await fetchLatestReleaseInfo({
          rootDir: updateRootDir,
          releaseApiUrl: releaseApiUrl || undefined,
          fetchFn: updateFetchFn,
        });
        let hostInfo = null;
        if (activeHostLease && activeHostLease.streamRes && !activeHostLease.streamRes.writableEnded) {
          try {
            hostInfo = await invokeRelayHost('check_for_updates', args, 10000);
          } catch {}
        }
        return {
          ...relayInfo,
          relayVersion: relayInfo.currentVersion,
          hostVersion: hostInfo?.currentVersion ?? null,
          hostUpdateAvailable: Boolean(hostInfo?.updateAvailable),
          updateAvailable: Boolean(relayInfo.updateAvailable || hostInfo?.updateAvailable),
        };
      }
      if (command === 'apply_update') {
        const target = String(args.target || 'both');
        let hostResult = null;
        if ((target === 'both' || target === 'host') && activeHostLease && activeHostLease.streamRes && !activeHostLease.streamRes.writableEnded) {
          try {
            hostResult = await invokeRelayHost('apply_update', { ...args, target: 'host' }, 45000);
          } catch (err) {
            if (target === 'host') throw err;
            hostResult = { updated: false, error: String(err.message || err) };
          }
        }
        let relayResult = null;
        if (target === 'both' || target === 'relay') {
          relayResult = await performSelfUpdate({
            rootDir: updateRootDir,
            releaseApiUrl: releaseApiUrl || undefined,
            fetchFn: updateFetchFn,
            scheduleRestart: options.scheduleRestartOnUpdate !== false,
            onRestart: options.onRestart,
          });
          staticAssetCache.clear();
          broadcast('update-status-changed', {
            target: 'relay',
            updated: relayResult.updated,
            version: relayResult.version,
            restartScheduled: relayResult.restartScheduled,
          });
        }
        return {
          ...(relayResult || hostResult || { updated: false }),
          relay: relayResult,
          host: hostResult,
        };
      }
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
        materializeDesktopSessions();
        scheduleMirroredSessionSnapshots();
        return state.layout;
      case 'save_layout':
        if (args.layout && typeof args.layout === 'object') {
          state.layout = args.layout;
          persistState();
        }
        return null;
      case 'list_projects':
        materializeDesktopSessions();
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
        const existingSession = req.threadId
          ? [...sessions.values()].find(s => s.threadId === String(req.threadId) && s.active)
          : null;
        let wasDesktopMirrored = false;
        if (req.threadId) {
          for (const [sid, s] of sessions) {
            if (s.threadId === String(req.threadId) && !s.active) {
              if (s.isDesktopMirrored) wasDesktopMirrored = true;
              explicitlyStoppedMirroredIds.delete(sid);
              sessions.delete(sid);
            }
          }
        }
        if (existingSession) {
          existingSession.title = title;
          existingSession.cwd = cwd;
          if (req.projectId !== undefined) existingSession.projectId = req.projectId;
          if (req.projectAssigned !== undefined) existingSession.projectAssigned = Boolean(req.projectAssigned);
          await syncThreadFromServer(existingSession, false);
          emitMirroredSessionSnapshot(existingSession, true);
          const existingInfo = publicSessionInfo(existingSession);
          broadcast('session-changed', existingInfo);
          return existingInfo;
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
          ...(wasDesktopMirrored ? { isDesktopMirrored: true } : {}),
        };
        await syncThreadFromServer(session, false);
        sessions.set(id, session);
        persistState();

        const info = publicSessionInfo(session);
        broadcast('session-changed', info);
        if (!wasDesktopMirrored) {
          emitTerminalOutput(
            session,
            `\x1b[38;5;141m╭─ [OpenDIY Remote] ${title} · ${cwd}\x1b[0m\r\n`,
          );
        }

        const settings = computeSettings();
        const shouldSpawnProcess = options.spawnProcess !== false && !wasDesktopMirrored;
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
                  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
                ]
              : [
                  '-c',
                  'exec /bin/sh -i',
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
        materializeDesktopSessions();
        scheduleMirroredSessionSnapshots();
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
          return null;
        }
        if (session.threadId || data.trimStart().startsWith('/')) {
          const isWideTerminalChar = ch => {
            if (!ch) return false;
            const cp = ch.codePointAt(0) || 0;
            return (
              (cp >= 0x1100 && cp <= 0x115f) ||
              (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
              (cp >= 0xac00 && cp <= 0xd7a3) ||
              (cp >= 0xf900 && cp <= 0xfaff) ||
              (cp >= 0xfe10 && cp <= 0xfe6f) ||
              (cp >= 0xff00 && cp <= 0xff60) ||
              (cp >= 0xffe0 && cp <= 0xffe6)
            );
          };
          session.inputBuffer = String(session.inputBuffer || '');
          let out = '';
          const submittedPrompts = [];
          for (const ch of data) {
            if (ch === '\u0003') {
              session.inputBuffer = '';
              out += '^C\r\n\x1b[38;5;141m›\x1b[0m ';
              if (session.threadId && appServerBridge.isConnected()) {
                void appServerBridge.request('turn/interrupt', { threadId: session.threadId }).catch(() => {});
              }
            } else if (ch === '\u007f' || ch === '\b') {
              const chars = Array.from(session.inputBuffer);
              if (chars.length > 0) {
                const popped = chars.pop();
                session.inputBuffer = chars.join('');
                out += isWideTerminalChar(popped) ? '\b \b\b \b' : '\b \b';
              }
            } else if (ch === '\r' || ch === '\n') {
              const promptText = session.inputBuffer.trim();
              session.inputBuffer = '';
              out += '\r\n';
              if (promptText) {
                submittedPrompts.push(promptText);
              } else {
                out += '\x1b[38;5;141m›\x1b[0m ';
              }
            } else if (ch >= ' ') {
              session.inputBuffer += ch;
              out += ch;
            }
          }
          if (out) emitTerminalOutput(session, out);
          for (const promptText of submittedPrompts) {
            if (!data.startsWith(promptText)) {
              emitTerminalOutput(session, `\x1b[90m›\x1b[0m \x1b[1m${promptText}\x1b[0m\r\n`);
            }
            try {
              await handleConversationRequest(session, { type: 'send', text: promptText });
              if (session.threadId) {
                emitMirroredSessionSnapshot(session, false);
              }
            } catch (err) {
              emitTerminalOutput(
                session,
                `\x1b[38;5;203m• 전송 실패: ${err.message || err}\x1b[0m\r\n\x1b[38;5;141m›\x1b[0m `,
              );
            }
          }
          return null;
        }
        emitTerminalOutput(session, data);
        return null;
      }
      case 'session_resize': {
        const session = sessions.get(args.id);
        if (session && session.generation === Number(args.generation)) {
          session.cols = Number(args.cols) || session.cols;
          session.rows = Number(args.rows) || session.rows;
          if (!sessionProcesses.has(session.id) && session.threadId) {
            emitMirroredSessionSnapshot(session, true);
          }
        }
        return null;
      }
      case 'session_stop': {
        const session = sessions.get(args.id);
        if (session && session.generation === Number(args.generation)) {
          session.state = 'stopped';
          session.active = false;
          if (session.isDesktopMirrored) {
            explicitlyStoppedMirroredIds.add(session.id);
          }
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
        materializeDesktopSessions();
        const query = String(args.request?.query ?? '').trim().toLowerCase();
        const rawCwdFilter = args.request?.cwd ? String(args.request.cwd).trim() : '';
        const cwdFilter = rawCwdFilter
          ? normalizeWindowsExtendedPath(rawCwdFilter).replace(/[\\/]+$/, '').toLowerCase()
          : null;
        const matchedProjectIds = new Set();
        if (cwdFilter) {
          for (const p of state.projects || []) {
            const pCwd = p?.cwd ? normalizeWindowsExtendedPath(String(p.cwd)).replace(/[\\/]+$/, '').toLowerCase() : '';
            if (pCwd === cwdFilter || String(p?.id || '').toLowerCase() === cwdFilter || String(p?.name || '').toLowerCase() === cwdFilter) {
              if (p.id) matchedProjectIds.add(String(p.id));
            }
          }
        }
        const projectThreadIds = new Set();
        if (matchedProjectIds.size > 0) {
          for (const s of sessions.values()) {
            if (s.threadId && s.projectId && matchedProjectIds.has(String(s.projectId))) {
              projectThreadIds.add(String(s.threadId));
            }
          }
          for (const ls of state.layout?.sessions || []) {
            const tid = ls?.threadId || ls?.resumeSessionId;
            if (tid && ls?.projectId && matchedProjectIds.has(String(ls.projectId))) {
              projectThreadIds.add(String(tid));
            }
          }
        }

        const normalizeCatalogTimestamp = val => {
          const num = Number(val || 0);
          if (!Number.isFinite(num) || num <= 0) return Math.floor(Date.now() / 1000);
          return num > 10_000_000_000 ? Math.floor(num / 1000) : Math.floor(num);
        };
        const normalizeCatalogTitle = (nameVal, titleVal, previewVal, fallbackId) => {
          const raw = String(nameVal || titleVal || previewVal || fallbackId || '').trim();
          const firstLine = raw.split(/\r?\n/)[0].trim();
          return (firstLine || String(fallbackId || '세션')).slice(0, 200);
        };

        const threadMap = new Map();
        for (const t of Object.values(state.threads)) {
          if (!t || !t.id) continue;
          const tid = String(t.id);
          threadMap.set(tid, {
            id: tid,
            title: normalizeCatalogTitle(t.name, t.title, '', tid),
            cwd: normalizeWindowsExtendedPath(String(t.cwd || '')),
            createdAt: normalizeCatalogTimestamp(t.createdAt ?? t.created_at),
            updatedAt: normalizeCatalogTimestamp(t.updatedAt ?? t.updated_at),
            projectId: t.projectId ? String(t.projectId) : null,
          });
        }

        const stateDbPath = path.join(codexHomeDir || getCodexHome(), 'state_5.sqlite');
        if (fs.existsSync(stateDbPath)) {
          let db = null;
          try {
            db = new DatabaseSync(stateDbPath, { readOnly: true });
            const cols = new Set(
              db
                .prepare('PRAGMA table_info(threads)')
                .all()
                .map(c => String(c.name)),
            );
            if (cols.has('id')) {
              const selectCols = ['id', 'cwd', 'created_at', 'updated_at', 'name', 'title', 'first_user_message', 'preview', 'project_id', 'archived']
                .filter(c => cols.has(c));
              const whereClauses = [];
              if (cols.has('archived')) whereClauses.push('archived = 0');
              const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
              const orderSql = cols.has('updated_at') ? 'ORDER BY updated_at DESC' : '';
              const rows = db
                .prepare(`SELECT ${selectCols.join(', ')} FROM threads ${whereSql} ${orderSql} LIMIT 2500`)
                .all();
              for (const r of rows) {
                const tid = String(r.id);
                const rCwd = normalizeWindowsExtendedPath(String(r.cwd || ''));
                const rTitle = normalizeCatalogTitle(r.name, r.title, r.first_user_message || r.preview, tid);
                const existing = threadMap.get(tid);
                if (!existing) {
                  threadMap.set(tid, {
                    id: tid,
                    title: rTitle,
                    cwd: rCwd,
                    createdAt: normalizeCatalogTimestamp(r.created_at),
                    updatedAt: normalizeCatalogTimestamp(r.updated_at ?? r.created_at),
                    projectId: r.project_id ? String(r.project_id) : null,
                  });
                } else {
                  if ((!existing.title || existing.title === tid) && rTitle) existing.title = rTitle;
                  if (!existing.cwd && rCwd) existing.cwd = rCwd;
                  if (r.updated_at) existing.updatedAt = Math.max(existing.updatedAt, normalizeCatalogTimestamp(r.updated_at));
                }
              }
            }
          } catch {} finally {
            try { db?.close(); } catch {}
          }
        }

        if (appServerBridge.isConnected() && (threadMap.size === 0 || options.customTransport)) {
          try {
            const rpcRes = await appServerBridge.request(
              'thread/list',
              {
                cursor: args.request?.cursor ?? null,
                cwd: args.request?.cwd ?? undefined,
              },
              2000,
            );
            if (Array.isArray(rpcRes?.data)) {
              for (const r of rpcRes.data) {
                if (!r || !r.id) continue;
                const tid = String(r.id);
                if (!threadMap.has(tid)) {
                  threadMap.set(tid, {
                    id: tid,
                    title: normalizeCatalogTitle(r.name, r.title, r.preview, tid),
                    cwd: normalizeWindowsExtendedPath(String(r.cwd || '')),
                    createdAt: normalizeCatalogTimestamp(r.createdAt ?? r.created_at),
                    updatedAt: normalizeCatalogTimestamp(r.updatedAt ?? r.updated_at ?? r.createdAt ?? r.created_at),
                    projectId: r.projectId ? String(r.projectId) : null,
                  });
                }
              }
            }
          } catch {
            // Fall back to persisted workspace threads.
          }
        }

        const allThreads = [...threadMap.values()];
        const filtered = allThreads.filter(t => {
          if (cwdFilter) {
            const tCwd = normalizeWindowsExtendedPath(String(t.cwd || '')).replace(/[\\/]+$/, '').toLowerCase();
            const cwdMatched = tCwd === cwdFilter || tCwd.startsWith(`${cwdFilter}\\`) || tCwd.startsWith(`${cwdFilter}/`);
            const projectMatched = projectThreadIds.has(String(t.id)) || (t.projectId && matchedProjectIds.has(String(t.projectId)));
            if (!cwdMatched && !projectMatched) return false;
          }
          if (query && !String(t.title || '').toLowerCase().includes(query) && !String(t.id || '').toLowerCase().includes(query)) return false;
          return true;
        });
        filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return {
          sessions: filtered.slice(0, 250).map(t => ({
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
        let thread = state.threads[threadId];
        if ((!thread || !Array.isArray(thread.turns) || thread.turns.length === 0) && threadId) {
          const rollout = readCodexRolloutSummary(threadId, codexHomeDir);
          if (rollout && rollout.turns.length > 0) {
            thread = rollout;
          }
        }
        if ((!thread || !Array.isArray(thread.turns) || thread.turns.length === 0) && appServerBridge.isConnected() && threadId) {
          try {
            const readRes = await appServerBridge.request('thread/read', { threadId, includeTurns: true }, 2500);
            if (Array.isArray(readRes?.thread?.turns) && readRes.thread.turns.length > 0) {
              thread = readRes.thread;
            }
          } catch {
            // Fall back to local thread cache.
          }
        }
        const messages = [];
        let msgSeq = 1;
        if (thread && Array.isArray(thread.turns)) {
          for (const turn of thread.turns.slice(-20)) {
            for (const item of turn.items || []) {
              const txt = String(item.text ?? '').trim();
              if (!txt) continue;
              messages.push({
                id: String(item.id || `${turn.id || 'turn'}-${msgSeq++}`),
                role: item.role === 'user' || item.type === 'userMessage' ? 'user' : 'assistant',
                text: txt.slice(0, ITEM_PREVIEW_LIMIT),
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
      case 'slash_commands_list': {
        const session = args.id ? sessions.get(args.id) : null;
        const cwd = args.cwd ? String(args.cwd) : session?.cwd || null;
        return buildSlashCommandsList(cwd);
      }
      case 'check_for_updates': {
        const info = await fetchLatestReleaseInfo({
          rootDir: updateRootDir,
          releaseApiUrl: releaseApiUrl || undefined,
          fetchFn: updateFetchFn,
        });
        if (info.updateAvailable) {
          broadcast('update-available', info);
        }
        return {
          ...info,
          relayVersion: null,
          hostVersion: info.currentVersion,
          hostUpdateAvailable: info.updateAvailable,
        };
      }
      case 'apply_update': {
        const res = await performSelfUpdate({
          rootDir: updateRootDir,
          releaseApiUrl: releaseApiUrl || undefined,
          fetchFn: updateFetchFn,
          scheduleRestart: options.scheduleRestartOnUpdate !== false,
          onRestart: options.onRestart,
        });
        staticAssetCache.clear();
        broadcast('update-status-changed', {
          target: 'host',
          updated: res.updated,
          version: res.version,
          restartScheduled: res.restartScheduled,
        });
        return {
          ...res,
          host: res,
          relay: null,
        };
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
        const rpcConnected = appServerBridge.isConnected();
        const effectiveConnected = Boolean(rpcConnected || session.isDesktopMirrored || session.threadId);
        const supported = Boolean(appServerBridge.serverInfo?.supportsSubagentManagement ?? effectiveConnected);
        if (!req.type || req.type === 'list') {
          let agents = [];
          let nextCursor = null;
          if (rpcConnected && supported) {
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
            connected: effectiveConnected,
            parentRuntimeId: appServerBridge.runtimeId,
            agents,
            nextCursor,
            mutationState: 'clear',
            reconciledRequestId: req.requestId ?? null,
          };
        }
        if (rpcConnected && supported) {
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
        const connected = Boolean(
          appServerBridge.isConnected() ||
            session.isDesktopMirrored ||
            session.threadId ||
            session.active,
        );
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
        if (req.type === 'add') {
          const promptText = String(req.prompt ?? req.promptPreview ?? '').trim();
          const schedule = req.schedule || { type: 'every', seconds: 60 };
          const jobId = String(cronJobSeq++);
          const nextRunAt =
            schedule.type === 'every'
              ? Date.now() + Math.max(1, Number(schedule.seconds || 60)) * 1000
              : Number(schedule.atUnixMs || Date.now() + 60000);
          const job = {
            id: jobId,
            promptPreview: promptText.slice(0, 512),
            schedule,
            state: 'ready',
            paused: false,
            removed: false,
            nextRunAt,
            skipped: 0,
          };
          jobs.push(job);
          scheduleCronJob(session, job, promptText);
          return { status: 'applied', jobId };
        }
        if (req.type === 'pause' || req.type === 'resume' || req.type === 'remove' || req.type === 'cancel') {
          const job = jobs.find(j => j.id === String(req.jobId));
          if (!job) return { status: 'notApplied' };
          if (req.type === 'pause') job.paused = true;
          else if (req.type === 'resume') job.paused = false;
          else if (req.type === 'remove') {
            job.removed = true;
            clearCronTimer(job.id);
            const idx = jobs.indexOf(job);
            if (idx !== -1) jobs.splice(idx, 1);
          } else if (req.type === 'cancel') {
            if (session.threadId && appServerBridge.isConnected()) {
              await appServerBridge.request('turn/interrupt', { threadId: session.threadId }).catch(() => {});
            }
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
        const job = {
          id: jobId,
          promptPreview: String(saved.prompt).slice(0, 512),
          schedule: saved.schedule,
          state: 'ready',
          paused: false,
          removed: false,
          nextRunAt,
          skipped: 0,
        };
        jobs.push(job);
        scheduleCronJob(session, job, String(saved.prompt));
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
            // Fall through to rollout rate_limits fallback.
          }
        }
        if (!weekly) {
          const fallbackLimits = readLatestRateLimitsFromRollouts(codexHomeDir);
          if (fallbackLimits) {
            const parsed = extractWeeklyUsage(fallbackLimits);
            limitName = parsed.limitName ?? limitName;
            weekly = parsed.weekly;
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
      case 'list_directory': {
        const rawTarget = String(args.path ?? '').trim() || os.homedir();
        const targetPath = path.resolve(normalizeWindowsExtendedPath(rawTarget));
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          throw new Error(`폴더를 찾을 수 없습니다: ${targetPath}`);
        }
        const includeFiles = Boolean(args.includeFiles);
        const parentDir = path.dirname(targetPath);
        const parentPath = parentDir && parentDir !== targetPath ? parentDir : null;
        const roots = [os.homedir()];
        if (process.platform === 'win32') {
          for (const drive of ['C:\\', 'D:\\', 'E:\\', 'F:\\']) {
            try {
              if (fs.existsSync(drive) && !roots.includes(drive)) roots.push(drive);
            } catch {}
          }
        } else if (!roots.includes('/')) {
          roots.push('/');
        }
        const entries = [];
        try {
          for (const dirent of fs.readdirSync(targetPath, { withFileTypes: true })) {
            if (dirent.name.startsWith('.')) continue;
            const isDir = dirent.isDirectory();
            if (!isDir && !includeFiles) continue;
            entries.push({
              name: dirent.name,
              path: path.join(targetPath, dirent.name),
              isDirectory: isDir,
            });
          }
        } catch (err) {
          throw new Error(`폴더 내용을 읽을 수 없습니다: ${err.message || err}`);
        }
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return {
          currentPath: targetPath,
          parentPath,
          roots,
          entries: entries.slice(0, 300),
        };
      }
      case 'complete_exit': {
        for (const jobId of [...cronTimers.keys()]) {
          clearCronTimer(jobId);
        }
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

  const staticAssetCache = new Map(); // filePath -> { mtimeMs, size, etag, rawBuf, gzipBuf }

  function sendJsonResponse(req, res, statusCode, payload, extraHeaders = {}) {
    const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const acceptEnc = String(req.headers['accept-encoding'] || '');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    };
    if (jsonBuf.length >= 1024 && /\bgzip\b/i.test(acceptEnc)) {
      const gz = zlib.gzipSync(jsonBuf);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      headers.Vary = 'Accept-Encoding';
      res.writeHead(statusCode, headers);
      res.end(gz);
      return;
    }
    headers['Content-Length'] = jsonBuf.length;
    res.writeHead(statusCode, headers);
    res.end(jsonBuf);
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
        let rawBuf = Buffer.concat(chunks);
        const contentEnc = String(req.headers['content-encoding'] || '').toLowerCase();
        if (contentEnc === 'gzip') {
          rawBuf = zlib.gunzipSync(rawBuf, { maxOutputLength: MAX_BODY_BYTES });
        }
        const body = JSON.parse(rawBuf.toString('utf8'));
        callback(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `잘못된 JSON 요청입니다: ${err.message}` }));
      }
    });
  }

  const tlsCert = options.tlsCert || (options.tlsCertFile ? fs.readFileSync(options.tlsCertFile, 'utf8') : '');
  const tlsKey = options.tlsKey || (options.tlsKeyFile ? fs.readFileSync(options.tlsKeyFile, 'utf8') : '');
  const useTls = Boolean(tlsCert && tlsKey);

  const requestHandler = (req, res) => {
    const reqUrl = new URL(req.url || '/', `${useTls ? 'https' : 'http'}://${req.headers.host || '127.0.0.1'}`);
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
      const validSecret = isHostCredentialValid(String(hostAuth));
      const rate = checkAndRecordAuth(`host:${clientIp}`, validSecret);
      if (!rate.allowed) {
        res.writeHead(rate.locked ? 429 : 401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: false,
          oauthSupported: googleOAuthEnabled,
          authUrl: googleOAuthEnabled ? '/auth/google' : null,
          error: rate.locked
            ? '반복된 인증 실패로 호스트 연결이 일시 차단되었습니다.'
            : googleOAuthEnabled
              ? '유효한 호스트 인증(Google OAuth 또는 OPENDIY_REMOTE_HOST_SECRET)이 필요합니다.'
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
        if (activeHostLease && activeHostLease.hostId === requestedHostId) {
          if (activeHostLease.keepAlive) clearInterval(activeHostLease.keepAlive);
          try {
            if (activeHostLease.streamRes && activeHostLease.streamRes !== res) {
              activeHostLease.streamRes.end();
            }
          } catch {}
        }
        try { req.socket?.setNoDelay?.(true); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
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
        res.write(`data: ${JSON.stringify({ type: 'registered', hostId: requestedHostId, protocolVersion: RELAY_PROTOCOL_VERSION })}\n\n`);
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
          const reqId = String(body.reqId || '');
          const entry = activeHostLease?.pendingCalls.get(reqId);
          if (!entry) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ignored: true }));
            return;
          }
          activeHostLease.pendingCalls.delete(reqId);
          clearTimeout(entry.timer);
          if (body.ok) entry.resolve(body.result);
          else entry.reject(new Error(String(body.error || '호스트 명령 실행 실패')));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ignored: false }));
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
          const eventName = typeof body.event === 'string' ? body.event.trim() : '';
          if (!RELAY_EVENT_SET.has(eventName)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, code: 'EVENT_NOT_ALLOWED', error: `허용되지 않은 중계 이벤트입니다: ${eventName}` }));
            return;
          }
          broadcast(eventName, body.payload);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/relay/disconnect') {
        const hostId = String(req.headers['x-opendiy-host-id'] || '');
        if (!activeHostLease || activeHostLease.hostId !== hostId) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, released: false }));
          return;
        }
        releaseHostLease(hostId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, released: true }));
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/auth/google') {
      if (!googleOAuthEnabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Google OAuth is not configured on this server.');
        return;
      }
      const now = Date.now();
      for (const [k, entry] of oauthStates) {
        const expTime = typeof entry === 'number' ? entry : entry.exp;
        if (expTime < now) oauthStates.delete(k);
      }
      for (const [k, entry] of cliOAuthSessions) {
        if (entry.exp < now) cliOAuthSessions.delete(k);
      }
      if (oauthStates.size >= 256) {
        const oldest = oauthStates.keys().next().value;
        if (oldest) oauthStates.delete(oldest);
      }
      const cliSessionRaw = String(reqUrl.searchParams.get('cli_session') || '').trim();
      const cliSessionId = /^[a-f0-9]{16,128}$/i.test(cliSessionRaw) ? cliSessionRaw : null;
      if (cliSessionId) {
        if (cliOAuthSessions.size >= 128) {
          const oldestCli = cliOAuthSessions.keys().next().value;
          if (oldestCli) cliOAuthSessions.delete(oldestCli);
        }
        cliOAuthSessions.set(cliSessionId, { status: 'pending', exp: now + 10 * 60 * 1000 });
      }
      const stateNonce = crypto.randomBytes(24).toString('hex');
      oauthStates.set(stateNonce, { exp: now + 10 * 60 * 1000, cliSessionId });
      const isHttps = useTls || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
      const origin = `${isHttps ? 'https' : 'http'}://${req.headers.host || '127.0.0.1'}`;
      const redirectUri = `${origin}/auth/google/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', googleClientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('state', stateNonce);
      authUrl.searchParams.set('prompt', 'select_account');
      res.writeHead(302, { Location: authUrl.toString(), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/auth/google/cli-poll') {
      if (!googleOAuthEnabled) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, status: 'unsupported', error: '서버에 Google OAuth가 설정되어 있지 않습니다.' }));
        return;
      }
      const cliSessionId = String(reqUrl.searchParams.get('cli_session') || '').trim();
      const entry = cliOAuthSessions.get(cliSessionId);
      if (!entry || Date.now() > entry.exp) {
        cliOAuthSessions.delete(cliSessionId);
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, status: 'expired' }));
        return;
      }
      if (entry.status === 'authenticated' && entry.token) {
        cliOAuthSessions.delete(cliSessionId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, status: 'authenticated', token: entry.token, email: entry.email }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, status: 'pending' }));
      return;
    }

    if (req.method === 'GET' && pathname === '/auth/google/callback') {
      if (!googleOAuthEnabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Google OAuth is not configured on this server.');
        return;
      }
      const stateParam = reqUrl.searchParams.get('state') || '';
      const codeParam = reqUrl.searchParams.get('code') || '';
      const stateEntry = oauthStates.get(stateParam);
      oauthStates.delete(stateParam);
      const exp = typeof stateEntry === 'number' ? stateEntry : stateEntry?.exp;
      const cliSessionId = typeof stateEntry === 'object' && stateEntry ? stateEntry.cliSessionId : null;
      if (!stateParam || !codeParam || !exp || Date.now() > exp) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderAuthGatePage({ errorMsg: 'OAuth 인증 상태(state)가 만료되었거나 유효하지 않습니다. 다시 시도해 주세요.' }));
        return;
      }
      const isHttps = useTls || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
      const origin = `${isHttps ? 'https' : 'http'}://${req.headers.host || '127.0.0.1'}`;
      const redirectUri = `${origin}/auth/google/callback`;
      (async () => {
        try {
          const tokenRes = await fetch(googleOAuthTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code: codeParam,
              client_id: googleClientId,
              client_secret: googleClientSecret,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
            }).toString(),
          });
          if (!tokenRes.ok) {
            throw new Error(`Google 토큰 교환 실패 (HTTP ${tokenRes.status})`);
          }
          const tokenJson = await tokenRes.json();
          const accessToken = String(tokenJson.access_token || '');
          if (!accessToken) {
            throw new Error('Google 액세스 토큰을 받지 못했습니다.');
          }
          const userRes = await fetch(googleOAuthUserInfoUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!userRes.ok) {
            throw new Error(`Google 사용자 정보 조회 실패 (HTTP ${userRes.status})`);
          }
          const userInfo = await userRes.json();
          const email = String(userInfo.email || '').trim().toLowerCase();
          const verified = userInfo.email_verified === true || userInfo.verified_email === true;
          if (!email || !verified || !allowedEmails.has(email)) {
            checkAndRecordAuth(`client:${clientIp}`, false);
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(renderAuthGatePage({ errorMsg: `허용되지 않은 Google 계정(${email || '알 수 없음'})입니다. 소유자 계정으로만 접속할 수 있습니다.` }));
            return;
          }
          checkAndRecordAuth(`client:${clientIp}`, true);
          const sessionCookieVal = signOAuthSessionToken(email);
          const setCookieHeader = `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionCookieVal)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${isHttps ? '; Secure' : ''}`;
          if (cliSessionId && cliOAuthSessions.has(cliSessionId)) {
            const hostOAuthToken = signOAuthSessionToken(email, 30 * 24 * 60 * 60 * 1000);
            cliOAuthSessions.set(cliSessionId, {
              status: 'authenticated',
              token: hostOAuthToken,
              email,
              exp: Date.now() + 5 * 60 * 1000,
            });
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Set-Cookie': setCookieHeader,
            });
            res.end(renderCliOAuthSuccessPage(email));
            return;
          }
          res.writeHead(302, {
            Location: '/',
            'Cache-Control': 'no-store',
            'Set-Cookie': setCookieHeader,
          });
          res.end();
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderAuthGatePage({ errorMsg: `Google 로그인 처리 중 오류가 발생했습니다: ${String(err.message || err)}` }));
        }
      })();
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/auth/logout') {
      const isHttps = useTls || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
      res.writeHead(302, {
        Location: '/',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isHttps ? '; Secure' : ''}`,
      });
      res.end();
      return;
    }

    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const queryToken = reqUrl.searchParams.get('token') || '';
      const cookies = parseCookies(req.headers.cookie);
      const cookieToken = cookies[AUTH_COOKIE_NAME] || '';
      const provided = bearer || queryToken || cookieToken;
      const valid = isClientCredentialValid(provided);
      const rate = checkAndRecordAuth(`client:${clientIp}`, valid);
      if (!rate.allowed) {
        res.writeHead(rate.locked ? 429 : 401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: false,
          error: rate.locked
            ? '반복된 인증 실패로 접속이 일시 차단되었습니다. 잠시 후 다시 시도하세요.'
            : '유효한 원격 접속 인증(Google 로그인 또는 접속 토큰)이 필요합니다.',
        }));
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      try { req.socket?.setNoDelay?.(true); } catch {}
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      for (const cached of relayTerminalBuffers.values()) {
        try {
          res.write(`data: ${JSON.stringify({ event: 'terminal-output', payload: cached })}\n\n`);
        } catch {}
      }
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
          sendJsonResponse(req, res, 200, { ok: true, result });
        } catch (err) {
          sendJsonResponse(req, res, 400, { ok: false, error: String(err.message || err) });
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
        const cookies = parseCookies(req.headers.cookie);
        const cookieToken = cookies[AUTH_COOKIE_NAME] || '';
        const isHttps = useTls || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
        let hasValidAuth = isClientCredentialValid(cookieToken);
        if (urlToken && verifyToken(tokenSha256, urlToken)) {
          headers['Set-Cookie'] = `${AUTH_COOKIE_NAME}=${encodeURIComponent(urlToken.trim())}; HttpOnly; SameSite=Lax; Path=/${isHttps ? '; Secure' : ''}`;
          hasValidAuth = true;
        }
        if (path.basename(filePath) === 'index.html') {
          if (googleOAuthEnabled && !hasValidAuth) {
            res.writeHead(200, headers);
            res.end(renderAuthGatePage(), 'utf8');
            return;
          }
          const htmlBuf = Buffer.from(injectRemoteFlag(fs.readFileSync(filePath, 'utf8')), 'utf8');
          const acceptEnc = String(req.headers['accept-encoding'] || '');
          if (htmlBuf.length >= 1024 && /\bgzip\b/i.test(acceptEnc)) {
            const gz = zlib.gzipSync(htmlBuf);
            headers['Content-Encoding'] = 'gzip';
            headers['Content-Length'] = gz.length;
            headers.Vary = 'Accept-Encoding';
            res.writeHead(200, headers);
            res.end(gz);
            return;
          }
          headers['Content-Length'] = htmlBuf.length;
          res.writeHead(200, headers);
          res.end(htmlBuf);
        } else {
          try {
            const st = fs.statSync(filePath);
            let cachedAsset = staticAssetCache.get(filePath);
            if (!cachedAsset || cachedAsset.mtimeMs !== st.mtimeMs || cachedAsset.size !== st.size) {
              const rawBuf = fs.readFileSync(filePath);
              const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
              const ext = path.extname(filePath).toLowerCase();
              const compressible = ['.js', '.mjs', '.css', '.json', '.svg', '.html'].includes(ext) && rawBuf.length >= 512;
              const gzipBuf = compressible ? zlib.gzipSync(rawBuf) : null;
              cachedAsset = { mtimeMs: st.mtimeMs, size: st.size, etag, rawBuf, gzipBuf };
              staticAssetCache.set(filePath, cachedAsset);
            }
            const isHashedAsset = pathname.startsWith('/assets/');
            headers['Cache-Control'] = isHashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
            headers.ETag = cachedAsset.etag;
            if (req.headers['if-none-match'] === cachedAsset.etag) {
              res.writeHead(304, headers);
              res.end();
              return;
            }
            const acceptEnc = String(req.headers['accept-encoding'] || '');
            if (cachedAsset.gzipBuf && /\bgzip\b/i.test(acceptEnc)) {
              headers['Content-Encoding'] = 'gzip';
              headers['Content-Length'] = cachedAsset.gzipBuf.length;
              headers.Vary = 'Accept-Encoding';
              res.writeHead(200, headers);
              res.end(cachedAsset.gzipBuf);
              return;
            }
            headers['Content-Length'] = cachedAsset.rawBuf.length;
            res.writeHead(200, headers);
            res.end(cachedAsset.rawBuf);
          } catch {
            res.writeHead(200, headers);
            fs.createReadStream(filePath).pipe(res);
          }
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found (Run "npm run build" first to generate dist/)');
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  };

  const server = useTls
    ? https.createServer({ cert: tlsCert, key: tlsKey }, requestHandler)
    : http.createServer(requestHandler);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.on('connection', socket => {
    try { socket.setNoDelay(true); } catch {}
  });

  const autoUpdateEnabled =
    options.autoUpdate !== undefined
      ? Boolean(options.autoUpdate)
      : process.env.OPENDIY_REMOTE_AUTO_UPDATE === '1' || process.env.OPENDIY_REMOTE_AUTO_UPDATE === 'true';
  const autoUpdateIntervalMs = Math.max(
    60 * 1000,
    Number(options.autoUpdateIntervalMs || process.env.OPENDIY_REMOTE_AUTO_UPDATE_INTERVAL_MS || 6 * 60 * 60 * 1000),
  );
  const autoUpdateTimer = autoUpdateEnabled
    ? setInterval(() => {
        void (async () => {
          try {
            const info = await fetchLatestReleaseInfo({
              rootDir: updateRootDir,
              releaseApiUrl: releaseApiUrl || undefined,
              fetchFn: updateFetchFn,
            });
            if (info.updateAvailable) {
              broadcast('update-available', info);
              await performSelfUpdate({
                rootDir: updateRootDir,
                releaseInfo: info,
                fetchFn: updateFetchFn,
                scheduleRestart: options.scheduleRestartOnUpdate !== false,
                onRestart: options.onRestart,
              });
            }
          } catch {}
        })();
      }, autoUpdateIntervalMs)
    : null;
  autoUpdateTimer?.unref?.();

  return {
    server,
    dispatchCommand,
    broadcast,
    close: async () => {
      if (autoUpdateTimer) clearInterval(autoUpdateTimer);
      if (desktopWatchInterval) clearInterval(desktopWatchInterval);
      for (const jobId of [...cronTimers.keys()]) {
        clearCronTimer(jobId);
      }
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
  const relayUrl = normalizeRelayBaseUrl(options.relayUrl || process.env.OPENDIY_REMOTE_RELAY_URL || '');
  const explicitSecret = String(options.hostSecret ?? process.env.OPENDIY_REMOTE_HOST_SECRET ?? process.env.OPENDIY_REMOTE_TOKEN ?? '').trim();
  const localWorkspaceDir = path.resolve(
    options.workspaceDir ||
      process.env.OPENDIY_REMOTE_DATA_DIR ||
      process.env.AGENT_GRID_WORKSPACE_DIR ||
      path.join(os.tmpdir(), 'opendiy-remote-workspace'),
  );
  const oauthCacheFile = path.resolve(options.oauthCacheFile || path.join(localWorkspaceDir, 'host-oauth-token.json'));
  const hostId = options.hostId || crypto.randomUUID();
  const rejectUnauthorized = options.tlsRejectUnauthorized !== undefined
    ? Boolean(options.tlsRejectUnauthorized)
    : process.env.OPENDIY_REMOTE_TLS_INSECURE !== '1' && process.env.OPENDIY_REMOTE_TLS_INSECURE !== 'true';
  let stopped = false;
  let activeReq = null;
  let reconnectTimer = null;
  let oauthPollTimer = null;
  let oauthInProgress = false;
  const inFlightReqIds = new Set();
  const completedReqIds = new Map(); // reqId -> { ok, result, error }

  function loadCachedOAuthToken() {
    try {
      if (!fs.existsSync(oauthCacheFile)) return '';
      const raw = JSON.parse(fs.readFileSync(oauthCacheFile, 'utf8'));
      const entry = raw && typeof raw === 'object' ? raw[relayUrl] : null;
      if (!entry || typeof entry.token !== 'string' || !entry.token.startsWith('oauth.')) return '';
      const parts = entry.token.split('.');
      if (parts.length === 3) {
        const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (parsed && typeof parsed.exp === 'number' && Date.now() >= parsed.exp - 60000) {
          return '';
        }
      }
      return entry.token;
    } catch {
      return '';
    }
  }

  function saveCachedOAuthToken(token, email) {
    try {
      fs.mkdirSync(path.dirname(oauthCacheFile), { recursive: true });
      let current = {};
      if (fs.existsSync(oauthCacheFile)) {
        try { current = JSON.parse(fs.readFileSync(oauthCacheFile, 'utf8')) || {}; } catch {}
      }
      current[relayUrl] = { token, email: email || null, savedAt: Date.now() };
      fs.writeFileSync(oauthCacheFile, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Ignore cache write errors.
    }
  }

  let currentAuthToken = explicitSecret || loadCachedOAuthToken();

  const localRuntime = createRemoteServer({
    ...options,
    mode: 'direct',
    tlsCert: '',
    tlsKey: '',
    tlsCertFile: '',
    tlsKeyFile: '',
    onBroadcast: (event, payload) => {
      if (!stopped && RELAY_EVENT_SET.has(event)) {
        postJson('/api/relay/event', { event, payload }).catch(() => {
          if (event === 'terminal-output' && !stopped) {
            postJson('/api/relay/event', { event: 'session-output', payload }).catch(() => {});
          }
        });
      }
    },
  });

  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 });
  const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, rejectUnauthorized });

  function recordCompletedReply(reqId, replyPayload) {
    if (completedReqIds.size >= 256) {
      const oldestKey = completedReqIds.keys().next().value;
      if (oldestKey !== undefined) completedReqIds.delete(oldestKey);
    }
    completedReqIds.set(reqId, replyPayload);
  }

  function getJson(endpointPath) {
    return new Promise((resolve, reject) => {
      const target = new URL(endpointPath, `${relayUrl}/`);
      const isHttpsTarget = target.protocol === 'https:';
      const mod = isHttpsTarget ? https : http;
      const req = mod.request(
        target,
        {
          method: 'GET',
          agent: isHttpsTarget ? httpsAgent : httpAgent,
          ...(isHttpsTarget ? { rejectUnauthorized } : {}),
          headers: { Accept: 'application/json', Connection: 'keep-alive' },
        },
        res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              resolve({ statusCode: res.statusCode || 0, body });
            } catch {
              resolve({ statusCode: res.statusCode || 0, body: {} });
            }
          });
        },
      );
      req.setNoDelay(true);
      req.on('error', reject);
      req.end();
    });
  }

  function openSystemBrowser(url) {
    if (options.openBrowser === false) return;
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      // User can still click the printed URL manually.
    }
  }

  function startCliOAuthFlow() {
    if (stopped || oauthInProgress || options.oauthLogin === false) return;
    oauthInProgress = true;
    const cliSessionId = crypto.randomBytes(24).toString('hex');
    const loginUrl = `${relayUrl}/auth/google?cli_session=${cliSessionId}`;
    options.onOAuthPrompt?.({ loginUrl, cliSessionId });
    if (options.silent !== true) {
      console.log(`\n[OpenDIY Remote] Google OAuth 로그인으로 로컬 PC 호스트를 인증합니다.`);
      console.log(`브라우저에서 허용된 Google 계정으로 로그인하세요:\n  ${loginUrl}\n`);
    }
    openSystemBrowser(loginUrl);

    const pollInterval = Math.max(150, Number(options.oauthPollIntervalMs || 1200));
    const pollOnce = async () => {
      if (stopped) return;
      try {
        const { statusCode, body } = await getJson(`/auth/google/cli-poll?cli_session=${cliSessionId}`);
        if (stopped) return;
        if (statusCode === 200 && body.status === 'authenticated' && body.token) {
          oauthInProgress = false;
          currentAuthToken = String(body.token);
          saveCachedOAuthToken(currentAuthToken, body.email);
          options.onOAuthAuthenticated?.({ email: body.email, token: currentAuthToken });
          if (options.silent !== true) {
            console.log(`[OpenDIY Remote] Google OAuth 인증 완료 (${body.email || 'owner'}). 중계 서버에 연결합니다...`);
          }
          connectStream();
          return;
        }
        if (statusCode === 404 && body.status === 'unsupported') {
          oauthInProgress = false;
          if (options.silent !== true) {
            console.error(`[OpenDIY Remote] 중계 서버에 Google OAuth가 설정되어 있지 않습니다. --host-secret 옵션을 사용하세요.`);
          }
          return;
        }
      } catch {
        // Retry on transient network errors while user completes login.
      }
      if (!stopped && oauthInProgress) {
        oauthPollTimer = setTimeout(pollOnce, pollInterval);
      }
    };
    oauthPollTimer = setTimeout(pollOnce, pollInterval);
  }

  function postJson(endpointPath, payload) {
    return new Promise((resolve, reject) => {
      const target = new URL(endpointPath, `${relayUrl}/`);
      const isHttpsTarget = target.protocol === 'https:';
      const mod = isHttpsTarget ? https : http;
      const rawBuf = Buffer.from(JSON.stringify(payload), 'utf8');
      const useGzip = rawBuf.length >= 2048;
      const bodyBuf = useGzip ? zlib.gzipSync(rawBuf) : rawBuf;
      const req = mod.request(
        target,
        {
          method: 'POST',
          agent: isHttpsTarget ? httpsAgent : httpAgent,
          ...(isHttpsTarget ? { rejectUnauthorized } : {}),
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
            'Content-Length': bodyBuf.length,
            Connection: 'keep-alive',
            'X-OpenDIY-Host-Id': hostId,
            ...(currentAuthToken ? { 'X-OpenDIY-Host-Secret': currentAuthToken } : {}),
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
      req.setNoDelay(true);
      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });
  }

  // localRuntime.broadcast already invokes onBroadcast via internal broadcast(event, payload)

  function connectStream() {
    if (stopped) return;
    const streamUrl = new URL('/api/relay/stream', `${relayUrl}/`);
    const mod = streamUrl.protocol === 'https:' ? https : http;
    const req = mod.request(
      streamUrl,
      {
        method: 'GET',
        ...(streamUrl.protocol === 'https:' ? { rejectUnauthorized } : {}),
        headers: {
          Accept: 'text/event-stream',
          'X-OpenDIY-Host-Id': hostId,
          ...(currentAuthToken ? { 'X-OpenDIY-Host-Secret': currentAuthToken } : {}),
        },
      },
      res => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            if (stopped) return;
            if (res.statusCode === 401 && !explicitSecret) {
              try {
                const errBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                if (errBody.oauthSupported) {
                  startCliOAuthFlow();
                  return;
                }
              } catch {}
            }
            if (options.autoReconnect !== false) {
              reconnectTimer = setTimeout(connectStream, 2000);
            }
          });
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
              const reqId = String(msg.reqId);
              if (inFlightReqIds.has(reqId)) {
                return;
              }
              if (completedReqIds.has(reqId)) {
                const cached = completedReqIds.get(reqId);
                await postJson('/api/relay/reply', cached).catch(() => {});
                return;
              }
              const command = String(msg.command || '');
              if (!RELAY_COMMAND_SET.has(command)) {
                const denied = {
                  reqId,
                  ok: false,
                  error: `호스트에서 허용되지 않은 원격 명령입니다: ${command}`,
                };
                recordCompletedReply(reqId, denied);
                await postJson('/api/relay/reply', denied).catch(() => {});
                return;
              }
              inFlightReqIds.add(reqId);
              try {
                const result = await localRuntime.dispatchCommand(command, msg.args || {});
                const reply = { reqId, ok: true, result };
                recordCompletedReply(reqId, reply);
                if (!stopped) {
                  await postJson('/api/relay/reply', reply);
                }
              } catch (err) {
                const reply = {
                  reqId,
                  ok: false,
                  error: String(err.message || err),
                };
                recordCompletedReply(reqId, reply);
                if (!stopped) {
                  await postJson('/api/relay/reply', reply);
                }
              } finally {
                inFlightReqIds.delete(reqId);
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
    relayUrl,
    localRuntime,
    close: async () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      inFlightReqIds.clear();
      if (activeReq) {
        try { activeReq.destroy(); } catch {}
        activeReq = null;
      }
      await postJson('/api/relay/disconnect', {}).catch(() => {});
      try { httpAgent.destroy(); } catch {}
      try { httpsAgent.destroy(); } catch {}
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
  let tlsCertFile = process.env.OPENDIY_REMOTE_TLS_CERT || '';
  let tlsKeyFile = process.env.OPENDIY_REMOTE_TLS_KEY || '';
  let tlsInsecure = process.env.OPENDIY_REMOTE_TLS_INSECURE === '1' || process.env.OPENDIY_REMOTE_TLS_INSECURE === 'true';
  let googleClientId = process.env.OPENDIY_REMOTE_GOOGLE_CLIENT_ID || '';
  let googleClientSecret = process.env.OPENDIY_REMOTE_GOOGLE_CLIENT_SECRET || '';
  let allowedEmail = process.env.OPENDIY_REMOTE_ALLOWED_EMAIL || '';
  let autoUpdate = process.env.OPENDIY_REMOTE_AUTO_UPDATE === '1' || process.env.OPENDIY_REMOTE_AUTO_UPDATE === 'true';
  let checkUpdateOnly = false;
  let applyUpdateNow = false;

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
    } else if (argv[i] === '--tls-cert' && argv[i + 1]) {
      tlsCertFile = argv[++i];
    } else if (argv[i].startsWith('--tls-cert=')) {
      tlsCertFile = argv[i].slice('--tls-cert='.length);
    } else if (argv[i] === '--tls-key' && argv[i + 1]) {
      tlsKeyFile = argv[++i];
    } else if (argv[i].startsWith('--tls-key=')) {
      tlsKeyFile = argv[i].slice('--tls-key='.length);
    } else if (argv[i] === '--tls-insecure') {
      tlsInsecure = true;
    } else if (argv[i] === '--google-client-id' && argv[i + 1]) {
      googleClientId = argv[++i];
    } else if (argv[i].startsWith('--google-client-id=')) {
      googleClientId = argv[i].slice('--google-client-id='.length);
    } else if (argv[i] === '--google-client-secret' && argv[i + 1]) {
      googleClientSecret = argv[++i];
    } else if (argv[i].startsWith('--google-client-secret=')) {
      googleClientSecret = argv[i].slice('--google-client-secret='.length);
    } else if (argv[i] === '--allowed-email' && argv[i + 1]) {
      allowedEmail = argv[++i];
    } else if (argv[i].startsWith('--allowed-email=')) {
      allowedEmail = argv[i].slice('--allowed-email='.length);
    } else if (argv[i] === '--auto-update') {
      autoUpdate = true;
    } else if (argv[i] === '--no-auto-update') {
      autoUpdate = false;
    } else if (argv[i] === '--check-update') {
      checkUpdateOnly = true;
    } else if (argv[i] === '--update') {
      applyUpdateNow = true;
    }
  }

  if (checkUpdateOnly || applyUpdateNow) {
    (async () => {
      try {
        const info = await fetchLatestReleaseInfo();
        if (checkUpdateOnly && !applyUpdateNow) {
          console.log(
            info.updateAvailable
              ? `[OpenDIY Remote] 새 업데이트가 있습니다: v${info.currentVersion} -> v${info.latestVersion} (${info.releaseUrl})`
              : `[OpenDIY Remote] 현재 최신 버전(v${info.currentVersion})입니다.`,
          );
          process.exit(0);
        }
        if (!info.updateAvailable) {
          console.log(`[OpenDIY Remote] 이미 최신 버전(v${info.currentVersion})입니다.`);
          process.exit(0);
        }
        console.log(`[OpenDIY Remote] v${info.currentVersion} -> v${info.latestVersion} 자동 업데이트를 다운로드 및 적용합니다...`);
        const res = await performSelfUpdate({ releaseInfo: info, scheduleRestart: false });
        console.log(`[OpenDIY Remote] v${res.version} 업데이트 완료 (SHA-256: ${res.sha256}).`);
        process.exit(0);
      } catch (err) {
        console.error(`[OpenDIY Remote] 업데이트 오류: ${err.message || err}`);
        process.exit(1);
      }
    })();
  } else if (mode === 'connect' || connectUrl) {
    const connector = startHostConnector({
      relayUrl: connectUrl,
      hostSecret: hostSecret || token,
      workspaceDir: workspaceDir || undefined,
      tlsRejectUnauthorized: !tlsInsecure,
      autoUpdate,
      onRegistered: ({ hostId }) => {
        console.log(`OpenDIY Remote Host Connector registered with relay (${connectUrl}) [hostId=${hostId}]`);
      },
    });
    process.on('SIGINT', () => {
      connector.close().finally(() => process.exit(0));
    });
  } else {
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const hasOAuth = Boolean(googleClientId.trim() && googleClientSecret.trim() && allowedEmail.trim());
    if (!isLoopback && !token.trim() && !hasOAuth) {
      console.error(`Error: Refusing to bind non-loopback address (${host}:${port}) without --token or Google OAuth (--google-client-id, --google-client-secret, --allowed-email).`);
      process.exit(1);
    }

    const instance = createRemoteServer({
      mode,
      token,
      hostSecret: hostSecret || token,
      workspaceDir: workspaceDir || undefined,
      tlsCertFile: tlsCertFile || undefined,
      tlsKeyFile: tlsKeyFile || undefined,
      googleClientId: googleClientId || undefined,
      googleClientSecret: googleClientSecret || undefined,
      allowedEmail: allowedEmail || undefined,
      autoUpdate,
    });
    instance.server.listen(port, host, () => {
      const addr = instance.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const scheme = tlsCertFile && tlsKeyFile ? 'https' : 'http';
      console.log(`OpenDIY Remote (${mode} mode) listening on ${scheme}://${host}:${actualPort}`);
    });
  }
}
