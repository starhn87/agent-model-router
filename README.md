# Agent Model Router

Codex와 Claude Code에서 턴별 모델 선택을 시험하는 로컬 프로젝트입니다. TypeSafe Jev가 요청을 `fast`·`balanced`·`strong`으로 분류하고, 명시적으로 `auto`를 켠 Codex 요청에서만 응답 모델을 바꿉니다. Claude Code는 추천을 기록하는 관찰 모드만 지원합니다. 공개 합성 사례로 연결을 검증했으며, 실제 업무 품질이나 상시 사용을 검증한 제품은 아닙니다.

## 현재 상태

| 대상 | 현재 구현 | 실제 검증 |
| --- | --- | --- |
| Codex CLI | 기존 ChatGPT 로그인으로 로컬 프록시를 거쳐 `pass`·`force`·`shadow`·`auto` 실행 | 실제 Jev로 같은 대화의 `fast → balanced` 전환과 도구 사용 완료. 낮은 신뢰도에서는 모델 유지, 이미지 턴에서는 Jev 생략 확인. 저장된 판정 재생으로 `strong` 승급과 짧은 후속 지시의 모델 유지 확인 |
| Codex 데스크톱 | 동일 프록시와 사용자 수준 설정 예시 제공 | 수정된 문맥 추정기로 실제 앱 `shadow`의 Jev `fast` 추천·기존 모델 유지 확인. 이어 제한적 `auto`에서 `gpt-6-luna` 전환과 응답 완료 확인. 원래 설정 복원 완료 |
| Claude Code CLI·데스크톱 Code 탭 | 공식 `UserPromptSubmit` 훅으로 Jev 추천을 비동기 관찰 | CLI와 데스크톱 Code 탭에서 Jev 추천 확인. 데스크톱 합성 턴의 앱 응답까지 완료했으며 임시 훅 제거 |
| Claude 구독 기반 턴별 자동 전환 | 미구현 | 현재 공식 훅이 모델 변경을 실행하지 못함 |

Claude 구독 세션을 가로채는 프록시는 만들지 않았습니다. Claude의 별도 API 게이트웨이는 구독 외 과금과 자격 증명이 필요하므로 이 프로젝트에서 자동 활성화하지 않습니다.

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

설정 변경 후 앱을 재시작해 공개 합성 문장 한 턴으로 `shadow` 기록을 확인합니다. `auto`는 그 연결과 분류 품질을 검증한 뒤 별도 시험에 사용하세요. 시험이 끝나면 백업한 설정 파일 전체를 복원하고 서버를 종료한 다음 앱을 다시 재시작합니다. 이 저장소의 데스크톱 시험도 같은 순서로 복원했으며 상시 연결은 설치하지 않았습니다.

서버 종료는 진행 중인 HTTP/SSE 연결도 취소합니다. 업스트림 응답이 도중에 끊기면 SSE 연결을 오류로 닫으며, 아직 응답을 보내지 않은 모델 목록 요청에는 원문 오류를 포함하지 않는 502를 반환합니다.

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

현재 모델은 바뀌지 않습니다. 훅은 stdout에 아무것도 쓰지 않으므로 대화에 지시문을 주입하지 않습니다. `async` 훅이므로 추천 계산이 대화를 기다리게 하지 않습니다. `--env-file`은 훅 자식 프로세스에서만 키를 읽으며 Claude 메인 프로세스의 환경은 바꾸지 않습니다. Claude CLI와 데스크톱 Code 탭의 Jev 추천·앱 응답은 로컬 시험에서 확인했고 시험용 훅은 제거했습니다.

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
- Codex 요청의 대화 ID로 모델 상태를 분리합니다. 대화 ID가 없으면 이전 요청의 모델 상태를 물려받지 않고 기준 모델에서 시작합니다.
- 라우터는 Codex 전역 모델 설정이나 Claude 전역 훅을 자동으로 설치하지 않습니다. 데스크톱 연결을 수동으로 시험했다면 설정을 복원하고 앱을 재시작하세요. 기존 `ANTHROPIC_API_KEY` 환경 변수가 Claude 구독 인증보다 우선되는 경우에는 [인증 우선순위 안내](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code)를 확인하세요.

구체적인 단계별 통과 기준과 남은 검증은 [검증 계획](docs/validation-plan.md)에 있습니다.

## 참고 문서

- [Codex 사용자 정의 모델 공급자](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [TypeSafe Jev API](https://docs.typesafe.ai/api) · [모델/가격](https://docs.typesafe.ai/models)
- [Claude Code 훅](https://code.claude.com/docs/en/hooks) · [게이트웨이 연결](https://code.claude.com/docs/en/llm-gateway-connect)

Codex 프로토콜 연결 방식은 [jev-router](https://github.com/gargpratyush/jev-router)의 구현을 참고해 독립적으로 작성했습니다. Claude 구독 자격 증명 중계 방식은 채택하지 않았습니다.
