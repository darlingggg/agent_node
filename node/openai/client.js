import OpenAI from 'openai';
import { encodingForModel } from 'js-tiktoken';
import { baseURL, key } from '../../key.js';

export const client = new OpenAI({ apiKey: key, baseURL });
export const tokenizer = encodingForModel('gpt-4');
export const CHAT_MODEL = process.env.AI_CHAT_MODEL || 'deepseek-v4-pro';
export const CONTEXT_LIMIT_TOKENS = Math.max(
  Number(process.env.AI_CONTEXT_LIMIT_TOKENS) || 1_000_000,
  4096,
);
const compressionRatio = Math.min(
  Math.max(Number(process.env.AI_CONTEXT_COMPRESSION_RATIO) || 0.8, 0.5),
  0.95,
);
export const CONTEXT_COMPRESSION_THRESHOLD = Math.floor(CONTEXT_LIMIT_TOKENS * compressionRatio);
export const SUMMARY_MAX_TOKENS = Math.max(
  Number(process.env.AI_SUMMARY_MAX_TOKENS) || 1600,
  256,
);
export const RECENT_USER_TURNS_TO_KEEP = Math.max(
  Number(process.env.AI_RECENT_TURNS_TO_KEEP) || 3,
  1,
);
