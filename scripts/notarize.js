// macOS notarization script — runs as electron-builder afterSign hook.
// Calls xcrun notarytool directly with verbose logging and a timeout
// to avoid hanging in CI. Skips when not on macOS or credentials missing.

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('  • skipping notarization — credentials not set');
    return;
  }

  // Zip the app for submission
  const zipPath = path.join(appOutDir, `${appName}.zip`);
  console.log(`  • zipping app for notarization: ${appPath}`);
  execSync(`ditto -c -k --keepParent "${appPath}" "${zipPath}"`, { stdio: 'inherit' });

  // Submit with verbose output and 15-minute timeout
  console.log(`  • submitting to Apple notarization service...`);
  try {
    execSync(
      `xcrun notarytool submit "${zipPath}" ` +
      `--apple-id "${appleId}" ` +
      `--password "${appleIdPassword}" ` +
      `--team-id "${teamId}" ` +
      `--wait --timeout 15m ` +
      `--verbose`,
      { stdio: 'inherit', timeout: 20 * 60 * 1000 }
    );
  } catch (error) {
    console.error('  • notarization failed or timed out');
    console.error(`  • exit code: ${error.status}`);
    if (error.stderr) console.error(error.stderr.toString());

    // Try to get the submission log for debugging
    try {
      console.log('  • fetching notarization log...');
      execSync(
        `xcrun notarytool log ` +
        `--apple-id "${appleId}" ` +
        `--password "${appleIdPassword}" ` +
        `--team-id "${teamId}" ` +
        `$(xcrun notarytool history ` +
        `--apple-id "${appleId}" ` +
        `--password "${appleIdPassword}" ` +
        `--team-id "${teamId}" 2>/dev/null | head -5)`,
        { stdio: 'inherit', timeout: 30000 }
      );
    } catch {
      // Best effort — log retrieval may also fail
    }

    throw new Error('Notarization failed — check logs above');
  }

  // Staple the notarization ticket to the app
  console.log('  • stapling notarization ticket...');
  execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });

  // Clean up the zip
  execSync(`rm -f "${zipPath}"`);

  console.log('  • notarization complete');
};
