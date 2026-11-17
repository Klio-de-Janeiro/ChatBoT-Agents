[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProjectRoot,
    [string]$SkillDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills\use-chat-bots')
)
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$source = Join-Path $ProjectRoot '.agents\skills\use-chat-bots'
if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) { throw "Skill source missing: $source" }
$SkillDirectory = [IO.Path]::GetFullPath($SkillDirectory)
if (Test-Path -LiteralPath $SkillDirectory) {
    $marker = Join-Path $SkillDirectory '.mca-skill-install.json'
    if (-not (Test-Path -LiteralPath $marker)) { throw "Existing skill has no MCA ownership marker; left unchanged: $SkillDirectory" }
    $previous = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    if ($previous.owner -ne 'MultiChatAgent/use-chat-bots' -or $previous.project_root -ne $ProjectRoot) {
        throw "Existing skill belongs to another installation; left unchanged: $SkillDirectory"
    }
}
if (-not $PSCmdlet.ShouldProcess($SkillDirectory, 'Install/update owned use-chat-bots skill')) { return }
$null = New-Item -ItemType Directory -Path $SkillDirectory -Force
Get-ChildItem -Force -LiteralPath $source | Copy-Item -Destination $SkillDirectory -Recurse -Force
$utf8 = New-Object System.Text.UTF8Encoding($false)
$metadata = [ordered]@{ owner = 'MultiChatAgent/use-chat-bots'; project_root = $ProjectRoot; python = (Join-Path $ProjectRoot '.venv\Scripts\python.exe') }
[IO.File]::WriteAllText((Join-Path $SkillDirectory '.mca-skill-install.json'), ($metadata | ConvertTo-Json), $utf8)
# This small reference makes absolute paths available even after moving the source checkout.
$location = "# Local installation`n`nProject: ``$ProjectRoot```n`nPython executable: ``$($metadata.python)```n`nUse this absolute interpreter for every mca invocation. If it no longer exists, reinstall from the moved checkout.`n"
$null = New-Item -ItemType Directory -Path (Join-Path $SkillDirectory 'references') -Force
[IO.File]::WriteAllText((Join-Path $SkillDirectory 'references\installation.md'), $location, $utf8)
[PSCustomObject]@{ Installed = $true; SkillDirectory = $SkillDirectory; Python = $metadata.python }
