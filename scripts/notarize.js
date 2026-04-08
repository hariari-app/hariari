// macOS notarization script — runs as electron-builder afterSign hook.
// Submits to Apple notarization but does NOT fail the build on timeout.
// Apple's service can take hours for new app IDs. The signed .dmg is
// still produced; notarization ticket can be stapled later.

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

  // Submit without --wait so we don't block. Just fire and continue.
  console.log('  • submitting to Apple notarization service (non-blocking)...');
  try {
    const output = execSync(
      `xcrun notarytool submit "${zipPath}" ` +
      `--apple-id "${appleId}" ` +
      `--password "${appleIdPassword}" ` +
      `--team-id "${teamId}"`,
      { encoding: 'utf8', timeout: 120000 }
    );
    console.log(output);

    // Extract submission ID for reference
    const idMatch = output.match(/id:\s*([0-9a-f-]+)/);
    if (idMatch) {
      console.log(`  • notarization submitted — ID: ${idMatch[1]}`);
      console.log('  • Apple will process asynchronously. Check status with:');
      console.log(`    xcrun notarytool info ${idMatch[1]} --apple-id "..." --team-id "..." --password "..."`);
    }

    // Try a quick poll (2 minutes) — Apple sometimes finishes fast on retries
    console.log('  • waiting up to 2 minutes for Apple to finish...');
    try {
      execSync(
        `xcrun notarytool wait "${idMatch ? idMatch[1] : ''}" ` +
        `--apple-id "${appleId}" ` +
        `--password "${appleIdPassword}" ` +
        `--team-id "${teamId}" ` +
        `--timeout 2m`,
        { stdio: 'inherit', timeout: 150000 }
      );

      // If we get here, notarization completed — staple the ticket
      console.log('  • stapling notarization ticket...');
      execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
      console.log('  • notarization complete and stapled');
    } catch {
      console.log('  • notarization still in progress at Apple — build will continue');
      console.log('  • the signed .dmg will be produced without the notarization ticket');
      console.log('  • staple manually later: xcrun stapler staple Hariari.app');
    }
  } catch (error) {
    console.error('  • notarization submission failed:', error.message);
    console.log('  • continuing with signed-only build');
  }

  // Clean up zip
  try { execSync(`rm -f "${zipPath}"`); } catch { /* ignore */ }
};
