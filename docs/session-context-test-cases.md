# 세션별 컨텍스트 크기 조절 사전 테스트케이스

대상: `feat/hooks-and-session-context`. 전역 설정이 아니라 클릭한 해당 세션만 대상으로 한다.
정확한 get/set/capability 및 적용 시점은 CLI 담당자가 확인한 계약과 실제 스키마를 먼저 대조한다. 아직 확인되지 않은 메서드를 fixture에 가정해 성공으로 만들지 않는다.

| ID | 입력·사전조건 | 기대 결과·통과 기준 |
| --- | --- | --- |
| CTX01 | 지원되는 세션의 사용량 아이콘 클릭 | 해당 세션의 실제 현재 값·지원 한도·적용 시점을 표시하는 조절 UI |
| CTX02 | 세션 A에서 크기 변경, 세션 B와 새 세션 기본값 관측 | A의 동일 session id/generation 및 thread에만 적용. 전역 config/B/새 대화 기본값 불변 |
| CTX03 | 미지원 공식/확장 CLI 또는 미확인 capability | 조절 기능 숨김. 사용량 표시·새로고침·기본 대화/세션 기능 유지. CLI 이름이나 버전만으로 지원 추정하지 않음 |
| CTX04 | 음수·빈 값·소수·범위 밖·취소 | 서버 한도와 동일한 검증, 취소 시 변경 없음 |
| CTX05 | 세션 닫기·재시작·다른 카드/프로젝트 전환 중 지연 응답 | 다른 세션이나 세대로 적용되지 않고 오래된 응답을 버림 |
| CTX06 | busy/대기 질문/연결 끊김·적용 결과 불명 | 확인된 계약의 적용 시점을 지키고 실패를 성공으로 표시하지 않음. 자동 재전송 없음 |
| CTX07 | 공식 CLI와 지원 확장 CLI의 실제 자체 fixture | 지원 계약에 맞는 실제 read/write/read-back 또는 미지원 보존을 검증. 사용자 전역 설정·운영 서비스 불변 |
| CTX-INIT-01 | 새 context 연결의 `initialize.params.capabilities.experimentalApi`가 boolean `true`가 아니면 settings 조회를 R37과 같은 `-32600`으로 거부하는 native WebSocket fixture. 기존 exchange에 `ContextSettings` 입력 | initialize → initialized → 해당 thread의 크기 필드 생략 조회를 관측한다. 명시 ACK의 요청값 null·실효값 258400과 supported/canChange=true를 반환하고 추가 요청은 없어야 통과. 같은 신규 시험을 수정 전 제품에 적용하면 capability 오류로 실패해야 한다. 실제 RED/GREEN은 로컬 Cargo 부재로 NOT_RUN이며 root CI 실행이 필요하다. |

이 문서는 후속 실행의 사전 기준이며 구현 API의 존재를 주장하지 않는다. 서버 적용·클라이언트 표시·다음 turn 반영·복원 시 유지 여부는 실제 계약과 관측을 구분한다.

## 확인한 계약과 검증 연결

- 실제 R36 생성 스키마: `D:/codex/build/odHooksSchema/r36/schema/v2/ThreadSettingsUpdate{Params,Response}.json`. 조회는 `thread/settings/update({threadId})`이며 크기 필드를 **생략**한다. 변경은 `modelContextWindow: 양의 정수`, 복원은 `null`이다. 조회·변경 모두 `settingsApplied === true`와 명시 `threadSettings.modelContextWindow`, `effectiveContextWindow`를 확인한다.
- 공식 0.166 생성 스키마의 같은 메서드는 크기 필드가 없고 응답이 `{}`다. 이름·버전·빈 성공 응답으로 지원을 추정하지 않는다. 공식 CLI에서 크기 쓰기를 보내지 않고 기존 사용량 새로고침을 유지한다.
- 요청 override와 실효 예산은 다르다. 실효값은 모델 카탈로그 한도와 usable-context 비율을 반영한다. UI는 카탈로그의 별도 최대값을 가정하거나 숫자 상한을 만들지 않는다. 전달·표시에서 정수 정밀도를 보존하기 위해 JS safe integer 범위만 허용한다.
- `expectedModelContextWindow`는 Desktop의 오래된 UI 방어다. 서버 CAS·다른 클라이언트 변경 차단을 보장하지 않는다.
- 이미 송신한 쓰기는 창을 닫아도 취소 완료로 취급하지 않는다. 늦은 결과·알림은 원래 UI 세대에서만 반영한다. 세션 종료는 기존 stopped/deadline 감시자가 소유 transport를 회수한다.
- 변경 결과 불명 뒤 자동 재전송하지 않는다. 명시 조회에서 원래 요청값과 일치하는 적용 확인을 받으면 편집을 다시 허용한다. 불일치 시 기존 요청의 지연 적용을 배제할 서버 mutation ID/barrier가 없어 쓰기를 계속 차단한다. 다른 세션의 설정·잠금에는 영향이 없다.

| 의무 | 직접 실패 관측과 시험 |
| --- | --- |
| CTX01/02, DIST-ACK-001 | `tests/context-capabilities.spec.ts`의 같은 id/generation set/reset, 요청값 100000과 실효값 95000 구분. Rust `r36_reads_then_sets_only_thread_override_and_confirms_requested_and_effective_values`의 실제 WebSocket 요청 whitelist와 GUI lease 불변 |
| CTX03 | `official_empty_and_unconfirmed_or_incomplete_responses_never_enable_writes`: 실제 공식 `{}` 및 누락/오타/잘못된 ACK 뒤 추가 송신 금지. frontend 미지원 클릭은 사용량 새로고침 |
| CTX04 | 잘못된 정수·필수 nullable 필드 누락 거부, 닫기 무변경. 임의 모델 한도는 추가하지 않음 |
| CTX05, CONC-CANCEL-004 | 지연 변경 중 닫기·hide/show 후 응답/알림 무시, 중복 변경 버튼 차단 |
| CTX06, DIST-ORDER-004 | `stale_ui_is_rejected_before_write_and_unknown_ack_is_not_success`, `unknown_write_blocks_resubmission_and_authoritative_matching_query_recovers`, 세션별 독립 잠금 시험 |

실행: 구현 전 신규 Playwright 5사례는 4 FAIL(조절 UI 부재), 미지원 새로고침 1 PASS(해당 실행의 터미널 출력 기준, 초기 trace는 후속 runner가 덮어써 남아 있지 않음). 구현 후 최초 `npm run build` exit 0, 최종 `npx playwright test tests/context-controls.spec.ts tests/context-capabilities.spec.ts --reporter=line` exit 0 (21 PASS, 19.6s: 신규 8 + 기존 13). 최종 전체 build 재확인은 동시 편집 중인 `src/extensions.ts:243`의 `catalogQuery` 누락 TS2741로 FAIL이며 해당 담당에게 전달했다. Rust 7사례는 이 작업자의 PATH에 Cargo가 없어 **NOT_RUN**, root CI가 필요하다. 실제 R36/공식 실행 파일 자체 fixture·다음 turn 모델 반영·재시작 후 유지·실제 앱 GUI는 이 작업자의 시험 범위에서 **NOT_RUN**이며 mock과 소스 검증으로 대체하지 않는다.

컨텍스트 모듈만의 독립 타입 검사: `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --types vite/client src/context-controls.ts` exit 0. 전체 build의 다른 담당 파일 오류를 이 검사로 통과 처리하지 않는다.

## 실제 실행 파일 계약 검증과 명시 거절 보완

추가 실행 계획·runner·원시 RPC·stderr·결과는 `D:/codex/build/odHooksSchema/context-native-20261104-01/`과 `context-native-20261104-02/`에 있다. 직접 stdio child만 실행했고 운영 daemon/proxy/lifecycle 명령은 호출하지 않았다. 각 child의 HOME/CODEX_HOME/cwd와 설정 파일을 자체 폴더에 격리했고, loopback 자체 provider만 지정했다. 모델 turn은 보내지 않았다.

- 첫 시도 runner exit 1: R36의 임의 합성 모델은 조회에서 실효값 258400을 반환했으나 카탈로그 한도가 없어 set을 `-32600 invalid thread settings override`로 거절했다. 공식 `{}` 미지원 판정은 통과했다. 두 child exit 0, provider HTTP 요청 0. 첫 실패 원시 자료를 그대로 보존했다.
- 두 번째 runner exit 0: 자체 `model/list`가 광고한 default 모델을 선택했다. R36 0.166.0+native-r36.20261103에서 A의 `null/258400 → 100000/95000 → null/258400`을 ACK·재조회로 확인했다. B의 override/실효값과 C 신규 thread 기본값 불변, 자체 config SHA256 불변. 공식 0.166.0에서는 두 thread query 응답이 `{}`, 크기 쓰기는 0이었다. 두 child exit 0, provider HTTP 요청 0.
- 결과 원본: `D:/codex/build/odHooksSchema/context-native-20261104-02/report.json`. 첫 실패: `../context-native-20261104-01/report.json`. 실제 executable SHA256·명령·PID·응답은 각 result와 rpc.jsonl에 기록했다.
- 사후 자기 PID 4개와 해당 ParentProcessId의 직접 child 각각 잔존 0을 `context-native-20261104-02/cleanup-evidence.json`에 보존했다. 임시 자료는 검증 근거이므로 삭제하지 않았다.
- source `turn_processor.rs`의 preview 검증은 submit_core_op 전에 `-32600`을 반환하고, 적용 수락 이후 실패는 `-32603`이다. 따라서 Desktop은 `-32600/-32601/-32602`를 명시 거절로 표시하고 pending을 해제한다. 내부 오류·응답 유실은 계속 불명확 상태로 보존한다. 실제 거절 관측으로 확인한 수정이며 전역 설정 변경은 아니다.
- 보완 후 `npx playwright test tests/context-controls.spec.ts tests/context-capabilities.spec.ts --reporter=line` exit 0, **22 PASS**(17.9s: 신규 9 + 기존 13). outputDir은 자체 fixture의 `playwright-rejection`으로 분리했다. `npm run build`도 최종 exit 0으로 재확인했다. 앞선 동시 편집 시점 TS2741 실패는 위에 보존한다.

남은 NOT_RUN: Rust 7사례(Cargo PATH 부재), 실제 Desktop control 연결/모델 다음 turn 적용/재시작·resume 유지. 실제 CLI direct stdio 계약 성공을 이 범위의 성공으로 확대하지 않는다.
