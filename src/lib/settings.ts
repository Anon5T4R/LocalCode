import { DEFAULT_MODELS_DIR } from "./ai";
import { detectLocale, type Locale } from "./i18n";

export interface Settings {
  modelsDir: string;
  lastModelPath: string;
  ngl: number;
  ctx: number;
  locale: Locale;
  githubClientId: string;
  theme: "dark" | "light" | "high-contrast";
}

const DEFAULTS: Settings = {
  modelsDir: DEFAULT_MODELS_DIR,
  lastModelPath: "",
  ngl: 0,
  ctx: 4096,
  locale: detectLocale(),
  githubClientId: "",
  theme: "dark",
};

const KEY = "localcode.settings";

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
