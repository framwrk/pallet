import type { PalletApi } from "@shared/ipc/ipc-api.types";

declare global {
  interface Window {
    pallet: PalletApi;
  }
}

export {};
