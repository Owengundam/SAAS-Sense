# JEV integration and rollout policy

## Status

The TypeSafe JEV adapter, shadow reader, and JEV-primary/DeepSeek-fallback cascade are implemented locally. No live TypeSafe request has been made, and JEV is not enabled by default.

## Decision flow

1. Accept usable structured supplier availability through the existing deterministic path.
2. Otherwise preserve captured page text and structured fields as separate evidence records.
3. Generate bounded evidence candidates with origin, source URL, snapshot ID, field path or page offsets.
4. JEV stage 1 independently selects evidence, checks exact product identity, and checks whether relevant availability statements conflict.
5. Code retrieves the selected evidence and surrounding captured context.
6. JEV stage 2 independently checks whether that evidence applies to the monitored product/variant and classifies availability.
7. The application applies provider-specific probability and native-confidence gates.
8. Recoverable failures may receive one DeepSeek interpretation. Hard evidence/identity failures may not.
9. One page capture creates at most one observation; two model opinions never satisfy temporal change confirmation.

## Fallback policy

| Primary outcome | DeepSeek fallback |
|---|---|
| TypeSafe timeout, HTTP failure, invalid response | Allowed |
| Relevant evidence exists but interpretation misses the provisional threshold | Allowed |
| No relevant availability evidence | Blocked; return unknown |
| Strong product or variant mismatch | Blocked; require review |
| Strong contradictory evidence | Blocked; require review |
| Candidate preparation was truncated and no candidate was selected | Blocked; repair retrieval first |
| Accepted JEV factual decision | Not called |

Rejected, low-confidence JEV guesses do not veto a later accepted DeepSeek fallback. Two accepted, evidence-supported decisions are never solicited merely to vote on the same capture.

## Confidence policy

JEV returns both a winning-option probability and a native confidence statistic describing the probability distribution. SupplierSignal stores both. The application-level observation confidence for an accepted JEV decision is the minimum winning probability across evidence selection, page identity, evidence identity, and availability; it is not JEV's native confidence.

Initial thresholds are deliberately provisional and must not be loosened without a labeled evaluation:

| Decision | Winning probability | Native confidence |
|---|---:|---:|
| Evidence candidate | 0.80 | 0.50 |
| Product/variant identity | 0.90 | 0.60 |
| Availability | 0.90 | 0.60 |
| Contradiction veto | 0.90 | 0.60 |

## Configuration

```text
AI_READER_MODE=deepseek
JEV_API_KEY=
TYPESAFE_MODEL=jev-1.13.0
SILICONFLOW_API_KEY=
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
SILICONFLOW_ENDPOINT=https://api.siliconflow.com/v1/chat/completions
```

- `deepseek`: existing behavior and safe default.
- `jev-shadow`: DeepSeek remains authoritative; JEV results are stored for comparison.
- `jev-primary`: accepted JEV decisions are authoritative; DeepSeek is a bounded backup for recoverable failures.
- `TYPESAFE_API_KEY` remains supported as a compatibility alias for `JEV_API_KEY`.
- When `JEV_API_KEY` is present and `AI_READER_MODE` is omitted, the service selects `jev-shadow`; an explicit mode always wins.

## Promotion gate

Run JEV shadow mode on the same saved captures used by the current reader. Labels must come from independent review, not DeepSeek. Report correctness, usable coverage, fallback behavior, false factual transitions, latency, timeouts, tokens, and provider cost.

JEV should not become primary until it has:

- zero false factual transitions in the pilot evaluation set;
- useful coverage rather than merely returning unknown;
- no accepted product/variant mismatches;
- reproducible evidence provenance for every accepted fact;
- bounded fallback and measured whole-pipeline cost/latency;
- successful tests on authorized real supplier pages.
