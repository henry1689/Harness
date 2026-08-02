@echo off
chcp 65001 >nul
title Harness Service Manager (PM2)

cd /d D:\AI文件\harness

echo ==============================================
echo   Harness v3.0 — PM2 进程守护
echo ==============================================
echo.

REM 检查 PM2 daemon 是否存活
pm2 ping >nul 2>&1
if %errorlevel% neq 0 (
    echo [BOOT] PM2 守护未运行，尝试恢复快照...
    pm2 resurrect >nul 2>&1
    if %errorlevel% neq 0 (
        echo [BOOT] 快照不可用，从 ecosystem 启动全部服务...
        pm2 start ecosystem.config.cjs
    )
    goto :show
)

REM PM2 存活 → 检查具体服务
pm2 jlist 2>nul | findstr /C:"harness-mcp" >nul
if %errorlevel% neq 0 (
    echo [BOOT] harness-mcp 缺失，启动...
    pm2 start ecosystem.config.cjs --only harness-mcp
)

pm2 jlist 2>nul | findstr /C:"harness-sentinel" >nul
if %errorlevel% neq 0 (
    echo [BOOT] harness-sentinel 缺失，启动...
    pm2 start ecosystem.config.cjs --only harness-sentinel
)

:show
echo.
pm2 status
echo.
echo   MCP 端口:  http://127.0.0.1:8765
echo   Sentinel:  监控 D:\tools\wenstar-cc\src
echo   日志跟踪:  pm2 logs
echo   状态查看:  pm2 status
echo   全部停止:  pm2 stop all
echo ==============================================
