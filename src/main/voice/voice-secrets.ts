import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeStorage } from 'electron';

const CONFIG_DIR = path.join(os.homedir(), '.hariari');
const SECRET_PATH = path.join(CONFIG_DIR, 'voice-secrets.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

interface VoiceSecretsFile {
  readonly apiKey?: string;
}

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readSecretFile(): VoiceSecretsFile {
  try {
    if (!fs.existsSync(SECRET_PATH)) return {};
    const raw = fs.readFileSync(SECRET_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as VoiceSecretsFile : {};
  } catch {
    return {};
  }
}

function writeSecretFile(payload: VoiceSecretsFile): void {
  ensureConfigDir();
  fs.writeFileSync(SECRET_PATH, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function hasVoiceApiKey(): boolean {
  const secrets = readSecretFile();
  return typeof secrets.apiKey === 'string' && secrets.apiKey.length > 0;
}

export function readVoiceApiKey(): string {
  try {
    const encoded = readSecretFile().apiKey;
    if (!encoded || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(encoded, 'base64')).trim();
  } catch {
    return '';
  }
}

export function saveVoiceApiKey(apiKey: string): { success: boolean; error?: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) return { success: false, error: 'empty_api_key' };
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'secure_storage_unavailable' };
  }

  try {
    const encrypted = safeStorage.encryptString(trimmed).toString('base64');
    writeSecretFile({ apiKey: encrypted });
    return { success: true };
  } catch {
    return { success: false, error: 'secure_storage_failed' };
  }
}

export function clearVoiceApiKey(): void {
  try {
    if (fs.existsSync(SECRET_PATH)) {
      fs.rmSync(SECRET_PATH, { force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

export function migrateLegacyVoiceApiKey(): void {
  try {
    if (!safeStorage.isEncryptionAvailable() || hasVoiceApiKey() || !fs.existsSync(SETTINGS_PATH)) {
      return;
    }

    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;

    const legacyApiKey = typeof parsed.voiceApiKey === 'string' ? parsed.voiceApiKey.trim() : '';
    if (!legacyApiKey) return;

    const result = saveVoiceApiKey(legacyApiKey);
    if (!result.success) return;

    delete parsed.voiceApiKey;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch {
    // Migration is best-effort
  }
}
