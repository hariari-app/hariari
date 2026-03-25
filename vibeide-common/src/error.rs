use thiserror::Error;

/// Top-level error type for VibeIDE.
#[derive(Error, Debug)]
pub enum VibeError {
    #[error("Terminal error: {0}")]
    Terminal(String),

    #[error("PTY error: {0}")]
    Pty(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Voice error: {0}")]
    Voice(String),

    #[error("Agent error: {0}")]
    Agent(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serde(String),
}

pub type VibeResult<T> = Result<T, VibeError>;
