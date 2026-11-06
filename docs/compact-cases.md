# 1.2.1 컨텍스트 압축 단일 동작 검증

요구: 압축 버튼은 같은 세션에 안전한 수동 압축만 요청한다. 현재 터미널/대화 보기와 입력 소유권을 바꾸지 않는다. 기존 권한·busy·capability·결과 불명 보호를 유지한다.

시험 전 계획. 공개 경계는 컨텍스트 버튼, `conversation_request`와 observer WebSocket이다. Playwright의 IPC는 합성 fixture이며 실제 앱/CLI/daemon 검증을 대신하지 않는다. Rust WebSocket 회귀 시험은 CI에서 실행한다. 로컬 cargo는 실행하지 않는다.

| ID | 입력·전제 | 절차 | 기대 결과·판정 기준 | 실제 결과 |
| --- | --- | --- | --- | --- |
| C121-01 | 터미널 보기, CLI 입력 소유, observer 지원 true/idle/canCompact true | 압축 클릭, 응답 대기 중 다시 클릭 | 압축 RPC 1회, GUI 준비/attach 0회, 보기·입력 소유권 유지, 완료 선표시 없음 | UI RED→GREEN, native CI 대기 |
| C121-02 | initialize 압축 지원 false 또는 observer compact 지원 false·잘못된 타입 | 상태 새로고침 후 압축 시도 | 미지원 버튼 숨김/차단, legacy compact·resume·attach 요청 없음 | UI PASS, native CI 대기 |
| C121-03 | active/pending/unknown/deleted/closing/disconnected/불명 상태 | 압축 시도 | 원인별 차단, wire 압축 0회 | UI PASS, native CI 대기 |
| C121-04 | idle 관측 뒤 외부 turn 시작 | compact RPC가 skippedBusy 응답 | 재요청 없이 skippedBusy 안내, 기존 입력 소유권 유지 | UI PASS, native CI 대기 |
| C121-05 | 압축 송신 후 응답 유실·부정확 응답 | 첫 요청 뒤 재요청 | 결과 불명 보존, 자동·수동 중복 wire 요청 차단 | GUI 결과 불명 PASS, native CI 대기 |
| C121-06 | 압축 응답보다 canonical observer 완료 알림 선행 | 같은 turn 완료 후 started 응답 | 오래된 started 응답으로 active/compacting 되살리지 않음 | native CI 대기 |
| C121-07 | observer 요청 대기 중 보기/세대 변경·종료 | 숨김/폐기/owner 전환 후 결과 반환 | 늦은 UI 결과 무시, 송신 전 만료/세대·owner 불일치 요청은 거절, 슬롯 상한 1 | UI 숨김/폐기 PASS, native CI 대기 |

CS 의무: CONC-ATOMIC-001(입력 소유권과 송신의 경쟁), CONC-LOCK-003(네트워크 대기 동안 슬롯/worker/events mutex 해제), CONC-CANCEL-004(송신 전 만료와 송신 후 결과 불명 구분), DIST-ACK-001(접수와 완료 분리), DIST-ORDER-004(canonical observer 활동 revision 보존). 권한 확대·추가 서비스·상시 실행기를 만들지 않는다.

관측한 원인: `createContextControls.startCompaction`이 `options.prepare()`를 호출했고, 실제 main 결선이 `controller.setVisible(true)` 뒤 터미널을 숨기고 GUI 입력을 소유했다. `guiConnected` 재검사도 이 전환을 강제했다. 수정은 준비 호출을 제거하고, terminal owner의 실제 Compact 요청은 새 GUI 연결 대신 기존 observer RPC의 세션당 1개 슬롯으로 전달한다. GUI를 이미 보고 있을 때는 기존 controller/worker의 초안·busy·결과 불명 보호를 사용한다. WebSocket 송신·응답 해석은 두 경로가 같은 `execute_compact`를 사용한다.

실행 기록:

- `npx playwright test tests/context-controls.spec.ts --grep '터미널 보기와 CLI' --reporter=line`: 수정 전 exit 1, 같은 회귀의 GUI 준비 횟수 기대 0/실제 1. trace: `test-results/desktop121-compact-red/`.
- `npx playwright test tests/context-controls.spec.ts tests/context-capabilities.spec.ts --reporter=line`: 프런트 수정 후 exit 0, 당시 22건 PASS. 이 실행 이후 skippedBusy/최신 pending 2건을 추가했다.
- 추가 skippedBusy/최신 pending을 포함한 24건은 root의 84건 묶음에서 모두 PASS였다. `D:/codex/build/odDesktop121-test-results/frontend-integration.log`를 직접 읽어 해당 24개 testcase와 81 PASS/3 FAIL을 확인했다. 묶음의 실패 3건은 terminal 보기의 이전 전환 기대 1건과 GUI controller 보호 결선 회귀 2건이다. root가 main의 GUI controller 분기와 terminal 기대를 수정한 뒤 해당 3건을 재실행한 `compact-integration-fixed.log`는 3 PASS/exit 0이다. 이 결과와 최초 실패를 구분해 보존한다.
- `rustfmt --edition 2021 --emit stdout --config skip_children=true ...`: `rustfmt`가 PATH에 없어 실행하지 못함. PowerShell의 마지막 종료 코드는 구문 검사 성공 근거로 쓰지 않는다.
- Rust 단위 시험 3개를 추가했다. `terminal_compact_uses_existing_observer_without_gui_lease_or_duplicate_queue`, `terminal_compact_preserves_canonical_order_and_unknown_wire_protection`, `terminal_compact_expiry_wrong_thread_disconnect_and_guards_send_nothing`. 로컬 실행 NOT_RUN, root CI 대상.
- 독립 리뷰 후 `f3530c9`의 새 Rust 시험에서 잘못된 oracle 1곳을 수정했다. `terminal_write`는 `input`의 GUI 소유 여부만 검사하고 `unknown`은 검사하지 않는다. terminal fixture는 GUI lease를 취하지 않으므로 lost/malformed 압축 응답 뒤 CLI 입력은 여전히 허용돼야 한다. 제품 보호 조건은 바꾸지 않고 해당 단언만 CLI 소유권 유지(`owned=false`, `input=false`, write 결과 1)로 교정했다. 두 번째 Compact는 계속 `unknownResult`로 차단하고, 기존 `rpc.next_id == 1` 단언으로 추가 wire 송신이 없음을 검사한다. 최초 push의 CI와 후속 수정의 CI를 구분하며 로컬 Rust 실행은 계속 NOT_RUN이다.
- 두 번째 리뷰에서는 기존 `context_snapshot_uses_existing_observer_without_draining_or_connecting`의 observer 연결만 있음·observer compact 미지원·활동 미확인 입력에서 `unsupported`가 먼저 나와야 함을 확인했다. `f3530c9^`의 원래 조건 순서와 직접 대조해 observer 미지원 검사를 활동 검사 앞으로 복원했다. GUI 경로는 기존의 active → statusUnknown → GUI 미지원 순서를 그대로 유지한다. 양쪽 모두 압축을 허용하지 않으며 기존 테스트 oracle은 변경하지 않았다. 후속 CI에서 같은 기존 시험을 재실행한다.
