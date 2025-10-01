import { config } from './config';

/**
 * ログレベルの優先度
 */
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

/**
 * 現在の設定されたログレベルを取得
 */
function getCurrentLogLevel(): LogLevel {
  return config.LOG_LEVEL;
}

/**
 * 指定されたログレベルがログ出力すべきかを判定
 */
function shouldLog(level: LogLevel): boolean {
  const currentLevel = getCurrentLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * デバッグログを出力（LOG_LEVEL=debugの場合のみ）
 */
export function debugLog(...args: any[]): void {
  if (shouldLog('debug')) {
    console.log(...args);
  }
}

/**
 * 情報ログを出力（LOG_LEVEL=info以下の場合）
 */
export function infoLog(...args: any[]): void {
  if (shouldLog('info')) {
    console.log(...args);
  }
}

/**
 * 警告ログを出力（LOG_LEVEL=warn以下の場合）
 */
export function warnLog(...args: any[]): void {
  if (shouldLog('warn')) {
    console.warn(...args);
  }
}

/**
 * エラーログを出力（常に出力）
 */
export function errorLog(...args: any[]): void {
  if (shouldLog('error')) {
    console.error(...args);
  }
}
