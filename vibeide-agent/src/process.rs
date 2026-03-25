// Agent process abstraction -- Phase 2.5
//
// An agent is a terminal session with extra metadata: config, status, and timing.
// WezTerm handles actual I/O; the AgentProcess tracks lifecycle state.

use std::time::{Duration, Instant};

use vibeide_common::event::AgentStatus;

use crate::config::AgentConfig;

/// An agent process linked to a terminal session.
pub struct AgentProcess {
    pub id: u32,
    pub config: AgentConfig,
    pub status: AgentStatus,
    pub started_at: Instant,
    pub terminal_id: u32,
}

impl AgentProcess {
    /// Create a new agent process with the given configuration.
    pub fn new(id: u32, config: AgentConfig, terminal_id: u32) -> Self {
        Self {
            id,
            config,
            status: AgentStatus::Starting,
            started_at: Instant::now(),
            terminal_id,
        }
    }

    /// Update the agent's lifecycle status.
    pub fn update_status(&mut self, new_status: AgentStatus) {
        tracing::debug!(
            "Agent {} ({}) status: {:?} -> {:?}",
            self.id,
            self.config.name,
            self.status,
            new_status,
        );
        self.status = new_status;
    }

    /// How long the agent has been running since creation.
    pub fn uptime(&self) -> Duration {
        self.started_at.elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentConfig;

    #[test]
    fn new_agent_starts_in_starting_status() {
        let config = AgentConfig::claude_code(None);
        let agent = AgentProcess::new(1, config, 10);
        assert_eq!(agent.id, 1);
        assert_eq!(agent.terminal_id, 10);
        assert_eq!(agent.status, AgentStatus::Starting);
    }

    #[test]
    fn update_status_changes_status() {
        let config = AgentConfig::shell("/bin/bash");
        let mut agent = AgentProcess::new(2, config, 20);
        agent.update_status(AgentStatus::Running);
        assert_eq!(agent.status, AgentStatus::Running);
        agent.update_status(AgentStatus::Idle);
        assert_eq!(agent.status, AgentStatus::Idle);
    }

    #[test]
    fn uptime_is_nonnegative() {
        let config = AgentConfig::codex(None);
        let agent = AgentProcess::new(3, config, 30);
        // Uptime should be very small but non-zero.
        let _ = agent.uptime(); // Confirm it doesn't panic.
    }
}
