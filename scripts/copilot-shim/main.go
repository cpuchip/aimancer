// copilot-shim — an argv-preserving forwarder for GitHub Copilot CLI on
// Windows. The npm install exposes copilot only as a .cmd/.ps1 shim; anything
// that execs the .cmd (loom's copilot backend does) re-parses arguments
// through cmd.exe, which mangles prompts containing double quotes. This exe
// forwards os.Args verbatim to `node npm-loader.js`, so LOOM_COPILOT_BIN can
// point here and loom's prompt survives intact.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	loader := os.Getenv("COPILOT_SHIM_LOADER")
	if loader == "" {
		appdata := os.Getenv("APPDATA")
		loader = filepath.Join(appdata, "npm", "node_modules", "@github", "copilot", "npm-loader.js")
	}
	args := append([]string{loader}, os.Args[1:]...)
	cmd := exec.Command("node", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		os.Exit(1)
	}
}
