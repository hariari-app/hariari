/// Internal events that flow between subsystems.
#[derive(Debug, Clone)]
pub enum VibeEvent {
    /// A terminal pane was focused.
    PaneFocused { pane_id: String },

    /// An agent changed status.
    AgentStatusChanged {
        agent_id: String,
        status: AgentStatus,
    },

    /// Voice transcription completed.
    VoiceTranscription { text: String },

    /// Request to redraw the UI.
    RedrawRequested,

    /// Application quit requested.
    QuitRequested,
}

/// Agent lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Starting,
    Running,
    Thinking,
    Idle,
    Error,
    Stopped,
}
