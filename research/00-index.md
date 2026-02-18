# NanoClaw Sandboxing Research Index

Last verified: 2026-02-18

This folder contains curated research supporting the Go microVM-first re-architecture.

## Documents
Confidence: 0.9

- `01-current-nanoclaw-boundaries.md`: Current codebase boundaries and migration-critical seams.
- `02-daytona-patterns.md`: Daytona architecture patterns to adopt or avoid.
- `03-oss-sandbox-comparison.md`: Comparison of E2B, OpenHands, Coder, CodeSandbox SDK, DevPod, Gitpod, Daytona.
- `04-hardening-control-matrix.md`: Implementable hardening controls with verification checks.
- `05-academic-findings-2020-2026.md`: Isolation/security research implications for agent sandboxes.
- `06-claim-validation-ledger.md`: Claim-by-claim validation status with confidence.
- `sources.json`: Structured source registry used by all documents.

## Validation Rules Applied
- Every claim is tagged as `Direct evidence` or `Inference`.
- Every section contains a `Confidence` score.
- External claims include explicit source links.
- All documents include the same verification date.

## Scope Summary
- Migration target: Go runtime under `src-go/`.
- Initial deployment target: single-host Docker control plane + host microVM supervisor.
- Isolation baseline: microVM-only for sandbox execution.
- Migration strategy: breaking contracts (versioned Go APIs replace TS RPC wire contracts).
- [Inference] This index aggregates decision-support research and should be re-verified before production hardening milestones.
