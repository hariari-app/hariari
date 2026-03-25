// Health monitoring -- Phase 2.5
//
// Detect agent status from terminal output patterns. Each agent type
// has characteristic output that indicates its lifecycle state.

use vibeide_common::event::AgentStatus;

use crate::config::AgentType;

/// Monitors agent health by inspecting PTY output patterns.
pub struct HealthMonitor;

impl HealthMonitor {
    /// Analyze terminal output and return a detected status change, if any.
    ///
    /// Returns `None` if the output does not contain a recognizable pattern.
    pub fn check_output(output: &str, agent_type: &AgentType) -> Option<AgentStatus> {
        match agent_type {
            AgentType::ClaudeCode => check_claude_code(output),
            AgentType::Codex => check_codex(output),
            AgentType::Gemini => check_gemini(output),
            AgentType::Shell => check_shell(output),
            AgentType::Custom => check_generic(output),
        }
    }

    /// Auto-detect the agent type from initial terminal output.
    pub fn detect_agent_type(output: &str) -> Option<AgentType> {
        let lower = output.to_lowercase();
        if lower.contains("claude") {
            Some(AgentType::ClaudeCode)
        } else if lower.contains("codex") {
            Some(AgentType::Codex)
        } else if lower.contains("gemini") {
            Some(AgentType::Gemini)
        } else {
            None
        }
    }
}

/// Detect Claude Code status from output patterns.
fn check_claude_code(output: &str) -> Option<AgentStatus> {
    if output.contains("Thinking") || output.contains("thinking") {
        Some(AgentStatus::Thinking)
    } else if output.contains("> ") || output.contains("\u{276f}") {
        Some(AgentStatus::Idle)
    } else if output.contains("Error") || output.contains("error:") {
        Some(AgentStatus::Error)
    } else if !output.trim().is_empty() {
        Some(AgentStatus::Running)
    } else {
        None
    }
}

/// Detect Codex status from output patterns.
fn check_codex(output: &str) -> Option<AgentStatus> {
    if output.contains("thinking") || output.contains("Thinking") {
        Some(AgentStatus::Thinking)
    } else if output.contains("> ") {
        Some(AgentStatus::Idle)
    } else if output.contains("error") {
        Some(AgentStatus::Error)
    } else if !output.trim().is_empty() {
        Some(AgentStatus::Running)
    } else {
        None
    }
}

/// Detect Gemini status from output patterns.
fn check_gemini(output: &str) -> Option<AgentStatus> {
    if output.contains("Thinking") || output.contains("thinking") {
        Some(AgentStatus::Thinking)
    } else if output.contains("> ") || output.contains(">>> ") {
        Some(AgentStatus::Idle)
    } else if output.contains("Error") || output.contains("error:") {
        Some(AgentStatus::Error)
    } else if !output.trim().is_empty() {
        Some(AgentStatus::Running)
    } else {
        None
    }
}

/// Detect plain shell status.
fn check_shell(output: &str) -> Option<AgentStatus> {
    if output.contains("$ ") || output.contains("# ") || output.contains("% ") {
        Some(AgentStatus::Idle)
    } else if !output.trim().is_empty() {
        Some(AgentStatus::Running)
    } else {
        None
    }
}

/// Generic fallback for custom agents.
fn check_generic(output: &str) -> Option<AgentStatus> {
    if !output.trim().is_empty() {
        Some(AgentStatus::Running)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_thinking_detected() {
        let status = HealthMonitor::check_output("Thinking...", &AgentType::ClaudeCode);
        assert_eq!(status, Some(AgentStatus::Thinking));
    }

    #[test]
    fn claude_code_idle_on_prompt() {
        let status = HealthMonitor::check_output("> ", &AgentType::ClaudeCode);
        assert_eq!(status, Some(AgentStatus::Idle));
    }

    #[test]
    fn claude_code_error_detected() {
        let status =
            HealthMonitor::check_output("Error: something failed", &AgentType::ClaudeCode);
        assert_eq!(status, Some(AgentStatus::Error));
    }

    #[test]
    fn shell_idle_on_prompt() {
        let status = HealthMonitor::check_output("user@host:~$ ", &AgentType::Shell);
        assert_eq!(status, Some(AgentStatus::Idle));
    }

    #[test]
    fn empty_output_returns_none() {
        let status = HealthMonitor::check_output("", &AgentType::ClaudeCode);
        assert_eq!(status, None);
    }

    #[test]
    fn detect_claude_type() {
        let detected = HealthMonitor::detect_agent_type("Welcome to Claude Code v1.0");
        assert_eq!(detected, Some(AgentType::ClaudeCode));
    }

    #[test]
    fn detect_unknown_type() {
        let detected = HealthMonitor::detect_agent_type("some random shell output");
        assert_eq!(detected, None);
    }
}
