import { postProcessTranscription, type PostProcessMode } from './voice-postprocessor';
import { formatWithLLM } from './voice-formatter';

export type VoiceState = 'idle' | 'listening' | 'processing' | 'error';
export type VoiceTranscriptCallback = (text: string) => void;
export type VoiceStateCallback = (state: VoiceState) => void;

// Extend Window type for webkitSpeechRecognition
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
  readonly resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
    SpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

// Voice settings are cached in memory, loaded from ~/.vibeide/settings.json via IPC
let voiceSettings: { apiKey: string; provider: string; postProcessMode: string; deviceId: string } = { apiKey: '', provider: 'openai', postProcessMode: 'command', deviceId: '' };
let settingsLoaded = false;

async function loadVoiceSettings(): Promise<void> {
  if (settingsLoaded) return;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const all = await window.api.settings.load();
      if (all && typeof all === 'object' && !('error' in all)) {
        voiceSettings = {
          apiKey: (all.voiceApiKey as string) ?? '',
          provider: (all.voiceProvider as string) ?? 'openai',
          postProcessMode: (all.voicePostProcessMode as string) ?? 'command',
          deviceId: (all.voiceDeviceId as string) ?? '',
        };
        console.log(`[VoiceCapture] Settings loaded: provider=${voiceSettings.provider}`);
        settingsLoaded = true;
        return;
      }
    } catch {
      // Handler not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function saveVoiceSettings(): void {
  window.api.settings.load().then((all) => {
    window.api.settings.save({
      ...all,
      voiceApiKey: voiceSettings.apiKey,
      voiceProvider: voiceSettings.provider,
      voicePostProcessMode: voiceSettings.postProcessMode,
      voiceDeviceId: voiceSettings.deviceId,
    });
  }).catch(() => {});
}

export class VoiceCapture {
  private recognition: SpeechRecognitionInstance | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private state: VoiceState = 'idle';
  private readonly onTranscript: VoiceTranscriptCallback;
  private readonly onStateChange: VoiceStateCallback;
  private indicatorEl: HTMLElement | null = null;
  private useMediaRecorder = false;
  private postProcessMode: PostProcessMode = 'command';
  private warmStream: MediaStream | null = null;
  private stopTailTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onTranscript: VoiceTranscriptCallback, onStateChange: VoiceStateCallback) {
    this.onTranscript = onTranscript;
    this.onStateChange = onStateChange;
    this.createIndicator();
  }

  isWebSpeechSupported(): boolean {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  getState(): VoiceState {
    return this.state;
  }

  getApiKey(): string {
    return voiceSettings.apiKey;
  }

  setApiKey(key: string): void {
    voiceSettings.apiKey = key;
    saveVoiceSettings();
  }

  getProvider(): string {
    return voiceSettings.provider;
  }

  setProvider(provider: string): void {
    voiceSettings.provider = provider;
    saveVoiceSettings();
  }

  getDeviceId(): string {
    return voiceSettings.deviceId;
  }

  setDeviceId(deviceId: string): void {
    voiceSettings.deviceId = deviceId;
    saveVoiceSettings();
  }

  getPostProcessMode(): PostProcessMode {
    return this.postProcessMode;
  }

  setPostProcessMode(mode: PostProcessMode): void {
    this.postProcessMode = mode;
    voiceSettings.provider = this.getProvider(); // trigger save with all settings
    saveVoiceSettings();
  }

  async ensureSettingsLoaded(): Promise<void> {
    await loadVoiceSettings();
    this.postProcessMode = (voiceSettings as Record<string, unknown>).postProcessMode as PostProcessMode ?? 'command';
  }

  startListening(): void {
    if (this.state === 'listening') return;

    // Skip Web Speech API — it doesn't reliably work in Electron on Linux.
    // Go straight to MediaRecorder + cloud STT.
    this.startMediaRecorder();
  }

  stopListening(): void {
    if (this.state !== 'listening') return;

    if (this.recognition) {
      this.setState('processing');
      this.recognition.stop();
    } else if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      // Tail delay — keep recording for 500ms after key release to capture final words
      this.stopTailTimer = setTimeout(() => {
        this.stopTailTimer = null;
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.setState('processing');
          this.mediaRecorder.stop();
        }
      }, 500);
    }
  }

  toggle(): void {
    if (this.state === 'listening' || this.state === 'processing') {
      this.forceStop();
    } else if (this.state === 'idle' || this.state === 'error') {
      this.startListening();
    }
  }

  forceStop(): void {
    if (this.stopTailTimer) {
      clearTimeout(this.stopTailTimer);
      this.stopTailTimer = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    } else if (this.recognition) {
      this.recognition.abort();
      this.recognition = null;
    }
    this.setState('idle');
  }

  dispose(): void {
    if (this.stopTailTimer) {
      clearTimeout(this.stopTailTimer);
      this.stopTailTimer = null;
    }
    if (this.recognition) {
      this.recognition.abort();
      this.recognition = null;
    }
    if (this.mediaRecorder) {
      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
      }
      this.mediaRecorder = null;
    }
    if (this.warmStream) {
      this.warmStream.getTracks().forEach((t) => t.stop());
      this.warmStream = null;
    }
    this.indicatorEl?.remove();
    this.indicatorEl = null;
  }

  // --- Web Speech API path ---

  private startWebSpeech(): void {
    try {
      const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.recognition = new SpeechRecognitionClass();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';
      this.recognition.maxAlternatives = 1;

      this.recognition.onstart = () => {
        this.setState('listening');
      };

      this.recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0].transcript;
          } else {
            interimTranscript += result[0].transcript;
          }
        }

        if (interimTranscript) this.updateIndicatorText(interimTranscript);
        if (finalTranscript) this.onTranscript(finalTranscript);
      };

      this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (event.error === 'aborted' || event.error === 'no-speech') {
          this.setState('idle');
        } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          // Web Speech API not available — fall back to MediaRecorder
          console.warn('[VoiceCapture] Web Speech API denied, switching to MediaRecorder');
          this.useMediaRecorder = true;
          this.recognition = null;
          this.startMediaRecorder();
        } else {
          console.error('[VoiceCapture] Web Speech error:', event.error);
          this.setState('error');
          setTimeout(() => { if (this.state === 'error') this.setState('idle'); }, 2000);
        }
      };

      this.recognition.onend = () => {
        if (this.state === 'listening') this.setState('idle');
        this.recognition = null;
      };

      this.recognition.start();
    } catch (error) {
      console.warn('[VoiceCapture] Web Speech API failed, switching to MediaRecorder:', error);
      this.useMediaRecorder = true;
      this.startMediaRecorder();
    }
  }

  // --- MediaRecorder + Cloud STT path ---

  // Pre-warm the microphone stream so PTT starts instantly
  private async ensureWarmStream(): Promise<MediaStream> {
    if (this.warmStream) {
      // Check if stream is still active
      const tracks = this.warmStream.getAudioTracks();
      if (tracks.length > 0 && tracks[0].readyState === 'live') {
        return this.warmStream;
      }
    }
    const audioConstraints: boolean | MediaTrackConstraints = voiceSettings.deviceId
      ? { deviceId: { exact: voiceSettings.deviceId } }
      : true;
    this.warmStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    return this.warmStream;
  }

  private async startMediaRecorder(): Promise<void> {
    // Ensure settings are loaded before checking API key
    await loadVoiceSettings();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.showApiKeyPrompt();
      return;
    }

    // Cancel any pending tail stop from a previous recording
    if (this.stopTailTimer) {
      clearTimeout(this.stopTailTimer);
      this.stopTailTimer = null;
    }

    try {
      const stream = await this.ensureWarmStream();
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        // Don't kill the warm stream — keep it alive for next PTT press

        if (this.audioChunks.length === 0) {
          this.setState('idle');
          return;
        }

        this.setState('processing');
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        await this.transcribeWithCloud(audioBlob);
      };

      this.mediaRecorder.onerror = () => {
        this.setState('error');
        setTimeout(() => { if (this.state === 'error') this.setState('idle'); }, 2000);
      };

      this.mediaRecorder.start(100); // Collect data every 100ms for faster chunks
      this.setState('listening');
    } catch (error) {
      console.error('[VoiceCapture] MediaRecorder failed:', error);
      this.setState('error');
      setTimeout(() => { if (this.state === 'error') this.setState('idle'); }, 2000);
    }
  }

  private async transcribeWithCloud(audioBlob: Blob): Promise<void> {
    const apiKey = this.getApiKey();
    const provider = this.getProvider();

    try {
      if (provider === 'groq' || provider === 'openai' || provider === 'deepgram') {
        // Route through main process IPC to bypass CSP and get better logging
        await this.transcribeViaIPC(audioBlob, apiKey, provider);
      } else {
        await this.transcribeViaIPC(audioBlob, apiKey, provider);
      }
    } catch (error) {
      console.error('[VoiceCapture] Transcription failed:', error);
      this.updateIndicatorText('Transcription failed');
      setTimeout(() => this.setState('idle'), 2000);
    }
  }

  private async transcribeViaIPC(audioBlob: Blob, _apiKey: string, provider: string): Promise<void> {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    // Convert to base64 in chunks to avoid call stack overflow
    let base64 = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8.length; i += chunkSize) {
      base64 += String.fromCharCode(...uint8.slice(i, i + chunkSize));
    }
    base64 = btoa(base64);

    // API key is read from settings in main process — not sent from renderer
    const result = await window.api.voice.transcribe({ provider, audioBase64: base64 });

    if (result.error) {
      throw new Error(`Transcription error: ${result.error}`);
    }

    const rawText = result.text?.trim();
    if (rawText) {
      const formatted = await this.applyFormatting(rawText);
      this.onTranscript(formatted);
    }
    this.setState('idle');
  }

  private async applyFormatting(rawText: string): Promise<string> {
    if (this.postProcessMode === 'command' || this.postProcessMode === 'code') {
      const apiKey = this.getApiKey();
      const provider = this.getProvider();
      if (apiKey && (provider === 'groq' || provider === 'openai')) {
        try {
          const llmResult = await formatWithLLM(rawText, apiKey, provider);
          if (llmResult && llmResult !== rawText) return llmResult;
        } catch { /* fall through */ }
      }
    }
    return postProcessTranscription(rawText, this.postProcessMode);
  }

  private async transcribeOpenAI(audioBlob: Blob, apiKey: string): Promise<void> {
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const result = await response.json();
    const text = result.text?.trim();
    if (text) {
      this.onTranscript(text);
    }
    this.setState('idle');
  }

  private async transcribeGroq(audioBlob: Blob, apiKey: string): Promise<void> {
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status}`);
    }

    const result = await response.json();
    const rawText = result.text?.trim();
    if (rawText) {
      const formatted = await this.applyFormatting(rawText);
      this.onTranscript(formatted);
    }
    this.setState('idle');
  }

  // --- API key prompt ---

  async showSetup(): Promise<void> {
    await this.ensureSettingsLoaded();
    this.showApiKeyPrompt();
  }

  private showApiKeyPrompt(): void {
    const existing = document.querySelector('.voice-api-key-dialog');
    if (existing) { existing.remove(); }

    const overlay = document.createElement('div');
    overlay.className = 'voice-api-key-dialog';

    const card = document.createElement('div');
    card.className = 'voice-api-key-card';

    const title = document.createElement('h3');
    title.textContent = 'Voice Input Setup';
    title.style.margin = '0 0 8px';

    const desc = document.createElement('p');
    desc.textContent = 'Enter your OpenAI or Deepgram API key for speech-to-text:';
    desc.style.cssText = 'margin: 0 0 12px; color: var(--fg-dim); font-size: 13px;';

    const providerSelect = document.createElement('select');
    providerSelect.className = 'voice-api-key-select';
    const providers = [
      { value: 'groq', label: 'Groq Whisper (fast)' },
      { value: 'openai', label: 'OpenAI Whisper' },
      { value: 'deepgram', label: 'Deepgram Nova' },
    ];
    for (const opt of providers) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === this.getProvider()) option.selected = true;
      providerSelect.appendChild(option);
    }

    const input = document.createElement('input');
    input.className = 'voice-api-key-input';
    input.type = 'password';
    input.placeholder = 'sk-... or gsk_...';
    input.value = this.getApiKey();

    const modeLabel = document.createElement('p');
    modeLabel.textContent = 'Voice mode:';
    modeLabel.style.cssText = 'margin: 12px 0 4px; color: var(--fg-dim); font-size: 13px;';

    const modeSelect = document.createElement('select');
    modeSelect.className = 'voice-api-key-select';
    const modes = [
      { value: 'command', label: 'Command — converts symbols & case (e.g. "forward slash help" → /help)' },
      { value: 'code', label: 'Code — symbols & abbreviations, no terminal shortcuts' },
      { value: 'natural', label: 'Natural — raw transcription, no transformations' },
    ];
    for (const m of modes) {
      const option = document.createElement('option');
      option.value = m.value;
      option.textContent = m.label;
      if (m.value === this.postProcessMode) option.selected = true;
      modeSelect.appendChild(option);
    }

    const deviceLabel = document.createElement('p');
    deviceLabel.textContent = 'Microphone:';
    deviceLabel.style.cssText = 'margin: 12px 0 4px; color: var(--fg-dim); font-size: 13px;';

    const deviceSelect = document.createElement('select');
    deviceSelect.className = 'voice-api-key-select';

    // Default option while loading
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'System Default';
    deviceSelect.appendChild(defaultOpt);

    // Enumerate audio devices async
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      deviceSelect.replaceChildren();

      const sysDefault = document.createElement('option');
      sysDefault.value = '';
      sysDefault.textContent = 'System Default';
      if (!voiceSettings.deviceId) sysDefault.selected = true;
      deviceSelect.appendChild(sysDefault);

      for (const device of audioInputs) {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Microphone ${device.deviceId.slice(0, 8)}`;
        if (device.deviceId === voiceSettings.deviceId) opt.selected = true;
        deviceSelect.appendChild(opt);
      }
    }).catch(() => {
      // Can't enumerate — keep default option
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'voice-api-key-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'voice-api-key-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const key = input.value.trim();
      if (!key) return;
      this.setApiKey(key);
      this.setProvider(providerSelect.value);
      this.setDeviceId(deviceSelect.value);
      this.postProcessMode = modeSelect.value as PostProcessMode;
      voiceSettings.postProcessMode = modeSelect.value;
      saveVoiceSettings();
      overlay.remove();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') overlay.remove();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(providerSelect);
    card.appendChild(input);
    card.appendChild(deviceLabel);
    card.appendChild(deviceSelect);
    card.appendChild(modeLabel);
    card.appendChild(modeSelect);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    input.focus();
  }

  // --- UI ---

  private setState(state: VoiceState): void {
    this.state = state;
    this.onStateChange(state);
    this.updateIndicator();
  }

  private lastErrorReason = '';

  private createIndicator(): void {
    this.indicatorEl = document.createElement('div');
    this.indicatorEl.className = 'voice-indicator';

    // Accessibility
    this.indicatorEl.setAttribute('role', 'status');
    this.indicatorEl.setAttribute('aria-live', 'polite');
    this.indicatorEl.setAttribute('aria-atomic', 'true');

    const dot = document.createElement('span');
    dot.className = 'voice-indicator-dot';

    const modeBadge = document.createElement('span');
    modeBadge.className = 'voice-indicator-mode';

    const label = document.createElement('span');
    label.className = 'voice-indicator-label';
    label.textContent = 'Listening...';

    const text = document.createElement('span');
    text.className = 'voice-indicator-text';

    this.indicatorEl.appendChild(dot);
    this.indicatorEl.appendChild(modeBadge);
    this.indicatorEl.appendChild(label);
    this.indicatorEl.appendChild(text);
    document.body.appendChild(this.indicatorEl);
  }

  private updateIndicatorText(text: string): void {
    if (!this.indicatorEl) return;
    const textEl = this.indicatorEl.querySelector('.voice-indicator-text');
    if (textEl) textEl.textContent = text;
  }

  private updateModeLabel(): void {
    if (!this.indicatorEl) return;
    const modeBadge = this.indicatorEl.querySelector('.voice-indicator-mode') as HTMLElement;
    if (modeBadge) {
      const modeLabels: Record<string, string> = { natural: 'Dictation', command: 'Command', code: 'Code' };
      modeBadge.textContent = modeLabels[this.postProcessMode] ?? this.postProcessMode;
    }
  }

  showDoneState(transcript: string): void {
    if (!this.indicatorEl) return;
    const dot = this.indicatorEl.querySelector('.voice-indicator-dot') as HTMLElement;
    const label = this.indicatorEl.querySelector('.voice-indicator-label') as HTMLElement;

    this.indicatorEl.className = 'voice-indicator done visible';
    if (dot) dot.className = 'voice-indicator-dot done';
    if (label) label.textContent = 'Done';
    this.updateIndicatorText(transcript.slice(0, 60));

    setTimeout(() => {
      this.indicatorEl?.classList.remove('visible');
    }, 800);
  }

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    const dot = this.indicatorEl.querySelector('.voice-indicator-dot') as HTMLElement;
    const label = this.indicatorEl.querySelector('.voice-indicator-label') as HTMLElement;

    switch (this.state) {
      case 'listening':
        this.indicatorEl.className = 'voice-indicator listening visible';
        if (dot) dot.className = 'voice-indicator-dot recording';
        if (label) label.textContent = 'Listening...';
        this.updateModeLabel();
        this.updateIndicatorText('');
        break;
      case 'processing':
        this.indicatorEl.className = 'voice-indicator processing visible';
        if (dot) dot.className = 'voice-indicator-dot processing';
        if (label) label.textContent = 'Transcribing...';
        break;
      case 'error':
        this.indicatorEl.className = 'voice-indicator error visible';
        if (dot) dot.className = 'voice-indicator-dot error';
        if (label) label.textContent = 'Voice error';
        this.updateIndicatorText(this.lastErrorReason || 'Try again');
        setTimeout(() => {
          this.indicatorEl?.classList.remove('visible');
          if (this.state === 'error') this.state = 'idle';
        }, 3500);
        break;
      case 'idle':
        this.indicatorEl?.classList.remove('visible');
        break;
    }
  }
}
