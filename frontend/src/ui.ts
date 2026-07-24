import type { AppConfig, TranscriptEntry, SpeakerConfig, Mode, SttProvider, SummaryInterval } from './types';
import { loadConfig, saveConfig, setMode, setSttProvider, setSummaryInterval, updateSpeakerConfig, setDeviceIds, resetConfig, DEFAULT_CONFIG } from './config';

type ViewMode = 'compact' | 'expanded';

interface UiCallbacks {
  onStartRecording: () => void;
  onStopRecording: () => void;
  onConfigChange: (config: Partial<AppConfig>) => void;
  onManualSummarize: () => void;
  onSave: () => void;
  onDeviceRefresh: () => void;
}

export class UiManager {
  private container: HTMLElement;
  private callbacks: UiCallbacks;
  private config: AppConfig;
  private viewMode: ViewMode = 'expanded';
  private isRecording = false;
  private devices: MediaDeviceInfo[] = [];

  private elements: Record<string, HTMLElement | null> = {};

  constructor(container: HTMLElement, callbacks: UiCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.config = loadConfig();
    this.render();
    this.bindEvents();
    this.updateDeviceSelects();
  }

  private render(): void {
    // 既存の .app-container のみ置換（metaタグ等は残す）
    let appContainer = this.container.querySelector('.app-container') as HTMLElement;
    if (!appContainer) {
      appContainer = document.createElement('div');
      appContainer.className = 'app-container';
      this.container.appendChild(appContainer);
    }

    appContainer.innerHTML = `
      <div class="app-container" data-view="${this.viewMode}">
        <!-- Control Panel -->
        <header class="control-panel">
          <div class="panel-row">
            <button id="btn-record" class="btn btn-record" aria-label="録音開始/停止">
              <span class="record-icon">●</span>
              <span class="record-text">録音開始</span>
            </button>
            <div class="mode-toggle" role="radiogroup" aria-label="モード選択">
              <label class="mode-option">
                <input type="radio" name="mode" value="web" ${this.config.mode === 'web' ? 'checked' : ''}>
                <span>Web会議</span>
              </label>
              <label class="mode-option">
                <input type="radio" name="mode" value="inperson" ${this.config.mode === 'inperson' ? 'checked' : ''}>
                <span>対面</span>
              </label>
            </div>
          </div>

          <div class="panel-row" id="device-row" style="display: ${this.config.mode === 'web' ? 'flex' : 'none'};">
            <select id="mic-select" class="device-select" aria-label="マイク選択">
              <option value="">マイク: 自動</option>
            </select>
            <select id="cable-select" class="device-select" aria-label="VB-Cable選択">
              <option value="">VB-Cable: 自動</option>
            </select>
            <button id="btn-refresh-devices" class="btn btn-icon" aria-label="デバイス再読み込み">↻</button>
          </div>

          <div class="panel-row settings-row">
            <select id="stt-select" class="setting-select" aria-label="STTエンジン">
              <option value="speechmatics" ${this.config.sttProvider === 'speechmatics' ? 'selected' : ''}>Speechmatics</option>
              <option value="deepgram" ${this.config.sttProvider === 'deepgram' ? 'selected' : ''}>Deepgram</option>
            </select>
            <select id="interval-select" class="setting-select" aria-label="要約間隔">
              <option value="1" ${this.config.summaryInterval === 1 ? 'selected' : ''}>1分</option>
              <option value="3" ${this.config.summaryInterval === 3 ? 'selected' : ''}>3分</option>
              <option value="5" ${this.config.summaryInterval === 5 ? 'selected' : ''}>5分</option>
            </select>
          </div>

          <div class="panel-row speaker-row">
            <input type="text" id="mic-label" class="speaker-input" placeholder="自分" value="${this.config.speakerConfig.micLabel}" aria-label="自分側ラベル">
            <span class="speaker-sep">/</span>
            <input type="text" id="cable-label" class="speaker-input" placeholder="相手" value="${this.config.speakerConfig.cableLabel}" aria-label="相手側ラベル">
          </div>

          <div class="panel-row action-row">
            <button id="btn-summarize" class="btn btn-secondary" aria-label="手動要約">要約</button>
            <button id="btn-save" class="btn btn-primary" aria-label="保存">保存</button>
            <button id="btn-clear" class="btn btn-ghost" aria-label="クリア">クリア</button>
            <button id="btn-toggle-view" class="btn btn-icon" aria-label="ビュー切替">⛶</button>
            <button id="btn-debug" class="btn btn-ghost" aria-label="デバッグテスト" style="margin-left:8px;">🐛</button>
            <button id="btn-perm-check" class="btn btn-ghost" aria-label="マイク権限確認・再要求" style="margin-left:8px;">🔐</button>
            <button id="btn-mic-test" class="btn btn-ghost" aria-label="マイク直接テスト（権限チェックなし）" style="margin-left:8px;">🎤</button>
          </div>

          <div class="status-bar">
            <span id="status-text" class="status-text">待機中</span>
            <span id="connection-status" class="status-indicator disconnected">切断</span>
          </div>
        </header>

        <!-- Summary Area -->
        <section class="summary-area" aria-label="リアルタイム要約">
          <div class="area-header">
            <h2>リアルタイム要約</h2>
            <span class="area-toggle summary-meta" id="summary-meta"></span>
          </div>
          <div class="area-content">
            <div id="summary-content" class="summary-content">
              <p class="placeholder">録音開始後に要約が表示されます</p>
            </div>
          </div>
        </section>

        <!-- Timeline Area -->
        <section class="timeline-area" aria-label="文字起こしタイムライン">
          <div class="area-header">
            <h2>文字起こしログ</h2>
          </div>
          <div class="area-content">
            <div id="timeline-content" class="timeline-content">
              <p class="placeholder">発言がここに表示されます</p>
            </div>
          </div>
        </section>

        <!-- Toast Container -->
        <div id="toast-container" class="toast-container" aria-live="polite"></div>
      </div>
    `;

    this.cacheElements();
    this.applyConfigToUi();
  }

  private cacheElements(): void {
    const ids = [
      'btn-record', 'btn-summarize', 'btn-save', 'btn-clear', 'btn-toggle-view', 'btn-refresh-devices',
      'btn-debug', 'btn-perm-check', 'btn-mic-test',
      'mic-select', 'cable-select', 'stt-select', 'interval-select',
      'mic-label', 'cable-label',
      'summary-content', 'timeline-content',
      'status-text', 'connection-status',
      'toast-container', 'device-row', 'speaker-row'
    ];
    for (const id of ids) {
      this.elements[id] = this.container.querySelector('#' + id);
    }
  }

  private bindEvents(): void {
    // 録音ボタン
    this.elements['btn-record']?.addEventListener('click', () => {
      if (this.isRecording) {
        this.callbacks.onStopRecording();
      } else {
        this.callbacks.onStartRecording();
      }
    });

    // モード切替
    this.container.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        this.setMode(target.value as Mode);
      });
    });

    // STT選択
    this.elements['stt-select']?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      this.callbacks.onConfigChange({ sttProvider: target.value as SttProvider });
    });

    // 要約間隔
    this.elements['interval-select']?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      this.callbacks.onConfigChange({ summaryInterval: parseInt(target.value) as SummaryInterval });
    });

    // 話者ラベル
    this.elements['mic-label']?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      this.callbacks.onConfigChange({ speakerConfig: { micLabel: target.value } });
    });
    this.elements['cable-label']?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      this.callbacks.onConfigChange({ speakerConfig: { cableLabel: target.value } });
    });

    // デバイス選択
    this.elements['mic-select']?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      this.callbacks.onConfigChange({ micDeviceId: target.value || undefined });
    });
    this.elements['cable-select']?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      this.callbacks.onConfigChange({ cableDeviceId: target.value || undefined });
    });

    // デバイス再読み込み
    this.elements['btn-refresh-devices']?.addEventListener('click', () => {
      this.callbacks.onDeviceRefresh();
    });

    // 手動要約
    this.elements['btn-summarize']?.addEventListener('click', () => {
      this.callbacks.onManualSummarize();
    });

    // 保存
    this.elements['btn-save']?.addEventListener('click', () => {
      this.callbacks.onSave();
    });

    // クリア
    this.elements['btn-clear']?.addEventListener('click', () => {
      this.clearTimeline();
      this.clearSummary();
    });

    // ビュー切替
    this.elements['btn-toggle-view']?.addEventListener('click', () => {
      this.toggleView();
    });

    // デバッグボタン
    this.elements['btn-debug']?.addEventListener('click', () => {
      this.showToast('JS実行OK: ' + new Date().toLocaleTimeString(), 'success');
      console.log('[DEBUG] Button click works');
    });

    // 権限チェックボタン
    this.elements['btn-perm-check']?.addEventListener('click', async () => {
      try {
        const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        this.showToast(`マイク権限: ${perm.state}`, perm.state === 'granted' ? 'success' : 'error', 10000);
      } catch (e) {
        this.showToast('権限API未対応', 'info', 5000);
      }
    });

    // マイク直接テストボタン（権限チェックなし、直接getUserMedia）
    this.elements['btn-mic-test']?.addEventListener('click', async () => {
      try {
        this.showToast('マイクアクセス要求中...', 'info', 5000);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        this.showToast('✅ マイクアクセス成功！ストリーム取得完了', 'success', 10000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.showToast(`❌ マイクアクセス失敗: ${msg}`, 'error', 15000);
      }
    });
  }

  private applyConfigToUi(): void {
    // モード
    const modeRadios = this.container.querySelectorAll('input[name="mode"]');
    modeRadios.forEach((radio) => {
      (radio as HTMLInputElement).checked = (radio as HTMLInputElement).value === this.config.mode;
    });

    // デバイス行表示制御
    const deviceRow = this.elements['device-row'] as HTMLElement;
    if (deviceRow) {
      deviceRow.style.display = this.config.mode === 'web' ? 'flex' : 'none';
    }

    // STT
    const sttSelect = this.elements['stt-select'] as HTMLSelectElement;
    if (sttSelect) sttSelect.value = this.config.sttProvider;

    // 間隔
    const intervalSelect = this.elements['interval-select'] as HTMLSelectElement;
    if (intervalSelect) intervalSelect.value = String(this.config.summaryInterval);

    // 話者ラベル
    const micLabel = this.elements['mic-label'] as HTMLInputElement;
    const cableLabel = this.elements['cable-label'] as HTMLInputElement;
    if (micLabel) micLabel.value = this.config.speakerConfig.micLabel;
    if (cableLabel) cableLabel.value = this.config.speakerConfig.cableLabel;

    // デバイス選択
    const micSelect = this.elements['mic-select'] as HTMLSelectElement;
    const cableSelect = this.elements['cable-select'] as HTMLSelectElement;
    if (micSelect && this.config.micDeviceId) micSelect.value = this.config.micDeviceId;
    if (cableSelect && this.config.cableDeviceId) cableSelect.value = this.config.cableDeviceId;
  }

  private setMode(mode: Mode): void {
    this.config = { ...this.config, mode };
    saveConfig({ mode });
    this.callbacks.onConfigChange({ mode });

    const deviceRow = this.elements['device-row'] as HTMLElement;
    if (deviceRow) {
      deviceRow.style.display = mode === 'web' ? 'flex' : 'none';
    }

    if (mode === 'inperson') {
      this.callbacks.onConfigChange({ micDeviceId: undefined, cableDeviceId: undefined });
    }
  }

  private toggleView(): void {
    this.viewMode = this.viewMode === 'expanded' ? 'compact' : 'expanded';
    const appContainer = this.container.querySelector('.app-container');
    if (appContainer) {
      appContainer.setAttribute('data-view', this.viewMode);
    }
  }

  // ===== Public API =====

  setRecordingState(recording: boolean): void {
    this.isRecording = recording;
    const btn = this.elements['btn-record'] as HTMLButtonElement;
    if (btn) {
      btn.classList.toggle('recording', recording);
      const icon = btn.querySelector('.record-icon');
      const text = btn.querySelector('.record-text');
      if (icon) icon.textContent = recording ? '■' : '●';
      if (text) text.textContent = recording ? '録音停止' : '録音開始';
    }
    this.updateStatus(recording ? '録音中...' : '待機中');
  }

  updateStatus(text: string): void {
    const el = this.elements['status-text'];
    if (el) el.textContent = text;
  }

  setConnectionStatus(connected: boolean): void {
    const el = this.elements['connection-status'];
    if (el) {
      el.textContent = connected ? '接続中' : '切断';
      el.classList.toggle('connected', connected);
      el.classList.toggle('disconnected', !connected);
    }
  }

  addTranscript(entry: TranscriptEntry): void {
    const container = this.elements['timeline-content'];
    if (!container) return;

    const placeholder = container.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    const isMe = entry.speaker === this.config.speakerConfig.micLabel;
    const isOther = entry.speaker === this.config.speakerConfig.cableLabel;
    div.className = `transcript-entry ${isMe ? 'speaker-me' : (isOther ? 'speaker-other' : 'speaker-a')}`;
    if (!entry.isFinal) div.classList.add('interim');

    div.innerHTML = `
      <div class="transcript-header">
        <span class="transcript-time">[${entry.time}]</span>
        <span class="transcript-speaker">${this.escapeHtml(entry.speaker)}</span>
      </div>
      <div class="transcript-text">${this.escapeHtml(entry.text)}</div>
    `;

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  updateTranscript(entry: TranscriptEntry): void {
    const container = this.elements['timeline-content'];
    if (!container) return;

    const entries = container.querySelectorAll('.transcript-entry.interim');
    const lastInterim = entries[entries.length - 1] as HTMLElement;
    if (lastInterim) {
      const textEl = lastInterim.querySelector('.transcript-text');
      if (textEl) textEl.textContent = this.escapeHtml(entry.text);
      if (entry.isFinal) lastInterim.classList.remove('interim');
    }
  }

  setSummary(text: string): void {
    const container = this.elements['summary-content'];
    if (!container) return;

    const placeholder = container.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    container.innerHTML = this.formatSummary(text);
  }

  appendSummary(text: string): void {
    const container = this.elements['summary-content'];
    if (!container) return;
    container.innerHTML += '\n\n' + this.formatSummary(text);
    container.scrollTop = container.scrollHeight;
  }

  private formatSummary(text: string): string {
    return text
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');
  }

  clearTimeline(): void {
    const container = this.elements['timeline-content'];
    if (container) {
      container.innerHTML = '<p class="placeholder">発言がここに表示されます</p>';
    }
  }

  clearSummary(): void {
    const container = this.elements['summary-content'];
    if (container) {
      container.innerHTML = '<p class="placeholder">録音開始後に要約が表示されます</p>';
    }
  }

  updateDevices(devices: MediaDeviceInfo[]): void {
    this.devices = devices;
    this.updateDeviceSelects();
  }

  private updateDeviceSelects(): void {
    const micSelect = this.elements['mic-select'] as HTMLSelectElement;
    const cableSelect = this.elements['cable-select'] as HTMLSelectElement;
    if (!micSelect || !cableSelect) return;

    const micValue = micSelect.value;
    const cableValue = cableSelect.value;

    const micOptions = ['<option value="">マイク: 自動</option>'];
    const cableOptions = ['<option value="">VB-Cable: 自動</option>'];

    for (const device of this.devices) {
      const opt = `<option value="${device.deviceId}">${device.label || `マイク (${device.deviceId.slice(0, 8)}...)`}</option>`;
      micOptions.push(opt);
      cableOptions.push(opt);
    }

    micSelect.innerHTML = micOptions.join('');
    cableSelect.innerHTML = cableOptions.join('');
    if (micValue) micSelect.value = micValue;
    if (cableValue) cableSelect.value = cableValue;
  }

  getConfig(): AppConfig {
    return { ...this.config };
  }

  getMicDeviceId(): string | undefined {
    return this.config.micDeviceId;
  }

  getCableDeviceId(): string | undefined {
    return this.config.cableDeviceId;
  }

  getSpeakerConfig(): SpeakerConfig {
    return { ...this.config.speakerConfig };
  }

  showToast(message: string, type: 'info' | 'success' | 'error' = 'info', duration: number = 10000): void {
    const container = this.elements['toast-container'];
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  getSummaryText(): string {
    return this.elements['summary-content']?.textContent || '';
  }

  destroy(): void {
    // クリーンアップ
  }
}