package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func main() {
	cfg := config.Load()
	sup := vm.NewSupervisor(cfg.EnableSimulatedVM, cfg.FirecrackerBin)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "summary": sup.Summary()})
	})
	mux.HandleFunc("/v1/supervisor/sandboxes/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/v1/supervisor/sandboxes/")
		parts := strings.SplitN(path, ":", 2)
		if len(parts) != 2 {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "expected /v1/supervisor/sandboxes/{id}:killswitch"})
			return
		}
		if parts[1] != "killswitch" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "unsupported action"})
			return
		}
		status, err := sup.KillSwitch(context.Background(), parts[0], "manual supervisor kill-switch")
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
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
