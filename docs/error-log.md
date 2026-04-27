# Error Log

## 2026-04-25

### 1) PWA plugin 의존성 충돌
- **증상**: `npm install -D vite-plugin-pwa` 시 `ERESOLVE`
- **재현 조건**: Vite 8 프로젝트에서 `vite-plugin-pwa@1.2.0` 설치
- **원인**: 플러그인 peer dependency가 Vite 7까지로 제한됨
- **해결**: 플러그인 의존 제거, 기본 `manifest.webmanifest` + 서비스워커 수동 등록 방식으로 전환
- **재발 방지**: 신규 라이브러리 도입 전 peer dependency 범위를 먼저 확인

### 2) Vitest setup에서 `expect is not defined`
- **증상**: 테스트 시작 직후 `ReferenceError: expect is not defined`
- **재현 조건**: `src/test/setup.ts`에서 `@testing-library/jest-dom`만 로드
- **원인**: 현재 테스트는 DOM matcher를 사용하지 않는데 jest-dom이 전역 expect 확장을 시도함
- **해결**: setup 파일을 빈 모듈(`export {}`)로 변경
- **재발 방지**: matcher 확장이 필요한 테스트 추가 시에만 setup 확장 모듈 도입

### 3) Node 테스트 환경에서 `DOMMatrix is not defined`
- **증상**: `pdfjs-dist` import 시 `DOMMatrix is not defined`
- **재현 조건**: 모듈 top-level에서 `pdfjs-dist` 정적 import
- **원인**: Node 테스트 환경에 브라우저 canvas 관련 API 부재
- **해결**: `extractTextFromPdf()` 내부로 동적 import 이동
- **재발 방지**: 브라우저 전용 라이브러리는 지연 로딩하거나 환경 분기 적용

### 4) Vite config 타입 오류 (`test` 속성 인식 실패)
- **증상**: `tsc -b` 단계에서 `test does not exist in type UserConfigExport`
- **재현 조건**: `vite.config.ts`에서 `defineConfig`를 `vite`에서 import
- **원인**: Vitest 설정 타입이 포함되지 않음
- **해결**: `defineConfig` import를 `vitest/config`로 변경
- **재발 방지**: Vitest 옵션 사용 시 config import 소스를 `vitest/config`로 통일

### 5) 실제 PDF 업로드 시 문제 추출 실패 (브라우저 환경)
- **증상**: 실제 업로드에서 `문제를 추출하지 못했어요. 다른 PDF로 다시 시도해 주세요.` 발생
- **재현 조건**: 브라우저 런타임에서 특정 기출 PDF 업로드 후 파싱 시도
- **원인**: 브라우저에서도 `legacy` 빌드를 사용하면서 worker 로딩/실행 경로가 맞지 않아 텍스트 추출 실패
- **해결**:
  - 브라우저: `pdfjs-dist` 표준 빌드 사용
  - Node: `pdfjs-dist/legacy/build/pdf.mjs` 사용
  - 브라우저에서 `GlobalWorkerOptions.workerSrc`를 명시 설정
- **재발 방지**:
  - 런타임 환경별(import 분기) 정책 유지
  - 실제 PDF 업로드 기반 E2E 스캔 스크립트(`scripts/full-flow-scan.mjs`)를 릴리즈 전 필수 실행

## 2026-04-26

### 6) 2단 구성 PDF에서 문항/선지가 서로 섞이는 문제
- **증상**: 선택지에 다음 문항 내용이 섞이고, 업로드 후 문제 파싱이 0개 또는 비정상 개수로 실패
- **재현 조건**: 좌/우 2단 편집된 기출 PDF 업로드
- **원인**:
  - 페이지 전체를 단일 y/x 정렬로 복원하면서 좌/우 컬럼 텍스트가 교차됨
  - 문항 시작 탐지를 줄 시작 기준으로 강화한 상태에서 텍스트가 섞여 파싱 실패
- **해결**:
  - `rebuildPageText`에 2단 컬럼 감지 로직 추가
  - 컬럼별(좌 -> 우)로 독립 복원 후 결합
  - 문항 시퀀스 필터의 과도한 거리 제한 제거
- **재발 방지**:
  - `npm run scan:pdf`로 샘플 PDF 파싱 품질(최소 문항 수/선지 완전성) 선검증
  - `npm run quality:gate`를 통해 `scan:pdf -> scan:flow -> test -> build`를 일괄 자동 점검

### 7) 정답 확인 직후 진행도 증가 및 불필요 문구 혼입
- **증상**:
  - 사용자가 `정답 확인`만 눌렀는데 진행도/백분율이 증가한 것처럼 보임
  - 일부 문항 선택지에 저작권/페이지 관련 문구가 함께 노출됨
- **원인**:
  - 답안을 `정답 확인` 시점에 세션 정답 맵에 즉시 반영
  - 파싱 후 정규화 단계에서 문서 머리말/꼬리말 노이즈 필터링이 부족
- **해결**:
  - `정답 확인`은 판정만 수행하고, `다음 문제` 클릭 시 답안을 확정하도록 로직 변경
  - 문제풀이 상단에 정답/오답 카운터를 추가해 현재 판정 상태를 명시
  - 문항/선지 정규화 시 저작권 문구, 페이지 번호, 헤더/푸터 노이즈 라인 제거
- **재발 방지**:
  - 플로우 테스트에 `정답 확인 단독 시 진행도 불변` 검증 추가
  - 텍스트 품질 체크리스트에 `불필요 문구 혼입 여부` 항목 추가
