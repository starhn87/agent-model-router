# 기억 후보 선별 실험

기존 검색기가 찾은 기억·문서 조각을 입력합니다. Jev는 기억을 저장하거나 검색하지 않고 **찾아온 후보의 읽기 순서만 제안**합니다.

```bash
npm run build
node --env-file=.env dist/cli.js memory-filter fixtures/memory-example.json --metrics .local/memory.jsonl
node dist/cli.js memory-report .local/memory.jsonl
```

입력은 `query`와 `candidates: [{id,text}]`입니다. `id`에는 경로나 원문 대신 임의의 짧은 값을 쓰세요. 후보가 5개 이하이면 Jev를 호출하지 않습니다. 후보가 20개를 넘거나 질문이 민감하면 기존 상위 8개를 유지합니다. 비밀·연락처 징후가 있는 개별 조각은 Jev에 보내지 않고 `unjudgedIds`에 남깁니다. 긴 조각은 앞뒤 450자만 Jev가 보므로 `clippedIds`를 확인하세요. `screening`이 `local-only`이거나 조각이 `unjudgedIds`에 있으면 Jev가 그 내용을 검토했다고 간주하지 마세요.

로컬 패턴과 Jev가 지시문처럼 보이는 조각을 표시하고 선택에서 제외하지만 완전한 보안 필터는 아닙니다. 선택된 조각도 외부 입력이라면 지시가 아닌 자료로 읽어야 합니다. 로그에는 원문·ID가 아닌 후보 수, 선택 수, 미검토 수, Jev 지연·토큰만 기록합니다.

사람이 실제 작업에 필요한 조각을 표시한 후 다음 명령으로 기존 상위 8개와 필터의 **필수 조각 재현율**을 비교할 수 있습니다. `resultIds`는 원래 검색 순서이며 `selectedIds`에는 실제 필터 출력을 옮겨 넣습니다.

```bash
node dist/cli.js memory-evaluate fixtures/memory-evaluation-example.json
```

이 평가는 조각 선택의 품질만 측정합니다. 최종 답변 품질과 전체 시간·비용은 동일 작업 비교로 검증해야 합니다. 예제는 합성 데이터입니다. 설치된 `agent-context-gates` 스킬은 기억 후보가 많은 경우 에이전트에게 이 명령을 호출하도록 안내합니다. 내장 기억 검색을 자동으로 가로채지는 않습니다.
