$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
    throw "Run this file from the root of an ai-prompt-macro Git clone."
}

function Invoke-GitChecked {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    & git -C $RepoRoot @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed (exit=$LASTEXITCODE)."
    }
}

$Branch = (& git -C $RepoRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not read the current Git branch."
}
if ($Branch -ne "main") {
    throw "Automatic update is allowed only on main. Current branch: $Branch"
}

$Dirty = @(& git -C $RepoRoot status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw "git status failed."
}
if ($Dirty.Count -gt 0) {
    Write-Host "Update stopped because the working tree has uncommitted or untracked changes:" -ForegroundColor Yellow
    $Dirty | ForEach-Object { Write-Host "  $_" }
    throw "Commit or stash the changes, then run the updater again."
}

Write-Host "Updating AI Prompt Macro from origin/main with fast-forward only..."
Invoke-GitChecked pull --ff-only origin main

$ManifestPath = Join-Path $RepoRoot "manifest.json"
$Version = if (Test-Path $ManifestPath) {
    (Get-Content $ManifestPath -Raw | ConvertFrom-Json).version
} else {
    "unknown"
}

Write-Host ""
Write-Host "Update complete: AI Prompt Macro v$Version" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. AI Prompt Macro Side Panel > Development update > Reload extension"
Write-Host "  2. Reload the ChatGPT tab with Ctrl+R"
