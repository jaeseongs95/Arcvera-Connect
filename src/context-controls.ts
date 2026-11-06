import { bindAttribute, onLanguageChange, t } from './i18n';
import './context-controls.css';

interface ContextStatus {
  connected: boolean;
  guiConnected: boolean;
  tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number | null };
  tokenUsageFresh: boolean;
  compacting: boolean;
  active: boolean | null;
  canCompact: boolean;
  passiveSubscriptionSupported?: boolean;
  subagentsSupported?: boolean;
  cronSupported?: boolean;
  compactSupported?: boolean;
  reason?: string;
  revision?: number;
}
interface Options {
  host: HTMLElement;
  statusHost: HTMLElement;
  sessionId: string;
  generation: number;
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  compact(): Promise<{ status?: string }>;
  notify(ko: string, error: boolean, en: string): void;
  capabilitiesChanged?(supported: { passiveSubscription: boolean; subagents: boolean; cron: boolean }): void;
}
interface SessionContextSettings {
  supported: boolean;
  canChange: boolean;
  modelContextWindow: number | null;
  effectiveContextWindow: number | null;
  status?: string;
}
function verifiedSettings(value: unknown): value is SessionContextSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as SessionContextSettings;
  const window = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  return settings.supported === true && settings.canChange === true && window(settings.modelContextWindow) && window(settings.effectiveContextWindow);
}

/** One small snapshot per visible card; observation never claims the GUI input lease. */
export function createContextControls(options: Options) {
  const { host } = options;
  host.innerHTML = '<button class="context-usage icon-button" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><circle class="context-track" cx="10" cy="10" r="7"/><circle class="context-fill" cx="10" cy="10" r="7" pathLength="100"/></svg><span>—</span></button><button class="context-compact icon-button" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 3l5 5M3 8h4V4M18 3l-5 5M13 4v4h4M2 17l5-5M3 12h4v4M18 17l-5-5M13 16v-4h4"/></svg></button>';
  const usage = host.querySelector<HTMLButtonElement>('.context-usage')!;
  const compact = host.querySelector<HTMLButtonElement>('.context-compact')!;
  const amount = usage.querySelector('span')!;
  const fill = usage.querySelector<SVGCircleElement>('.context-fill')!;
  let snapshot: ContextStatus | undefined;
  let visible = false; let disposed = false; let epoch = 0; let supportEpoch = 0;
  let reading = false; let busy = false;
  let settingsReading = false; let changing = false; let editorEpoch = 0;
  let editor: HTMLDialogElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = -1;
  const abort = new AbortController();
  const read = () => options.call<ContextStatus>('conversation_request', { id: options.sessionId, generation: options.generation, request: { type: 'contextStatus' } });
  const alive = (version: number) => !disposed && visible && epoch === version;
  const canAttempt = () => snapshot?.compactSupported === true && snapshot.canCompact === true;
  function publishCapabilities() {
    options.capabilitiesChanged?.({ passiveSubscription: snapshot?.passiveSubscriptionSupported === true, subagents: snapshot?.subagentsSupported === true, cron: snapshot?.cronSupported === true });
  }
  function invalidateCapabilities() {
    supportEpoch++;
    if (snapshot) snapshot = { ...snapshot, passiveSubscriptionSupported: false, subagentsSupported: false, cronSupported: false, compactSupported: false };
    publishCapabilities();
  }
  function accept(value: ContextStatus) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { invalidateCapabilities(); return; }
    if (typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0) {
      if (value.revision < revision) return;
      revision = value.revision;
    }
    snapshot = value;
    publishCapabilities();
  }
  function reason() {
    if (busy || snapshot?.compacting) return t('컨텍스트 압축 중 · 완료 확인 대기', 'Compacting context · waiting for confirmation');
    switch (snapshot?.reason) {
      case 'active': return t('작업 완료 후 컨텍스트를 압축할 수 있습니다.', 'Context can be compacted after the current task finishes.');
      case 'pendingRequest': return t('대기 중인 질문이나 승인을 먼저 처리하세요.', 'Resolve pending questions or approvals first.');
      case 'unsupported': return t('이 실행 환경은 안전한 수동 압축을 지원하지 않습니다.', 'This runtime does not support safe manual compaction.');
      case 'unknownResult': return t('이전 요청 결과를 확인할 때까지 압축하지 않습니다.', 'Compaction is blocked until the previous request is confirmed.');
      case 'deleted': return t('삭제된 대화는 압축할 수 없습니다.', 'A deleted conversation cannot be compacted.');
      case 'closing': return t('연결을 전환하거나 종료하는 중입니다.', 'The connection is switching or closing.');
      default: return snapshot?.canCompact ? t('컨텍스트 압축', 'Compact context') : t('연결과 작업 상태를 확인한 후 압축할 수 있습니다.', 'Compaction is available after connection and activity are confirmed.');
    }
  }
  function render() {
    options.statusHost.hidden = snapshot?.connected !== true || snapshot.compacting !== true;
    const status = t('압축 중', 'Compacting');
    if (options.statusHost.textContent !== status) options.statusHost.textContent = status;
    const used = snapshot?.tokenUsage?.last?.totalTokens;
    const capacity = snapshot?.tokenUsage?.modelContextWindow;
    const valid = typeof used === 'number' && Number.isSafeInteger(used) && used >= 0 && typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity > 0;
    const percent = valid ? Math.min(100, Math.max(0, Math.round(used / capacity * 100))) : undefined;
    const fresh = snapshot?.connected === true && snapshot.tokenUsageFresh === true;
    amount.textContent = percent === undefined || !fresh ? '—' : `${percent}%`;
    fill.style.strokeDasharray = `${percent ?? 0} 100`;
    host.classList.toggle('context-stale', !fresh);
    host.classList.toggle('context-compacting', busy || snapshot?.compacting === true);
    const ko = valid ? `컨텍스트 ${percent}% · 최근 모델 응답 사용량 ${used.toLocaleString('ko-KR')} / ${capacity.toLocaleString('ko-KR')} 토큰${fresh ? '' : ' · 마지막 확인값, 현재 사용량 미확인'} · 클릭하여 새로고침` : '컨텍스트 사용량 미확인 · 클릭하여 새로고침';
    const en = valid ? `Context ${percent}% · latest model response usage ${used.toLocaleString('en-US')} / ${capacity.toLocaleString('en-US')} tokens${fresh ? '' : ' · last known value, current usage unknown'} · click to refresh` : 'Context usage unknown · click to refresh';
    bindAttribute(usage, 'title', ko, en); bindAttribute(usage, 'aria-label', ko, en);
    compact.title = reason(); compact.setAttribute('aria-label', reason());
    usage.disabled = !visible || reading || settingsReading || changing;
    compact.hidden = snapshot?.compactSupported !== true;
    compact.disabled = !visible || busy || !canAttempt();
    compact.setAttribute('aria-busy', String(busy || snapshot?.compacting === true));
  }
  function schedule(delay = 2000) {
    clearTimeout(timer);
    if (!disposed && visible) timer = setTimeout(() => void refresh(), delay);
  }
  async function refresh() {
    if (disposed || !visible || reading) return;
    reading = true; const version = epoch; const supportVersion = supportEpoch; render();
    try {
      const value = await read();
      if (alive(version) && supportVersion === supportEpoch) accept(value);
    } catch {
      if (alive(version) && supportVersion === supportEpoch) { snapshot = { ...snapshot, connected: false, guiConnected: false, tokenUsageFresh: false, compacting: false, active: null, canCompact: false, reason: 'disconnected' }; invalidateCapabilities(); }
    } finally {
      reading = false;
      if (!disposed) { render(); schedule(version === epoch ? 2000 : 0); }
    }
  }
  async function startCompaction() {
    if (disposed || !visible || busy || !canAttempt()) return;
    busy = true; const version = epoch; render();
    try {
      const supportVersion = supportEpoch;
      const current = await read();
      if (!alive(version) || supportVersion !== supportEpoch) return;
      accept(current);
      if (snapshot?.compactSupported !== true || snapshot.canCompact !== true) {
        options.notify('현재 연결·작업 상태에서는 압축할 수 없습니다. 상태를 확인한 뒤 다시 시도하세요.', false, 'Compaction is unavailable in the current connection or activity state. Check the status before trying again.'); return;
      }
      const result = await options.compact();
      if (!alive(version)) return;
      if (result.status === 'started') options.notify('압축을 요청했습니다. 서버의 완료 확인을 기다립니다.', false, 'Compaction requested. Waiting for server confirmation.');
      else if (result.status === 'skippedBusy') options.notify('다른 작업이 시작되어 압축하지 않았습니다.', false, 'Another task started, so context was not compacted.');
      else options.notify('현재 상태에서는 압축을 시작하지 못했습니다. 연결과 대기 중인 요청을 확인하세요.', false, 'Compaction could not start. Check the connection and pending requests.');
    } catch {
      if (alive(version)) { invalidateCapabilities(); options.notify('압축 결과를 확인하지 못했습니다. 자동으로 다시 요청하지 않습니다.', true, 'The compaction result could not be confirmed. It will not be retried automatically.'); }
    } finally {
      busy = false;
      if (!disposed) { render(); schedule(0); }
    }
  }
  function closeEditor() { editorEpoch++; editor?.close(); editor?.remove(); editor = undefined; }
  async function openSettings() {
    if (disposed || !visible || settingsReading || changing) return;
    const version = epoch;
    await refresh();
    if (!alive(version) || settingsReading || changing) return;
    settingsReading = true; const editorVersion = ++editorEpoch; render();
    try {
      const value = await options.call<unknown>('conversation_request', { id: options.sessionId, generation: options.generation, request: { type: 'contextSettings' } });
      if (!alive(version) || editorVersion !== editorEpoch || !verifiedSettings(value)) return;
      closeEditor();
      let current = value; const dialogVersion = editorEpoch;
      const dialog = document.createElement('dialog'); editor = dialog; dialog.className = 'session-context-dialog';
      dialog.setAttribute('aria-label', t('세션 컨텍스트 크기', 'Session context size'));
      const heading = document.createElement('h3'); heading.textContent = t('세션 컨텍스트 크기', 'Session context size');
      const explanation = document.createElement('p'); explanation.textContent = t('이 세션의 다음 turn부터 적용됩니다. 모델의 지원 한도를 늘리지 않으며 전역 설정은 바꾸지 않습니다.', 'Applies to the next turn of this session. Does not increase the model limit or change global settings.');
      const summary = document.createElement('p'); summary.className = 'session-context-summary';
      const label = document.createElement('label'); label.textContent = t('요청 컨텍스트 크기 (토큰)', 'Requested context size (tokens)');
      const input = document.createElement('input'); input.id = `context-window-${crypto.randomUUID()}`; input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; label.htmlFor = input.id;
      const message = document.createElement('p'); message.setAttribute('role', 'status');
      const actions = document.createElement('div'); actions.className = 'session-context-actions';
      const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = t('적용', 'Apply');
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = t('기본값 복원', 'Restore default');
      const close = document.createElement('button'); close.type = 'button'; close.textContent = t('닫기', 'Close');
      function showCurrent() {
        const format = (n: number | null) => n === null ? t('기본값', 'Default') : n.toLocaleString(t('ko-KR', 'en-US'));
        summary.textContent = t(`요청값: ${format(current.modelContextWindow)} · 실효 예산: ${format(current.effectiveContextWindow)} 토큰`, `Requested: ${format(current.modelContextWindow)} · effective budget: ${format(current.effectiveContextWindow)} tokens`);
        input.value = current.modelContextWindow?.toString() ?? '';
      }
      async function change(value: number | null) {
        if (!alive(version) || dialogVersion !== editorEpoch || changing) return;
        changing = true; apply.disabled = true; reset.disabled = true; input.disabled = true; dialog.setAttribute('aria-busy', 'true'); render();
        message.textContent = t('적용 확인 대기 중입니다. 닫아도 이미 보낸 요청은 취소되지 않습니다.', 'Waiting for confirmation. Closing does not cancel an already submitted request.');
        try {
          const result = await options.call<unknown>('conversation_request', { id: options.sessionId, generation: options.generation, request: { type: 'setContextWindow', modelContextWindow: value, expectedModelContextWindow: current.modelContextWindow } });
          if (!alive(version) || dialogVersion !== editorEpoch) return;
          if (!verifiedSettings(result) || !['applied', 'conflict', 'rejected'].includes(result.status ?? '')) throw Error('unconfirmed');
          current = result; showCurrent();
          message.textContent = result.status === 'applied' ? t('서버가 적용을 확인했습니다. 이 세션의 다음 turn부터 사용합니다.', 'The server confirmed application for the next turn of this session.') : result.status === 'rejected' ? t('서버가 요청한 크기를 거절했습니다. 모델 지원 한도와 세션 정책에 맞는 값을 선택하세요.', 'The server rejected the requested size. Choose a value allowed by the model limit and session policy.') : t('다른 곳에서 설정이 바뀌어 전송하지 않았습니다. 현재 값을 확인하고 다시 선택하세요.', 'The setting changed elsewhere. No update was sent. Review the current value before choosing again.');
        } catch {
          if (alive(version) && dialogVersion === editorEpoch) { closeEditor(); options.notify('컨텍스트 변경 결과를 확인하지 못했습니다. 자동으로 다시 요청하지 않습니다. 아이콘을 눌러 서버 상태를 확인하세요.', true, 'The context change could not be confirmed. It will not be retried automatically. Click the icon to check the server state.'); }
        } finally {
          changing = false;
          if (editor === dialog) { apply.disabled = false; reset.disabled = false; input.disabled = false; dialog.setAttribute('aria-busy', 'false'); }
          if (!disposed) render();
        }
      }
      apply.addEventListener('click', () => {
        const value = input.value.trim(); const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) { message.textContent = t('양의 정수를 입력하세요.', 'Enter a positive integer.'); return; }
        void change(number);
      });
      reset.addEventListener('click', () => void change(null)); close.addEventListener('click', closeEditor);
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
      actions.append(apply, reset, close); dialog.append(heading, explanation, summary, label, input, message, actions); document.body.append(dialog); showCurrent(); dialog.showModal();
    } catch { /* An unconfirmed read offers no editing; the usage refresh remains available. */ }
    finally { settingsReading = false; if (!disposed) render(); }
  }
  usage.addEventListener('click', () => void openSettings(), { signal: abort.signal });
  compact.addEventListener('click', () => void startCompaction(), { signal: abort.signal });
  const unlanguage = onLanguageChange(render);
  render();
  return {
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value; epoch++; clearTimeout(timer); if (!visible) { closeEditor(); invalidateCapabilities(); } render();
      if (visible) void refresh();
    },
    dispose() { if (disposed) return; disposed = true; epoch++; visible = false; closeEditor(); clearTimeout(timer); abort.abort(); unlanguage(); snapshot = undefined; options.statusHost.hidden = true; options.statusHost.textContent = ''; host.replaceChildren(); },
  };
}
