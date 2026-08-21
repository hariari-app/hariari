const expected = process.argv[2];
if (!['linux', 'darwin', 'win32'].includes(expected)) {
  throw new Error('Expected a supported native Runtime platform');
}
if (process.platform !== expected) {
  throw new Error(
    `Runtime SEA packages must be built natively (expected ${expected}, running ${process.platform})`,
  );
}
