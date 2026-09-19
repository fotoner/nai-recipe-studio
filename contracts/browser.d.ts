import type { StudioClient } from "./studio";

declare global {
  interface Window {
    studio: StudioClient;
  }
}
