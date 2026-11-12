#!/usr/bin/env bash
# 打 macOS 安装包：.app -> 可选签名 -> DMG -> 可选公证。
#
# 为什么要自己打 DMG：tauri build 的 DMG 步骤会通过 AppleScript 让 Finder 排版窗口，
# 在无 GUI / 屏幕锁定的机器上会超时失败（-1712）。这里用 hdiutil 直接产出可用的 DMG，
# 只是没有自定义窗口背景。
#
# 用法：
#   ./scripts/package_macos.sh                    # 构建 + 打包（有证书就签）
#   SKIP_BUILD=1 ./scripts/package_macos.sh       # 复用已构建的 .app
#   APPLE_SIGNING_IDENTITY="Developer ID Application: xxx (TEAMID)" ./scripts/package_macos.sh
#   NOTARIZE=1 NOTARY_PROFILE=shiguang-notary ./scripts/package_macos.sh
#
# 公证凭据只从 keychain profile 读，绝不写进仓库：
#   xcrun notarytool store-credentials shiguang-notary --apple-id ... --team-id ... --password ...
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="拾光"
BUNDLE="src-tauri/target/release/bundle"
APP="$BUNDLE/macos/${APP_NAME}.app"
OUT_DIR="${OUT_DIR:-$BUNDLE/dmg}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-shiguang-notary}"
STAMP="$(date +%Y%m%d)"
DMG="$OUT_DIR/${APP_NAME}_${STAMP}_aarch64.dmg"

echo "[1/5] 构建 app bundle"
if [ "${SKIP_BUILD:-0}" = "1" ] && [ -d "$APP" ]; then
  echo "  SKIP_BUILD=1，复用 $APP"
else
  npm run tauri build -- --bundles app
fi

echo "[2/5] 签名"
SIGNED=0
if [ -n "$IDENTITY" ] && security find-identity -v -p codesigning | grep -qF "$IDENTITY"; then
  # 不要用 codesign --deep：Apple 明确不建议，嵌套代码可能被漏签，
  # 公证会以 signature invalid 拒绝且很难定位。显式从内到外签。
  while IFS= read -r -d '' nested; do
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$nested"
  done < <(find "$APP/Contents" -type f -name "*.dylib" -print0 -o -type f -name "*.so" -print0)
  if [ -d "$APP/Contents/Frameworks" ]; then
    while IFS= read -r -d '' fw; do
      codesign --force --options runtime --timestamp --sign "$IDENTITY" "$fw"
    done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0)
  fi
  if [ -d "$APP/Contents/MacOS" ]; then
    while IFS= read -r -d '' exe; do
      codesign --force --options runtime --timestamp --sign "$IDENTITY" "$exe"
    done < <(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -111 -print0)
  fi
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "  已签名（由内到外，未用 --deep）：$IDENTITY"
  SIGNED=1
else
  echo "  跳过：本机没有匹配的签名身份（security find-identity -p codesigning 为空）"
  echo "  产物是未签名 app，别人打开需要右键 -> 打开，或 xattr -dr com.apple.quarantine"
fi

echo "[3/5] 打包 DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -sfn /Applications "$STAGE/Applications"
mkdir -p "$OUT_DIR"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
if [ "$SIGNED" = "1" ]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
fi
echo "  $DMG"

echo "[4/5] 公证"
if [ "${NOTARIZE:-0}" = "1" ]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
else
  echo "  跳过：NOTARIZE=1 时才会提交（需要先用 xcrun notarytool store-credentials 存好 profile）"
fi

echo "[5/5] 验收"
codesign -dv "$DMG" 2>&1 | sed 's/^/  /' || true
if [ "$SIGNED" = "1" ]; then
  spctl -a -vv "$DMG" 2>&1 | sed 's/^/  /' || true
  if [ "${NOTARIZE:-0}" = "1" ]; then
    xcrun stapler validate "$DMG" 2>&1 | sed 's/^/  /' || true
  fi
else
  echo "  未签名产物：spctl 必然拒绝，这是预期结果"
fi
