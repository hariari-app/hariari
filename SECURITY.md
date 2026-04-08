# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | No |

We only patch the latest release. Please upgrade to the latest version before reporting issues.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, please report them privately:

1. **GitHub Security Advisories** (preferred): Go to the [Security tab](https://github.com/vibeide-app/vibeide/security/advisories/new) and create a new advisory
2. **Email**: Send details to **hello@vibeide.dev** with subject line `[SECURITY]`

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depends on severity — critical issues are prioritized immediately

### What to Expect

- We will acknowledge your report promptly
- We will work with you to understand and validate the issue
- We will credit you in the release notes (unless you prefer otherwise)
- We ask that you give us reasonable time to fix the issue before public disclosure

## Scope

The following are in scope:

- The VibeIDE Electron application
- IPC communication between main and renderer processes
- PTY/terminal handling and command execution
- File system access and permissions
- Clipboard handling

The following are out of scope:

- Vulnerabilities in AI agents themselves (Claude, Gemini, etc.)
- Issues in upstream dependencies (report these to the respective projects)
- Social engineering attacks
