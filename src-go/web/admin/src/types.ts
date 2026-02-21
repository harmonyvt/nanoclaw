// Types matching Go backend contracts

export interface PathScope {
  path: string;
  mode: 'read' | 'write';
}

export interface EgressRule {
  host: string;
  port: number;
}

export interface ToolRule {
  name: string;
  allowed: boolean;
}

export interface SecretRule {
  ref: string;
  allowed: boolean;
}

export interface CapabilityPolicy {
  fs_scopes: PathScope[];
  egress_rules: EgressRule[];
  tool_rules: ToolRule[];
  secret_rules: SecretRule[];
}

export interface CredentialRefs {
  telegram_bot_token_ref: string;
  openai_api_key_ref: string;
}

export interface ResourceProfile {
  cpu: number;
  memory: number;
  pids: number;
}

export interface VMProfile {
  kernel_image: string;
  rootfs_image: string;
  vcpu: number;
  memory_mib: number;
}

export interface NetworkPolicy {
  default_deny: boolean;
  allow: EgressRule[];
}

export interface TaskRunSpec {
  task_id?: string;
  sandbox_id?: string;
  risk_class: string;
  capabilities: CapabilityPolicy;
  image_ref: string;
  credential_refs: CredentialRefs;
  secrets_ref?: string[];
  resource_profile: ResourceProfile;
  command?: string;
}

export interface SandboxSpec {
  sandbox_id: string;
  desired_state: string;
  vm_profile: VMProfile;
  network_policy: NetworkPolicy;
  credential_refs: CredentialRefs;
  ttl_seconds: number;
}

export interface SandboxStatus {
  sandbox_id: string;
  observed_state: string;
  health: string;
  backend?: string;
  vm_id?: string;
  pid?: number;
  api_socket?: string;
  last_exit_code?: number;
  snapshot_ref?: string;
  started_at?: string;
  last_heartbeat?: string;
  failure_reason?: string;
  snapshot_count: number;
  policy_digest?: string;
  kill_switch_note?: string;
}

export interface SandboxRecord {
  spec: SandboxSpec;
  status: SandboxStatus;
}

export interface SignedPolicyDecision {
  decision_id: string;
  issued_at: string;
  digest: string;
  signature: string;
  allowed: boolean;
  reason?: string;
}

export interface TaskRunResult {
  task_id: string;
  sandbox_id: string;
  status: string;
  output?: string;
  error?: string;
  policy: SignedPolicyDecision;
  started_at: string;
  completed_at: string;
}

export interface SessionCreateRequest {
  sandbox_id: string;
  command?: string;
}

export interface SessionInfo {
  session_id: string;
  sandbox_id: string;
  status: string;
  command: string;
  created_at: string;
  last_input_at: string;
}

export interface Event {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface RuntimeConfig {
  apiBasePath: string;
  buildVersion: string;
  hasBuiltUI: boolean;
}

export interface HealthStatus {
  ok: boolean;
  time: string;
  supervisor: {
    backend: string;
    healthy: boolean;
  };
}

export interface ApiError {
  error: string;
}

export interface ListResponse<T> {
  items: T[];
}
