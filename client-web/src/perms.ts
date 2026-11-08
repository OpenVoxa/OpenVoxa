// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Staff: anyone holding a permission switch other than Direct messages,
 * which is an everyday ability Members carry by default (perm.Set.Staff
 * on the server draws the same line).
 */
export const isStaffPerms = (perms: readonly string[]): boolean =>
  perms.some((p) => p !== "direct_messages");
