# Claim Validation Ledger

Last verified: 2026-02-18

## Category A: Daytona Architecture Claims
Confidence: 0.9

- Claim: Daytona release `v0.143.0` on 2026-02-13.
  - Status: [Direct evidence]
  - Source: [GitHub releases latest API](https://api.github.com/repos/daytonaio/daytona/releases/latest)
- Claim: API/Proxy/Runner service decomposition exists in OSS deployment docs.
  - Status: [Direct evidence]
  - Source: [OSS deployment doc](https://github.com/daytonaio/daytona/blob/main/apps/docs/src/content/docs/en/oss-deployment.mdx)
- Claim: Desired/observed state lifecycle management is used for sandboxes.
  - Status: [Direct evidence]
  - Source: [sandbox.manager.ts](https://github.com/daytonaio/daytona/blob/main/apps/api/src/sandbox/managers/sandbox.manager.ts)
- Claim: Daytona networking controls are Docker/iptables-centric.
  - Status: [Direct evidence]
  - Source: [runner netrules package](https://github.com/daytonaio/daytona/tree/main/apps/runner/pkg/netrules)

## Category B: OSS Platform Comparison Claims
Confidence: 0.88

- Claim: OpenHands process mode has no sandbox isolation.
  - Status: [Direct evidence]
  - Source: [OpenHands process sandbox docs](https://docs.openhands.dev/openhands/usage/sandboxes/process)
- Claim: E2B supports internet access disablement.
  - Status: [Direct evidence]
  - Source: [E2B internet access docs](https://e2b.dev/docs/sandbox/internet-access)
- Claim: CodeSandbox SDK states microVM backing and fast restore/clone.
  - Status: [Direct evidence]
  - Source: [CodeSandbox SDK README](https://github.com/codesandbox/codesandbox-sdk)
- Claim: DevPod isolation depends on provider/backend.
  - Status: [Inference]
  - Source context: [DevPod provider docs](https://devpod.sh/docs/managing-providers/what-are-providers)

## Category C: Hardening Matrix Claims
Confidence: 0.9

- Claim: Deny-by-default egress and explicit allowlist are baseline controls.
  - Status: [Direct evidence]
  - Sources: [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [Cilium Egress Gateway](https://docs.cilium.io/en/latest/network/egress-gateway/egress-gateway.html)
- Claim: RuntimeDefault seccomp/AppArmor controls should be mandatory baseline.
  - Status: [Direct evidence]
  - Sources: [Kubernetes seccomp](https://kubernetes.io/docs/reference/node/seccomp/), [Kubernetes AppArmor](https://kubernetes.io/docs/tutorials/security/apparmor/)
- Claim: Kill-switch choreography can be composed from cgroup and policy primitives.
  - Status: [Inference]
  - Source context: [cgroup v2 docs](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)

## Category D: Academic Claims
Confidence: 0.8

- Claim: MicroVM security posture still requires additional hardening and threat-model clarity.
  - Status: [Direct evidence]
  - Sources: [Attacks are Forwarded](https://www.usenix.org/conference/usenixsecurity23/presentation/xiao-jietao), [Microarchitectural Security of Firecracker](https://arxiv.org/abs/2311.15999)
- Claim: Capability-based and deterministic policy models improve agent tool safety.
  - Status: [Direct evidence]
  - Sources: [CAP-VMs](https://www.usenix.org/conference/osdi22/presentation/sartakov), [CaMeL](https://arxiv.org/abs/2503.18813), [Progent](https://arxiv.org/abs/2504.11703), [MiniScope](https://arxiv.org/abs/2512.11147)
- Claim: Runtime syscall mediation via eBPF is promising but design-specific.
  - Status: [Direct evidence]
  - Sources: [BPFContain](https://arxiv.org/abs/2102.06972), [Optimus](https://link.springer.com/article/10.1186/s13677-024-00639-3)

## Weak or Time-Sensitive Claims
Confidence: 0.76

- [Inference] Vendor startup-latency claims (e.g., sub-second startup) are documentation statements and should be treated as benchmark hypotheses until measured in NanoClaw environment.
- [Inference] Multi-tenant governance comparisons across vendors vary by deployment mode and should be re-validated before production hardening commitments.
