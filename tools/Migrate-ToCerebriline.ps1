<#
.SYNOPSIS
    Moves a mann1x Cline fork installation to Cerebriline.

.DESCRIPTION
    The fork was published as the extension `saoudrizwan.claude-dev` and kept
    its data in `~/.cline`. It is now `mann1x.cerebriline` and keeps its data
    in `~/.cerebriline`. VS Code keys an extension's storage on its publisher
    and name, so the new build is a different extension as far as VS Code is
    concerned: install it and it starts empty, beside the old one, with every
    session and setting still under the old name.

    This script carries them across. It copies rather than moves, verifies the
    copy file by file, and only then renames the original out of the way - so
    nothing is deleted and a failed run leaves you exactly where you started.

    WHAT IT TOUCHES

      ~\.cline                      -> ~\.cerebriline
        Sessions, settings, providers, logs, templates, the machine id.
        This is the one that matters: it holds every conversation you have had.

      ~\Documents\Cline             -> ~\Documents\Cerebriline
        Agents, Hooks, Rules, Workflows, Plugins you wrote yourself.

      globalStorage\saoudrizwan.claude-dev
                                    -> globalStorage\mann1x.cerebriline
        VS Code's own per-extension storage, under each installed VS Code.

      settings.json                 "cline.*" -> "cerebriline.*"
        Only keys with that exact prefix, only in VS Code's user settings.
        A backup is written beside the file first.

    It does NOT touch `.cline` folders inside your projects (rules, agents,
    plugins and generated images live there). That name is unchanged and still
    read: it is a convention shared with upstream Cline, so a repository you
    work on with other people keeps working for all of you. Nothing to do.

    Nor is it mandatory. If you install Cerebriline before running this, it
    falls back to the old `~/.cline` and your history is all still there - the
    script tidies the layout, it does not rescue it.

    CLOSE VS CODE FIRST. The script refuses to run while it is open: VS Code
    writes to these files continuously and would overwrite the migration, or
    lose whatever it was holding in memory.

.PARAMETER WhatIf
    Show everything the script would do, and do none of it. Worth running
    first - it prints the sizes, so you can see what is about to move.

.PARAMETER Force
    Run even though VS Code appears to be open. Nothing good comes of this;
    it exists because a stale process can pin the check.

.PARAMETER KeepOldExtension
    Leave the old extension installed. By default it is uninstalled once the
    data has moved, because two builds of the same agent both watching the
    same workspace is confusing and they will fight over the diff view.

.PARAMETER SkipSettings
    Do not rewrite the `cline.*` keys in settings.json.

.EXAMPLE
    .\Migrate-ToCerebriline.ps1 -WhatIf
    Show what would move, change nothing.

.EXAMPLE
    .\Migrate-ToCerebriline.ps1
    Do it.

.NOTES
    Windows PowerShell 5.1 and PowerShell 7 both work. No admin rights needed.
    Re-running it is safe: anything already migrated is reported and skipped.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Force,
    [switch]$KeepOldExtension,
    [switch]$SkipSettings
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$OLD_EXTENSION_ID = 'saoudrizwan.claude-dev'
$NEW_EXTENSION_ID = 'mann1x.cerebriline'
$OLD_SETTINGS_PREFIX = 'cline.'
$NEW_SETTINGS_PREFIX = 'cerebriline.'

$script:Moved = 0
$script:Skipped = 0
$script:Problems = @()

function Write-Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "   $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "   $Text" -ForegroundColor Gray }
function Write-Warn {
    param([string]$Text)
    Write-Host "   $Text" -ForegroundColor Yellow
    $script:Problems += $Text
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return "$Bytes B"
}

function Get-FreeSpace {
    param([string]$Path)
    try {
        $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
        $drive = Get-PSDrive -Name $root.TrimEnd('\\', ':') -ErrorAction Stop
        return [long]$drive.Free
    } catch {
        return -1  # unknown: do not block the migration on a check that failed
    }
}

function Measure-Tree {
    param([string]$Path)
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
    $bytes = 0
    foreach ($f in $files) { $bytes += $f.Length }
    return [pscustomobject]@{ Count = $files.Count; Bytes = $bytes }
}

<#
    Copy a directory tree, prove the copy landed, and only then move the
    original aside. The proof is deliberately not a hash of every file - on a
    session store of a few hundred megabytes that takes long enough that people
    interrupt it, and an interrupted migration is the thing this is trying to
    avoid. File count and total bytes catch a partial copy, which is the
    failure that actually happens (a full disk, a locked file, a stray
    antivirus scan).
#>
function Move-Tree {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$From,
        [string]$To,
        [string]$Label
    )

    if (-not (Test-Path -LiteralPath $From)) {
        Write-Note "$Label - nothing at $From, skipping"
        $script:Skipped++
        return
    }

    if (Test-Path -LiteralPath $To) {
        $existing = Measure-Tree -Path $To
        Write-Warn "$Label - $To already exists ($($existing.Count) files). Left alone; move or delete it and re-run if this is a leftover."
        return
    }

    $before = Measure-Tree -Path $From
    Write-Note "$Label - $($before.Count) files, $(Format-Size $before.Bytes)"
    Write-Note "  $From"
    Write-Note "  -> $To"

    # Copying rather than moving means both copies exist at once, and the
    # extension storage alone can be most of a gigabyte. Say so before filling
    # the disk rather than after.
    $free = Get-FreeSpace -Path $To
    if ($free -ge 0 -and $free -lt ($before.Bytes * 1.15)) {
        Write-Warn "$Label - not enough room: $(Format-Size $before.Bytes) to copy, $(Format-Size $free) free. Nothing was touched."
        return
    }

    if (-not $PSCmdlet.ShouldProcess($From, "copy to $To, verify, then set aside")) {
        return
    }

    Copy-Item -LiteralPath $From -Destination $To -Recurse -Force

    $after = Measure-Tree -Path $To
    if ($after.Count -ne $before.Count -or $after.Bytes -ne $before.Bytes) {
        Write-Warn "$Label - COPY DOES NOT MATCH: $($before.Count) files/$($before.Bytes) B in, $($after.Count) files/$($after.Bytes) B out. The original has NOT been touched. Delete $To and try again."
        return
    }

    # Renamed, never deleted. If something was missed, it is still here.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $parked = "$From.migrated-$stamp"
    Rename-Item -LiteralPath $From -NewName (Split-Path -Leaf $parked)
    Write-Ok "$Label - moved. Original kept at $parked"
    $script:Moved++
}

function Get-VSCodeUserDirectories {
    $roots = @()
    foreach ($name in @('Code', 'Code - Insiders', 'VSCodium')) {
        $candidate = Join-Path $env:APPDATA "$name\User"
        if (Test-Path -LiteralPath $candidate) {
            $roots += [pscustomobject]@{ Name = $name; Path = $candidate }
        }
    }
    return $roots
}

function Test-VSCodeRunning {
    $names = @('Code', 'Code - Insiders', 'VSCodium')
    foreach ($n in $names) {
        $p = Get-Process -Name $n -ErrorAction SilentlyContinue
        if ($p) { return $true }
    }
    return $false
}

<#
    Rewrite the `cline.` settings keys in place.

    Deliberately a text substitution on `"cline.` rather than a JSON parse and
    re-emit. VS Code's settings.json is JSONC: it has comments and trailing
    commas, and every PowerShell JSON round-trip loses both, along with the
    user's own ordering and formatting. Anchoring on the opening quote means a
    value that happens to contain the word cline is never touched - only a key.
#>
function Update-Settings {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$SettingsPath, [string]$Label)

    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        Write-Note "$Label - no settings.json, skipping"
        return
    }

    $text = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8
    $pattern = '"' + [regex]::Escape($OLD_SETTINGS_PREFIX)
    $hits = ([regex]::Matches($text, $pattern)).Count
    if ($hits -eq 0) {
        Write-Note "$Label - no $OLD_SETTINGS_PREFIX keys, nothing to do"
        return
    }

    Write-Note "$Label - $hits key(s) to rename in $SettingsPath"
    if (-not $PSCmdlet.ShouldProcess($SettingsPath, "rename $hits key(s)")) {
        return
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$SettingsPath.before-cerebriline-$stamp"
    Copy-Item -LiteralPath $SettingsPath -Destination $backup -Force

    $updated = $text -replace $pattern, ('"' + $NEW_SETTINGS_PREFIX)
    # No BOM: VS Code writes settings.json without one and adding it makes the
    # file look changed to every tool that reads it.
    [System.IO.File]::WriteAllText($SettingsPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "$Label - $hits key(s) renamed. Backup at $backup"
    $script:Moved++
}

function Remove-OldExtension {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    $code = Get-Command code -ErrorAction SilentlyContinue
    if (-not $code) {
        Write-Warn "The 'code' command is not on PATH, so the old extension could not be uninstalled. Remove '$OLD_EXTENSION_ID' from the Extensions view by hand."
        return
    }
    $installed = @(& code --list-extensions 2>$null)
    if ($installed -notcontains $OLD_EXTENSION_ID) {
        Write-Note "Old extension is not installed, nothing to remove"
        return
    }
    if (-not $PSCmdlet.ShouldProcess($OLD_EXTENSION_ID, 'uninstall')) {
        return
    }
    & code --uninstall-extension $OLD_EXTENSION_ID 2>&1 | Out-Null
    Write-Ok "Uninstalled $OLD_EXTENSION_ID"
    $script:Moved++
}

# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '  Cline (mann1x build)  ->  Cerebriline' -ForegroundColor White
Write-Host '  ------------------------------------' -ForegroundColor DarkGray

if ($WhatIfPreference) {
    Write-Host '  DRY RUN - nothing will be changed.' -ForegroundColor Yellow
}

Write-Step 'Checking VS Code is closed'
if (Test-VSCodeRunning) {
    if (-not $Force -and -not $WhatIfPreference) {
        Write-Host ''
        Write-Host '   VS Code is running. Close every window and run this again.' -ForegroundColor Red
        Write-Host '   It writes to these files continuously; migrating underneath it' -ForegroundColor Red
        Write-Host '   loses whatever it is holding in memory. (-Force overrides.)' -ForegroundColor Red
        Write-Host ''
        exit 1
    }
    Write-Warn 'VS Code is running and -Force was given. This may lose data.'
} else {
    Write-Ok 'Closed'
}

Write-Step 'Data directory'
Move-Tree -From (Join-Path $HOME '.cline') -To (Join-Path $HOME '.cerebriline') -Label 'Sessions and settings'

Write-Step 'Documents'
Move-Tree -From (Join-Path $HOME 'Documents\Cline') -To (Join-Path $HOME 'Documents\Cerebriline') -Label 'Agents, hooks, rules, workflows'

Write-Step 'VS Code extension storage'
$userDirs = @(Get-VSCodeUserDirectories)
if ($userDirs.Count -eq 0) {
    Write-Note 'No VS Code user directory found under %APPDATA%'
}
foreach ($dir in $userDirs) {
    Move-Tree `
        -From (Join-Path $dir.Path "globalStorage\$OLD_EXTENSION_ID") `
        -To (Join-Path $dir.Path "globalStorage\$NEW_EXTENSION_ID") `
        -Label $dir.Name
}

if (-not $SkipSettings) {
    Write-Step 'Settings keys'
    foreach ($dir in $userDirs) {
        Update-Settings -SettingsPath (Join-Path $dir.Path 'settings.json') -Label $dir.Name
    }
}

if (-not $KeepOldExtension) {
    Write-Step 'Old extension'
    Remove-OldExtension
}

Write-Host ''
Write-Host '  ------------------------------------' -ForegroundColor DarkGray
if ($WhatIfPreference) {
    Write-Host '  Dry run finished. Nothing was changed.' -ForegroundColor Yellow
    Write-Host '  Run again without -WhatIf to do it.' -ForegroundColor Yellow
} else {
    Write-Host "  $($script:Moved) thing(s) migrated, $($script:Skipped) not present." -ForegroundColor White
    if ($script:Problems.Count -gt 0) {
        Write-Host ''
        Write-Host '  Needs your attention:' -ForegroundColor Yellow
        foreach ($p in $script:Problems) { Write-Host "    - $p" -ForegroundColor Yellow }
    }
    Write-Host ''
    Write-Host '  Nothing was deleted. Originals are kept as *.migrated-<timestamp>' -ForegroundColor Gray
    Write-Host '  next to where they were; remove them once you are happy.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Now install Cerebriline and start VS Code.' -ForegroundColor White
}
Write-Host ''
