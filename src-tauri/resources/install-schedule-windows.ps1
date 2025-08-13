#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0, HelpMessage="Hour (0-23)")]
    [ValidateRange(0,23)]
    [int]$Hour,

    [Parameter(Mandatory=$true, Position=1, HelpMessage="Minute (0-59)")]
    [ValidateRange(0,59)]
    [int]$Minute,

    [Parameter(Mandatory=$true, Position=2, HelpMessage="Full path to executable or script (.exe/.ps1/.bat/.cmd)")]
    [ValidateScript({
        if (-not [System.IO.Path]::IsPathRooted($_)) {
            throw "Path must be absolute: $_"
        }
        if (-not (Test-Path $_ -PathType Leaf)) {
            throw "Executable file not found: $_"
        }
        $true
    })]
    [string]$ExecutablePath,

    [Parameter(Position=3, HelpMessage="Arguments to pass to the executable/script")]
    [string]$Arguments = "",

    [Parameter(HelpMessage="Task name (default: GhostCat.Scheduler)")]
    [ValidatePattern('^[a-zA-Z0-9._-]+$')]
    [string]$TaskName = "GhostCat.Scheduler",

    [Parameter(HelpMessage="Working directory (defaults to the executable's folder)")]
    [string]$WorkingDirectory,

    [Parameter(HelpMessage="Run with highest privileges")]
    [switch]$RunElevated,

    [Parameter(HelpMessage="Run while logged off using S4U (no stored password; limited access to network resources)")]
    [switch]$UseS4U,

    [Parameter(HelpMessage="Show usage and exit")]
    [switch]$Help,

    [Parameter(HelpMessage="Run in silent mode (no interactive prompts, minimal output)")]
    [switch]$Silent,

    [Parameter(HelpMessage="Force replace existing task without prompting")]
    [switch]$Force,

    [Parameter(HelpMessage="Output results as JSON")]
    [switch]$Json
)

# Make non-terminating errors throw in try/catch
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Write-Usage {
    $scriptName = if ($MyInvocation.ScriptName) { Split-Path $MyInvocation.ScriptName -Leaf } else { "schedule-task.ps1" }
    Write-Host @"
Usage: .\$scriptName HH MM 'C:\path\to\exe-or-script' [-Arguments '...'] [-TaskName Name] [-WorkingDirectory 'C:\path'] [-RunElevated] [-UseS4U] [-Silent] [-Force] [-Json]

Creates a Windows Scheduled Task to run daily at the specified time.

Parameters:
  HH, MM         Hour (0-23) and Minute (0-59)
  ExecutablePath Full absolute path to .exe, .ps1, .bat, or .cmd
  -Arguments     Arguments to pass
  -TaskName      Task name (default: GhostCat.Scheduler)
  -WorkingDirectory  Defaults to the executable's folder
  -RunElevated   Run with highest privileges
  -UseS4U        Run when logged off (no stored password; limited network access)
  -Silent        No interactive prompts, minimal output
  -Force         Replace existing task without prompting
  -Json          Output results as JSON

Examples:
  .\$scriptName 14 30 'C:\Apps\Monitor\monitor.exe'
  .\$scriptName 02 15 'C:\Tools\backup.ps1' -Arguments '-Full' -TaskName 'NightlyBackup' -UseS4U -Silent
  .\$scriptName 14 30 'C:\App.exe' -Force -Json

"@
}

function Format-Time {
    param([int]$Hour, [int]$Minute)
    return ('{0:D2}:{1:D2}' -f $Hour, $Minute)
}

function Write-Output-Conditionally {
    param([string]$Message, [string]$Color = "White")
    if (-not $Silent -and -not $Json) {
        Write-Host $Message -ForegroundColor $Color
    }
}

function Write-Result {
    param(
        [bool]$Success,
        [string]$Message,
        [hashtable]$Details = @{}
    )

    if ($Json) {
        $result = @{
            success = $Success
            message = $Message
            timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
            details = $Details
        }
        Write-Host ($result | ConvertTo-Json -Depth 10)
    } else {
        if ($Success) {
            Write-Host "✓ $Message" -ForegroundColor Green
        } else {
            Write-Host "✗ $Message" -ForegroundColor Red
        }
        if ($Details.Count -gt 0 -and -not $Silent) {
            $Details.GetEnumerator() | ForEach-Object {
                Write-Host "  $($_.Key): $($_.Value)" -ForegroundColor Cyan
            }
        }
    }
}

# Check for administrator privileges if elevated execution is requested
function Test-IsElevated {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
    if ($Help) {
        Write-Usage
        exit 0
    }

    # Validate elevation requirement
    if ($RunElevated -and -not (Test-IsElevated)) {
        Write-Result -Success $false -Message "RunElevated requires administrator privileges" -Details @{
            "solution" = "Run PowerShell as Administrator or remove -RunElevated flag"
        }
        exit 1
    }

    if (-not $PSBoundParameters.ContainsKey('WorkingDirectory')) {
        $WorkingDirectory = Split-Path -Path $ExecutablePath -Parent
    }

    $timeFormatted = Format-Time $Hour $Minute

    Write-Output-Conditionally "Setting up Windows scheduled task..." "Green"
    if (-not $Silent -and -not $Json) {
        Write-Host "Task Name : $TaskName"
        Write-Host "Schedule  : Daily at $timeFormatted"
        Write-Host "Target    : $ExecutablePath"
        if ($Arguments) { Write-Host "Arguments : $Arguments" }
        Write-Host "Work Dir  : $WorkingDirectory"
        Write-Host "User      : $env:USERNAME"
        if ($RunElevated) { Write-Host "RunLevel  : Highest" }
        if ($UseS4U) { Write-Host "Logon     : S4U (runs while logged off)" }
        Write-Host ""
    }

    # Conflict handling
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        if ($Force -or $Silent) {
            Write-Output-Conditionally "Removing existing task '$TaskName'..." "Yellow"
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        } else {
            Write-Warning "Task '$TaskName' already exists."
            $response = Read-Host "Do you want to replace it? (y/N)"
            if ($response -notmatch '^[Yy]') {
                Write-Result -Success $false -Message "Operation cancelled by user"
                exit 1
            }
            Write-Host "Removing existing task..." -ForegroundColor Yellow
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
    }

    # Choose proper host/arguments based on file type
    $exec = $ExecutablePath
    $args = $Arguments
    switch -Regex ([System.IO.Path]::GetExtension($ExecutablePath).ToLowerInvariant()) {
        '\.ps1$' {
            $exec = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
            $args = "-NoProfile -ExecutionPolicy Bypass -File `"$ExecutablePath`" $Arguments".Trim()
        }
        '\.(bat|cmd)$' {
            $exec = "$env:SystemRoot\System32\cmd.exe"
            $args = "/c `"$ExecutablePath`" $Arguments".Trim()
        }
        default { } # .exe or other true executables
    }

    # Build action, trigger, settings, principal
    Write-Output-Conditionally "Creating task components..." "Cyan"

    $action = New-ScheduledTaskAction -Execute $exec -Argument $args -WorkingDirectory $WorkingDirectory

    $triggerTime = [DateTime]::Today.AddHours($Hour).AddMinutes($Minute)
    $trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime

    $settings = New-ScheduledTaskSettingsSet `
        -WakeToRun:$true `
        -StartWhenAvailable:$true `
        -DontStopOnIdleEnd:$true `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5)

    $runLevel = if ($RunElevated) { 'Highest' } else { 'Limited' }
    $logonType = if ($UseS4U) { 'S4U' } else { 'Interactive' }
    $principal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType $logonType `
        -RunLevel $runLevel

    Write-Output-Conditionally "Registering scheduled task..." "Cyan"

    $task = Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "Daily scheduled task created by GhostCat scheduler"

    # Prepare success details
    $successDetails = @{
        "taskName" = $TaskName
        "schedule" = "Daily at $timeFormatted"
        "executable" = $exec
        "workingDirectory" = $WorkingDirectory
        "runLevel" = $runLevel
        "logonType" = $logonType
    }

    if ($args) {
        $successDetails["arguments"] = $args
    }

    Write-Result -Success $true -Message "Successfully created scheduled task: $TaskName" -Details $successDetails

    if (-not $Silent -and -not $Json) {
        Write-Host ""
        Write-Host "Management commands:" -ForegroundColor White
        Write-Host "View task info      : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
        Write-Host "Test run immediately: Start-ScheduledTask -TaskName '$TaskName'"
        Write-Host "Remove task         : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
        Write-Host ""
        if ($UseS4U) {
            Write-Host "Note: S4U allows execution while logged off but limits network resource access." -ForegroundColor Yellow
        } else {
            Write-Host "Note: Interactive logon requires user to be logged in for task execution." -ForegroundColor Yellow
        }
    }

    exit 0

} catch {
    $errorDetails = @{
        "error" = $_.Exception.Message
        "category" = $_.CategoryInfo.Category.ToString()
        "line" = if ($_.InvocationInfo.ScriptLineNumber) { $_.InvocationInfo.ScriptLineNumber } else { "Unknown" }
    }

    Write-Result -Success $false -Message "Failed to create scheduled task" -Details $errorDetails

    if (-not $Json -and -not $Silent) {
        Write-Host ""
        Write-Host "Common solutions:" -ForegroundColor Yellow
        Write-Host "- Verify the executable path exists and is accessible"
        Write-Host "- Ensure you have sufficient permissions"
        Write-Host "- Check that the task name contains only letters, digits, ., _ or -"
        Write-Host "- For -RunElevated, run PowerShell as Administrator"
        Write-Host "- For -UseS4U, be aware of network access limitations"
    }

    exit 1
}
