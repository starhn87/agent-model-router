# Agent Model Router

Codex와 Claude Code에서 턴별 모델 선택을 시험하는 로컬 프로젝트입니다. TypeSafe Jev가 요청을 `fast`·`balanced`·`strong`으로 분류하고, `auto`를 켠 Codex 요청 또는 Claude Code 함수 훅에서 응답 모델을 바꿉니다. 공개 합성 사례로 연결을 검증했으며, 실제 업무 품질이나 장기 사용의 비용 절감을 검증한 제품은 아닙니다.

## 현재 상태

| 대상 | 현재 구현 | 실제 검증 |
| --- | --- | --- |
| Codex CLI | 기존 ChatGPT 로그인으로 로컬 프록시를 거쳐 `pass`·`force`·`shadow`·`auto` 실행 | 실제 Jev로 같은 대화의 `fast → balanced` 전환과 도구 사용 완료. 사용자 설정과 상시 로컬 서버를 연결한 공개 합성 CLI 턴에서도 `fast → gpt-6-luna` 전환 확인 |
| Codex 데스크톱 | 동일 프록시와 사용자 수준 설정 제공 | 이전 제한 시험에서 앱의 `shadow` 추천과 `auto`의 `gpt-6-luna` 응답 완료 확인. 현재 사용자 설정을 상시 서버에 연결했으며 실행 중인 앱에는 재시작 후 반영됨 |
| Claude Code CLI·데스크톱 Code 탭 | 초기 접근 기능인 함수 훅 플러그인으로 주 턴의 모델 요청을 전환. 기존 `UserPromptSubmit` 관찰 훅도 선택 가능 | 사용자 범위 플러그인 설치 후 새 CLI·데스크톱 Code 세션의 공개 합성 턴에서 실제 `claude-haiku-4-5` 응답 확인 |

Claude 구독 세션을 가로채는 프록시는 만들지 않았습니다. Claude Code 내부의 [초기 접근 함수 훅](https://github.com/anthropics/claude-code/blob/main/mods/README.md)을 사용하므로 설치된 Claude Code 버전에 따라 동작이 바뀔 수 있습니다. Claude의 별도 API 게이트웨이는 구독 외 과금과 자격 증명이 필요하므로 이 프로젝트에서 자동 활성화하지 않습니다.

TypeSafe `jev-latest` 연결 확인 1건, 기존 합성 10건과 AI 임시 판정 30건의 예비평가를 마쳤습니다. `jev-1.13.0`의 결과는 각각 10/10, 29/30 일치했고, 30건 중 `strong`을 `balanced`로 낮춘 사례가 1건 있었습니다. 사람이 독립 판정한 품질 검증을 대체하지 않습니다.

이 시험에서는 인적 판정표 작성을 생략했습니다. 신뢰도 0.8 이상인 25건은 AI 임시 판정과 일치했지만, 이것만으로 상시 자동 전환을 켜지 않습니다. 실제 Jev를 사용한 연속 턴과 앱 턴은 제한적으로 검증했으며 세부 결과는 [검증 계획](docs/validation-plan.md)에 있습니다.

## 준비

Node.js 22 이상이 필요합니다. Codex 요청을 실행하려면 로그인된 Codex CLI도 필요합니다. 프로젝트 디렉터리에서 다음을 실행하면 의존성을 설치하고 빌드·테스트합니다.

```bash
npm ci
npm test
npm run check
```

Jev 호출에는 `TYPESAFE_API_KEY`가 필요합니다. 가장 간단한 방법은 `.env.example`을 `.env`로 복사하고 키를 텍스트 편집기에서 입력한 뒤, 실행 명령 앞에 Node.js의 `--env-file=.env`를 붙이는 것입니다. 이 방식은 macOS·Linux·Windows에서 동일합니다. `.env`는 Git에서 무시되지만 로컬 디스크에는 평문으로 저장됩니다. 운영체제 비밀 저장소를 선호하면 선택적으로 macOS 키체인을 사용할 수 있습니다.

macOS·Linux에서는 `cp .env.example .env`, Windows PowerShell에서는 `Copy-Item .env.example .env`로 복사하세요. 키는 복사한 `.env`에 입력합니다.

설치·확인 방법은 [키 설정 안내](docs/local-secrets.md)에 있습니다. 키 준비 확인은 API를 호출하지 않습니다. 키가 없어도 `pass`·`force`와 모의 테스트는 동작합니다. `auto`에서 Jev가 실패하면 안전한 모델로 되돌립니다. `shadow`·`auto`·`evaluate`는 조건에 따라 유료 Jev 요청을 보내므로 전송할 텍스트와 호출 범위를 먼저 확인하세요.

## Codex CLI

아래 명령은 기존 Codex CLI를 자식 프로세스로 실행합니다. 사용자 설정 파일을 수정하지 않습니다. `--` 뒤는 Codex CLI 인자입니다.

```bash
node dist/cli.js codex --mode pass -- exec "한 문장으로 인사해줘"
node dist/cli.js codex --mode force --force-model gpt-6-luna -- exec "한 문장으로 인사해줘"
node --env-file=.env dist/cli.js codex --mode shadow --metrics .local/codex.jsonl -- exec "함수 버그를 분석해줘"
```

| 모드 | 응답 모델 | Jev 호출 |
| --- | --- | --- |
| `pass` | 기준 모델 | 없음 |
| `force` | 지정한 모델 | 없음 |
| `shadow` | 기존 모델 유지, 추천만 기록 | 보호 규칙에 걸리지 않은 턴에서 호출 |
| `auto` | 신뢰도와 보호 규칙에 따라 선택 | 보호 규칙에 걸리지 않은 턴에서 호출 |

`auto`는 자신의 사례로 분류 품질을 검증한 뒤 제한적으로 사용하세요:

```bash
node --env-file=.env dist/cli.js codex --mode auto --metrics .local/codex.jsonl -- exec "함수 버그를 분석해줘"
```

시험에 사용한 기본 매핑은 `fast=gpt-6-luna`, `balanced=gpt-6-sol`, `strong=gpt-6-astra`입니다. 계정에서 사용 가능한 모델 이름을 확인하고 필요하면 `--fast-model`, `--balanced-model`, `--strong-model`, `--baseline-model`로 바꾸세요. Codex에서 `--model`을 직접 지정하면 그 모델을 우선하며 자동 라우팅을 건너뜁니다.

잦은 모델 전환 뒤 캐시 재사용률이 떨어지는지 시험하려면 `--downgrade-confidence 0.9`를 추가할 수 있습니다. [OpenAI 프롬프트 캐싱 문서](https://developers.openai.com/api/docs/guides/prompt-caching)는 모델 변경이 캐시 동작에 영향을 줄 수 있다고 설명합니다. 이 옵션은 Jev가 현재보다 낮은 등급을 추천했더라도 신뢰도가 0.9 미만이면 현재 모델을 유지하고 `downgrade-held`로 기록합니다. 상향 전환과 기본 0.8 신뢰도 기준은 그대로입니다. 0.9는 검증된 최적값이 아니므로 기본값으로 켜지 않으며, 아래 응답 사용량 기록을 보고 조정하세요.

```bash
node --env-file=.env dist/cli.js codex --mode auto --downgrade-confidence 0.9 --metrics .local/codex.jsonl -- exec "함수 버그를 분석해줘"
node dist/cli.js report .local/codex.jsonl
```

지표에는 라우터가 **요청한 모델**과 완료된 Codex 응답이 보고한 **실제 모델 ID**를 별도 행으로 남깁니다. 같은 `requestId`로 두 행을 연결할 수 있습니다. `observedResponses`는 확인된 API 응답 수, `differentModelIds`는 요청·응답 모델 ID가 정확히 다르게 나온 수, `observedCacheReadRate`는 관찰된 입력 토큰 중 캐시에서 읽은 비율입니다. 날짜가 붙은 모델 ID처럼 이름만 다를 수도 있으므로 `differentModelIds`만으로 잘못된 등급이라고 단정하지 마세요. 도구 연속 요청에는 새 Jev 판정 없이 응답 관찰 행만 생길 수 있습니다. 관찰은 완료된 비압축 Responses JSON 또는 SSE에서만 기록하며, `Content-Type`이 없는 SSE나 완료 직후 닫히는 연결도 처리합니다. 4MiB를 넘는 이벤트·본문은 건너뜁니다. 응답 원문과 프롬프트는 기록하지 않습니다.

## Codex 데스크톱 연결 준비

데스크톱 연결은 `~/.codex/config.toml`을 직접 편집하는 고급 시험입니다. 라우터는 이 파일을 자동으로 바꾸지 않습니다. 먼저 원래 설정을 백업하고, 별도 터미널에서 `127.0.0.1` 전용 서버를 실행합니다.

```bash
node --env-file=.env dist/cli.js serve --mode shadow --port 8765 --metrics .local/codex-desktop.jsonl
```

백업을 확인한 뒤 최상위 `model`·`model_provider`를 아래처럼 설정하고 공급자 테이블을 추가합니다. 프로젝트 로컬 `.codex/config.toml`에서는 공급자 설정이 무시됩니다. `agent-auto`를 선택한 상태에서 서버가 꺼지면 앱 요청이 실패할 수 있습니다.

```toml
# 기존 최상위 설정 부분에서 변경
model = "agent-auto"
model_provider = "agent_router"

# 공급자 테이블 추가
[model_providers.agent_router]
name = "Agent Model Router"
base_url = "http://127.0.0.1:8765"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

설정 변경 후 앱을 재시작해 공개 합성 문장 한 턴으로 `shadow` 기록을 확인합니다. `auto`는 그 연결과 분류 품질을 검증한 뒤 별도 시험에 사용하세요. 시험이 끝나면 백업한 설정 파일 전체를 복원하고 서버를 종료한 다음 앱을 다시 재시작합니다. 상시 사용하려면 로그인 시 서버가 자동으로 시작되도록 운영체제의 서비스 관리자에 등록하고 `/health`가 응답하는지 확인해야 합니다. 이 개발 머신에는 `auto`·기준 모델 `gpt-6-astra`·선택적 하향 전환 신뢰도 `0.9`로 로그인 시 시작하는 로컬 서버를 등록했습니다.

서버 종료는 진행 중인 HTTP/SSE 연결도 취소합니다. 업스트림 응답이 도중에 끊기면 SSE 연결을 오류로 닫으며, 아직 응답을 보내지 않은 모델 목록 요청에는 원문 오류를 포함하지 않는 502를 반환합니다.

## Claude Code 자동 전환 (실험 기능)

`claude-mod/`는 Claude Code의 함수 훅으로 사용자 턴이 시작될 때 Jev를 한 번 호출하고, 해당 턴의 주 에이전트 모델 요청을 `fast=claude-haiku-4-5`, `balanced=claude-sonnet-5`, `strong=claude-opus-5`로 보냅니다. 신뢰도가 0.8 미만이거나 분류에 실패하면 세션 모델을 유지합니다. 12자 미만 후속 입력과 명백한 비밀 문자열이 있는 입력은 Jev에 보내지 않습니다. 서브에이전트는 자체 모델을 유지합니다. 각 모델 ID는 `AMR_CLAUDE_FAST_MODEL`, `AMR_CLAUDE_BALANCED_MODEL`, `AMR_CLAUDE_STRONG_MODEL` 환경 변수로 바꿀 수 있습니다.

프로젝트 루트에 [키 설정 안내](docs/local-secrets.md)에 따라 `.env`를 준비한 뒤, CLI 한 세션만 시험하려면 다음을 실행합니다. 플러그인이 `.env`를 직접 읽으므로 TypeSafe 키를 Claude의 인증 환경 변수에 넣지 않습니다. 이 호출은 사용자 프롬프트 최대 1,600자를 TypeSafe로 보내며 유료 Jev 요청이 생길 수 있습니다.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 AMR_CLAUDE_AUTO=1 claude --plugin-dir "$(pwd -P)/claude-mod"
```

일상 CLI와 데스크톱 Code 탭에서 사용하려면 플러그인을 Claude의 사용자 범위 skills 디렉터리에 연결하고, `~/.claude/settings.json`의 기존 설정에 아래 `env` 항목을 병합합니다. `REPO_ABS_PATH`를 저장소의 절대 경로로 바꾸세요. 이 파일에는 키 값이 아닌 `.env` 경로만 기록합니다. macOS·Linux의 연결 예시이며 Windows에서는 플러그인 디렉터리를 복사해 설치할 수 있습니다.

```bash
ln -s "$(pwd -P)/claude-mod" "$HOME/.claude/skills/agent-model-router"
```

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "AMR_CLAUDE_AUTO": "1",
    "AMR_ENV_FILE": "REPO_ABS_PATH/.env"
  }
}
```

새 Claude Code 세션을 열어 `/amr-route`로 최근 Jev 판정과 API가 실제로 응답한 모델을 확인할 수 있습니다. Claude 앱의 모델 배지는 **세션 모델**을 표시하므로 턴별 전환 후에도 그대로일 수 있습니다. CLI에서는 `claude -p --verbose --output-format stream-json ...` 결과의 `modelUsage`와 `assistant.message.model`로도 확인할 수 있습니다. Claude Code 2.1.282에서 CLI와 데스크톱 Code 탭의 공개 합성 턴으로 실제 전환을 확인했습니다. 이 함수 훅 API는 초기 접근 기능이므로 Claude 업데이트 후 `claude plugin validate --strict claude-mod`와 합성 턴을 다시 시험하세요.

자동 전환을 끄려면 `AMR_CLAUDE_AUTO`를 `0`으로 바꾸고 새 세션을 시작합니다. 플러그인까지 제거하려면 사용자 skills 디렉터리의 `agent-model-router` 연결을 삭제하고 추가한 세 환경 변수를 설정에서 지웁니다. 이미 `UserPromptSubmit` 관찰 훅을 설치했다면 자동 전환과 함께 Jev를 두 번 호출하지 않도록 그 훅을 제거하세요.

## Claude Code 관찰 모드

Claude의 공식 `UserPromptSubmit` 훅은 프롬프트를 볼 수 있지만 모델 선택 명령은 제공하지 않습니다. 따라서 이 훅은 **추천 기록 전용**입니다. 아래 예시를 자신의 Claude Code 설정에 병합하기 전에 `REPO_ABS_PATH`를 저장소의 절대 경로로 바꾸세요. macOS·Linux에서는 프로젝트 디렉터리에서 `pwd -P`로 확인할 수 있습니다. 경로에 공백이 있어도 동작하도록 경로를 따옴표로 감쌌습니다. 프로젝트는 훅을 자동 설치하지 않습니다.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"--env-file=REPO_ABS_PATH/.env\" \"REPO_ABS_PATH/dist/cli.js\" claude-shadow-hook --metrics \"REPO_ABS_PATH/.local/claude.jsonl\"",
            "async": true
          }
        ]
      }
    ]
  }
}
```

이 관찰 훅에서는 모델이 바뀌지 않습니다. 훅은 stdout에 아무것도 쓰지 않으므로 대화에 지시문을 주입하지 않습니다. `async` 훅이므로 추천 계산이 대화를 기다리게 하지 않습니다. `--env-file`은 훅 자식 프로세스에서만 키를 읽으며 Claude 메인 프로세스의 환경은 바꾸지 않습니다. Claude CLI와 데스크톱 Code 탭의 Jev 추천·앱 응답은 로컬 시험에서 확인했고 시험용 훅은 제거했습니다.

## 평가와 비용

연결 확인을 마친 Jev 키로 합성 한국어 사례의 정확도와 과도한 저가 모델 선택을 측정할 수 있습니다. `--max-calls`는 필수이며 파일의 사례 수가 상한을 넘거나 등급 판정이 비어 있으면 **요청 전에 중단**합니다. 아래 `evaluate` 명령은 **유료 TypeSafe API를 최대 10회 호출**하므로 실행 범위를 확인한 뒤 사용하세요.

```bash
node --env-file=.env dist/cli.js evaluate fixtures/routing-cases.json --max-calls 10
node dist/cli.js report .local/codex.jsonl
```

독립 판정용 한국어 후보 30개는 [후보 사례](fixtures/routing-candidates.json)에 있습니다. `expectedTier`가 `null`인 채로는 유료 평가가 실행되지 않습니다. 사람의 독립 판정 절차는 [검증 계획](docs/validation-plan.md)에 기록했습니다.

평가 출력에는 전체 사례 기준 정확도(실패는 오답), 분류 성공 기준 정확도, 오류율, `balanced`/`strong`의 `fast` 오분류 비율과 전체 하향 분류 비율, 지연 p95, 사례 ID·예상/추천 등급·Jev 응답 모델 버전·입력 토큰만 포함하고 원문 프롬프트는 담지 않습니다. 지표 파일에도 프롬프트와 인증 헤더를 저장하지 않습니다. Jev 비용 추정치는 실행 시점의 [TypeSafe 공개 단가](https://docs.typesafe.ai/models)와 입력 토큰 수를 확인해 계산하세요. 이 수치만으로 실제 청구액이나 Codex/Claude 구독료 절감을 확인할 수는 없습니다.

## 안전 경계

- `auto`는 신뢰도 0.8 미만, 동적 대화 문맥 추정치 24,000토큰 초과, 이미지 포함 턴, 명백한 비밀 문자열, Jev 오류에서 `fast` 사용 중이면 기준 모델로 복귀합니다. 정적 도구 스키마와 개발자 지시는 이 문맥 추정치에서 제외합니다. 이미 선택한 `strong` 모델은 유지하고, 짧은 후속 지시와 도구 연속 요청은 현재 모델을 유지합니다. 이 규칙은 초기 가설이며 평가 결과로 조정해야 합니다.
- Jev가 활성화되면 사용자 턴의 텍스트 최대 1,600자를 TypeSafe로 전송합니다. 비밀 문자열 탐지는 완전한 DLP가 아닙니다. 민감한 업무에는 `pass` 또는 `force`를 사용하세요.
- 프록시는 ChatGPT용 고정 업스트림으로만 전달하고 계정 토큰이나 요청 원문을 기록하지 않습니다. 로그에는 모델·등급·신뢰도·지연·토큰 수만 남습니다. TypeSafe 키는 프록시 부모 프로세스에만 두고 Codex CLI 자식 환경에서는 제거합니다.
- 자동 전환은 새 사용자 턴에서만 결정하고 도구 실행 후 이어지는 요청에는 같은 모델을 고정합니다.
- Claude 함수 훅도 Jev를 사용자 턴당 한 번만 호출하고 그 턴의 주 에이전트 요청에 같은 모델을 적용합니다. 짧은 입력·명백한 비밀 문자열·낮은 신뢰도·오류에서는 세션 모델을 유지합니다. 첨부 이미지와 전체 대화 문맥의 크기는 아직 Claude 함수 훅에서 검사하지 않으므로, 민감한 작업이나 긴 문맥에서는 `AMR_CLAUDE_AUTO=0`으로 끄세요.
- Codex 요청의 대화 ID로 모델 상태를 분리합니다. 대화 ID가 없으면 이전 요청의 모델 상태를 물려받지 않고 기준 모델에서 시작합니다.
- 저장소는 Codex 전역 모델 설정이나 Claude 플러그인을 자동 설치하지 않습니다. 이 개발 머신에는 사용자 범위 Claude 플러그인, Codex 사용자 설정, 로그인 시 실행되는 로컬 라우터를 별도로 설치했습니다. 기존 `ANTHROPIC_API_KEY` 환경 변수가 Claude 구독 인증보다 우선되는 경우에는 [인증 우선순위 안내](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code)를 확인하세요.

구체적인 단계별 통과 기준과 남은 검증은 [검증 계획](docs/validation-plan.md)에 있습니다.

## 참고 문서

- [Codex 사용자 정의 모델 공급자](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [TypeSafe Jev API](https://docs.typesafe.ai/api) · [모델/가격](https://docs.typesafe.ai/models)
- [Claude Code 훅](https://code.claude.com/docs/en/hooks) · [게이트웨이 연결](https://code.claude.com/docs/en/llm-gateway-connect)

Codex 프로토콜 연결 방식은 [jev-router](https://github.com/gargpratyush/jev-router)의 구현을 참고해 독립적으로 작성했습니다. 모델 전환의 캐시 영향과 요청 모델·실제 응답 모델을 구분하는 관찰 방식은 [jev-model-router](https://github.com/satviksinha/jev-model-router)를 참고했습니다. Claude 구독 자격 증명 중계 방식은 채택하지 않았습니다.

Claude 함수 훅의 연결 방식은 [jev-model-router](https://github.com/satviksinha/jev-model-router)와 [Claude Code Mods 소스](https://github.com/anthropics/claude-code/tree/main/mods)를 참고해 독립적으로 구현했습니다.
