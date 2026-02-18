# Hardening Control Matrix for Agent Sandboxes

Last verified: 2026-02-18

## Control Matrix
Confidence: 0.89

| Area | Claim | Evidence Type | Implementation Direction | Sources |
|---|---|---|---|---|
| Egress control | Deny-by-default egress with explicit allowlist is baseline-safe. | Direct evidence | Default block + explicit destinations for DNS/package mirrors/internal APIs. | [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [Cilium Egress Gateway](https://docs.cilium.io/en/latest/network/egress-gateway/egress-gateway.html) |
| Filesystem isolation | Read-only rootfs + controlled writable mounts materially reduce tampering. | Direct evidence | Read-only guest rootfs + explicit writable paths only. | [Kubernetes SecurityContext](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/), [Docker run docs](https://docs.docker.com/reference/cli/docker/container/run/) |
| Identity and secrets | Short-lived projected identities and brokered secrets reduce static secret risk. | Direct evidence | Use ephemeral token exchange and revocable lease-based secret delivery. | [Projected volumes](https://kubernetes.io/docs/concepts/storage/projected-volumes/), [Service accounts](https://kubernetes.io/docs/concepts/security/service-accounts/) |
| Syscall hardening | `RuntimeDefault` seccomp + AppArmor/SELinux baseline should be enforced. | Direct evidence | Enforce profiles globally, permit exceptions only by policy approval. | [Kubernetes seccomp](https://kubernetes.io/docs/reference/node/seccomp/), [Kubernetes AppArmor](https://kubernetes.io/docs/tutorials/security/apparmor/) |
| Resource containment | cgroup v2 limits/freeze/kill are required for abuse containment. | Direct evidence | Set cpu/memory/pids budgets; expose kill-switch backed by cgroup controls. | [cgroup v2 docs](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) |
| Kill-switch workflow | Quarantine -> freeze -> terminate -> revoke is a practical emergency sequence. | Inference | Implement coordinated incident endpoint in supervisor/control plane. | (Inference from cgroup and policy control primitives above) |
| Auditability | API and host-level audit logs are needed for forensics. | Direct evidence | Structured event log + immutable sink + integrity checks. | [Kubernetes auditing](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/), [auditd.conf](https://man7.org/linux/man-pages/man5/auditd.conf.5.html) |

## Minimal Launch Baseline (Single Host)
Confidence: 0.84

- [Inference] For NanoClaw V1 on a single host, enforce these non-negotiables:
  - egress deny by default;
  - signed policy decisions per run;
  - sandbox-scoped resource caps;
  - session termination and secret revocation hooks;
  - immutable event trail with correlation IDs.

## Validation Checks
Confidence: 0.88

- [Inference] Each sandbox launch should fail closed when:
  - no egress allowlist exists;
  - capability policy is malformed;
  - signature verification fails;
  - secret lease is revoked/expired.
