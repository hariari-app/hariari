import fs from 'node:fs';
import path from 'node:path';

const [x64Path, arm64Path, outputPath] = process.argv
  .slice(2)
  .map((value) => (value ? path.resolve(value) : value));
if (!x64Path || !arm64Path || !outputPath) {
  throw new Error('Expected x64, arm64, and output macOS update manifest paths');
}

const x64 = splitFilesSection(fs.readFileSync(x64Path, 'utf8'));
const arm64 = splitFilesSection(fs.readFileSync(arm64Path, 'utf8'));
if (x64.prefix.join('\n') !== arm64.prefix.join('\n')) {
  throw new Error('macOS update manifests disagree before their files sections');
}
const mergedFiles = [...x64.files, ...arm64.files];
if (mergedFiles.length < 2) throw new Error('macOS update manifests contain too few files');
fs.writeFileSync(
  outputPath,
  `${[...x64.prefix, 'files:', ...mergedFiles, ...x64.suffix].join('\n')}\n`,
);

function splitFilesSection(source) {
  const lines = source.trimEnd().split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'files:');
  if (start < 0) throw new Error('macOS update manifest has no files section');
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end])) end += 1;
  return {
    prefix: lines.slice(0, start),
    files: lines.slice(start + 1, end),
    suffix: lines.slice(end),
  };
}
