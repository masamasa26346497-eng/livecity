# Mission 36L — Paid API approval policy

**Default: DENY.** Google Cloud billing being active is not permission to use a paid API.

Before **every individual paid execution**, the operator must show the owner:
- exact API/SKU and purpose;
- maximum requests, estimated yen per request, estimated total, and a conservative maximum estimated total;
- applicable Google Cloud project quota and remaining monthly budget;
- a one-time run identifier, with the intended expiry.

Only the owner's explicit approval **for that specific run and stated maximum estimated cost** permits it. No approval is inferred from a prior run, general agreement, enabled billing, workflow_dispatch, a GitHub push, or a configuration toggle. Approval is never reusable.

On approval, enforce the approved per-run request cap and estimated yen cap **before each paid call**. Reject if approval is missing, expired, malformed, or for another run; reject if billing prices or usage ledger are unknown. No paid fallback or retry may exceed the approved allowance. Record all attempted requests, including errors, and report estimated charges after the run. Actual invoicing is determined by Google Cloud billing, not this estimate.

**Current implementation status (2026-10-09):** rescue CLI remains hard-locked; this document defines policy, not a claim that an interactive approval enforcement system has been implemented. Do not unlock until durable ledger, exact one-run approval validation, quota controls, and offline tests are complete. Never store API keys or approval tokens in the repository.
