// ============================================================
// 文字起こしツール - GAS バックエンド (単一ファイル)
// Script Properties キー (変更禁止):
//   GEMINI_API_KEY, SPEECHMATICS_API_KEY, DEEPGRAM_API_KEY,
//   DROPBOX_ACCESS_TOKEN, DROPBOX_FOLDER_PATH,
//   GEMINI_MODEL(任意), SPEECHMATICS_WS_URL(任意), DEEPGRAM_WS_URL(任意)
// ============================================================

var REQUIRED_PROPERTIES = [
  "GEMINI_API_KEY",
  "SPEECHMATICS_API_KEY",
  "DEEPGRAM_API_KEY",
  "DROPBOX_ACCESS_TOKEN",
  "DROPBOX_FOLDER_PATH"
];
var OPTIONAL_PROPERTIES = ["GEMINI_MODEL", "SPEECHMATICS_WS_URL", "DEEPGRAM_WS_URL"];

var DEFAULT_SPEAKER_CONFIG = { micLabel: "自分", cableLabel: "相手" };

function getScriptProperty(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error("Required script property not set: " + key);
  return value;
}
function getOptionalScriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || "";
}

// GAS Web App は「全員アクセス」デプロイで自動CORS付与。
// TextOutput.setHeader は存在しないため呼ばないこと（例外になる）。
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
function errorResponse(message, details) {
  return { status: "error", error: details ? message + ": " + details : message };
}
function validateProperties() {
  for (var i = 0; i < REQUIRED_PROPERTIES.length; i++) {
    var key = REQUIRED_PROPERTIES[i];
    if (!PropertiesService.getScriptProperties().getProperty(key)) return key;
  }
  return null;
}

function summarizeWithGemini(transcript, mode, speakerConfig, customPrompt) {
  var apiKey = getScriptProperty("GEMINI_API_KEY");
  var model = getOptionalScriptProperty("GEMINI_MODEL") || "gemini-1.5-flash";
  var transcriptText = transcript.map(function (e) {
    return "[" + e.time + "] " + e.speaker + ": " + e.text;
  }).join("\n");
  var prompt;
  if (customPrompt && customPrompt.trim().length > 0) {
    // ユーザー独自プロンプト：文字起こしログを末尾に付与
    prompt = customPrompt.trim() + "\n\n---\n文字起こしログ:\n" + transcriptText;
  } else {
    var modeLabel = mode === "web" ? "Web会議" : "対面打ち合わせ";
    prompt = [
      "以下は" + modeLabel + "のリアルタイム文字起こしログです。",
      '話者: "' + speakerConfig.micLabel + '" (自分側), "' + speakerConfig.cableLabel + '" (相手側)',
      "",
      "要点を簡潔にまとめてください。以下の形式で出力してください：",
      "",
      "## 概要・要約",
      "(全体の要約 3-5行程度)",
      "",
      "## 主な議題・決定事項",
      "- 箇条書きで",
      "",
      "## アクションアイテム",
      "- 担当者と期限があれば記載",
      "",
      "---",
      "文字起こしログ:",
      transcriptText
    ].join("\n");
  }

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var lastError = null;
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();
      var data = JSON.parse(response.getContentText());
      if (code !== 200) throw new Error((data.error && data.error.message) ? data.error.message : "HTTP " + code);
      var text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0].text;
      if (!text) throw new Error("Empty response from Gemini");
      return text.trim();
    } catch (err) {
      lastError = err;
      if (attempt < 3) Utilities.sleep(Math.min(1000 * Math.pow(2, attempt - 1), 10000));
    }
  }
  throw lastError || new Error("Gemini API failed");
}

function generateMarkdown(transcript, summary, mode, dateStr) {
  var modeLabel = mode === "web" ? "Web会議" : "対面";
  var frontmatter = "---\ndate: " + dateStr + "\ntype: meeting-note\nmode: " + modeLabel + "\n---\n\n";
  var timeline = transcript.map(function (e) {
    return "- **[" + e.time + "] " + e.speaker + "**: " + e.text;
  }).join("\n");
  var content = "# 会議要約（" + dateStr.split(" ")[0] + "）\n\n" +
    "## 概要・要約\n" + summary + "\n\n" +
    "## タイムライン（文字起こしログ）\n" + timeline + "\n";
  return frontmatter + content;
}

function pad(n) { return n < 10 ? "0" + n : "" + n; }
function getJSTDateString() {
  var now = new Date();
  var jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCFullYear() + "-" + pad(jst.getUTCMonth() + 1) + "-" + pad(jst.getUTCDate()) +
    " " + pad(jst.getUTCHours()) + ":" + pad(jst.getUTCMinutes());
}
function generateFilename(mode) {
  var now = new Date();
  var jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  var d = jst.getUTCFullYear() + "-" + pad(jst.getUTCMonth() + 1) + "-" + pad(jst.getUTCDate()) +
    "_" + pad(jst.getUTCHours()) + "-" + pad(jst.getUTCMinutes());
  return d + "_" + (mode === "web" ? "web" : "inperson") + ".md";
}
function uploadMarkdownToDropbox(markdown, filename) {
  var accessToken = getScriptProperty("DROPBOX_ACCESS_TOKEN");
  var folderPath = getScriptProperty("DROPBOX_FOLDER_PATH");
  var fullPath = (folderPath.replace(/\/$/, "") + "/" + filename).replace(/\/+/g, "/");
  var args = { path: fullPath, mode: "add", autorename: true, mute: false, strict_conflict: false };
  var options = {
    method: "post",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Dropbox-API-Arg": JSON.stringify(args),
      "Content-Type": "application/octet-stream"
    },
    payload: markdown,
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch("https://content.dropboxapi.com/2/files/upload", options);
  var code = response.getResponseCode();
  var respText = response.getContentText();
  if (code === 200) {
    try { return JSON.parse(respText); }
    catch (e) { return { path: fullPath }; }
  }
  // エラー詳細解析
  var detail = "";
  try {
    var errObj = JSON.parse(respText);
    if (errObj.error_summary) detail = errObj.error_summary;
    else if (errObj.error) detail = JSON.stringify(errObj.error);
    else detail = respText.substring(0, 200);
  } catch (x) {
    detail = respText.substring(0, 200);
  }
  throw new Error("Dropbox upload failed: HTTP " + code + " - " + detail);
}

function verifyDropboxToken() {
  var accessToken = getScriptProperty("DROPBOX_ACCESS_TOKEN");
  var options = {
    method: "post",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    payload: JSON.stringify({ query: "" }),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch("https://api.dropboxapi.com/2/users/get_current_account", options);
  var code = response.getResponseCode();
  if (code !== 200) {
    var detail = "";
    try { var e = JSON.parse(response.getContentText()); detail = e.error_summary || JSON.stringify(e.error); } catch (x) {}
    throw new Error("Dropbox token invalid/expired: HTTP " + code + " - " + detail);
  }
  return true;
}

function verifyDropboxFolder() {
  var accessToken = getScriptProperty("DROPBOX_ACCESS_TOKEN");
  var folderPath = getScriptProperty("DROPBOX_FOLDER_PATH");
  var options = {
    method: "post",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    payload: JSON.stringify({ path: folderPath }),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch("https://api.dropboxapi.com/2/files/get_metadata", options);
  var code = response.getResponseCode();
  if (code !== 200) {
    var detail = "";
    try { var e = JSON.parse(response.getContentText()); detail = e.error_summary || JSON.stringify(e.error); } catch (x) {}
    throw new Error("Dropbox folder not found: " + folderPath + " (HTTP " + code + " - " + detail + ")");
  }
  return true;
}

function handleSummarize(request) {
  try {
    var transcript = request.transcript;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0)
      return errorResponse("No transcript data");
    var hasMe = transcript.some(function (t) { return t.speaker === "自分" || t.speaker === DEFAULT_SPEAKER_CONFIG.micLabel; });
    var mode = hasMe ? "web" : "inperson";
    var summary = summarizeWithGemini(transcript, mode, DEFAULT_SPEAKER_CONFIG, request.prompt);
    return { status: "success", summary: summary };
  } catch (err) {
    return errorResponse("Summarize failed", err.message);
  }
}
function handleSave(request) {
  try {
    var transcript = request.transcript;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0)
      return errorResponse("No transcript data");
    var mode = request.mode || "inperson";
    var summary = summarizeWithGemini(transcript, mode, DEFAULT_SPEAKER_CONFIG, request.prompt);
    var dateStr = getJSTDateString();
    var markdown = generateMarkdown(transcript, summary, mode, dateStr);
    var filename = generateFilename(mode);
    // 保存前検証（詳細エラーを取得）
    verifyDropboxToken();
    verifyDropboxFolder();
    uploadMarkdownToDropbox(markdown, filename);
    return { status: "success", summary: summary, markdown: markdown, filename: filename };
  } catch (err) {
    return errorResponse("Save failed", err.message);
  }
}
function handleDropboxDebug() {
  try {
    verifyDropboxToken();
    verifyDropboxFolder();
    return { status: "success", message: "Dropbox connection OK" };
  } catch (err) {
    return errorResponse("Dropbox debug failed", err.message);
  }
}
function handleSttToken(request) {
  try {
    var provider = request.provider || "deepgram";
    if (provider === "speechmatics") {
      var apiKey = getScriptProperty("SPEECHMATICS_API_KEY");
      return { status: "success", token: createSpeechmaticsJwt(apiKey) };
    }
    if (provider === "deepgram")
      return { status: "success", token: getScriptProperty("DEEPGRAM_API_KEY") };
    return errorResponse("Unknown provider", provider);
  } catch (err) {
    return errorResponse("STT token failed", err.message);
  }
}

// Speechmatics用の短命JWT生成（HMAC-SHA256）
// パディング(=)は除去すること（JWT仕様）
function b64url(input) {
  return Utilities.base64EncodeWebSafe(input).replace(/=+$/, "");
}
function createSpeechmaticsJwt(apiKey) {
  var header = { alg: "HS256", typ: "JWT" };
  var now = Math.floor(Date.now() / 1000);
  var payload = { iss: apiKey, iat: now, exp: now + 3600, type: "rt" };
  var data = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  var signature = b64url(Utilities.computeHmacSha256Signature(data, apiKey));
  return data + "." + signature;
}
function handleDebugProps() {
  try {
    var props = PropertiesService.getScriptProperties().getProperties();
    var masked = {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      masked[k] = v ? v.substring(0, 4) + "****" + v.slice(-4) : "(empty)";
    });
    return { status: "success", properties: masked };
  } catch (err) {
    return errorResponse("Debug failed", err.message);
  }
}

function doPost(e) {
  try {
    var missing = validateProperties();
    if (missing) return jsonResponse(errorResponse("Script property not configured", missing));

    var postData = e.postData && e.postData.contents;
    if (!postData) return jsonResponse(errorResponse("Empty request body"));

    var request;
    try { request = JSON.parse(postData); }
    catch (err) { return jsonResponse(errorResponse("Invalid JSON", err.message)); }

    if (request.action === "summarize") return jsonResponse(handleSummarize(request));
    if (request.action === "save") return jsonResponse(handleSave(request));
    if (request.action === "stt_token") return jsonResponse(handleSttToken(request));
    if (request.action === "debug_props") return jsonResponse(handleDebugProps());
    if (request.action === "dropbox_debug") return jsonResponse(handleDropboxDebug());
    return jsonResponse(errorResponse("Unknown action", request.action));
  } catch (err) {
    return jsonResponse(errorResponse("Internal server error", err.message));
  }
}

function doOptions(e) {
  // プリフライト(OPTIONS)用。text/plain POSTでは通常発生しないが、念のためCORS付与。
  // HtmlService は setHeader が使える（TextOutput は setHeader が例外になるため使わない）。
  var out = HtmlService.createHtmlOutput("");
  out.setHeader("Access-Control-Allow-Origin", "*");
  out.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  out.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return out;
}

function checkProperties() {
  var result = {};
  for (var i = 0; i < REQUIRED_PROPERTIES.length; i++)
    result[REQUIRED_PROPERTIES[i]] = !!PropertiesService.getScriptProperties().getProperty(REQUIRED_PROPERTIES[i]);
  for (var j = 0; j < OPTIONAL_PROPERTIES.length; j++)
    result[OPTIONAL_PROPERTIES[j]] = !!PropertiesService.getScriptProperties().getProperty(OPTIONAL_PROPERTIES[j]);
  return result;
}
