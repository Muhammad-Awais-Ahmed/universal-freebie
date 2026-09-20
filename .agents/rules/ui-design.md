# UI/UX Design System Guidelines

When designing, refactoring, or creating UI components, views, or layouts in this repository, always adhere to the installed UI design intelligence skills:

## Available Skills
1. **`ui-ux-pro-max`** (`.agents/skills/ui-ux-pro-max/`):
   - Query design styles, palettes, typography, and stack guidelines using the offline search tool:
     `python .agents/skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system -p "Universal Freebie"`
   - Query stack-specific Next.js / Tailwind guidelines:
     `python .agents/skills/ui-ux-pro-max/scripts/search.py "<topic>" --stack nextjs`
   - Check pre-delivery checklists and UX guidelines in `.agents/skills/ui-ux-pro-max/references/`.

2. **`frontend-design`** (`.agents/skills/frontend-design/`):
   - Distinctive visual identity: avoid generic AI design patterns (e.g. cookie-cutter rounded cards, warm cream with terracotta, or identical purple glow washes).
   - Ground designs in the subject matter: gaming, high-energy download manager, performance-focused client.
   - Purposeful typography and layout hierarchy.
   - Restraint: let one element be the bold, memorable anchor; keep supporting elements quiet and functional.

## Stack Requirements (Next.js 16 + Tailwind CSS v4)
- Keep components as Server Components by default; only add `'use client'` to interactive leaf components.
- Use semantic CSS variables and design tokens rather than ad-hoc raw hex values.
- Ensure accessible contrast (minimum 4.5:1 for body text), visible keyboard focus rings, and `cursor-pointer` on all interactive elements.
- Never use emojis as iconography; use SVG icons (e.g., Lucide).
