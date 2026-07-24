import type { SttProvider, TranscriptEntry, SpeakerConfig } from './types';

export interface SttCallbacks {
  onTranscript: (entry: TranscriptEntry) => void;
  onError: (error: Error) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
}

interface SpeechmaticsMessage {
  message: 'StartRecognition' | 'EndOfStream' | 'AddAudio' | 'SetRecognitionConfig' | 'AddPartialTranscript' | 'AddTranscript' | 'RecognitionStarted';
  audio_format?: {
    type: 'raw';
    encoding: 'pcm_s16le';
    sample_rate: number;
  };
  recognition_config?: {
    language: string;
    enable_diarization: boolean;
    diarization_config?: {
      speaker_count?: number;
    };
  };
  audio_data?: string;
  results?: Array<{
    alternatives: Array<{ content: string }>;
    is_final?: boolean;
    start_time?: number;
    speaker?: number;
  }>;
}

interface DeepgramMessage {
  type: 'LiveTranscription' | 'Metadata' | 'SpeechStarted' | 'UtteranceEnd' | 'Error' | 'Close';
  channel?: {
    alternatives: Array<{ transcript: string; confidence: number; words?: Array<{ word: string; start: number; end: number; speaker?: number }> }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
  speaker?: number;
  duration?: number;
  error?: string;
}

export class SttWebSocket {
  private ws: WebSocket | null = null;
  private provider: SttProvider;
  private callbacks: SttCallbacks;
  private speakerConfig: SpeakerConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private speakerMap: Map<number, string> = new Map();
  private nextSpeakerIndex = 0;
  private isClosing = false;
  private audioQueue: string[] = [];

  constructor(
    provider: SttProvider,
    callbacks: SttCallbacks,
    speakerConfig: SpeakerConfig
  ) {
    this.provider = provider;
    this.callbacks = callbacks;
    this.speakerConfig = speakerConfig;
  }

  async connect(token?: string): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = this.buildWsUrl(token);
    this.ws = new WebSocket(wsUrl);

    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log(`[STT] ${this.provider} connected`);
      this.reconnectAttempts = 0;
      this.sendInitialConfig();
      this.flushAudioQueue();
      this.callbacks.onOpen();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onerror = (event) => {
      console.error(`[STT] ${this.provider} error:`, event);
      this.callbacks.onError(new Error(`WebSocket error: ${this.provider}`));
    };

    this.ws.onclose = (event) => {
      console.log(`[STT] ${this.provider} closed: ${event.code} ${event.reason}`);
      if (!this.isClosing && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect(token);
      } else {
        this.callbacks.onClose(event.code, event.reason);
      }
    };
  }

  private buildWsUrl(token?: string): string {
    if (this.provider === 'speechmatics') {
      const baseUrl = 'wss://eu2.rt.speechmatics.com/v2';
      const params = new URLSearchParams();
      if (token) params.set('jwt', token);
      params.set('language', 'ja');
      params.set('diarization', 'true');
      return `${baseUrl}?${params.toString()}`;
    }
    const baseUrl = 'wss://api.deepgram.com/v1/listen';
    const params = new URLSearchParams();
    params.set('model', 'nova-2');
    params.set('language', 'ja');
    params.set('diarize', 'true');
    params.set('punctuate', 'true');
    params.set('interim_results', 'true');
    params.set('encoding', 'linear16');
    params.set('sample_rate', '16000');
    return `${baseUrl}?${params.toString()}`;
  }

  private sendInitialConfig(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.provider === 'speechmatics') {
      const msg: SpeechmaticsMessage = {
        message: 'SetRecognitionConfig',
        audio_format: {
          type: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 16000,
        },
        recognition_config: {
          language: 'ja',
          enable_diarization: true,
        },
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.handleTextMessage(data);
    }
  }

  private handleTextMessage(text: string): void {
    try {
      if (this.provider === 'speechmatics') {
        this.handleSpeechmaticsMessage(JSON.parse(text) as SpeechmaticsMessage);
      } else {
        this.handleDeepgramMessage(JSON.parse(text) as DeepgramMessage);
      }
    } catch (err) {
      console.error('[STT] Parse error:', err);
    }
  }

  private handleSpeechmaticsMessage(msg: SpeechmaticsMessage): void {
    if ((msg.message === 'AddPartialTranscript' || msg.message === 'AddTranscript') && msg.results) {
      for (const result of msg.results) {
        const alt = result.alternatives?.[0];
        if (!alt?.content) continue;

        const isFinal = msg.message === 'AddTranscript' || result.is_final === true;
        const speakerNum = result.speaker ?? 0;
        const speakerLabel = this.getSpeakerLabel(speakerNum);

        const time = this.formatTime(result.start_time ?? Date.now() / 1000);

        this.callbacks.onTranscript({
          time,
          speaker: speakerLabel,
          text: alt.content,
          isFinal,
        });
      }
    }
  }

  private handleDeepgramMessage(msg: DeepgramMessage): void {
    if (msg.type === 'LiveTranscription' && msg.channel?.alternatives?.[0]) {
      const alt = msg.channel.alternatives[0];
      const transcript = alt.transcript;
      if (!transcript) return;

      const isFinal = msg.is_final === true || msg.speech_final === true;
      const speakerNum = msg.speaker ?? 0;
      const speakerLabel = this.getSpeakerLabel(speakerNum);
      const time = this.formatTime(Date.now() / 1000);

      this.callbacks.onTranscript({
        time,
        speaker: speakerLabel,
        text: transcript,
        isFinal,
      });
    } else if (msg.type === 'Error' && msg.error) {
      this.callbacks.onError(new Error(`Deepgram: ${msg.error}`));
    }
  }

  private getSpeakerLabel(speakerNum: number): string {
    if (!this.speakerMap.has(speakerNum)) {
      const label = this.nextSpeakerIndex === 0
        ? this.speakerConfig.micLabel
        : this.nextSpeakerIndex === 1
        ? this.speakerConfig.cableLabel
        : `話者${String.fromCharCode(65 + this.nextSpeakerIndex)}`;
      this.speakerMap.set(speakerNum, label);
      this.nextSpeakerIndex++;
    }
    return this.speakerMap.get(speakerNum)!;
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  sendAudio(audioData: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.provider === 'speechmatics') {
        const msg = {
          message: 'AddAudio',
          audio_data: audioData,
        };
        this.ws.send(JSON.stringify(msg));
      } else {
        const binary = atob(audioData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        this.ws.send(bytes.buffer);
      }
    } else {
      this.audioQueue.push(audioData);
      if (this.audioQueue.length > 100) this.audioQueue.shift();
    }
  }

  private flushAudioQueue(): void {
    while (this.audioQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const data = this.audioQueue.shift()!;
      this.sendAudio(data);
    }
  }

  private scheduleReconnect(token?: string): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[STT] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(token), delay);
  }

  close(): void {
    this.isClosing = true;
    if (this.ws) {
      if (this.provider === 'speechmatics') {
        this.ws.send(JSON.stringify({ message: 'EndOfStream' }));
      }
      this.ws.close(1000, 'Client closing');
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  updateSpeakerConfig(config: SpeakerConfig): void {
    this.speakerConfig = config;
  }
}