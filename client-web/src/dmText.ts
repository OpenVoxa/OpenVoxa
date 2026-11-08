// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Words and rules for direct messages, shared by the sidebar (dms.tsx)
 * and the message pane (ChannelPane.tsx). */

import type { DMInfo } from "@core/chat";
import { isStaffPerms } from "./perms";

/** Whether these permissions may send direct messages: the switch, or
 * staff (any other switch), as the server's mayDMSQL. */
export const mayDM = (perms: readonly string[]): boolean =>
  perms.includes("direct_messages") || isStaffPerms(perms);

/** Why the + and "Message" are greyed out for someone who may not DM. */
export const NO_DM_REASON = "You can't send direct messages on this server";

/** The name to show for the other person. */
export const dmName = (d: DMInfo): string => d.user.username || "Deleted user";

/** Why a conversation is read-only, for the greyed-out message box. */
export function readOnlyText(d: DMInfo): string {
  const name = dmName(d);
  switch (d.read_only_reason) {
    case "you_blocked": return `You blocked ${name}. Unblock them to send messages.`;
    case "you_cannot": return "You can't send direct messages on this server.";
    case "deleted": return "This account was deleted.";
    default: return `${name} can't receive direct messages right now.`;
  }
}
