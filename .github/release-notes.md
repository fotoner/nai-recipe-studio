## 설치 파일

| OS | 파일 |
|---|---|
| macOS (Apple Silicon) | `*-mac-arm64.dmg` |
| macOS (Intel) | `*-mac-x64.dmg` |
| Windows x64 | `*-win-x64.exe` |
| Linux x64 | `*-linux-x86_64.AppImage`, `*-linux-amd64.deb` |

`SHA256SUMS.txt`로 내려받은 파일을 확인할 수 있습니다.

- 이 빌드는 Apple 공증과 Windows 코드 서명을 거치지 않았습니다. macOS는 처음 실행할 때 **시스템 설정 → 개인정보 보호 및 보안**에서 열기를 허용해야 하고, Windows는 SmartScreen 경고에서 **추가 정보 → 실행**을 선택해야 합니다.
- Linux에서 API 토큰을 저장하려면 GNOME Keyring이나 KWallet 같은 키링이 필요합니다. 키링이 없으면 토큰은 현재 세션에만 유지됩니다. AppImage는 `chmod +x` 후 실행합니다.
- NAI Recipe Studio는 NovelAI의 공식 제품이 아닙니다.

