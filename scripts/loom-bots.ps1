<#
.SYNOPSIS
loom-bots — the sandboxed-loom bot runner (D4 capstone).

Drives REAL agent CLIs (copilot / codex) as clearly-labeled bot players in an
AIMANCER room over the plain HTTP API — the exact surface any BYO agent uses.
One tool, three jobs: proves the BYO surface end-to-end, fills seats so a demo
room is alive from tick 1, and records replays (the room log).

.DESCRIPTION
Flow: create a room over HTTP (or join an existing one with -Pin), HTTP-join
one seat per agent, fetch each seat's OFFICIAL paste-prompt from
GET /api/room/:pin/agent-prompt (the same text a human copies from their
phone), start the game, then hand each prompt to a real agent CLI:

  copilot — driven THROUGH LOOM (`loom run --agent copilot -skip-permissions`
            → copilot `--allow-all`). Three Windows findings, all verified
            live on 1.0.73 (this room's config; yours may differ):
            1. QUOTE MANGLING: the npm install exposes copilot only as a
               .cmd/.ps1 shim; exec'ing the .cmd (which loom's backend
               resolves to) re-parses argv through cmd.exe and MANGLES a
               prompt containing double quotes — the paste-prompt arrives
               truncated/garbled and the agent flails. Fix: build the tiny
               argv-preserving forwarder in scripts/copilot-shim/ (go build
               -o copilot-shim.exe .) and set LOOM_COPILOT_BIN to it. With
               the shim, the loom path passes end-to-end.
            2. URL PERMISSIONS are their own class: `--allow-all-tools`
               alone still denies the localhost curl headless (prompts fail
               closed), and a user-level ~/.copilot/settings.json
               `allowedUrls` allowlist silently excludes the room URL.
               loom's -skip-permissions (`--allow-all`) covers it; the
               scoped flag is `--allow-url <BaseUrl>` — WITH the scheme
               ("localhost:18090" never matches; "http://localhost:18090"
               does).
            3. -CopilotScoped drives copilot DIRECTLY (via the .ps1 shim,
               argv-safe inside pwsh) with the tightest encoding:
               `--allow-all-tools --allow-url <BaseUrl>` — tools auto-run,
               file walls intact, network scoped to the room's host.
            Either way: pure curl, no special network story.
  codex   — driven DIRECTLY, because loom has no passthrough for codex `-c`
            overrides today and codex's sandbox needs per-OS encoding:
              macOS/Linux: `-s workspace-write
                -c sandbox_workspace_write.network_access=true` — the
                researched flags: native kernel sandbox ON, network opened,
                filesystem walled to the scratch workdir.
              Windows: `-s danger-full-access` — VERIFIED LIVE (codex-cli
                0.144.6): the experimental Windows sandbox declines shell
                commands under workspace-write even with network_access=true
                ("rejected: blocked by policy"), so full-access is the only
                encoding that plays here. Local rooms only; that's why the
                localhost guardrail above exists.
            (-CodexViaLoom uses loom's -skip-permissions rung instead —
            clearly labeled, OFF by default.)

The paste-prompt itself NEVER asks an agent to bypass its own permission
prompts (that rule is server-side, wstest-enforced); granting the bot
tool-run permission here is the OPERATOR's invocation choice, which is where
that decision belongs.

The script then polls room state until each bot seat shows >= 1 drafted
script (script fates are public) and reports PASS/FAIL per agent.

.EXAMPLE
  # local server first (never point bots at the live site):
  #   $env:PORT=18090; npx tsx server/index.ts
  ./scripts/loom-bots.ps1 -BaseUrl http://localhost:18090 -Agents copilot,codex

.EXAMPLE
  # fill seats in a room your phone created (PIN on the screen):
  ./scripts/loom-bots.ps1 -BaseUrl http://localhost:18090 -Pin ABCD -NoStart -Agents copilot
#>
param(
  [string]$BaseUrl = 'http://localhost:18090',
  [string]$Pin = '',                      # join an existing room instead of creating one
  [string[]]$Agents = @('copilot', 'codex'),
  [int]$TickMs = 5000,
  [int]$Round1 = 6,
  [int]$Round2 = 6,
  [switch]$NoStart,                       # don't start the game (a human host will)
  [switch]$CodexViaLoom,                  # drive codex through loom's -skip-permissions rung (labeled; default OFF)
  [switch]$CopilotScoped,                 # drive copilot DIRECTLY with --allow-url <BaseUrl> instead of through loom
  [switch]$ForceLive,                     # required to aim at a non-local server
  [string]$LoomExe = $(if ($env:LOOM_EXE) { $env:LOOM_EXE } else { "$env:USERPROFILE\go\bin\loom.exe" }),
  [int]$WaitSeconds = 300
)
$ErrorActionPreference = 'Stop'

# ── guardrails ───────────────────────────────────────────────────────────────
if ($BaseUrl -notmatch '^https?://(localhost|127\.0\.0\.1)([:/]|$)' -and -not $ForceLive) {
  throw "loom-bots: '$BaseUrl' is not a local server. Bots are for LOCAL rooms (respect the live site); pass -ForceLive only if you really mean it."
}
if (-not (Test-Path $LoomExe)) { throw "loom-bots: loom not found at '$LoomExe' (set -LoomExe or `$env:LOOM_EXE)" }
$loomBackends = & $LoomExe agents 2>$null
if ($Agents -contains 'copilot' -and -not $CopilotScoped -and $loomBackends -notcontains 'copilot') {
  throw "loom-bots: this loom binary has no copilot backend ($($loomBackends -join ', ')). Build loom from HEAD (projects/loom: go build ./cmd/loom) and point -LoomExe at it, or pass -CopilotScoped."
}
# pin copilot past the VS Code extension's shadow install (it lags npm's)
$npmCopilot = "$env:APPDATA\npm\copilot.cmd"
if ((Test-Path $npmCopilot) -and -not $env:LOOM_COPILOT_BIN) { $env:LOOM_COPILOT_BIN = $npmCopilot }

function Api([string]$Method, [string]$Path, $Body = $null, [string]$Token = '') {
  $headers = @{}
  if ($Token) { $headers['Authorization'] = "Bearer $Token" }
  $args = @{ Method = $Method; Uri = "$BaseUrl$Path"; Headers = $headers }
  if ($null -ne $Body) {
    $args['Body'] = ($Body | ConvertTo-Json -Compress)
    $args['ContentType'] = 'application/json'
  }
  Invoke-RestMethod @args
}

# ── room: create (or adopt) ──────────────────────────────────────────────────
$hostSeat = $null
if (-not $Pin) {
  $hostSeat = Api POST '/api/room' @{ name = 'loom-host'; tickMs = $TickMs; round1Ticks = $Round1; round2Ticks = $Round2 }
  $Pin = $hostSeat.pin
  Write-Host "room $Pin created (host seat $($hostSeat.seat); tick ${TickMs}ms, rounds $Round1+$Round2)"
} else {
  Write-Host "joining existing room $Pin"
}

# ── seats: one HTTP join + official paste-prompt per agent ───────────────────
# (join BEFORE start — a started room admits reconnects only)
$bots = @()
foreach ($agent in $Agents) {
  $seat = Api POST "/api/room/$Pin/join" @{ name = "bot-$agent" }
  $prompt = Invoke-RestMethod -Uri "$BaseUrl/api/room/$Pin/agent-prompt?token=$($seat.workerToken)"
  $bots += [pscustomobject]@{ Agent = $agent; Seat = $seat.seat; Name = $seat.name; Worker = $seat.workerToken; Prompt = $prompt }
  Write-Host "  seat $($seat.seat) = bot-$agent (worker token issued; paste-prompt fetched)"
}

# ── start the game (host hinge — the same human act, held by this script) ────
if (-not $NoStart) {
  if (-not $hostSeat) { Write-Host 'NOTE: -Pin given without host tokens; the room host must start the game.' }
  else { Api POST "/api/room/$Pin/start" @{} $hostSeat.hingeToken | Out-Null; Write-Host "game started" }
}

# ── the bot directive: framed AROUND the official paste-prompt ───────────────
function BotPrompt([string]$paste) {
  @"
You are an autonomous SEAT-FILLER BOT in a local game demo (clearly labeled as
a bot; no human is at this seat). Follow the room prompt below exactly as any
player's agent would, but keep it SHORT — at most 5 shell commands total, then
stop: (1) GET state once; (2) author TWO scripts — a harvest and a refine —
and POST each to /draft; (3) GET state once to confirm they are in you.hand;
(4) reply with a one-line summary of what you drafted. Run the curl commands
DIRECTLY in the shell — do NOT create, write, or edit any files, and do not
build helper scripts. Do not wait for a human, do not poll in a loop, and do
not try to arm — your worker token cannot, by design.

About the room prompt's approve-the-curl note: your OPERATOR already granted
this run's tool permissions up front, in the invocation flags — that grant IS
the approval the note asks for. There is no human at the console to ask, so
run the curls directly; do not stop to request interactive permission.

$paste
"@
}

# ── launch the agents ────────────────────────────────────────────────────────
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) "aimancer-loom-bots-$([System.IO.Path]::GetRandomFileName())"
$jobs = @()
foreach ($bot in $bots) {
  $dir = Join-Path $workRoot $bot.Agent
  New-Item -ItemType Directory -Force $dir | Out-Null
  $prompt = BotPrompt $bot.Prompt
  $promptFile = Join-Path $dir 'prompt.txt'
  Set-Content -Path $promptFile -Value $prompt -Encoding utf8
  $log = Join-Path $dir 'run.log'
  Write-Host "launching $($bot.Agent) (workdir $dir)…"
  switch ($bot.Agent) {
    'codex' {
      if ($CodexViaLoom) {
        # labeled: loom's only network-permitting rung for codex today
        $jobs += Start-Job -Name $bot.Agent -ScriptBlock {
          param($loom, $pf, $dir, $log)
          Get-Content $pf -Raw | & $loom run --agent codex -skip-permissions -dir $dir "$(Get-Content $pf -Raw)" *> $log
        } -ArgumentList $LoomExe, $promptFile, $dir, $log
      } else {
        # per-OS sandbox encoding (see the header comment): the researched
        # workspace-write + network override where the native sandbox works;
        # danger-full-access on Windows, where workspace-write declines shell
        # commands outright (verified live, codex-cli 0.144.6). Prompt over
        # stdin (`-` sentinel).
        $sandboxArgs = if ($IsWindows) { @('-s', 'danger-full-access') }
                       else { @('-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true') }
        $jobs += Start-Job -Name $bot.Agent -ScriptBlock {
          param($pf, $dir, $log, $sb)
          Get-Content $pf -Raw |
            & codex exec --json --skip-git-repo-check -C $dir @sb - *> $log
        } -ArgumentList $promptFile, $dir, $log, $sandboxArgs
      }
    }
    'copilot' {
      if ($CopilotScoped) {
        # direct: the tightest copilot encoding — tools auto-run, paths
        # walled, network allowed ONLY to the room's host
        # NOTE: --allow-url needs the SCHEME to match (verified live 1.0.73:
        # "localhost:18090" never matches; "http://localhost:18090" does).
        # Prefer an argv-safe bin: the pinned shim, else the npm .ps1 (pwsh
        # passes args natively), never the .cmd (quote mangling — see header).
        $allowUrl = $BaseUrl.TrimEnd('/')
        $npmPs1 = "$env:APPDATA\npm\copilot.ps1"
        $copilotBin = if ($env:LOOM_COPILOT_BIN) { $env:LOOM_COPILOT_BIN }
                      elseif (Test-Path $npmPs1) { $npmPs1 }
                      else { 'copilot' }
        $jobs += Start-Job -Name $bot.Agent -ScriptBlock {
          param($bin, $pf, $dir, $log, $allowUrl)
          Set-Location $dir
          $prompt = Get-Content $pf -Raw
          & $bin -p $prompt --log-level none --no-color --no-auto-update --allow-all-tools --allow-url $allowUrl *> $log
        } -ArgumentList $copilotBin, $promptFile, $dir, $log, $allowUrl
      } else {
        # through loom: -skip-permissions → --allow-all, loom's only rung
        # that opens copilot's separate URL permission class headless
        $jobs += Start-Job -Name $bot.Agent -ScriptBlock {
          param($loom, $pf, $dir, $log)
          & $loom run --agent copilot -skip-permissions -dir $dir "$(Get-Content $pf -Raw)" *> $log
        } -ArgumentList $LoomExe, $promptFile, $dir, $log
      }
    }
    default {
      # any other loom backend (claude, agy, opencode…) — the -isolate rung
      $jobs += Start-Job -Name $bot.Agent -ScriptBlock {
        param($loom, $agent, $pf, $dir, $log)
        & $loom run --agent $agent -isolate -dir $dir "$(Get-Content $pf -Raw)" *> $log
      } -ArgumentList $LoomExe, $bot.Agent, $promptFile, $dir, $log
    }
  }
}

# ── the acceptance oracle: a real draft from each bot seat, on the wire ──────
Write-Host "waiting up to ${WaitSeconds}s for drafts to land (script fates are public state)…"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$landed = @{}
while ((Get-Date) -lt $deadline -and $landed.Count -lt $bots.Count) {
  Start-Sleep -Seconds 3
  $state = Api GET "/api/room/$Pin/state"
  foreach ($bot in $bots) {
    if ($landed.ContainsKey($bot.Agent)) { continue }
    $player = $state.view.players | Where-Object { $_.index -eq $bot.Seat }
    if ($player -and $player.scripts.Count -gt 0) {
      $landed[$bot.Agent] = $player.scripts.Count
      Write-Host "  PASS $($bot.Agent): $($player.scripts.Count) draft(s) on seat $($bot.Seat) — a real agent curled the API"
    }
  }
}
foreach ($bot in $bots) {
  if (-not $landed.ContainsKey($bot.Agent)) {
    Write-Host "  FAIL $($bot.Agent): no draft landed within ${WaitSeconds}s — see $workRoot\$($bot.Agent)\run.log"
  }
}
$jobs | Wait-Job -Timeout 30 | Out-Null
$jobs | Stop-Job -ErrorAction SilentlyContinue
Write-Host "room $Pin log: $BaseUrl/api/room/$Pin/log — logs under $workRoot"
if ($landed.Count -lt $bots.Count) { exit 1 }
Write-Host "loom-bots: ALL $($bots.Count) agent(s) drafted over the real HTTP path."
