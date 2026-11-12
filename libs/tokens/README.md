# @land/tokens

The land-\* design tokens: Landfall's design system as Landflow's `globals.css` carries it, and a Tailwind 4 theme
over them. Landbright's console consumes it; Landflow and Landfall can adopt it later (plan §6.1).

```css
@import 'tailwindcss';
@import '@land/tokens/tokens.css';
@import '@land/tokens/theme.css';
```

`src/tokens.css` is a verbatim copy of Landflow's token blocks. `pnpm --filter @land/tokens test` fails when they
drift; it skips when no Landflow checkout sits next to this repo (`LANDFLOW_DIR` overrides the path).
