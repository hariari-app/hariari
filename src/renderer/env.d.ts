import type { VibeIDEApi } from '../shared/ipc-types';

declare const APP_VERSION: string;

declare global {
  interface Window {
    api: VibeIDEApi;
  }
}
