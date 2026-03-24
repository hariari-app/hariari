import type { VibeIDEApi } from '../shared/ipc-types';

declare global {
  interface Window {
    api: VibeIDEApi;
  }
}
