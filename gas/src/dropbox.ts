import { getScriptProperty } from './config';

const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';

interface DropboxUploadResult {
  name: string;
  path_display: string;
  id: string;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/**
 * DropboxにMarkdownファイルをアップロード
 */
export function uploadMarkdownToDropbox(
  markdown: string,
  filename: string
): DropboxUploadResult {
  const accessToken = getScriptProperty('DROPBOX_ACCESS_TOKEN');
  const folderPath = getScriptProperty('DROPBOX_FOLDER_PATH');

  const fullPath = `${folderPath.replace(/\/$/, '')}/${filename}`.replace(/\/+/g, '/');

  const uploadUrl = `${DROPBOX_CONTENT_API}/files/upload`;

  const args = {
    path: fullPath,
    mode: 'add' as const,
    autorename: true,
    mute: false,
    strict_conflict: false,
  };

  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: 'post',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify(args),
      'Content-Type': 'application/octet-stream',
    },
    payload: markdown,
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(uploadUrl, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code === 200) {
    return JSON.parse(text);
  }

  let errorMsg = `Dropbox upload failed: HTTP ${code}`;
  try {
    const errorData = JSON.parse(text);
    errorMsg += ` - ${errorData.error_summary || errorData.error || text}`;
  } catch {
    errorMsg += ` - ${text}`;
  }
  throw new Error(errorMsg);
}

/**
 * ファイル名生成 (YYYY-MM-DD_HH-mm_mode.md)
 */
export function generateFilename(mode: 'web' | 'inperson'): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const dateStr = `${jstNow.getUTCFullYear()}-${pad(jstNow.getUTCMonth() + 1)}-${pad(jstNow.getUTCDate())}_${pad(jstNow.getUTCHours())}-${pad(jstNow.getUTCMinutes())}`;
  const modeLabel = mode === 'web' ? 'web' : 'inperson';
  return `${dateStr}_${modeLabel}.md`;
}

/**
 * JST現在日時文字列生成 (YYYY-MM-DD HH:mm)
 */
export function getJSTDateString(): string {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  return `${jstNow.getUTCFullYear()}-${pad(jstNow.getUTCMonth() + 1)}-${pad(jstNow.getUTCDate())} ${pad(jstNow.getUTCHours())}:${pad(jstNow.getUTCMinutes())}`;
}