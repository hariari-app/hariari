/**
 * Describes the node-pty payload that a standalone Runtime must carry.
 * The plan is parameterized so hosted Darwin coverage has a Linux-runnable preflight.
 */
export function nodePtyNativeAssetPlan({ platform, arch, hasPrebuild }) {
  const directory = hasPrebuild ? `prebuilds/${platform}-${arch}` : 'build/Release';
  const required = ['pty.node'];
  const executable = platform === 'darwin' ? ['spawn-helper'] : [];
  required.push(...executable);
  return { directory, required, executable };
}

export function selectNodePtyNativeAssets(plan, available) {
  assertNodePtyAssetPlan(plan, available);
  return available.filter(isLoadableNodePtyAsset);
}

export function nodePtyPrebuildAssetSelector(plan, rootAvailable) {
  assertNodePtyAssetPlan(plan, rootAvailable);
  return isLoadableNodePtyAsset;
}

export function nodePtyAssetMode(plan, name, sourceMode) {
  return plan.executable.includes(name) ? 0o755 : sourceMode;
}

export function assertNodePtyAssetPlan(plan, available) {
  for (const required of plan.required) {
    if (!available.includes(required)) {
      const companion = required === 'spawn-helper' ? 'required companion asset' : 'required asset';
      throw new Error(`node-pty ${companion} is missing: ${required}`);
    }
  }
}

export function isLoadableNodePtyAsset(name) {
  return /\.(node|dll|exe)$/.test(name) || name === 'spawn-helper';
}
