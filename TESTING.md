# 검증

새 기능은 의미 있는 기대 동작을 먼저 테스트하고 실패 원인을 확인한 뒤 구현합니다. 기존 순수 로직에 추가한 검사는 회귀 테스트로 구분합니다.

```bash
pnpm check
pnpm build
pnpm test:e2e
pnpm package:dir
```

MCP 개발용 Node 런타임은 `pnpm bundle:runtime`으로 준비합니다. 필요할 때 `NAI_BUILD_PLATFORM`과 `NAI_BUILD_ARCH`로 이 런타임 대상만 지정할 수 있습니다. 앱 패키징은 electron-builder의 실제 대상 아키텍처를 사용하며, `afterPack`이 각 앱 리소스 폴더에 맞는 Node 런타임과 MCP helper를 배치합니다.

이미 빌드된 앱을 특정 대상으로 패키징할 때는 다음처럼 아키텍처를 명시합니다.

```bash
pnpm exec electron-builder --mac --x64 --publish never
pnpm exec electron-builder --win --x64 --publish never
```

두 번째 명령은 Windows 네이티브 runner에서 실행해 SQLite 네이티브 모듈도 Windows x64용으로 재빌드합니다.

단위 테스트는 임시 SQLite와 합성 레시피를 사용합니다. 전역 `fetch`는 기본 차단되며, 네트워크 경계는 주입된 응답으로 검증합니다. 실계정의 토큰·구독 API·이미지 생성 API는 자동 테스트에서 사용하지 않습니다. UI 테스트는 jsdom과 React Testing Library를 사용합니다.

Electron E2E는 임시 앱 프로필을 명시적으로 지정합니다. 기존 앱의 저장소나 이미지 폴더를 열지 않습니다. 테스트 종료 시 자신이 만든 임시 프로필과 프로세스만 정리합니다.

배포 빌드는 허용된 파일 경로와 로컬 경로·비밀키 포함 여부를 검사합니다. 언어 리소스는 키·보간 변수 대응을 검사하며 UI의 언어 변경과 저장 데이터 보존을 별도로 검증합니다.

자동 테스트의 성공은 공급자 API 실호출, 최종 과금, 배포 인증서 서명·공증이나 모든 OS의 동작을 검증했다는 뜻이 아닙니다. 각 릴리스에서는 실제 실행한 OS와 패키지 종류를 함께 기록합니다.
