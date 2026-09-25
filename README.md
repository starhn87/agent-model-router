# Agent Model Router

Codex와 Claude Code에서 요청마다 모델과 effort를 고르고, 완료한 답변 끝에 실제 모델과 요청 effort를 표시합니다.

## 설치: macOS

**Node.js 22 이상**, 로그인된 Codex/Claude Code, **TypeSafe API 키**가 필요합니다. 두 앱을 함께 쓸 때는 `claude` CLI도 설치되어 있어야 합니다.

```bash
git clone https://github.com/starhn87/agent-model-router.git
cd agent-model-router
npm ci
cp -n .env.example .env
open -e .env
```

열린 파일의 `TYPESAFE_API_KEY=` 뒤에 키를 입력하고 저장한 다음, 아래 명령 하나로 적용하세요. 이미 `.env`가 있으면 `cp -n`이 덮어쓰지 않습니다.

```bash
npm run setup
```

이 명령은 기존 설정을 백업하고 Codex의 로컬 서버와 Claude Code 함수 훅을 설정합니다. 서버를 터미널에 계속 띄워 둘 필요가 없습니다. 하나만 설정하려면 `npm run setup -- codex` 또는 `npm run setup -- claude`를 사용하세요.

- **Codex:** 앱을 재시작해 **새 작업**에서 `Jev Auto`를 선택하세요. 예전 작업은 기존 공급자 연결을 유지할 수 있습니다.
- **Claude Code:** 새 CLI 세션 또는 Claude 앱의 **Code 탭** 세션을 시작하세요. 일반 Chat 탭에는 적용되지 않습니다.

이미 설치했다면 다시 설치할 필요는 없습니다. 이 컴퓨터의 적용 상태는 `npm run doctor`로 확인할 수 있습니다. 정상적인 답변 끝에는 다음과 같이 표시됩니다.

```text
I have an apple.

— 모델: gpt-6-luna · 요청 effort: low
```

## 앱의 플러그인 목록과 설치는 어떻게 다른가요?

**Codex 앱의 ‘개인용’에 보이는 같은 이름의 플러그인을 설치해도 이 라우터가 똑같이 적용된다고 볼 수 없습니다.** 이 저장소에는 Codex 플러그인 패키지가 없고, 자동 라우팅에는 로컬 서버 실행과 Codex 모델 공급자 연결이 필요합니다. 위 `npm run setup -- codex`가 두 작업을 처리합니다. 이미 설치한 경우 같은 이름의 플러그인을 추가로 설치할 필요가 없습니다.

**Claude 앱의 플러그인 ‘탐색’에 보이지 않아도 Claude Code에서 동작할 수 있습니다.** 위 설치 명령은 `~/.claude/skills/agent-model-router`에 로컬 연결을 만듭니다. 이 연결은 Claude Code CLI와 Claude 앱 **Code 탭**에서 사용하며, 일반 앱 플러그인 탐색 목록에 게시된 항목은 아닙니다. `claude plugin list`에서 `agent-model-router@skills-dir`이 `loaded`인지, 새 Code 세션에서 `/amr-route`가 동작하는지 확인하세요. 별도로 제공하는 [Claude Code 마켓플레이스 방식](docs/installation.md#claude-code-마켓플레이스)은 로컬 연결과 중복 설치하지 마세요.

## 업데이트와 해제

저장소 폴더에서 실행하세요.

```bash
# 업데이트
git pull --ff-only && npm ci && npm run setup

# 해제
npm run disable
```

한 클라이언트만 해제하려면 `npm run disable -- codex` 또는 `npm run disable -- claude`를 사용하세요. 설치한 저장소 폴더는 실행 중에도 필요합니다.

Codex는 `fast=Luna`, `balanced=Sol`, `strong=Astra`, Claude Code는 Haiku·Sonnet·Opus를 사용합니다. [턴별 선택 규칙](docs/routing-policy.md), [고급 설치·문제 해결](docs/installation.md), [키 보관](docs/local-secrets.md), [검증 기록](docs/validation-plan.md)을 참고하세요. 자동 분류는 요청 텍스트 최대 1,600자를 유료 TypeSafe API에 보낼 수 있습니다.

Codex 프로토콜 연결은 [jev-router](https://github.com/gargpratyush/jev-router), 모델 전환과 Claude 함수 훅은 [jev-model-router](https://github.com/satviksinha/jev-model-router)를 참고해 독립적으로 구현했습니다.
