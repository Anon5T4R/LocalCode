import { useState, useCallback } from "react";
import { loadSettings, saveSettings } from "../lib/settings";
import type { Settings } from "../lib/settings";
import { t, setLocale, LOCALE_LABELS, type Locale } from "../lib/i18n";

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>(loadSettings());

  const update = useCallback((patch: Partial<Settings>) => {
    const next = saveSettings(patch);
    setSettings(next);
  }, []);

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span>{t("common.settings")}</span>
        <button className="settings-close-btn" onClick={onClose} title={t("common.close")}>
          <span className="codicon codicon-close" />
        </button>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t("settings.aiSection")}</div>

        <label className="settings-label">{t("settings.modelsDir")}</label>
        <input
          className="settings-input"
          value={settings.modelsDir}
          onChange={(e) => update({ modelsDir: e.target.value })}
        />

        <label className="settings-label">GPU Layers (ngl)</label>
        <input
          className="settings-input"
          type="number"
          value={settings.ngl}
          onChange={(e) => update({ ngl: parseInt(e.target.value) || 0 })}
        />

        <label className="settings-label">Context size (ctx)</label>
        <input
          className="settings-input"
          type="number"
          value={settings.ctx}
          onChange={(e) => update({ ctx: parseInt(e.target.value) || 4096 })}
        />
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t("settings.editorSection")}</div>

        <label className="settings-label">{t("settings.theme")}</label>
        <select
          className="settings-input"
          value={settings.theme}
          onChange={(e) => {
            const theme = e.target.value as Settings["theme"];
            update({ theme });
            document.documentElement.setAttribute("data-theme", theme);
          }}
        >
          <option value="dark">{t("settings.themeDark")}</option>
          <option value="light">{t("settings.themeLight")}</option>
          <option value="high-contrast">{t("settings.themeHc")}</option>
          <option value="nature">{t("settings.themeNature")}</option>
          <option value="darkblue">{t("settings.themeDarkBlue")}</option>
          <option value="calmgreen">{t("settings.themeCalmGreen")}</option>
          <option value="pastelpink">{t("settings.themePastelPink")}</option>
          <option value="punkprincess">{t("settings.themePunkPrincess")}</option>
        </select>

        <label className="settings-label">{t("settings.language")}</label>
        <select
          className="settings-input"
          value={settings.locale}
          onChange={(e) => {
            const locale = e.target.value as Locale;
            update({ locale });
            setLocale(locale); // App remounts the tree with the new strings
          }}
        >
          {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
            <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
          ))}
        </select>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t("settings.githubSection")}</div>

        <label className="settings-label">{t("settings.clientId")}</label>
        <input
          className="settings-input"
          value={settings.githubClientId}
          onChange={(e) => update({ githubClientId: e.target.value })}
        />
      </div>
    </div>
  );
}
