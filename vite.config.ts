// Adapted from kernel-panic vite.config.ts (the house pattern).
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Build stamp: git short hash of the deployed commit. GET /version echoes it —
// the deploy oracle. Dockerfile sets VITE_GIT_SHA; local reads git, falls to 'dev'.
function buildSha(): string {
  const env = process.env.VITE_GIT_SHA
  if (env && env.trim()) return env.trim()
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}
const BUILD_SHA = buildSha()

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  server: {
    port: 5175,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080' },
    },
  },
  plugins: [
    svelte(),
    {
      name: 'write-version-txt',
      apply: 'build',
      closeBundle() {
        try {
          writeFileSync(resolve(process.cwd(), 'dist/version.txt'), BUILD_SHA)
        } catch {
          /* dist may not exist on a failed build */
        }
      },
    },
  ],
})
