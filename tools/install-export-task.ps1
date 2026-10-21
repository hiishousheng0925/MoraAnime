<#
  注册「每天导出番剧库」的 Windows 计划任务（跑 tools/export-catalog.js）。
  上游网站每天 04:30 同步，导出排在之后（缺省 06:00）。

  用法（先看会做什么，再真的注册）：
    powershell -ExecutionPolicy Bypass -File tools\install-export-task.ps1 -WhatIf
    powershell -ExecutionPolicy Bypass -File tools\install-export-task.ps1
    powershell -ExecutionPolicy Bypass -File tools\install-export-task.ps1 -Publish     # 导出后上传 GitHub Releases
    powershell -ExecutionPolicy Bypass -File tools\install-export-task.ps1 -Uninstall

  参数：
    -TaskName   任务名（缺省 MoraAnime-export-catalog）
    -At         每天几点（缺省 06:00）
    -Src        源库路径（缺省不传 = 读 ~/.j-anime.env 的 J_ANIME_DATA 下的 j-anime.db）
    -Out        输出目录（缺省不传 = %LOCALAPPDATA%\MoraAnime-export）
    -Node       node.exe 路径（缺省取 PATH 里的）
    -Publish    加上 --publish（需要在用户环境变量里配好 MORA_GITHUB_TOKEN / MORA_GITHUB_REPO）
  日志写到 <输出目录>\export.log。
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'MoraAnime-export-catalog',
  [string]$At = '06:00',
  [string]$Src = '',
  [string]$Out = '',
  [string]$Node = '',
  [switch]$Publish,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if ($Uninstall) {
  if ($PSCmdlet.ShouldProcess($TaskName, '删除计划任务')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "已删除计划任务 $TaskName"
  }
  return
}

if (-not $Node) { $Node = (Get-Command node -ErrorAction Stop).Source }
if (-not $Out) { $Out = Join-Path $env:LOCALAPPDATA 'MoraAnime-export' }
$script = Join-Path $repo 'tools\export-catalog.js'
$nodeArgs = @("`"$script`"", '--out', "`"$Out`"")
if ($Src) { $nodeArgs += @('--src', "`"$Src`"") }
if ($Publish) { $nodeArgs += '--publish' }
$log = Join-Path $Out 'export.log'
# 经 cmd 跑是为了把输出追加进日志（计划任务本身不记 stdout）
$cmdLine = "/c `"`"$Node`" $($nodeArgs -join ' ') >> `"$log`" 2>&1`""

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# 错过了（关机 / 睡眠）就在下次开机后补跑；最多跑 1 小时
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

Write-Output "任务名   $TaskName"
Write-Output "时间     每天 $At"
Write-Output "命令     cmd.exe $cmdLine"
Write-Output "工作目录 $repo"
if ($PSCmdlet.ShouldProcess($TaskName, '注册计划任务')) {
  New-Item -ItemType Directory -Force $Out | Out-Null
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output "已注册。立刻试跑：Start-ScheduledTask -TaskName $TaskName"
}
