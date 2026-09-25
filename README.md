# Agent Model Router

TypeSafe Jev가 사용자 턴의 모델 등급(`fast`·`balanced`·`strong`)과 사고량(`low`부터 `max`까지)을 한 번에 판정해 Codex와 Claude Code에 적용합니다. Codex CLI·데스크톱 앱과 Claude Code CLI·데스크톱 **Code 탭**에서 사용합니다. Claude의 일반 채팅에는 적용되지 않습니다.

## 1. 설치와 키 준비

Node.js 22 이상, 사용할 클라이언트(Codex 또는 Claude Code)의 로그인, TypeSafe API 키가 필요합니다. 저장소 루트에서:

```bash
npm ci
npm run build
cp .env.example .env
```

`.env`의 `TYPESAFE_API_KEY=` 뒤에 키를 입력하세요. macOS·Linux에서는 `chmod 600 .env`로 파일 권한을 제한할 수 있습니다. Windows에서는 `cp` 대신 `Copy-Item .env.example .env`를 사용하세요. `.env`는 Git에서 제외되지만 로컬에는 평문으로 저장됩니다. 다른 비밀 저장 방식은 [키 설정 안내](docs/local-secrets.md)에 있습니다.

## 2. Codex CLI와 앱에 적용

저장소 루트의 터미널에서 라우터를 시작하고, **Codex를 사용하는 동안 이 터미널을 열어 두세요.**

```bash
node --env-file=.env dist/cli.js serve --mode auto --baseline-model gpt-6-astra --port 8765 --metrics .local/codex.jsonl
```

기존 `~/.codex/config.toml`이 있다면 백업한 뒤, 파일 **최상위**의 `model`·`model_provider`를 아래 값으로 설정하고 공급자 테이블을 병합합니다. 다른 설정은 유지하세요.

```toml
model = "gpt-6-astra"
model_provider = "agent_router"

[model_providers.agent_router]
name = "Agent Model Router"
base_url = "http://127.0.0.1:8765"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

Codex 앱을 재시작하고 **새 작업**을 만드세요. 앱 모델 목록에서는 실제 지원 모델 ID `gpt-6-astra`가 **Jev Auto**로 표시됩니다. 이 항목을 선택하면 턴마다 모델과 effort를 자동으로 정합니다. CLI도 새 `codex` 세션부터 적용됩니다. 기준 모델과 다른 모델을 수동 선택하면 라우팅을 건너뜁니다. 라우터를 중지한 채 위 공급자 설정을 사용하면 요청이 실패하므로, 상시 사용하려면 서버 명령을 로그인 시 실행되는 서비스에 등록해야 합니다.

Codex 앱의 브라우저 패널이나 일반 브라우저에서 [상태 화면](http://127.0.0.1:8765/status)을 열면 전체 Codex 작업의 최근 **실제 응답 모델**과 **요청한 effort**가 3초마다 갱신됩니다. 현재 앱의 effort 메뉴는 고정된 값만 허용하므로 별도 Auto 항목을 추가할 수 없습니다. Jev Auto에서는 effort도 자동으로 정하며, 앱에 표시된 값과 실제 요청값이 다를 수 있습니다. 보고서의 `byEffort`도 요청한 턴별 값입니다.

```bash
curl -fsS http://127.0.0.1:8765/health
node dist/cli.js report .local/codex.jsonl
```

## 3. Claude Code CLI와 앱 Code 탭에 적용

macOS·Linux에서는 저장소 루트에서 플러그인을 사용자 범위에 연결합니다. Windows에서는 `claude-mod` 폴더를 사용자 `.claude/skills/agent-model-router`로 복사할 수 있습니다.

```bash
mkdir -p "$HOME/.claude/skills"
ln -s "$(pwd -P)/claude-mod" "$HOME/.claude/skills/agent-model-router"
```

`~/.claude/settings.json`의 기존 `env` 객체에 아래 세 값을 **병합**합니다. `ABSOLUTE_PATH_TO_REPO`를 저장소의 실제 절대 경로로 바꾸세요. 키 값은 설정 파일에 넣지 않습니다.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "AMR_CLAUDE_AUTO": "1",
    "AMR_ENV_FILE": "ABSOLUTE_PATH_TO_REPO/.env"
  }
}
```

새 Claude Code CLI 세션이나 데스크톱 **Code 탭** 세션에서 사용하세요. `/amr-route`를 실행하면 최근 판정, 요청한 effort, 실제 응답 모델을 볼 수 있습니다. 앱의 모델 배지는 세션 모델이므로 턴별 전환 결과와 다를 수 있습니다. 함수 훅은 초기 접근 기능이므로 Claude 업데이트 후 `claude plugin validate --strict claude-mod`와 공개 예문 한 턴으로 다시 확인하세요.

## 사용 전 알아둘 점

- 기본 매핑: Codex `fast=gpt-6-luna`, `balanced=gpt-6-sol`, `strong=gpt-6-astra`; Claude `fast=haiku`, `balanced=sonnet`, `strong=opus`. Jev의 사고량 점수는 `low`·`medium`·`high`·`xhigh`·`max` 중 하나로 적용됩니다. Codex 자동 전환에서는 선택한 모델의 지원 범위에 맞추고 기존 effort 선택을 덮어씁니다.
- 자동 분류는 사용자 턴의 텍스트 최대 1,600자를 **유료 TypeSafe API**로 보낼 수 있습니다. 민감한 내용을 다룰 때는 자동 전환을 끄세요.
- Codex는 `~/.codex/config.toml`의 모델·공급자를 원래 값으로 되돌리고 앱을 재시작하면 해제됩니다. Claude는 `AMR_CLAUDE_AUTO`를 `0`으로 바꾸고 새 세션을 시작하면 해제됩니다.
- 이 저장소는 전역 설정을 자동으로 수정하지 않습니다. 합성 사례 검증 결과와 남은 한계는 [검증 기록](docs/validation-plan.md)에 있습니다.

Codex 프로토콜 연결은 [jev-router](https://github.com/gargpratyush/jev-router), 모델 전환과 Claude 함수 훅은 [jev-model-router](https://github.com/satviksinha/jev-model-router)를 참고해 독립적으로 구현했습니다.
