# Daytona Patterns Relevant to NanoClaw

Last verified: 2026-02-18

## Control Plane Composition
Confidence: 0.93

- [Direct evidence] Daytona OSS deployment includes API, Proxy, Runner, SSH Gateway, DB, Redis and support services in compose topology.
  - Sources: [OSS deployment doc](https://github.com/daytonaio/daytona/blob/main/apps/docs/src/content/docs/en/oss-deployment.mdx), [Compose file](https://github.com/daytonaio/daytona/blob/main/docker/docker-compose.yaml)
- [Direct evidence] The latest release at verification time is `v0.143.0` published on 2026-02-13.
  - Source: [GitHub releases latest API](https://api.github.com/repos/daytonaio/daytona/releases/latest)

## Desired vs Observed State Reconciliation
Confidence: 0.9

- [Direct evidence] Sandbox manager code operates on state enums and desired state transitions, with periodic processing and retries.
  - Sources: [sandbox.manager.ts](https://github.com/daytonaio/daytona/blob/main/apps/api/src/sandbox/managers/sandbox.manager.ts), [job.service.ts](https://github.com/daytonaio/daytona/blob/main/apps/api/src/sandbox/services/job.service.ts)
- [Inference] NanoClaw should adopt a similar reconciler model for robust convergence and drift healing.
  - Supporting source context: same files above.

## Networking and Enforcement Patterns
Confidence: 0.92

- [Direct evidence] Daytona runner netrules implementation manages `iptables` chains and `DOCKER-USER` insertions.
  - Sources: [netrules package](https://github.com/daytonaio/daytona/tree/main/apps/runner/pkg/netrules), [set.go](https://github.com/daytonaio/daytona/blob/main/apps/runner/pkg/netrules/set.go), [netrules.go](https://github.com/daytonaio/daytona/blob/main/apps/runner/pkg/netrules/netrules.go)
- [Inference] NanoClaw can reuse the reconciliation pattern while replacing Docker-coupled networking with microVM-aware network enforcement.
  - Supporting context: Daytona netrules are Docker chain-specific.

## Session and Tooling Model
Confidence: 0.88

- [Direct evidence] Daytona provides PTY and session-oriented tooling paths in docs and daemon components.
  - Sources: [PTY docs](https://github.com/daytonaio/daytona/blob/main/apps/docs/src/content/docs/en/pty.mdx), [daemon session package](https://github.com/daytonaio/daytona/tree/main/apps/daemon/pkg/session)
- [Inference] NanoClaw should separate session gateway concerns from sandbox lifecycle control for clearer failure domains.
  - Supporting context: multi-service separation in Daytona architecture docs.

## Adopt vs Avoid
Confidence: 0.9

- [Inference] Adopt:
  - State-machine driven reconciler loop.
  - Job-oriented control/worker contract.
  - Explicit lifecycle transitions and health monitoring.
- [Inference] Avoid direct copy of:
  - Docker/iptables assumptions in runner netrules.
  - Internal service-specific queue patterns without evaluating fit to NanoClaw constraints.
