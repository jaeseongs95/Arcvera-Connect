# 질문함 회귀 사례 (구현 전 작성)

범위: `createQuestionCenter` 공개 UI와 native 명령 호출. 기존 Playwright fixture/runner를 사용한다. native observer 및 실제 OS 브라우저 실행은 별도 backend/link 사례에서 검증하며 이 UI mock으로 보장하지 않는다.

| ID | 입력 및 전제 | 절차 | 기대 결과 / 판정 기준 |
| --- | --- | --- | --- |
| QC-L1 | 질문 제목·본문·선택지·설명에 HTTP(S) URL 포함, native 호출 기록 가능 | 질문함을 열고 각 링크 클릭 | 모든 URL은 텍스트를 보존하는 링크로 표시, 클릭당 `open_external_url` 1회. 질문 응답/선택 변경 없음 |
| QC-L2 | native opener가 실패 | 링크 클릭 | 질문 원문·초안 보존, 오류를 안전한 안내로 표시. 내부 경로·오류 문자열 노출 없음, 자동 재시도 없음 |
| QC-A1 | `source:async` 질문, 안정 requestId/questionId, 자유 입력 및 선택지 | 초안 작성→목록 갱신→명시 전송 | 초안 유지, 기존 응답 명령에 정확한 세션/세대/질문 ID와 답변 전달, 해결 관측 전 항목 유지 |
| QC-A2 | `complete:false`, 알려진 항목 없음 | 최초 조회·언어 전환·재조회 | 확정 0건/미응답 없음으로 표시하지 않음. 이후 complete:true 빈 목록만 확정 0건 |
| QC-A3 | `complete:false`, 알려진 항목 1개 | 최초 조회·complete:true로 재조회 | 확인된 질문은 유지·응답 가능. 일부 상태 미확인 안내 후 정상 조회 때 안내 해제 |
| QC-R1 | 기존 sync 질문/승인, 연결 끊김, 전송 불명, 숨김·해제 fixture | 기존 question-center.spec.ts 전체 실행 | 모든 기존 요구 보존. 거짓 해결·자동 재전송·중복 poll 없음 |
| QC-B1 | 최대 32개 세션에 sync 요청 32개와 async 질문 32개씩, 합계 2,048개 | 공개 질문함 목록 조회 후 2,049개로 변경하여 재조회 | 2,048개는 정상 표시. 상한 초과는 이전 목록과 마지막 건수 보존 + 조회 실패 안내. 유효한 목록을 형식 오류로 거부하지 않음 |

위 표는 실행 전 계획이다. 실제 실행 결과와 원시 근거를 아래에 별도로 기록한다.

## 로컬 실행 결과

기존 1,024 항목 제한 후보에서 QC-B1은 badge 기대값 2,048 / 실제 0으로 실패했다. 동일 시험에서 상한을 네이티브의 32세션 × (RPC 32 + async 32)에 맞춘 뒤 2,048 항목 표시와 2,049 항목 거부·이전 목록 보존을 확인했다.

| 사례 | 실제 결과 | 근거 및 제한 |
| --- | --- | --- |
| QC-L1, QC-L2 | PASS | 실제 질문센터 DOM click → native invoke stub, 선택·응답 변화 없음 / 실패 안내·초안 보존. OS 브라우저 실행은 별도 |
| QC-A1 | PASS | async DTO를 받는 UI의 정확한 안정 ID·초안·단일 전송·해결 전 pending 유지. 실제 서버 전송은 backend 시험 |
| QC-A2, QC-A3 | PASS | complete:false의 빈 목록/확인된 한 항목, 한·영 안내, complete:true 재확정 |
| QC-R1 | PASS | 기존 질문센터 10개 회귀 포함 |
| QC-B1 | RED → GREEN | `artifacts/question-fix/limits-red.log` exit 1 → `limits-green.log` exit 0. 테스트 바이트는 동일 |

명령: `npx playwright test tests/question-center-limits.spec.ts tests/question-center.spec.ts --reporter=line`, Windows msedge, worker 1, 15 PASS / exit 0. 그 전 전체 화면 회귀는 `full-source-separated.log`에서 395 PASS / 선택 performance replay 1 SKIP / exit 0이며 이후 상한 변경은 위 표적 시험과 최종 CI로 검증한다.

첫 링크 시험의 Unicode URL 기대값은 미인코딩 원문이었으나 표준 URL 변환 결과는 percent-encoded URI였다. 최초 13 PASS / 1 FAIL을 보존하고 기대값만 정확한 URI로 수정했다. 이를 제품 결함 red/green으로 세지 않는다. 별도의 baseline 질문센터 격리본은 QC-L1/L2/A2 관련 새 시험 3개에서 실제로 실패했으며 `red.log`에 보존했다.

## 통합 후보 추가 확인 (2026-11-05)

- `npx playwright test tests/external-links.spec.ts tests/question-center.spec.ts tests/question-center-limits.spec.ts --reporter=list`: 22 PASS, 종료 0. `artifacts/question-fix/final-targeted.log`에 보존했다. 이는 프런트엔드 native invoke stub 경계이며 실제 브라우저 실행 증거와 구분한다.
- `npm run build`: 종료 0. `artifacts/question-fix/final-build.log`에 보존했다. 기존 500kB chunk 경고가 남아 있다.
