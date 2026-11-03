import { onLanguageChange, t } from './i18n';

type Preview = {
  pair: {
    cliVersion: string | null; selectedServerExecutable: string | null; selectedServerVersion: string | null;
    managedCliExecutable: string | null; managedVersion: string | null; runningVersion: string | null;
    socketPath: string | null; state: 'matched' | 'mismatch' | 'stopped' | 'embedded' | 'unconfirmed' | 'unavailable'; message: string | null;
  };
  canApply: boolean; reason: string | null; fingerprint: string; packageRoot: string | null;
};
type Result = { status: string; success: boolean; outcome: 'updated' | 'failed' | 'unknown'; message: string | null };

export function runtimeTransitionSucceeded(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Partial<Result>;
  return reply.status === 'updated' && reply.success === true && reply.outcome === 'updated'
    && (reply.message === null || typeof reply.message === 'string' && reply.message.length <= 8192);
}

export function createRuntimeTransition(call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>, onPendingChange: () => void) {
  const element = document.createElement('section');
  element.className = 'runtime-transition';
  element.setAttribute('aria-labelledby', 'runtime-transition-title');
  element.innerHTML = `<h3 id="runtime-transition-title"></h3><p class="transition-help"></p>
    <div class="dialog-actions"><button class="transition-preview quiet-button" type="button"></button><button class="transition-align primary-button" type="button" hidden></button></div>
    <p class="transition-status" role="status" aria-live="polite"></p>
    <dl class="executable-details transition-details" hidden></dl><p class="transition-reason"></p>
    <section class="transition-confirmation" role="group" aria-labelledby="runtime-transition-confirm-title" hidden>
      <h4 id="runtime-transition-confirm-title"></h4><p class="transition-warning"></p>
      <label><input class="transition-acknowledge" type="checkbox" style="width:auto"><span class="transition-acknowledge-label"></span></label>
      <div class="dialog-actions"><button class="transition-cancel quiet-button" type="button"></button><button class="transition-apply primary-button" type="button"></button></div>
    </section>`;
  const $ = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!;
  const refresh = $<HTMLButtonElement>('.transition-preview');
  const align = $<HTMLButtonElement>('.transition-align');
  const apply = $<HTMLButtonElement>('.transition-apply');
  const cancel = $<HTMLButtonElement>('.transition-cancel');
  const acknowledge = $<HTMLInputElement>('.transition-acknowledge');
  const details = $('.transition-details');
  let preview: Preview | undefined;
  let generation = 0;
  let pending: Promise<void> | undefined;
  let pendingKind: 'preview' | 'apply' | undefined;
  let blocked = false;
  let confirming = false;
  let state: 'empty' | 'loading' | 'ready' | 'applying' | 'updated' | 'failed' | 'unknown' = 'empty';
  let message = '';
  const current = (token: number) => generation === token && element.closest('dialog')?.open;
  const canApply = () => state === 'ready' && !!preview && ['mismatch', 'stopped'].includes(preview.pair.state) && preview.canApply;
  const nullableText = (value: unknown) => value === null || typeof value === 'string' && value.length <= 8192;
  function render() {
    $('#runtime-transition-title').textContent = t('공유 서버 버전 전환', 'Shared server version transition');
    $('.transition-help').textContent = t('서버 버전은 버튼을 눌러 확인합니다. 버전이 다르면 작업을 자동 복원하지 않으며, 모든 작업이 끝난 뒤 확인을 받아 전환합니다.', 'Check server versions explicitly. If versions differ, saved work is not restored automatically. Transition only after all work has finished and you confirm.');
    refresh.textContent = t('서버 버전 확인', 'Check server versions');
    align.textContent = t('버전 맞추기…', 'Align server version…');
    refresh.disabled = blocked || !!pending;
    align.hidden = !preview || !['mismatch', 'stopped'].includes(preview.pair.state);
    align.disabled = blocked || !!pending || !canApply();
    $('.transition-confirmation').hidden = !confirming;
    $('#runtime-transition-confirm-title').textContent = t('작업 종료 후 서버 전환 확인', 'Confirm server transition after work finishes');
    $('.transition-warning').textContent = t('선택한 서버가 포함된 전체 패키지를 공유 서버에 적용합니다. 선택한 서버 파일 경로와 실제 관리 CLI 실행 경로는 다를 수 있습니다. 다른 Codex 창과 모바일의 공유 연결은 전환 후 다시 연결해야 합니다. 서버 종료·전환 요청을 보낸 뒤에는 취소할 수 없으며, 응답이 끊기면 결과가 미확인일 수 있습니다.', 'The full package containing the selected server is applied to the shared server. The selected server file path can differ from the actual managed CLI launch path. Other Codex windows and mobile shared connections must reconnect after the transition. Once the server shutdown and transition request is sent, it cannot be canceled; a lost response can leave the result unknown.');
    $('.transition-acknowledge-label').textContent = t('다른 Codex 창과 모바일의 작업이 모두 끝났으며, 전환이 끝날 때까지 새 작업을 시작하지 않겠습니다.', 'All work in other Codex windows and on mobile has finished, and I will not start new work until the transition finishes.');
    cancel.textContent = t('돌아가기', 'Go back');
    apply.textContent = t('확인하고 서버 전환', 'Confirm and transition server');
    acknowledge.disabled = blocked || !!pending;
    cancel.disabled = blocked || !!pending;
    apply.disabled = blocked || !!pending || !canApply() || !acknowledge.checked;
    const status = pending ? pendingKind === 'apply' ? t('서버 전환과 새 버전 연결을 확인하는 중… 요청은 취소할 수 없습니다.', 'Transitioning and checking the new server connection… The request cannot be canceled.') : t('서버 버전을 확인하는 중…', 'Checking server versions…')
      : state === 'ready' ? preview?.pair.state === 'matched' ? t('현재 서버와 선택한 버전이 일치합니다.', 'The current server matches the selected version.') : preview?.pair.state === 'embedded' ? t('이 CLI는 내장된 개별 서버를 사용합니다.', 'This CLI uses its built-in per-session server.') : preview?.pair.state === 'stopped' ? t('서버가 꺼져 있음', 'Server is stopped') : preview?.pair.state === 'mismatch' ? t('현재 서버와 선택한 버전이 다릅니다. 작업 종료 후 확인이 필요합니다.', 'The current server differs from the selected version. Confirm after work finishes.') : preview?.pair.state === 'unconfirmed' ? t('현재 서버 연결 상태를 확인하지 못했습니다. 서버 버전을 다시 확인하세요.', 'The current server connection could not be confirmed. Check server versions again.') : t('현재 서버 버전을 확인하지 못했습니다.', 'The current server version could not be verified.')
      : state === 'updated' ? t('서버 전환과 새 버전 연결 검사가 완료되었습니다.', 'Server transition and the new version connection check are complete.')
      : state === 'failed' ? t('서버 버전 확인 또는 전환에 실패했습니다. 현재 상태는 미확인입니다. 다시 조회하세요.', 'Server version checking or transition failed. The current state is unknown. Check again.')
      : state === 'unknown' ? t('서버 전환 결과가 미확인입니다. 성공으로 간주하지 않으며 자동으로 다시 시도하지 않습니다. 현재 버전을 다시 조회하세요.', 'The server transition result is unknown. It is not treated as success and will not be retried automatically. Check the current versions again.')
      : t('서버 버전 확인을 눌러 현재 서버와 선택한 버전을 확인하세요.', 'Check server versions to compare the current server with your selection.');
    $('.transition-status').textContent = status;
    $('.transition-reason').textContent = message || (preview && !preview.canApply && preview.pair.state !== 'matched' ? t('현재는 안전한 서버 전환을 실행할 수 없습니다.', 'A safe server transition is currently unavailable.') : '');
    details.replaceChildren(); details.hidden = state === 'empty' || state === 'loading';
    if (!details.hidden) for (const [title, value] of [
      [t('선택한 CLI 버전', 'Selected CLI version'), preview?.pair.cliVersion],
      [t('선택한 서버 실행 파일', 'Selected server executable'), preview?.pair.selectedServerExecutable],
      [t('선택한 서버 버전', 'Selected server version'), preview?.pair.selectedServerVersion],
      [t('공유 서버 관리 CLI 실행 파일', 'Managed server CLI executable'), preview?.pair.managedCliExecutable],
      [t('공유 서버 관리 버전', 'Managed server version'), preview?.pair.managedVersion],
      [t('연결 확인된 현재 서버 버전', 'Verified current server version'), state === 'applying' ? null : preview?.pair.runningVersion],
    ]) { const dt = document.createElement('dt'); dt.textContent = title!; const dd = document.createElement('dd'); dd.textContent = value ?? t('미확인', 'Unknown'); details.append(dt, dd); }
  }
  function execute<T>(kind: 'preview' | 'apply', command: string, args: Record<string, unknown> | undefined, accept: (value: T) => void) {
    const token = generation;
    const operation = Promise.resolve().then(() => call<T>(command, args)).then(value => {
      if (current(token)) accept(value);
    }).catch(cause => {
      if (!current(token)) return;
      preview = undefined; state = kind === 'apply' ? 'unknown' : 'failed';
      message = cause instanceof Error ? cause.message : String(cause);
    });
    pending = operation; pendingKind = kind; render(); onPendingChange();
    void operation.finally(() => { if (pending === operation) { pending = undefined; pendingKind = undefined; } render(); onPendingChange(); });
  }
  function check() {
    if (blocked || pending) return;
    confirming = false; acknowledge.checked = false; preview = undefined; message = ''; state = 'loading';
    execute<Preview>('preview', 'runtime_transition_preview', undefined, value => {
      if (!value?.pair || !['matched', 'mismatch', 'stopped', 'embedded', 'unconfirmed', 'unavailable'].includes(value.pair.state) || typeof value.canApply !== 'boolean'
        || typeof value.fingerprint !== 'string' || value.canApply && !value.fingerprint.trim() || value.fingerprint.length > 8192
        || ![value.reason, value.packageRoot, value.pair.cliVersion, value.pair.selectedServerExecutable, value.pair.selectedServerVersion, value.pair.managedCliExecutable, value.pair.managedVersion, value.pair.runningVersion, value.pair.socketPath, value.pair.message].every(nullableText)) throw new Error(t('서버 버전 응답 형식이 올바르지 않습니다.', 'Invalid server version response.'));
      preview = value; state = 'ready'; message = [...new Set([value.reason, value.pair.message].filter(Boolean))].join('\n');
    });
  }
  refresh.onclick = check;
  align.onclick = () => {
    if (blocked || pending || !canApply()) return;
    confirming = true; acknowledge.checked = false; render(); acknowledge.focus();
  };
  cancel.onclick = () => { if (blocked || pending) return; confirming = false; acknowledge.checked = false; render(); align.focus(); };
  acknowledge.onchange = render;
  apply.onclick = () => {
    if (blocked || pending || !confirming || !acknowledge.checked || !canApply()) return;
    const fingerprint = preview!.fingerprint;
    confirming = false; acknowledge.checked = false; message = ''; state = 'applying';
    execute<Result>('apply', 'apply_runtime_transition', { confirmed: true, fingerprint }, value => {
      preview = undefined;
      if (!value || typeof value.status !== 'string' || typeof value.success !== 'boolean' || !['updated', 'failed', 'unknown'].includes(value.outcome) || !nullableText(value.message)) throw new Error(t('서버 전환 응답을 확인하지 못했습니다.', 'Could not verify the server transition response.'));
      state = runtimeTransitionSucceeded(value) ? 'updated' : !value.success && value.outcome === 'failed' ? 'failed' : 'unknown';
      message = value.message ?? '';
    });
  };
  onLanguageChange(render); render();
  return {
    element,
    check,
    get pending() { return !!pending; },
    async whenIdle() { await pending; },
    setBlocked(value: boolean) { blocked = value; render(); },
    invalidate() { generation++; preview = undefined; confirming = false; acknowledge.checked = false; message = ''; state = 'empty'; render(); },
  };
}
