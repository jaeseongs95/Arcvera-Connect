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

  function promptRemotePath(koPrompt: string, enPrompt: string): string | null {
    if (typeof window.prompt !== 'function') return null;
    const lang = document.documentElement.lang === 'en' ? 'en' : 'ko';
    const value = window.prompt(lang === 'en' ? enPrompt : koPrompt, '');
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
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
        const path = promptRemotePath(
          '원격 서버의 프로젝트 폴더 절대 경로를 입력하세요:',
          'Enter the absolute project folder path on the remote server:',
        );
        if (!path) return null;
        return remoteInvoke('choose_project_folder', { path });
      }
      if (command === 'choose_project') {
        const cwd = promptRemotePath(
          '가져올 원격 서버의 프로젝트 폴더 절대 경로를 입력하세요:',
          'Enter the absolute project folder path to import from the remote server:',
        );
        if (!cwd) return null;
        return remoteInvoke('choose_project', { cwd });
      }
      if (command === 'choose_skill_folder') {
        const path = promptRemotePath(
          '원격 서버의 스킬 폴더 절대 경로를 입력하세요:',
          'Enter the absolute skill folder path on the remote server:',
        );
        if (!path) return null;
        return remoteInvoke('choose_skill_folder', { path });
      }
      if (command === 'choose_codex_executable') {
        const path = promptRemotePath(
          '원격 서버의 Codex CLI 실행 파일 절대 경로를 입력하세요:',
          'Enter the absolute path to the Codex CLI executable on the remote server:',
        );
        if (!path) return null;
        return remoteInvoke('set_codex_executable', { path });
      }
      if (command === 'choose_app_server_executable') {
        const path = promptRemotePath(
          '원격 서버의 Codex 앱 서버 실행 파일 절대 경로를 입력하세요:',
          'Enter the absolute path to the Codex app-server executable on the remote server:',
        );
        if (!path) return null;
        return remoteInvoke('set_app_server_executable', { path });
      }
      if (command === 'choose_conversation_attachments') {
        const path = promptRemotePath(
          '첨부할 원격 서버 파일의 절대 경로를 입력하세요 (이미지는 대화창에 직접 붙여넣기/끌어놓기 가능):',
          'Enter the absolute file path on the remote server to attach (images can also be pasted/dropped directly):',
        );
        if (!path) return [];
        return remoteInvoke('choose_conversation_attachments', { paths: [path] });
      }
      return remoteInvoke(command, args);
    },
  };
}

installRemoteBridge();
