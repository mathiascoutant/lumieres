package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"lumieres/backend/internal/api"
	"lumieres/backend/internal/artnet"
	"lumieres/backend/internal/catalog"
	"lumieres/backend/internal/engine"
	"lumieres/backend/internal/store"
)

func main() {
	_ = godotenv.Load()
	dataDir := envOr("DATA_DIR", "data")
	port := envOr("PORT", "8080")

	st := store.Open(os.Getenv("MONGO_URI"), envOr("MONGO_DB", "lumieres"), filepath.Join(dataDir, "show.json"))
	en := engine.New()
	an, err := artnet.New()
	if err != nil {
		log.Fatalf("art-net: %v", err)
	}
	cat := catalog.New(dataDir, os.Getenv("UPCITEMDB_KEY"))
	srv := api.New(st, en, an, cat, os.Getenv("DMX_GATEWAY_URL"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go st.Run(ctx)
	go an.Run(ctx)
	go srv.RunStatus(ctx)
	go en.Run(ctx, srv.Frame)

	httpSrv := &http.Server{Addr: ":" + port, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdown)
	}()

	log.Printf("Lumières prêt : http://%s:%s", localIP(), port)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http: %v", err)
	}

	// Leave the room dark rather than frozen on the last look.
	var dark [512]byte
	for range 3 {
		an.Send(&dark)
		time.Sleep(30 * time.Millisecond)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func localIP() string {
	conn, err := net.Dial("udp4", "8.8.8.8:80") // no packet is sent, this only picks the route
	if err != nil {
		return "localhost"
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}
