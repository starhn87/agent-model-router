# Agent Model Router

Codex와 Claude Code에서 모델과 effort를 자동 선택합니다.

## 설치

필요 항목: macOS, Node.js 22 이상, Codex 또는 Claude Code, TypeSafe API 키.

```bash
git clone https://github.com/starhn87/agent-model-router.git
cd agent-model-router
npm ci
cp -n .env.example .env
open -e .env
```

`.env`에 `TYPESAFE_API_KEY`를 입력하고 저장한 다음:

```bash
npm run setup
npm run doctor
```

Codex 앱을 재시작하고 새 작업에서 `Jev Auto`를 선택하세요. Claude Code는 새 세션을 시작하세요.

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

[설치 및 문제 해결](docs/installation.md) · [라우팅 규칙](docs/routing-policy.md) · [키 보관](docs/local-secrets.md) · [검증 기록](docs/validation-plan.md)
