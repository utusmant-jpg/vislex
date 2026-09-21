# VisLex incident benchmark

This harness scores independently adjudicated outputs. It does not ask an LLM to decide whether its own answer is correct. Included synthetic files contain invented scorer inputs: they are neither VisLex measurements nor Harvey results.

Run the scorer and its regression tests:

```
python -m unittest discover -s benchmarks -v
python benchmarks/harness.py benchmarks/synthetic-truth.json benchmarks/synthetic-runs.json --candidate vislex --baseline baseline --output benchmarks/synthetic-score.json
```

Use the two JSON examples as the versioned interchange format. Freeze material facts before seeing system outputs. Each assertion is independently marked for source support, correct attribution, and contradiction accuracy. Record every assertion, including unsupported additions, not only matches to expected facts. Include failed runs and their incurred time/cost. Do not substitute a missing run with an empty successful run. A missing incident blocks comparative claims; an unavailable system remains untested.

For actual evaluation, create incident-level development and held-out splits, separating all recordings/documents from the same incident. Keep held-out labels unavailable to operators and model prompts. Use at least 30 held-out incidents with repeated runs under fixed configurations. Save build and dataset hashes, provider/model identifiers, prompts, permissions, model settings, tool budgets, final answer, tool receipts, failures, elapsed processing time, billed cost and reviewer correction time. Compare existing VisLex, a capable same-model baseline, direct-media processing, combined processing and actual competitor output only when legitimately available. Freeze settings and the protocol before held-out runs.

Reviewers should be blind to system identity. Resolve disagreements before scoring and retain both original judgments plus the adjudication record. Positive and negative findings both need source support. Correct expected facts with wrong attribution do not earn recall credit. Empty answers earn no precision credit. Duplicate paraphrases must not be counted as distinct recovered facts. Runtime, cost, review effort and failures are reported separately from quality.

Metrics are incident-macro averages. Repeats are averaged inside each incident; confidence intervals use paired incident-cluster bootstrap. The comparison reports candidate-minus-baseline differences, including undesirable differences where lower is better. Preregister `preregistered_targets` with `minimum_incidents`, `recall_gain`, `precision_margin`, and `review_time_reduction`; set `split` to `held_out`, `synthetic` to false, and record the preregistration artifact SHA-256. Defaults are provisional 0.15 recall gain at precision no more than 0.01 below baseline, and 0.40 reviewer-time reduction. The lower bootstrap bounds must pass these thresholds. Synthetic data, fewer than 30 incidents, mismatched repeat sets, or missing preregistration prevents a positive claim flag. The flag is an analysis aid, not independent validation of dataset integrity or reviewer judgment.

The current scorer measures material facts, attribution, unsupported statements, false contradictions, coverage honesty, review time, runtime and cost. Modality-specific timestamp error, ASR word error and short-event detection should be retained as separately adjudicated diagnostic outputs. No comparative result has been measured against Harvey.

## Capture real VisLex outputs

`capture.py` opens an explicitly selected case database read-only and exports selected stopped tasks and their receipts for blinded review. It refuses restricted or missing scoped sources and never reads provider credentials. The mapping file is an array of `{ "incident_id": "incident-a", "repeat": 1, "task_id": "..." }`. Use an external new output file; existing output is not overwritten.

```
python benchmarks/capture.py PATH_TO_CASE_DATABASE mapping.json --configuration "Build SHA; provider/model; tool settings; run protocol" --output captured-runs.json
```

The capture includes authorized case text. Keep it within the evaluation's approved storage. Reviewers create the scored assertion submission from captured answers and receipts. Measure billed cost and review duration separately rather than mistaking token-budget reservations for actual cost. No automatic factual score is fabricated from capture success.
