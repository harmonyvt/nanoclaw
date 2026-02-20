package firecracker

import (
	"context"
	"fmt"

	"github.com/harmony/nanoclaw/src-go/internal/contracts"
)

func (b *Backend) configureNetworking(_ context.Context, _ contracts.SandboxSpec, _ *runtimeState) error {
	switch b.opts.NetMode {
	case NetModeNone:
		// Intentionally no network devices attached.
		return nil
	case NetModeTap:
		return fmt.Errorf("firecracker net mode %q is not implemented", NetModeTap)
	default:
		return fmt.Errorf("unsupported firecracker net mode %q", b.opts.NetMode)
	}
}
