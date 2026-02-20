package contracts

import "time"

// TaskRunSpec describes a single execution request.
type TaskRunSpec struct {
	TaskID          string           `json:"task_id,omitempty"`
	SandboxID       string           `json:"sandbox_id,omitempty"`
	RiskClass       string           `json:"risk_class"`
	Capabilities    CapabilityPolicy `json:"capabilities"`
	ImageRef        string           `json:"image_ref"`
	SecretsRef      []string         `json:"secrets_ref,omitempty"`
	ResourceProfile ResourceProfile  `json:"resource_profile"`
	Command         string           `json:"command,omitempty"`
}

// SandboxSpec defines desired sandbox state and isolation controls.
type SandboxSpec struct {
	SandboxID     string        `json:"sandbox_id"`
	DesiredState  string        `json:"desired_state"`
	VMProfile     VMProfile     `json:"vm_profile"`
	NetworkPolicy NetworkPolicy `json:"network_policy"`
	TTLSeconds    int           `json:"ttl_seconds"`
}

// SandboxStatus captures live sandbox state.
type SandboxStatus struct {
	SandboxID      string     `json:"sandbox_id"`
	ObservedState  string     `json:"observed_state"`
	Health         string     `json:"health"`
	Backend        string     `json:"backend,omitempty"`
	VMID           string     `json:"vm_id,omitempty"`
	PID            int        `json:"pid,omitempty"`
	APISocket      string     `json:"api_socket,omitempty"`
	LastExitCode   int        `json:"last_exit_code,omitempty"`
	SnapshotRef    string     `json:"snapshot_ref,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	LastHeartbeat  *time.Time `json:"last_heartbeat,omitempty"`
	FailureReason  string     `json:"failure_reason,omitempty"`
	SnapshotCount  int        `json:"snapshot_count"`
	PolicyDigest   string     `json:"policy_digest,omitempty"`
	KillSwitchNote string     `json:"kill_switch_note,omitempty"`
}

// CapabilityPolicy is attached to every run and sandbox decision.
type CapabilityPolicy struct {
	FSScopes    []PathScope  `json:"fs_scopes"`
	EgressRules []EgressRule `json:"egress_rules"`
	ToolRules   []ToolRule   `json:"tool_rules"`
	SecretRules []SecretRule `json:"secret_rules"`
}

type PathScope struct {
	Path string `json:"path"`
	Mode string `json:"mode"` // read|write
}

type EgressRule struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type ToolRule struct {
	Name    string `json:"name"`
	Allowed bool   `json:"allowed"`
}

type SecretRule struct {
	Ref     string `json:"ref"`
	Allowed bool   `json:"allowed"`
}

type ResourceProfile struct {
	CPU    int `json:"cpu"`
	Memory int `json:"memory"`
	Pids   int `json:"pids"`
}

type VMProfile struct {
	KernelImage string `json:"kernel_image"`
	RootFSImage string `json:"rootfs_image"`
	VCPU        int    `json:"vcpu"`
	MemoryMiB   int    `json:"memory_mib"`
}

type NetworkPolicy struct {
	DefaultDeny bool         `json:"default_deny"`
	Allow       []EgressRule `json:"allow"`
}

type SignedPolicyDecision struct {
	DecisionID string    `json:"decision_id"`
	IssuedAt   time.Time `json:"issued_at"`
	Digest     string    `json:"digest"`
	Signature  string    `json:"signature"`
	Allowed    bool      `json:"allowed"`
	Reason     string    `json:"reason,omitempty"`
}

type TaskRunResult struct {
	TaskID      string               `json:"task_id"`
	SandboxID   string               `json:"sandbox_id"`
	Status      string               `json:"status"`
	Output      string               `json:"output,omitempty"`
	Error       string               `json:"error,omitempty"`
	Policy      SignedPolicyDecision `json:"policy"`
	StartedAt   time.Time            `json:"started_at"`
	CompletedAt time.Time            `json:"completed_at"`
}

type SessionCreateRequest struct {
	SandboxID string `json:"sandbox_id"`
	Command   string `json:"command,omitempty"`
}

type SessionInfo struct {
	SessionID   string    `json:"session_id"`
	SandboxID   string    `json:"sandbox_id"`
	Status      string    `json:"status"`
	Command     string    `json:"command"`
	CreatedAt   time.Time `json:"created_at"`
	LastInputAt time.Time `json:"last_input_at"`
}

type Event struct {
	Type      string         `json:"type"`
	Timestamp time.Time      `json:"timestamp"`
	Payload   map[string]any `json:"payload"`
}
