import type { Mode, SpeakerConfig } from './types';

export interface AudioStreamCallbacks {
  onAudioData: (audioData: Float32Array, channel: 'mic' | 'cable') => void;
  onError: (error: Error) => void;
  onDevicesChanged: () => void;
}

export class AudioManager {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private cableStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private cableSource: MediaStreamAudioSourceNode | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private cableProcessor: ScriptProcessorNode | null = null;
  private callbacks: AudioStreamCallbacks | null = null;
  private mode: Mode = 'web';
  private isRecording = false;
  private devicesChangedHandler: (() => void) | null = null;
  private isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  async initialize(
    mode: Mode,
    callbacks: AudioStreamCallbacks
  ): Promise<void> {
    this.mode = mode;
    this.callbacks = callbacks;

    // AudioContextは初回ユーザー操作時まで作成しない
    // ここで devicechange イベントだけ登録
    this.devicesChangedHandler = () => {
      this.callbacks?.onDevicesChanged();
    };
    navigator.mediaDevices.addEventListener('devicechange', this.devicesChangedHandler);
  }

  /**
   * AudioContext を確実に作成・resume する（初回録音開始時に呼ばれる）
   */
  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({
        sampleRate: 16000,
      });
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  async getInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  async startRecording(
    micDeviceId?: string,
    cableDeviceId?: string
  ): Promise<void> {
    if (this.isRecording) return;

    try {
      // ここで初めて AudioContext 作成・resume
      await this.ensureAudioContext();

      // 権限状態事前チェック
      try {
        const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        this.callbacks?.onError(new Error(`マイク権限状態: ${perm.state}`));
        if (perm.state === 'denied') {
          throw new Error('Permission denied: ブラウザ設定でマイクがブロックされています');
        }
      } catch (permErr) {
        // 権限API未対応時は無視
        console.warn('Permission query failed:', permErr);
      }

      // マイク制約（緩和版：exact除去、sampleRateをidealに）
      const micConstraints: MediaStreamConstraints = {
        audio: {
          deviceId: micDeviceId ? { ideal: micDeviceId } : undefined,
          channelCount: 1,
          sampleRate: { ideal: 16000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };
      
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
      } catch (micErr) {
        // フォールバック：最小制約で再試行
        const fallbackConstraints: MediaStreamConstraints = {
          audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true
        };
        this.callbacks?.onError(new Error(`マイク制約エラー、フォールバック試行: ${micErr instanceof Error ? micErr.message : String(micErr)}`));
        this.micStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      }

      // Web会議モードかつモバイルでない場合のみ cableStream 取得
      // モバイルには VB-Cable がないためスキップ
      if (this.mode === 'web' && !this.isMobile) {
        const cableConstraints: MediaStreamConstraints = {
          audio: {
            deviceId: cableDeviceId ? { ideal: cableDeviceId } : undefined,
            channelCount: 1,
            sampleRate: { ideal: 16000 },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        };
        
        try {
          this.cableStream = await navigator.mediaDevices.getUserMedia(cableConstraints);
        } catch (cableErr) {
          const fallbackConstraints: MediaStreamConstraints = {
            audio: cableDeviceId ? { deviceId: { ideal: cableDeviceId } } : true
          };
          this.callbacks?.onError(new Error(`VB-Cable制約エラー、フォールバック試行: ${cableErr instanceof Error ? cableErr.message : String(cableErr)}`));
          this.cableStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        }
      } else if (this.mode === 'web' && this.isMobile) {
        // モバイルでWeb会議モードの場合は警告
        this.callbacks?.onError(new Error('モバイルではVB-Cableが使用できません。マイクのみで録音します。'));
      }

      this.micSource = this.audioContext!.createMediaStreamSource(this.micStream);
      await this.createProcessorNode(this.micSource, 'mic');

      if (this.mode === 'web' && this.cableStream && !this.isMobile) {
        this.cableSource = this.audioContext!.createMediaStreamSource(this.cableStream);
        await this.createProcessorNode(this.cableSource, 'cable');
      }

      this.isRecording = true;
    } catch (err) {
      this.callbacks?.onError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private async createProcessorNode(
    source: MediaStreamAudioSourceNode,
    channel: 'mic' | 'cable'
  ): Promise<void> {
    const ctx = this.audioContext!;

    // AudioWorklet (Blob URL) を完全に削除し、ScriptProcessorNode のみ使用
    // GAS環境・モバイルでのBlob URL制限を回避
    const bufferSize = 4096;
    const node = ctx.createScriptProcessor(bufferSize, 1, 1);
    node.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      this.callbacks?.onAudioData(new Float32Array(inputData), channel);
    };
    source.connect(node).connect(ctx.destination);

    if (channel === 'mic') {
      this.micProcessor = node;
    } else {
      this.cableProcessor = node;
    }
  }

  stopRecording(): void {
    if (!this.isRecording) return;

    this.isRecording = false;

    this.micProcessor?.disconnect();
    this.cableProcessor?.disconnect();
    this.micSource?.disconnect();
    this.cableSource?.disconnect();

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.cableStream?.getTracks().forEach((t) => t.stop());

    this.micStream = null;
    this.cableStream = null;
    this.micSource = null;
    this.cableSource = null;
    this.micProcessor = null;
    this.cableProcessor = null;
  }

  dispose(): void {
    this.stopRecording();
    this.audioContext?.close();
    this.audioContext = null;
    if (this.devicesChangedHandler) {
      navigator.mediaDevices.removeEventListener('devicechange', this.devicesChangedHandler);
    }
  }

  getIsRecording(): boolean {
    return this.isRecording;
  }

  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }

  isMobileDevice(): boolean {
    return this.isMobile;
  }
}

export function floatToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}

export function pcm16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function floatToBase64Pcm16(float32: Float32Array): string {
  return pcm16ToBase64(floatToPcm16(float32));
}