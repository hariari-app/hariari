// Agent lifecycle management -- Phase 2.5
//
// The AgentManager tracks agent metadata. Actual terminal I/O is handled
// by WezTerm's mux system; the manager only holds AgentProcess entries
// that link to terminals by ID.

use std::collections::HashMap;

use vibeide_common::error::{VibeError, VibeResult};

use crate::process::AgentProcess;

/// Manages the lifecycle of all registered agents.
pub struct AgentManager {
    agents: HashMap<u32, AgentProcess>,
    max_agents: usize,
}

impl AgentManager {
    /// Create a new manager with the given capacity limit.
    pub fn new(max_agents: usize) -> Self {
        Self {
            agents: HashMap::new(),
            max_agents,
        }
    }

    /// Register an agent. Returns an error if the limit is reached or the ID is duplicate.
    pub fn register_agent(&mut self, agent: AgentProcess) -> VibeResult<()> {
        if self.agents.len() >= self.max_agents {
            return Err(VibeError::Agent(format!(
                "Agent limit reached (max {})",
                self.max_agents,
            )));
        }

        if self.agents.contains_key(&agent.id) {
            return Err(VibeError::Agent(format!(
                "Agent with id {} already registered",
                agent.id,
            )));
        }

        tracing::info!(
            "Registered agent {} ({}) -> terminal {}",
            agent.id,
            agent.config.name,
            agent.terminal_id,
        );
        self.agents.insert(agent.id, agent);
        Ok(())
    }

    /// Remove an agent by ID, returning it if found.
    pub fn remove_agent(&mut self, id: u32) -> Option<AgentProcess> {
        let removed = self.agents.remove(&id);
        if let Some(ref agent) = removed {
            tracing::info!("Removed agent {} ({})", agent.id, agent.config.name);
        }
        removed
    }

    /// Get a reference to an agent by ID.
    pub fn get_agent(&self, id: u32) -> Option<&AgentProcess> {
        self.agents.get(&id)
    }

    /// Get a mutable reference to an agent by ID.
    pub fn get_agent_mut(&mut self, id: u32) -> Option<&mut AgentProcess> {
        self.agents.get_mut(&id)
    }

    /// List all registered agents.
    pub fn list_agents(&self) -> Vec<&AgentProcess> {
        self.agents.values().collect()
    }

    /// Number of registered agents.
    pub fn agent_count(&self) -> usize {
        self.agents.len()
    }

    /// Find an agent by its linked terminal ID.
    pub fn find_by_terminal_id(&self, terminal_id: u32) -> Option<&AgentProcess> {
        self.agents.values().find(|a| a.terminal_id == terminal_id)
    }

    /// Find a mutable agent by its linked terminal ID.
    pub fn find_by_terminal_id_mut(&mut self, terminal_id: u32) -> Option<&mut AgentProcess> {
        self.agents
            .values_mut()
            .find(|a| a.terminal_id == terminal_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentConfig;
    use crate::process::AgentProcess;

    fn make_agent(id: u32, terminal_id: u32) -> AgentProcess {
        AgentProcess::new(id, AgentConfig::claude_code(None), terminal_id)
    }

    #[test]
    fn register_and_retrieve_agent() {
        let mut mgr = AgentManager::new(10);
        let agent = make_agent(1, 100);
        mgr.register_agent(agent).unwrap();
        assert_eq!(mgr.agent_count(), 1);
        assert!(mgr.get_agent(1).is_some());
    }

    #[test]
    fn register_duplicate_id_fails() {
        let mut mgr = AgentManager::new(10);
        mgr.register_agent(make_agent(1, 100)).unwrap();
        let result = mgr.register_agent(make_agent(1, 200));
        assert!(result.is_err());
    }

    #[test]
    fn register_over_limit_fails() {
        let mut mgr = AgentManager::new(1);
        mgr.register_agent(make_agent(1, 100)).unwrap();
        let result = mgr.register_agent(make_agent(2, 200));
        assert!(result.is_err());
    }

    #[test]
    fn remove_agent_returns_it() {
        let mut mgr = AgentManager::new(10);
        mgr.register_agent(make_agent(1, 100)).unwrap();
        let removed = mgr.remove_agent(1);
        assert!(removed.is_some());
        assert_eq!(mgr.agent_count(), 0);
    }

    #[test]
    fn remove_nonexistent_returns_none() {
        let mut mgr = AgentManager::new(10);
        assert!(mgr.remove_agent(99).is_none());
    }

    #[test]
    fn find_by_terminal_id_works() {
        let mut mgr = AgentManager::new(10);
        mgr.register_agent(make_agent(1, 100)).unwrap();
        mgr.register_agent(make_agent(2, 200)).unwrap();
        let found = mgr.find_by_terminal_id(200);
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, 2);
    }

    #[test]
    fn find_by_terminal_id_returns_none_for_unknown() {
        let mgr = AgentManager::new(10);
        assert!(mgr.find_by_terminal_id(999).is_none());
    }

    #[test]
    fn list_agents_returns_all() {
        let mut mgr = AgentManager::new(10);
        mgr.register_agent(make_agent(1, 100)).unwrap();
        mgr.register_agent(make_agent(2, 200)).unwrap();
        assert_eq!(mgr.list_agents().len(), 2);
    }
}
