// Browser-to-server Tauri IPC bridge for OpenDIY Remote.
// Activates only when served by the OpenDIY Remote server (__OPENDIY_REMOTE__)
// or when ?remote=1 is present in the URL, preserving standard desktop and test modes.

const TOKEN_STORAGE_KEY = 'opendiy_remote_token';

export function isRemoteBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const state = window as unknown as Record<string, unknown>;
  if (state.__OPENDIY_REMOTE__ === true) return true;
  try {
    return new URLSearchParams(window.location.search).has('remote');
  } catch {
    return false;
  }
}

function captureTokenFromUrl(): string {
  try {
    const url = new URL(window.location.href);
    const urlToken = url.searchParams.get('token');
    if (urlToken) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      return urlToken;
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function getStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function setStoredToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors in restricted browser contexts.
  }
}

export function installRemoteBridge(): void {
  if (!isRemoteBrowser()) return;
  const state = window as unknown as Record<string, unknown>;
  if (state.__TAURI_INTERNALS__) return;

  captureTokenFromUrl();
  state.isTauri = true;

  let nextCallbackId = 1;
  const callbacks = new Map<number, (value: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  let eventSource: EventSource | null = null;

  function emitLocal(event: string, payload: unknown): void {
    const ids = listeners.get(event);
    if (!ids) return;
    for (const id of [...ids]) {
      const handler = callbacks.get(id);
      if (handler) {
        try {
          handler({ event, id, payload });
        } catch (error) {
          console.error(`Remote event handler error (${event}):`, error);
        }
      }
    }
  }

  function connectEvents(forceReconnect = false): void {
    if (typeof EventSource === 'undefined') return;
    if (eventSource && !forceReconnect) return;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    const token = getStoredToken();
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    const source = new EventSource(url);
    source.onmessage = message => {
      try {
        const parsed = JSON.parse(message.data) as { event?: string; payload?: unknown };
        if (typeof parsed.event === 'string') {
          emitLocal(parsed.event, parsed.payload);
          if (parsed.event === 'session-output') {
            emitLocal('terminal-output', parsed.payload);
          }
        }
      } catch {
        // Ignore malformed keepalive or non-JSON frames.
      }
    };
    eventSource = source;
  }

  async function remoteInvoke(command: string, args: Record<string, unknown> = {}, retried = false): Promise<unknown> {
    const token = getStoredToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch('/api/invoke', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command, args }),
    });

    if (response.status === 401 && !retried && typeof window.prompt === 'function') {
      const input = window.prompt('OpenDIY Remote 접속 토큰을 입력하세요 (Enter remote access token):', '');
      if (input !== null && input.trim()) {
        setStoredToken(input.trim());
        connectEvents(true);
        return remoteInvoke(command, args, true);
      }
    }

    let body: { ok?: boolean; result?: unknown; error?: string } | null = null;
    try {
      body = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
    } catch {
      throw new Error(`원격 서버 응답을 해석할 수 없습니다 (HTTP ${response.status}).`);
    }

    if (!response.ok || !body || body.ok !== true) {
      throw new Error(body?.error || `원격 서버 요청 실패 (${command}: HTTP ${response.status})`);
    }
    return body.result ?? null;
  }

  interface DirectoryListing {
    currentPath: string;
    parentPath: string | null;
    roots: string[];
    entries: { name: string; path: string; isDirectory: boolean }[];
  }

  function openRemotePathPicker(options: {
    koTitle: string;
    enTitle: string;
    includeFiles?: boolean;
  }): Promise<string | null> {
    if (typeof document === 'undefined' || !document.body) {
      return Promise.resolve(null);
    }
    const lang = document.documentElement.lang === 'en' ? 'en' : 'ko';
    const titleText = lang === 'en' ? options.enTitle : options.koTitle;
    const includeFiles = Boolean(options.includeFiles);

    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'remote-path-dialog';
      dialog.innerHTML = `
        <div class="dialog-heading">
          <span class="eyebrow">${lang === 'en' ? 'REMOTE FILE SYSTEM' : '원격 호스트 경로 탐색'}</span>
          <button type="button" class="icon-button remote-path-cancel" aria-label="${lang === 'en' ? 'Close' : '닫기'}">×</button>
        </div>
        <h2></h2>
        <div class="remote-path-roots"></div>
        <div class="remote-path-bar">
          <input type="text" class="remote-path-input" placeholder="${lang === 'en' ? 'Absolute path on host PC' : '호스트 PC 절대 경로'}" />
          <button type="button" class="quiet-button remote-path-go">${lang === 'en' ? 'Open' : '열기'}</button>
        </div>
        <p class="remote-path-error inline-error" hidden></p>
        <div class="remote-path-entries" role="listbox"></div>
        <div class="dialog-actions">
          <button type="button" class="quiet-button remote-path-cancel-btn">${lang === 'en' ? 'Cancel' : '취소'}</button>
          <button type="button" class="primary-button remote-path-select-btn">${
            includeFiles
              ? lang === 'en'
                ? 'Select Path →'
                : '이 경로 선택 →'
              : lang === 'en'
                ? 'Select Folder →'
                : '이 폴더 선택 →'
          }</button>
        </div>
      `;
      dialog.querySelector('h2')!.textContent = titleText;
      document.body.append(dialog);

      const input = dialog.querySelector<HTMLInputElement>('.remote-path-input')!;
      const rootsEl = dialog.querySelector<HTMLElement>('.remote-path-roots')!;
      const entriesEl = dialog.querySelector<HTMLElement>('.remote-path-entries')!;
      const errorEl = dialog.querySelector<HTMLElement>('.remote-path-error')!;

      let settled = false;
      function finish(val: string | null) {
        if (settled) return;
        settled = true;
        try {
          if (dialog.open) dialog.close();
        } catch {}
        dialog.remove();
        resolve(val);
      }

      async function loadDir(targetPath = '') {
        errorEl.hidden = true;
        try {
          const listing = (await remoteInvoke('list_directory', {
            path: targetPath,
            includeFiles,
          })) as DirectoryListing;
          input.value = listing.currentPath || targetPath;

          rootsEl.replaceChildren();
          for (const rootPath of listing.roots || []) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quiet-button remote-root-chip';
            btn.textContent = rootPath;
            btn.onclick = () => void loadDir(rootPath);
            rootsEl.append(btn);
          }

          entriesEl.replaceChildren();
          if (listing.parentPath) {
            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'remote-entry-row';
            upBtn.innerHTML = `<span class="remote-entry-icon">↰</span><span class="remote-entry-name">.. (${lang === 'en' ? 'Parent folder' : '상위 폴더'})</span>`;
            upBtn.onclick = () => void loadDir(listing.parentPath!);
            entriesEl.append(upBtn);
          }
          for (const item of listing.entries || []) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'remote-entry-row';
            const icon = document.createElement('span');
            icon.className = 'remote-entry-icon';
            icon.textContent = item.isDirectory ? '📁' : '📄';
            const name = document.createElement('span');
            name.className = 'remote-entry-name';
            name.textContent = item.name;
            row.append(icon, name);
            row.onclick = () => {
              if (item.isDirectory) {
                void loadDir(item.path);
              } else {
                input.value = item.path;
              }
            };
            entriesEl.append(row);
          }
        } catch (err) {
          errorEl.hidden = false;
          errorEl.textContent = err instanceof Error ? err.message : String(err);
        }
      }

      dialog.querySelector<HTMLButtonElement>('.remote-path-go')!.onclick = () => {
        void loadDir(input.value.trim());
      };
      input.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(input.value.trim() || null);
        }
      };
      dialog.querySelector<HTMLButtonElement>('.remote-path-cancel')!.onclick = () => finish(null);
      dialog.querySelector<HTMLButtonElement>('.remote-path-cancel-btn')!.onclick = () => finish(null);
      dialog.querySelector<HTMLButtonElement>('.remote-path-select-btn')!.onclick = () => {
        const chosen = input.value.trim();
        finish(chosen || null);
      };
      dialog.addEventListener('close', () => finish(null));

      dialog.showModal();
      void loadDir('');
    });
  }

  state.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      listeners.get(event)?.delete(eventId);
    },
  };

  state.__TAURI_INTERNALS__ = {
    transformCallback(handler: (value: unknown) => void, once = false) {
      const id = nextCallbackId++;
      callbacks.set(id, value => {
        if (once) callbacks.delete(id);
        handler(value);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    async invoke(command: string, args: Record<string, unknown> = {}) {
      if (command === 'plugin:event|listen') {
        const event = String(args.event ?? '');
        const handlerId = Number(args.handler);
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handlerId);
        connectEvents(false);
        return handlerId;
      }
      if (command === 'plugin:event|unlisten') {
        const event = String(args.event ?? '');
        const eventId = Number(args.eventId ?? args.handler);
        listeners.get(event)?.delete(eventId);
        return null;
      }
      if (command === 'plugin:event|emit') {
        emitLocal(String(args.event ?? ''), args.payload);
        return null;
      }
      if (command === 'open_external_url') {
        const url = String(args.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('외부 링크는 http 또는 https 주소만 열 수 있습니다.');
        }
        window.open(url, '_blank', 'noopener,noreferrer');
        return null;
      }
      if (command === 'choose_project_folder') {
        const directPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
        const path =
          directPath ??
          (await openRemotePathPicker({
            koTitle: '프로젝트 폴더 선택',
            enTitle: 'Select Project Folder',
            includeFiles: false,
          }));
        if (!path) return null;
        return remoteInvoke('choose_project_folder', { path });
      }
      if (command === 'choose_project') {
        const directCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null;
        const cwd =
          directCwd ??
          (await openRemotePathPicker({
            koTitle: '가져올 프로젝트 폴더 선택',
            enTitle: 'Import Project Folder',
            includeFiles: false,
          }));
        if (!cwd) return null;
        return remoteInvoke('choose_project', { cwd });
      }
      if (command === 'choose_skill_folder') {
        const directPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
        const path =
          directPath ??
          (await openRemotePathPicker({
            koTitle: '스킬 폴더 선택',
            enTitle: 'Select Skill Folder',
            includeFiles: false,
          }));
        if (!path) return null;
        return remoteInvoke('choose_skill_folder', { path });
      }
      if (command === 'choose_codex_executable') {
        const directPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
        const path =
          directPath ??
          (await openRemotePathPicker({
            koTitle: 'Codex CLI 실행 파일 선택',
            enTitle: 'Select Codex CLI Executable',
            includeFiles: true,
          }));
        if (!path) return null;
        return remoteInvoke('set_codex_executable', { path });
      }
      if (command === 'choose_app_server_executable') {
        const directPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
        const path =
          directPath ??
          (await openRemotePathPicker({
            koTitle: 'Codex 앱 서버 실행 파일 선택',
            enTitle: 'Select Codex App-Server Executable',
            includeFiles: true,
          }));
        if (!path) return null;
        return remoteInvoke('set_app_server_executable', { path });
      }
      if (command === 'choose_conversation_attachments') {
        const directPaths = Array.isArray(args.paths) ? args.paths : null;
        if (directPaths && directPaths.length > 0) {
          return remoteInvoke('choose_conversation_attachments', { paths: directPaths });
        }
        const path = await openRemotePathPicker({
          koTitle: '첨부할 파일 선택',
          enTitle: 'Select File to Attach',
          includeFiles: true,
        });
        if (!path) return [];
        return remoteInvoke('choose_conversation_attachments', { paths: [path] });
      }
      return remoteInvoke(command, args);
    },
  };
}

installRemoteBridge();
