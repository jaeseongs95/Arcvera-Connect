import { onLanguageChange, t } from './i18n';

type Report = {
  executable: string; cliVersion: string | null; serverVersion: string | null;
  selectedServerExecutable?: string | null; selectedServerVersion?: string | null;
  serverState: 'running' | 'unsupported' | 'unavailable';
  subagents: boolean | null; compactIfIdle: boolean | null; expectedTurnInterrupt: boolean | null;
};

export function createRuntimeCompatibility(call: <T>(command: string) => Promise<T>) {
  const element = document.createElement('section');
  element.className = 'runtime-compatibility';
  element.innerHTML = '<h3></h3><p class="compatibility-help"></p><button class="compatibility-refresh quiet-button" type="button"></button><p class="compatibility-status" role="status"></p><dl class="executable-details compatibility-details" hidden></dl><p class="compatibility-scope"></p>';
  const refresh = element.querySelector<HTMLButtonElement>('button')!;
  const status = element.querySelector<HTMLElement>('.compatibility-status')!;
  const details = element.querySelector<HTMLElement>('dl')!;
  let report: Report | undefined;
  let generation = 0;
  let pending: Promise<unknown> | undefined;
  let state: 'empty' | 'loading' | 'ready' | 'failed' = 'empty';
  const label = (value: boolean | null) => value === true ? t('지원됨', 'Supported') : value === false ? t('지원되지 않음', 'Not supported') : t('미확인', 'Unknown');
  function render() {
    element.querySelector('h3')!.textContent = t('실행 기반 호환성', 'Runtime compatibility');
    element.querySelector('.compatibility-help')!.textContent = t('선택한 명령줄 실행 파일과 서버 정보를 구분합니다. 서버 버전은 기존 연결이 받은 보고값이며 현재 실행 상태를 다시 확인한 값이 아닙니다. 파일을 바꿔도 실행 중인 서버는 바뀌지 않습니다.', 'Separate the selected CLI from server information. Server versions come from existing connections and do not recheck the currently running server. Choosing a file does not replace a running server.');
    element.querySelector('.compatibility-scope')!.textContent = t('버전이 같아도 출처·파일 해시·실행 세대를 확인하기 전에는 같은 패키지로 확정하지 않습니다. 이 조회는 서버에 새로 연결하지 않습니다. 현재 실행 정보와 다음 시작 선택값을 안전하게 확인할 수 없으면 미확인으로 표시합니다. 기능 지원과 보고 버전은 같은 실행 파일·소켓의 기존 세션이 이미 받은 정보만 사용하며 현재 연결 성공을 보장하지 않습니다. 각 기능에서 연결·권한·작업 상태를 추가 확인합니다.', 'Matching versions do not confirm the same package until source, file hash and execution generation are verified. This check opens no new server connection. Current execution details and next-start selection remain unknown when they cannot be checked safely. Support and reported versions use information already received by existing sessions with the same executable and socket, without confirming current connectivity. Each feature also checks connection, permissions and task state.');
    refresh.textContent = t('호환성 확인', 'Check compatibility'); refresh.disabled = !!pending;
    status.textContent = state === 'loading' ? t('확인 중…', 'Checking…') : state === 'failed' ? t('호환성을 확인하지 못했습니다. 실행 파일과 서버 상태를 확인한 뒤 다시 조회하세요.', 'Could not check compatibility. Check the executable and server status, then retry.') : state === 'empty' ? t('호환성 확인을 눌러 현재 상태를 조회하세요.', 'Check compatibility to read the current state.') : report?.serverState === 'running' ? t('서버가 보고한 정보를 표시합니다. 현재 실행 상태는 다시 확인하지 않았습니다.', 'Showing server-reported information without rechecking current execution.') : report?.serverState === 'unsupported' ? t('선택한 실행 파일에 공유서버 조회 기능이 없습니다. 개별 세션의 지원 여부를 확인하세요.', 'The selected executable has no shared-server query support. Check support in each session.') : t('공유서버 연결을 확인하지 못했습니다. 추가 연결 없이 기존 관측 정보만 표시하며, 확인되지 않은 값은 미확인입니다.', 'The shared server connection has not been confirmed. Only existing observations are shown without a new connection; other values remain unknown.');
    details.replaceChildren(); details.hidden = !report;
    if (!report) return;
    for (const [title, value] of [
      [t('선택한 명령줄 실행 파일', 'Selected CLI executable'), report.executable],
      [t('선택한 명령줄 버전', 'Selected CLI version'), report.cliVersion ?? t('미확인', 'Unknown')],
      [t('서버 후보 실행 파일', 'Server candidate executable'), report.selectedServerExecutable ?? t('미확인', 'Unknown')],
      [t('서버 후보 버전', 'Server candidate version'), report.selectedServerVersion ?? t('미확인', 'Unknown')],
      [t('실제 실행 중인 서버 실행 파일', 'Actually running server executable'), t('미확인', 'Unknown')],
      [t('기존 연결에서 보고한 서버 버전', 'Server version reported by existing connections'), report.serverVersion ?? t('미확인', 'Unknown')],
      [t('서브에이전트 관리', 'Subagent management'), label(report.subagents)],
      [t('안전한 유휴 압축', 'Safe idle compaction'), label(report.compactIfIdle)],
      [t('지정 작업만 중단', 'Interrupt exact turn'), label(report.expectedTurnInterrupt)],
    ]) { const dt = document.createElement('dt'); dt.textContent = title; const dd = document.createElement('dd'); dd.textContent = value; details.append(dt, dd); }
  }
  refresh.onclick = () => {
    if (pending) return;
    const token = generation;
    report = undefined; state = 'loading';
    const operation = call<Report>('runtime_compatibility'); pending = operation; render();
    void operation.then(value => {
      if (generation !== token || !element.closest('dialog')?.open) return;
      if (!value || typeof value.executable !== 'string' || !['running','unsupported','unavailable'].includes(value.serverState)
        || [value.cliVersion,value.serverVersion].some(item => item !== null && (typeof item !== 'string' || item.length > 1024))
        || [value.selectedServerExecutable,value.selectedServerVersion].some(item => item != null && (typeof item !== 'string' || item.length > 1024))
        || [value.subagents,value.compactIfIdle,value.expectedTurnInterrupt].some(item => item !== null && typeof item !== 'boolean')) throw new Error('Invalid compatibility response');
      report = value; state = 'ready';
    }).catch(() => { if (generation === token) state = 'failed'; })
      .finally(() => { if (pending === operation) pending = undefined; render(); });
  };
  onLanguageChange(render); render();
  return { element, invalidate() { generation++; report = undefined; state = 'empty'; render(); } };
}
