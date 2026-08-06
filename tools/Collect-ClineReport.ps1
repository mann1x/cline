<#
.SYNOPSIS
    Collects Cline session transcripts and logs into a zip for analysis.

.DESCRIPTION
    Gathers the transcript of one or more Cline tasks, the extension's own
    output log, and a short description of the machine, into a single zip.

    Run with no arguments it lists the sessions on this machine - when each
    ran, which model, how it ended, how large the transcript is and the task
    it was given - and puts the ones you tick into the zip.

    WHAT THIS CONTAINS. The transcript is the full conversation: every prompt,
    every model reply, and the contents of every file the model read or wrote.
    If the task touched private code, that code is in the zip. Read the
    manifest the script prints before sending it to anyone.

    Provider settings are included with credential-shaped values replaced by
    [REDACTED] — any field whose name looks like a key, token, secret or
    password. The redaction is by field name, so check the file if you keep
    credentials somewhere unusual.

.PARAMETER SessionCount
    Take this many of the most recent sessions without asking. Passing it at
    all skips the picker.

.PARAMETER SessionId
    Collect this specific session id, without asking.

.PARAMETER Latest
    Skip the picker and take the most recent session (or -SessionCount of
    them). Useful when the script is run from another script.

.PARAMETER OutputPath
    Directory to write the zip to. Default: Desktop.

.PARAMETER IncludeOllamaRequests
    Also include raw Ollama request bodies from %TEMP% when Ollama was run with
    OLLAMA_DEBUG request logging. These are large and contain the full prompt.

.PARAMETER NoSettings
    Skip provider settings entirely.

.PARAMETER StripImages
    Replace the base64 payload of every image in the transcript with a
    placeholder - screenshots the browser tool returned, and images embedded
    in files the model read. Use it when the zip is too large to send. The
    transcript is otherwise byte-identical, including the text that came back
    alongside each picture.

.EXAMPLE
    .\Collect-ClineReport.ps1

    Lists the sessions and asks which to include.

.EXAMPLE
    .\Collect-ClineReport.ps1 -Latest

    Takes the most recent session without asking.

.EXAMPLE
    .\Collect-ClineReport.ps1 -SessionCount 3 -OutputPath C:\temp

.EXAMPLE
    .\Collect-ClineReport.ps1 -StripImages

    Leaves the screenshots out, for when the zip will not fit through
    whatever you are sending it with.
#>

[CmdletBinding()]
param(
    [int]$SessionCount = 1,
    [string]$SessionId,
    [switch]$Latest,
    [string]$OutputPath = [Environment]::GetFolderPath('Desktop'),
    [switch]$IncludeOllamaRequests,
    [switch]$NoSettings,
    [switch]$StripImages
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Manifest = New-Object System.Collections.ArrayList
$script:ImagesStripped = 0

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

# ------------------------------------------------------- image stripping ---
#
# Base64 is what makes a transcript too large to send, and it arrives by more
# than one route: a screenshot the browser tool returned, a sprite sheet the
# model read out of a source file, an inline data: URI. Keying on the JSON
# field would only catch the first, so match the payload by its own magic
# number instead - iVBORw0KGgo is a PNG header encoded, /9j/ a JPEG, R0lGOD a
# GIF, UklGR a WebP. That identifies an image wherever it sits, and prose
# cannot be mistaken for one.
#
# The character class stops at a backslash, so a match can never run past the
# end of the JSON string it lives in: base64 has no escapes, and every other
# byte in the file that could follow one does.

$ImagePayloadPattern = '(?<![A-Za-z0-9+/])(?:iVBORw0KGgo|/9j/|R0lGOD|UklGR)[A-Za-z0-9+/]{200,}={0,2}'

function Remove-ImageData {
    param([string]$Source, [string]$Destination)

    $text = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
    if ($null -eq $text) { return $null }

    $images = 0
    $chars  = 0
    foreach ($match in [regex]::Matches($text, $ImagePayloadPattern)) {
        $images++
        $chars += $match.Length
    }

    $evaluator = [System.Text.RegularExpressions.MatchEvaluator] {
        param($match)
        "[image removed by -StripImages: $($match.Length) base64 characters]"
    }
    $text = [regex]::Replace($text, $ImagePayloadPattern, $evaluator)

    # No BOM: Get-Content read one off if there was one, and a JSON parser at
    # the far end is entitled to choke on it.
    [System.IO.File]::WriteAllText($Destination, $text, (New-Object System.Text.UTF8Encoding($false)))

    return [pscustomobject]@{ Images = $images; Chars = $chars }
}

# ------------------------------------------------------ the session picker ---
#
# A transcript is only useful to whoever receives it if it is the right one.
# The name on disk is a uuid, so the person sending the report has nothing to
# choose by unless we read each session's metadata and show it: when it ran,
# which model, how it ended, and the first line of what was asked.

function Get-JsonField {
    param($Object, [string]$Name, $Default = '')

    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Get-SessionSummary {
    param($Dir)

    $meta = $null
    $metaPath = Join-Path $Dir.FullName "$($Dir.Name).json"
    if (Test-Path -LiteralPath $metaPath) {
        try {
            $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            # An unreadable header still leaves a transcript worth sending.
            $meta = $null
        }
    }

    $bytes = 0
    foreach ($file in Get-ChildItem -LiteralPath $Dir.FullName -File -ErrorAction SilentlyContinue) {
        $bytes += $file.Length
    }

    # started_at is the truth about when the work happened; the directory's
    # timestamp only says when something last touched it.
    $when = $Dir.LastWriteTime
    $started = [string](Get-JsonField $meta 'started_at')
    if ($started) {
        try { $when = [datetime]::Parse($started).ToLocalTime() } catch { }
    }

    [pscustomobject]@{
        Dir      = $Dir
        Id       = $Dir.Name
        When     = $when
        Provider = [string](Get-JsonField $meta 'provider' 'unknown')
        Model    = [string](Get-JsonField $meta 'model' 'unknown')
        Status   = [string](Get-JsonField $meta 'status')
        Cwd      = [string](Get-JsonField $meta 'cwd')
        Task     = (([string](Get-JsonField $meta 'prompt')) -replace '\s+', ' ').Trim()
        Bytes    = $bytes
    }
}

function Format-Size {
    param([long]$Bytes)

    if ($Bytes -ge 1MB) { return '{0,6:N1} MB' -f ($Bytes / 1MB) }
    return '{0,6:N0} KB' -f ($Bytes / 1KB)
}

function Format-Column {
    param([string]$Text, [int]$Width)

    if ($Text.Length -le $Width) { return $Text.PadRight($Width) }
    return $Text.Substring(0, $Width - 3) + '...'
}

function Format-SessionRow {
    param($Session)

    '{0}  {1}  {2}  {3}  {4}' -f
        $Session.When.ToString('yyyy-MM-dd HH:mm'),
        (Format-Column $Session.Model 28),
        (Format-Column $Session.Status 9),
        (Format-Size $Session.Bytes),
        (Format-Column $Session.Task 46)
}

function Select-SessionsGui {
    param($Sessions)

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Cline report - choose which sessions to send'
    $form.ClientSize = New-Object System.Drawing.Size(940, 520)
    $form.StartPosition = 'CenterScreen'
    $form.MinimizeBox = $false
    $form.MaximizeBox = $true
    $form.TopMost = $true

    $blurb = New-Object System.Windows.Forms.Label
    $blurb.Text = 'Tick the sessions to put in the zip. Each transcript holds the whole conversation, ' +
        'including the contents of every file the model read or wrote. Send only what you mean to share.'
    $blurb.SetBounds(12, 10, 916, 34)
    $blurb.Anchor = 'Top,Left,Right'
    $form.Controls.Add($blurb)

    $header = New-Object System.Windows.Forms.Label
    $header.Text = '     ' + ('{0}  {1}  {2}  {3}  {4}' -f
        'started         ', (Format-Column 'model' 28), (Format-Column 'status' 9), 'size   ', 'task')
    $header.Font = New-Object System.Drawing.Font('Consolas', 9, [System.Drawing.FontStyle]::Bold)
    $header.SetBounds(12, 48, 916, 18)
    $header.Anchor = 'Top,Left,Right'
    $form.Controls.Add($header)

    $list = New-Object System.Windows.Forms.CheckedListBox
    $list.SetBounds(12, 68, 916, 372)
    $list.Font = New-Object System.Drawing.Font('Consolas', 9)
    $list.CheckOnClick = $true
    $list.HorizontalScrollbar = $true
    $list.Anchor = 'Top,Left,Right,Bottom'
    foreach ($session in $Sessions) { [void]$list.Items.Add((Format-SessionRow $session)) }
    $form.Controls.Add($list)

    $total = New-Object System.Windows.Forms.Label
    $total.SetBounds(12, 450, 500, 20)
    $total.Anchor = 'Bottom,Left'
    $form.Controls.Add($total)

    $refreshTotal = {
        $bytes = 0
        foreach ($index in $list.CheckedIndices) { $bytes += $Sessions[$index].Bytes }
        $total.Text = '{0} selected, {1} of transcript' -f $list.CheckedIndices.Count, (Format-Size $bytes).Trim()
    }.GetNewClosure()

    # ItemCheck fires before the item's state flips, so read the total after
    # the control has settled rather than from inside the event. The cast is
    # required: BeginInvoke takes a Delegate, and Windows PowerShell will not
    # pick an overload for a bare script block.
    $updateTotal = [System.Action]$refreshTotal
    # There is nothing to marshal to before the window exists; the ticks set
    # up below the dialog are followed by a direct call.
    $list.Add_ItemCheck({
        if ($form.IsHandleCreated) { [void]$form.BeginInvoke($updateTotal) }
    }.GetNewClosure())

    $makeButton = {
        param([string]$Text, [int]$X)
        $button = New-Object System.Windows.Forms.Button
        $button.Text = $Text
        $button.SetBounds($X, 480, 110, 30)
        $button.Anchor = 'Bottom,Left'
        $form.Controls.Add($button)
        return $button
    }

    $all = & $makeButton 'Select all' 12
    $all.Add_Click({
        for ($i = 0; $i -lt $list.Items.Count; $i++) { $list.SetItemChecked($i, $true) }
    }.GetNewClosure())

    $none = & $makeButton 'Clear' 130
    $none.Add_Click({
        for ($i = 0; $i -lt $list.Items.Count; $i++) { $list.SetItemChecked($i, $false) }
    }.GetNewClosure())

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'Create zip'
    $ok.SetBounds(700, 480, 110, 30)
    $ok.Anchor = 'Bottom,Right'
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($ok)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.SetBounds(818, 480, 110, 30)
    $cancel.Anchor = 'Bottom,Right'
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)

    $form.AcceptButton = $ok
    $form.CancelButton = $cancel

    # The newest session is what someone reporting a problem almost always
    # wants, so it starts ticked and Enter alone is a sensible answer.
    if ($list.Items.Count -gt 0) { $list.SetItemChecked(0, $true) }
    & $refreshTotal

    $answer = $form.ShowDialog()
    $picked = @()
    if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
        foreach ($index in $list.CheckedIndices) { $picked += $Sessions[$index] }
    }
    $form.Dispose()

    return ,$picked
}

function Expand-IndexList {
    param([string]$Text, [int]$Count)

    $indexes = New-Object System.Collections.ArrayList
    foreach ($part in ($Text -split ',')) {
        $trimmed = $part.Trim()
        if ($trimmed -eq '') { continue }

        if ($trimmed -match '^(\d+)\s*-\s*(\d+)$') {
            $from = [int]$Matches[1]
            $to   = [int]$Matches[2]
            if ($from -gt $to) { $swap = $from; $from = $to; $to = $swap }
        } elseif ($trimmed -match '^\d+$') {
            $from = [int]$trimmed
            $to   = $from
        } else {
            continue
        }

        for ($n = $from; $n -le $to; $n++) {
            if ($n -ge 1 -and $n -le $Count) { [void]$indexes.Add($n - 1) }
        }
    }

    return @($indexes | Sort-Object -Unique)
}

function Select-SessionsConsole {
    param($Sessions)

    Add-Note ''
    Add-Note 'Sessions on this machine, newest first:' 'Cyan'
    Add-Note ('      {0}  {1}  {2}  {3}  {4}' -f
        'started         ', (Format-Column 'model' 28), (Format-Column 'status' 9), 'size   ', 'task') 'DarkGray'
    for ($i = 0; $i -lt $Sessions.Count; $i++) {
        Add-Note ('  {0,2}. {1}' -f ($i + 1), (Format-SessionRow $Sessions[$i]))
    }
    Add-Note ''
    Add-Note 'Which ones? Numbers like 1,3 or a range like 1-3, or "all". Blank takes the newest.' 'Yellow'

    $answer = Read-Host 'Sessions'
    if ($null -eq $answer -or $answer.Trim() -eq '') { return ,@($Sessions[0]) }
    if ($answer.Trim() -match '^(a|all)$') { return ,@($Sessions) }

    $picked = @()
    foreach ($index in (Expand-IndexList $answer $Sessions.Count)) { $picked += $Sessions[$index] }
    return ,$picked
}

function Select-Sessions {
    param($Sessions)

    try {
        return (Select-SessionsGui $Sessions)
    } catch {
        Add-Note "Could not open the picker window ($($_.Exception.Message)); asking here instead." 'DarkYellow'
        return (Select-SessionsConsole $Sessions)
    }
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

# Reading every session's header to build the list costs a file read each, so
# only go back as far as anyone plausibly would when reporting a problem.
$ListedSessionLimit = 40

$allDirs = @(Get-ChildItem -LiteralPath $sessionsRoot -Directory |
    Sort-Object LastWriteTime -Descending)

if ($allDirs.Count -eq 0) {
    Add-Note "No sessions found under $sessionsRoot." 'Red'
    exit 1
}

# An explicit id or count is an answer already given; only ask when nothing
# in the invocation says which sessions are wanted, and never ask when there
# is no one there to answer.
$chosen = $null
if ($SessionId) {
    $chosen = @($allDirs | Where-Object { $_.Name -eq $SessionId } | ForEach-Object { Get-SessionSummary $_ })
    if ($chosen.Count -eq 0) {
        Add-Note "No session directory named '$SessionId'." 'Red'
        exit 1
    }
} elseif ($Latest -or $PSBoundParameters.ContainsKey('SessionCount') -or -not [Environment]::UserInteractive) {
    $chosen = @($allDirs | Select-Object -First $SessionCount | ForEach-Object { Get-SessionSummary $_ })
} else {
    $offered = @($allDirs | Select-Object -First $ListedSessionLimit | ForEach-Object { Get-SessionSummary $_ })
    $chosen = @(Select-Sessions $offered)
    if ($chosen.Count -eq 0) {
        Add-Note 'Nothing selected, so nothing was collected.' 'Yellow'
        exit 1
    }
}

Add-Note ''
Add-Note ("Collecting {0} session(s):" -f $chosen.Count) 'Cyan'
$chosenBytes = 0
foreach ($session in $chosen) {
    $chosenBytes += $session.Bytes
    Add-Note ("  {0}  {1}" -f $session.Id, (Format-SessionRow $session)) 'DarkGray'
}

# A transcript that will not fit through email or a chat upload is the usual
# reason a report never arrives. Say so here rather than at the far end.
if ($chosenBytes -ge 20MB) {
    Add-Note ''
    Add-Note ("These transcripts total {0} before compression, which many chat and mail" -f (Format-Size $chosenBytes).Trim()) 'Yellow'
    Add-Note 'clients will refuse. If the zip turns out to be too large to send, run again' 'Yellow'
    if ($StripImages) {
        Add-Note 'and pick fewer sessions.' 'Yellow'
    } else {
        Add-Note 'with -StripImages, or pick fewer sessions.' 'Yellow'
    }
}

$sessionDirs = @($chosen | ForEach-Object { $_.Dir })

$sessionTarget = Join-Path $staging 'sessions'
New-Item -ItemType Directory -Path $sessionTarget -Force | Out-Null

foreach ($dir in $sessionDirs) {
    $dest = Join-Path $sessionTarget $dir.Name
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    foreach ($file in Get-ChildItem -LiteralPath $dir.FullName -File) {
        $target = Join-Path $dest $file.Name

        $stripped = $null
        if ($StripImages -and $file.Name -like '*.messages.json') {
            try {
                $stripped = Remove-ImageData -Source $file.FullName -Destination $target
            } catch {
                Add-Note "  Could not strip images from $($file.Name): $($_.Exception.Message)" 'DarkYellow'
                $stripped = $null
            }
        }
        if ($null -eq $stripped) {
            Copy-Item -LiteralPath $file.FullName -Destination $target
        }

        $kb = [math]::Round((Get-Item -LiteralPath $target).Length / 1KB, 1)
        $note = "$($file.Name) (${kb} KB)"
        if ($null -ne $stripped -and $stripped.Images -gt 0) {
            $script:ImagesStripped += $stripped.Images
            $note += ", $($stripped.Images) image(s) removed"
        }
        Add-Item "session/$($dir.Name)" $note
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
    imagesStripped    = $script:ImagesStripped
    sessionsCollected = @($chosen | ForEach-Object {
        [ordered]@{
            id       = $_.Id
            started  = $_.When.ToString('s')
            provider = $_.Provider
            model    = $_.Model
            status   = $_.Status
            cwd      = $_.Cwd
            task     = $_.Task
        }
    })
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
Sessions   : $(($chosen | ForEach-Object {
                 '{0}  {1}  {2}' -f $_.When.ToString('yyyy-MM-dd HH:mm'), $_.Model, $_.Id
             }) -join "`n             ")

Contents
--------
sessions/<id>/<id>.messages.json    The full transcript: prompts, replies,
                                    tool calls, and the contents of every file
                                    that was read or written.$(if ($script:ImagesStripped -gt 0) {
"
                                    Run with -StripImages: $($script:ImagesStripped) base64 image(s),
                                    screenshots and any embedded in the files
                                    that were read, are replaced by a
                                    placeholder. Nothing else was changed." })
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
