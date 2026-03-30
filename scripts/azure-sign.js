const { execSync } = require("child_process");

exports.default = async function (configuration) {
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_ENDPOINT) {
    console.log("Skipping signing: Azure credentials not configured");
    return;
  }

  const filePath = configuration.path;
  console.log(`Signing: ${filePath}`);

  execSync(
    `AzureSignTool sign ` +
      `-kvu "${process.env.AZURE_ENDPOINT}" ` +
      `-kvi "${process.env.AZURE_CLIENT_ID}" ` +
      `-kvs "${process.env.AZURE_CLIENT_SECRET}" ` +
      `-kvt "${process.env.AZURE_TENANT_ID}" ` +
      `-kvc "${process.env.AZURE_CERT_PROFILE_NAME}" ` +
      `-tr http://timestamp.acs.microsoft.com ` +
      `-td sha256 ` +
      `"${filePath}"`,
    { stdio: "inherit" }
  );
};
