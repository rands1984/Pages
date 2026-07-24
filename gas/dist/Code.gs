/**
 * GASスクリプトプロパティ管理
 * すべての機密情報・設定はスクリプトプロパティから取得
 */

var scriptProperties = PropertiesService.getScriptProperties();

/**
 * 必須プロパティ取得 (未設定時は例外)
 */
function getScriptProperty(key) {
  var value = scriptProperties.getProperty(key);
  if (!value) {
    throw new Error('Required script property not set: ' + key);
  }
  return value;
}

/**
 * 任意プロパティ取得 (未設定時はundefined)
 */
function getOptionalScriptProperty(key) {
  return scriptProperties.getProperty(key) || undefined;
}

/**
 * 必須プロパティキー一覧 (セットアップ時のチェック用)
 */
var REQUIRED_PROPERTIES = [
  'GEMINI_API_KEY',
  'SPEECHMATICS_API_KEY',
  'DEEPGRAM_API_KEY',
  'DROPBOX_ACCESS_TOKEN',
  'DROPBOX_FOLDER_PATH',
];

var OPTIONAL_PROPERTIES = [
  'SPEECHMATICS_WS_URL',
  'DEEPGRAM_WS_URL',
];

var DEFAULT_SPEAKER_CONFIG = {
  micLabel: '自分',
  cableLabel: '相手'
};

var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * CORSヘッダー付きレスポンス作成
 */
function createResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * エラーレスポンス作成
 */
function createErrorResponse(message, details) {
  return {
    status: 'error',
    error: details ? message + ': ' + details : message,
  };
}

/**
 * 必須プロパティチェック
 */
function validateProperties() {
  for (var i = 0; i < REQUIRED_PROPERTIES.length; i++) {
    var key = REQUIRED_PROPERTIES[i];
    try {
      getScriptProperty(key);
    } catch (e) {
      return key;
    }
  }
  return null;
}

/**
 * パディング関数
 */
function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * JST日付文字列取得 (YYYY-MM-DD)
 */
function getJSTDateString() {
  var now = new Date();
  var offset = 9 * 60; // JST = UTC+9
  var local = new Date(now.getTime() + offset * 60000);
  return local.getFullYear() + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate());
}

/**
 * ファイル名生成
 */
function generateFilename(mode) {
  var dateStr = getJSTDateString();
  var prefix = mode === 'web' ? 'web-meeting' : 'in-person';
  return prefix + '_' + dateStr + '.md';
}

/**
 * Markdown生成
 */
function generateMarkdown(transcript, summary, mode, dateStr) {
  var modeLabel = mode === 'web' ? 'Web会議' : '対面打ち合わせ';
  var lines = [];
  lines.push('# ' + modeLabel + ' 文字起こし・要約');
  lines.push('');
  lines.push('**日付**: ' + dateStr);
  lines.push('**モード**: ' + modeLabel);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## リアルタイム要約');
  lines.push('');
  lines.push(summary || '(要約なし)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 文字起こしログ');
  lines.push('');
  for (var i = 0; i < transcript.length; i++) {
    var entry = transcript[i];
    lines.push('[' + entry.time + '] ' + entry.speaker + ': ' + entry.text);
  }
  return lines.join('\n');
}

/**
 * Gemini APIで要約生成
 */
function summarizeWithGemini(transcript, mode, speakerConfig) {
  var apiKey = getScriptProperty('GEMINI_API_KEY');
  var model = getOptionalScriptProperty('GEMINI_MODEL') || 'gemini-1.5-flash';

  var transcriptText = transcript.map(function(entry) {
    return '[' + entry.time + '] ' + entry.speaker + ': ' + entry.text;
  }).join('\n');

  var modeLabel = mode === 'web' ? 'Web会議' : '対面打ち合わせ';
  var meLabel = speakerConfig.micLabel;
  var otherLabel = speakerConfig.cableLabel;

  var prompt = '以下は' + modeLabel + 'のリアルタイム文字起こしログです。\n' +
    '話者: "' + meLabel + '" (自分側), "' + otherLabel + '" (相手側)\n\n' +
    '要点を簡潔にまとめてください。以下の形式で出力してください：\n\n' +
    '## 概要・要約\n（全体の要約 3-5行程度）\n\n' +
    '## 主な議題・決定事項\n- 箇条書きで\n\n' +
    '## アクションアイテム\n- 担当者と期限があれば記載\n\n' +
    '---\n文字起こしログ:\n' + transcriptText;

  var url = GEMINI_API_BASE + model + ':generateContent?key=' + apiKey;

  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (responseCode !== 200) {
    throw new Error('Gemini API error: ' + responseCode + ' ' + responseText);
  }

  var data = JSON.parse(responseText);
  var summaryText = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

  if (!summaryText) {
    throw new Error('Gemini response parsing failed: ' + responseText);
  }

  return summaryText.trim();
}

/**
 * DropboxにMarkdownアップロード
 */
function uploadMarkdownToDropbox(markdown, filename) {
  var accessToken = getScriptProperty('DROPBOX_ACCESS_TOKEN');
  var folderPath = getScriptProperty('DROPBOX_FOLDER_PATH');
  var path = folderPath + '/' + filename;

  var url = 'https://content.dropboxapi.com/2/files/upload';
  var options = {
    method: 'post',
    contentType: 'application/octet-stream',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({
        path: path,
        mode: 'add',
        autorename: true,
        mute: false,
        strict_conflict: false
      })
    },
    payload: markdown,
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (responseCode !== 200) {
    throw new Error('Dropbox upload failed: ' + responseCode + ' ' + responseText);
  }

  return JSON.parse(responseText);
}

/**
 * 要約生成処理
 */
function handleSummarize(request) {
  try {
    var transcript = request.transcript;
    var interval = request.interval;

    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return createErrorResponse('No transcript data');
    }

    var speakerConfig = DEFAULT_SPEAKER_CONFIG;
    var hasMeSpeaker = transcript.some(function(t) {
      return t.speaker === '自分' || t.speaker === speakerConfig.micLabel;
    });
    var mode = hasMeSpeaker ? 'web' : 'inperson';

    var summary = summarizeWithGemini(transcript, mode, speakerConfig);

    return {
      status: 'success',
      summary: summary,
    };
  } catch (err) {
    var message = err instanceof Error ? err.message : String(err);
    return createErrorResponse('Summarize failed', message);
  }
}

/**
 * 保存処理 (Markdown生成 → Dropboxアップロード)
 */
function handleSave(request) {
  try {
    var transcript = request.transcript;
    var mode = request.mode;
    var sttProvider = request.sttProvider;
    var summaryInterval = request.summaryInterval;

    if (!transcript || !Array.isArray(transcript) || transcript.length === 0) {
      return createErrorResponse('No transcript data');
    }

    var speakerConfig = DEFAULT_SPEAKER_CONFIG;

    var summary = summarizeWithGemini(transcript, mode, speakerConfig);

    var dateStr = getJSTDateString();
    var markdown = generateMarkdown(transcript, summary, mode, dateStr);

    var filename = generateFilename(mode);
    uploadMarkdownToDropbox(markdown, filename);

    return {
      status: 'success',
      summary: summary,
      markdown: markdown,
    };
  } catch (err) {
    var message = err instanceof Error ? err.message : String(err);
    return createErrorResponse('Save failed', message);
  }
}

/**
 * STT トークン取得 (Speechmatics/Deepgram用)
 */
function handleSttToken(request) {
  try {
    var provider = request.provider || 'speechmatics';

    if (provider === 'speechmatics') {
      var apiKey = getScriptProperty('SPEECHMATICS_API_KEY');
      return { status: 'success', token: apiKey };
    }

    if (provider === 'deepgram') {
      var apiKey = getScriptProperty('DEEPGRAM_API_KEY');
      return { status: 'success', token: apiKey };
    }

    return createErrorResponse('Unknown provider', provider);
  } catch (err) {
    var message = err instanceof Error ? err.message : String(err);
    return createErrorResponse('STT token failed', message);
  }
}

/**
 * メインハンドラ: doPost
 * リクエスト: { action: 'summarize' | 'save' | 'stt_token', ... }
 * レスポンス: { status, summary?, markdown?, error? }
 */
function doPost(e) {
  try {
    var missing = validateProperties();
    if (missing) {
      return createResponse(createErrorResponse('Script property not configured', missing));
    }

    var postData = e.postData?.contents;
    if (!postData) {
      return createResponse(createErrorResponse('Empty request body'));
    }

    var request;
    try {
      request = JSON.parse(postData);
    } catch (parseErr) {
      return createResponse(createErrorResponse('Invalid JSON', parseErr.message));
    }

    if (request.action === 'summarize') {
      return createResponse(handleSummarize(request));
    } else if (request.action === 'save') {
      return createResponse(handleSave(request));
    } else if (request.action === 'stt_token') {
      return createResponse(handleSttToken(request));
    } else {
      return createResponse(createErrorResponse('Unknown action', request.action));
    }
  } catch (err) {
    var message = err instanceof Error ? err.message : String(err);
    return createResponse(createErrorResponse('Internal server error', message));
  }
}

/**
 * OPTIONS リクエスト対応 (CORS プリフライト)
 */
function doOptions() {
  var output = ContentService.createTextOutput('');
  output.setMimeType(ContentService.MimeType.TEXT);
  return output;
}

/**
 * HtmlService用includeヘルパー (テンプレート評価時に呼ばれるためグローバル必須)
 * 別HTMLファイル（css.html, js.html）をテンプレート内で読み込む
 */
function include(filename) {
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (err) {
    // ログ出力して空文字返却（テンプレート崩壊防止）
    console.error('include() failed for: ' + filename + ' - ' + err.message);
    return '<!-- include failed: ' + filename + ' -->';
  }
}

/**
 * WebアプリGET: フロントエンドHTML配信
 */
function doGet() {
  try {
    var template = HtmlService.createTemplateFromFile('index');
    template.apiUrl = ScriptApp.getService().getUrl();
    var output = template.evaluate()
      .setTitle('文字起こしツール')
      // ALLOWALLを削除: iframeでマイク権限が使えなくなるため
      // .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
      .addMetaTag('apple-mobile-web-app-capable', 'yes')
      .addMetaTag('mobile-web-app-capable', 'yes');
    return output;
  } catch (err) {
    // テンプレート評価失敗時はフォールバックHTML返却
    console.error('doGet template evaluation failed: ' + err.message);
    var fallback = HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>文字起こしツール - Error</title></head>' +
      '<body style="font-family:sans-serif;padding:20px;text-align:center">' +
      '<h1>初期化エラー</h1><p>' + err.message + '</p>' +
      '<p>GASエディタのログを確認してください。</p></body></html>'
    );
    fallback.setTitle('文字起こしツール - Error');
    return fallback;
  }
}

/**
 * デプロイ用: WebアプリURL取得 (手動実行)
 */
function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

/**
 * 設定確認用: プロパティ一覧取得 (手動実行)
 */
function checkProperties() {
  var result = {};
  for (var i = 0; i < REQUIRED_PROPERTIES.length; i++) {
    var key = REQUIRED_PROPERTIES[i];
    result[key] = !!PropertiesService.getScriptProperties().getProperty(key);
  }
  for (var i = 0; i < OPTIONAL_PROPERTIES.length; i++) {
    var key = OPTIONAL_PROPERTIES[i];
    result[key] = !!PropertiesService.getScriptProperties().getProperty(key);
  }
  return result;
}