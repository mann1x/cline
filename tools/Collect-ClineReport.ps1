<#
.SYNOPSIS
    Collects one Cline session and its logs into a zip for analysis.

.DESCRIPTION
    Gathers the transcript of the most recent Cline task, the extension's own
    output log, and a short description of the machine, into a single zip.

    WHAT THIS CONTAINS. The transcript is the full conversation: every prompt,
    every model reply, and the contents of every file the model read or wrote.
    If the task touched private code, that code is in the zip. Read the
    manifest the script prints before sending it to anyone.

    Provider settings are included with credential-shaped values replaced by
    [REDACTED] — any field whose name looks like a key, token, secret or
    password. The redaction is by field name, so check the file if you keep
    credentials somewhere unusual.

.PARAMETER SessionCount
    How many of the most recent sessions to include. Default 1.

.PARAMETER SessionId
    Collect this specific session id instead of the most recent.

.PARAMETER OutputPath
    Directory to write the zip to. Default: Desktop.

.PARAMETER IncludeOllamaRequests
    Also include raw Ollama request bodies from %TEMP% when Ollama was run with
    OLLAMA_DEBUG request logging. These are large and contain the full prompt.

.PARAMETER NoSettings
    Skip provider settings entirely.

.EXAMPLE
    .\Collect-ClineReport.ps1

.EXAMPLE
    .\Collect-ClineReport.ps1 -SessionCount 3 -OutputPath C:\temp
#>

[CmdletBinding()]
param(
    [int]$SessionCount = 1,
    [string]$SessionId,
    [string]$OutputPath = [Environment]::GetFolderPath('Desktop'),
    [switch]$IncludeOllamaRequests,
    [switch]$NoSettings
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Manifest = New-Object System.Collections.ArrayList

function Add-Note {
    param([string]$Text, [string]$Colour = 'Gray')
    Write-Host $Text -ForegroundColor $Colour
}

function Add-Item {
    param([string]$What, [string]$Detail)
    [void]$script:Manifest.Add([pscustomobject]@{ item = $What; detail = $Detail })
    Add-Note ("  + {0,-28} {1}" -f $What, $Detail) 'DarkGray'
}

function Add-Missing {
    param([string]$What, [string]$Why)
    [void]$script:Manifest.Add([pscustomobject]@{ item = $What; detail = "NOT COLLECTED: $Why" })
    Add-Note ("  - {0,-28} {1}" -f $What, $Why) 'DarkYellow'
}

# Field names whose values are replaced before anything is written out. Matched
# against the property name, case-insensitively, anywhere in the name.
$SecretPattern = 'key|token|secret|password|passwd|credential|authorization|bearer|cookie|session_?id_?token'

function Protect-Secrets {
    param($Node)

    if ($null -eq $Node) { return $null }

    if ($Node -is [System.Collections.IDictionary]) {
        $out = @{}
        foreach ($entry in $Node.GetEnumerator()) {
            $out[$entry.Key] = Protect-Secrets $entry.Value
        }
        return $out
    }

    if ($Node -is [PSCustomObject]) {
        $out = [ordered]@{}
        foreach ($prop in $Node.PSObject.Properties) {
            if ($prop.Name -match $SecretPattern) {
                if ($null -ne $prop.Value -and "$($prop.Value)".Length -gt 0) {
                    $out[$prop.Name] = '[REDACTED]'
                } else {
                    $out[$prop.Name] = $prop.Value
                }
            } else {
                $out[$prop.Name] = Protect-Secrets $prop.Value
            }
        }
        return [pscustomobject]$out
    }

    if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
        return @($Node | ForEach-Object { Protect-Secrets $_ })
    }

    return $Node
}

function Copy-Redacted {
    param([string]$Source, [string]$Destination)

    try {
        $parsed = Get-Content -LiteralPath $Source -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        # Not JSON, or malformed. Do not copy something we could not inspect.
        return $false
    }
    $clean = Protect-Secrets $parsed
    $clean | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Destination -Encoding UTF8
    return $true
}

# ---------------------------------------------------------------- staging ---

$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportId = "cline-report-$env:COMPUTERNAME-$stamp"
$staging  = Join-Path ([System.IO.Path]::GetTempPath()) $reportId

New-Item -ItemType Directory -Path $staging -Force | Out-Null

Add-Note ''
Add-Note "Collecting into $reportId" 'Cyan'
Add-Note ''

# --------------------------------------------------------------- sessions ---

$sessionsRoot = Join-Path $env:USERPROFILE '.cline\data\sessions'

if (-not (Test-Path -LiteralPath $sessionsRoot)) {
    Add-Note "No Cline session directory at $sessionsRoot." 'Red'
    Add-Note "Has Cline been run on this machine as this user?" 'Red'
    exit 1
}

if ($SessionId) {
    $sessionDirs = @(Get-ChildItem -LiteralPath $sessionsRoot -Directory |
        Where-Object { $_.Name -eq $SessionId })
    if ($sessionDirs.Count -eq 0) {
        Add-Note "No session directory named '$SessionId'." 'Red'
        exit 1
    }
} else {
    $sessionDirs = @(Get-ChildItem -LiteralPath $sessionsRoot -Directory |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First $SessionCount)
}

if ($sessionDirs.Count -eq 0) {
    Add-Note "No sessions found under $sessionsRoot." 'Red'
    exit 1
}

$sessionTarget = Join-Path $staging 'sessions'
New-Item -ItemType Directory -Path $sessionTarget -Force | Out-Null

foreach ($dir in $sessionDirs) {
    $dest = Join-Path $sessionTarget $dir.Name
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    foreach ($file in Get-ChildItem -LiteralPath $dir.FullName -File) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $dest $file.Name)
        $kb = [math]::Round($file.Length / 1KB, 1)
        Add-Item "session/$($dir.Name)" "$($file.Name) (${kb} KB)"
    }
}

# ------------------------------------------------------------ Cline's log ---
#
# The extension writes its output channel to
#   %APPDATA%\Code\logs\<stamp>\window<N>\exthost\output_logging_<stamp>\1-Cline.log
# One directory per window per launch, so take the newest that actually exists.

$logRoots = @(
    (Join-Path $env:APPDATA 'Code\logs'),
    (Join-Path $env:APPDATA 'Code - Insiders\logs'),
    (Join-Path $env:APPDATA 'VSCodium\logs')
) | Where-Object { Test-Path -LiteralPath $_ }

$clineLogs = @()
foreach ($root in $logRoots) {
    $clineLogs += Get-ChildItem -LiteralPath $root -Recurse -Filter '*-Cline.log' -ErrorAction SilentlyContinue
}

if ($clineLogs.Count -gt 0) {
    $logTarget = Join-Path $staging 'logs'
    New-Item -ItemType Directory -Path $logTarget -Force | Out-Null

    # Newest three windows' worth: a reload mid-task splits the log in two, and
    # the interesting half is often the earlier one. Empty logs are skipped —
    # launching VS Code creates one before anything is written to it.
    $picked = $clineLogs |
        Where-Object { $_.Length -gt 0 } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 3

    # These logs are cumulative across every task in that window, not per-task,
    # so they grow without bound. Keep the tail, which is the part covering the
    # session being reported.
    $maxLogBytes = 8MB

    $index = 0
    foreach ($log in $picked) {
        $index += 1
        $name = "cline-output-$index.log"
        $dest = Join-Path $logTarget $name
        $kb = [math]::Round($log.Length / 1KB, 1)

        if ($log.Length -gt $maxLogBytes) {
            # -Tail counts lines, not bytes; 40k lines comfortably exceeds 8MB
            # of this log's line length, so read back from the end and trim.
            $tail = Get-Content -LiteralPath $log.FullName -Tail 40000
            Set-Content -LiteralPath $dest -Value $tail -Encoding UTF8
            Add-Item 'logs' "$name <- $($log.LastWriteTime.ToString('s')) (tail of ${kb} KB)"
        } else {
            Copy-Item -LiteralPath $log.FullName -Destination $dest
            Add-Item 'logs' "$name <- $($log.LastWriteTime.ToString('s')) (${kb} KB)"
        }
    }

    if ($picked.Count -eq 0) {
        Add-Missing 'logs' 'every *-Cline.log found was empty'
    }
} else {
    Add-Missing 'logs' 'no *-Cline.log found under any VS Code logs directory'
}

$hooksLog = Join-Path $env:USERPROFILE '.cline\data\logs\hooks.jsonl'
if (Test-Path -LiteralPath $hooksLog) {
    $logTarget = Join-Path $staging 'logs'
    if (-not (Test-Path -LiteralPath $logTarget)) {
        New-Item -ItemType Directory -Path $logTarget -Force | Out-Null
    }
    Copy-Item -LiteralPath $hooksLog -Destination (Join-Path $logTarget 'hooks.jsonl')
    $kb = [math]::Round((Get-Item -LiteralPath $hooksLog).Length / 1KB, 1)
    Add-Item 'logs' "hooks.jsonl (${kb} KB)"
}

# --------------------------------------------------------------- settings ---

if (-not $NoSettings) {
    $settingsRoot = Join-Path $env:USERPROFILE '.cline\data\settings'
    if (Test-Path -LiteralPath $settingsRoot) {
        $settingsTarget = Join-Path $staging 'settings'
        New-Item -ItemType Directory -Path $settingsTarget -Force | Out-Null

        foreach ($file in Get-ChildItem -LiteralPath $settingsRoot -File -Filter '*.json') {
            $dest = Join-Path $settingsTarget $file.Name
            if (Copy-Redacted -Source $file.FullName -Destination $dest) {
                Add-Item 'settings' "$($file.Name) (secrets redacted)"
            } else {
                Add-Missing "settings/$($file.Name)" 'could not be parsed as JSON, so not included'
            }
        }
    } else {
        Add-Missing 'settings' 'no settings directory'
    }
} else {
    Add-Missing 'settings' 'skipped (-NoSettings)'
}

# -------------------------------------------------- Ollama request bodies ---

if ($IncludeOllamaRequests) {
    $reqDirs = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ollama-request-logs-*' -ErrorAction SilentlyContinue)
    if ($reqDirs.Count -gt 0) {
        $newest = $reqDirs | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $bodies = Get-ChildItem -LiteralPath $newest.FullName -Filter '*_api_chat_body.json' |
            Sort-Object LastWriteTime -Descending | Select-Object -First 10
        if ($bodies.Count -gt 0) {
            $reqTarget = Join-Path $staging 'ollama-requests'
            New-Item -ItemType Directory -Path $reqTarget -Force | Out-Null
            foreach ($body in $bodies) {
                Copy-Item -LiteralPath $body.FullName -Destination (Join-Path $reqTarget $body.Name)
            }
            Add-Item 'ollama-requests' "$($bodies.Count) newest request bodies from $($newest.Name)"
        } else {
            Add-Missing 'ollama-requests' "no *_api_chat_body.json in $($newest.Name)"
        }
    } else {
        Add-Missing 'ollama-requests' 'no ollama-request-logs-* directory in %TEMP%'
    }
}

# ------------------------------------------------------------ environment ---

function Get-CommandOutput {
    param([string]$Command, [string[]]$Arguments)
    try {
        $resolved = Get-Command $Command -ErrorAction Stop
        return (& $resolved.Source @Arguments 2>&1 | Out-String).Trim()
    } catch {
        return "(not found on PATH)"
    }
}

$extensionDirs = @()
$extRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
if (Test-Path -LiteralPath $extRoot) {
    $extensionDirs = @(Get-ChildItem -LiteralPath $extRoot -Directory |
        Where-Object { $_.Name -like '*claude-dev*' -or $_.Name -like '*cline*' } |
        ForEach-Object { $_.Name })
}

$os = Get-CimInstance Win32_OperatingSystem

# Win32_VideoController.AdapterRAM is a uint32, so it saturates at 4 GB and
# reports a 16 GB card as 4. Ask the driver instead when it is an NVIDIA card,
# and otherwise give the name without a size rather than a wrong one.
$gpuNames = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
$gpuDetail = Get-CommandOutput 'nvidia-smi' @('--query-gpu=name,memory.total,driver_version', '--format=csv,noheader')
if ($gpuDetail -like '*not found*' -or [string]::IsNullOrWhiteSpace($gpuDetail)) {
    $gpu = $gpuNames -join '; '
} else {
    $gpu = $gpuDetail
}

$environment = [ordered]@{
    collectedAt       = (Get-Date).ToString('o')
    scriptVersion     = '1.0.0'
    computerName      = $env:COMPUTERNAME
    powerShell        = $PSVersionTable.PSVersion.ToString()
    os                = "$($os.Caption) $($os.Version)"
    memoryGB          = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    gpu               = $gpu
    vsCode            = (Get-CommandOutput 'code' @('--version'))
    clineExtensions   = $extensionDirs
    ollamaVersion     = (Get-CommandOutput 'ollama' @('--version'))
    ollamaModels      = (Get-CommandOutput 'ollama' @('list'))
    ollamaRunning     = (Get-CommandOutput 'ollama' @('ps'))
    ollamaEnvironment = @{
        OLLAMA_HOST       = $env:OLLAMA_HOST
        OLLAMA_NUM_PARALLEL = $env:OLLAMA_NUM_PARALLEL
        OLLAMA_CONTEXT_LENGTH = $env:OLLAMA_CONTEXT_LENGTH
        OLLAMA_KV_CACHE_TYPE = $env:OLLAMA_KV_CACHE_TYPE
        OLLAMA_FLASH_ATTENTION = $env:OLLAMA_FLASH_ATTENTION
    }
    sessionsCollected = @($sessionDirs | ForEach-Object { $_.Name })
}

$environment | ConvertTo-Json -Depth 100 |
    Set-Content -LiteralPath (Join-Path $staging 'environment.json') -Encoding UTF8
Add-Item 'environment.json' 'OS, GPU, VS Code, extension version, Ollama models'

# ----------------------------------------------------------- what is here ---

$readme = @"
Cline session report
====================

Collected  : $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))
Machine    : $env:COMPUTERNAME
Sessions   : $(@($sessionDirs | ForEach-Object { $_.Name }) -join ', ')

Contents
--------
sessions/<id>/<id>.messages.json    The full transcript: prompts, replies,
                                    tool calls, and the contents of every file
                                    that was read or written.
sessions/<id>/<id>.compaction.json  The compacted summary, if the task ran long
                                    enough to be compacted.
sessions/<id>/<id>.json             Task metadata: timestamps, token counts.
logs/cline-output-N.log             The extension's own log, newest first. A
                                    window reload splits one task across two.
logs/hooks.jsonl                    Hook activity, if hooks are configured.
settings/*.json                     Provider and MCP settings. Values under
                                    field names matching key/token/secret/
                                    password/credential are [REDACTED].
environment.json                    Machine, VS Code, extension and Ollama.

Please read before sending
--------------------------
The transcript contains the contents of files the model read. If this task
touched code or data you would rather not share, do not send this zip — rerun
the script after a task that does not, or open the messages file and check.
"@

Set-Content -LiteralPath (Join-Path $staging 'README.txt') -Value $readme -Encoding UTF8

$script:Manifest | ConvertTo-Json -Depth 100 |
    Set-Content -LiteralPath (Join-Path $staging 'manifest.json') -Encoding UTF8

# -------------------------------------------------------------------- zip ---

if (-not (Test-Path -LiteralPath $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}

$zipPath = Join-Path $OutputPath "$reportId.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $staging -Recurse -Force

$zipKb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1)

Add-Note ''
Add-Note "Written: $zipPath (${zipKb} KB)" 'Green'
Add-Note ''
Add-Note 'The transcript includes the contents of files the model read.' 'Yellow'
Add-Note 'Check README.txt inside the zip before sending it on.' 'Yellow'
Add-Note ''
