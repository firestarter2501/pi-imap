/**
 * pi-imap: IMAP tools for the pi coding agent.
 *
 * Two modes:
 *   - read-only  (default): only tools that never change the mailbox are active.
 *   - read-write           : tools to flag, move and delete messages are added.
 *
 * Only the user can switch modes (with /imap-mode, the --imap-mode flag or the
 * IMAP_MODE environment variable). The model cannot switch modes itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as imap from "./imap.ts";

type Mode = "read-only" | "read-write";

const WRITE_TOOLS = ["imap_set_flags", "imap_move", "imap_delete"];

/** Longest message body returned to the model unless it asks for more. */
const DEFAULT_MAX_CHARS = 20_000;

function parseMode(value: unknown): Mode | undefined {
	if (value === "read-only" || value === "read-write") return value;
	return undefined;
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = "read-only";

	pi.registerFlag("imap-mode", {
		description: "IMAP access mode: read-only (default) or read-write",
		type: "string",
	});

	/** Activate or deactivate the write tools to match the current mode. */
	function applyMode(ctx: ExtensionContext) {
		const others = pi.getActiveTools().filter((name) => !WRITE_TOOLS.includes(name));
		pi.setActiveTools(mode === "read-write" ? [...others, ...WRITE_TOOLS] : others);
		const theme = ctx.ui.theme;
		const label = mode === "read-write" ? theme.fg("warning", "read-write") : theme.fg("success", "read-only");
		ctx.ui.setStatus("imap", `${theme.fg("dim", "IMAP:")} ${label}`);
	}

	/** Second line of defence: write tools refuse to run in read-only mode. */
	function requireWriteMode() {
		if (mode !== "read-write") {
			throw new Error("IMAP is in read-only mode. Ask the user to run /imap-mode read-write.");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const requested = pi.getFlag("imap-mode") ?? process.env.IMAP_MODE;
		if (requested !== undefined && parseMode(requested) === undefined) {
			ctx.ui.notify(`Unknown IMAP mode "${requested}", using read-only`, "warning");
		}
		mode = parseMode(requested) ?? "read-only";
		applyMode(ctx);
	});

	pi.registerCommand("imap-mode", {
		description: "Show or switch IMAP mode: /imap-mode [read-only|read-write]",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				ctx.ui.notify(`IMAP mode: ${mode}`, "info");
				return;
			}
			const next = parseMode(arg);
			if (!next) {
				ctx.ui.notify("Usage: /imap-mode [read-only|read-write]", "error");
				return;
			}
			mode = next;
			applyMode(ctx);
			ctx.ui.notify(`IMAP mode: ${mode}`, "info");
		},
	});

	// -------------------------------------------------------------------------
	// Read tools (always available)
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "imap_list_mailboxes",
		label: "IMAP: list mailboxes",
		description: "List all IMAP mailboxes (folders) with their message and unseen counts.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true },
		async execute() {
			const boxes = await imap.listMailboxes(imap.configFromEnv());
			const lines = boxes.map((b) => {
				const special = b.specialUse ? ` ${b.specialUse}` : "";
				return `${b.path}${special} (messages: ${b.messages ?? "?"}, unseen: ${b.unseen ?? "?"})`;
			});
			return text(lines.join("\n") || "No mailboxes found.");
		},
	});

	pi.registerTool({
		name: "imap_search",
		label: "IMAP: search",
		description:
			"Search messages in a mailbox. Returns UID, date, sender, recipient, subject and flags, newest first. " +
			"All filters are optional and combined with AND. Use imap_read with a UID to read a message.",
		parameters: Type.Object({
			mailbox: Type.Optional(Type.String({ description: "Mailbox path (default INBOX)" })),
			from: Type.Optional(Type.String({ description: "Sender contains this text" })),
			to: Type.Optional(Type.String({ description: "Recipient contains this text" })),
			subject: Type.Optional(Type.String({ description: "Subject contains this text" })),
			body: Type.Optional(Type.String({ description: "Body contains this text" })),
			since: Type.Optional(Type.String({ description: "On or after this date (YYYY-MM-DD)" })),
			before: Type.Optional(Type.String({ description: "Before this date (YYYY-MM-DD)" })),
			unseenOnly: Type.Optional(Type.Boolean({ description: "Only unread messages" })),
			limit: Type.Optional(Type.Integer({ description: "Maximum results (default 20)", minimum: 1, maximum: 200 })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const { mailbox = "INBOX", ...options } = params;
			const messages = await imap.searchMessages(imap.configFromEnv(), mailbox, options);
			if (messages.length === 0) return text(`No messages found in ${mailbox}.`);
			const lines = messages.map(
				(m) =>
					`UID ${m.uid} | ${m.date ?? "?"} | from: ${m.from ?? "?"} | to: ${m.to ?? "?"} | ` +
					`subject: ${m.subject ?? "(no subject)"} | flags: ${m.flags.join(" ") || "-"}`,
			);
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "imap_read",
		label: "IMAP: read message",
		description:
			"Read one message by UID: headers, plain-text body and attachment list. " +
			"Reading does not mark the message as seen.",
		parameters: Type.Object({
			mailbox: Type.Optional(Type.String({ description: "Mailbox path (default INBOX)" })),
			uid: Type.Integer({ description: "Message UID (from imap_search)", minimum: 1 }),
			maxChars: Type.Optional(
				Type.Integer({ description: `Truncate body after this many characters (default ${DEFAULT_MAX_CHARS})`, minimum: 1 }),
			),
		}),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const mailbox = params.mailbox ?? "INBOX";
			const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
			const m = await imap.readMessage(imap.configFromEnv(), mailbox, params.uid);

			let body = m.text;
			if (body.length > maxChars) {
				body = `${body.slice(0, maxChars)}\n\n[truncated: ${m.text.length} characters in total, raise maxChars to see more]`;
			}
			const attachments = m.attachments.map((a) => `- ${a.filename ?? "(unnamed)"} (${a.contentType}, ${a.size} bytes)`);

			return text(
				[
					`UID: ${m.uid}`,
					`Date: ${m.date ?? "?"}`,
					`From: ${m.from ?? "?"}`,
					`To: ${m.to ?? "?"}`,
					...(m.cc ? [`Cc: ${m.cc}`] : []),
					`Subject: ${m.subject ?? "(no subject)"}`,
					`Flags: ${m.flags.join(" ") || "-"}`,
					...(attachments.length > 0 ? ["Attachments:", ...attachments] : []),
					"",
					body,
				].join("\n"),
			);
		},
	});

	// -------------------------------------------------------------------------
	// Write tools (only active in read-write mode)
	// -------------------------------------------------------------------------

	const uidsParam = Type.Array(Type.Integer({ minimum: 1 }), { description: "Message UIDs", minItems: 1 });

	pi.registerTool({
		name: "imap_set_flags",
		label: "IMAP: set flags",
		description:
			"Add or remove flags on messages, e.g. add [\"\\\\Seen\"] to mark as read or [\"\\\\Flagged\"] to star. " +
			"Only available in read-write mode.",
		parameters: Type.Object({
			mailbox: Type.String({ description: "Mailbox path, e.g. INBOX" }),
			uids: uidsParam,
			add: Type.Optional(Type.Array(Type.String(), { description: "Flags to add" })),
			remove: Type.Optional(Type.Array(Type.String(), { description: "Flags to remove" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async execute(_id, params) {
			requireWriteMode();
			const add = params.add ?? [];
			const remove = params.remove ?? [];
			if (add.length === 0 && remove.length === 0) throw new Error("Give at least one flag in add or remove.");
			await imap.setFlags(imap.configFromEnv(), params.mailbox, params.uids, add, remove);
			return text(`Updated flags on ${params.uids.length} message(s) in ${params.mailbox}.`);
		},
	});

	pi.registerTool({
		name: "imap_move",
		label: "IMAP: move messages",
		description: "Move messages to another mailbox. Only available in read-write mode.",
		parameters: Type.Object({
			mailbox: Type.String({ description: "Source mailbox path" }),
			uids: uidsParam,
			destination: Type.String({ description: "Destination mailbox path" }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false },
		async execute(_id, params) {
			requireWriteMode();
			await imap.moveMessages(imap.configFromEnv(), params.mailbox, params.uids, params.destination);
			return text(`Moved ${params.uids.length} message(s) from ${params.mailbox} to ${params.destination}.`);
		},
	});

	pi.registerTool({
		name: "imap_delete",
		label: "IMAP: delete messages",
		description:
			"Permanently delete messages (flag \\Deleted and expunge). Prefer imap_move to a Trash mailbox " +
			"unless the user asked for permanent deletion. Only available in read-write mode.",
		parameters: Type.Object({
			mailbox: Type.String({ description: "Mailbox path" }),
			uids: uidsParam,
		}),
		annotations: { readOnlyHint: false, destructiveHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireWriteMode();
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Delete messages permanently?",
					`${params.uids.length} message(s) in ${params.mailbox} (UIDs ${params.uids.join(", ")})`,
				);
				if (!ok) throw new Error("The user declined the deletion.");
			}
			await imap.deleteMessages(imap.configFromEnv(), params.mailbox, params.uids);
			return text(`Deleted ${params.uids.length} message(s) from ${params.mailbox}.`);
		},
	});
}
