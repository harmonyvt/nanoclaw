package firecracker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

type apiClient struct {
	socketPath string
	httpClient *http.Client
}

func newAPIClient(socketPath string) *apiClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
	}
	return &apiClient{
		socketPath: socketPath,
		httpClient: &http.Client{Transport: transport, Timeout: 5 * time.Second},
	}
}

func (c *apiClient) configureMachine(ctx context.Context, vcpu, memoryMiB int) error {
	if vcpu <= 0 {
		vcpu = 1
	}
	if memoryMiB <= 0 {
		memoryMiB = 256
	}
	payload := map[string]any{
		"vcpu_count":   vcpu,
		"mem_size_mib": memoryMiB,
		"smt":          false,
	}
	return c.put(ctx, "/machine-config", payload)
}

func (c *apiClient) configureBootSource(ctx context.Context, kernelImagePath string) error {
	payload := map[string]any{
		"kernel_image_path": kernelImagePath,
		"boot_args":         "console=ttyS0 reboot=k panic=1 pci=off",
	}
	return c.put(ctx, "/boot-source", payload)
}

func (c *apiClient) configureRootDrive(ctx context.Context, rootfsPath string) error {
	payload := map[string]any{
		"drive_id":       "rootfs",
		"path_on_host":   rootfsPath,
		"is_root_device": true,
		// Keep rootfs read-only in MVP to allow safe image sharing across VMs.
		"is_read_only": true,
	}
	return c.put(ctx, "/drives/rootfs", payload)
}

func (c *apiClient) startInstance(ctx context.Context) error {
	return c.put(ctx, "/actions", map[string]any{"action_type": "InstanceStart"})
}

func (c *apiClient) sendCtrlAltDel(ctx context.Context) error {
	return c.put(ctx, "/actions", map[string]any{"action_type": "SendCtrlAltDel"})
}

func (c *apiClient) createSnapshot(ctx context.Context, snapshotPath, memoryPath string) error {
	payload := map[string]any{
		"snapshot_type": "Full",
		"snapshot_path": snapshotPath,
		"mem_file_path": memoryPath,
	}
	return c.put(ctx, "/snapshot/create", payload)
}

func (c *apiClient) put(ctx context.Context, path string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://localhost"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if len(body) == 0 {
		return fmt.Errorf("firecracker api %s failed: status %d", path, resp.StatusCode)
	}
	return fmt.Errorf("firecracker api %s failed: status %d body=%s", path, resp.StatusCode, string(body))
}
