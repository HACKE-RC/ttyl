// Command astream streams a live, interactive terminal session to a self-hosted
// relay server that serves a shareable web link.
//
// Usage:
//
//	astream serve  [-addr :8080] [-public-url http://host:8080]
//	astream stream [-server http://localhost:8080] [-- command args...]
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/rc/astream/internal/client"
	"github.com/rc/astream/internal/server"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = server.Run(ctx, args)
	case "stream":
		err = client.Run(ctx, args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "astream: unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "astream: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `astream - live interactive terminal streaming

Commands:
  serve    Run the relay/web server
  stream   Wrap a shell in a PTY and stream it to a server

Run "astream <command> -h" for command-specific flags.
`)
}
