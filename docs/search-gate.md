# 검색 결과 선별 실험

검색 도구가 반환한 결과를 `id`, `title`, `url`, `snippet`으로 전달합니다. `id`는 URL이나 경로가 아닌 임의의 짧은 값이어야 합니다. 검색과 페이지 읽기는 기존 도구가 수행하며, 이 명령은 **다음 행동을 제안**합니다.

```bash
npm run build
node --env-file=.env dist/cli.js search fixtures/search-example.json --metrics .local/search.jsonl
node dist/cli.js search-report .local/search.jsonl
```

`search`는 Jev를 최대 두 번 호출합니다. 첫 호출은 결과의 관련성을 매기고, 두 번째는 선택한 결과의 근거가 충분한지와 후보 검색어 중 무엇을 시도할지 판단합니다. 후보 검색어는 에이전트가 작성해야 합니다. 결과가 5개 이하이거나 민감정보 징후가 있으면 Jev를 호출하지 않습니다. URL과 원래 결과 ID는 Jev에 전송하지 않으며, 질문·제목·요약은 전송할 수 있으므로 비공개 자료를 넣지 마세요. 흔한 지시문 형태는 로컬에서 표시하고 후보에서 제외하지만, 이는 모든 프롬프트 인젝션을 찾아낸다는 뜻이 아닙니다. `status`가 `unknown` 또는 `partial`이면 충분성 판단이 없으므로 일반 검색 판단을 계속하세요.

`--metrics` 로그에는 원문, URL, ID가 아닌 결과 수·선택 수·Jev 호출 및 토큰 수·지연만 남습니다. 사람은 실제 검색 결과를 검토해 필수 출처의 ID를 표시한 뒤 다음 명령으로 기본 상위 5개와 선별 결과의 필수 출처 재현율을 비교할 수 있습니다.

```bash
node dist/cli.js search-evaluate fixtures/search-evaluation-example.json
```

이 평가는 **검색 결과 선택의 품질**만 다룹니다. 최종 답의 정확성과 전체 작업 시간은 별도의 동일 작업 비교가 필요합니다. 예제의 질문과 결과는 합성 데이터입니다. 현재 Codex·Claude Code의 내장 검색을 자동으로 가로채지는 않습니다.
