# Academic Findings (2020-2026)

Last verified: 2026-02-18

## MicroVMs vs Containers
Confidence: 0.82

- [Direct evidence] Research indicates meaningful security/performance tradeoffs between isolation techniques rather than universal dominance of one approach.
  - Sources: [Blending Containers and VMs (VEE 2020, Crossref record)](https://api.crossref.org/works/10.1145/3381052.3381315), [Attacks are Forwarded (USENIX Security 2023)](https://www.usenix.org/conference/usenixsecurity23/presentation/xiao-jietao)
- [Direct evidence] MicroVM deployments can still carry microarchitectural risks if not additionally hardened.
  - Source: [Microarchitectural Security of Firecracker (arXiv)](https://arxiv.org/abs/2311.15999)
- [Inference] NanoClaw should treat microVM as necessary but not sufficient and retain explicit policy/telemetry enforcement.

## Capability-Oriented Agent Security
Confidence: 0.79

- [Direct evidence] Capability-focused systems work supports fine-grained privilege boundaries.
  - Source: [CAP-VMs (OSDI 2022)](https://www.usenix.org/conference/osdi22/presentation/sartakov)
- [Direct evidence] Recent agent-security papers emphasize deterministic capability boundaries against prompt/tool abuse.
  - Sources: [CaMeL](https://arxiv.org/abs/2503.18813), [Progent](https://arxiv.org/abs/2504.11703), [MiniScope](https://arxiv.org/abs/2512.11147)
- [Inference] NanoClaw policy engine should be capability-first and not rely on natural-language prompt constraints.

## Syscall and Runtime Mediation
Confidence: 0.74

- [Direct evidence] eBPF and syscall-policy systems show practical value for adaptive runtime controls.
  - Sources: [BPFContain](https://arxiv.org/abs/2102.06972), [Optimus](https://link.springer.com/article/10.1186/s13677-024-00639-3), [BPFGuard](https://doi.org/10.1109/TCC.2025.3551838)
- [Inference] NanoClaw should architect for pluggable runtime mediation, even if initial release uses simpler static controls.

## Practical Design Implications for NanoClaw
Confidence: 0.81

- [Inference] Use microVM-only task execution with signed capability policies.
- [Inference] Pair static defaults (deny egress, constrained FS, quotas) with event-driven kill-switch.
- [Inference] Preserve a low-trust control path where each action is verifiable and replayable from audit logs.
