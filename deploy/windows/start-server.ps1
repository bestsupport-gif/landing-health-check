# 회사 PC(Windows)에서 서버를 띄우는 스크립트. 작업 스케줄러가 로그인할 때 숨김 창으로 실행한다.
#  1) GitHub main 의 최신 코드를 받고 (package-lock 이 바뀌면 npm ci)
#  2) .env 파일의 환경변수를 읽어
#  3) node src/server.js 를 실행, 로그는 logs\server.log
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
$log = Join-Path $root 'logs\server.log'

function Write-Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 $log }

# 최신 코드 받기 (실패해도 기존 코드로 실행)
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = 'C:\Program Files\Git\cmd\git.exe' }
if (Test-Path $git) {
  $before = (& $git rev-parse HEAD:package-lock.json 2>$null)
  & $git pull --ff-only -q origin main 2>&1 | ForEach-Object { Write-Log "git: $_" }
  $after = (& $git rev-parse HEAD:package-lock.json 2>$null)
  if ($before -ne $after -or -not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Log 'npm ci'
    & npm.cmd ci --omit=dev 2>&1 | ForEach-Object { Write-Log "npm: $_" }
    & npx.cmd playwright install chromium 2>&1 | ForEach-Object { Write-Log "playwright: $_" }
  }
}

# .env (KEY=VALUE) → 환경변수
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  Get-Content $envFile -Encoding utf8 | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
  }
}
if (-not $env:DATA_DIR) { $env:DATA_DIR = Join-Path $root 'data' }
if (-not $env:BROWSER_CONCURRENCY) { $env:BROWSER_CONCURRENCY = '2' }

Write-Log "server start (port $(if ($env:PORT) { $env:PORT } else { 3000 }))"
& node src/server.js *>> $log
Write-Log "server exited ($LASTEXITCODE)"
exit 1   # 작업 스케줄러가 재시작하도록 실패로 끝낸다
