/**
 * Small wrapper around imapflow.
 *
 * Every function opens a connection, does one job, and logs out again.
 * That is slower than keeping a connection open, but there is no state to
 * manage and nothing can leak between tool calls.
 */

import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";

export interface ImapConfig {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	password: string;
	/** Set to false only for servers with self-signed certificates. */
	rejectUnauthorized: boolean;
	/** Give up when connecting, or when the server stays silent, for this many milliseconds. */
	timeoutMs: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;

/** Read connection settings from environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ImapConfig {
	const missing = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"].filter((name) => !env[name]);
	if (missing.length > 0) {
		throw new Error(`IMAP is not configured. Missing environment variables: ${missing.join(", ")}`);
	}
	const port = Number(env.IMAP_PORT ?? 993);
	const timeoutSeconds = Number(env.IMAP_TIMEOUT ?? DEFAULT_TIMEOUT_SECONDS);
	if (!(timeoutSeconds > 0)) {
		throw new Error(`IMAP_TIMEOUT must be a positive number of seconds, got "${env.IMAP_TIMEOUT}"`);
	}
	return {
		host: env.IMAP_HOST!,
		port,
		// Use implicit TLS by default. Set IMAP_SECURE=false for STARTTLS / plain servers.
		secure: env.IMAP_SECURE ? env.IMAP_SECURE !== "false" : port === 993,
		user: env.IMAP_USER!,
		password: env.IMAP_PASSWORD!,
		rejectUnauthorized: env.IMAP_TLS_REJECT_UNAUTHORIZED !== "false",
		timeoutMs: timeoutSeconds * 1000,
	};
}

/** Connect, run `fn`, and always log out afterwards. Exported for tests. */
export async function withClient<T>(config: ImapConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
	const client = new ImapFlow({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: { user: config.user, pass: config.password },
		tls: { rejectUnauthorized: config.rejectUnauthorized },
		connectionTimeout: config.timeoutMs,
		greetingTimeout: config.timeoutMs,
		socketTimeout: config.timeoutMs,
		logger: false,
	});
	// Once connected, imapflow reports a dead connection (socket timeout, TLS or
	// network error) as an 'error' event and fails the pending command with a
	// generic "Connection not available". An 'error' event without a listener is
	// thrown by Node and would take the whole pi process down, so catch it here
	// and report it as the reason the command failed.
	let connectionError: Error | undefined;
	client.on("error", (err: Error) => {
		connectionError ??= err;
	});
	await client.connect();
	try {
		return await fn(client);
	} catch (err) {
		if (connectionError) {
			throw new Error(`IMAP connection failed: ${connectionError.message}`, { cause: connectionError });
		}
		throw err;
	} finally {
		await client.logout().catch(() => client.close());
	}
}

/**
 * Open a mailbox, run `fn`, and release the mailbox again.
 * With `readOnly: true` the mailbox is opened with EXAMINE, so the server
 * will not change anything (not even the \Seen flag).
 */
async function withMailbox<T>(
	config: ImapConfig,
	mailbox: string,
	readOnly: boolean,
	fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
	return withClient(config, async (client) => {
		const lock = await client.getMailboxLock(mailbox, { readOnly });
		try {
			return await fn(client);
		} finally {
			lock.release();
		}
	});
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export interface MailboxInfo {
	path: string;
	specialUse?: string;
	messages?: number;
	unseen?: number;
}

export async function listMailboxes(config: ImapConfig): Promise<MailboxInfo[]> {
	return withClient(config, async (client) => {
		const mailboxes = await client.list({ statusQuery: { messages: true, unseen: true } });
		return mailboxes.map((box) => ({
			path: box.path,
			specialUse: box.specialUse || undefined,
			messages: box.status?.messages,
			unseen: box.status?.unseen,
		}));
	});
}

export interface SearchOptions {
	from?: string;
	to?: string;
	subject?: string;
	body?: string;
	/** ISO date (YYYY-MM-DD). Messages on or after this day. */
	since?: string;
	/** ISO date (YYYY-MM-DD). Messages before this day. */
	before?: string;
	unseenOnly?: boolean;
	/** Maximum number of results (newest first). */
	limit?: number;
}

export interface MessageSummary {
	uid: number;
	date?: string;
	from?: string;
	to?: string;
	subject?: string;
	flags: string[];
}

export async function searchMessages(
	config: ImapConfig,
	mailbox: string,
	options: SearchOptions,
): Promise<MessageSummary[]> {
	const query: SearchObject = {};
	if (options.from) query.from = options.from;
	if (options.to) query.to = options.to;
	if (options.subject) query.subject = options.subject;
	if (options.body) query.body = options.body;
	if (options.since) query.since = new Date(options.since);
	if (options.before) query.before = new Date(options.before);
	if (options.unseenOnly) query.seen = false;
	if (Object.keys(query).length === 0) query.all = true;

	const limit = options.limit ?? 20;

	return withMailbox(config, mailbox, true, async (client) => {
		const found = (await client.search(query, { uid: true })) || [];
		// Higher UIDs are newer, so keep the last `limit` ones.
		const uids = found.sort((a, b) => a - b).slice(-limit);
		if (uids.length === 0) return [];

		const results: MessageSummary[] = [];
		for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
			results.push({
				uid: msg.uid,
				date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : undefined,
				from: formatAddresses(msg.envelope?.from),
				to: formatAddresses(msg.envelope?.to),
				subject: msg.envelope?.subject,
				flags: [...(msg.flags ?? [])],
			});
		}
		return results.sort((a, b) => b.uid - a.uid);
	});
}

export interface FullMessage {
	uid: number;
	date?: string;
	from?: string;
	to?: string;
	cc?: string;
	subject?: string;
	flags: string[];
	text: string;
	attachments: { filename?: string; contentType: string; size: number }[];
}

export async function readMessage(config: ImapConfig, mailbox: string, uid: number): Promise<FullMessage> {
	return withMailbox(config, mailbox, true, async (client) => {
		const msg = await client.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
		if (!msg || !msg.source) {
			throw new Error(`Message UID ${uid} not found in ${mailbox}`);
		}
		const parsed = await simpleParser(msg.source);
		return {
			uid: msg.uid,
			date: parsed.date?.toISOString(),
			from: parsed.from?.text,
			to: addressText(parsed.to),
			cc: addressText(parsed.cc),
			subject: parsed.subject,
			flags: [...(msg.flags ?? [])],
			// mailparser converts HTML-only messages to text for us.
			text: parsed.text ?? "",
			attachments: parsed.attachments.map((a) => ({
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			})),
		};
	});
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export async function setFlags(
	config: ImapConfig,
	mailbox: string,
	uids: number[],
	add: string[],
	remove: string[],
): Promise<void> {
	await withMailbox(config, mailbox, false, async (client) => {
		const range = uids.join(",");
		if (add.length > 0) await client.messageFlagsAdd(range, add, { uid: true });
		if (remove.length > 0) await client.messageFlagsRemove(range, remove, { uid: true });
	});
}

export async function moveMessages(
	config: ImapConfig,
	mailbox: string,
	uids: number[],
	destination: string,
): Promise<void> {
	await withMailbox(config, mailbox, false, async (client) => {
		const result = await client.messageMove(uids.join(","), destination, { uid: true });
		if (!result) throw new Error(`Could not move messages to ${destination}`);
	});
}

export async function deleteMessages(config: ImapConfig, mailbox: string, uids: number[]): Promise<void> {
	await withMailbox(config, mailbox, false, async (client) => {
		const ok = await client.messageDelete(uids.join(","), { uid: true });
		if (!ok) throw new Error("Could not delete messages");
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAddresses(list?: { name?: string; address?: string }[]): string | undefined {
	if (!list || list.length === 0) return undefined;
	return list.map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""))).join(", ");
}

function addressText(value: { text: string } | { text: string }[] | undefined): string | undefined {
	if (!value) return undefined;
	return Array.isArray(value) ? value.map((v) => v.text).join(", ") : value.text;
}
