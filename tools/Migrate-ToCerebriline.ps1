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

    Close anything else looking at those files too. Renaming a folder on
    Windows needs every handle inside it closed, and a file does not have to be
    open in an editor to be held - an Explorer preview pane is enough. If the
    old folder cannot be set aside, the script says so, names the process
    holding it, and carries on; the data has already been copied and verified
    at that point, so nothing is at risk and you can re-run it afterwards.

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

.PARAMETER Backup
    Copy everything to a timestamped backup folder before touching any of it,
    without asking. With neither this nor -SkipBackup you are asked, and the
    default answer is yes.

.PARAMETER SkipBackup
    Do not back up, and do not ask.

    Worth knowing before you choose: the migration is already written not to
    lose anything. Every tree is copied, the copy is verified, and only then is
    the original renamed aside as `*.migrated-<timestamp>`; settings.json is the
    one file edited in place, and it gets a `.bak` beside it either way. What a
    backup adds is a single restore point for the whole run, which is what you
    want if it is interrupted halfway - a power cut, a closed lid, Ctrl-C.

    It is a full second copy, so it needs as much room again as the data: on a
    typical install that is a gigabyte or so, mostly VS Code extension storage.

.PARAMETER BackupPath
    Where the backup goes. Defaults to a timestamped folder in your home
    directory.

.EXAMPLE
    .\Migrate-ToCerebriline.ps1 -WhatIf
    Show what would move, change nothing.

.EXAMPLE
    .\Migrate-ToCerebriline.ps1
    Do it, asking first whether to back up.

.EXAMPLE
    .\Migrate-ToCerebriline.ps1 -Backup
    Do it, backing up first, no questions. This is the cautious run.

.EXAMPLE
    .\Migrate-ToCerebriline.ps1 -SkipBackup
    Do it without a backup and without asking.

.NOTES
    Windows PowerShell 5.1 and PowerShell 7 both work. No admin rights needed.
    Re-running it is safe: anything already migrated is reported and skipped.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Force,
    [switch]$KeepOldExtension,
    [switch]$SkipSettings,
    [switch]$Backup,
    [switch]$SkipBackup,
    [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$OLD_EXTENSION_ID = 'saoudrizwan.claude-dev'
$NEW_EXTENSION_ID = 'mann1x.cerebriline'
$OLD_SETTINGS_PREFIX = 'cline.'
$NEW_SETTINGS_PREFIX = 'cerebriline.'

if ($Backup -and $SkipBackup) {
    Write-Host ''
    Write-Host '   -Backup and -SkipBackup contradict each other. Pick one.' -ForegroundColor Red
    Write-Host ''
    exit 2
}

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
    Everything the migration is about to touch, as a list, so the backup and
    the migration cannot disagree about what "everything" means.
#>
function Get-MigrationSources {
    $sources = @()
    $sources += [pscustomobject]@{ Path = (Join-Path $HOME '.cline'); Under = 'home'; Leaf = '.cline' }
    $sources += [pscustomobject]@{ Path = (Join-Path $HOME 'Documents\Cline'); Under = 'home\Documents'; Leaf = 'Cline' }
    foreach ($dir in @(Get-VSCodeUserDirectories)) {
        $sources += [pscustomobject]@{
            Path  = (Join-Path $dir.Path "globalStorage\$OLD_EXTENSION_ID")
            Under = "$($dir.Name)\globalStorage"
            Leaf  = $OLD_EXTENSION_ID
        }
        $sources += [pscustomobject]@{
            Path  = (Join-Path $dir.Path 'settings.json')
            Under = $dir.Name
            Leaf  = 'settings.json'
        }
    }
    return $sources | Where-Object { Test-Path -LiteralPath $_.Path }
}

<#
    A single restore point for the whole run.

    The migration already keeps every original, so this is not what stops you
    losing data in the normal case -- it is what you want when a run is
    interrupted partway and you would rather start again from a known state
    than work out which half happened.

    A manifest goes in beside it, because a backup you cannot work out how to
    restore is not one.
#>
function New-Backup {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$Destination)

    $sources = @(Get-MigrationSources)
    if ($sources.Count -eq 0) {
        Write-Note 'Nothing present to back up.'
        return $true
    }

    $totalFiles = 0
    $totalBytes = 0
    foreach ($src in $sources) {
        if (Test-Path -LiteralPath $src.Path -PathType Container) {
            $m = Measure-Tree -Path $src.Path
            $totalFiles += $m.Count; $totalBytes += $m.Bytes
        } else {
            $totalFiles += 1
            $totalBytes += (Get-Item -LiteralPath $src.Path).Length
        }
    }

    Write-Note "$totalFiles files, $(Format-Size $totalBytes) -> $Destination"

    # The backup and the migration's own copy are both live at once, so the
    # disk has to hold the data twice over plus headroom.
    $free = Get-FreeSpace -Path (Split-Path -Parent $Destination)
    $needed = [long]($totalBytes * 2.15)
    if ($free -ge 0 -and $free -lt $needed) {
        Write-Warn "Not enough room to back up AND migrate: $(Format-Size $needed) wanted, $(Format-Size $free) free. Nothing was touched."
        return $false
    }

    if (-not $PSCmdlet.ShouldProcess($Destination, "back up $totalFiles files")) {
        return $true
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $manifest = @()
    $manifest += "Cerebriline migration backup"
    $manifest += "Taken:  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $manifest += "Script: $($MyInvocation.MyCommand.Name)"
    $manifest += ''
    $manifest += 'To restore, copy each item back over the path on the right.'
    $manifest += ''

    foreach ($src in $sources) {
        $targetDir = Join-Path $Destination $src.Under
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        $target = Join-Path $targetDir $src.Leaf

        if (Test-Path -LiteralPath $src.Path -PathType Container) {
            $before = Measure-Tree -Path $src.Path
            Copy-Item -LiteralPath $src.Path -Destination $target -Recurse -Force
            $after = Measure-Tree -Path $target
            if ($after.Count -ne $before.Count -or $after.Bytes -ne $before.Bytes) {
                Write-Warn "Backup of $($src.Path) does not match ($($before.Count)/$(Format-Size $before.Bytes) -> $($after.Count)/$(Format-Size $after.Bytes)). Nothing else was touched."
                return $false
            }
            Write-Ok "$($src.Leaf) - $($after.Count) files, $(Format-Size $after.Bytes)"
        } else {
            Copy-Item -LiteralPath $src.Path -Destination $target -Force
            if ((Get-Item -LiteralPath $target).Length -ne (Get-Item -LiteralPath $src.Path).Length) {
                Write-Warn "Backup of $($src.Path) is the wrong size. Nothing else was touched."
                return $false
            }
            Write-Ok "$($src.Leaf)"
        }
        $manifest += ("  {0,-58} -> {1}" -f (Join-Path $src.Under $src.Leaf), $src.Path)
    }

    $manifest += ''
    $manifest += "Total: $totalFiles files, $(Format-Size $totalBytes)"
    Set-Content -LiteralPath (Join-Path $Destination 'MANIFEST.txt') -Value $manifest -Encoding UTF8
    Write-Ok "Manifest written to $(Join-Path $Destination 'MANIFEST.txt')"
    return $true
}

<#
    Ask, unless the answer was already given on the command line.

    Defaults to yes on an empty answer, and yes again when there is nobody to
    ask -- an unattended run is exactly where an unrecoverable mistake is worst,
    so silence means the cautious branch, never the fast one.
#>
function Confirm-Backup {
    if ($SkipBackup) { return $false }
    if ($Backup) { return $true }

    if (-not [Environment]::UserInteractive) {
        Write-Note 'Not an interactive session; backing up (use -SkipBackup to skip).'
        return $true
    }

    Write-Host ''
    Write-Host '   Back up everything first?' -ForegroundColor White
    Write-Host '   The migration keeps your originals either way; a backup is the' -ForegroundColor Gray
    Write-Host '   single restore point if the run is interrupted halfway.' -ForegroundColor Gray
    Write-Host '   It needs as much disk again as your data.' -ForegroundColor Gray
    Write-Host ''
    try {
        $answer = Read-Host '   Back up first? [Y/n]'
    } catch {
        Write-Note 'Could not read an answer; backing up.'
        return $true
    }
    if ($null -eq $answer) { return $true }
    $answer = $answer.Trim()
    if ($answer -eq '') { return $true }
    return ($answer -notmatch '^(n|no)$')
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
    #
    # This is also the step that fails, and it fails for a reason nobody
    # guesses: renaming a directory needs every handle inside it closed, and
    # closing VS Code is not enough. An Explorer preview pane counts. A file
    # open in another editor counts. The first real run of this script died
    # here because PowerToys' Monaco preview handler was showing
    # `cline_mcp_settings.json` in Explorer's reading pane.
    #
    # So: say who is holding it, and carry on with the rest rather than
    # abandoning the migration halfway. The copy is already made and verified;
    # what is left undone is only the tidying of the old name.
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $parked = "$From.migrated-$stamp"
    try {
        Rename-Item -LiteralPath $From -NewName (Split-Path -Leaf $parked) -ErrorAction Stop
    } catch {
        $holders = Find-Holders -Path $From
        $who = if ($holders) { "Holding it: $($holders -join '; ')" } else { 'Could not identify what is holding it.' }
        Write-Warn "$Label - copied to $To and verified, but the old folder could not be renamed aside: $($_.Exception.Message) $who Close it and rename $From by hand, or re-run."
        return
    }
    Write-Ok "$Label - moved. Original kept at $parked"
    $script:Moved++
}

<#
    Name what is holding a path open, so "access is denied" becomes something
    a person can act on.

    Windows will not tell us the handle owners without a debugger privilege, so
    this looks for the answer that is actually available and is nearly always
    the right one: a running process whose command line names a file under the
    path. Preview handlers, editors and viewers are all launched that way.
#>
function Find-Holders {
    param([string]$Path)
    $needle = [regex]::Escape($Path)
    $found = @()
    try {
        foreach ($proc in Get-CimInstance Win32_Process -ErrorAction Stop) {
            if ($proc.CommandLine -and $proc.CommandLine -match $needle) {
                $found += "$($proc.Name) (PID $($proc.ProcessId))"
            }
        }
    } catch {
        return @()
    }
    return $found | Select-Object -Unique
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
    Write-Note 'Also close any Explorer preview pane or editor showing these files.'
}

if (-not $SkipBackup) {
    Write-Step 'Backup'
    if (Confirm-Backup) {
        if (-not $BackupPath) {
            $BackupPath = Join-Path $HOME "Cerebriline-Migration-Backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        }
        if (-not (New-Backup -Destination $BackupPath)) {
            Write-Host ''
            Write-Host '   Backup failed. Stopping before anything is migrated.' -ForegroundColor Red
            Write-Host ''
            exit 3
        }
    } else {
        Write-Note 'Skipped at your request.'
    }
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
    if ($BackupPath -and (Test-Path -LiteralPath $BackupPath)) {
        Write-Host ''
        Write-Host "  Backup: $BackupPath" -ForegroundColor Gray
        Write-Host '  See MANIFEST.txt in there for what came from where.' -ForegroundColor Gray
    }
    Write-Host ''
    Write-Host '  Now install Cerebriline and start VS Code.' -ForegroundColor White
}
Write-Host ''
