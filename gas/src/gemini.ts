import { getScriptProperty, getOptionalScriptProperty } from './config';
import { TranscriptEntry, SpeakerConfig } from './types';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * Gemini APIで要約生成
 */
export async function summarizeWithGemini(
  transcript: TranscriptEntry[],
  mode: 'web' | 'inperson',
  speakerConfig: SpeakerConfig
): Promise<string> {
  const apiKey = getScriptProperty('GEMINI_API_KEY');
  const model = getOptionalScriptProperty('GEMINI_MODEL') || 'gemini-1.5-flash';

  // 文字起こしテキスト整形
  const transcriptText = transcript
    .map((entry) => `[${entry.time}] ${entry.speaker}: ${entry.text}`)
    .join('\n');

  const modeLabel = mode === 'web' ? 'Web会議' : '対面打ち合わせ';
  const meLabel = speakerConfig.micLabel;
  const otherLabel = speakerConfig.cableLabel;

  const prompt = `
以下は${modeLabel}のリアルタイム文字起こしログです。
話者: "${meLabel}" (自分側), "${otherLabel}" (相手側)

要点を簡潔にまとめてください。以下の形式で出力してください：

## 概要・要約
（全体の要約 3-5行程度）

## 主な議題・決定事項
- 箇条書きで

## アクションアイテム
- 担当者と期限があれば記載

---
文字起こしログ:
${transcriptText}
`.trim();

  const url = `${GEMINI_API_BASE}${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  };

  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  // リトライ付き実行 (最大3回、指数バックオフ)
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const data = JSON.parse(response.getContentText());

      if (response.getResponseCode() !== 200) {
        throw new Error(data.error?.message || `HTTP ${response.getResponseCode()}`);
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Empty response from Gemini');
      }

      return text.trim();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < 3) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        Utilities.sleep(delay);
      }
    }
  }

  throw lastError || new Error('Gemini API failed after retries');
}

/**
 * Markdown全体生成
 */
export function generateMarkdown(
  transcript: TranscriptEntry[],
  summary: string,
  mode: 'web' | 'inperson',
  dateStr: string
): string {
  const modeLabel = mode === 'web' ? 'Web会議' : '対面';

  const frontmatter = `---
date: ${dateStr}
type: meeting-note
mode: ${modeLabel}
---

`;

  const timeline = transcript
    .map((entry) => `- **[${entry.time}] ${entry.speaker}**: ${entry.text}`)
    .join('\n');

  const content = `# 会議要約（${dateStr.split(' ')[0]}）

## 概要・要約
${summary}

## タイムライン（文字起こしログ）
${timeline}
`;

  return frontmatter + content;
}

/**
 * フロントエンドから話者設定を受け取れるようにする拡張用
 */
export function buildPrompt(
  transcript: TranscriptEntry[],
  mode: 'web' | 'inperson',
  speakerConfig: SpeakerConfig,
  customPrompt?: string
): string {
  if (customPrompt) {
    return customPrompt
      .replace('{{transcript}}', transcript.map(e => `[${e.time}] ${e.speaker}: ${e.text}`).join('\n'))
      .replace('{{mode}}', mode === 'web' ? 'Web会議' : '対面打ち合わせ')
      .replace('{{meLabel}}', speakerConfig.micLabel)
      .replace('{{otherLabel}}', speakerConfig.cableLabel);
  }

  // デフォルトプロンプト
  return `
以下は${mode === 'web' ? 'Web会議' : '対面打ち合わせ'}のリアルタイム文字起こしログです。
話者: "${speakerConfig.micLabel}" (自分側), "${speakerConfig.cableLabel}" (相手側)

要点を簡潔にまとめてください。以下の形式で出力してください：

## 概要・要約
（全体の要約 3-5行程度）

## 主な議題・決定事項
- 箇条書きで

## アクションアイテム
- 担当者と期限があれば記載

---
文字起こしログ:
${transcript.map(e => `[${e.time}] ${e.speaker}: ${e.text}`).join('\n')}
`.trim();
}