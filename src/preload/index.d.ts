import type { PalletApi } from "../shared/api";

declare global {
  interface Window {
    pallet: PalletApi;
  }
}

export {};
