# Release Notes — `v<MAJOR.MINOR.PATCH>` (<YYYY-MM-DD>)

> **Document Policy / 문서 작성 기준**
> - This single release note contains both the **English** and **Korean (한국어)** editions inline (never separated by external links).
> - Maintain a formal, objective technical tone throughout both editions.

---

## [English] `v<MAJOR.MINOR.PATCH>` Release Notes

### 1. Summary
<Concise formal summary of the release scope, compatibility updates, and primary objectives.>

### 2. Breaking Changes & Migration Guide
- None. *(If applicable, specify affected configuration keys, API signatures, and exact migration/rollback commands.)*

### 3. Defect Fixes & Enhancements
- **`<DEFECT-ID>` (`<Severity>`)**: <Formal description of root cause resolved, affected module (`file:line`), and verified behavior.>

### 4. Installation & Upgrade
```bash
curl -fsSL https://github.com/jaeseongs95/Arcvera-Connect/releases/download/v<MAJOR.MINOR.PATCH>/install-relay.sh | bash
```

### 5. Verification & CI Evidence
- **Unit & Integration Suite**: `npm test` (`<N>/<N>` passed)
- **Production Build**: `npm run build` (passed)
- **Browser E2E Suite**: `npm run test:e2e` (`<N>/<N>` passed)
- **Commit SHA**: `<40-char commit SHA>`
- **CI Workflow**: `<GitHub Actions run URL>`

---

## [한국어] `v<MAJOR.MINOR.PATCH>` 릴리즈 노트

### 1. 개요
<이번 릴리즈의 적용 범위, 호환성 갱신 사항 및 주요 목적을 공식적인 기술 문서 문체로 요약합니다.>

### 2. 호환성 및 마이그레이션 안내
- 해당 사항 없음. *(계약·설정 변경이 있는 경우 영향 대상과 이전·복구 절차를 명시합니다.)*

### 3. 주요 결함 수정 및 개선 사항
- **`<DEFECT-ID>` (`<심각도>`)**: <해결한 근본 원인, 대상 모듈(`파일:줄`) 및 검증된 동작을 공식 표현으로 기술합니다.>

### 4. 설치 및 업그레이드 방법
```bash
curl -fsSL https://github.com/jaeseongs95/Arcvera-Connect/releases/download/v<MAJOR.MINOR.PATCH>/install-relay.sh | bash
```

### 5. 검증 및 CI 근거
- **단위·통합 시험**: `npm test` (`<N>/<N>` 통과)
- **프로덕션 빌드**: `npm run build` (통과)
- **브라우저 E2E 시험**: `npm run test:e2e` (`<N>/<N>` 통과)
- **커밋 SHA**: `<40자 커밋 SHA>`
- **CI 실행 이력**: `<GitHub Actions 실행 URL>`
