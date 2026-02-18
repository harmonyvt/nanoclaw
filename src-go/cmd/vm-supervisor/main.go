package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/contracts"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func main() {
	cfg := config.Load()
	sup := vm.NewSupervisor(cfg.EnableSimulatedVM, cfg.FirecrackerBin)

	mux := http.NewServeMux()
	newSandbox := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var spec contracts.SandboxSpec
		if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		if spec.SandboxID == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "sandbox_id is required"})
			return
		}
		status := sup.CreateSandbox(spec)
		_ = json.NewEncoder(w).Encode(map[string]any{"spec": spec, "status": status})
	}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "summary": sup.Summary()})
	})
	mux.HandleFunc("/v1/supervisor/sandboxes", func(w http.ResponseWriter, r *http.Request) {
		newSandbox(w, r)
	})
	mux.HandleFunc("/v1/supervisor/sandboxes/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/v1/supervisor/sandboxes/")
		if path == "" {
			newSandbox(w, r)
			return
		}

		if !strings.Contains(path, ":") {
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			status, err := sup.GetStatus(path)
			if err != nil {
				if errors.Is(err, vm.ErrSandboxNotFound) {
					w.WriteHeader(http.StatusNotFound)
				} else {
					w.WriteHeader(http.StatusInternalServerError)
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			_ = json.NewEncoder(w).Encode(status)
			return
		}

		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		parts := strings.SplitN(path, ":", 2)
		if len(parts) != 2 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "expected /v1/supervisor/sandboxes/{id}:{action}"})
			return
		}
		id, action := parts[0], parts[1]
		ctx := context.Background()
		var (
			status contracts.SandboxStatus
			err    error
		)
		switch action {
		case "start":
			status, err = sup.StartSandbox(ctx, id)
		case "stop":
			status, err = sup.StopSandbox(ctx, id)
		case "snapshot":
			status, err = sup.SnapshotSandbox(ctx, id)
		case "destroy":
			status, err = sup.DestroySandbox(ctx, id)
		case "killswitch":
			status, err = sup.KillSwitch(ctx, id, "manual supervisor kill-switch")
		default:
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "unsupported action"})
			return
		}
		if err != nil {
			if errors.Is(err, vm.ErrSandboxNotFound) {
				w.WriteHeader(http.StatusNotFound)
			} else {
				w.WriteHeader(http.StatusInternalServerError)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(status)
	})

	httpServer := &http.Server{Addr: cfg.SupervisorAddr, Handler: mux}
	go func() {
		log.Printf("vm-supervisor listening on %s", cfg.SupervisorAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("vm-supervisor failed: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		fmt.Printf("shutdown error: %v\n", err)
	}
}
