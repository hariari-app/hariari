// Agent configuration -- Phase 2.5
//
// Defines agent types, presets, and configuration loading from TOML.

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The type of AI agent or shell process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentType {
    ClaudeCode,
    Codex,
    Gemini,
    Shell,
    Custom,
}

impl fmt::Display for AgentType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClaudeCode => write!(f, "Claude Code"),
            Self::Codex => write!(f, "Codex"),
            Self::Gemini => write!(f, "Gemini"),
            Self::Shell => write!(f, "Shell"),
            Self::Custom => write!(f, "Custom"),
        }
    }
}

/// Configuration for spawning an agent process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    pub agent_type: AgentType,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub working_dir: Option<String>,
    pub auto_restart: bool,
}

impl AgentConfig {
    /// Preset for Claude Code CLI.
    pub fn claude_code(working_dir: Option<&str>) -> Self {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        Self {
            name: "Claude Code".to_string(),
            agent_type: AgentType::ClaudeCode,
            command: "claude".to_string(),
            args: Vec::new(),
            env,
            working_dir: working_dir.map(String::from),
            auto_restart: false,
        }
    }

    /// Preset for OpenAI Codex CLI.
    pub fn codex(working_dir: Option<&str>) -> Self {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        Self {
            name: "Codex".to_string(),
            agent_type: AgentType::Codex,
            command: "codex".to_string(),
            args: Vec::new(),
            env,
            working_dir: working_dir.map(String::from),
            auto_restart: false,
        }
    }

    /// Preset for Gemini CLI.
    pub fn gemini(working_dir: Option<&str>) -> Self {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        Self {
            name: "Gemini".to_string(),
            agent_type: AgentType::Gemini,
            command: "gemini".to_string(),
            args: Vec::new(),
            env,
            working_dir: working_dir.map(String::from),
            auto_restart: false,
        }
    }

    /// Preset for a plain shell.
    pub fn shell(shell_path: &str) -> Self {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "xterm-256color".to_string());

        Self {
            name: "Shell".to_string(),
            agent_type: AgentType::Shell,
            command: shell_path.to_string(),
            args: Vec::new(),
            env,
            working_dir: None,
            auto_restart: false,
        }
    }
}

/// Top-level structure for `~/.vibeide/agents.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentsToml {
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
}

/// Load agent configurations from `~/.vibeide/agents.toml`.
/// Returns an empty list if the file does not exist or cannot be parsed.
pub fn load_agent_configs() -> Vec<AgentConfig> {
    let config_path = agent_config_path();
    match std::fs::read_to_string(&config_path) {
        Ok(content) => match toml::from_str::<AgentsToml>(&content) {
            Ok(parsed) => {
                tracing::info!(
                    "Loaded {} agent configs from {}",
                    parsed.agents.len(),
                    config_path.display()
                );
                parsed.agents
            }
            Err(e) => {
                tracing::warn!("Failed to parse {}: {e}", config_path.display());
                Vec::new()
            }
        },
        Err(_) => {
            tracing::debug!(
                "No agent config at {}, using defaults",
                config_path.display()
            );
            Vec::new()
        }
    }
}

/// Path to the agents configuration file.
fn agent_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".vibeide").join("agents.toml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_preset_has_correct_command() {
        let config = AgentConfig::claude_code(Some("/home/user/project"));
        assert_eq!(config.command, "claude");
        assert_eq!(config.agent_type, AgentType::ClaudeCode);
        assert_eq!(config.working_dir.as_deref(), Some("/home/user/project"));
        assert!(!config.auto_restart);
    }

    #[test]
    fn codex_preset_has_correct_command() {
        let config = AgentConfig::codex(None);
        assert_eq!(config.command, "codex");
        assert_eq!(config.agent_type, AgentType::Codex);
        assert!(config.working_dir.is_none());
    }

    #[test]
    fn gemini_preset_has_correct_command() {
        let config = AgentConfig::gemini(None);
        assert_eq!(config.command, "gemini");
        assert_eq!(config.agent_type, AgentType::Gemini);
    }

    #[test]
    fn shell_preset_uses_given_path() {
        let config = AgentConfig::shell("/bin/zsh");
        assert_eq!(config.command, "/bin/zsh");
        assert_eq!(config.agent_type, AgentType::Shell);
    }

    #[test]
    fn agent_type_display() {
        assert_eq!(AgentType::ClaudeCode.to_string(), "Claude Code");
        assert_eq!(AgentType::Shell.to_string(), "Shell");
    }

    #[test]
    fn agents_toml_round_trip() {
        let config = AgentConfig::claude_code(Some("/tmp"));
        let toml_data = AgentsToml {
            agents: vec![config.clone()],
        };
        let serialized = toml::to_string(&toml_data).unwrap();
        let parsed: AgentsToml = toml::from_str(&serialized).unwrap();
        assert_eq!(parsed.agents.len(), 1);
        assert_eq!(parsed.agents[0].command, "claude");
    }
}
