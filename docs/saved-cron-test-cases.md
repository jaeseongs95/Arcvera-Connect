# Desktop 예약 정의 저장과 수동 재등록 시험 계획

대상: `feat/desktop-1.3.0-saved-cron`, 기존 CLI lifetime 예약 API를 유지한다.
경계: 운영 CLI/daemon/사용자 대화·인증에는 접근하지 않는다. SQLite 임시 DB와 Playwright 합성 fixture만 사용한다. 실제 실행 파일 빌드·CLI 연결 검증은 통합 담당에게 인계한다.

설계: 기존 `Store`의 앱 전용 SQLite `app_settings`에 예약 정의를 개별 JSON 값으로 원자 저장한다. 전체 prompt, schedule, 원래 threadId를 보존한다. 실행은 기존 `cron_request`로만 전달한다. 자동 등록·별도 실행기·OS 예약은 추가하지 않는다. CLI 목록은 `promptPreview`만 제공하므로 원문 가져오기를 지원하지 않는다.

필수 불변조건: 저장 완료 전에 등록을 보내지 않는다. 등록 전에 pending receipt를 영속화한다. 현재 sessionId/generation/threadId가 일치해야 등록한다. 같은 살아 있는 CLI에 이미 등록됐거나 결과 불명인 정의는 다시 보내지 않는다. 목록 새로고침은 기존 requestId reconcile만 사용한다. 원문·미리보기로 job을 추정 연결하지 않는다. 정의 삭제와 CLI 예약 삭제는 서로 전파하지 않는다.

| ID | 입력·사전조건 | 절차 | 기대 결과·합격 기준 | 수준·실제 결과 |
| --- | --- | --- | --- | --- |
| SAVE-01 | 새 임시 SQLite, 여러 줄·공백 포함 64 KiB 이내 원문과 반복 일정 | 저장, Store 닫기, 다시 열기, 목록 조회 | 원문·일정·threadId·식별자 정확 보존, 다른 app_settings 유지 | Rust 실DB / NOT_RUN |
| SAVE-02 | 저장된 정의, 무효 prompt/UUID/일정 또는 상한 초과 | 저장·수정 시도 | 오류, 기존 정의 유지, 등록 무전송 | Rust 실DB + DOM / NOT_RUN |
| SAVE-03 | 저장된 정의, CLI 종료 또는 미지원 | 창 열기, 정의 조회·수정·삭제 | 저장 기능 사용 가능, CLI 등록 불가, runtime 작업 변경 없음 | DOM / NOT_RUN |
| SAVE-04 | 같은 threadId의 새 session/generation, 미래 일정 | 정의의 수동 등록 클릭 | 저장 원문·일정으로 원래 대화에 한 번만 add, 자동 등록 없음 | Rust admission + DOM / NOT_RUN |
| SAVE-05 | 같은 정의에 진행·완료 receipt, 살아 있는 같은 CLI | 재클릭, 창 재개방, pending 복원 | 중복 add 없음; known job 삭제/누락이 정확히 확인되기 전 차단 | Rust 실DB/state + DOM / NOT_RUN |
| SAVE-06 | add 결과 unknown/throw/timeout | 새로고침, 재등록 시도 | 자동 재전송 없음, pending 보존, 기존 list reconcile 사용, 불명 결과를 성공으로 표시하지 않음 | Rust state + DOM / NOT_RUN |
| SAVE-07 | 다른 threadId 또는 stale session generation | 저장정의 등록 요청 | CLI 호출 전 거부, 저장정의·연결 대상 보존 | Rust admission + DOM / NOT_RUN |
| SAVE-08 | 만료된 일시 정의 | 수동 등록, 양식에서 새 미래시각 저장 후 등록 | 지난 시각 무전송, 변경된 미래시각에만 등록 | Rust state + DOM / NOT_RUN |
| SAVE-09 | CLI 목록만 존재(promptPreview만 포함) | 목록 확인, 삭제·pause·cancel 실행 | 원문 저장/가져오기 추정 없음, 기존 CLI 제어 요청 보존 | 기존 cron-manager 회귀 / NOT_RUN |
| SAVE-10 | 저장정의와 runtime 예약 둘 다 존재 | 정의 삭제, 별도로 runtime remove | 정의 삭제는 runtime remove 무전송, runtime remove는 정의 유지 | Rust 실DB + DOM / NOT_RUN |
| SAVE-11 | 저장 정의가 있는 열린 팝업, 같은 대화의 새 session/generation | 이전 팝업의 실제 close 이벤트 수신 Promise를 준비하고 닫기·재열기를 같은 open 호출로 실행, 실제 이전 close 전달까지 기다림 | 새 세션 제목·정의·입력 활성 상태 보존, 명시적 등록은 새 session/generation으로 정확히 1회, 이후 정상 닫기는 상태 정리 | 실제 DOM 이벤트 + 합성 IPC / NOT_RUN |

판정은 명령 종료 코드와 assertion 결과를 따로 기록한다. 위 mock DOM 시험은 실제 pipe/CLI 실행·OS 재시작 내구성 검증을 대신하지 않는다. 새 기능의 pre-change red는 미구현 IPC/저장 UI에 대해 신규 사례로 확인하며, 사용자 작업 트리를 reset하지 않는다.

## 실행 결과 (2026-11-06)

- `npm ci --ignore-scripts`: 종료 0. 새 의존성 추가 없음.
- `npx tsc --noEmit`: 종료 0. `npm test`: 종료 0, 기존 모델 시험 9/9 PASS. `git diff --check`: 종료 0.
- `PLAYWRIGHT_CHANNEL=msedge`, `npx playwright test tests/cron-manager.spec.ts tests/saved-cron.spec.ts tests/conversation-capabilities.spec.ts --reporter=line`: 두 번째 실행 종료 0, 43/43 PASS(기존 cron 20, 신규 저장 6, capability 17). 원시 산출물 `artifacts/saved-cron-green-02`.
- 첫 실행은 42 PASS/1 FAIL. 오류 주입 fixture가 등록 응답 throw에도 `registered`로 저장해 기존 unknown 표시 assertion이 실패했다. 실제 Rust의 throw→Unknown과 맞게 fixture를 수정했다. 실패 trace는 `artifacts/saved-cron-first-failure/test-results`에 보존한다. 이 실패를 제품 결함의 red로 집계하지 않는다.
- SAVE-01,02,04,05,06,07,08,10의 실제 SQLite/Engine 경계 시험은 `saved_cron.rs` 2개 및 `session_saved_cron.rs` 3개에 작성했다. 로컬 대형 cargo 빌드 금지에 따라 **NOT_RUN**, 통합 CI가 컴파일·실행해야 한다. 위 43 PASS에 Rust 시험을 포함하지 않는다.
- SAVE-01의 DOM manager 교체 복원, SAVE-03/04/05/06/07/08/10의 합성 IPC 사용자 흐름은 신규 6개에서 PASS. SAVE-09의 기존 CLI 제어·미리보기·실패·숨김·초점·초안 회귀는 기존 cron 20개에서 PASS. 실제 Windows 실행 파일과 CLI pipe·프로세스 재시작·OS crash 내구성은 NOT_RUN.

민감도 확인: 기준 `1da47c00975f215fc6a486740164464933da6007`의 `src/cron-manager.ts`만 `artifacts/saved-cron-red` 격리 사본에 복원했다. `npx playwright test tests/saved-cron.spec.ts -g '종료된 CLI에서도' --timeout=10000 --reporter=line`은 이전 구현에서 종료 1(종료된 CLI에서 `.cron-prompt`가 disabled여서 저장 불가), 현재 구현에서 종료 0(1 PASS)였다. 원시 산출물은 각각 `artifacts/saved-cron-red-result`, `artifacts/saved-cron-green-red-pair`. 두 실행의 테스트 SHA-256은 `6fdbc1167263d32ebfefce5481067fe62c31a24234f0cfdc015db723fff0d637`, 설정 SHA-256은 `19f2151040efaba5230dd46f1667fb34bf2064fa1ef4eed562aaa8d3577c1138`로 일치했다. 이 red/green은 저장 UI의 요구 차이를 탐지하며 Rust 저장 내구성의 실행 근거를 대신하지 않는다.

CS 조건 연결: DB-BOUNDARY-001(정의·receipt의 단일 SQLite 커밋, 실제 DB 실패 보존 시험), DIST-ACK-001(등록 적용·거절·결과 불명 분리), DIST-IDEMPOTENCY-002(등록 전 durable requestId, 동일 살아 있는 CLI의 중복 차단), DIST-ORDER-004(session/generation/threadId 및 늦은 응답 격리)를 구현에 반영했다. DOM 검증은 위 PASS, 실제 저장·등록 경계는 Rust 시험 NOT_RUN이므로 최종 CS 충족·독립 감사·릴리스 판정은 통합 담당에게 남긴다.

## 통합 후 팝업 close 경합 회귀 (2026-11-06)

기준 후보 `e5bffbb95db1786a33053e9a92873ad5d528f8d4`. 통합 담당의 110개 시험 결과 중 저장 정의의 같은 대화/새 CLI 사례가 실패했다. 전달된 `D:/codex/build/odDesktop130-test-results/integrated.log`에서 109 PASS/1 FAIL 및 해당 등록 버튼을 찾지 못한 원문을 직접 확인했다. 기존 로그·error-context·trace는 변경하지 않았다.

SAVE-11은 이미 열린 팝업에서 `open(newSession)`을 호출하고 이전 팝업의 **실제** `close` 이벤트 전달을 Promise로 기다려, 이전 close가 새 팝업보다 늦게 도착하는 순서를 고정한다. `npx playwright test tests/saved-cron.spec.ts -g '이전 팝업의 늦은 실제 close' --reporter=line`은 수정 전 종료 1(새 팝업은 열렸으나 `.cron-session`이 빈 문자열), 수정 후 종료 0(1 PASS)였다. 원시 결과는 `artifacts/saved-cron-close-red`, `artifacts/saved-cron-close-green`에 보존했다. 두 실행의 테스트 SHA-256은 `2a6b9433987e13462316b9f212082ba6e6749dca517fde4a6def8478146c4ffe`로 동일하며 시간 제한을 늘리지 않았다.

수정은 팝업이 이미 다시 열렸을 때 이전 close의 `clear()`를 건너뛰는 가드다. SAVE-11은 새 제목·정의·입력 상태, 자동 등록 없음, 새 session/generation으로 수동 등록 1회, 이후 정상 닫기의 상태 정리까지 확인한다. 기존 같은 대화/새 CLI 사례도 유지한다. `npx tsc --noEmit`와 `git diff --check`는 종료 0이다.

수정 후 `PLAYWRIGHT_CHANNEL=msedge`, `npx playwright test tests/cron-manager.spec.ts tests/saved-cron.spec.ts tests/conversation-capabilities.spec.ts --reporter=line`은 종료 0, **44/44 PASS**(기존 cron 20, 저장 7, capability 17)였다. 새 SAVE-11과 기존 같은 대화/새 CLI 사례 모두 PASS이며 원시 산출물은 `artifacts/saved-cron-close-regression`에 보존했다. 이번 수정에서 Rust·운영 CLI·설치·배포는 실행하지 않았다.
