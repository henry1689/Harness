@echo off
chcp 65001 >nul
title Harness Service Manager (PM2)

cd /d D:\AI文件\harness

REM v2.7: 固化被管控项目根目录——防止 WENSTAR_CC_ROOT 未设时退化成 harness 自身
set WENSTAR_CC_ROOT=D:\tools\wenstar-cc

echo ==============================================
echo   Harness v3.0 — PM2 进程守护
echo ==============================================
echo.

REM v2.7: 全面监管——5 个 app 逐一检查（wenstaros-watch 暂不启）
set "APPS=harness-mcp harness-sentinel harness-self-sentinel harness-dashboard harness-watchdog"

REM 检查 PM2 daemon 是否存活
pm2 ping >nul 2>&1
if %errorlevel% neq 0 (
    echo [BOOT] PM2 守护未运行，尝试恢复快照...
    pm2 resurrect >nul 2>&1
)

REM 统一收尾：先 resurrect（幂等，只启 dump 里缺的），再逐 app 兜底。
REM 循环放公共路径末尾（不 goto 跳过）——daemon 死亡分支同样执行兜底，
REM 避免陈旧 dump 缺本轮新增 app 时无人拉起。逐 app 启动天然只启 5 个，
REM 永不启动 wenstaros-watch（MID-3-fix）。findstr 只验证「存在」不验证
REM "online"，stopped/errored 状态由 harness-watchdog 二道防线自愈。
pm2 resurrect >nul 2>&1
for %%A in (%APPS%) do (
    pm2 jlist 2>nul | findstr /C:"%%A" >nul
    if errorlevel 1 (
        echo [BOOT] %%A 缺失，启动...
        pm2 start ecosystem.config.cjs --only %%A
    )
)

echo.
pm2 status
echo.
echo   MCP 端口:  http://127.0.0.1:8765
echo   Sentinel:  监控 D:\tools\wenstar-cc\src
echo   日志跟踪:  pm2 logs
echo   状态查看:  pm2 status
echo   全部停止:  pm2 stop all
echo ==============================================
