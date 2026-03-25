-- VibeIDE agent spawning module for WezTerm
-- Source this from your wezterm.lua to get agent keybindings.

local wezterm = require("wezterm")
local act = wezterm.action

local M = {}

--- Spawn an agent or shell in a new pane by splitting the current one.
--- @param agent_type string One of "claude", "shell", "gemini", "codex"
--- @return table A WezTerm action that splits and runs the agent command
function M.spawn_agent(agent_type)
  local commands = {
    claude = { "claude" },
    shell = { os.getenv("SHELL") or "/bin/bash" },
    gemini = { "gemini" },
    codex = { "codex" },
  }

  local cmd = commands[agent_type]
  if not cmd then
    wezterm.log_error("vibeide: unknown agent type: " .. tostring(agent_type))
    return act.Nop
  end

  return act.SplitPane({
    direction = "Right",
    command = wezterm.action_callback(function(window, pane)
      local tab = pane:tab()
      local new_pane = pane:split({
        direction = "Right",
        args = cmd,
        cwd = pane:get_current_working_dir(),
      })
    end),
  })
end

--- Return the VibeIDE leader + key_table keybindings.
--- Leader is Ctrl+Shift+A; after pressing leader, press:
---   c = Claude Code
---   s = Shell
---   g = Gemini
---   x = Codex
function M.keys()
  return {
    leader = { key = "a", mods = "CTRL|SHIFT", timeout_milliseconds = 2000 },
    keys = {
      {
        key = "c",
        mods = "LEADER",
        action = wezterm.action_callback(function(window, pane)
          pane:split({
            direction = "Right",
            args = { "claude" },
            cwd = pane:get_current_working_dir(),
          })
        end),
      },
      {
        key = "s",
        mods = "LEADER",
        action = wezterm.action_callback(function(window, pane)
          local shell = os.getenv("SHELL") or "/bin/bash"
          pane:split({
            direction = "Right",
            args = { shell },
            cwd = pane:get_current_working_dir(),
          })
        end),
      },
      {
        key = "g",
        mods = "LEADER",
        action = wezterm.action_callback(function(window, pane)
          pane:split({
            direction = "Right",
            args = { "gemini" },
            cwd = pane:get_current_working_dir(),
          })
        end),
      },
      {
        key = "x",
        mods = "LEADER",
        action = wezterm.action_callback(function(window, pane)
          pane:split({
            direction = "Right",
            args = { "codex" },
            cwd = pane:get_current_working_dir(),
          })
        end),
      },
    },
  }
end

return M
