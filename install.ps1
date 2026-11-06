# deepseekbaby 一键安装 / 卸载（Windows PowerShell 5.1+）
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# 参数：
#   -Profile desktop       profile 名称或绝对路径
#   -DshHome <path>        DSH_HOME，默认 %USERPROFILE%\.dsh
#   -Uninstall             移除依赖与链接（保留数据）
#   -NoInstall             只写配置和链接，不跑 pnpm（DSH 启动时会自己装）
#   -SkipVerify            跳过装上后的 import 自检

[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = "",
    [switch]$Uninstall,
    [switch]$NoInstall,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

function Write-Step($text) { Write-Host "[deepseekbaby] $text" }
function Write-Ok($text) { Write-Host "[deepseekbaby] OK  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[deepseekbaby] !   $text" -ForegroundColor Yellow }

# ---------- 定位插件、DSH、profile ----------

$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginPkgPath = Join-Path $pluginDir "package.json"
if (-not (Test-Path -LiteralPath $pluginPkgPath)) {
    throw "找不到 package.json：$pluginPkgPath"
}
$pluginPkg = Get-Content -LiteralPath $pluginPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pluginPkg.name -ne "deepseekbaby") {
    throw "插件目录里的 package.json name 是 '$($pluginPkg.name)'，应为 deepseekbaby"
}
Write-Ok "插件目录：$pluginDir"

if ($DshHome) {
    $dshHomePath = (Resolve-Path -LiteralPath $DshHome).Path
} elseif ($env:DSH_HOME -and $env:DSH_HOME.Trim()) {
    $dshHomePath = $env:DSH_HOME.Trim()
} else {
    $dshHomePath = Join-Path $env:USERPROFILE ".dsh"
}
if (-not (Test-Path -LiteralPath $dshHomePath)) {
    throw "找不到 DSH 目录：$dshHomePath（可以用 -DshHome 指定）"
}

if ([System.IO.Path]::IsPathRooted($Profile) -and (Test-Path -LiteralPath $Profile)) {
    $profileDir = (Resolve-Path -LiteralPath $Profile).Path
} else {
    $profileDir = Join-Path $dshHomePath (Join-Path "profiles" $Profile)
}
$profilePkgPath = Join-Path $profileDir "package.json"
if (-not (Test-Path -LiteralPath $profilePkgPath)) {
    throw "找不到 profile 配置：$profilePkgPath（可用 -Profile 指定）"
}
Write-Ok "profile：$profileDir"

# ---------- JSON 读写 ----------

function Read-JsonFile([string]$path) {
    return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-JsonFile([string]$path, $value) {
    $json = $value | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-Property($node, [string]$name) {
    if ($null -eq $node) { return }
    $property = $node.PSObject.Properties[$name]
    if ($null -ne $property) { $node.PSObject.Properties.Remove($name) }
}

# ---------- 链接 ----------

$modulesDir = Join-Path $profileDir "node_modules"
$linkPath = Join-Path $modulesDir "deepseekbaby"
$pluginLinkSpec = "link:" + ($pluginDir -replace '\\', '/')

function Get-LinkTarget([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $item = Get-Item -LiteralPath $path -Force
    if ($null -eq $item.Target) { return $null }
    return (@($item.Target) -join "")
}

function Ensure-Link() {
    if (-not (Test-Path -LiteralPath $modulesDir)) {
        New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
    }
    $existing = Get-LinkTarget $linkPath
    if ($existing -and ((Resolve-Path -LiteralPath $existing -ErrorAction SilentlyContinue).Path -eq (Resolve-Path -LiteralPath $pluginDir).Path)) {
        Write-Ok "链接已存在"
        return
    }
    if (Test-Path -LiteralPath $linkPath) {
        cmd /c rmdir "$linkPath" | Out-Null
    }
    cmd /c mklink /J "$linkPath" "$pluginDir" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $linkPath)) {
        throw "创建目录链接失败：$linkPath（可改用管理员 PowerShell 重试）"
    }
    Write-Ok "已链接 node_modules\deepseekbaby"
}

function Remove-Link() {
    if (Test-Path -LiteralPath $linkPath) {
        cmd /c rmdir "$linkPath" | Out-Null
        Write-Ok "已移除链接"
    }
}

# ---------- 依赖与 bundle ----------

$profilePkg = Read-JsonFile $profilePkgPath
$backupPath = "$profilePkgPath.bak-deepseekbaby-" + (Get-Date -Format "yyyyMMdd-HHmmss")

if ($Uninstall) {
    Copy-Item -LiteralPath $profilePkgPath -Destination $backupPath -Force
    $hadDependency = $false
    $hadBundle = $false

    if ($profilePkg.dependencies) {
        if ($profilePkg.dependencies.PSObject.Properties["deepseekbaby"]) {
            Remove-Property $profilePkg.dependencies "deepseekbaby"
            $hadDependency = $true
        }
    }
    if ($profilePkg.dsh -and $profilePkg.dsh.profile -and $profilePkg.dsh.profile.bundles) {
        $bundles = @($profilePkg.dsh.profile.bundles)
        if ($bundles -contains "deepseekbaby") {
            $profilePkg.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne "deepseekbaby" })
            $hadBundle = $true
        }
    }
    if ($hadDependency -or $hadBundle) {
        Write-JsonFile $profilePkgPath $profilePkg
        Write-Ok "已从 profile 配置移除 deepseekbaby（备份：$backupPath）"
    } else {
        Write-Ok "profile 配置里没有 deepseekbaby，无需修改"
    }
    Remove-Link
    Write-Host ""
    Write-Step "卸载完成；数据仍保留在 $dshHomePath\deepseekbaby。重启 DSH 生效。"
    exit 0
}

Copy-Item -LiteralPath $profilePkgPath -Destination $backupPath -Force

if (-not $profilePkg.dependencies) {
    $profilePkg | Add-Member -NotePropertyName "dependencies" -NotePropertyValue ([pscustomobject]@{}) -Force
}
$profilePkg.dependencies | Add-Member -NotePropertyName "deepseekbaby" -NotePropertyValue $pluginLinkSpec -Force

if (-not $profilePkg.dsh) {
    $profilePkg | Add-Member -NotePropertyName "dsh" -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $profilePkg.dsh.profile) {
    $profilePkg.dsh | Add-Member -NotePropertyName "profile" -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $profilePkg.dsh.profile.bundles) {
    $profilePkg.dsh.profile | Add-Member -NotePropertyName "bundles" -NotePropertyValue @() -Force
}
$bundles = @($profilePkg.dsh.profile.bundles)
if ($bundles -notcontains "deepseekbaby") {
    $profilePkg.dsh.profile.bundles = @($bundles + "deepseekbaby")
}

Write-JsonFile $profilePkgPath $profilePkg
Write-Ok "已写入依赖与 bundle（备份：$backupPath）"

Ensure-Link

# ---------- pnpm / 自检 ----------

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Find-Pnpm([string]$nodePath) {
    if ($env:DSH_PNPM -and (Test-Path -LiteralPath $env:DSH_PNPM)) {
        return $env:DSH_PNPM
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    try {
        $process = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($process -and $process.Path) {
            $appDir = Split-Path -Parent $process.Path
            $candidates.Add((Join-Path $appDir "resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs"))
        }
    } catch {
        # 进程可能拿不到路径，继续找。
    }
    if ($nodePath) {
        $nodeDir = Split-Path -Parent $nodePath
        $candidates.Add((Join-Path $nodeDir "node_modules\pnpm\bin\pnpm.cjs"))
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $command = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

$nodePath = Find-Node
if (-not $nodePath) {
    Write-Warn "PATH 里没有 node，跳过依赖安装与自检；DSH 启动时会自己安装依赖。"
} else {
    # engines.node is advisory: npm would refuse, a hand-copied directory would not.
    # The host code gates again at runtime (lib/compat.js MIN_NODE_MAJOR).
    $nodeMajor = 0
    try { $nodeMajor = [int](& $nodePath -p "process.versions.node.split('.')[0]") } catch { $nodeMajor = 0 }
    if ($nodeMajor -gt 0 -and $nodeMajor -lt 20) {
        Write-Warn "node $(& $nodePath --version) 太旧：本插件需要 Node 20 或更新，请先升级（详见 README 的版本边界）。"
    }

    if (-not $NoInstall) {
        $pnpmPath = Find-Pnpm $nodePath
        if ($pnpmPath) {
            Write-Step "安装依赖（$pnpmPath）..."
            Push-Location $profileDir
            try {
                & $nodePath $pnpmPath install --dir $profileDir --prefer-offline --reporter=append-only
                if ($LASTEXITCODE -ne 0) {
                    Write-Warn "pnpm install 退出码 $LASTEXITCODE；DSH 启动时还会再装一次，通常不影响。"
                } else {
                    Write-Ok "依赖已同步"
                }
            } finally {
                Pop-Location
            }
        } else {
            Write-Warn "没找到 pnpm（可设 DSH_PNPM 指向 pnpm.cjs）；DSH 启动时会自动安装。"
        }
    }

    if (-not $SkipVerify) {
        Push-Location $profileDir
        try {
            $resolved = & $nodePath -e "try { console.log(require.resolve('deepseekbaby')) } catch (error) { process.exit(1) }" 2>$null
            if ($LASTEXITCODE -eq 0 -and $resolved) {
                Write-Ok "包解析自检通过：$resolved"
            } else {
                Write-Warn "包解析自检失败；重启 DSH 后如果插件不出现，检查 profile 的 node_modules\deepseekbaby。"
            }
        } finally {
            Pop-Location
        }
    }
}

Write-Host ""
Write-Step "安装完成。下一步："
Write-Host "  1. 重启 DSH（完全退出再打开，插件宿主只在启动时加载）。"
Write-Host "  2. 如果「设置 → 插件」里 deepseekbaby 没自动打开，手动把开关打开。"
Write-Host "  3. 入口在界面右下角的 deepseekbaby 圆按钮。"
Write-Host ""
Write-Host "卸载：powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall"
Write-Host "数据目录：$dshHomePath\deepseekbaby（卸载不会删除）"
