# Antigravity UI/UX Design System Rules

This workspace is integrated with **`ui-ux-pro-max`** and **`frontend-design`** agent skills.

## Mandatory Guidelines for UI & Frontend Tasks

Whenever the user asks to design, style, refactor, or build user interfaces, components, or pages:

1. **Active Skills**:
   - **`ui-ux-pro-max`**: Design intelligence engine for 79+ UI styles, 192+ color palettes, 74+ Google font pairings, 119+ UX guidelines, and stack-specific rules (Next.js 16, React 19, Tailwind CSS v4).
   - **`frontend-design`**: Anti-generic design methodology ensuring distinct brand identity, purposeful typography hierarchy, and avoiding generic "AI slop" (no cookie-cutter SaaS cards, no repetitive purple glows).

2. **Stack Standards**:
   - Framework: Next.js 16 (Turbopack / App Router) + React 19 + Electron 35.
   - Styling: Tailwind CSS v4 using CSS variable tokens.
   - Component architecture: Server Components by default; Client Components (`'use client'`) only at interactive leaf nodes.
   - Accessibility: WCAG 2.1 AA minimum (4.5:1 text contrast), visible keyboard focus rings, min 44x44px touch/click targets.
   - Icons: Lucide / SVG icons only (never raw emojis as interface icons).

3. **Design System Execution**:
   - When proposing or building a new UI feature, run the offline design search engine to generate tokens:
     ```bash
     python .agents/skills/ui-ux-pro-max/scripts/search.py "<product-theme>" --design-system -p "Universal Freebie"
     ```
   - Reference stack-specific best practices:
     ```bash
     python .agents/skills/ui-ux-pro-max/scripts/search.py "<topic>" --stack nextjs
     ```
