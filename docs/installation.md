# 고급 설치와 문제 해결

일반적인 macOS 설치는 [README](../README.md)의 `npm run setup`을 사용하세요. 아래는 수동 설정이나 팀용 마켓플레이스가 필요한 경우의 안내입니다.

## 설치 도구가 변경하는 범위

`npm run setup -- codex`는 `.codex/config.toml`의 최상위 모델·공급자와 `model_providers.agent_router` 테이블을 설정하고, macOS 사용자 LaunchAgent를 등록합니다. `~/.agents/skills/agent-context-gates`에 검색·기억 스킬을 연결합니다. 서버가 정상 응답하는지 확인한 후 Codex의 공급자를 바꿉니다. 설치 도중 실패하면 이전 파일을 복원합니다. `~/.jev-agent-optimizer/backups/`에 설정 백업을 남깁니다.

`npm run setup -- claude`는 사용자 skills 폴더에 로컬 플러그인과 검색·기억 스킬을 연결하고 `.claude/settings.json`의 네 개 환경변수를 설정합니다. 기존 다른 설정을 보존합니다. 마켓플레이스의 동일 플러그인이 활성화되어 있으면 중복 설치를 거절합니다.

기존 로컬 설치를 다시 설정하면 관리하던 `AMR_*` 값은 `JAO_*`로 바꾸고 설치 기록을 `~/.agent-model-router/install.json`에서 `~/.jev-agent-optimizer/install.json`로 이전합니다. 기존 기록은 백업한 뒤 제거합니다. 새 설치의 백업은 `~/.jev-agent-optimizer/backups/`에 저장합니다.

설치 도구는 기본 사용자 경로 `~/.codex`, `~/.claude`를 대상으로 합니다. 사용자 지정 `CODEX_HOME`·`CLAUDE_CONFIG_DIR` 또는 조직 관리 설정에서는 아래 수동 구성을 사용하세요. 기존 관련 없는 `agent_router` 공급자, 다른 플러그인 폴더, 복잡한 TOML 형식은 자동으로 덮어쓰지 않습니다.

## Codex 수동 실행

모든 운영체제에서 Node.js 22 이상과 로그인한 Codex가 필요합니다.

```bash
npm ci
npm run build
node --env-file=.env dist/cli.js serve --mode auto --baseline-model gpt-6-astra --port 8765 --metrics .local/codex.jsonl
```

`--baseline-model`은 `Jev Auto`로 표시할 클라이언트 모델 ID입니다. 자동 모드의 실제 초기·실패 시 모델은 `--balanced-model`(기본 `gpt-6-sol`)입니다. 기존 Astra 설정을 바꾸지 않고 새 정책을 사용할 수 있습니다. 기본 effort는 `medium`, 로컬에서 판별한 간단한 인사·문장 교정은 `low`입니다. `--downgrade-confidence`를 지정하면 기준에 못 미친 하향 추천은 balanced로 처리합니다. 자동 설치는 이 기준을 `0.9`로 설정합니다.

이 터미널을 열어 둔 상태에서 Codex 설정의 **최상위** 모델·공급자와 해당 공급자 테이블을 아래와 같이 병합하세요.

```toml
model = "gpt-6-astra"
model_provider = "agent_router"

[model_providers.agent_router]
name = "Jev Agent Optimizer"
base_url = "http://127.0.0.1:8765"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

앱을 재시작하고 새 작업을 생성합니다. 종료된 서버를 공급자로 사용하면 요청이 실패합니다. 서버와 함께 CLI 세션만 실행하려면 다음 명령을 사용할 수 있습니다. 사용자 전역 설정은 변경하지 않습니다.

```bash
node --env-file=.env dist/cli.js codex --mode auto --baseline-model gpt-6-astra --
```

요약을 끄려면 서버/CLI 옵션에 `--response-footer off`를 추가하세요. 사람이 읽는 답변에만 사용하세요. 임의의 원문 형식을 유지해야 하는 CLI 파이프라인에서도 이 옵션으로 끌 수 있습니다.

[Codex 공급자 설정 공식 문서](https://developers.openai.com/codex/config-reference)와 [플러그인 범위](https://developers.openai.com/codex/plugins)를 참고하세요. 이 프로젝트는 Codex 플러그인 설치가 공급자 설정·서버 자동 실행을 대신한다고 보장하지 않습니다.

## Claude Code 마켓플레이스

이 저장소는 Claude Code용 마켓플레이스를 포함합니다. `claude plugin marketplace add`로 등록하면 CLI의 `/plugin`과 Claude 앱 **Code 탭의 로컬 세션**에서 `+` → **플러그인** → **플러그인 추가**에 목록이 나타납니다. 앱의 일반 **사용자 지정 → 플러그인 → 탐색**은 claude.ai 계정에서 동기화하는 별도 목록입니다. 그 화면에 저장소 등록만으로 나타난다고 안내하지 않습니다([Claude 데스크톱 Code 탭 문서](https://code.claude.com/docs/en/desktop#install-plugins)).

새로운 설치를 마켓플레이스 방식으로 진행한다면:

```bash
claude plugin marketplace add starhn87/jev-agent-optimizer
claude plugin install jev-agent-optimizer@jev-agent-optimizer
```

게시 전 로컬 목록을 검사하려면 저장소 루트에서 `claude plugin validate .`를 실행하세요. 로컬 목록 자체를 설치하려면 `claude plugin marketplace add .` 이후 같은 `plugin install` 명령을 사용할 수 있습니다. **로컬 연결 방식으로 이미 설치했다면 `npm run disable -- claude`로 먼저 해제**하세요.

마켓플레이스 플러그인에는 `agent-context-gates` 스킬도 포함됩니다. 스킬의 명령은 이 저장소에서 빌드한 CLI를 사용하며, `JAO_ENV_FILE`을 저장소의 `.env` 절대 경로로 설정해야 합니다. 스킬은 에이전트에게 필터 호출을 안내하지만 내장 검색·기억 도구를 가로채지는 않습니다.

키는 안정적인 위치의 `.env`에 두고, `~/.claude/settings.json`의 기존 `env` 객체에 아래 값을 병합하세요. 다른 환경변수·설정을 지우지 마세요. 플러그인 캐시 경로에 키를 넣으면 업데이트 때 잃을 수 있습니다.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "JAO_CLAUDE_AUTO": "1",
    "JAO_ENV_FILE": "/ABSOLUTE/PATH/TO/.env",
    "JAO_RESPONSE_FOOTER": "1"
  }
}
```

새 CLI 또는 데스크톱 Code 탭 세션을 시작하세요. `/jao-route`가 등록되고 새 요청 뒤 판정·API 모델이 나오면 적용된 것입니다. `JAO_CLAUDE_AUTO=0`은 자동 라우팅 해제, `JAO_RESPONSE_FOOTER=0`은 요약 표시만 해제합니다.

마켓플레이스로 설치한 플러그인은 `claude plugin uninstall jev-agent-optimizer@jev-agent-optimizer`로 제거하세요. `npm run disable`은 로컬 연결 방식만 관리합니다.

공식 문서: [마켓플레이스](https://code.claude.com/docs/en/plugin-marketplaces), [초기 접근 함수 훅과 타입](https://github.com/anthropics/claude-code/tree/main/mods). 함수 훅 활성화가 허용되지 않는 버전이나 조직 환경에서는 이 라우터가 동작하지 않습니다.

## Windows Claude 수동 설치

`claude-mod` 폴더를 사용자 `.claude/skills/jev-agent-optimizer`에 복사하고, 위의 환경변수를 병합하세요. `JAO_ENV_FILE`에는 실제 Windows 절대 경로를 JSON의 역슬래시 이스케이프 규칙에 맞게 입력하세요. 업데이트할 때 플러그인 폴더를 새 버전으로 교체합니다. Windows 자동 설치는 검증하지 않았습니다.

## 확인 순서

1. `npm run doctor`로 키 설정 유무·플러그인 연결·공급자·서버 응답을 확인합니다. 키 값은 출력하지 않습니다.
2. Codex는 새 작업에서 Jev Auto를 선택합니다. 예전 작업의 모델 선택만 바꿔서는 공급자가 변경되지 않을 수 있습니다.
3. Claude는 새 Code 세션에서 `/jao-route`를 확인합니다. 일반 Chat 탭과 세션 모델 배지는 턴별 라우팅 확인 수단이 아닙니다.
4. Codex 서버가 구버전이면 `npm run setup -- codex`로 재시작합니다. 재시작 중에는 실행 중인 라우터 요청이 끊길 수 있으므로 작업이 끝난 뒤 실행하세요.
5. 필요한 경우에만 [상태 화면](http://127.0.0.1:8765/status)과 `.local/router.stderr.log`를 확인합니다. 서버 로그나 키가 포함된 전체 설정을 공개하지 마세요.
