package policy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

type Engine struct {
	signingKey    []byte
	mu            sync.RWMutex
	revokedSecret map[string]time.Time
}

func NewEngine(signingKey string) *Engine {
	return &Engine{
		signingKey:    []byte(signingKey),
		revokedSecret: map[string]time.Time{},
	}
}

func (e *Engine) Evaluate(spec contracts.TaskRunSpec) contracts.SignedPolicyDecision {
	decision := contracts.SignedPolicyDecision{
		DecisionID: "pol-" + fmt.Sprintf("%d", time.Now().UnixNano()),
		IssuedAt:   time.Now().UTC(),
		Allowed:    true,
	}

	if spec.RiskClass == "" {
		decision.Allowed = false
		decision.Reason = "risk_class is required"
	}

	if len(spec.Capabilities.EgressRules) == 0 {
		decision.Allowed = false
		decision.Reason = "egress rules required for deny-by-default policy"
	}

	for _, secret := range spec.SecretsRef {
		if e.IsSecretRevoked(secret) {
			decision.Allowed = false
			decision.Reason = "secret lease revoked"
			break
		}
	}

	digest, sig := e.signPayload(spec, decision)
	decision.Digest = digest
	decision.Signature = sig
	return decision
}

func (e *Engine) IsPathAllowed(policy contracts.CapabilityPolicy, target string, write bool) bool {
	clean := filepath.Clean(target)
	for _, scope := range policy.FSScopes {
		base := filepath.Clean(scope.Path)
		if !strings.HasPrefix(clean, base) {
			continue
		}
		if write && scope.Mode != "write" {
			continue
		}
		return true
	}
	return false
}

func (e *Engine) IsEgressAllowed(policy contracts.CapabilityPolicy, host string, port int) bool {
	for _, rule := range policy.EgressRules {
		if rule.Port != 0 && rule.Port != port {
			continue
		}
		if rule.Host == host || rule.Host == "*" || strings.HasPrefix(host, strings.TrimPrefix(rule.Host, "*.")) {
			return true
		}
	}
	return false
}

func (e *Engine) RevokeSecret(ref string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.revokedSecret[ref] = time.Now().UTC()
}

func (e *Engine) IsSecretRevoked(ref string) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	_, ok := e.revokedSecret[ref]
	return ok
}

func (e *Engine) VerifySignature(spec contracts.TaskRunSpec, decision contracts.SignedPolicyDecision) bool {
	digest, sig := e.signPayload(spec, decision)
	return hmac.Equal([]byte(decision.Digest), []byte(digest)) && hmac.Equal([]byte(decision.Signature), []byte(sig))
}

func (e *Engine) signPayload(spec contracts.TaskRunSpec, decision contracts.SignedPolicyDecision) (string, string) {
	payload := map[string]any{
		"task_spec":   spec,
		"allowed":     decision.Allowed,
		"reason":      decision.Reason,
		"decision_id": decision.DecisionID,
		"issued_at":   decision.IssuedAt.Format(time.RFC3339Nano),
	}
	raw, _ := json.Marshal(payload)
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])

	mac := hmac.New(sha256.New, e.signingKey)
	_, _ = mac.Write([]byte(digest))
	signature := hex.EncodeToString(mac.Sum(nil))
	return digest, signature
}
