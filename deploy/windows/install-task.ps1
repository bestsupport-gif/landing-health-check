# 로그인할 때 서버가 자동으로 켜지도록 작업 스케줄러에 등록한다 (관리자 권한 불필요).
# 사용법: powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1
$name = 'LandingHealthCheck'
$script = Join-Path $PSScriptRoot 'start-server.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description '랜딩 헬스체크 서버 (Meta/Google/Naver 소재 랜딩 점검)' -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "등록 완료: 작업 스케줄러 '$name' (로그인 시 자동 실행). 로그: logs\server.log"
