-- VibeIDE default WezTerm configuration
-- Copy or symlink to ~/.wezterm.lua or ~/.config/wezterm/wezterm.lua

local wezterm = require("wezterm")
local vibeide = require("vibeide")

local config = wezterm.config_builder()

-- Appearance
config.color_scheme = "Tokyo Night"
config.font_size = 14.0
config.font = wezterm.font("JetBrains Mono", { weight = "Regular" })

-- Tab bar
config.enable_tab_bar = true
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.hide_tab_bar_if_only_one_tab = false

-- Window
config.window_padding = {
  left = 4,
  right = 4,
  top = 4,
  bottom = 4,
}
config.window_decorations = "RESIZE"
config.initial_rows = 40
config.initial_cols = 140

-- Scrollback
config.scrollback_lines = 10000

-- Cursor
config.default_cursor_style = "BlinkingBar"
config.cursor_blink_rate = 500

-- VibeIDE agent keybindings (Ctrl+Shift+A leader)
local vibeide_keys = vibeide.keys()
config.leader = vibeide_keys.leader

-- Merge VibeIDE keys with any additional keys
config.keys = vibeide_keys.keys

return config
