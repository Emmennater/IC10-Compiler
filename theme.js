// The color values are exported because two very different consumers need
// them: codemirror.js reads them as JS (a CodeMirror highlight style is built
// from the strings, not from CSS), and the docs prerender in vite.config.js
// generates this map into a `<style>` block so the static page is correctly
// colored before - and without - any of this module running. Both are
// generated from here; nothing hand-copies a color.
export const themes = {
  "Default": {
    // Text
    "declaration": "#ff7b72",
    "keyword": "#ff7b72",
    "function": "#d2a8ff",
    "number": "#ffa657",
    "bool": "#ff7b72",
    "variable": "#79c0ff",
    "string": "#a5d6ff",
    "comment": "#8b949e",
    "operator": "#7d91a8",
    "register": "#75e6d7",
    "device": "#75e6d7",
    "instruction": "#d2a8ff",
    "label": "#ff7b72",
    // Elements
    "background": "#282C34",
    "border": "#535964",
    "background-element": "#363b45",
    "text-element": "#c9d1d9",
    "line-number": "#858585"
  },
  "Dark+": {
    // Text
    "declaration": "#569CD6",
    "keyword": "#C586C0",
    "function": "#DCDCAA",
    "number": "#B5CEA8",
    "bool": "#569CD6",
    "variable": "#9CDCFE",
    "string": "#CE9178",
    "comment": "#6A9955",
    "operator": "#D4D4D4",
    "register": "#4EC9B0",
    "device": "#4EC9B0",
    "instruction": "#DCDCAA",
    "label": "#569CD6",
    // Elements
    "background": "#282C34",
    "border": "#535964",
    "background-element": "#363b45",
    "text-element": "#c9d1d9",
    "line-number": "#858585"
  },
  "IC10": {
    // Text
    "declaration": "#6C30A4",
    "keyword": "#DC6D0F",
    "function": "#919192",
    "number": "#2E8882",
    "bool": "#6C30A4",
    "variable": "#d2d2d2",
    "string": "#d2d2d2",
    "comment": "#4F4F50",
    "operator": "#D4D4D4",
    "register": "#0066CF",
    "device": "#00CA14",
    "instruction": "#C8BE27",
    "label": "#6C30A4",
    // Elements
    "background": "#001223",
    "border": "#414d5a",
    "background-element": "#001223",
    "text-element": "#909da9",
    "line-number": "#858585"
  }
};

export const THEME_KEY = "ic10-theme";
export const DEFAULT_THEME = "Dark+";

export const themeNames = Object.keys(themes);

/** The stored theme name, falling back to the default if it is unknown. */
export function themeName() {
  const stored = localStorage.getItem(THEME_KEY);
  return Object.hasOwn(themes, stored) ? stored : DEFAULT_THEME;
}

/** Write a theme's colors into the css root and remember the choice. */
export function applyTheme(name) {
  const resolved = Object.hasOwn(themes, name) ? name : DEFAULT_THEME;

  // Add to css root
  for (const [key, value] of Object.entries(themes[resolved])) {
    document.documentElement.style.setProperty(`--theme-${key}`, value);
  }

  // Keeps the attribute the docs page's head script sets in step with the
  // inline properties written above. The properties win on their own (an
  // inline style beats a stylesheet rule), so this changes nothing about how
  // the page looks now - it stops `data-theme` from naming one theme while
  // the page displays another, which is the state a mid-session switch would
  // otherwise leave behind.
  document.documentElement.dataset.theme = resolved;

  localStorage.setItem(THEME_KEY, resolved);

  return themes[resolved];
}

export function loadTheme() {
  return applyTheme(themeName());
}
