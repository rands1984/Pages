import { getScriptProperty, getOptionalScriptProperty } from './config';

export interface SttConfig {
  provider: 'speechmatics' | 'deepgram';
  wsUrl: string;
  apiKey: string;
  language?: string;
  diarization?: boolean;
}

export interface SttTokenResponse {
  token: string;
  wsUrl: string;
  expiresIn?: number;
}

/**
 * STTプロバイダの設定を取得
 */
export function getSttConfig(provider: 'speechmatics' | 'deepgram'): SttConfig {
  if (provider === 'speechmatics') {
    return {
      provider: 'speechmatics',
      wsUrl: getOptionalScriptProperty('SPEECHMATICS_WS_URL') || 'wss://eu2.rt.speechmatics.com/v2',
      apiKey: getScriptProperty('SPEECHMATICS_API_KEY'),
      language: 'ja',
      diarization: true,
    };
  }
  return {
    provider: 'deepgram',
    wsUrl: getOptionalScriptProperty('DEEPGRAM_WS_URL') || 'wss://api.deepgram.com/v1/listen',
    apiKey: getScriptProperty('DEEPGRAM_API_KEY'),
    language: 'ja',
    diarization: true,
  };
}

/**
 * Speechmatics用の一時JWTトークンを取得
 * フロントエンドから直接WebSocket接続する場合に使用
 */
export async function getSpeechmaticsToken(): Promise<SttTokenResponse> {
  const apiKey = getScriptProperty('SPEECHMATICS_API_KEY');
  const wsUrl = getOptionalScriptProperty('SPEECHMATICS_WS_URL') || 'wss://eu2.rt.speechmatics.com/v2';

  // Speechmatics JWT取得エンドポイント
  const url = `https://api.speechmatics.com/v1/api_keys/${apiKey}/jwt`;

  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: 'get',
    headers: { Authorization: `Bearer ${apiKey}` },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    throw new Error(`Speechmatics token fetch failed (${code}): ${text}`);
  }

  const data = JSON.parse(text);
  return {
    token: data.jwt || data.token,
    wsUrl,
    expiresIn: data.expires_in || 3600,
  };
}

/**
 * Deepgram用の一時トークンを取得（必要な場合）
 * Deepgramは通常APIキーを直接WebSocketクエリパラメータで渡す
 */
export function getDeepgramConfig(): SttConfig {
  return getSttConfig('deepgram');
}

/**
 * 共通: WebSocket接続用パラメータ生成
 */
export function buildWsUrl(config: SttConfig, token?: string): string {
  if (config.provider === 'speechmatics') {
    // Speechmatics: wss://host/v2?jwt=xxx&language=ja&diarization=true
    const params: string[] = [];
    if (token) params.push('jwt=' + encodeURIComponent(token));
    params.push('language=' + encodeURIComponent(config.language || 'ja'));
    if (config.diarization) params.push('diarization=true');
    return `${config.wsUrl}?${params.join('&')}`;
  }
  // Deepgram: wss://host/v1/listen?model=nova-2&language=ja&diarize=true&punctuate=true
  const params: string[] = [];
  params.push('model=nova-2');
  params.push('language=' + encodeURIComponent(config.language || 'ja'));
  if (config.diarization) params.push('diarize=true');
  params.push('punctuate=true');
  params.push('interim_results=true');
  params.push('encoding=linear16');
  params.push('sample_rate=16000');
  // APIキーはAuthorizationヘッダーまたはクエリパラメータで渡す
  return `${config.wsUrl}?${params.join('&')}`;
}