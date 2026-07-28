// 文字起こしツール - フロントエンド メイン
// アーキテクチャ: GitHub Pages (静的) + GAS Web App (API)
export {};

type SttProvider = 'deepgram' | 'speechmatics';
type Mode = 'web' | 'inperson';

interface TranscriptEntry {
  time: string;
  speaker: string;
  text: string;
  final: boolean;
}

interface SpeakerConfig {
  micLabel: string;
  cableLabel: string;
}

// GAS API URL: LocalStorage > metaタグ > デフォルト
const STORAGE_KEY_GAS_URL = 'transcription_gas_api_url';
const KNOWN_DEAD_GAS_URLS = [
  'AKfycbxVN3iTnaUBpeuUBGLwAp7vIthoscUWeZ65hq8whzorai7ae6qn1EEh16BY4fmg8WYhuA',
  'AKfycbxXP1SKaW4BUpJTlx6nD8kntD6xWUUiTL8gYhA-vrLGXZO_dfsKJymJO7_Zl1lJK_7JwQ',
  'AKfycbxNNsqmnBRpbNc4HBtuVpJJSq_flNXz4xUECEoQ5I_vc49eLhm4lr-_5GHSC1TPCyebVA',
  'AKfycbwVBJzRHpP6qDZzMB1idcXoBu_JQhWPJm49jgLIgb26HDq7Ab44g9TfhksP0mCi-FS2Yg',
  'AKfycbwIccTWzOneK9b0yR9YqJWeJENVmCxTpoluW5MH0nlPdJKd0FIlH3XM-gCO8MnxkiW8ZQ',
];
function getGasApiUrl(): string {
  const stored = localStorage.getItem(STORAGE_KEY_GAS_URL);
  // 既知の死んだURLが保存されていたら削除（新デフォルトを使わせる）
  if (stored && KNOWN_DEAD_GAS_URLS.some((u) => stored.includes(u))) {
    localStorage.removeItem(STORAGE_KEY_GAS_URL);
  }
  const fresh = localStorage.getItem(STORAGE_KEY_GAS_URL);
  if (fresh) return fresh;
  const meta = (document.querySelector('meta[name="gas-api-url"]') as HTMLMetaElement)?.content;
  return meta || 'https://script.google.com/macros/s/AKfycbyxL77pmTc_Z89D7DD2_R10lN3zCHMeP2bbO3-fZK0p6T9VJIQueuNxVQuGXB-MptgMhw/exec';
}
let GAS_API_URL = getGasApiUrl();

// ---------- GAS API クライアント ----------
class GasClient {
  async post(action: string, body: Record<string, unknown> = {}): Promise<any> {
    let resp: Response;
    try {
      // text/plain;charset=utf-8 は CORS 簡易リクエスト対象 → プリフライト(OPTIONS)が発生せず、
      // GAS の「全員アクセス」自動CORSヘッダーがそのまま効く。charset指定を含めることで
      // 一部ブラウザが text/plain を non-simple と誤判定するのを防ぐ。
      resp = await fetch(GAS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...body }),
      });
    } catch (e) {
      throw new Error('ネットワーク/CORSエラー: ' + (e as Error).message + ' (URL: ' + GAS_API_URL + ')');
    }
    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // HTML応答(404/削除/ログインページ)を受けた場合
      const snippet = text.replace(/\s+/g, ' ').slice(0, 150);
      throw new Error('GASがJSON以外を返却(URL無効/削除/未デプロイ?): ' + snippet);
    }
    if (data.status === 'error') throw new Error(data.error || 'GAS error');
    return data;
  }

  async getSttToken(provider: SttProvider): Promise<string> {
    const data = await this.post('stt_token', { provider });
    return data.token;
  }

  async summarize(transcript: TranscriptEntry[], interval: number, prompt?: string): Promise<string> {
    const data = await this.post('summarize', { transcript, interval, prompt: prompt || '' });
    return data.summary;
  }

  async save(transcript: TranscriptEntry[], mode: Mode, sttProvider: SttProvider, summaryInterval: number, prompt?: string): Promise<{ summary: string; markdown: string; filename: string }> {
    const data = await this.post('save', { transcript, mode, sttProvider, summaryInterval, prompt: prompt || '' });
    return data;
  }
}

// ---------- STT WebSocket ----------
class SttWebSocket {
  private ws: WebSocket | null = null;
  private provider: SttProvider;
  private token: string;
  private sampleRate: number;
  private onTranscript: (entry: TranscriptEntry) => void;
  private onError: (err: Error) => void;
  private onClose: (code: number) => void;
  private onOpen: () => void;
  private reconnectAttempts = 0;
  private maxReconnect = 5;
  private sendQueue: ArrayBuffer[] = [];
  private closedByUser = false;
  private sentBytes = 0;
  private onDebug: (kind: 'ws' | 'msg' | 'audio' | 'rms' | 'rate', info: string) => void;
  private recordingStart = Date.now();

  constructor(
    provider: SttProvider,
    token: string,
    sampleRate: number,
    callbacks: {
      onTranscript: (entry: TranscriptEntry) => void;
      onError: (err: Error) => void;
      onClose: (code: number) => void;
      onOpen: () => void;
      onDebug?: (kind: 'ws' | 'msg' | 'audio' | 'rms' | 'rate', info: string) => void;
    }
  ) {
    this.provider = provider;
    this.token = token;
    this.sampleRate = sampleRate;
    this.onTranscript = callbacks.onTranscript;
    this.onError = callbacks.onError;
    this.onClose = callbacks.onClose;
    this.onOpen = callbacks.onOpen;
    this.onDebug = callbacks.onDebug || (() => {});
  }

  connect(): void {
    this.closedByUser = false;
    this.recordingStart = Date.now();
    this.open();
  }

  private buildUrl(): string {
    if (this.provider === 'speechmatics') {
      const base = 'wss://eu.rt.speechmatics.com/v2';
      return `${base}?jwt=${encodeURIComponent(this.token)}`;
    }
    // Deepgram: tokenはサブプロトコルで渡すためURLに含めない
    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'ja',
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      diarize: 'true',
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  private open(): void {
    const url = this.buildUrl();
    try {
      if (this.provider === 'deepgram') {
        // サブプロトコルで認証
        this.ws = new WebSocket(url, ['token', this.token]);
      } else {
        this.ws = new WebSocket(url);
      }
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onOpen();
      this.onDebug('ws', 'OPEN');
      // Speechmaticsは接続後に StartRecognition を送る必要がある
      if (this.provider === 'speechmatics') {
        const startMsg = {
          message: 'StartRecognition',
          audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: this.sampleRate },
          transcription_config: { language: 'ja', enable_partials: true },
        };
        this.ws!.send(JSON.stringify(startMsg));
      }
      // キュー送信
      while (this.sendQueue.length > 0) {
        const chunk = this.sendQueue.shift()!;
        this.ws!.send(chunk);
      }
    };

    this.ws.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '[binary]';
      this.onDebug('msg', raw.slice(0, 400));
      // Deepgram/Speechmatics のエラーを検知
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'Error' || m.message === 'Error') {
            this.onError(new Error('STT Error: ' + (m.description || m.reason || JSON.stringify(m))));
          }
        } catch {}
      }
      this.handleMessage(ev.data);
    };

    this.ws.onerror = (ev) => {
      this.onError(new Error(`WebSocket error: ${this.provider} (code=${this.ws?.readyState})`));
      this.onDebug('msg', `[WS ERROR] ${this.provider} readyState=${this.ws?.readyState}`);
    };

    this.ws.onclose = (ev) => {
      this.onDebug('msg', `[WS CLOSE] code=${ev.code} reason=${ev.reason || '(none)'} wasClean=${ev.wasClean}`);
      if (this.closedByUser) {
        this.onClose(ev.code);
        return;
      }
      if (this.reconnectAttempts < this.maxReconnect) {
        this.reconnectAttempts++;
        setTimeout(() => this.open(), 1000 * this.reconnectAttempts);
      } else {
        this.onClose(ev.code);
      }
    };
  }

  private handleMessage(data: any): void {
    if (this.provider === 'speechmatics') {
      let msg: any;
      try { msg = JSON.parse(data); } catch { return; }
      if ((msg.message === 'AddTranscript' || msg.message === 'AddPartialTranscript') && msg.metadata?.transcript) {
        this.onTranscript({
          time: this.nowStr(),
          speaker: DEFAULT_SPEAKER_CONFIG.micLabel,
          text: msg.metadata.transcript,
          final: msg.message === 'AddTranscript',
        });
      }
    } else {
      // Deepgram
      let msg: any;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'Results' && msg.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        const speakerIdx = alt.words?.[0]?.speaker ?? 0;
        const speaker = speakerIdx === 0
          ? DEFAULT_SPEAKER_CONFIG.micLabel
          : DEFAULT_SPEAKER_CONFIG.cableLabel;
        this.onTranscript({
          time: this.nowStr(),
          speaker,
          text: alt.transcript || '',
          final: msg.is_final === true,
        });
      }
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.sentBytes += chunk.byteLength;
    this.onDebug('audio', this.sentBytes + ' bytes');
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.sendQueue.push(chunk);
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private nowStr(): string {
    const elapsed = Math.floor((Date.now() - this.recordingStart) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const p = (n: number) => n < 10 ? '0' + n : '' + n;
    return `${p(m)}:${p(s)}`;
  }
}

const DEFAULT_SPEAKER_CONFIG: SpeakerConfig = { micLabel: '自分', cableLabel: '相手' };

// ---------- Audio Manager ----------
class AudioManager {
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private tabStream: MediaStream | null = null;
  private onTabError: ((msg: string) => void) | null = null;
  private stt: SttWebSocket | null = null;
  private sampleRate = 16000;
  private onError: (err: Error) => void;
  private onRms: ((rms: number) => void) | null = null;

  constructor(onError: (err: Error) => void, onRms?: (rms: number) => void) {
    this.onError = onError;
    this.onRms = onRms || null;
  }

  async prepareContext(): Promise<void> {
    if (this.audioContext) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AC({ sampleRate: this.sampleRate });
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    // ブラウザが要求サンプルレートを丸める場合があるため、実際の値を取得
    this.sampleRate = this.audioContext.sampleRate;
  }

  async start(stt: SttWebSocket, deviceId?: string, opts?: { mode?: Mode; isDesktop?: boolean }): Promise<void> {
    this.stt = stt;
    const mode = opts?.mode || 'inperson';
    const isDesktop = opts?.isDesktop || false;
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    // PC + Web会議モード: タブ音声(相手の声)も取得を試みる
    if (mode === 'web' && isDesktop) {
      try {
        const tabStream = await (navigator.mediaDevices as any).getDisplayMedia({ video: false, audio: true });
        // タブ音声ストリームをマイクストリームにマージ
        const tabAudio = tabStream.getAudioTracks();
        if (tabAudio.length > 0) {
          tabAudio.forEach(t => this.stream.addTrack(t));
          this.tabStream = tabStream;
        }
      } catch (e) {
        // タブ音声取得キャンセル/失敗時はマイクのみ継続
        if (this.onTabError) this.onTabError((e as Error).message);
      }
    }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AC({ sampleRate: this.sampleRate });
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    this.source = this.audioContext.createMediaStreamSource(this.stream);
    // ScriptProcessorNode (GAS iframe/Android互換のためWorklet不使用)
    const bufferSize = 4096;
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.processor.onaudioprocess = (e) => this.onAudioProcess(e);

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  private onAudioProcess(e: AudioProcessingEvent): void {
    if (!this.stt) return;
    const input = e.inputBuffer.getChannelData(0);
    const GAIN = 8;
    const pcm = new Int16Array(input.length);
    let sumSq = 0;
    for (let i = 0; i < input.length; i++) {
      const raw = input[i];
      sumSq += raw * raw;
      let s = raw * GAIN;
      s = Math.max(-1, Math.min(1, s));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const rms = Math.sqrt(sumSq / input.length);
    if (this.onRms) this.onRms(rms);
    this.stt.sendAudio(pcm.buffer);
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  stop(): void {
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.source) { this.source.disconnect(); this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }
}

// ---------- UI / アプリ ----------
class App {
  private gas = new GasClient();
  private audio = new AudioManager(
    (err) => this.log('音声エラー: ' + err.message),
    (rms) => this.updateDebug('rms', rms.toFixed(4))
  );
  private stt: SttWebSocket | null = null;
  private transcripts: TranscriptEntry[] = [];
  private recording = false;
  private mode: Mode = 'inperson';
  private sttProvider: SttProvider = 'deepgram';
  private speakerConfig: SpeakerConfig = { ...DEFAULT_SPEAKER_CONFIG };
  private summaryPrompt = localStorage.getItem('transcription_summary_prompt') || '';
  private summaryInterval = 3;
  private lastSummary = '';
  private summaryTimer: number | null = null;

  // DOM
  private elStatus!: HTMLElement;
  private elTranscript!: HTMLElement;
  private elSummary!: HTMLElement;
  private elMicSelect!: HTMLSelectElement;

  async init(): Promise<void> {
    this.buildUI();
    await this.loadDevices();
  }

  private buildUI(): void {
    document.body.innerHTML = `
      <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; background: #f5f5f5; color: #222; }
        .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
        button { padding: 8px 14px; border: none; border-radius: 6px; background: #1976d2; color: #fff; font-size: 14px; cursor: pointer; }
        button.stop { background: #d32f2f; }
        button:disabled { opacity: .5; cursor: not-allowed; }
        select, input { padding: 6px; border-radius: 6px; border: 1px solid #ccc; font-size: 14px; }
        .status { padding: 6px 10px; border-radius: 6px; background: #e3f2fd; font-size: 13px; margin-bottom: 8px; }
        .error { background: #ffebee; color: #c62828; }
        .row { display: flex; gap: 16px; }
        .col { flex: 1; min-width: 280px; }
        .panel { background: #fff; border-radius: 8px; padding: 12px; height: 50vh; overflow-y: auto; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
        .entry { margin-bottom: 6px; font-size: 14px; line-height: 1.4; }
        .entry.tmp { opacity: .6; }
        .entry.spk-me .speaker { font-weight: bold; color: #1565c0; }
        .entry.spk-other .speaker { font-weight: bold; color: #e65100; }
        .entry.spk-other { background: #fff3e0; border-radius: 4px; padding: 2px 4px; }
        .entry.spk-me { background: #e3f2fd; border-radius: 4px; padding: 2px 4px; }
        .speaker { font-weight: bold; color: #1976d2; }
        .summary { white-space: pre-wrap; font-size: 14px; }
        h3 { margin: 0 0 8px; font-size: 15px; }
        .settings { background: #fff; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
        .settings input { width: 100%; box-sizing: border-box; margin: 4px 0; }
        .settings .savestatus { font-size: 12px; color: #2e7d32; margin-top: 4px; }
      </style>
      <div class="toolbar">
        <button id="btnRec">🎤 録音開始</button>
        <label>モード:
          <select id="selMode">
            <option value="inperson">対面</option>
            <option value="web">Web会議</option>
          </select>
        </label>
        <label>STT:
          <select id="selStt">
            <option value="deepgram">Deepgram</option>
            <option value="speechmatics">Speechmatics</option>
          </select>
        </label>
        <label>要約間隔:
          <select id="selInterval">
            <option value="1">1分</option>
            <option value="3" selected>3分</option>
            <option value="5">5分</option>
          </select>
        </label>
        <label>マイク:
          <select id="selMic"><option value="">デフォルト</option></select>
        </label>
        <button id="btnSave">💾 保存</button>
      </div>
      <div class="settings">
        <strong>話者ラベル</strong>
        <input id="inpMicLabel" type="text" placeholder="自分の名前" value="自分" style="width:48%">
        <input id="inpOtherLabel" type="text" placeholder="相手の名前" value="相手" style="width:48%">
        <button id="btnRenameSpk">適用</button>
        <div id="renameStatus" class="savestatus"></div>
      </div>
      <div class="settings">
        <strong>要約プロンプト（任意・空欄で既定）</strong>
        <textarea id="inpPrompt" rows="3" style="width:100%;box-sizing:border-box" placeholder="例: 箇条書きで、アクションアイテムを先頭にまとめて"></textarea>
        <button id="btnSavePrompt">プロンプト保存</button>
        <div id="promptStatus" class="savestatus"></div>
      </div>
      <div class="settings">
        <strong>GAS API URL設定</strong>
        <input id="inpGasUrl" type="text" placeholder="https://script.google.com/macros/s/.../exec" value="${GAS_API_URL}">
        <button id="btnSaveGasUrl">URLを保存</button>
        <div id="gasSaveStatus" class="savestatus"></div>
      </div>
      <div id="status" class="status">待機中...</div>
      <div class="settings">
        <strong>デバッグ情報</strong>
        <div id="dbgWs" style="font-size:12px;color:#555">WS: -</div>
        <div id="dbgMsg" style="font-size:12px;color:#555;max-height:80px;overflow:auto">受信: -</div>
        <div id="dbgAudio" style="font-size:12px;color:#555">送信音声: 0 bytes</div>
        <div id="dbgRate" style="font-size:12px;color:#555">実レート: -</div>
        <div id="dbgRms" style="font-size:12px;color:#555">音声RMS: -</div>
      </div>
      <div class="row">
        <div class="col">
          <div class="panel"><h3>文字起こし</h3><div id="transcript"></div></div>
        </div>
        <div class="col">
          <div class="panel"><h3>要約</h3><div id="summary" class="summary"></div></div>
        </div>
      </div>
    `;
    this.elStatus = document.getElementById('status')!;
    this.elTranscript = document.getElementById('transcript')!;
    this.elSummary = document.getElementById('summary')!;
    this.elMicSelect = document.getElementById('selMic') as HTMLSelectElement;

    document.getElementById('btnRec')!.addEventListener('click', () => this.toggleRecording());
    document.getElementById('btnSave')!.addEventListener('click', () => this.save());
    (document.getElementById('selMode') as HTMLSelectElement).addEventListener('change', (e) => {
      this.mode = (e.target as HTMLSelectElement).value as Mode;
    });
    (document.getElementById('selStt') as HTMLSelectElement).addEventListener('change', (e) => {
      this.sttProvider = (e.target as HTMLSelectElement).value as SttProvider;
    });
    (document.getElementById('selInterval') as HTMLSelectElement).addEventListener('change', (e) => {
      this.summaryInterval = parseInt((e.target as HTMLSelectElement).value, 10);
      this.restartSummaryTimer();
    });
    document.getElementById('btnSaveGasUrl')!.addEventListener('click', () => this.saveGasUrl());
    document.getElementById('btnRenameSpk')!.addEventListener('click', () => this.applySpeakerLabels());
    document.getElementById('btnSavePrompt')!.addEventListener('click', () => this.savePrompt());
    // 要約プロンプトの初期値を反映
    (document.getElementById('inpPrompt') as HTMLTextAreaElement).value = this.summaryPrompt;
  }

  private applySpeakerLabels(): void {
    const mic = (document.getElementById('inpMicLabel') as HTMLInputElement).value.trim();
    const other = (document.getElementById('inpOtherLabel') as HTMLInputElement).value.trim();
    if (mic) this.speakerConfig.micLabel = mic;
    if (other) this.speakerConfig.cableLabel = other;
    document.getElementById('renameStatus')!.textContent = `適用: ${this.speakerConfig.micLabel} / ${this.speakerConfig.cableLabel} ✓`;
  }

  private savePrompt(): void {
    const v = (document.getElementById('inpPrompt') as HTMLTextAreaElement).value.trim();
    this.summaryPrompt = v;
    localStorage.setItem('transcription_summary_prompt', v);
    document.getElementById('promptStatus')!.textContent = '保存しました ✓';
  }

  private saveGasUrl(): void {
    const inp = document.getElementById('inpGasUrl') as HTMLInputElement;
    const val = inp.value.trim();
    if (!val) {
      document.getElementById('gasSaveStatus')!.textContent = 'URLを入力してください';
      return;
    }
    localStorage.setItem(STORAGE_KEY_GAS_URL, val);
    GAS_API_URL = val;
    document.getElementById('gasSaveStatus')!.textContent = '保存しました ✓';
    this.setStatus('GAS API URLを更新しました');
  }

  private async loadDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      this.elMicSelect.innerHTML = '<option value="">デフォルト</option>' +
        mics.map((m, i) => `<option value="${m.deviceId}">${m.label || 'マイク' + (i + 1)}</option>`).join('');
    } catch (err) {
      this.log('デバイス一覧取得失敗: ' + (err as Error).message);
    }
  }

  private isMobile(): boolean {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  private async toggleRecording(): Promise<void> {
    if (this.recording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    try {
      // 権限確認
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permission.state === 'denied') {
        this.setStatus('マイク権限が拒否されています。ブラウザの設定から許可してください。', true);
        return;
      }

      this.setStatus('トークン取得中...');
      const token = await this.gas.getSttToken(this.sttProvider);

      // AudioContextを先に作り、実際のサンプルレートを取得（Androidで丸められる場合がある）
      await this.audio.prepareContext();
      this.audio.onTabError = (msg) => this.log('タブ音声取得スキップ(Web会議PC): ' + msg);
      this.updateDebug('rate', String(this.audio.getSampleRate()) + ' Hz');
      const deviceId = this.elMicSelect.value || undefined;
      this.stt = new SttWebSocket(this.sttProvider, token, this.audio.getSampleRate(), {
        onTranscript: (entry) => this.addTranscript(entry),
        onError: (err) => this.log(err.message),
        onClose: (code) => this.log(`STT切断: ${code}`),
        onOpen: () => this.log(`[STT] ${this.sttProvider} connected`),
        onDebug: (kind, info) => this.updateDebug(kind, info),
      });
      await this.audio.start(this.stt!, deviceId, { mode: this.mode, isDesktop: !this.isMobile() });
      this.stt.connect();

      this.recording = true;
      (document.getElementById('btnRec') as HTMLButtonElement).textContent = '⏹ 録音停止';
      (document.getElementById('btnRec') as HTMLButtonElement).classList.add('stop');
      this.setStatus('録音中...');
      this.startSummaryTimer();
    } catch (err) {
      this.setStatus('開始エラー: ' + (err as Error).message, true);
      this.stopRecording();
    }
  }

  private stopRecording(): void {
    this.recording = false;
    (document.getElementById('btnRec') as HTMLButtonElement).textContent = '🎤 録音開始';
    (document.getElementById('btnRec') as HTMLButtonElement).classList.remove('stop');
    if (this.stt) { this.stt.close(); this.stt = null; }
    this.audio.stop();
    this.stopSummaryTimer();
    this.setStatus('停止しました');
  }

  private addTranscript(entry: TranscriptEntry): void {
    if (!entry.text) return;
    this.transcripts.push(entry);
    const div = document.createElement('div');
    const speakerClass = entry.speaker === this.speakerConfig.micLabel ? 'me' : 'other';
    div.className = 'entry' + (entry.final ? '' : ' tmp') + ' spk-' + speakerClass;
    div.innerHTML = `<span class="speaker">[${entry.time}] ${entry.speaker}:</span> ${entry.text}`;
    this.elTranscript.appendChild(div);
    this.elTranscript.scrollTop = this.elTranscript.scrollHeight;
    // 暫定結果は5秒後に削除（確定表示の重複防止）
    if (!entry.final) {
      setTimeout(() => {
        if (div.parentNode) div.parentNode.removeChild(div);
      }, 5000);
    }
  }

  private startSummaryTimer(): void {
    this.stopSummaryTimer();
    this.summaryTimer = window.setInterval(() => this.runSummary(), this.summaryInterval * 60 * 1000);
  }
  private restartSummaryTimer(): void {
    if (this.recording) this.startSummaryTimer();
  }
  private stopSummaryTimer(): void {
    if (this.summaryTimer) { clearInterval(this.summaryTimer); this.summaryTimer = null; }
  }

  private async runSummary(): Promise<void> {
    if (this.transcripts.length === 0) return;
    try {
      const summary = await this.gas.summarize(this.transcripts, this.summaryInterval, this.summaryPrompt);
      this.lastSummary = summary;
      this.elSummary.textContent = summary;
    } catch (err) {
      this.log('要約失敗: ' + (err as Error).message);
    }
  }

  private async save(): Promise<void> {
    if (this.transcripts.length === 0) { this.setStatus('保存するデータがありません', true); return; }
    try {
      this.setStatus('保存中...');
      const result = await this.gas.save(this.transcripts, this.mode, this.sttProvider, this.summaryInterval, this.summaryPrompt);
      this.elSummary.textContent = result.summary;
      this.setStatus('保存完了: ' + result.filename);
    } catch (err) {
      this.setStatus('保存失敗: ' + (err as Error).message, true);
      this.updateDebug('msg', '保存失敗: ' + (err as Error).message);
    }
  }

  private updateDebug(kind: 'ws' | 'msg' | 'audio' | 'rms' | 'rate', info: string): void {
    const el = kind === 'ws' ? 'dbgWs' : kind === 'msg' ? 'dbgMsg' : kind === 'audio' ? 'dbgAudio' : kind === 'rms' ? 'dbgRms' : 'dbgRate';
    const node = document.getElementById(el);
    if (!node) return;
    if (kind === 'msg') {
      // 直近5件を追記（最新が上）
      const lines = node.textContent === '-' || node.textContent === '' ? [] : node.textContent!.split('\n');
      lines.unshift(info);
      node.textContent = lines.slice(0, 5).join('\n');
    } else {
      node.textContent = (kind === 'audio' ? '送信音声: ' : kind === 'rms' ? '音声RMS: ' : kind === 'rate' ? '実レート: ' : (kind === 'ws' ? 'WS: ' : '')) + info;
    }
  }

  private setStatus(msg: string, isError = false): void {
    this.elStatus.textContent = msg;
    this.elStatus.className = 'status' + (isError ? ' error' : '');
  }
  private log(msg: string): void {
    console.log(msg);
    if (msg.startsWith('STT切断') || msg.startsWith('音声エラー') || msg.startsWith('[STT]')) {
      // ステータスには軽微なもののみ
    }
  }
}

const app = new App();
app.init();
