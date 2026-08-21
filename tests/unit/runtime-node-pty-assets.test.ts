import { describe, expect, it } from 'vitest';
import {
  assertNodePtyAssetPlan,
  nodePtyAssetMode,
  nodePtyNativeAssetPlan,
  nodePtyPrebuildAssetSelector,
  selectNodePtyNativeAssets,
} from '../../scripts/runtime-node-pty-assets.mjs';

describe('node-pty Runtime asset plan', () => {
  it('requires executable Darwin spawn-helper beside pty.node for darwin-arm64', () => {
    const plan = nodePtyNativeAssetPlan({
      platform: 'darwin',
      arch: 'arm64',
      hasPrebuild: true,
    });

    expect(plan.directory).toBe('prebuilds/darwin-arm64');
    expect(plan.required).toEqual(['pty.node', 'spawn-helper']);
    expect(plan.executable).toEqual(['spawn-helper']);
    expect(
      selectNodePtyNativeAssets(plan, ['pty.node', 'spawn-helper', 'ignored.pdb']),
    ).toEqual(['pty.node', 'spawn-helper']);
  });

  it('fails preflight clearly when the Darwin companion helper is absent', () => {
    const plan = nodePtyNativeAssetPlan({
      platform: 'darwin',
      arch: 'arm64',
      hasPrebuild: true,
    });

    expect(() => assertNodePtyAssetPlan(plan, ['pty.node'])).toThrow(
      'node-pty required companion asset is missing: spawn-helper',
    );
  });

  it('makes the Darwin helper executable even when the installed prebuild mode is not', () => {
    const plan = nodePtyNativeAssetPlan({
      platform: 'darwin',
      arch: 'arm64',
      hasPrebuild: true,
    });

    expect(nodePtyAssetMode(plan, 'spawn-helper', 0o664)).toBe(0o755);
    expect(nodePtyAssetMode(plan, 'pty.node', 0o644)).toBe(0o644);
  });

  it('keeps the Windows prebuild plan limited to loadable binaries and helpers', () => {
    const plan = nodePtyNativeAssetPlan({
      platform: 'win32',
      arch: 'x64',
      hasPrebuild: true,
    });

    expect(
      selectNodePtyNativeAssets(plan, ['pty.node', 'winpty.dll', 'winpty-agent.exe', 'pty.pdb']),
    ).toEqual(['pty.node', 'winpty.dll', 'winpty-agent.exe']);
  });

  it('validates the Windows prebuild root once before selecting nested conpty executables', () => {
    const plan = nodePtyNativeAssetPlan({
      platform: 'win32',
      arch: 'x64',
      hasPrebuild: true,
    });

    const include = nodePtyPrebuildAssetSelector(plan, ['pty.node', 'winpty.dll']);
    expect(['OpenConsole.exe', 'conpty.pdb'].filter(include)).toEqual(['OpenConsole.exe']);
  });
});
