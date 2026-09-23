## 2024-05-27 - Add aria-labels to icon buttons
**Learning:** Found several icon-only buttons in the main App shell missing accessible names, which would cause screen readers to announce them as generic buttons. Added context-aware labels (like 'Settings for [item name]') where possible to improve keyboard navigation and screen reader support.
**Action:** Always ensure icon-only buttons (`.icon-button`) have an `aria-label` describing their action.
