// Bundled skills manifest — catalog of available skills from AISkills repo

import type { SkillManifest } from '../../shared/skills-types';

// This manifest is bundled with the app. It describes what's available
// without requiring a network request. Updated with each Hariari release.
const BUNDLED_MANIFEST: SkillManifest = {
  version: '1.0.0',
  skills: [
    // Language rules
    { id: 'typescript-rules', name: 'TypeScript Rules', description: 'TypeScript/JavaScript coding standards, patterns, and best practices', category: 'language', languages: ['typescript', 'javascript'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/typescript' },
    { id: 'python-rules', name: 'Python Rules', description: 'PEP 8, type hints, Pythonic patterns, and testing standards', category: 'language', languages: ['python'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/python' },
    { id: 'golang-rules', name: 'Go Rules', description: 'Idiomatic Go patterns, error handling, concurrency', category: 'language', languages: ['go'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/golang' },
    { id: 'rust-rules', name: 'Rust Rules', description: 'Ownership, lifetimes, error handling, idiomatic Rust', category: 'language', languages: ['rust'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/rust' },
    { id: 'kotlin-rules', name: 'Kotlin Rules', description: 'Kotlin idioms, coroutines, null safety, DSL builders', category: 'language', languages: ['kotlin'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/kotlin' },
    { id: 'java-rules', name: 'Java Rules', description: 'Spring Boot, JPA, clean architecture, testing patterns', category: 'language', languages: ['java'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/java' },
    { id: 'swift-rules', name: 'Swift Rules', description: 'Swift idioms, SwiftUI, concurrency patterns', category: 'language', languages: ['swift'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/swift' },
    { id: 'cpp-rules', name: 'C++ Rules', description: 'Modern C++ idioms, memory safety, core guidelines', category: 'language', languages: ['cpp'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/cpp' },
    { id: 'php-rules', name: 'PHP Rules', description: 'Laravel patterns, PSR standards, modern PHP', category: 'language', languages: ['php'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/php' },
    { id: 'perl-rules', name: 'Perl Rules', description: 'Modern Perl 5.36+, testing, best practices', category: 'language', languages: ['perl'], targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'rules/perl' },

    // Code quality
    { id: 'coding-standards', name: 'Coding Standards', description: 'Universal coding standards and best practices', category: 'quality', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/coding-standards' },
    { id: 'api-design', name: 'API Design', description: 'REST API patterns, status codes, pagination, error responses', category: 'patterns', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/api-design' },

    // Testing
    { id: 'tdd-workflow', name: 'TDD Workflow', description: 'Test-driven development with 80%+ coverage', category: 'testing', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/tdd-workflow' },
    { id: 'e2e-testing', name: 'E2E Testing', description: 'Playwright patterns, Page Object Model, CI integration', category: 'testing', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/e2e-testing' },

    // Security
    { id: 'ai-regression-testing', name: 'AI Regression Testing', description: 'Catch AI blind spots, sandbox API testing, bug-check workflows', category: 'security', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/ai-regression-testing' },

    // Patterns
    { id: 'backend-patterns', name: 'Backend Patterns', description: 'API design, database optimization, server-side best practices', category: 'patterns', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/backend-patterns' },
    { id: 'frontend-patterns', name: 'Frontend Patterns', description: 'React, Next.js, state management, performance', category: 'patterns', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/frontend-patterns' },
    { id: 'database-migrations', name: 'Database Migrations', description: 'Schema changes, rollbacks, zero-downtime deployments', category: 'patterns', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/database-migrations' },

    // Workflow
    { id: 'continuous-learning', name: 'Continuous Learning', description: 'Auto-extract reusable patterns from sessions', category: 'workflow', targetAgents: ['claude', 'codex', 'gemini', 'pi', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen'], archivePath: 'skills/continuous-learning' },

    // Agent definitions
    { id: 'agent-planner', name: 'Planner Agent', description: 'Implementation planning for complex features', category: 'agent', targetAgents: ['claude', 'codex', 'gemini'], archivePath: 'agents/planner.md' },
    { id: 'agent-code-reviewer', name: 'Code Reviewer Agent', description: 'Automated code review for quality and security', category: 'agent', targetAgents: ['claude', 'codex', 'gemini'], archivePath: 'agents/code-reviewer.md' },
    { id: 'agent-security-reviewer', name: 'Security Reviewer Agent', description: 'Security vulnerability detection and remediation', category: 'agent', targetAgents: ['claude', 'codex', 'gemini'], archivePath: 'agents/security-reviewer.md' },
    { id: 'agent-tdd-guide', name: 'TDD Guide Agent', description: 'Test-driven development enforcement', category: 'agent', targetAgents: ['claude', 'codex', 'gemini'], archivePath: 'agents/tdd-guide.md' },
    { id: 'agent-architect', name: 'Architect Agent', description: 'System design and architectural decisions', category: 'agent', targetAgents: ['claude', 'codex', 'gemini'], archivePath: 'agents/architect.md' },
  ],
  presets: [
    {
      id: 'recommended',
      name: 'Recommended',
      description: 'Essential skills for effective AI coding: code review, TDD, security, and coding standards',
      skillIds: ['coding-standards', 'tdd-workflow', 'ai-regression-testing', 'api-design', 'agent-planner', 'agent-code-reviewer', 'agent-security-reviewer'],
    },
    {
      id: 'full-stack',
      name: 'Full Stack',
      description: 'Everything in Recommended plus backend patterns, frontend patterns, and database migrations',
      skillIds: ['coding-standards', 'tdd-workflow', 'ai-regression-testing', 'api-design', 'backend-patterns', 'frontend-patterns', 'database-migrations', 'e2e-testing', 'agent-planner', 'agent-code-reviewer', 'agent-security-reviewer', 'agent-tdd-guide', 'agent-architect'],
    },
  ],
};

export function getSkillsManifest(): SkillManifest {
  return BUNDLED_MANIFEST;
}
