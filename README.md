# Jev Agent Optimizer

Codex와 Claude Code에서 모델·effort를 자동 선택하고, 검색·기억 후보 선별을 돕습니다.
명령 이름은 `jao`입니다. 기존 설치는 `npm run setup`으로 새 플러그인 ID에 맞춰 갱신합니다.

## 설치

필요 항목: macOS, Node.js 22 이상, Codex 또는 Claude Code, TypeSafe API 키.

```bash
git clone https://github.com/starhn87/jev-agent-optimizer.git
cd jev-agent-optimizer
npm ci
cp -n .env.example .env
open -e .env
```

`.env`에 `TYPESAFE_API_KEY`를 입력하고 저장한 다음:

```bash
npm run setup
npm run doctor
```

CLI 명령을 직접 쓰려면 `npm link` 후 `jao doctor`를 실행하세요.

사용량 요약:

```bash
npm run build
node dist/cli.js report .local/codex-persistent.jsonl
node dist/cli.js compare fixtures/comparison-example.json
```

Codex 앱을 재시작하고 새 작업에서 `Jev Auto`를 선택하세요. Claude Code는 새 세션을 시작하세요.
응답 시작에 선택 모델·요청 effort가 표시됩니다. 실제 모델이 다를 때만 응답 끝에 알립니다.
설치 시 검색·기억 스킬도 연결됩니다. 후보가 5개를 넘고 에이전트가 스킬을 호출하면 Jev의 구조화된 응답으로 후보를 선별하고 `.local/search.jsonl` 또는 `.local/memory.jsonl`에 건수·시간 등을 기록합니다. 매 대화마다 자동 실행되거나 내장 검색·기억 도구를 가로채지는 않습니다.

한 앱만 설정하려면 다음을 사용하세요:

```bash
npm run setup -- codex
npm run setup -- claude
```

## 업데이트 및 제거

```bash
git pull --ff-only
npm ci
npm run setup
```

```bash
npm run disable
npm run disable -- codex
npm run disable -- claude
```

## 더 알아보기

[설치 및 문제 해결](docs/installation.md) · [라우팅 규칙](docs/routing-policy.md) · [측정과 비교](docs/measurement.md) · [키 보관](docs/local-secrets.md) · [검증 기록](docs/validation-plan.md)

검색 결과 선별 실험: [명령어](docs/search-gate.md)

기억 후보 선별 실험: [명령어](docs/memory-filter.md)
