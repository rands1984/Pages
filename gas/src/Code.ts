import { getScriptProperty, REQUIRED_PROPERTIES, OPTIONAL_PROPERTIES } from './config';
import { TranscriptEntry, SpeakerConfig, DEFAULT_SPEAKER_CONFIG, GasResponse, SummarizeRequest, SaveRequest } from './types';
import { summarizeWithGemini, generateMarkdown } from './gemini';
import { uploadMarkdownToDropbox, generateFilename, getJSTDateString } from './dropbox';

// ========================================
// GAS グローバル関数定義 (esbuildでバンドルされずグローバルに露出させる)
// ========================================

/**
 * CORSヘッダー付きレスポンス作成
 */
function createResponse(data: GasResponse): GoogleAppsScript.Content.TextOutput {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * エラーレスポンス作成
 */
function createErrorResponse(message: string, details?: string): GasResponse {
  return {
    status: 'error',
    error: details ? `${message}: ${details}` : message,
  };
}

/**
 * 必須プロパティチェック
 */
function validateProperties(): string | null {
  for (const key of REQUIRED_PROPERTIES) {
    try {
      getScriptProperty(key);
    } catch {
      return key;
    }
  }
  return null;
}

/**
 * 要約生成処理
 */
async function handleSummarize(request: SummarizeRequest): Promise<GasResponse> {
  try {
    const { transcript, interval } = request;

    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return createErrorResponse('No transcript data');
    }

    const speakerConfig: SpeakerConfig = DEFAULT_SPEAKER_CONFIG;
    const hasMeSpeaker = transcript.some((t) => t.speaker === '自分' || t.speaker === speakerConfig.micLabel);
    const mode = hasMeSpeaker ? 'web' : 'inperson';

    const summary = await summarizeWithGemini(transcript, mode, speakerConfig);

    return {
      status: 'success',
      summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createErrorResponse('Summarize failed', message);
  }
}

/**
 * 保存処理 (Markdown生成 → Dropboxアップロード)
 */
async function handleSave(request: SaveRequest): Promise<GasResponse> {
  try {
    const { transcript, mode, sttProvider, summaryInterval } = request;

    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return createErrorResponse('No transcript data');
    }

    const speakerConfig: SpeakerConfig = DEFAULT_SPEAKER_CONFIG;

    const summary = await summarizeWithGemini(transcript, mode, speakerConfig);

    const dateStr = getJSTDateString();
    const markdown = generateMarkdown(transcript, summary, mode, dateStr);

    const filename = generateFilename(mode);
    uploadMarkdownToDropbox(markdown, filename);

    return {
      status: 'success',
      summary,
      markdown,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createErrorResponse('Save failed', message);
  }
}

/**
 * メインハンドラ: doPost
 * リクエスト: { action: 'summarize' | 'save', ... }
 * レスポンス: { status, summary?, markdown?, error? }
 */
async function doPost(e: GoogleAppsScript.Events.DoPost): Promise<GoogleAppsScript.Content.TextOutput> {
  try {
    const missing = validateProperties();
    if (missing) {
      return createResponse(createErrorResponse('Script property not configured', missing));
    }

    const postData = e.postData?.contents;
    if (!postData) {
      return createResponse(createErrorResponse('Empty request body'));
    }

    let request: { action: string; [key: string]: any };
    try {
      request = JSON.parse(postData);
    } catch {
      return createResponse(createErrorResponse('Invalid JSON'));
    }

    if (request.action === 'summarize') {
      return createResponse(await handleSummarize(request));
    }
    if (request.action === 'save') {
      return createResponse(await handleSave(request));
    }
    if (request.action === 'stt_token') {
      return createResponse(await handleSttToken(request));
    }

    return createResponse(createErrorResponse('Unknown action', request.action));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createResponse(createErrorResponse('Internal server error', message));
  }
}

/**
 * STT トークン取得 (Speechmatics用)
 */
async function handleSttToken(request: { provider: 'speechmatics' | 'deepgram' }): Promise<GasResponse> {
  try {
    const provider = request.provider || 'speechmatics';

    if (provider === 'speechmatics') {
      const apiKey = getScriptProperty('SPEECHMATICS_API_KEY');
      // SpeechmaticsはAPIキーを直接WebSocket認証で使用するため、トークン不要
      return { status: 'success', token: apiKey };
    }

    if (provider === 'deepgram') {
      const apiKey = getScriptProperty('DEEPGRAM_API_KEY');
      // DeepgramもAPIキーを直接使用
      return { status: 'success', token: apiKey };
    }

    return createErrorResponse('Unknown provider', provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createErrorResponse('STT token failed', message);
  }
}

/**
 * OPTIONS リクエスト対応 (CORS プリフライト)
 */
function doOptions(): GoogleAppsScript.Content.TextOutput {
  const output = ContentService.createTextOutput('');
  output.setMimeType(ContentService.MimeType.TEXT);
  return output;
}

/**
 * WebアプリGET: フロントエンドHTML配信
 */
function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile('index');
  template.apiUrl = ScriptApp.getService().getUrl();
  return template.evaluate()
    .setTitle('文字起こしツール')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * デプロイ用: WebアプリURL取得 (手動実行)
 */
function getWebAppUrl(): string {
  return ScriptApp.getService().getUrl();
}

/**
 * 設定確認用: プロパティ一覧取得 (手動実行)
 */
function checkProperties(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const key of REQUIRED_PROPERTIES) {
    result[key] = !!PropertiesService.getScriptProperties().getProperty(key);
  }
  for (const key of OPTIONAL_PROPERTIES) {
    result[key] = !!PropertiesService.getScriptProperties().getProperty(key);
  }
  return result;
}

/**
 * HtmlService用includeヘルパー
 * 別HTMLファイル（css.html, js.html）をテンプレート内で読み込む
 */
function include(filename: string): string {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// GASグローバルスコープに露出させる
declare global {
  var createResponse: typeof createResponse;
  var createErrorResponse: typeof createErrorResponse;
  var validateProperties: typeof validateProperties;
  var handleSummarize: typeof handleSummarize;
  var handleSave: typeof handleSave;
  var handleSttToken: typeof handleSttToken;
  var doPost: typeof doPost;
  var doOptions: typeof doOptions;
  var doGet: typeof doGet;
  var getWebAppUrl: typeof getWebAppUrl;
  var checkProperties: typeof checkProperties;
  var include: typeof include;
}

globalThis.createResponse = createResponse;
globalThis.createErrorResponse = createErrorResponse;
globalThis.validateProperties = validateProperties;
globalThis.handleSummarize = handleSummarize;
globalThis.handleSave = handleSave;
globalThis.handleSttToken = handleSttToken;
globalThis.doPost = doPost;
globalThis.doOptions = doOptions;
globalThis.doGet = doGet;
globalThis.getWebAppUrl = getWebAppUrl;
globalThis.checkProperties = checkProperties;
globalThis.include = include;