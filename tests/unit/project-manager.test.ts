import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectManager } from '../../src/main/project/project-manager';

function createTestProjectManager(configDir: string): ProjectManager {
  const manager = new ProjectManager();
  Object.defineProperty(manager, 'configDir', { value: configDir, writable: false });
  Object.defineProperty(manager, 'projectsPath', {
    value: path.join(configDir, 'projects.json'),
    writable: false,
  });
  Object.defineProperty(manager, 'workspacesDir', {
    value: path.join(configDir, 'workspaces'),
    writable: false,
  });
  // Clear the projects loaded from real ~/.hariari
  Object.defineProperty(manager, 'projects', { value: [], writable: true });
  return manager;
}

describe('ProjectManager', () => {
  let tempDir: string;
  let projectDir: string;
  let projectDir2: string;
  let manager: ProjectManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-test-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });

    projectDir = path.join(tempDir, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    projectDir2 = path.join(tempDir, 'my-project-2');
    fs.mkdirSync(projectDir2, { recursive: true });

    manager = createTestProjectManager(configDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createProject', () => {
    it('creates a project with correct defaults', () => {
      const project = manager.createProject({ path: projectDir });
      expect(project.name).toBe('my-project');
      expect(project.path).toBe(projectDir);
      expect(project.pinned).toBe(false);
      expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(project.createdAt).toBeGreaterThan(0);
      expect(project.lastActiveAt).toBe(project.createdAt);
    });

    it('uses custom name when provided', () => {
      const project = manager.createProject({ path: projectDir, name: 'Custom Name' });
      expect(project.name).toBe('Custom Name');
    });

    it('rejects nonexistent directory', () => {
      expect(() =>
        manager.createProject({ path: path.join(tempDir, 'nonexistent') }),
      ).toThrow('Directory does not exist');
    });

    it('rejects duplicate path', () => {
      manager.createProject({ path: projectDir });
      expect(() =>
        manager.createProject({ path: projectDir }),
      ).toThrow('Project already exists');
    });

    it('persists to disk', () => {
      manager.createProject({ path: projectDir });
      const configDir = path.join(tempDir, 'config');
      const raw = fs.readFileSync(path.join(configDir, 'projects.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].path).toBe(projectDir);
    });
  });

  describe('listProjects', () => {
    it('returns empty array initially', () => {
      expect(manager.listProjects()).toEqual([]);
    });

    it('returns projects sorted by pinned first, then last active', () => {
      const p1 = manager.createProject({ path: projectDir });
      const p2 = manager.createProject({ path: projectDir2 });
      manager.updateProject({ id: p1.id, pinned: true });

      const list = manager.listProjects();
      expect(list[0].id).toBe(p1.id);
      expect(list[0].pinned).toBe(true);
    });

    it('sorts unpinned by lastActiveAt descending', () => {
      const p1 = manager.createProject({ path: projectDir });
      const p2 = manager.createProject({ path: projectDir2 });

      // Touch p1 to make it more recent
      manager.touchProject(p1.id);

      const list = manager.listProjects();
      expect(list[0].id).toBe(p1.id);
    });
  });

  describe('removeProject', () => {
    it('removes a project', () => {
      const project = manager.createProject({ path: projectDir });
      manager.removeProject(project.id);
      expect(manager.listProjects()).toHaveLength(0);
    });

    it('throws for unknown project', () => {
      expect(() =>
        manager.removeProject('00000000-0000-4000-8000-000000000000'),
      ).toThrow('Project not found');
    });

    it('cleans up workspace state file', () => {
      const configDir = path.join(tempDir, 'config');
      const wsDir = path.join(configDir, 'workspaces');
      fs.mkdirSync(wsDir, { recursive: true });

      const project = manager.createProject({ path: projectDir });
      const wsPath = path.join(wsDir, `${project.id}.json`);
      fs.writeFileSync(wsPath, '{}', 'utf-8');

      manager.removeProject(project.id);
      expect(fs.existsSync(wsPath)).toBe(false);
    });
  });

  describe('updateProject', () => {
    it('updates name', () => {
      const project = manager.createProject({ path: projectDir });
      const updated = manager.updateProject({ id: project.id, name: 'New Name' });
      expect(updated.name).toBe('New Name');
      expect(updated.path).toBe(projectDir);
    });

    it('updates pinned status', () => {
      const project = manager.createProject({ path: projectDir });
      const updated = manager.updateProject({ id: project.id, pinned: true });
      expect(updated.pinned).toBe(true);
    });

    it('throws for unknown project', () => {
      expect(() =>
        manager.updateProject({ id: '00000000-0000-4000-8000-000000000000', name: 'x' }),
      ).toThrow('Project not found');
    });
  });

  describe('touchProject', () => {
    it('updates lastActiveAt', () => {
      const project = manager.createProject({ path: projectDir });
      const originalTime = project.lastActiveAt;

      // Touch after a tick
      manager.touchProject(project.id);
      const updated = manager.getProject(project.id);
      expect(updated!.lastActiveAt).toBeGreaterThanOrEqual(originalTime);
    });

    it('does nothing for unknown project', () => {
      // Should not throw
      manager.touchProject('00000000-0000-4000-8000-000000000000');
    });
  });

  describe('validateDirectories', () => {
    it('separates valid and missing directories', () => {
      manager.createProject({ path: projectDir });
      manager.createProject({ path: projectDir2 });

      // Remove one directory
      fs.rmSync(projectDir2, { recursive: true });

      const { valid, missing } = manager.validateDirectories();
      expect(valid).toHaveLength(1);
      expect(valid[0].path).toBe(projectDir);
      expect(missing).toHaveLength(1);
      expect(missing[0].path).toBe(projectDir2);
    });

    it('returns all valid when directories exist', () => {
      manager.createProject({ path: projectDir });
      const { valid, missing } = manager.validateDirectories();
      expect(valid).toHaveLength(1);
      expect(missing).toHaveLength(0);
    });
  });

  describe('getProject', () => {
    it('returns project by id', () => {
      const project = manager.createProject({ path: projectDir });
      expect(manager.getProject(project.id)).toEqual(project);
    });

    it('returns undefined for unknown id', () => {
      expect(manager.getProject('00000000-0000-4000-8000-000000000000')).toBeUndefined();
    });
  });

  describe('max projects limit', () => {
    it('rejects creation beyond limit', () => {
      // Create 50 projects
      for (let i = 0; i < 50; i++) {
        const dir = path.join(tempDir, `proj-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        manager.createProject({ path: dir });
      }

      const extraDir = path.join(tempDir, 'proj-extra');
      fs.mkdirSync(extraDir, { recursive: true });
      expect(() => manager.createProject({ path: extraDir })).toThrow('Maximum number of projects');
    });
  });
});
