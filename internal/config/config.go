// Package config persists ttyl client settings (currently the default relay
// server URL) to a small JSON file in the user's OS config directory, so the
// server does not have to be passed on every stream. The location follows each
// platform's convention via os.UserConfigDir:
//
//	Linux/BSD: $XDG_CONFIG_HOME/ttyl/config.json  (or ~/.config/ttyl/...)
//	macOS:     ~/Library/Application Support/ttyl/config.json
//	Windows:   %AppData%\ttyl\config.json
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config holds persisted client settings.
type Config struct {
	// Server is the default relay base URL used by `ttyl stream` when no
	// -server flag is given.
	Server string `json:"server,omitempty"`
}

// Path returns the absolute path to the config file for this OS.
func Path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate config dir: %w", err)
	}
	return filepath.Join(dir, "ttyl", "config.json"), nil
}

// Load reads the config file. A missing file is not an error: it returns a zero
// Config so callers can fall back to defaults.
func Load() (Config, error) {
	path, err := Path()
	if err != nil {
		return Config{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, nil
		}
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return c, nil
}

// Save writes the config file, creating the directory if needed. The file is
// written 0600 since it records user preferences in the user's profile.
func Save(c Config) (string, error) {
	path, err := Path()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return "", err
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", fmt.Errorf("write config: %w", err)
	}
	return path, nil
}
