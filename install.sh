#!/usr/bin/env bash
# deepseekbaby 一键安装（macOS / Linux）
#   ./install.sh            # 默认 profile: desktop
#   ./install.sh work       # 指定 profile 名
#   ./install.sh -u         # 卸载（保留数据）
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if [[ "${1:-}" == "-u" || "${1:-}" == "--uninstall" ]]; then
  MODE="uninstall"
  PROFILE="${2:-desktop}"
else
  MODE="install"
  PROFILE="${1:-desktop}"
fi

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"

if [[ ! -f "$PKG" ]]; then
  echo "找不到 profile 配置：$PKG" >&2
  exit 1
fi

if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
  echo "插件目录缺 package.json：$PLUGIN_DIR" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "需要 node 来修改 profile 配置（DSH 自带的 Node 也可以，把它加进 PATH）" >&2
  exit 1
fi

cp "$PKG" "$PKG.bak-deepseekbaby-$(date +%Y%m%d-%H%M%S)"

if [[ "$MODE" == "uninstall" ]]; then
  node - "$PKG" <<'JS'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (pkg.dependencies) delete pkg.dependencies.deepseekbaby;
if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== "deepseekbaby");
}
fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n");
JS
  rm -f "$PROFILE_DIR/node_modules/deepseekbaby"
  echo "[deepseekbaby] 已卸载（数据保留在 $DSH_HOME/deepseekbaby）"
  exit 0
fi

node - "$PKG" "$PLUGIN_DIR" <<'JS'
const fs = require("fs");
const [pkgPath, pluginDir] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies.deepseekbaby = "link:" + pluginDir;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes("deepseekbaby")) bundles.push("deepseekbaby");
pkg.dsh.profile.bundles = bundles;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
JS

mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/deepseekbaby"

echo "[deepseekbaby] 已写入依赖并建立链接"
echo "[deepseekbaby] 重启 DSH；若设置 → 插件里没自动打开，手动打开 deepseekbaby 开关。"
