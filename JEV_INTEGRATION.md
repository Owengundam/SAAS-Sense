# JEV integration and rollout policy

## Status

Production was last verified at `c76f563` in `jev-shadow` mode with DeepSeek authoritative. The corrected 300-case synthetic evaluation produced 293/300 correct effective cascade outcomes, 168/175 accepted factual outcomes, and zero incorrect accepted results. The bounded Lighting Supply evaluation then produced 5/5 correct JEV-cascade outcomes, versus 4/5 for DeepSeek alone, with zero false factual results after capture-time relabeling. See `AI_SYNTHETIC_300_EVALUATION_2026-09-21.md` and `REAL_SUPPLIER_EVALUATION_2026-09-22.md` for limitations and reproduction. The exact-host `jev-validated` promotion mode is implemented locally but has not been deployed or enabled. A configured JEV key still selects shadow mode when no explicit mode is set.

## Decision flow

1. Accept usable structured supplier availability through the existing deterministic path.
2. Otherwise preserve captured page text and structured fields as separate evidence records.
3. Generate bounded evidence candidates with origin, source URL, snapshot ID, field path or page offsets. JEV v2 groups adjacent captured text into verbatim windows without merging across blank paragraphs or structured-field boundaries.
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
JEV_PRIMARY_DOMAINS=
AI_FALLBACK_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
```

SiliconFlow remains available as an explicit rollback:

```text
AI_FALLBACK_PROVIDER=siliconflow
SILICONFLOW_API_KEY=
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
SILICONFLOW_ENDPOINT=https://api.siliconflow.com/v1/chat/completions
```

- `deepseek`: existing behavior and safe default.
- `jev-shadow`: DeepSeek remains authoritative; JEV results are stored for comparison.
- `jev-validated`: JEV is primary only when the source hostname is an exact member of `JEV_PRIMARY_DOMAINS`; other sources keep DeepSeek authoritative and JEV shadowed.
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

The synthetic and bounded real-page evaluations cleared their current correctness and safety checks. The real-page sample is still one public domain, four in-stock products, and one backorder; it does not establish supplier permission for recurring commercial monitoring. Before allowlisting `lightingsupply.com`, repeat the capture in an independent window and add current out-of-stock, preorder, or discontinued evidence. The next promotion stage remains `jev-validated`, with exact-host allowlisting and persisted routing provenance. It is not a global production switch.
