package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/harmony/nanoclaw/src-go/internal/api"
	"github.com/harmony/nanoclaw/src-go/internal/config"
	"github.com/harmony/nanoclaw/src-go/internal/policy"
	"github.com/harmony/nanoclaw/src-go/internal/reconciler"
	"github.com/harmony/nanoclaw/src-go/internal/session"
	"github.com/harmony/nanoclaw/src-go/internal/store"
	"github.com/harmony/nanoclaw/src-go/internal/vm"
)

func main() {
	cfg := config.Load()
	st, err := store.NewMemoryStore(cfg.StateFile)
	if err != nil {
		log.Fatalf("store init failed: %v", err)
	}

	sup := vm.NewSupervisor(cfg.EnableSimulatedVM, cfg.FirecrackerBin)
	pol := policy.NewEngine(cfg.PolicySigningKey)
	rec := reconciler.New(st, sup)
	sess := session.NewManager(st)
	server := api.NewServer(st, sup, pol, rec, sess)

	httpServer := &http.Server{
		Addr:    cfg.APIListenAddr,
		Handler: server.Handler(),
	}

	go func() {
		log.Printf("nanoclawd listening on %s", cfg.APIListenAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server failed: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	_ = server.Shutdown(ctx)
}
