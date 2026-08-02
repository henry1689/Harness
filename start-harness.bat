@echo off
cd /d "D:\AI文件\harness"
echo ==============================================
echo   Harness v2.5 - All Services Launcher
echo ==============================================
echo.

echo [1/2] Starting MCP Server on port 8765...
start "MCP" /min node node_modules\tsx\dist\cli.cjs mcp\server.ts
echo   Done. Waiting 6 seconds...

timeout /t 6 /nobreak >nul

echo [2/2] Starting Sentinel watcher...
start "Sentinel" /min node sentinel\sentinel-service.cjs --project "D:\tools\wenstar-cc"
echo   Done.

timeout /t 3 /nobreak >nul
echo.
echo ==============================================
echo   MCP  : http://127.0.0.1:8765
echo   Sentinel : watching D:\tools\wenstar-cc\src
echo   Hook  : active on every Edit/Write
echo ==============================================
echo.
pause
