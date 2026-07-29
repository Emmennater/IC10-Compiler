
const themes = {
  "Default": {
    // Text
    "declaration": "#ff7b72",
    "keyword": "#ff7b72",
    "function": "#d2a8ff",
    "number": "#ffa657",
    "variable": "#79c0ff",
    "string": "#a5d6ff",
    "comment": "#8b949e",
    "operator": "#7d91a8",
    "special": "#75e6d7",
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
    "variable": "#9CDCFE",
    "string": "#CE9178",
    "comment": "#6A9955",
    "operator": "#D4D4D4",
    "special": "#4EC9B0",
    // Elements
    "background": "#282C34",
    "border": "#535964",
    "background-element": "#363b45",
    "text-element": "#c9d1d9",
    "line-number": "#858585"
  }
};

const THEME_KEY = "ic10-theme";
const DEFAULT_THEME = "Dark+";

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

  localStorage.setItem(THEME_KEY, resolved);

  return themes[resolved];
}

export function loadTheme() {
  return applyTheme(themeName());
}
