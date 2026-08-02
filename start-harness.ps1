$harnessDir = "D:\AI文件\harness"
$tsxCli = "D:\AI文件\harness\node_modules\tsx\dist\cli.cjs"
$mcpServer = "D:\AI文件\harness\mcp\server.ts"
$sentinel = "D:\AI文件\harness\sentinel\sentinel-service.cjs"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Harness v2.5 - All Services" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# Kill stale processes
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# [1/2] MCP Server
Write-Host "[1/2] MCP Server (port 8765)..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList $tsxCli, $mcpServer -WorkingDirectory $harnessDir -WindowStyle Minimized
Start-Sleep 5

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/sentinel/health" -TimeoutSec 3
    Write-Host "      MCP Server: ONLINE ($($health.version))" -ForegroundColor Green
} catch {
    Write-Host "      MCP Server: still starting (check in 5s)" -ForegroundColor Yellow
}

# [2/2] Sentinel
Write-Host "[2/2] Sentinel..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList $sentinel, "--project", "D:\tools\wenstar-cc" -WorkingDirectory $harnessDir -WindowStyle Minimized
Start-Sleep 4

# Status
$nodes = @(Get-Process -Name "node" -ErrorAction SilentlyContinue)
Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  MCP Server : http://127.0.0.1:8765" -ForegroundColor Gray
Write-Host "  Sentinel   : D:\tools\wenstar-cc\src\" -ForegroundColor Gray
Write-Host "  Hook       : active (every Edit/Write)" -ForegroundColor Gray
Write-Host "  Processes  : $($nodes.Count) node.exe" -ForegroundColor Gray
Write-Host "==============================================" -ForegroundColor Cyan
Read-Host "Press Enter to exit"
