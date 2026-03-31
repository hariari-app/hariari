// macOS notarization script — runs as electron-builder afterSign hook.
// Uses @electron/notarize with explicit logging for CI visibility.
// Skips silently when not on macOS or when credentials are missing.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appId = 'com.vibeide.app';
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('  • skipping notarization — APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID not set');
    return;
  }

  console.log(`  • notarizing  appId=${appId} appPath=${appPath}`);

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
    tool: 'notarytool',
  });

  console.log('  • notarization complete');
};
