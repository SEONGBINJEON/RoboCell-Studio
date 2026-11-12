# RoboCell Bedrock API

Python 3.12 standard-library HTTP server with pinned boto3. It binds **127.0.0.1:8000**; Nginx serves `/var/www/robocell` and proxies the three AI routes. No GPU control proxy exists. EC2 instance-role credentials are used through boto3's default chain. Do not add AWS access keys, private SSH keys or uploaded company documents to the repository.

## API

- `GET /api/ai/status`: configuration, last real model-call check, model/provider, limits and data handling. `configured` alone does not mean a call has succeeded. GET never invokes the model.
- `POST /api/ai/assist`: `{question, context}`.
- `POST /api/ai/report`: `{context}`.
- Context: `{layout, projectEvidence?, runEvidence?, planningReview?, diagnostics?}`. The layout is required. Unknown fields, raw documents/CSV/logs, shell commands and private server paths are not forwarded.
- Success: `{mode:"llm", answer, citations:[{evidence_id,field}], unverified, provider, model, request_id, input_hash, generated_at, usage, evidence_ids, validation:"not_assessed", kind}`.
- Errors: non-2xx `{mode:"error", error:{code,message}, message}`. Unconfigured/unavailable models never produce a fabricated AI answer.
- Known citation IDs: `layout`, `layout_metrics`, `run_evidence`, `input_evidence`, `planning_review`, `diagnostics`. Invalid model citations are removed and noted.
- Supplied run metrics require matching job identifiers and a full matching request layout. They remain client-provided records, not independently fetched/attested server results.
- Diagnostic context preserves up to 40 equipment summaries, including baselines and per-signal minimum/maximum/latest/event counts, plus the stated layout-association limitations. At most 40 supplied events are selected evenly across the received event list. `context_limits` distinguishes reported total, frontend omissions, backend omissions and transmitted details; omitted events are never described as fully analyzed. Raw CSV rows are excluded.
- Diagnostic display names are added only for exact identifiers in the current normalized layout. This is label association, not physical sensor attribution. Model instructions prohibit invented labels, inferred production feasibility and arithmetic restatements; these instructions do not validate model claims. Use deterministic diagnostic tables for exact quantities and treat AI causes and checks as proposals requiring review.

Same-origin JSON POSTs only. Public requests remain subject to bounded anonymous-demo quotas: 6/client/minute, 30/client/UTC day, 300 global requests/day, 2M global tokens/day, two concurrent model calls. SQLite quota reservations survive restarts and retain conservative reservations after uncertain upstream failures. Nginx additionally limits API bursts. Request/response content is not stored or logged; the database stores counts, time and hashed client identifiers. Model status stores only capability metadata.

Model output is capped at 1800 tokens for assist and 2400 for reports. The prompt requests concise Korean answers with at most five citations and three missing-evidence items. A Bedrock `max_tokens` stop is returned explicitly as `model_output_truncated`; partial JSON is never repaired into a purported complete answer. Only stop/usage metadata, never user content, is logged for this failure. Both successful and truncated calls settle the persistent quota with the actual supplied token usage.

## Prepare and verify

```sh
python3 -m venv /home/ubuntu/robocell/.venv
/home/ubuntu/robocell/.venv/bin/pip install -r server/requirements.txt
/home/ubuntu/robocell/.venv/bin/python -m unittest discover -s server -p 'test_*.py' -v
cp server/robocell.env.example server/robocell.env
# Review public origins and static path; this file contains configuration, not credentials.
set -a; . server/robocell.env; set +a
.venv/bin/python server/app.py --check-model
.venv/bin/python server/app.py
```

The explicit administrator CLI probe makes a small real Bedrock request. HTTP status endpoints cannot trigger paid probes. Service readiness should include one real grounded answer, cross-origin rejection, missing-data rejection and public GPU-control rejection.

Install the reviewed `robocell.service` and `nginx-robocell.conf` only after the prepared static site and loopback backend pass checks. The service uses read-only system/home protection and a single writable data directory. Enable Nginx HTTPS after a suitable hostname/certificate is available; update `ROBOCELL_PUBLIC_ORIGINS` to the exact deployed origins. The competition's global inference profile may process data outside the source Mumbai region; the status response states this.

## Official references

- [Bedrock Converse boto3 API](https://docs.aws.amazon.com/boto3/latest/reference/services/bedrock-runtime/client/converse.html): `messages`, `system`, inference bounds and token usage.
- [AWS Claude Haiku 4.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html): exact global inference-profile identifier and Mumbai source-region support.

Verified on 2026-11-12 using the team-provided instance role. No IAM resources or AWS keys are provisioned by this server.
