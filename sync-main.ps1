# Publish this branch to the target branch, minus everything the target's
# .gitignore lists.
#
# The two branches deliberately differ: IC10-V3 tracks CLAUDE.md, DEVELOPER.md
# and .claude/ so they are backed up; main is the public branch and must not
# carry them. .gitignore alone cannot express that, because it has no effect on
# files git already tracks - a plain merge would bring all three across.
#
# So the merge is taken with -s ours (which records the merge but keeps none of
# the source tree), the source tree is then copied over explicitly, and the
# target's own .gitignore is restored and used to decide what to drop from the
# index. That makes the target's .gitignore the single source of truth for the
# difference between the branches, and means this can never hit a merge
# conflict - git is never asked to reconcile the two trees.
#
# Dropped files are removed from the index but left on disk, so switching back
# to the source branch does not have to rewrite them.
#
#   .\sync-main.ps1              # sync, leave the commit local
#   .\sync-main.ps1 -Push        # sync and push the target branch
#
# Run it from the source branch with a clean working tree.

[CmdletBinding()]
param(
    [string] $Source = "IC10-V3",
    [string] $Target = "main",
    [string] $Remote = "origin",
    [switch] $Push
)

$ErrorActionPreference = "Stop"

# Files the target keeps its own version of rather than taking from the source.
# .gitignore is the whole mechanism, so it must not be overwritten by the copy.
$KeepFromTarget = @(".gitignore")

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') exited with $LASTEXITCODE" }
}

function Test-MergeInProgress {
    & git rev-parse --verify --quiet MERGE_HEAD > $null
    return $LASTEXITCODE -eq 0
}

$root = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw "Not inside a git repository." }
Set-Location $root

foreach ($branch in @($Source, $Target)) {
    & git rev-parse --verify --quiet "refs/heads/$branch" > $null
    if ($LASTEXITCODE -ne 0) { throw "No local branch '$branch'." }
}

$dirty = & git status --porcelain
if ($dirty) { throw "Working tree is not clean. Commit or stash first:`n$dirty" }

$startingBranch = & git rev-parse --abbrev-ref HEAD

# Paths the target still tracks that the source no longer has. `git checkout
# <source> -- .` adds and updates but never deletes, so these have to be removed
# by hand or the target quietly keeps files the source dropped.
$stale = @(& git diff --name-only --diff-filter=A $Source $Target)

try {
    Invoke-Git checkout --quiet $Target
    Invoke-Git merge -s ours --no-commit --no-ff $Source

    Invoke-Git checkout $Source -- .
    foreach ($path in $KeepFromTarget) {
        # HEAD is the target's tip: the merge is not committed yet.
        Invoke-Git checkout HEAD -- $path
    }

    if ($stale.Count -gt 0) {
        Write-Host "Removing paths dropped on ${Source}:" -ForegroundColor Yellow
        $stale | ForEach-Object { Write-Host "  $_" }
        Invoke-Git rm -r --quiet --force --ignore-unmatch -- @stale
    }

    # Tracked files matching the target's .gitignore, which the copy above just
    # staged. --cached leaves them in the working tree.
    $ignored = @(& git ls-files --cached --ignored --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw "git ls-files exited with $LASTEXITCODE" }
    if ($ignored.Count -gt 0) {
        Write-Host "Excluding from ${Target} (per its .gitignore):" -ForegroundColor Yellow
        $ignored | ForEach-Object { Write-Host "  $_" }
        Invoke-Git rm -r --cached --quiet -- @ignored
    }

    # `merge -s ours` says "Already up to date" and starts nothing when the
    # source is already an ancestor, so there may be neither a merge to record
    # nor a staged change - and `git commit` would fail on the empty commit.
    # A merge that is in progress is always committed even when the tree is
    # unchanged, so that a source commit touching only excluded files still
    # advances the merge base and does not get re-examined next run.
    & git diff --cached --quiet HEAD
    $staged = $LASTEXITCODE -ne 0
    if (-not (Test-MergeInProgress) -and -not $staged) {
        Write-Host "$Target is already up to date with $Source." -ForegroundColor Green
    } else {
        $rev = & git rev-parse --short $Source
        Invoke-Git commit --quiet -m "Sync $Target from $Source ($rev)"
        Write-Host "Committed on $Target." -ForegroundColor Green
        & git show --stat --oneline HEAD
    }

    if ($Push) {
        Invoke-Git push $Remote $Target
        Write-Host "Pushed $Target to $Remote." -ForegroundColor Green
    } else {
        Write-Host "Not pushed. When it looks right: git push $Remote $Target" -ForegroundColor Cyan
    }
} finally {
    # On the failure path this abandons a half-applied merge; on the success
    # path there is nothing in progress and only the checkout runs.
    if (Test-MergeInProgress) {
        & git merge --abort
        Write-Host "Merge aborted; $Target is unchanged." -ForegroundColor Red
    }
    if ((& git rev-parse --abbrev-ref HEAD) -ne $startingBranch) {
        & git checkout --quiet --force $startingBranch
        Write-Host "Back on $startingBranch."
    }
}
