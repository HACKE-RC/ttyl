// Command ttyl streams a live, interactive terminal session to a self-hosted
// relay server that serves a shareable web link.
//
// Usage:
//
//	ttyl serve  [-addr :8080]
//	ttyl init   [-server http://host:8080]
//	ttyl stream [-server http://host:8080] [-- command args...]
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/rc/ttyl/internal/client"
	"github.com/rc/ttyl/internal/server"
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
	case "init":
		err = client.Init(ctx, args)
	case "stream":
		err = client.Run(ctx, args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "ttyl: unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "ttyl: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `ttyl - live interactive terminal streaming

Commands:
  serve    Run the relay/web server
  init     Save the default relay server URL to your config file
  stream   Wrap a shell in a PTY and stream it to a server

Run "ttyl <command> -h" for command-specific flags.
`)
}
