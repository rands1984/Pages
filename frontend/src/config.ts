import { DEFAULT_SPEAKER_CONFIG, type AppConfig, type SpeakerConfig, type Mode, type SttProvider, type SummaryInterval } from './types';

const STORAGE_KEY = 'transcription-tool-config';

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'web',
  sttProvider: 'speechmatics',
  summaryInterval: 3,
  speakerConfig: DEFAULT_SPEAKER_CONFIG,
};

export function loadConfig(): AppConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_CONFIG, ...parsed, speakerConfig: { ...DEFAULT_SPEAKER_CONFIG, ...parsed.speakerConfig } };
    }
  } catch {
    // 無視してデフォルト返却
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const merged = {
    ...current,
    ...config,
    speakerConfig: { ...current.speakerConfig, ...config.speakerConfig },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function resetConfig(): AppConfig {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULT_CONFIG };
}

export function updateSpeakerConfig(speakerConfig: Partial<SpeakerConfig>): SpeakerConfig {
  const current = loadConfig();
  const merged = { ...current.speakerConfig, ...speakerConfig };
  saveConfig({ speakerConfig: merged });
  return merged;
}

export function setMode(mode: Mode): void {
  saveConfig({ mode });
}

export function setSttProvider(provider: SttProvider): void {
  saveConfig({ sttProvider: provider });
}

export function setSummaryInterval(interval: SummaryInterval): void {
  saveConfig({ summaryInterval: interval });
}

export function setDeviceIds(micDeviceId?: string, cableDeviceId?: string): void {
  saveConfig({ micDeviceId, cableDeviceId });
}