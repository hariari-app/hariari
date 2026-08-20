const notarize = require('./notarize.js').default;
const { findRuntimeManifests, refreshRuntimeManifest } = require('./runtime-after-pack.js');

exports.default = async function runtimeAfterSign(context) {
  if (context.electronPlatformName === 'win32') {
    for (const manifestPath of findRuntimeManifests(context)) {
      refreshRuntimeManifest(manifestPath);
    }
  }
  await notarize(context);
};
