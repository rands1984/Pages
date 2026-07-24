/**
 * GASスクリプトプロパティ管理
 * すべての機密情報・設定はスクリプトプロパティから取得
 */

const scriptProperties = PropertiesService.getScriptProperties();

/**
 * 必須プロパティ取得 (未設定時は例外)
 */
export function getScriptProperty(key: string): string {
  const value = scriptProperties.getProperty(key);
  if (!value) {
    throw new Error(`Required script property not set: ${key}`);
  }
  return value;
}

/**
 * 任意プロパティ取得 (未設定時はundefined)
 */
export function getOptionalScriptProperty(key: string): string | undefined {
  return scriptProperties.getProperty(key) || undefined;
}

/**
 * 複数プロパティ一括取得
 */
export function getScriptProperties(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = scriptProperties.getProperty(key);
    if (value) result[key] = value;
  }
  return result;
}

/**
 * プロパティ設定 (管理用)
 */
export function setScriptProperty(key: string, value: string): void {
  scriptProperties.setProperty(key, value);
}

export function setScriptProperties(props: Record<string, string>): void {
  scriptProperties.setProperties(props);
}

/**
 * 必須プロパティキー一覧 (セットアップ時のチェック用)
 */
export const REQUIRED_PROPERTIES = [
  'GEMINI_API_KEY',
  'SPEECHMATICS_API_KEY',
  'DEEPGRAM_API_KEY',
  'DROPBOX_ACCESS_TOKEN',
  'DROPBOX_FOLDER_PATH',
] as const;

export const OPTIONAL_PROPERTIES = [
  'SPEECHMATICS_WS_URL',
  'DEEPGRAM_WS_URL',
] as const;