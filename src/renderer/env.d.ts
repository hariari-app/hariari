import type { HariariApi } from '../shared/ipc-types';

declare const APP_VERSION: string;

declare global {
  interface Window {
    api: HariariApi;
  }
}
