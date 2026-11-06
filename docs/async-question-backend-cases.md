# 비동기 질문 백엔드 요구 사례

구현 전 작성. 기준: Desktop base `22551c6`, R36 protocol `1b441423baf713d144647d5be37525f7d9cc03c0`.
실행 범위는 합성 metadata fixture이며 운영 세션, 원시 대화, 인증 자료를 읽지 않는다.
공개 경계는 observer 알림 → pending snapshot → Engine 질문함 DTO이다. pure 상태 시험은 이 경계에서 쓰는 동일 adapter 모듈을 직접 실행한다.

| ID | 입력 / 사전조건 | 절차 | 기대 결과 / 합격 조건 | 실제 결과 |
|---|---|---|---|---|
| AQ1 | 진행 turn의 async AgentMessage, 질문 2개 | item/completed를 관측하고 snapshot 조회 | 질문 2개, 각 stable id는 `["request_user_input_async","call-1",index]` JSON 문자열, 원문/선택지 보존 | NOT_RUN |
| AQ2 | 동일 item started/completed 및 중복 completed | 반복 관측 | 같은 stable id가 한 번만 나타남 | NOT_RUN |
| AQ3 | ordinary UserMessage의 공식 답변 envelope | 한 질문 답변 후 원본 item 재생 | 해당 질문만 해결되고 재생으로 복원되지 않음 | NOT_RUN |
| AQ4 | 답변 UserMessage가 원본 질문보다 먼저 도착 | 답변 → 질문 관측 | 해결된 stable id는 pending에 나타나지 않음 | NOT_RUN |
| AQ5 | 진행 질문과 turn/completed, 뒤늦은 같은 turn item | 종료 후 item 재생 | 종료 turn 질문이 복원되지 않음; 다른 현재 turn은 보존 | NOT_RUN |
| AQ6 | 진행 turn 하나의 bounded history, 질문과 답변 혼합 | 구독 시 최신 turn/list, 현재 turn item/list만 조회 | 미답변만 복원; 완료 turn은 pending으로 취급하지 않음 | NOT_RUN |
| AQ7 | history 조회 실패/미지원/상한/단절 | 기존 질문 이후 실패 | 마지막 항목 보존, complete=false; metadataAvailable은 관측 연결 여부와 일치. 확정 0건으로 표시하지 않음 | NOT_RUN |
| AQ8 | 다른 thread 및 새 connection/session generation | 잘못된 thread 알림과 새 state 조회 | 다른 thread 무시, 이전 세대 질문 유출 없음 | NOT_RUN |
| AQ9 | oversized 질문/옵션/고유 id 반복 | 설정 상한을 넘기는 metadata 투입 | bounded state와 명시 진단 유지, 조용한 정상 빈 목록 금지 | NOT_RUN |
| AQ10 | 기존 blocking request/approval | 기존 observer와 GUI request fixture | 기존 requestId/응답 소유권/응답 검증 보존 | NOT_RUN |
| AQ11 | async 답변 제출, TUI busy/기존 draft/modal | 기존 일반 입력 안전 계약 조사 및 synthetic 검증 | RPC 응답으로 보내지 않음; 안전 API가 없으면 직접 응답 불가 이유를 명시 | NOT_RUN |

CS 조건: DIST-ORDER-004(중복/순서/turn 세대), DIST-ACK-001(전송과 해결 구분), PERF-BOUND-002(항목/바이트/조회 페이지 상한), CONC-LOCK-003(I/O 중 상태 잠금 미보유). 판정은 위 사례와 실제 실행 근거에 결속한다. 전체 Rust/실제 TUI 검증은 통합 담당의 승인된 환경에 남긴다.

## 구현과 검증 근거

- 라이브 `item/completed.agentMessage`의 `delivery=async`, 질문별 call id/index를 보존한다. `UserMessage`는 R36의 완전한 답변 envelope와 동일한 단일 text/skill/mention 제외 규칙으로만 해결한다. 완료 turn과 이전 세대 state는 재생으로 되살리지 않는다.
- 구독 이력은 최신 진행 turn 하나, 32개씩 최대 4페이지/128개/1MiB다. I/O 중 `Events` 잠금을 보유하지 않는다. 관련 라이브 알림과 경합하면 같은 전체 RPC 기한 안에서 한 번만 다시 읽는다. 두 번 모두 경합하거나 프로토콜·읽기·상한 오류가 나면 마지막 라이브 항목과 `complete=false`를 보존한다. 이후 새 turn 시작·완료 또는 재구독이 상태를 다시 확정한다.
- `metadataAvailable`은 관측 연결 여부이고 `complete`는 전체 미응답 metadata 확인 여부다. 두 값은 별개다. 직접 응답은 GUI 입력 소유권/연결, 관측 연결, 완전한 현재 state, 이전 입력 결과 불명 없음까지 확인한다.
- async `requestId`와 `questions[0].id`는 stable questionItemId다. 별도 RPC 질문 응답을 만들지 않고 기존 Respond 요청을 `turn/steer`의 정확한 `expectedTurnId`와 일반 사용자 text envelope로 바꾼다. `{turnId}`는 입력 수락까지만 뜻하며, UserMessage 알림 이전에는 `responded=true`와 pending을 유지한다. 유실·잘못된 성공 응답은 결과 불명으로 보존하며 자동 재전송하지 않는다.
- 고정 R36 소스 `app-server/src/request_processors/turn_processor.rs`의 `turn_steer_inner`, `app-server-protocol/src/protocol/v2/turn.rs`의 `TurnSteerParams`, `tui/src/async_question_reply.rs`, `context-fragments/src/answered_question.rs`를 `git show 1b441423baf713d144647d5be37525f7d9cc03c0:<path>`로 확인했다. `-32600`은 handler의 입력/권한/expected-turn/비수락 검증 거절이며 알려진 미수락으로 처리한다. `-32603`과 전송 유실은 미수락으로 간주하지 않는다.

| 사례 | 실제 실행 / 판정 |
|---|---|
| AQ1~AQ5 | 동일 production 상태 모듈의 Rust 시험 `live_async_questions_preserve_identity_and_deduplicate`, `user_answer_before_or_after_question_prevents_replay`, `completed_turn_cannot_reopen_or_clear_new_turn`: 로컬 PASS. 공개 observer 통합은 CI NOT_RUN. |
| AQ6 | 공개 WS 시험 `async_public_observer_subscribe_restores_only_active_turn_then_merges_live_answers`, `async_public_history_live_race_retries_once_without_replacing_newer_notifications`: 작성, CI NOT_RUN. |
| AQ7 | pure `restore_failure_and_live_race_preserve_last_metadata`: 로컬 PASS. 공개 WS의 unsupported/unmaterialized/cursorCycle: 작성, CI NOT_RUN. |
| AQ8 | 새 state/이전 turn 차단 pure 시험: 로컬 PASS. 공개 observer의 다른 thread 무시와 기존 Engine stale generation 경계는 CI NOT_RUN. |
| AQ9 | pure `bounds_are_explicit_and_bad_envelopes_do_not_resolve`: 로컬 PASS. WS 전체 페이지/바이트 포화 시험과 실사용 장기 부하는 NOT_RUN. |
| AQ10 | 기존 sync request/approval fixture 보존. 구독 응답에 상태가 없었던 observer 전용 fixture 두 곳은 명시 idle snapshot으로 수정하고 기존 무추가RPC assertion을 유지. 기존 전체 Rust 시험 CI NOT_RUN. |
| AQ11 | pure `answer_attempt_is_not_resolution_and_cannot_be_resent`: 로컬 PASS. 공개 WS steer exact request, 수락/미지원/expected mismatch/유실/wrongTurn, ownership 미확인 무송신 시험: 작성, CI NOT_RUN. 실제 TUI/daemon 미실행. |

로컬 작은 runner는 기존 MSVC/Rust 환경 exporter를 재사용하며 새 dependency는 제품에 추가하지 않았다. 실행 명령은 `node D:/codex/build/odAsyncProbe1104/run.cjs`이며 실제 Cargo 인수는 `test --offline --manifest-path D:/codex/build/odAsyncProbe1104/Cargo.toml -- --nocapture`다. 결과 원문은 해당 경로의 `result.json`에 있다. 전체 Tauri crate 및 공개 WS 시험을 실행한 것으로 확대하지 않는다. 기존 결함 상태의 같은 시험 실행은 하지 않았으므로 red/green 증거는 NOT_RUN이다.

처음 작은 runner를 작업 트리 `artifacts/async-backend-probe` 안에서 실행했을 때, 통합 담당의 Vite watcher가 MSVC 임시 linker 파일의 EBUSY로 종료했다. 이는 제품 assertion 실패와 다르다. 통합 담당이 원본 로그를 보존하고 runner를 작업 트리 밖 `D:/codex/build/odAsyncProbe1104`로 옮겼으며 이후 빌드는 그 위치만 쓴다. 원래 시험 실패를 재실행 성공으로 덮지 않는다.

## 29a 리뷰 후 선작성한 추가 회귀 계획

아래 사례는 추가 수정 전에 작성했다. 기존 `artifacts/async-source-review/review.md`의 ASYNC-CR-001/002와 CHANGES_REQUESTED 원문, `artifacts/question-fix/async-first-native.log`의 354 PASS / 1 FAIL / 6 ignored를 보존한다. 실패는 `shared_reaper_handoff_during_observer_join_reports_unknown_for_stop_and_shutdown` fixture가 읽기 전용 `thread/turns/list`를 예상하지 못한 panic이며, 기존 unknown/회수/observer join 판정을 완화하지 않는다.

| ID | 입력 / 사전조건 | 절차 | 기대 결과 / 합격 조건 | 실제 결과 |
|---|---|---|---|---|
| AQ12 / CR-001 | R36 실제 `{turnId,item,startedAtMs,completedAtMs}` entry 배열, 질문 1개와 답변 및 질문 외 항목 | 진행 turn의 history 복원 → snapshot | 모든 entry를 검증하고 inner item으로 환원; 미답변 원문/안정 id 보존, complete=true의 거짓 빈 목록 금지 | NOT_RUN |
| AQ13 / CR-001 | 이전 pending 2개, entry의 다른 turn/turn 누락/item 누락/null/scalar/type 누락·비문자열/id 누락·비문자열·빈값·상한초과; 질문 외 항목도 포함 | malformed 페이지를 복원 | 명시 오류 또는 incomplete, 이전 질문 2개 보존. 정상 질문 뒤 malformed가 있어도 부분 교체 금지 | NOT_RUN |
| AQ14 / CR-002 | 종료 ID 1024개로 상한 포화, 새 현재 turn 시작/질문/종료 | 같은 turn의 지연 item/completed와 turn/started, history 재생 | bounded 현재 종료 표식으로 pending=0 유지. 새 turn은 정상 표시, 이전 포화 종료 turn의 지연 알림이 새 pending을 지우지 않음 | NOT_RUN |
| AQ15 | 현재 질문 2개를 관측한 뒤 history 실패로 complete=false/진단 존재 | 다른 turn/completed → 현재 turn/completed → 늦은 item | 다른 turn 종료는 원상 유지. 권위 있는 현재 종료에서 pending=0/complete=true/진단 없음; 늦은 item 재등장 없음. 포화 상태에도 같음 | NOT_RUN |
| AQ16 / 29a CI | shutdown race fixture는 active 구독이며 thread/read에서 PTY activation 신호를 기다림 | 실제 active turn summary와 R36 item entry 읽기 응답을 허용한 뒤 원래 reaper/observer join 경합 실행 | 조회 RPC의 정확한 thread/turn/limit/sort 검증, 기존 unknown·재전송 금지·동일 PID 종료·추가 연결 금지 assertion 유지 | NOT_RUN |

pure 회귀는 같은 수정 후 테스트 블록을 격리된 수정 전 모듈 사본과 수정 후 모듈에 적용해 비교한다. 기존 6 PASS의 `D:/codex/build/odAsyncProbe1104/result.json`은 덮어쓰지 않는다. 새 실행은 같은 격리 경로의 별도 evidence 파일에 기록한다. 공개 WebSocket 및 실제 shutdown race는 root의 Windows CI에서 실행하고 그 전까지 NOT_RUN으로 남긴다.

## 추가 수정의 실제 결과

`git show 1b441423baf713d144647d5be37525f7d9cc03c0:codex-rs/app-server-protocol/src/protocol/v2/thread.rs`의 `ThreadItemEntry`/`ThreadItemsListResponse`, 같은 commit의 `request_processors/thread_processor.rs`의 `thread_items_list_response_inner`/`stored_thread_item_to_entry`, `v2/tests.rs`의 `thread_items_list_round_trips`를 직접 대조했다. 복원 경로는 이제 모든 entry를 `State::restore`에 전달하며, requested turn 일치/inner object/id/type을 검사한 뒤 처리한다. 질문 외 entry에도 같은 검사를 적용한다. 알 수 없는 유형이나 필요한 agent text/user content 형식도 조용히 무시하지 않는다. 검증 실패 시 이전 pending을 교체하지 않고 incomplete로 남긴다.

종료 상태는 bounded old-ID set과 별도로 현재 turn의 `current_closed` flag 하나를 보존한다. 따라서 old-ID set이 포화해도 현재 종료 turn의 item·start·history 재생을 거부한다. 현재 turn의 권위 있는 종료는 pending을 비우고 complete=true/진단 없음으로 복구하며, 다른 turn 종료는 현재 pending/complete/진단을 바꾸지 않는다. 포화 전 일반 종료의 known-zero 복구는 기존 코드에도 있었으며, 이번 회귀는 일반 경계와 포화 경계를 구분했다.

| 추가 사례 | 실제 결과 |
|---|---|
| AQ12 | pure `history_entry_envelopes_restore_questions_and_answers_instead_of_false_empty`: 수정 전 FAIL(0건이 반환되어 기대 1건과 다름), 수정 후 PASS. 실제 entry 2페이지를 쓰는 공개 WS 시험은 작성, 새 후보 CI NOT_RUN. |
| AQ13 | pure `malformed_history_entries_fail_without_replacing_previous_questions`: 수정 전 FAIL(다른 turn entry 수락), 수정 후 16종 malformed에 PASS. 공개 WS 10종 malformed/부분 교체 금지는 작성, 새 후보 CI NOT_RUN. |
| AQ14 | pure `saturated_closed_ids_do_not_reopen_the_current_completed_turn`: 수정 전 FAIL(종료 질문 재등장), 수정 후 PASS. old-ID set 1024개 상한 유지도 assertion으로 확인. |
| AQ15 | pure `authoritative_current_completion_recovers_unknown_while_other_completion_preserves_it`: 수정 전 포화 상태에서 FAIL(다른 turn 종료가 기존 진단을 덮어씀), 수정 후 포화 전·후 모두 PASS. 공개 history 실패 시험에 다른 turn 종료 보존/현재 종료 known-zero/late item 차단 assertion 추가, 새 후보 CI NOT_RUN. |
| AQ16 | active subscribe 및 원래 `thread/read`의 `activated.recv_timeout` 경계를 유지했다. 정확한 현재 turn summary와 reasoning entry 읽기 응답만 추가하고 최종 RPC 순서 assertion도 두 조회를 포함하도록 강화했다. unknown/reaper/observer join/동일 PID/추가 연결 금지 assertion의 변경 없음은 diff로 확인했다. 실제 Windows race 실행은 새 후보 CI NOT_RUN. |

실행:

- `node D:/codex/build/odAsyncProbe1104/review-fix/run.cjs before`: node exit 1, Cargo exit 101, **5 PASS / 5 FAIL**. 실제 assertion 실패이며 compiler/runner 오류가 아니다. 원문 `review-fix/result-before.json`.
- `node D:/codex/build/odAsyncProbe1104/review-fix/run.cjs after`: node/Cargo exit 0, **10 PASS / 0 FAIL**. 원문 `review-fix/result-after.json`. 기존 6개 시험을 포함하며 이력 복원 fixture는 실제 entry envelope로 보정했다.
- 두 실행의 테스트 블록 SHA-256은 동일한 `693fb20721d9150904e309976d8367e56811326698f3cc1638d0bb6abaaac6ec`다. 수정 후 production 모듈 SHA-256은 `8529590f00d7ae589b7b154cb7b4dacfd500ea1f18aaa5c7fe656734de7100ec`다. 수정 전 구현과 같은 최종 테스트를 결합한 `before-with-regressions.rs`는 격리 경로에 남겼다.
- 원래 `result.json` 및 보존 사본 `review-fix/original-six-pass.json`의 SHA-256이 모두 `d8c6c4425cae74a1fd5e94599bb6cce4606f5f153b9b125eb9664c85e2813f97`임을 직접 확인했다. 기존 6 PASS 원문을 덮어쓰지 않았다.
- 세 Rust 파일은 `rustfmt --edition 2021 --emit stdout --config skip_children=true <path>`를 파일 쓰기 없이 실행해 각각 구문 parse exit 0을 확인했다. 이는 타입 검사나 전체 Rust 시험이 아니다. `git diff --check` exit 0. 실행 후 D: 여유 공간 약 274.6 GB. 검증·복구 자료와 원래 리뷰/CI 실패 기록을 보존했다.

## ee2d30e 재리뷰 후 정상 tuple 유형 회귀 계획

추가 수정 전 선작성. 고정 R36 `codex-rs/app-server-protocol/src/protocol/v2/item.rs`의 `ThreadItemPayload` 전체를 직접 읽었다. 일반 struct variant 16종 외에 `WebSearch(WebSearchItem)`, `Sleep(SleepItem)`, `ImageGeneration(ImageGenerationItem)` tuple variant 3종이 있다. 기존 `{` 형태 중심 대조가 이 3종을 놓쳤다. 실제 필드는 같은 commit의 `codex-rs/ext/items/src/{web_search,sleep,image_generation}.rs`로 확인했다. 원래 리뷰·CI·RED/GREEN 기록을 보존한다.

| ID | 입력 / 사전조건 | 절차 | 기대 결과 / 합격 조건 | 실제 결과 |
|---|---|---|---|---|
| AQ17 | 실제 R36 `webSearch`(query/action/results), `sleep`(durationMs), `imageGeneration`(status/revisedPrompt/result/failure/generationId) 각 item을 `{turnId,item,startedAtMs,completedAtMs}`로 포장하고 async pending 질문과 혼합 | 3종 각각 및 3종 동시 이력을 동일 State.restore로 복원; 공개 WS에서도 같은 실제 envelope를 사용 | 정상 3종 때문에 complete=false가 되지 않음. 질문 2개 pure/질문 1개 WS와 원문·stable id 유지. 기존 malformed·다른 turn·unknown 유형 거절과 원래 10개 회귀 결과 유지 | NOT_RUN |

R36 전체 wire 유형 대조 목록(19종): userMessage, hookPrompt, agentMessage, functionCallOutput, plan, reasoning, commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep, imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction. 검증 목록은 정확히 이 정본에 맞추며 추정한 유형을 허용하지 않는다.

AQ17 실제 결과: 동일 `r36_tuple_variants_preserve_pending_questions_in_complete_history` 회귀를 수정 전 구현과 수정 후 production 모듈에 실행했다. 수정 전에는 기존 10개 PASS / 신규 1개 FAIL(Cargo exit 101, node exit 1)이었고, 정상 `webSearch` entry에서 잘못된 유형 오류가 났다. whitelist에 정본의 3종만 추가한 후 기존 10개와 신규 1개 모두 PASS(Cargo/node exit 0)였다. 신규 시험은 3종 각각 및 3종 동시 entry + async 질문 2개를 검사한다. 기존 malformed/failure/complete/종료/포화 assertion은 바꾸지 않았다.

실행 명령과 원문:

- `node D:/codex/build/odAsyncProbe1104/tuple-variants-fix/run.cjs before` → `tuple-variants-fix/result-before.json`.
- `node D:/codex/build/odAsyncProbe1104/tuple-variants-fix/run.cjs after` → `tuple-variants-fix/result-after.json`.
- 두 실행의 테스트 블록 SHA-256은 동일한 `1e625215f084079152509900ba95472a2cc57c3a891386746338044469349128`, 수정 후 모듈 SHA-256은 `72926bb4dd22e76f274dbfe2e8fbf5a507d8b144a20322303520449ca7efbb19`다. 이전 `result.json`, `review-fix/result-before.json`, `review-fix/result-after.json`은 덮어쓰지 않았다.
- immutable enum 전체의 struct와 tuple variant 양쪽을 포함해 추출한 19종을 production 검증 목록과 비교하여 누락 0종을 확인했다. 원문은 `tuple-variants-fix/enum-comparison.json`이다.
- 공개 WS `async_public_history_accepts_r36_tuple_variants_beside_pending_questions`는 정확한 R36 entry/필드를 사용하며 신규 후보 CI NOT_RUN이다. 진행 중이던 이전 후보 CI 결과로 대체하지 않는다. 변경 Rust 2파일의 파일 쓰기 없는 rustfmt parse exit 0, `git diff --check` exit 0을 확인했다.

## f9bc 최종 감사 후 구독 경합 회귀 계획

수정 전 선작성. 구독 응답의 active 상태와 이전에 관측한 현재 turn 질문이 있는 상황에서, context 상태와 async 질문의 종료 판정을 혼동하지 않아야 한다. 기존 f9bc 검증·감사 기록을 보존한다.

| ID | 입력 / 사전조건 | 절차 | 기대 결과 / 합격 조건 | 실제 결과 |
|---|---|---|---|---|
| AQ18 | turn-async의 retained 질문 1개, subscribePassive는 active | thread/turns/list 응답 대기 중 turn/completed(other-old-turn) 알림 후 -32601 history 오류 | retained stable id와 원문 보존, complete=false, 질문 조회 진단 유지. 다른 turn 완료를 현재 turn idle로 해석해 0건을 확정하지 않음 | NOT_RUN |
| AQ19 | AQ18과 같은 현재 turn | 대기 중 turn/completed(turn-async) 알림 후 동일 history 오류 | 정확한 현재 turn 종료 근거로 pending=0/complete=true 유지. 다른 turn·새 turn과 혼합하지 않음 | NOT_RUN |

공개 회귀 `async_public_subscribe_history_failure_only_confirms_the_observed_current_turn_end`를 두 입력에 같은 fixture/오류로 실행한다. 회귀를 추가한 수정 전 `codex_conversation.rs` 전체를 `artifacts/async-subscribe-race-fix/red-codex_conversation.rs`에 보존하고 root가 격리 native RED 시험에 사용한다. 로컬에서 실행하지 않은 RPC 시험을 RED/PASS로 보고하지 않는다.

AQ18/19 소스 판별 및 최소 수정: 구독이 `context_turn=None`으로 바꾼 뒤 별도 context reducer는 식별되지 않은 old turn 완료로도 `context_active=false`가 될 수 있었다. async reducer는 해당 old 종료에서 현재 pending을 보존했지만, history 오류 처리의 `context_active==false → idle()`가 이를 다시 지워 완전한 0건으로 만들었다. 오류 처리는 이제 복원 시도 직전에 알고 있던 async active turn id를 보존하고, 그 정확한 turn의 종료 표식이 현재 async state에 남아 있을 때만 idle을 확정한다. 다른 turn·현재 id 불명·새 turn 교체에서는 오류 진단과 마지막 질문을 보존한다. 별도 context 기능의 동작은 변경하지 않았다.

같은 원인의 다른 idle 경로도 확인했다. production 호출은 (1) 검증된 passive 응답 자체가 명시 idle이며 구독 중 async revision이 변하지 않은 경우, (2) 이번 exact async turn 종료 확인 후 history 오류 처리뿐이다. `State::restore(None)`도 idle을 호출하지만 production history helper는 진행 turn이 없으면 먼저 오류로 반환하므로 이 경로에 None을 전달하지 않는다. `turn/completed`의 직접 질문 정리는 State의 현재 turn id 일치에서만 실행된다. 선택 thread의 `thread/deleted`는 별도 권위 있는 삭제 알림 경로다. 별도 context의 추정 inactive를 재사용하는 다른 async idle production 경로는 확인한 두 Rust 파일에서 없었다.

로컬 실제 검증은 `node artifacts/async-subscribe-race-fix/run-pure.cjs` exit 0, 기존 pure 회귀 **11 PASS / 0 FAIL**이다. 이 runner는 컴파일 TEMP/target을 기존 `D:/codex/build/odAsyncProbe1104`로 지정하며 Git을 실행하지 않는다. 원문 `artifacts/async-subscribe-race-fix/pure-regressions.json`에 보존했다. 변경 Rust 2파일의 쓰기 없는 rustfmt 구문 parse exit 0도 확인했다. 공개 RPC RED/GREEN은 root CI 담당이 실행하며 현재 이 문서의 로컬 RPC 상태는 NOT_RUN이다. 새 source provenance 및 RED/GREEN 전체 시험 블록 바이트 비교는 `artifacts/async-subscribe-race-fix/provenance.json`에 있다.
