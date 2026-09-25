# Agent Model Router

**메시지를 보낼 때마다 모델과 effort를 자동으로 선택하고, 답변 끝에서 결과를 확인하세요.**

```text
I have one apple.

— 모델: gpt-6-luna · 요청 effort: low
```

위 표시는 예시입니다. 모델은 실제 응답 메타데이터, effort는 요청한 값입니다. 한 답변을 생성하는 도중 구간별로 모델을 바꾸지는 않습니다. TypeSafe Jev가 턴을 분류하고, Codex 또는 Claude Code가 답변합니다.

## 가장 쉬운 설치: macOS에서 한 번 설정하기

Codex 또는 Claude Code에 먼저 로그인하고 **Node.js 22 이상**을 설치하세요. 두 클라이언트를 함께 설치하려면 Claude CLI의 `claude` 명령도 있어야 합니다. TypeSafe API 키가 하나 필요합니다.

### 1. 다운로드

터미널에서 한 번 실행하세요. 이미 저장소를 내려받았다면 해당 폴더로 이동하고 `npm ci`만 실행하면 됩니다.

```bash
git clone https://github.com/starhn87/agent-model-router.git
cd agent-model-router
npm ci
```

### 2. 키 입력

처음 설치할 때만 `.env.example`을 `.env`로 복사하고, 편집기로 `.env`를 열어 `TYPESAFE_API_KEY=` 뒤에 TypeSafe 키를 입력하세요. 이미 `.env`가 있다면 덮어쓰지 마세요.

```bash
cp -n .env.example .env
open -e .env
```

키는 로컬 파일에만 입력하세요. Git에는 포함되지 않습니다. 자동 분류는 메시지 텍스트 최대 1,600자를 유료 TypeSafe API로 보낼 수 있습니다.

### 3. 설치 및 적용

```bash
npm run setup
```

이 명령이 기존 설정을 백업하고, **Codex와 Claude Code를 함께 설정**합니다. 설정 파일을 직접 편집하거나 서버 터미널을 계속 켜 둘 필요가 없습니다.

하나만 쓴다면 대신 아래 중 하나를 실행하세요.

```bash
npm run setup -- codex
npm run setup -- claude
```

- **Codex:** 앱을 재시작하고 **새 작업**을 만든 다음 `Jev Auto`를 선택하세요. CLI도 새 세션부터 적용됩니다. 예전 작업은 옛 공급자 연결을 유지할 수 있습니다.
- **Claude Code:** 새 CLI 세션 또는 Claude 앱의 **Code 탭** 세션을 시작하면 적용됩니다. 일반 Chat 탭에는 적용되지 않습니다.

정상적으로 완료한 답변 아래에 모델과 요청 effort가 표시됩니다. Claude에서는 `/amr-route`로 최근 판정도 확인할 수 있습니다. 앱의 고정 모델·effort 메뉴는 실제 턴별 결과와 다를 수 있습니다.

## 지금 내 컴퓨터에서 왜 동작하나요?

```bash
npm run doctor
```

설정을 변경하거나 유료 모델을 호출하지 않고, 다음을 경로와 함께 보여줍니다.

| 클라이언트 | 설치 도구가 설정하는 것 | 동작하는 이유 |
| --- | --- | --- |
| Codex | `~/.codex/config.toml`의 `agent_router` 공급자 | 요청이 `127.0.0.1:8765`의 라우터를 거칩니다. |
| Codex | `~/Library/LaunchAgents/com.agent-model-router.codex.plist` | 로그인할 때 서버가 자동으로 시작됩니다. |
| Claude Code | `~/.claude/skills/agent-model-router` 플러그인 연결 | 턴마다 함수 훅이 모델과 effort를 선택합니다. |
| Claude Code | `~/.claude/settings.json`의 `env` | 함수 훅·자동 라우팅을 켜고 `.env`의 위치를 알려줍니다. |

예전 안내대로 수동 설치했다면 설치 도구 기록이 없어도 위 연결로 작동할 수 있습니다. `npm run setup`을 실행하면 기존 설치를 관리 대상으로 등록합니다. 이후에는 같은 명령으로 서버를 재시작할 수 있습니다. 저장소 폴더는 실행 중 계속 필요하므로 설치 후 삭제하거나 옮기지 마세요.

## 업데이트 또는 해제

업데이트는 저장소 폴더에서 실행합니다.

```bash
git pull --ff-only
npm ci
npm run setup
```

해제는 다음과 같습니다. 하나만 해제하려면 뒤에 `-- codex` 또는 `-- claude`를 붙이세요.

```bash
npm run disable
```

설치 전 모델·공급자와 관리 대상 환경변수를 복원하고, 라우터 서비스와 플러그인 연결을 제거합니다. 기존 수동 라우터 설치를 등록한 경우에는 Codex를 기본 `openai` 공급자로 돌리고 Claude 자동 라우팅을 끕니다. 관련 없는 설정과 `.env`는 보존합니다. 앱을 재시작하고 새 세션을 사용하세요. **기존 Codex 작업은 해제 후에도 옛 라우터를 찾을 수 있으므로 새 작업이 필요합니다.**

백업과 설치 기록은 `~/.agent-model-router/`에 저장됩니다. 설치 후 라우터가 관리하는 값을 직접 수정했다면 해제는 덮어쓰지 않고 충돌을 알려줍니다.

## 마켓플레이스로도 설치할 수 있나요?

**Claude Code용 마켓플레이스 파일을 제공합니다.** 이 버전이 원격 저장소에 게시된 뒤 다음 명령으로 추가할 수 있습니다.

```bash
claude plugin marketplace add starhn87/agent-model-router
claude plugin install agent-model-router@agent-model-router
```

마켓플레이스는 플러그인 배포·업데이트를 담당합니다. TypeSafe 키와 초기 접근 함수 훅 설정은 별도로 필요해서, 개인 사용에는 위의 **`npm run setup`을 권장**합니다. 두 설치 방식을 중복 적용하지 마세요. 마켓플레이스 방식의 나머지 설정과 로컬 테스트는 [고급 설치 안내](docs/installation.md#claude-code-마켓플레이스)에 있습니다.

**Codex는 현재 이 프로젝트의 마켓플레이스 설치를 제공하지 않습니다.** 자동 라우팅에는 로컬 프록시와 모델 공급자 설정이 필요합니다. 플러그인을 추가하는 것만으로 모두 적용되는 기능으로 안내하지 않습니다. `npm run setup -- codex`가 이 두 단계를 묶어 처리합니다.

## 지원 범위와 표시 예외

- 통합 자동 설치와 로그인 시 Codex 서버 실행: **macOS**. Claude 단독 설치는 macOS·Linux에서 사용할 수 있습니다. Windows와 다른 운영체제의 Codex 실행은 [수동 설치](docs/installation.md)를 참고하세요.
- Codex 자동 선택: `fast=gpt-6-luna`, `balanced=gpt-6-sol`, `strong=gpt-6-astra`. Claude: Haiku·Sonnet·Opus. 짧은 후속 지시, 큰 문맥, 낮은 신뢰도 등 보호 규칙에서는 추천과 다른 모델을 유지할 수 있습니다.
- Codex 수동 모델 선택·도구 호출 중간 메시지·구조화 JSON 출력·제목 생성·실패/중단 응답에는 요약을 붙이지 않습니다. 읽을 수 없는 응답 형식은 원문을 보존합니다. Claude 요약은 화면 하단 표시이며 대화 원문에는 추가하지 않습니다.
- Claude 함수 훅은 초기 접근 기능입니다. 버전·조직 정책에 따라 사용할 수 없을 수 있습니다. `npm run doctor`는 설정 확인이며, 실제 연결은 새 세션의 응답과 `/amr-route`로 확인하세요.
- 로컬 상태 웹은 문제 해결용으로 남아 있지만 일상 확인에는 필요하지 않습니다. 키 보관은 [키 설정 안내](docs/local-secrets.md), 테스트 근거와 한계는 [검증 기록](docs/validation-plan.md)을 참고하세요.

Codex 프로토콜 연결은 [jev-router](https://github.com/gargpratyush/jev-router), 모델 전환과 Claude 함수 훅은 [jev-model-router](https://github.com/satviksinha/jev-model-router)를 참고해 독립적으로 구현했습니다.
