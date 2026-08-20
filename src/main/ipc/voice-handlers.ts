import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/constants';
import { extractDeepgramTranscript } from '../voice/deepgram-response';
import { clearVoiceApiKey, hasVoiceApiKey, readVoiceApiKey, saveVoiceApiKey } from '../voice/voice-secrets';

function loadVoiceConfig(): { provider: string; postProcessMode: string; deviceId: string; hasApiKey: boolean } {
  try {
    const filePath = path.join(os.homedir(), '.hariari', 'settings.json');
    const parsed = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : {};
    const settings = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    return {
      provider: typeof settings.voiceProvider === 'string' ? settings.voiceProvider : 'openai',
      postProcessMode: typeof settings.voicePostProcessMode === 'string' ? settings.voicePostProcessMode : 'command',
      deviceId: typeof settings.voiceDeviceId === 'string' ? settings.voiceDeviceId : '',
      hasApiKey: hasVoiceApiKey(),
    };
  } catch {
    return { provider: 'openai', postProcessMode: 'command', deviceId: '', hasApiKey: hasVoiceApiKey() };
  }
}

function saveVoiceConfig(config: { provider: string; postProcessMode: string; deviceId: string }): void {
  const filePath = path.join(os.homedir(), '.hariari', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      settings = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
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
  ipcMain.handle(IPC_CHANNELS.VOICE_CONFIG_LOAD, () => {
    try {
      return loadVoiceConfig();
    } catch {
      return { provider: 'openai', postProcessMode: 'command', deviceId: '', hasApiKey: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_CONFIG_SAVE, (_event, raw: unknown) => {
    try {
      if (!raw || typeof raw !== 'object') return { error: 'invalid_voice_config' };
      const req = raw as Record<string, unknown>;
      saveVoiceConfig({
        provider: typeof req.provider === 'string' ? req.provider : 'openai',
        postProcessMode: typeof req.postProcessMode === 'string' ? req.postProcessMode : 'command',
        deviceId: typeof req.deviceId === 'string' ? req.deviceId : '',
      });
    } catch {
      return { error: 'voice_config_save_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_API_KEY_SET, (_event, raw: unknown) => {
    if (typeof raw !== 'string') return { success: false, error: 'invalid_api_key' };
    return saveVoiceApiKey(raw);
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_API_KEY_CLEAR, () => {
    clearVoiceApiKey();
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      const provider = req.provider as string;
      const audioBase64 = req.audioBase64 as string;
      if (!provider || !audioBase64) return { error: 'missing_fields' };

      const apiKey = req.apiKey as string | undefined || readVoiceApiKey();
      if (!apiKey) return { error: 'no_api_key' };

      const audioBuffer = Buffer.from(audioBase64, 'base64');
      console.log(`[IPC][voice:transcribe] provider=${provider}, audioSize=${audioBuffer.length} bytes`);

      let url: string;
      let model = '';
      if (provider === 'groq') {
        url = 'https://api.groq.com/openai/v1/audio/transcriptions';
        model = 'whisper-large-v3-turbo';
      } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/audio/transcriptions';
        model = 'whisper-1';
      } else if (provider === 'deepgram') {
        url = 'https://api.deepgram.com/v1/listen?model=nova-2&language=en';
      } else {
        return { error: 'unsupported_provider_for_ipc' };
      }

      if (provider === 'deepgram') {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${apiKey}`,
            'Content-Type': 'audio/webm',
          },
          body: audioBuffer,
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[IPC][voice:transcribe] ${provider} API error ${response.status}:`, errText);
          return { error: `${provider}_api_error_${response.status}: ${errText}` };
        }

        const text = extractDeepgramTranscript(await response.json());
        console.log('[IPC][voice:transcribe] Success, text length:', text.length);
        return { text };
      }

      const boundary = '----HariariBoundary' + Date.now();
      const parts: Buffer[] = [];

      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`
      ));
      parts.push(audioBuffer);
      parts.push(Buffer.from('\r\n'));

      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`
      ));

      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`
      ));

      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[IPC][voice:transcribe] ${provider} API error ${response.status}:`, errText);
        return { error: `${provider}_api_error_${response.status}: ${errText}` };
      }

      const result = await response.json() as Record<string, unknown>;
      console.log('[IPC][voice:transcribe] Success, text length:', (result.text as string)?.length ?? 0);
      return { text: (result.text as string)?.trim() ?? '' };
    } catch (error) {
      console.error('[IPC][voice:transcribe] Exception:', error);
      return { error: `transcription_failed: ${error}` };
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_FORMAT_LLM, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      const provider = req.provider as string;
      const messages = req.messages as Array<{ role: string; content: string }>;
      if (!provider || !messages) return { error: 'missing_fields' };

      const apiKey = req.apiKey as string | undefined || readVoiceApiKey();
      if (!apiKey) return { error: 'no_api_key' };

      let url: string;
      let model: string;

      if (provider === 'groq') {
        url = 'https://api.groq.com/openai/v1/chat/completions';
        model = 'llama-3.1-8b-instant';
      } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        model = 'gpt-4o-mini';
      } else {
        return { error: 'unsupported_provider' };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[IPC][voice:format-llm] ${provider} error ${response.status}:`, errText);
        return { error: `llm_error_${response.status}` };
      }

      const result = await response.json() as Record<string, unknown>;
      const choices = result.choices as Array<{ message: { content: string } }>;
      const text = choices?.[0]?.message?.content?.trim() ?? '';
      return { text };
    } catch (error) {
      console.error('[IPC][voice:format-llm]', error);
      return { error: 'format_failed' };
    }
  });
}
