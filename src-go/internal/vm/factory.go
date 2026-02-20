package vm

import (
	"fmt"
	"strings"

	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/vm/firecracker"
)

func NewBackendFromConfig(cfg config.Config) (Backend, error) {
	backendName := strings.ToLower(strings.TrimSpace(cfg.VMBackend))
	switch backendName {
	case "", BackendSimulated:
		return NewSimulatedBackend(cfg.FirecrackerBin), nil
	case BackendFirecracker:
		return firecracker.NewBackend(firecracker.Options{
			BinaryPath:  cfg.FirecrackerBin,
			StateDir:    cfg.VMStateDir,
			KernelImage: cfg.VMKernelImage,
			NetMode:     cfg.VMNetMode,
			StopTimeout: cfg.VMStopTimeout,
		})
	default:
		return nil, fmt.Errorf("unsupported VM backend %q", cfg.VMBackend)
	}
}
