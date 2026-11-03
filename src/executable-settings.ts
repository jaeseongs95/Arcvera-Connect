import { createRuntimeCompatibility } from './runtime-compatibility';
import { createRuntimeTransition } from './runtime-transition';
import { onLanguageChange, t } from './i18n';

interface CodexSettings {
  savedPath: string | null;
  resolvedPath: string | null;
  source: 'saved' | 'environment' | 'path' | 'unavailable';
  error: string | null;
  appServer: {
    savedPath: string | null;
    resolvedPath: string | null;
    source: 'saved' | 'sibling' | 'cli' | 'unavailable';
    error: string | null;
    kind: 'standalone' | 'cli';
  };
}

export function createExecutableSettings(call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>) {
  const dialog = document.createElement('dialog');
  dialog.id = 'codex-settings-dialog';
  dialog.setAttribute('aria-labelledby', 'codex-settings-title');
  dialog.innerHTML = `
    <div class="dialog-heading"><span class="eyebrow">EXECUTABLE</span><button id="codex-settings-close" class="icon-button" aria-label="설정 닫기">×</button></div>
    <h2 id="codex-settings-title">실행 파일 설정</h2>
    <p id="codex-settings-description">사용할 Codex 실행 파일을 선택하세요. 선택한 파일은 바로 저장됩니다.</p>
    <h3 id="codex-cli-heading">Codex CLI</h3>
    <label for="codex-executable-path">직접 지정한 파일</label>
    <input id="codex-executable-path" readonly placeholder="자동 찾기 사용 중"/>
    <dl class="executable-details"><dt id="codex-executable-resolved-label">적용 경로</dt><dd id="codex-executable-resolved"></dd><dt id="codex-executable-source-label">찾은 위치</dt><dd id="codex-executable-source"></dd></dl>
    <div class="dialog-actions"><button id="codex-executable-reset" class="quiet-button">자동 찾기로 변경</button><button id="codex-executable-choose" class="primary-button">실행 파일 선택…</button></div>
    <h3 id="app-server-heading">앱 서버</h3>
    <label for="app-server-executable-path">직접 지정한 서버 파일</label>
    <input id="app-server-executable-path" readonly placeholder="CLI에 맞춰 자동 선택"/>
    <dl class="executable-details"><dt id="app-server-resolved-label">서버 후보 경로</dt><dd id="app-server-executable-resolved"></dd><dt id="app-server-source-label">선택 방식</dt><dd id="app-server-executable-source"></dd><dt id="app-server-kind-label">파일 형식</dt><dd id="app-server-executable-kind"></dd></dl>
    <p id="app-server-discovery">자동 선택은 CLI와 같은 폴더의 짝 서버를 먼저 찾고, 없으면 CLI 내장 서버를 후보로 선택합니다.</p>
    <div class="dialog-actions"><button id="app-server-executable-reset" class="quiet-button">서버 자동 선택</button><button id="app-server-executable-choose" class="primary-button">서버 파일 선택…</button></div>
    <p class="executable-help"><span id="codex-settings-scope">새 세션과 세션 조회부터 적용됩니다. 이미 열린 세션은 계속 유지됩니다.</span><br><span id="codex-settings-discovery">자동 찾기는 환경변수, PATH 순서로 실행 파일을 찾습니다.</span></p>
    <div id="codex-settings-status" role="status" aria-live="polite"></div>
    <div id="codex-settings-error" class="inline-error" role="alert" hidden></div>
    `;
  const compatibility = createRuntimeCompatibility(call);
  const transition = createRuntimeTransition(call, updateBusy);
  dialog.querySelector('.executable-help')!.after(transition.element, compatibility.element);
  document.body.append(dialog);
  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const choose = $<HTMLButtonElement>('#codex-executable-choose');
  const reset = $<HTMLButtonElement>('#codex-executable-reset');
  const serverChoose = $<HTMLButtonElement>('#app-server-executable-choose');
  const serverReset = $<HTMLButtonElement>('#app-server-executable-reset');
  const serverPath = $<HTMLInputElement>('#app-server-executable-path');
  const status = $('#codex-settings-status');
  const error = $('#codex-settings-error');
  const path = $<HTMLInputElement>('#codex-executable-path');
  function text(element: HTMLElement, ko: string, en = ko) {
    element.dataset.ko = ko; element.dataset.en = en; element.textContent = t(ko, en);
  }
  let pathPlaceholder = () => t('자동 찾기 사용 중', 'Using automatic discovery');
  function placeholder(ko: string, en: string) {
    pathPlaceholder = () => t(ko, en); path.placeholder = pathPlaceholder();
  }
  for (const [selector, ko, en] of [
    ['.eyebrow', '실행 파일', 'EXECUTABLE'],
    ['#codex-settings-title', '실행 파일 설정', 'Executable settings'],
    ['#codex-settings-description', 'Codex CLI와 앱 서버를 선택하세요. 설정은 바로 저장되며 실행 중인 서버는 바뀌지 않습니다.', 'Choose the Codex CLI and app server. Settings are saved immediately; running servers remain unchanged.'],
    ['#codex-cli-heading', 'Codex CLI', 'Codex CLI'],
    ['#app-server-heading', '앱 서버', 'App server'],
    ['label[for="app-server-executable-path"]', '직접 지정한 서버 파일', 'Selected server file'],
    ['#app-server-resolved-label', '서버 후보 경로', 'Server candidate path'],
    ['#app-server-source-label', '선택 방식', 'Selection source'],
    ['#app-server-kind-label', '파일 형식', 'File type'],
    ['#app-server-discovery', '자동 선택은 CLI와 같은 폴더의 짝 서버를 먼저 찾고, 없으면 CLI 내장 서버를 후보로 선택합니다.', 'Automatic selection first finds a matching server beside the CLI, then selects the CLI’s built-in server as the candidate if none is found.'],
    ['#app-server-executable-reset', '서버 자동 선택', 'Use automatic server'],
    ['#app-server-executable-choose', '서버 파일 선택…', 'Choose server executable…'],
    ['label[for="codex-executable-path"]', '직접 지정한 파일', 'Selected file'],
    ['#codex-executable-resolved-label', '선택된 CLI 경로', 'Selected CLI path'],
    ['#codex-executable-source-label', '찾은 위치', 'Source'],
    ['#codex-settings-scope', '선택한 서버는 버전 확인과 패키지 전환에 사용합니다. 선택만 바꿔서는 열린 세션이나 공유 서버를 교체하지 않습니다. 실제 실행 버전은 아래 서버 버전 확인에서 확인하세요.', 'The server candidate is used for version checks and package transitions. Changing the selection alone does not replace open sessions or the shared server. Check the actual running version below.'],
    ['#codex-settings-discovery', '자동 찾기는 환경변수, PATH 순서로 실행 파일을 찾습니다.', 'Automatic discovery checks the environment variable, then PATH.'],
    ['#codex-executable-reset', '자동 찾기로 변경', 'Use automatic discovery'],
    ['#codex-executable-choose', '실행 파일 선택…', 'Choose executable…'],
  ]) text($(selector), ko, en);
  function refreshLabels() {
    for (const element of dialog.querySelectorAll<HTMLElement>('[data-ko]')) element.textContent = t(element.dataset.ko!, element.dataset.en!);
    $('#codex-settings-close').setAttribute('aria-label', t('설정 닫기', 'Close settings'));
    path.placeholder = pathPlaceholder();
    serverPath.placeholder = t('CLI에 맞춰 자동 선택', 'Select automatically for the CLI');
  }
  refreshLabels(); onLanguageChange(refreshLabels);
  let version = 0;
  let busy = false;
  let mutation: Promise<CodexSettings | null> | undefined;
  const current = (token: number) => dialog.open && version === token;
  function updateBusy() {
    const value = busy || transition.pending;
    for (const button of [choose, reset, serverChoose, serverReset]) button.disabled = value;
    dialog.setAttribute('aria-busy', String(value));
  }
  function setBusy(value: boolean, ko?: string, en = ko) {
    busy = value; transition.setBlocked(value); updateBusy();
    if (ko !== undefined) text(status, ko, en);
  }
  function showError(value: unknown) {
    error.textContent = value instanceof Error ? value.message : String(value); error.hidden = false;
  }
  function show(settings: CodexSettings) {
    compatibility.invalidate(); transition.invalidate();
    path.value = settings.savedPath ?? '';
    placeholder('자동 찾기 사용 중', 'Using automatic discovery');
    text($('#codex-executable-resolved'), settings.resolvedPath ?? '사용 가능한 실행 파일이 없습니다', settings.resolvedPath ?? 'No executable available');
    const source = { saved: ['직접 지정', 'Selected file'], environment: ['환경변수', 'Environment variable'], path: ['PATH 자동 찾기', 'PATH discovery'], unavailable: ['찾지 못함', 'Not found'] }[settings.source];
    text($('#codex-executable-source'), source[0], source[1]);
    const server = settings.appServer;
    serverPath.value = server?.savedPath ?? '';
    text($('#app-server-executable-resolved'), server?.resolvedPath ?? '미확인', server?.resolvedPath ?? 'Unknown');
    const serverSource = { saved: ['직접 지정', 'Selected file'], sibling: ['CLI와 같은 폴더의 짝 서버', 'Matching server beside the CLI'], cli: ['선택한 CLI의 app-server 명령', 'Selected CLI app-server command'], unavailable: ['찾지 못함', 'Not found'] }[server?.source ?? 'unavailable'];
    text($('#app-server-executable-source'), serverSource[0], serverSource[1]);
    const serverKind = !server?.resolvedPath ? ['미확인', 'Unknown'] : server.kind === 'standalone' ? ['독립 서버 실행 파일', 'Standalone server executable'] : ['CLI app-server 명령', 'CLI app-server command'];
    text($('#app-server-executable-kind'), serverKind[0], serverKind[1]);
    const errors = [settings.error, server?.error].filter(Boolean).join('\n');
    error.hidden = !errors; error.textContent = errors;
  }
  async function change(command: string, args?: Record<string, unknown>) {
    if (busy || transition.pending) return;
    transition.invalidate();
    const token = version;
    error.hidden = true;
    const choosing = command.startsWith('choose_');
    setBusy(true, choosing ? '파일 선택을 기다리는 중…' : '자동 찾기로 변경 중…', choosing ? 'Waiting for file selection…' : 'Switching to automatic discovery…');
    const operation = call<CodexSettings | null>(command, args);
    mutation = operation;
    try {
      const settings = await operation;
      if (current(token)) { if (settings) show(settings); text(status, settings ? '설정이 저장되었습니다.' : '파일 선택을 취소했습니다.', settings ? 'Settings saved.' : 'File selection canceled.'); }
    } catch (cause) { if (current(token)) { text(status, ''); showError(cause); } }
    finally { if (mutation === operation) mutation = undefined; if (current(token)) setBusy(false); }
  }
  choose.onclick = () => void change('choose_codex_executable');
  reset.onclick = () => void change('set_codex_executable', { path: null });
  serverChoose.onclick = () => void change('choose_app_server_executable');
  serverReset.onclick = () => void change('set_app_server_executable', { path: null });
  $('#codex-settings-close').onclick = () => dialog.close();
  dialog.onclose = () => { version++; compatibility.invalidate(); transition.invalidate(); };
  return {
    async open(options: { checkServer?: boolean } = {}) {
      if (dialog.open) return;
      const token = ++version;
      compatibility.invalidate(); transition.invalidate();
      path.value = ''; serverPath.value = '';
      for (const selector of ['#app-server-executable-resolved', '#app-server-executable-source', '#app-server-executable-kind']) text($(selector), '확인 중…', 'Checking…');
      placeholder('확인 중…', 'Checking…');
      text($('#codex-executable-resolved'), '확인 중…', 'Checking…');
      text($('#codex-executable-source'), '확인 중…', 'Checking…');
      error.hidden = true; setBusy(true, '현재 설정을 확인하는 중…', 'Checking current settings…');
      dialog.showModal(); $('#codex-settings-close').focus();
      let loaded = false;
      try {
        // A chooser may finish after the popup closes. Read back its persisted result on reopen.
        if (mutation) { try { await mutation; } catch { /* Read the unchanged saved setting after a rejected selection. */ } }
        await transition.whenIdle();
        if (!current(token)) return;
        const settings = await call<CodexSettings>('get_codex_settings');
        if (current(token)) { show(settings); text(status, ''); loaded = true; }
      } catch (cause) { if (current(token)) {
        placeholder('설정을 확인하지 못했습니다', 'Could not check settings');
        for (const selector of ['#app-server-executable-resolved', '#app-server-executable-source', '#app-server-executable-kind']) text($(selector), '미확인', 'Unknown');
        text($('#codex-executable-resolved'), '확인하지 못했습니다', 'Could not verify');
        text($('#codex-executable-source'), '확인하지 못함', 'Unknown');
        text(status, ''); showError(cause);
      } }
      finally { if (current(token)) setBusy(false); }
      if (current(token) && loaded && options.checkServer) {
        transition.check();
        transition.element.scrollIntoView({ block: 'start' });
      }
    },
  };
}
