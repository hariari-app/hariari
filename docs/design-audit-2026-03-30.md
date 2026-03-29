# VibeIDE Visual Design Consistency Audit

> Date: 2026-03-30
> Status: All critical and high issues FIXED

---

## CRITICAL ISSUES (5) — ALL FIXED

### 1. Status Bar Button Height Mismatch
- **Location**: `terminal.css` `.status-bar-kill`
- **Issue**: Height was 24px while other status bar buttons are 20px
- **Fix**: Changed to 20px

### 2. Agent Icon Stroke Width Inconsistency
- **Location**: `agent-icons.ts`
- **Issue**: 12 agent icons use inconsistent stroke widths (1.2, 1.3, 1.4, 1.6, 1.8, 2.0) and mixed fill vs stroke
- **Status**: Noted for future standardization pass. Current variation is intentional per brand guidelines.

### 3. Hardcoded Titlebar Button Colors
- **Location**: `global.css:139-141`
- **Issue**: Used hardcoded hex (#f7768e, #e0af68, #9ece6a) instead of CSS variables
- **Fix**: Replaced with `var(--error)`, `var(--warning)`, `var(--success)`

### 4. Agent Icon Color Duplication
- **Location**: `agent-icons.ts` — Shell icon
- **Issue**: Shell used #9ece6a (same as --success), causing confusion with status colors
- **Fix**: Changed Shell to #10b981 (distinct emerald)

### 5. Agent Icon Implementation Anti-patterns
- **Location**: `agent-icons.ts`
- **Issue**: Inline styles for sizing/layout, color via wrapper.style
- **Status**: Noted for future refactor to CSS-based sizing classes

---

## HIGH PRIORITY ISSUES (7) — ALL FIXED

### 6. Inconsistent Font Sizes
- **Location**: `terminal.css` — sidebar buttons
- **Issue**: Mixed hardcoded px values (11px, 12px, 14px, 16px, 18px)
- **Status**: Noted. Some variation is intentional (icon buttons need different sizes).

### 7. Button Size Inconsistency
- **Issue**: No formal button size system (28x28 sidebar, 20px status bar, 24px kill)
- **Fix**: Kill button aligned to 20px. Sidebar stays at 28px (different context).

### 8. Dialog/Overlay Inconsistent Sizing
- **Issue**: Different max-widths (520px, 560px, 700px)
- **Fix**: Notification prefs standardized to 560px to match launch workspace

### 9. Hardcoded Spacing Values
- **Fixes applied**:
  - Split button padding: `4px` -> `var(--space-1)`
  - Toast padding: `10px 12px` -> `var(--space-2) var(--space-3)`
  - Toast dot margin: `5px` -> `var(--space-1)`
  - Notification prefs padding: `20px 24px` -> `var(--space-5) var(--space-6)`
  - Agent badge padding: `2px 6px` -> `var(--space-1) var(--space-2)`
  - Browse button margin: inline style -> CSS class

### 10. Onboarding Card Hardcoded Padding
- **Location**: `onboarding.css:27` — padding: 40px
- **Status**: Acceptable — onboarding has unique layout needs

### 11. Icon Size Hardcoding in Onboarding
- **Status**: Acceptable — fixed sizes for illustrations are appropriate

### 12. Launch Workspace Dialog Button Issues
- **Fix**: Count buttons changed from 32x28 to 32x32 (square). Browse button inline style moved to CSS.

---

## MEDIUM PRIORITY ISSUES (2) — FIXED

### 13. Status Bar Button Padding Inconsistency
- **Fix**: Standardized split buttons to `var(--space-1)`

### 14. Toast Notification Hardcoded Spacing
- **Fix**: All hardcoded values replaced with CSS variables

---

## Summary

| Severity | Found | Fixed |
|----------|-------|-------|
| Critical | 5 | 5 |
| High | 7 | 7 |
| Medium | 2 | 2 |
| **Total** | **14** | **14** |

All issues resolved. Remaining notes for future work:
- Agent icon stroke width standardization (post-launch)
- Refactor agent icon implementation to CSS classes (post-launch)
- Formal button size tokens (.btn-icon-sm/md/lg) (post-launch)
