# Publish this branch to the target branch as a single squashed commit, minus
# everything .syncignore lists.
#
# The two branches deliberately differ: IC10-V3 tracks CLAUDE.md, DEVELOPER.md
# and .claude/ so they are backed up; main is the public branch and must not
# carry them. .gitignore cannot express that on its own, because it has no
# effect on files git already tracks - a plain merge would bring all three
# across.
#
# So no merge is taken at all. The source tree is copied over wholesale and
# whatever .syncignore matches is then dropped from the index. The sync can
# therefore never hit a merge conflict, because git is never asked to reconcile
# the two trees.
#
# .syncignore lives on this branch, next to the script, so excluding something
# new is one edit here rather than a commit on the target. It is a closed list
# read with `git ls-files --exclude-from`: the target's own .gitignore, a global
# gitignore and any nested .gitignore have no say, so nothing can quietly strip
# a real source file from the target.
#
# That split - .syncignore for what must not be published, .gitignore for
# ordinary build artifacts - is what lets .gitignore stay identical on both
# branches. The target holds no state of its own at all now: its tree is a pure
# function of this branch's tree and this file.
#
# Because each sync copies the whole tree rather than replaying a diff, squashing
# costs nothing: the result depends only on the two tips, never on the history
# between them. What it does give up is git's record that the source was merged.
# `git branch --merged` will not list the source, and the target's history holds
# no source commits, so the position of the last sync is recovered by reading it
# back out of the previous sync commit's subject - which is also what lets the
# squashed commit list the commits it stands for.
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
    [string] $ExcludeFile = ".syncignore",
    [switch] $Push
)

$ErrorActionPreference = "Stop"

# Subject line of a sync commit. The trailing "(<rev>)" is parsed back off the
# target's log to find where the last sync left the source, so the two halves
# have to stay in step.
function Get-SyncSubject {
    param([string] $Rev)
    return "Sync $Target from $Source ($Rev)"
}
$SyncSubjectPattern = "^Sync $([regex]::Escape($Target)) from $([regex]::Escape($Source)) \(([0-9a-f]+)\)$"

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') exited with $LASTEXITCODE" }
}

# The source commit the previous sync captured, or $null if there is no usable
# marker. Anything unusable - no previous sync, an unparseable subject, a commit
# that has since been rebased away - only costs the commit list, so it is not an
# error.
function Get-LastSyncedRev {
    $subjects = @(& git log --format=%s $Target)
    if ($LASTEXITCODE -ne 0) { return $null }
    foreach ($subject in $subjects) {
        $match = [regex]::Match($subject, $SyncSubjectPattern)
        if (-not $match.Success) { continue }
        $rev = $match.Groups[1].Value
        # Resolve before asking about ancestry: a rev that has been rebased or
        # gc'd away is unknown to merge-base, which would fail loudly rather
        # than answer no.
        & git rev-parse --verify --quiet "$rev^{commit}" > $null
        if ($LASTEXITCODE -ne 0) { return $null }
        & git merge-base --is-ancestor $rev $Source
        if ($LASTEXITCODE -eq 0) { return $rev }
        return $null
    }
    return $null
}

$root = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw "Not inside a git repository." }
Set-Location $root

foreach ($branch in @($Source, $Target)) {
    & git rev-parse --verify --quiet "refs/heads/$branch" > $null
    if ($LASTEXITCODE -ne 0) { throw "No local branch '$branch'." }
}

# Read off the source rather than the working tree: it is the copy that will be
# in place when the exclusions are applied, and its absence means every excluded
# file would be published.
& git rev-parse --verify --quiet "${Source}:${ExcludeFile}" > $null
if ($LASTEXITCODE -ne 0) { throw "$Source does not track $ExcludeFile - refusing to sync without an exclusion list." }

$dirty = & git status --porcelain
if ($dirty) { throw "Working tree is not clean. Commit or stash first:`n$dirty" }

$startingBranch = & git rev-parse --abbrev-ref HEAD
$sourceRev = & git rev-parse --short $Source

# Paths the target still tracks that the source no longer has. `git checkout
# <source> -- .` adds and updates but never deletes, so these have to be removed
# by hand or the target quietly keeps files the source dropped.
$stale = @(& git diff --name-only --diff-filter=A $Source $Target)

$messageFile = $null

try {
    Invoke-Git checkout --quiet $Target

    # Read before the tree is touched; it only looks at committed history, but
    # the previous sync commit is the target's tip and must not be confused with
    # the one about to be written.
    $lastSynced = Get-LastSyncedRev

    Invoke-Git checkout $Source -- .

    if ($stale.Count -gt 0) {
        Write-Host "Removing paths dropped on ${Source}:" -ForegroundColor Yellow
        $stale | ForEach-Object { Write-Host "  $_" }
        Invoke-Git rm -r --quiet --force --ignore-unmatch -- @stale
    }

    # Tracked files matching .syncignore, which the copy above just staged.
    # --cached leaves them in the working tree.
    $ignored = @(& git ls-files --cached --ignored --exclude-from=$ExcludeFile)
    if ($LASTEXITCODE -ne 0) { throw "git ls-files exited with $LASTEXITCODE" }
    if ($ignored.Count -gt 0) {
        Write-Host "Excluding from ${Target} (per ${ExcludeFile}):" -ForegroundColor Yellow
        $ignored | ForEach-Object { Write-Host "  $_" }
        Invoke-Git rm -r --cached --quiet -- @ignored
    }

    # With no merge to record, an unchanged tree means there is nothing to do -
    # including when the source advanced by commits that only touched excluded
    # files. `git commit` would fail on the empty commit rather than say so.
    & git diff --cached --quiet HEAD
    if ($LASTEXITCODE -eq 0) {
        Write-Host "$Target is already up to date with $Source." -ForegroundColor Green
    } else {
        $lines = @((Get-SyncSubject $sourceRev))
        if ($lastSynced) {
            $squashed = @(& git log --format="  %h %s" --reverse "$lastSynced..$Source")
            if ($squashed.Count -gt 0) {
                $lines += ""
                $lines += "Squashed from ${Source}:"
                $lines += $squashed
            }
        }
        # -F rather than -m: the body is multi-line, and passing embedded
        # newlines through PowerShell's native-command quoting is not reliable.
        $messageFile = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText(
            $messageFile,
            ($lines -join "`n") + "`n",
            (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Git commit --quiet -F $messageFile

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
    if ($messageFile -and (Test-Path $messageFile)) { Remove-Item -Force $messageFile }

    # On the failure path this discards a half-applied copy; the target's ref is
    # never moved before the commit, so it is unharmed either way. After a
    # successful commit the tree is already clean and the reset does nothing
    # (it leaves ignored and untracked files alone).
    if ((& git rev-parse --abbrev-ref HEAD) -ne $startingBranch) {
        & git reset --hard --quiet HEAD
        & git checkout --quiet --force $startingBranch
        Write-Host "Back on $startingBranch."
    }
}
