import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/constants';
import { extractDeepgramTranscript } from '../voice/deepgram-response';
import {
  clearVoiceApiKey,
  hasVoiceApiKey,
  readVoiceApiKey,
  saveVoiceApiKey,
} from '../voice/voice-secrets';

type VoiceConfig = {
  provider: string;
  postProcessMode: string;
  deviceId: string;
  hasApiKey: boolean;
};

type VoiceConfigSaveRequest = {
  provider: string;
  postProcessMode: string;
  deviceId: string;
};

type VoiceTranscriptionRequest = {
  provider: string;
  audioBase64: string;
  apiKey?: string;
};

type VoiceFormatRequest = {
  provider: string;
  messages: Array<{ role: string; content: string }>;
  apiKey?: string;
};

function loadVoiceConfig(): VoiceConfig {
  try {
    const filePath = path.join(os.homedir(), '.hariari', 'settings.json');
    const parsed = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : {};
    const settings =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return {
      provider: typeof settings.voiceProvider === 'string' ? settings.voiceProvider : 'openai',
      postProcessMode:
        typeof settings.voicePostProcessMode === 'string'
          ? settings.voicePostProcessMode
          : 'command',
      deviceId: typeof settings.voiceDeviceId === 'string' ? settings.voiceDeviceId : '',
      hasApiKey: hasVoiceApiKey(),
    };
  } catch {
    return {
      provider: 'openai',
      postProcessMode: 'command',
      deviceId: '',
      hasApiKey: hasVoiceApiKey(),
    };
  }
}

function saveVoiceConfig(config: VoiceConfigSaveRequest): void {
  const filePath = path.join(os.homedir(), '.hariari', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      settings = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    }
  } catch {
    settings = {};
  }

  delete settings.voiceApiKey;
  settings.voiceProvider = config.provider;
  settings.voicePostProcessMode = config.postProcessMode;
  settings.voiceDeviceId = config.deviceId;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

export function registerVoiceHandlers(): void {
  registerVoiceConfigLoadHandler();
  registerVoiceConfigSaveHandler();
  registerVoiceApiKeySetHandler();
  registerVoiceApiKeyClearHandler();
  registerVoiceTranscribeHandler();
  registerVoiceFormatHandler();
}

function registerVoiceConfigLoadHandler(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_CONFIG_LOAD, () => handleVoiceConfigLoad());
}

function handleVoiceConfigLoad(): VoiceConfig {
  try {
    return loadVoiceConfig();
  } catch {
    return { provider: 'openai', postProcessMode: 'command', deviceId: '', hasApiKey: false };
  }
}

function registerVoiceConfigSaveHandler(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_CONFIG_SAVE, (_event, raw: unknown) =>
    handleVoiceConfigSave(raw),
  );
}

function handleVoiceConfigSave(raw: unknown): unknown {
  try {
    const request = parseVoiceConfigSaveRequest(raw);
    if (!request) return { error: 'invalid_voice_config' };
    saveVoiceConfig(request);
  } catch {
    return { error: 'voice_config_save_failed' };
  }
}

function registerVoiceApiKeySetHandler(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_API_KEY_SET, (_event, raw: unknown) =>
    typeof raw === 'string' ? saveVoiceApiKey(raw) : { success: false, error: 'invalid_api_key' },
  );
}

function registerVoiceApiKeyClearHandler(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_API_KEY_CLEAR, () => clearVoiceApiKey());
}

function registerVoiceTranscribeHandler(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, (_event, raw: unknown) =>
    handleVoiceTranscribe(raw),
  );
}

async function handleVoiceTranscribe(raw: unknown): Promise<unknown> {
  try {
    const request = parseVoiceTranscriptionRequest(raw);
    if (!request) return { error: 'invalid_request' };
    if (!request.provider || !request.audioBase64) return { error: 'missing_fields' };
    const apiKey = request.apiKey || readVoiceApiKey();
    if (!apiKey) return { error: 'no_api_key' };
    return await transcribeAudio(request, apiKey);
  } catch (error) {
    console.error('[IPC][voice:transcribe] Exception:', error);
    return { error: `transcription_failed: ${error}` };
  }
}

function registerVoiceFormatHandler(): void {
  ipcMain.handle(IPC_CHANNELS.VOICE_FORMAT_LLM, (_event, raw: unknown) => handleVoiceFormat(raw));
}

async function handleVoiceFormat(raw: unknown): Promise<unknown> {
  try {
    const request = parseVoiceFormatRequest(raw);
    if (!request) return { error: 'invalid_request' };
    if (!request.provider || !request.messages) return { error: 'missing_fields' };
    const apiKey = request.apiKey || readVoiceApiKey();
    if (!apiKey) return { error: 'no_api_key' };
    return await formatVoiceWithLlm(request, apiKey);
  } catch (error) {
    console.error('[IPC][voice:format-llm]', error);
    return { error: 'format_failed' };
  }
}

function parseVoiceConfigSaveRequest(raw: unknown): VoiceConfigSaveRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  return {
    provider: typeof request.provider === 'string' ? request.provider : 'openai',
    postProcessMode:
      typeof request.postProcessMode === 'string' ? request.postProcessMode : 'command',
    deviceId: typeof request.deviceId === 'string' ? request.deviceId : '',
  };
}

function parseVoiceTranscriptionRequest(raw: unknown): VoiceTranscriptionRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  return {
    provider: typeof request.provider === 'string' ? request.provider : '',
    audioBase64: typeof request.audioBase64 === 'string' ? request.audioBase64 : '',
    apiKey: typeof request.apiKey === 'string' ? request.apiKey : undefined,
  };
}

function parseVoiceFormatRequest(raw: unknown): VoiceFormatRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (!Array.isArray(request.messages)) return null;
  return {
    provider: typeof request.provider === 'string' ? request.provider : '',
    messages: request.messages as Array<{ role: string; content: string }>,
    apiKey: typeof request.apiKey === 'string' ? request.apiKey : undefined,
  };
}

async function transcribeAudio(
  request: VoiceTranscriptionRequest,
  apiKey: string,
): Promise<unknown> {
  const audioBuffer = Buffer.from(request.audioBase64, 'base64');
  console.log(
    `[IPC][voice:transcribe] provider=${request.provider}, audioSize=${audioBuffer.length} bytes`,
  );
  const endpoint = resolveTranscriptionEndpoint(request.provider);
  if (!endpoint) return { error: 'unsupported_provider_for_ipc' };
  return endpoint.kind === 'deepgram'
    ? transcribeWithDeepgram(endpoint.url, apiKey, audioBuffer, request.provider)
    : transcribeWithMultipart(endpoint, apiKey, audioBuffer, request.provider);
}

function resolveTranscriptionEndpoint(
  provider: string,
): { kind: 'deepgram'; url: string } | { kind: 'multipart'; url: string; model: string } | null {
  if (provider === 'groq') {
    return {
      kind: 'multipart',
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo',
    };
  }
  if (provider === 'openai') {
    return {
      kind: 'multipart',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
    };
  }
  if (provider === 'deepgram') {
    return { kind: 'deepgram', url: 'https://api.deepgram.com/v1/listen?model=nova-2&language=en' };
  }
  return null;
}

async function transcribeWithDeepgram(
  url: string,
  apiKey: string,
  audioBuffer: Buffer,
  provider: string,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/webm' },
    body: toRequestBody(audioBuffer, 'audio/webm'),
  });
  if (!response.ok) return logVoiceApiError('voice:transcribe', provider, response);
  const text = extractDeepgramTranscript(await response.json());
  console.log('[IPC][voice:transcribe] Success, text length:', text.length);
  return { text };
}

async function transcribeWithMultipart(
  endpoint: { url: string; model: string },
  apiKey: string,
  audioBuffer: Buffer,
  provider: string,
): Promise<unknown> {
  const boundary = `----HariariBoundary${Date.now()}`;
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: toRequestBody(
      buildMultipartAudioBody(boundary, endpoint.model, audioBuffer),
      `multipart/form-data; boundary=${boundary}`,
    ),
  });
  if (!response.ok) return logVoiceApiError('voice:transcribe', provider, response);
  const result = (await response.json()) as Record<string, unknown>;
  const text = (result.text as string)?.trim() ?? '';
  console.log('[IPC][voice:transcribe] Success, text length:', text.length);
  return { text };
}

function buildMultipartAudioBody(boundary: string, model: string, audioBuffer: Buffer): Buffer {
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
    ),
    audioBuffer,
    Buffer.from('\r\n'),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    ),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ];
  return Buffer.concat(parts);
}

function toRequestBody(buffer: Buffer, type: string): Blob {
  return new Blob([Uint8Array.from(buffer)], { type });
}

async function formatVoiceWithLlm(request: VoiceFormatRequest, apiKey: string): Promise<unknown> {
  const endpoint = resolveVoiceFormatEndpoint(request.provider);
  if (!endpoint) return { error: 'unsupported_provider' };
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.model,
      messages: request.messages,
      temperature: 0.1,
      max_tokens: 500,
    }),
  });
  if (!response.ok) return logVoiceFormatError(request.provider, response);
  const result = (await response.json()) as Record<string, unknown>;
  const choices = result.choices as Array<{ message: { content: string } }>;
  return { text: choices?.[0]?.message?.content?.trim() ?? '' };
}

function resolveVoiceFormatEndpoint(provider: string): { url: string; model: string } | null {
  if (provider === 'groq') {
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
    };
  }
  if (provider === 'openai') {
    return { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' };
  }
  return null;
}

async function logVoiceApiError(
  scope: string,
  provider: string,
  response: Response,
): Promise<unknown> {
  const errText = await response.text();
  console.error(`[IPC][${scope}] ${provider} API error ${response.status}:`, errText);
  return { error: `${provider}_api_error_${response.status}: ${errText}` };
}

async function logVoiceFormatError(provider: string, response: Response): Promise<unknown> {
  const errText = await response.text();
  console.error(`[IPC][voice:format-llm] ${provider} error ${response.status}:`, errText);
  return { error: `llm_error_${response.status}` };
}
