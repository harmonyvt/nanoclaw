package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	APIListenAddr     string
	SessionListenAddr string
	SupervisorAddr    string
	StateFile         string
	PolicySigningKey  string
	AdminEnabled      bool
	AdminToken        string
	AdminDistDir      string
	AdminBuildVersion string

	VMBackend      string
	FirecrackerBin string
	VMStateDir     string
	VMKernelImage  string
	VMNetMode      string
	VMStopTimeout  time.Duration
}

func Load() Config {
	firecrackerBin := getenv("NANOCLAW_GO_FIRECRACKER_BIN", "")
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("NANOCLAW_GO_VM_BACKEND")))
	if backend == "" {
		backend = "firecracker"
	}

	cfg := Config{
		APIListenAddr:     getenv("NANOCLAW_GO_API_ADDR", ":8088"),
		SessionListenAddr: getenv("NANOCLAW_GO_SESSION_ADDR", ":8089"),
		SupervisorAddr:    getenv("NANOCLAW_GO_SUPERVISOR_ADDR", ":8071"),
		StateFile:         getenv("NANOCLAW_GO_STATE_FILE", ""),
		PolicySigningKey:  getenv("NANOCLAW_GO_POLICY_KEY", "nanoclaw-dev-signing-key"),
		AdminEnabled:      getenvBool("NANOCLAW_GO_ADMIN_ENABLED", true),
		AdminToken:        strings.TrimSpace(os.Getenv("NANOCLAW_GO_ADMIN_TOKEN")),
		AdminDistDir:      getenv("NANOCLAW_GO_ADMIN_DIST_DIR", "web/admin/dist"),
		AdminBuildVersion: getenv("NANOCLAW_GO_BUILD_VERSION", "dev"),
		VMBackend:         backend,
		FirecrackerBin:    firecrackerBin,
		VMStateDir:        getenv("NANOCLAW_GO_VM_STATE_DIR", filepath.Join(os.TempDir(), "nanoclaw-go-vm")),
		VMKernelImage:     getenv("NANOCLAW_GO_VM_KERNEL_IMAGE", ""),
		VMNetMode:         strings.ToLower(strings.TrimSpace(getenv("NANOCLAW_GO_VM_NET_MODE", "none"))),
		VMStopTimeout:     time.Duration(getenvInt("NANOCLAW_GO_VM_STOP_TIMEOUT_MS", 10000)) * time.Millisecond,
	}
	if cfg.VMStopTimeout <= 0 {
		cfg.VMStopTimeout = 10 * time.Second
	}
	if cfg.VMNetMode == "" {
		cfg.VMNetMode = "none"
	}
	return cfg
}

func getenv(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func getenvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvBool(key string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
