# 측정과 비교

```bash
npm run build
node dist/cli.js report .local/codex-persistent.jsonl
```

새 로그의 `tasks`는 Codex 사용자 턴마다 만든 익명 ID로 후속 도구 요청을 묶습니다. `completedResponses`는 완료 메타데이터가 확인된 API 응답 수, `toolContinuations`는 그중 새 사용자 턴의 판정 요청이 아닌 후속 응답 수입니다. 토큰은 이 응답들의 실제 사용량 합계입니다. 응답 메타데이터가 없거나 요청이 실패하면 사용량에 포함되지 않습니다. 과거 로그에는 작업 ID가 없어서 `tasks`에 잡히지 않습니다.

`p50/p95RequestDurationMs`는 프록시가 요청을 받기 시작한 때부터 완료 메타데이터를 관찰할 때까지의 시간입니다. `p50/p95ObservedSpanMs`는 첫 판정 기록부터 마지막으로 관찰한 완료 응답까지의 간격으로, 실제 작업 완료 시간의 **하한**입니다. 작업 사이의 중단, 사용자의 확인 시간, 품질과 재시도 여부는 측정하지 않습니다. `estimatedJevUsd`는 Jev 입력 비용만이며 에이전트 모델의 청구 비용이 아닙니다.

## 기간 필터

`--since`에 날짜나 ISO 시각을 주면 그 이후 기록만 요약합니다. 정책을 바꾼 뒤의 결과만 보려면 변경 시각을 지정하세요.

```bash
node dist/cli.js report .local/codex-persistent.jsonl --since 2026-09-25T20:49:00+09:00
```

## fast 신뢰도 기준 shadow 실험

`serve`·`codex`에 `--shadow-fast-confidence 0.7`을 주면 Jev가 fast를 추천했지만 신뢰도 기준(또는 `--downgrade-confidence` 하향 기준)에 못 미친 턴에서, 기준이 0.7이었다면 선택됐을 모델을 판정 기록의 `shadowModel`·`shadowEffort`에 남깁니다. **실제 요청 모델은 바꾸지 않습니다.** 자동 설치는 이 옵션을 켭니다. `report`의 `shadow`는 해당 판정·작업·응답 수와, `--prices`가 있으면 같은 토큰을 실제 모델과 shadow 모델 단가로 계산한 `appliedUsd`·`shadowUsd`를 보여줍니다. shadow 모델이 같은 품질로 같은 토큰을 썼을 거라는 가정의 추정치이므로, 기준을 실제로 낮추기 전에 해당 작업 일부를 fast 모델로 다시 실행해 `compare-draft`와 품질 점수로 확인하세요.

## 에이전트 모델 비용 추정

`--prices`에 모델별 100만 토큰당 단가 파일을 주면 `agentCost`에 실제 응답 모델별 추정 비용과, 같은 토큰을 `referenceModel` 단가로 계산한 값 및 차이를 표시합니다. 단가는 이 프로젝트가 제공하지 않으므로 계정의 실제 요금으로 직접 채우세요. 예제 파일의 숫자는 합성값입니다. 기준 모델이 실제로 같은 토큰을 썼을 거라는 가정이므로 `estimatedSavingsUsd`는 추정치이며 청구 비용 비교를 대신하지 않습니다. 단가가 없는 모델의 응답은 `unpricedResponses`로 따로 셉니다. 날짜가 붙은 스냅샷(`…-20251001`)은 기본 모델 단가를 사용합니다.

```bash
cp fixtures/prices-example.json .local/prices.json
node dist/cli.js report .local/codex-persistent.jsonl --prices .local/prices.json
node dist/cli.js report .local/claude.jsonl --prices .local/prices.json
```

`jevErrorRate`는 Jev를 호출한 판정 중 실패 비율입니다. 10회 이상 호출에서 20% 이상 실패하면 `warnings`와 표준 오류에 경고를 출력합니다. 실패한 턴은 balanced 모델로 돌아가므로 절감 효과가 줄어듭니다.

정책 비교는 동일한 라벨 작업 묶음을 고정 모델과 자동 정책으로 각각 실행해 완료 여부, 품질, 사람의 재수정 횟수, 전체 경과 시간, 실제 청구 비용을 함께 기록해야 합니다. 현재 로그 하나만으로는 다른 모델을 사용했을 때의 결과나 절감률을 알 수 없습니다. 자동 정책의 캐시 사용률과 도구 요청 수를 먼저 관찰하고, 비교 실행 결과가 쌓인 뒤 캐시를 고려한 라우팅이나 검색 단계를 조정합니다.

비교 결과를 기록할 때는 예제 파일을 복사하고 같은 `id`의 `fixed`·`auto`에 각각 **실측값**을 입력하세요. `elapsedMs`는 작업 시작부터 검증까지 걸린 전체 시간, `billedUsd`는 실제 청구액, `qualityScore`는 실행 정책을 모르는 검토자가 매긴 0~5점입니다. `manualCorrections`는 사람이 추가로 수정한 횟수입니다. 작업별 청구액을 알 수 없으면 `billedUsd`를 `null`로 두세요. 이때 비용 비교도 `null`로 표시됩니다. 프롬프트와 결과 본문은 파일에 넣을 수 없습니다.

```bash
cp fixtures/comparison-example.json .local/comparison.json
node dist/cli.js compare .local/comparison.json
```

같은 작업 목록을 두 정책으로 **같은 순서로** 실행해 로그를 따로 남겼다면(예: Codex `--mode force --force-model gpt-6-sol --metrics .local/fixed.jsonl`과 `--mode auto --metrics .local/auto.jsonl`), `compare-draft`로 입력 파일 초안을 만들 수 있습니다. 작업 시작 순서대로 짝을 짓고 `completed`, `elapsedMs`(관찰 구간, 실제 작업 시간의 하한), `--prices`가 있으면 추정 `billedUsd`를 채웁니다. `qualityScore`와 `manualCorrections`는 `null`로 남으며, 검토자가 채우기 전에는 `compare`가 해당 작업을 거절합니다. 작업 수가 다르면 초안을 만들지 않습니다. 추정 비용은 청구서 금액으로 바꿔 넣는 것이 좋습니다.

```bash
node dist/cli.js compare-draft .local/fixed.jsonl .local/auto.jsonl --prices .local/prices.json --fixed-policy gpt-6-sol > .local/comparison.json
```

`compare`는 모델을 실행하지 않습니다. 두 정책은 같은 작업·검증 기준·코드 버전에서 실행하고, 실행 순서를 바꿔가며 캐시와 시간대 영향을 줄이세요. 결과의 비용·시간 변화율은 입력한 두 실행의 관측치 차이이며, 완료율과 품질 저하 건수를 함께 봐야 합니다. 예제 숫자는 합성 데이터이므로 실제 절감률을 나타내지 않습니다.
