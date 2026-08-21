import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDisposableGitRepository } from '../test-common/disposable-git-repository';

describe('disposable Git repository fixture', () => {
  it('returns caller-owned cleanup without mutating its options', () => {
    const options = {
      temporaryPrefix: 'hariari-disposable-repository-',
      readmeContents: '# Disposable fixture\n',
      commitMessage: 'create disposable fixture',
      authorName: 'Runtime Test',
      authorEmail: 'runtime@example.test',
    };
    const originalOptions = { ...options };
    const repository = createDisposableGitRepository(options);

    expect(options).toEqual(originalOptions);
    expect(repository.path).toBe(path.join(repository.root, 'repository'));
    expect(fs.existsSync(repository.path)).toBe(true);
    repository.dispose();
    repository.dispose();
    expect(fs.existsSync(repository.root)).toBe(false);
  });
});
