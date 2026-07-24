import type { GasApiResponse, SummarizeRequest, SaveRequest, TranscriptEntry, Mode } from './types';

const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec';

export interface GasClientConfig {
  apiUrl: string;
}

export class GasClient {
  private apiUrl: string;

  constructor(config: GasClientConfig) {
    this.apiUrl = config.apiUrl || DEFAULT_GAS_URL;
  }

  setApiUrl(url: string): void {
    this.apiUrl = url;
  }

  async summarize(
    transcript: TranscriptEntry[],
    interval: number,
    _mode: Mode,
    _speakerConfig: { micLabel: string; cableLabel: string }
  ): Promise<GasApiResponse> {
    const finalTranscript = transcript.filter((t) => t.isFinal);
    if (finalTranscript.length === 0) {
      return { status: 'success', summary: '' };
    }

    const request: SummarizeRequest = {
      action: 'summarize',
      interval,
      transcript: finalTranscript.map((t) => ({
        time: t.time,
        speaker: t.speaker,
        text: t.text,
      })),
    };

    return this.post(request);
  }

  async save(
    transcript: TranscriptEntry[],
    interval: number,
    mode: Mode,
    sttProvider: 'speechmatics' | 'deepgram',
    summaryInterval: number
  ): Promise<GasApiResponse> {
    const finalTranscript = transcript.filter((t) => t.isFinal);
    if (finalTranscript.length === 0) {
      return { status: 'error', error: 'No transcript data' };
    }

    const request: SaveRequest = {
      action: 'save',
      interval,
      transcript: finalTranscript.map((t) => ({
        time: t.time,
        speaker: t.speaker,
        text: t.text,
      })),
      mode,
      sttProvider,
      summaryInterval,
    };

    return this.post(request);
  }

  private async post(body: SummarizeRequest | SaveRequest): Promise<GasApiResponse> {
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          status: 'error',
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = await response.json();
      return data as GasApiResponse;
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

let gasClientInstance: GasClient | null = null;

export function getGasClient(config?: GasClientConfig): GasClient {
  if (!gasClientInstance) {
    gasClientInstance = new GasClient(config || { apiUrl: DEFAULT_GAS_URL });
  }
  return gasClientInstance;
}

export function initGasClient(config: GasClientConfig): GasClient {
  gasClientInstance = new GasClient(config);
  return gasClientInstance;
}

export function setGasApiUrl(url: string): void {
  if (gasClientInstance) {
    gasClientInstance.setApiUrl(url);
  }
}

export async function requestSummarize(
  transcript: TranscriptEntry[],
  interval: number,
  mode: 'web' | 'inperson',
  speakerConfig: { micLabel: string; cableLabel: string }
): Promise<{ summary: string } | { error: string }> {
  const client = getGasClient();
  const result = await client.summarize(transcript, interval, mode as Mode, speakerConfig);
  if (result.status === 'success') {
    return { summary: result.summary || '' };
  }
  return { error: result.error || 'Unknown error' };
}

export async function requestSave(
  transcript: TranscriptEntry[],
  _summary: string,
  mode: 'web' | 'inperson',
  sttProvider: 'speechmatics' | 'deepgram',
  summaryInterval: number,
  _speakerConfig: { micLabel: string; cableLabel: string }
): Promise<{ markdown: string } | { error: string }> {
  const client = getGasClient();
  const result = await client.save(transcript, summaryInterval, mode as Mode, sttProvider, summaryInterval);
  if (result.status === 'success') {
    return { markdown: result.markdown || '' };
  }
  return { error: result.error || 'Save failed' };
}