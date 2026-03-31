const { execSync } = require("child_process");

exports.default = async function (configuration) {
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_ENDPOINT) {
    console.log("Skipping signing: Azure credentials not configured");
    return;
  }

  const filePath = configuration.path;
  console.log(`Signing: ${filePath}`);

  try {
    execSync(
      `AzureSignTool sign ` +
        `-kvu "${process.env.AZURE_ENDPOINT.trim()}" ` +
        `-kva "${process.env.AZURE_CODE_SIGNING_ACCOUNT.trim()}" ` +
        `-kvc "${process.env.AZURE_CERT_PROFILE_NAME.trim()}" ` +
        `-kvi "${process.env.AZURE_CLIENT_ID.trim()}" ` +
        `-kvs "${process.env.AZURE_CLIENT_SECRET.trim()}" ` +
        `-kvt "${process.env.AZURE_TENANT_ID.trim()}" ` +
        `-tr http://timestamp.acs.microsoft.com ` +
        `-td sha256 ` +
        `"${filePath}"`,
      { stdio: "inherit" }
    );
    console.log(`Signed: ${filePath}`);
  } catch (error) {
    console.warn(`WARNING: Signing failed for ${filePath}. Producing unsigned build.`);
    console.warn(`Error: ${error.message}`);
  }
};
