package config

import (
	"os"
	"strconv"
)

type Config struct {
	APIListenAddr     string
	SessionListenAddr string
	SupervisorAddr    string
	StateFile         string
	PolicySigningKey  string
	FirecrackerBin    string
	EnableSimulatedVM bool
}

func Load() Config {
	cfg := Config{
		APIListenAddr:     getenv("NANOCLAW_GO_API_ADDR", ":8088"),
		SessionListenAddr: getenv("NANOCLAW_GO_SESSION_ADDR", ":8089"),
		SupervisorAddr:    getenv("NANOCLAW_GO_SUPERVISOR_ADDR", ":8071"),
		StateFile:         getenv("NANOCLAW_GO_STATE_FILE", ""),
		PolicySigningKey:  getenv("NANOCLAW_GO_POLICY_KEY", "nanoclaw-dev-signing-key"),
		FirecrackerBin:    getenv("NANOCLAW_GO_FIRECRACKER_BIN", ""),
		EnableSimulatedVM: getenvBool("NANOCLAW_GO_SIMULATED_VM", true),
	}
	if cfg.FirecrackerBin != "" {
		cfg.EnableSimulatedVM = false
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

func getenvBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}
