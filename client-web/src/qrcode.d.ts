// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// The one function client-web uses from the `qrcode` package. Its
// published types (@types/qrcode) pull in all of Node's types for the
// server-side half, which a browser build has no use for.
declare module "qrcode" {
  export function toString(
    text: string,
    options: {
      type: "svg";
      errorCorrectionLevel?: "L" | "M" | "Q" | "H";
      margin?: number;
      color?: { dark?: string; light?: string };
    },
  ): Promise<string>;
}
