// Package web holds the embedded static assets for the ttyl viewer.
package web

import "embed"

// Assets contains the viewer page and its script. xterm.js itself is loaded
// from a CDN to avoid a frontend build step.
//
//go:embed index.html viewer.js
var Assets embed.FS
