export type Mode = 'web' | 'inperson';
export type SttProvider = 'speechmatics' | 'deepgram';
export type SummaryInterval = 1 | 3 | 5;
export type ViewMode = 'compact' | 'expanded';

export interface SpeakerConfig {
  micLabel: string;
  cableLabel: string;
}

export interface TranscriptEntry {
  time: string;
  speaker: string;
  text: string;
  isFinal: boolean;
}

export interface AppConfig {
  mode: Mode;
  sttProvider: SttProvider;
  summaryInterval: SummaryInterval;
  speakerConfig: SpeakerConfig;
  micDeviceId?: string;
  cableDeviceId?: string;
  gasApiUrl?: string;
}

export interface SummarizeRequest {
  action: 'summarize';
  interval: number;
  transcript: Array<{ time: string; speaker: string; text: string }>;
}

export interface SaveRequest {
  action: 'save';
  interval: number;
  transcript: Array<{ time: string; speaker: string; text: string }>;
  mode: Mode;
  sttProvider: SttProvider;
  summaryInterval: number;
}

export interface GasApiResponse {
  status: 'success' | 'error';
  summary?: string;
  markdown?: string;
  error?: string;
}

export interface SttTokenResponse {
  token: string;
  wsUrl: string;
  expiresIn?: number;
}

export interface DeepgramMessage {
  type: string;
  channel?: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
  speaker?: number;
  duration?: number;
  error?: string;
}

export interface SpeechmaticsMessage {
  message: string;
  results?: Array<{
    alternatives: Array<{ content: string }>;
    is_final?: boolean;
    start_time?: number;
    speaker?: number;
  }>;
}

export const DEFAULT_SPEAKER_CONFIG: SpeakerConfig = {
  micLabel: '自分',
  cableLabel: '相手',
};

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'web',
  sttProvider: 'speechmatics',
  summaryInterval: 3,
  speakerConfig: DEFAULT_SPEAKER_CONFIG,
};