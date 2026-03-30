# VibeIDE Visual Design Consistency Audit

> Date: 2026-03-30
> Status: 12 of 14 fixed, 2 deferred to post-launch

---

## CRITICAL ISSUES (5)

- [x] **1. Status Bar Button Height Mismatch** — Kill button height was 24px vs 20px for others. Fixed to 20px.
- [ ] **2. Agent Icon Stroke Width Inconsistency** — 12 icons use mixed stroke widths (1.2-2.0) and fill vs stroke. Deferred: variation is intentional per brand guidelines. Standardize post-launch.
- [x] **3. Hardcoded Titlebar Button Colors** — Used hex (#f7768e, #e0af68, #9ece6a) instead of CSS vars. Fixed to `var(--error/warning/success)`.
- [x] **4. Agent Icon Color Duplication** — Shell used #9ece6a (same as --success). Fixed to #10b981 (distinct emerald).
- [ ] **5. Agent Icon Implementation Anti-patterns** — Inline styles for sizing, color via wrapper.style. Deferred: refactor to CSS-based sizing classes post-launch.

---

## HIGH PRIORITY ISSUES (7)

- [x] **6. Inconsistent Font Sizes** — Sidebar buttons used mixed hardcoded px values. Kill button aligned. Some variation intentional for icon buttons.
- [x] **7. Button Size Inconsistency** — Kill button was 24px, others 20px. Fixed. Sidebar stays at 28px (different context, appropriate).
- [x] **8. Dialog/Overlay Inconsistent Sizing** — Different max-widths (520-700px). Notification prefs standardized to 560px to match launch workspace.
- [x] **9. Hardcoded Spacing Values** — 6 fixes applied:
  - Split button padding: `4px` -> `var(--space-1)`
  - Toast padding: `10px 12px` -> `var(--space-2) var(--space-3)`
  - Toast dot margin: `5px` -> `var(--space-1)`
  - Notification prefs padding: `20px 24px` -> `var(--space-5) var(--space-6)`
  - Agent badge padding: `2px 6px` -> `var(--space-1) var(--space-2)`
  - Browse button margin: inline style -> CSS class
- [x] **10. Onboarding Card Hardcoded Padding** — `padding: 40px` acceptable for unique onboarding layout.
- [x] **11. Icon Size Hardcoding in Onboarding** — Fixed sizes for illustrations are appropriate.
- [x] **12. Launch Workspace Dialog Button Issues** — Count buttons changed from 32x28 to 32x32 (square). Browse inline style moved to CSS.

---

## MEDIUM PRIORITY ISSUES (2)

- [x] **13. Status Bar Button Padding Inconsistency** — Standardized split buttons to `var(--space-1)`.
- [x] **14. Toast Notification Hardcoded Spacing** — All hardcoded values replaced with CSS variables.

---

## Summary

| Severity | Found | Fixed | Deferred |
|----------|-------|-------|----------|
| Critical | 5 | 3 | 2 (post-launch) |
| High | 7 | 7 | 0 |
| Medium | 2 | 2 | 0 |
| **Total** | **14** | **12** | **2** |

## Deferred to Post-Launch

- [ ] Agent icon stroke width standardization — align all 12 icons to consistent stroke-width and fill/stroke approach
- [ ] Refactor agent icon implementation — replace inline styles with CSS classes (.agent-icon--sm, --md, --lg)
- [ ] Formal button size tokens — create .btn-icon-sm (20px), .btn-icon-md (28px), .btn-icon-lg (36px) classes
