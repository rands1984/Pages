import { SttProvider, TranscriptEntry, SttTokenResponse, DeepgramMessage, SpeechmaticsMessage, AppConfig, SpeakerConfig } from './types';
import { floatToBase64Pcm16 } from './audio';

export interface SttCallbacks {
  onTranscript: (entry: TranscriptEntry) => void;
  onError: (error: Error) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
}

export class SttWebSocket {
  private ws: WebSocket | null = null;
  private provider: SttProvider;
  private callbacks: SttCallbacks;
  private speakerConfig: SpeakerConfig;
  private config: AppConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private speakerMap: Map<number, string> = new Map(); // Deepgram用: speaker番号→ラベル
  private nextSpeakerIndex = 0;
  private isClosing = false;
  private audioQueue: Float32Array[] = [];

  constructor(
    provider: SttProvider,
    config: AppConfig,
    callbacks: SttCallbacks,
    speakerConfig: SpeakerConfig
  ) {
    this.provider = provider;
    this.config = config;
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
    // Deepgram
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
      const msg = {
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
    // Deepgramはクエリパラメータで設定済み
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.handleTextMessage(data);
    } else {
      // バイナリメッセージ (STTからは通常来ない)
      console.log('[STT] Binary message received');
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
      console.error('[STT] Parse error:', err, text);
    }
  }

  private handleSpeechmaticsMessage(msg: SpeechmaticsMessage): void {
    if (msg.message === 'AddPartialTranscript' || msg.message === 'AddTranscript') {
      const results = msg.results || [];
      for (const result of results) {
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
    } else if (msg.message === 'RecognitionStarted') {
      console.log('[STT] Speechmatics recognition started');
    } else if (msg.message === 'EndOfStream') {
      console.log('[STT] Speechmatics end of stream');
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
    } else if (msg.type === 'Metadata') {
      console.log('[STT] Deepgram metadata:', msg.duration);
    } else if (msg.type === 'Error' && msg.error) {
      this.callbacks.onError(new Error(`Deepgram: ${msg.error}`));
    } else if (msg.type === 'Close') {
      console.log('[STT] Deepgram closed');
    }
  }

  private getSpeakerLabel(speakerNum: number): string {
    // 話者マッピング: 初回登場順で「話者A」「話者B」... または設定ラベル
    if (this.provider === 'speechmatics' && this.speakerConfig) {
      // Speechmatics: speaker 0 = 自分側(mic), speaker 1 = 相手側(cable) と想定
      // 実際の仕様に合わせて調整必要
      return speakerNum === 0 ? this.speakerConfig.micLabel : this.speakerConfig.cableLabel;
    }

    // Deepgram: 話者番号を順番にラベル付け
    if (!this.speakerMap.has(speakerNum)) {
      const labels = ['話者A', '話者B', '話者C', '話者D'];
      this.speakerMap.set(speakerNum, labels[this.nextSpeakerIndex] || `話者${speakerNum + 1}`);
      this.nextSpeakerIndex++;
    }
    return this.speakerMap.get(speakerNum)!;
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  sendAudio(audioData: Float32Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // キューイング
      this.audioQueue.push(audioData);
      if (this.audioQueue.length > 100) this.audioQueue.shift(); // 古いの捨て
      return;
    }

    const pcm16Base64 = floatToBase64Pcm16(audioData);

    if (this.provider === 'speechmatics') {
      const msg = {
        message: 'AddAudio',
        audio_data: pcm16Base64,
      };
      this.ws.send(JSON.stringify(msg));
    } else {
      // Deepgram: バイナリで送信
      const pcm16 = new Int16Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        const s = Math.max(-1, Math.min(1, audioData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.ws.send(pcm16.buffer);
    }
  }

  private flushAudioQueue(): void {
    while (this.audioQueue.length > 0) {
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
      this.ws.close();
      this.ws = null;
    }
  }

  getProvider(): SttProvider {
    return this.provider;
  }

  setProvider(provider: SttProvider): void {
    const wasConnected = this.ws?.readyState === WebSocket.OPEN;
    this.close();
    this.provider = provider;
    this.speakerMap.clear();
    this.nextSpeakerIndex = 0;
    if (wasConnected) {
      // 再接続は外部で制御
    }
  }
}