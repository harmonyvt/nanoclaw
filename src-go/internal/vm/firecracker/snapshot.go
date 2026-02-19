package firecracker

import (
	"context"
	"path/filepath"
	"time"
)

func (b *Backend) createSnapshot(ctx context.Context, rt *runtimeState) (snapshotRef string, err error) {
	snapshotDir := filepath.Join(rt.runtimeDir, "snapshots")
	if err := ensureDir(snapshotDir); err != nil {
		return "", err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	snapshotPath := filepath.Join(snapshotDir, stamp+".snapshot")
	memoryPath := filepath.Join(snapshotDir, stamp+".mem")
	client := newAPIClient(rt.apiSocket)
	if err := client.createSnapshot(ctx, snapshotPath, memoryPath); err != nil {
		return "", err
	}
	return snapshotPath, nil
}
