import winston from 'winston';
import 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';

// Format IST timestamp per §2.5 explicitly
export function getISTTimestamp(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function getISTDateString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

const logsDir = path.resolve(process.cwd(), 'logs');
const mtmDir = path.resolve(logsDir, 'mtm');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
if (!fs.existsSync(mtmDir)) fs.mkdirSync(mtmDir, { recursive: true });

const logFormat = winston.format.printf(({ level, message }) => {
  return `[${getISTTimestamp()}] [${level.toUpperCase()}]: ${message}`;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(winston.format.timestamp(), logFormat),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      dirname: logsDir,
      filename: 'banknifty-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
  ],
});
