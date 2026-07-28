// ============================================================
// 文字起こしツール - GAS バックエンド (TypeScriptソース)
// esbuild で単一ファイルにバンドルして dist/Code.gs へ出力。
// 自己完結型（外部importなし）で記述。
//
// Script Properties キー (変更禁止):
//   GEMINI_API_KEY, SPEECHMATICS_API_KEY, DEEPGRAM_API_KEY,
//   DROPBOX_ACCESS_TOKEN, DROPBOX_FOLDER_PATH,
//   GEMINI_MODEL(任意), SPEECHMATICS_WS_URL(任意), DEEPGRAM_WS_URL(任意)
// ============================================================

const REQUIRED_PROPERTIES = [
  "GEMINI_API_KEY",
  "SPEECHMATICS_API_KEY",
  "DEEPGRAM_API_KEY",
  "DROPBOX_ACCESS_TOKEN",
  "DROPBOX_FOLDER_PATH",
];
const OPTIONAL_PROPERTIES = ["GEMINI_MODEL", "SPEECHMATICS_WS_URL", "DEEPGRAM_WS_URL"];

const DEFAULT_SPEAKER_CONFIG = { micLabel: "自分", cableLabel: "相手" };

function getScriptProperty(key: string): string {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error("Required script property not set: " + key);
  return value;
}
function getOptionalScriptProperty(key: string): string {
  return PropertiesService.getScriptProperties().getProperty(key) || "";
}

// GAS Web App は「全員アクセス」デプロイで自動CORS付与。
// TextOutput.setHeader は存在しないため呼ばないこと（例外になる）。
function jsonResponse(data: any): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}
function errorResponse(message: string, details?: string): any {
  return { status: "error", error: details ? message + ": " + details : message };
}
function validateProperties(): string | null {
  for (const key of REQUIRED_PROPERTIES) {
    if (!PropertiesService.getScriptProperties().getProperty(key)) return key;
  }
  return null;
}

function summarizeWithGemini(
  transcript: any[],
  mode: string,
  speakerConfig: any
): string {
  const apiKey = getScriptProperty("GEMINI_API_KEY");
  const model = getOptionalScriptProperty("GEMINI_MODEL") || "gemini-1.5-flash";
  const transcriptText = transcript
    .map((e) => "[" + e.time + "] " + e.speaker + ": " + e.text)
    .join("\n");
  const modeLabel = mode === "web" ? "Web会議" : "対面打ち合わせ";
  const prompt = [
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
    transcriptText,
  ].join("\n");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    apiKey;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
  };
  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const data = JSON.parse(response.getContentText());
      if (code !== 200)
        throw new Error(
          (data.error && data.error.message) ? data.error.message : "HTTP " + code
        );
      const text =
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts[0].text;
      if (!text) throw new Error("Empty response from Gemini");
      return text.trim();
    } catch (err) {
      lastError = err;
      if (attempt < 3)
        Utilities.sleep(Math.min(1000 * Math.pow(2, attempt - 1), 10000));
    }
  }
  throw lastError || new Error("Gemini API failed");
}

function generateMarkdown(
  transcript: any[],
  summary: string,
  mode: string,
  dateStr: string
): string {
  const modeLabel = mode === "web" ? "Web会議" : "対面";
  const frontmatter =
    "---\ndate: " + dateStr + "\ntype: meeting-note\nmode: " + modeLabel + "\n---\n\n";
  const timeline = transcript
    .map((e) => "- **[" + e.time + "] " + e.speaker + "**: " + e.text)
    .join("\n");
  const content =
    "# 会議要約（" + dateStr.split(" ")[0] + "）\n\n" +
    "## 概要・要約\n" + summary + "\n\n" +
    "## タイムライン（文字起こしログ）\n" + timeline + "\n";
  return frontmatter + content;
}

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}
function getJSTDateString(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return (
    jst.getUTCFullYear() +
    "-" + pad(jst.getUTCMonth() + 1) +
    "-" + pad(jst.getUTCDate()) +
    " " + pad(jst.getUTCHours()) +
    ":" + pad(jst.getUTCMinutes())
  );
}
function generateFilename(mode: string): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const d =
    jst.getUTCFullYear() +
    "-" + pad(jst.getUTCMonth() + 1) +
    "-" + pad(jst.getUTCDate()) +
    "_" + pad(jst.getUTCHours()) +
    "-" + pad(jst.getUTCMinutes());
  return d + "_" + (mode === "web" ? "web" : "inperson") + ".md";
}
function uploadMarkdownToDropbox(markdown: string, filename: string): any {
  const accessToken = getScriptProperty("DROPBOX_ACCESS_TOKEN");
  const folderPath = getScriptProperty("DROPBOX_FOLDER_PATH");
  const fullPath = (folderPath.replace(/\/$/, "") + "/" + filename).replace(/\/\/+/g, "/");
  const args = {
    path: fullPath,
    mode: "add",
    autorename: true,
    mute: false,
    strict_conflict: false,
  };
  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: "post",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Dropbox-API-Arg": JSON.stringify(args),
      "Content-Type": "application/octet-stream",
    },
    payload: markdown,
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch("https://content.dropboxapi.com/2/files/upload", options);
  const code = response.getResponseCode();
  if (code === 200) return JSON.parse(response.getContentText());
  let msg = "Dropbox upload failed: HTTP " + code;
  try {
    const e = JSON.parse(response.getContentText());
    msg += " - " + (e.error_summary || e.error || "");
  } catch (x) {}
  throw new Error(msg);
}

function handleSummarize(request: any): any {
  try {
    const transcript = request.transcript;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0)
      return errorResponse("No transcript data");
    const hasMe = transcript.some(
      (t) => t.speaker === "自分" || t.speaker === DEFAULT_SPEAKER_CONFIG.micLabel
    );
    const mode = hasMe ? "web" : "inperson";
    const summary = summarizeWithGemini(transcript, mode, DEFAULT_SPEAKER_CONFIG);
    return { status: "success", summary };
  } catch (err) {
    return errorResponse("Summarize failed", (err as Error).message);
  }
}
function handleSave(request: any): any {
  try {
    const transcript = request.transcript;
    if (!transcript || !Array.isArray(transcript) || transcript.length === 0)
      return errorResponse("No transcript data");
    const mode = request.mode || "inperson";
    const summary = summarizeWithGemini(transcript, mode, DEFAULT_SPEAKER_CONFIG);
    const dateStr = getJSTDateString();
    const markdown = generateMarkdown(transcript, summary, mode, dateStr);
    const filename = generateFilename(mode);
    uploadMarkdownToDropbox(markdown, filename);
    return { status: "success", summary, markdown, filename };
  } catch (err) {
    return errorResponse("Save failed", (err as Error).message);
  }
}
function handleSttToken(request: any): any {
  try {
    const provider = request.provider || "deepgram";
    if (provider === "speechmatics")
      return { status: "success", token: getScriptProperty("SPEECHMATICS_API_KEY") };
    if (provider === "deepgram")
      return { status: "success", token: getScriptProperty("DEEPGRAM_API_KEY") };
    return errorResponse("Unknown provider", provider);
  } catch (err) {
    return errorResponse("STT token failed", (err as Error).message);
  }
}
function handleDebugProps(): any {
  try {
    const props = PropertiesService.getScriptProperties().getProperties();
    const masked: any = {};
    Object.keys(props).forEach((k) => {
      const v = props[k];
      masked[k] = v ? v.substring(0, 4) + "****" + v.slice(-4) : "(empty)";
    });
    return { status: "success", properties: masked };
  } catch (err) {
    return errorResponse("Debug failed", (err as Error).message);
  }
}

function doPost(e: any): GoogleAppsScript.Content.TextOutput {
  try {
    const missing = validateProperties();
    if (missing) return jsonResponse(errorResponse("Script property not configured", missing));

    const postData = e.postData && e.postData.contents;
    if (!postData) return jsonResponse(errorResponse("Empty request body"));

    let request: any;
    try {
      request = JSON.parse(postData);
    } catch (err) {
      return jsonResponse(errorResponse("Invalid JSON", (err as Error).message));
    }

    if (request.action === "summarize") return jsonResponse(handleSummarize(request));
    if (request.action === "save") return jsonResponse(handleSave(request));
    if (request.action === "stt_token") return jsonResponse(handleSttToken(request));
    if (request.action === "debug_props") return jsonResponse(handleDebugProps());
    return jsonResponse(errorResponse("Unknown action", request.action));
  } catch (err) {
    return jsonResponse(errorResponse("Internal server error", (err as Error).message));
  }
}

// プリフライト用。GAS「全員アクセス」デプロイで自動CORS付与。
function doOptions(e: any): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput("");
}

// 手動実行用ヘルパー
function checkProperties(): any {
  const result: any = {};
  for (const key of REQUIRED_PROPERTIES)
    result[key] = !!PropertiesService.getScriptProperties().getProperty(key);
  for (const key of OPTIONAL_PROPERTIES)
    result[key] = !!PropertiesService.getScriptProperties().getProperty(key);
  return result;
}
