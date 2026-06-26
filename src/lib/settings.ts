import { DEFAULT_MODELS_DIR } from "./ai";

export interface Settings {
  modelsDir: string;
  lastModelPath: string;
  ngl: number;
  ctx: number;
  locale: "pt" | "en";
}

const DEFAULTS: Settings = {
  modelsDir: DEFAULT_MODELS_DIR,
  lastModelPath: "",
  ngl: 0,
  ctx: 4096,
  locale: "pt",
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
