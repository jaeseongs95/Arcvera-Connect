# 1.2.1 세션 이동 버튼 정리 시험

실행 전 정의. 입력은 기존 `project-tabs.spec.ts`의 Alpha 두 세션과 Beta 한 세션 fixture다.

| 사례 | 사전 조건 및 절차 | 기대 결과 및 판정 |
| --- | --- | --- |
| UI-01 | 작업 공간을 열어 세션 헤더를 확인한다. | 앞/뒤 이동 버튼은 DOM에 없고 드래그 손잡이는 남는다. 하나라도 위반하면 실패. |
| UI-02 | Alpha에서 첫 세션 손잡이를 둘째 세션 위로 끌고 전체 프로젝트로 전환한다. | Alpha 순서만 바뀌고 Beta 및 다른 프로젝트의 상대 위치는 보존된다. |
| UI-03 | 기존 내부 드래그 회귀를 실행한다. 저장 순서, 터미널 DOM 동일성, 역이동, Escape 취소를 확인한다. | 순서 저장 성공, 터미널 재생성 및 CLI 시작/종료/입력 호출 0회. |

실행 결과와 커밋은 별도 검증 기록에 남긴다. 이 브라우저 fixture 결과를 설치된 Windows 앱의 실사용 시험으로 표현하지 않는다.

## 2026-11-06 실행 결과

- 변경 전: `npx playwright test tests/project-tabs.spec.ts --grep 'session shortcuts, maximize and reorder' --reporter=line` 종료 1. 이동 버튼이 0개여야 하는 조건에서 12개를 발견해 실패했다.
- 변경 후: `npx playwright test tests/project-tabs.spec.ts --grep 'session shortcuts, maximize and reorder|Windows 창은 내부 드래그' --reporter=line` 종료 0, 2개 통과. 동일한 첫 사례와 기존 저장·터미널 보존·취소 사례를 함께 실행했다.
- 원시 실패 trace: `D:/codex/build/odDesktop121-test-results/red`. 성공 실행 결과 폴더: `D:/codex/build/odDesktop121-test-results/green-arrows`.
- 대상: 기준 커밋 `1da47c00975f215fc6a486740164464933da6007`에서 분기한 `fix/desktop-1.2.1-controls` 작업 사본. 설치된 앱은 교체하지 않았다.
