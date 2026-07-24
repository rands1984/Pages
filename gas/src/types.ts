export interface TranscriptEntry {
  time: string;
  speaker: string;
  text: string;
}

export interface SummarizeRequest {
  action: 'summarize';
  interval: number;
  transcript: TranscriptEntry[];
}

export interface SaveRequest {
  action: 'save';
  interval: number;
  transcript: TranscriptEntry[];
  mode: 'web' | 'inperson';
  sttProvider: 'speechmatics' | 'deepgram';
  summaryInterval: number;
}

export type GasRequest = SummarizeRequest | SaveRequest;

export interface GasResponse {
  status: 'success' | 'error';
  summary?: string;
  markdown?: string;
  error?: string;
}

export interface MeetingMetadata {
  date: string;
  type: 'web' | 'inperson';
  mode: 'Web会議' | '対面';
  sttProvider: 'Speechmatics' | 'Deepgram';
  summaryInterval: number;
}

export interface ObsidianMarkdown {
  frontmatter: {
    date: string;
    type: 'meeting-note';
    mode: 'Web会議' | '対面';
  };
  content: string;
}

export interface SpeakerConfig {
  micLabel: string;
  cableLabel: string;
}

export const DEFAULT_SPEAKER_CONFIG: SpeakerConfig = {
  micLabel: '自分',
  cableLabel: '相手',
};