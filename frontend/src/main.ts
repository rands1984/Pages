import { loadConfig, saveConfig } from './config';
import { AudioManager, floatToBase64Pcm16 } from './audio';
import { SttWebSocket } from './websocket';
import { requestSummarize, requestSave, setGasApiUrl, getGasClient } from './gas';
import { UiManager } from './ui';
import type {
  AppConfig, TranscriptEntry, SpeakerConfig, Mode, SttProvider, SummaryInterval,
  SummarizeRequest, SaveRequest
} from './types';
import './css/style.css';

// ========================================
// メインアプリケーションクラス
// ========================================

class TranscriptionApp {
  private ui: UiManager;
  private audioManager: AudioManager;
  private sttWs: SttWebSocket | null = null;
  private config: AppConfig;
  private transcript: TranscriptEntry[] = [];
  private summaryTimer: number | null = null;
  private isRecording = false;
  private gasApiUrl = '';

  constructor() {
    this.config = loadConfig();
    this.gasApiUrl = this.config.gasApiUrl || '';
    
    // metaタグから GAS API URL 取得（本番では手動設定）
    const metaUrl = document.querySelector('meta[name="gas-api-url"]')?.content;
    if (metaUrl && metaUrl !== '<%= apiUrl %>') {
      this.gasApiUrl = metaUrl;
    }
    
    // 本番環境用：デフォルト GAS API URL（環境変数で上書き可能）
    if (!this.gasApiUrl) {
      this.gasApiUrl = 'https://script.google.com/macros/s/AKfycbxmK2XPK3DW7ftvQ7X0U0-8MSadiZfhuuihtiYq1g-pVc5u-De2rKyvKHvyEzCyxvK6dw/exec';
    }
    
    if (this.gasApiUrl) {
      setGasApiUrl(this.gasApiUrl);
    }

    // UI初期化
    this.ui = new UiManager(document.body, {
      onStartRecording: () => this.startRecording(),
      onStopRecording: () => this.stopRecording(),
      onConfigChange: (changes) => this.handleConfigChange(changes),
      onManualSummarize: () => this.manualSummarize(),
      onSave: () => this.save(),
      onDeviceRefresh: () => this.refreshDevices(),
    });

    // AudioManager初期化
    this.audioManager = new AudioManager();

    // 初期化
    this.initialize();
  }

  private async initialize(): Promise<void> {
      try {
        // GAS API URL が未設定ならデフォルト使用
        if (!this.gasApiUrl) {
          this.gasApiUrl = 'https://script.google.com/macros/s/AKfycbxmK2XPK3DW7ftvQ7X0U0-8MSadiZfhuuihtiYq1g-pVc5u-De2rKyvKHvyEzCyxvK6dw/exec';
          setGasApiUrl(this.gasApiUrl);
        }
      
        // window.GAS_API_URL も確認（UiManagerが設定する可能性）
        if (!this.gasApiUrl && (window as any).GAS_API_URL) {
          this.gasApiUrl = (window as any).GAS_API_URL;
          setGasApiUrl(this.gasApiUrl);
        }

        // デバイス列挙
        await this.refreshDevices();

        // AudioContext初期化
        await this.audioManager.initialize(
          this.config.mode,
          {
            onAudioData: (data, channel) => this.onAudioData(data, channel),
            onError: (err) => this.onAudioError(err),
            onDevicesChanged: () => this.refreshDevices(),
          }
        );

        // UIにデバイス反映
        this.ui.updateDevices(await this.audioManager.getInputDevices());

        this.updateStatus('準備完了');
      } catch (err) {
        this.onAudioError(err instanceof Error ? err : new Error(String(err)));
      }
    }

  // ========================================
  // 設定変更ハンドラ
  // ========================================

  private handleConfigChange(changes: Partial<AppConfig>): void {
    this.config = { ...this.config, ...changes };
    if (changes.speakerConfig) {
      this.config.speakerConfig = { ...this.config.speakerConfig, ...changes.speakerConfig };
    }
    saveConfig(this.config);

    // STTプロバイダ変更時は再接続
    if (changes.sttProvider && this.sttWs) {
      this.reconnectStt();
    }

    // モード変更時
    if (changes.mode) {
      this.handleModeChange(changes.mode);
    }

    // 要約間隔変更時
    if (changes.summaryInterval) {
      this.restartSummaryTimer();
    }
  }

  private handleModeChange(mode: Mode): void {
    this.config.mode = mode;
    // Web会議モード以外ではデバイスIDリセット
    if (mode === 'inperson') {
      this.config.micDeviceId = undefined;
      this.config.cableDeviceId = undefined;
      saveConfig({ micDeviceId: undefined, cableDeviceId: undefined });
    }
    // AudioManager再初期化が必要だが、録音中でなければ即適用
    if (!this.isRecording) {
      this.audioManager.dispose();
      this.audioManager = new AudioManager();
      this.initializeAudio();
    }
  }

  private async initializeAudio(): Promise<void> {
    await this.audioManager.initialize(
      this.config.mode,
      {
        onAudioData: (data, channel) => this.onAudioData(data, channel),
        onError: (err) => this.onAudioError(err),
        onDevicesChanged: () => this.refreshDevices(),
      }
    );
    this.ui.updateDevices(await this.audioManager.getInputDevices());
  }

  // ========================================
  // デバイス管理
  // ========================================

  private async refreshDevices(): Promise<void> {
    try {
      const devices = await this.audioManager.getInputDevices();
      this.ui.updateDevices(devices);
    } catch (err) {
      this.ui.showToast('デバイス取得エラー: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }

  // ========================================
  // 録音制御
  // ========================================

  private async startRecording(): Promise<void> {
    if (this.isRecording) return;

    if (!this.gasApiUrl) {
      this.ui.showToast('GAS API URLが未設定です', 'error');
      return;
    }

    // ★即座にUIフィードバック：ボタン無効化＋トースト
    this.ui.setRecordingState(true);
    this.ui.showToast('マイクアクセス中...', 'info');

    try {
      this.updateStatus('マイクアクセス中...');
      await this.audioManager.startRecording(
        this.config.micDeviceId,
        this.config.cableDeviceId
      );

      // STT WebSocket接続
      await this.connectStt();

      // 要約タイマー開始
      this.startSummaryTimer();

      this.isRecording = true;
      this.transcript = [];
      this.ui.setRecordingState(true);
      this.ui.setConnectionStatus(true);
      this.ui.clearTimeline();
      this.ui.clearSummary();
      this.updateStatus('録音中...');
      this.ui.showToast('録音を開始しました', 'success');
    } catch (err) {
      // ★エラー時は即座にUI戻し＋トースト
      this.isRecording = false;
      this.ui.setRecordingState(false);
      this.ui.setConnectionStatus(false);
      this.updateStatus('待機中');
      this.onAudioError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private stopRecording(): void {
    if (!this.isRecording) return;

    this.isRecording = false;
    this.audioManager.stopRecording();
    this.disconnectStt();
    this.stopSummaryTimer();

    // 最終要約・保存
    this.finalizeRecording();

    this.ui.setRecordingState(false);
    this.ui.setConnectionStatus(false);
    this.updateStatus('停止しました');
    this.ui.showToast('録音を停止しました', 'info');
  }

  private async finalizeRecording(): Promise<void> {
    // 最終要約生成
    await this.manualSummarize();

    // 保存実行
    await this.save();
  }

  // ========================================
  // STT WebSocket
  // ========================================

  private async connectStt(): Promise<void> {
    if (this.sttWs) return;

    this.sttWs = new SttWebSocket(
      this.config.sttProvider,
      {
        onTranscript: (entry) => this.onTranscript(entry),
        onError: (err) => this.onSttError(err),
        onOpen: () => this.ui.setConnectionStatus(true),
        onClose: (code, reason) => {
          this.ui.setConnectionStatus(false);
          if (!this.isRecording && code !== 1000) {
            this.ui.showToast(`STT切断: ${reason} (${code})`, 'error');
          }
        },
      },
      this.config.speakerConfig
    );

    // トークン取得 (Speechmaticsの場合)
    let token: string | undefined;
    if (this.config.sttProvider === 'speechmatics') {
      const client = getGasClient();
      try {
        const resp = await fetch(`${this.gasApiUrl}?action=stt_token&provider=speechmatics`);
        const data = await resp.json();
        if (data.token) token = data.token;
      } catch {
        // トークン取得失敗時はなしで接続
      }
    }

    await this.sttWs.connect(token);
  }

  private disconnectStt(): void {
    this.sttWs?.close();
    this.sttWs = null;
  }

  private reconnectStt(): void {
    if (!this.isRecording) return;
    this.disconnectStt();
    this.connectStt();
  }

  // ========================================
  // 音声データ処理
  // ========================================

  private onAudioData(float32: Float32Array, channel: 'mic' | 'cable'): void {
    if (!this.isRecording || !this.sttWs?.isConnected()) return;

    const base64 = floatToBase64Pcm16(float32);
    this.sttWs.sendAudio(base64);
  }

  private onAudioError(err: Error): void {
    const msg = err.message;
    let friendlyMsg = '音声エラー: ' + msg;
    
    // 権限エラーの場合、詳細ガイダンス
    if (msg.includes('Permission denied') || msg.includes('permission denied') || 
        msg.includes('NotAllowedError') || msg.includes('not allowed')) {
      friendlyMsg = '🎤 マイク権限が拒否されました。\n' +
        '• ブラウザのアドレスバー左🔒→「マイク」を「許可」に\n' +
        '• Android設定→アプリ→ブラウザ→権限→マイク「許可」\n' +
        '• 再読み込み後に再試行してください';
    } else if (msg.includes('NotFoundError') || msg.includes('not found')) {
      friendlyMsg = '🎤 マイクデバイスが見つかりません。\n' +
        '• デバイス接続確認\n' +
        '• Web会議モードならVB-Cable接続確認\n' +
        '• デバイス再読み込み(↻)ボタンで再試行';
    } else if (msg.includes('NotReadableError') || msg.includes('in use')) {
      friendlyMsg = '🎤 マイクが他アプリで使用中です。\n' +
        '• 他の会議アプリ/録音アプリを閉じる\n' +
        '• ブラウザタブを閉じて再開';
    }
    
    this.ui.showToast(friendlyMsg, 'error', 15000);
    if (this.isRecording) {
      this.stopRecording();
    }
  }

  // ========================================
  // 文字起こし受信
  // ========================================

  private onTranscript(entry: TranscriptEntry): void {
    // 既存の暫定結果を置き換えるか、新規追加
    const existingIndex = this.transcript.findIndex(
      (t) => !t.isFinal && t.speaker === entry.speaker
    );

    if (existingIndex >= 0) {
      this.transcript[existingIndex] = entry;
      this.ui.updateTranscript(entry);
    } else {
      this.transcript.push(entry);
      this.ui.addTranscript(entry);
    }
  }

  private onSttError(err: Error): void {
    this.ui.showToast('STTエラー: ' + err.message, 'error');
  }

  // ========================================
  // 要約・保存
  // ========================================

  private startSummaryTimer(): void {
    this.stopSummaryTimer();
    const intervalMs = this.config.summaryInterval * 60 * 1000;
    this.summaryTimer = window.setInterval(() => {
      this.manualSummarize();
    }, intervalMs);
  }

  private stopSummaryTimer(): void {
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  private restartSummaryTimer(): void {
    if (this.isRecording) {
      this.startSummaryTimer();
    }
  }

  private async manualSummarize(): Promise<void> {
    const finalTranscript = this.transcript.filter((t) => t.isFinal);
    if (finalTranscript.length === 0) return;

    try {
      const result = await requestSummarize(
        finalTranscript,
        this.config.summaryInterval,
        this.config.mode,
        this.config.speakerConfig
      );

      if (result.summary) {
        this.ui.setSummary(result.summary);
      } else if (result.error) {
        this.ui.showToast('要約エラー: ' + result.error, 'error');
      }
    } catch (err) {
      this.ui.showToast('要約失敗: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }

  private async save(): Promise<void> {
    const finalTranscript = this.transcript.filter((t) => t.isFinal);
    if (finalTranscript.length === 0) {
      this.ui.showToast('保存するデータがありません', 'info');
      return;
    }

    const summary = this.ui.getSummaryText();

    try {
      const result = await requestSave(
        finalTranscript,
        summary,
        this.config.mode,
        this.config.sttProvider,
        this.config.summaryInterval,
        this.config.speakerConfig
      );

      if (result.markdown) {
        this.ui.showToast('保存完了 (Dropboxにアップロード)', 'success');
      } else if (result.error) {
        this.ui.showToast('保存エラー: ' + result.error, 'error');
      }
    } catch (err) {
      this.ui.showToast('保存失敗: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }

  // ========================================
  // ユーティリティ
  // ========================================

  private updateStatus(text: string): void {
    this.ui.updateStatus(text);
  }

  // GAS API URL設定
  setGasApiUrl(url: string): void {
    this.gasApiUrl = url;
    setGasApiUrl(url);
    saveConfig({ gasApiUrl: url });
  }
}

// ========================================
// エントリーポイント
// ========================================

let app: TranscriptionApp;

document.addEventListener('DOMContentLoaded', () => {
  app = new TranscriptionApp();

  // グローバルに公開 (デバッグ用)
  (window as any).__app = app;
});

// ページ離脱時のクリーンアップ
window.addEventListener('beforeunload', () => {
  if (app) {
    // 録音中なら停止
  }
});