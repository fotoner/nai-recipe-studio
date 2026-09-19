# NAI Recipe Studio

NovelAI 프롬프트를 블록으로 편집하고 생성 결과를 레시피와 함께 보관하는 Windows·macOS 데스크톱 앱입니다. 한국어·日本語·English를 지원합니다.

API 토큰 없이 레시피 작성·저장·검사를 사용할 수 있습니다. 이미지 생성에는 사용자의 NovelAI 계정이 필요합니다. NAI Recipe Studio는 NovelAI의 공식 제품이 아닙니다.

## 사용 흐름

1. **레시피**에서 새 레시피를 만들거나 JSON을 가져옵니다.
2. 블록을 편집하고 **프롬프트·린트**로 생성 전에 확인할 사항을 살펴봅니다.
3. **설정**에서 NovelAI API 토큰을 저장하고 연결을 확인합니다.
4. **생성**에서 장수·시드·예상 사용량을 확인하고 승인합니다.
5. **갤러리**에서 결과와 당시 레시피를 확인하고 이미지를 내보냅니다.

처음 실행하면 캐릭터·레시피·갤러리는 비어 있고, 범용 블록 팔레트만 제공됩니다. 다른 작업공간의 데이터는 자동으로 가져오지 않습니다. 앱 언어 변경은 사용자가 작성한 이름·메모·태그·프롬프트를 바꾸지 않습니다.

## 개발

Node.js 24 이상과 pnpm 10을 사용합니다.

```bash
pnpm install
pnpm dev
```

```bash
pnpm check        # 타입, 린트, 단위·화면 테스트와 커버리지
pnpm build        # Electron main/preload/renderer와 MCP helper
pnpm test:e2e     # 임시 프로필에서 실제 Electron 동작 검사
pnpm package:dir # 현재 OS의 실행 가능한 앱 폴더
pnpm package     # 현재 OS의 설치 패키지
```

Windows 패키지는 Windows에서, macOS 패키지는 해당 아키텍처의 macOS에서 빌드합니다. 기본 macOS 패키지는 로컬 실행용 ad-hoc 서명을 사용하며 공증하지 않습니다. 공식 배포에는 Developer ID 서명·공증과 각 OS 검증이 필요합니다. [electron-builder 서명 안내](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)

## 외부 AI 연결

**설정 → AI 연결**에서 Codex 또는 Claude Desktop을 선택합니다. 연결별로 읽기·쓰기·생성·이미지 열람 권한과 장수·Anlas 한도를 설정하고, 변경할 설정 경로를 확인한 뒤 설치합니다.

- MCP helper는 앱에 동봉된 런타임을 사용합니다. 사용자가 별도로 Node.js나 Python을 설치할 필요가 없습니다.
- 앱이 실행 중일 때만 해당 작업공간을 제어할 수 있습니다.
- Codex에는 `recipe-studio` 스킬도 설치합니다. Claude Desktop은 MCP 설정과 스킬 지원 여부를 구분해 표시합니다.
- 외부 AI가 생성 계획을 준비해도 실제 생성 승인은 앱에서 처리합니다. 스킬의 문구나 도구 입력값으로 승인을 대신할 수 없습니다.
- 설정 갱신과 제거는 앱이 관리하는 항목에만 적용합니다. 다른 MCP 연결과 사용자가 수정한 스킬을 덮어쓰지 않습니다.

스킬 원본은 [skills/recipe-studio/SKILL.md](skills/recipe-studio/SKILL.md)에 있습니다. 실제 도구와 데이터 계약은 실행 중인 MCP의 리소스에서 확인할 수 있습니다.

## 토큰과 저장 데이터

NovelAI의 **User Settings → Account → Get Persistent API Token**에서 토큰을 발급해 앱의 설정에 붙여 넣습니다. 재발급하면 기존 토큰은 무효화됩니다. [NovelAI 계정 설정 안내](https://docs.novelai.net/en/text/usersettings/account/)

토큰은 운영체제 보안 저장 기능을 통해 암호화하고 renderer와 MCP에는 조회 기능을 제공하지 않습니다. 채팅이나 레시피 JSON에 토큰을 넣지 마세요. 생성 이미지와 메타데이터는 앱 프로필 및 사용자가 고른 출력 폴더에 저장됩니다. 공유용 이미지 내보내기는 기본적으로 프롬프트 메타데이터를 제거합니다.

자세한 개발 구조는 [아키텍처](docs/architecture.md), 검증 방법과 한계는 [TESTING.md](TESTING.md)를 참조하세요.
