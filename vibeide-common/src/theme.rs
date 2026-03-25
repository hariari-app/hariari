use serde::{Deserialize, Serialize};

/// RGBA color with f32 components (0.0-1.0).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// Create from hex string like "#0f172a".
    pub fn from_hex(hex: &str) -> Option<Self> {
        let hex = hex.strip_prefix('#').unwrap_or(hex);
        if hex.len() != 6 {
            return None;
        }
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some(Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: 1.0,
        })
    }

    /// Convert to an [r, g, b, a] array of f64 values.
    pub fn to_f64_array(self) -> [f64; 4] {
        [self.r as f64, self.g as f64, self.b as f64, self.a as f64]
    }
}

/// Terminal color palette -- 16 ANSI colors + foreground/background.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalColors {
    pub foreground: Color,
    pub background: Color,
    pub cursor: Color,
    pub selection: Color,
    pub ansi: [Color; 16],
}

/// Complete theme definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub name: String,
    pub terminal: TerminalColors,
    pub ui_bg: Color,
    pub ui_fg: Color,
    pub ui_border: Color,
    pub ui_accent: Color,
    pub ui_surface: Color,
}

impl Theme {
    /// Return all built-in themes.
    pub fn builtins() -> Vec<Self> {
        vec![Self::tokyo_night(), Self::tokyo_night_light(), Self::solarized_dark()]
    }

    /// Tokyo Night dark theme -- the default.
    pub fn tokyo_night() -> Self {
        Self {
            name: "Tokyo Night".to_string(),
            terminal: TerminalColors {
                foreground: Color::from_hex("#a9b1d6").unwrap(),
                background: Color::from_hex("#0f172a").unwrap(),
                cursor: Color::from_hex("#c0caf5").unwrap(),
                selection: Color::from_hex("#283457").unwrap(),
                ansi: [
                    Color::from_hex("#15161e").unwrap(), // black
                    Color::from_hex("#f7768e").unwrap(), // red
                    Color::from_hex("#9ece6a").unwrap(), // green
                    Color::from_hex("#e0af68").unwrap(), // yellow
                    Color::from_hex("#7aa2f7").unwrap(), // blue
                    Color::from_hex("#bb9af7").unwrap(), // magenta
                    Color::from_hex("#7dcfff").unwrap(), // cyan
                    Color::from_hex("#a9b1d6").unwrap(), // white
                    Color::from_hex("#414868").unwrap(), // bright black
                    Color::from_hex("#f7768e").unwrap(), // bright red
                    Color::from_hex("#9ece6a").unwrap(), // bright green
                    Color::from_hex("#e0af68").unwrap(), // bright yellow
                    Color::from_hex("#7aa2f7").unwrap(), // bright blue
                    Color::from_hex("#bb9af7").unwrap(), // bright magenta
                    Color::from_hex("#7dcfff").unwrap(), // bright cyan
                    Color::from_hex("#c0caf5").unwrap(), // bright white
                ],
            },
            ui_bg: Color::from_hex("#0f172a").unwrap(),
            ui_fg: Color::from_hex("#a9b1d6").unwrap(),
            ui_border: Color::from_hex("#1e293b").unwrap(),
            ui_accent: Color::from_hex("#7aa2f7").unwrap(),
            ui_surface: Color::from_hex("#1a1b2e").unwrap(),
        }
    }

    /// Tokyo Night Light theme.
    pub fn tokyo_night_light() -> Self {
        Self {
            name: "Tokyo Night Light".to_string(),
            terminal: TerminalColors {
                foreground: Color::from_hex("#343b58").unwrap(),
                background: Color::from_hex("#d5d6db").unwrap(),
                cursor: Color::from_hex("#343b58").unwrap(),
                selection: Color::from_hex("#99a7df").unwrap(),
                ansi: [
                    Color::from_hex("#0f0f14").unwrap(), // black
                    Color::from_hex("#8c4351").unwrap(), // red
                    Color::from_hex("#485e30").unwrap(), // green
                    Color::from_hex("#8f5e15").unwrap(), // yellow
                    Color::from_hex("#34548a").unwrap(), // blue
                    Color::from_hex("#5a4a78").unwrap(), // magenta
                    Color::from_hex("#0f4b6e").unwrap(), // cyan
                    Color::from_hex("#343b58").unwrap(), // white
                    Color::from_hex("#9699a3").unwrap(), // bright black
                    Color::from_hex("#8c4351").unwrap(), // bright red
                    Color::from_hex("#485e30").unwrap(), // bright green
                    Color::from_hex("#8f5e15").unwrap(), // bright yellow
                    Color::from_hex("#34548a").unwrap(), // bright blue
                    Color::from_hex("#5a4a78").unwrap(), // bright magenta
                    Color::from_hex("#0f4b6e").unwrap(), // bright cyan
                    Color::from_hex("#343b58").unwrap(), // bright white
                ],
            },
            ui_bg: Color::from_hex("#d5d6db").unwrap(),
            ui_fg: Color::from_hex("#343b58").unwrap(),
            ui_border: Color::from_hex("#c4c5ca").unwrap(),
            ui_accent: Color::from_hex("#34548a").unwrap(),
            ui_surface: Color::from_hex("#cbccd1").unwrap(),
        }
    }

    /// Solarized Dark theme.
    pub fn solarized_dark() -> Self {
        Self {
            name: "Solarized Dark".to_string(),
            terminal: TerminalColors {
                foreground: Color::from_hex("#839496").unwrap(),
                background: Color::from_hex("#002b36").unwrap(),
                cursor: Color::from_hex("#93a1a1").unwrap(),
                selection: Color::from_hex("#073642").unwrap(),
                ansi: [
                    Color::from_hex("#073642").unwrap(), // black
                    Color::from_hex("#dc322f").unwrap(), // red
                    Color::from_hex("#859900").unwrap(), // green
                    Color::from_hex("#b58900").unwrap(), // yellow
                    Color::from_hex("#268bd2").unwrap(), // blue
                    Color::from_hex("#d33682").unwrap(), // magenta
                    Color::from_hex("#2aa198").unwrap(), // cyan
                    Color::from_hex("#eee8d5").unwrap(), // white
                    Color::from_hex("#002b36").unwrap(), // bright black
                    Color::from_hex("#cb4b16").unwrap(), // bright red
                    Color::from_hex("#586e75").unwrap(), // bright green
                    Color::from_hex("#657b83").unwrap(), // bright yellow
                    Color::from_hex("#839496").unwrap(), // bright blue
                    Color::from_hex("#6c71c4").unwrap(), // bright magenta
                    Color::from_hex("#93a1a1").unwrap(), // bright cyan
                    Color::from_hex("#fdf6e3").unwrap(), // bright white
                ],
            },
            ui_bg: Color::from_hex("#002b36").unwrap(),
            ui_fg: Color::from_hex("#839496").unwrap(),
            ui_border: Color::from_hex("#073642").unwrap(),
            ui_accent: Color::from_hex("#268bd2").unwrap(),
            ui_surface: Color::from_hex("#073642").unwrap(),
        }
    }
}
