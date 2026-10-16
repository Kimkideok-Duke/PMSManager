# ChatGPT 플랜 연결 구현 검토

2026-10-16 김기덕: 사용자 요청에 따라 API 키 외에 ChatGPT 로그인으로 플랜 사용량을 사용하는 연결 방식을 추가했다.

## AS-IS와 변경 위치

- 변경 전 `src/main.cjs` 22행의 getKey, 89행 모델 조회, 108행 소스 색인 전 확인은 API 키만 인식했다. ChatGPT 계정 저장소와 연결 방식을 구분하고 분석·대화 직전에 해당 방식의 인증 정보를 받도록 변경했다.
- 변경 전 `src/core/ai.cjs` 54행의 OpenAI 요청은 stream 없이 max_output_tokens를 포함했다. 플랜 연결에서는 store=false, stream=true, input 배열을 사용하고 미지원 max_output_tokens는 제외한다. response.completed까지 검증한 결과만 저장한다.
- 변경 전 `src/ui/index.html` 43행과 `src/ui/app.js`의 drawSettings는 API 키 입력만 제공했다. 플랜 로그인, 계정 추가·선택·연결 해제 및 사용량 관리 버튼을 추가했다. 첫 연결 시 플랜 사용 안내를 표시한다.
- `src/preload.cjs`는 제한된 인증 IPC와 결과 이벤트만 제공한다. 인증 토큰·client ID·원본 ID token은 화면으로 보내지 않는다.
- `src/core/chatgpt-auth.cjs`를 추가해 동적 클라이언트 등록, 영속 host ID, loopback listener, PKCE, state/nonce, RS256 JWKS 검증, issuer/audience/expiry/subject 확인, 암호화 저장과 갱신 직렬화를 처리한다. 연결 취소나 잘못된 신원으로 기존 계정을 덮어쓰지 않는다.
- 단일 프로필 중복 실행을 차단해 회전 갱신 토큰의 경쟁을 방지한다. API 키는 별도 저장소에 보존하며 로그인 실패 시 API 키로 자동 전환하지 않는다.
- `package.json`은 주석을 지원하지 않아 이 문서에 변경 사유를 기록한다. 내부 버전은 0.6.0으로 기록하고 배포 파일명 PMS-Manager.exe는 유지한다.

## 공식 근거

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/ui-ux-guidelines

## 검증 범위

인증 서버를 대체한 테스트는 실제 RSA 서명 검증, state·nonce·계정·유효기간 실패, PKCE/loopback, 승인 권한 누락, 로그인 취소, 토큰 갱신 직렬화·회전, 계정 정보의 토큰 비노출, 모델 목록, SSE UTF-8 분할·완료·실패·중단, UI 및 IPC의 API 키 복원을 검증한다. 실제 계정의 OAuth 승인과 플랜 사용량 차감 성공은 별도 실제 로그인 이후에만 확인할 수 있다. 사용자 비밀번호를 입력하거나 기존 Codex 인증 토큰을 가져오지 않는다.

자동 테스트 81개 통과, 앱 시작 검증에서 IPC·격리·Windows 암호화 정상 확인. 이후 키 제거 시 보관 키도 제거하는 처리와 계정 전환 중 이전 모델 목록 표시 방지를 보완하고 관련 메인 프로세스 테스트 3개를 재검증했다. 패키지 소스 18개가 현재 소스와 일치하고 내부 버전 0.6.0임을 확인했다.

포터블 `release/PMS-Manager.exe` 생성 완료(100213967바이트). 실제 재실행한 임시 폴더 app.asar에서도 버전 0.6.0을 확인했다. 설정 화면에서 ChatGPT 플랜을 선택하면 API 키 입력이 숨겨지고 로그인·계정 선택·사용량 관리 버튼이 표시됨을 확인했다. Continue with ChatGPT를 눌러 프로그램이 로그인 대기 상태가 되고, 시스템 브라우저에 `ChatGPT로 PMS Manager에 로그인하세요 - OpenAI` 창이 열린 것을 확인했다. 이 시점에서 실제 사용자 로그인·승인 및 구독 사용량 차감은 아직 수행되지 않았다.
