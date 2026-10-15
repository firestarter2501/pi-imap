/**
 * Integration tests. They need a real IMAP server; scripts/dev.sh test starts
 * Dovecot in podman and sets the IMAP_* environment variables.
 */

import assert from "node:assert/strict";
import net from "node:net";
import { before, describe, test } from "node:test";
import { ImapFlow } from "imapflow";
import extension from "../src/index.ts";
import * as imap from "../src/imap.ts";

const config = imap.configFromEnv();

/** Put a test message into a mailbox (test setup only). */
async function appendMessage(mailbox: string, subject: string, body: string, html = false) {
	const client = new ImapFlow({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: { user: config.user, pass: config.password },
		tls: { rejectUnauthorized: config.rejectUnauthorized },
		logger: false,
	});
	await client.connect();
	if (!(await client.list()).some((b) => b.path === mailbox)) await client.mailboxCreate(mailbox);
	const contentType = html ? "text/html" : "text/plain";
	// Headers must be ASCII, so encode the subject as RFC 2047 like real mail clients do.
	const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
	const raw =
		`From: Alice <alice@example.com>\r\nTo: test@localhost\r\nSubject: ${encodedSubject}\r\n` +
		`Date: ${new Date().toUTCString()}\r\nContent-Type: ${contentType}; charset=utf-8\r\n\r\n${body}\r\n`;
	await client.append(mailbox, raw);
	await client.logout();
}

/**
 * TCP proxy in front of the test server that can make the server go silent
 * (`stall`) or drop the connection (`reset`), like a flaky network would.
 * With `afterMs` set, every connection fails that long after it was opened.
 */
async function faultyProxy(targetPort: number, mode: "stall" | "reset", afterMs?: number) {
	const sockets = new Set<net.Socket>();
	let stalled = false;
	const fail = (client: net.Socket, upstream: net.Socket) => {
		if (mode === "reset") {
			client.resetAndDestroy();
			upstream.destroy();
		} else {
			stalled = true;
		}
	};
	const server = net.createServer((client) => {
		const upstream = net.connect(targetPort, config.host);
		sockets.add(client).add(upstream);
		client.on("data", (d) => stalled || upstream.write(d));
		upstream.on("data", (d) => stalled || client.write(d));
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
		if (afterMs !== undefined) setTimeout(() => fail(client, upstream), afterMs);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		/** Make the connection fail now. */
		fail() {
			const [client, upstream] = [...sockets];
			fail(client, upstream);
		},
		close() {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

/** Minimal stand-in for pi's ExtensionAPI, enough to load the extension. */
function fakePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const flags: Record<string, string | undefined> = {};
	let active: string[] = ["read", "bash"];
	const ctx = {
		hasUI: false,
		ui: { setStatus() {}, notify() {}, confirm: async () => true },
	};
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
			active.push(tool.name);
		},
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		registerFlag() {},
		getFlag: (name: string) => flags[name],
		on: (event: string, handler: any) => handlers.set(event, handler),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => (active = names),
	};
	extension(pi as any);
	return {
		flags,
		active: () => active,
		start: () => handlers.get("session_start")({}, ctx),
		command: (name: string, args: string) => commands.get(name).handler(args, ctx),
		run: async (name: string, params: any) => {
			const result = await tools.get(name).execute("id", params, undefined, undefined, ctx);
			return result.content[0].text as string;
		},
	};
}

describe("imap helpers", () => {
	before(async () => {
		await appendMessage("INBOX", "Hello from Alice", "First test message");
		await appendMessage("INBOX", "日本語の件名", "本文です");
		await appendMessage("INBOX", "HTML mail", "<p>Hello <b>HTML</b></p>", true);
	});

	test("lists mailboxes", async () => {
		const boxes = await imap.listMailboxes(config);
		assert.ok(boxes.some((b) => b.path === "INBOX"));
	});

	test("searches by subject and reads without marking as seen", async () => {
		const [found] = await imap.searchMessages(config, "INBOX", { subject: "Hello from Alice" });
		assert.ok(found);
		assert.match(found.from ?? "", /alice@example.com/);

		const message = await imap.readMessage(config, "INBOX", found.uid);
		assert.match(message.text, /First test message/);

		const [after] = await imap.searchMessages(config, "INBOX", { subject: "Hello from Alice" });
		assert.ok(!after.flags.includes("\\Seen"));
	});

	test("decodes non-ASCII and HTML-only messages", async () => {
		const [jp] = await imap.searchMessages(config, "INBOX", { subject: "日本語" });
		assert.equal(jp.subject, "日本語の件名");
		assert.match((await imap.readMessage(config, "INBOX", jp.uid)).text, /本文です/);

		const [html] = await imap.searchMessages(config, "INBOX", { subject: "HTML mail" });
		assert.match((await imap.readMessage(config, "INBOX", html.uid)).text, /Hello HTML/);
	});

	test("limit returns the newest messages", async () => {
		const results = await imap.searchMessages(config, "INBOX", { limit: 2 });
		assert.equal(results.length, 2);
		assert.ok(results[0].uid > results[1].uid);
	});
});

describe("extension modes", () => {
	test("starts in read-only mode with write tools inactive", async () => {
		const pi = fakePi();
		await pi.start();
		assert.ok(pi.active().includes("imap_search"));
		assert.ok(!pi.active().includes("imap_delete"));
		assert.ok(pi.active().includes("bash"), "other tools are left alone");
		await assert.rejects(pi.run("imap_delete", { mailbox: "INBOX", uids: [1] }), /read-only/);
	});

	test("--imap-mode read-write activates write tools", async () => {
		const pi = fakePi();
		pi.flags["imap-mode"] = "read-write";
		await pi.start();
		assert.ok(pi.active().includes("imap_set_flags"));
	});

	test("/imap-mode switches back and forth", async () => {
		const pi = fakePi();
		await pi.start();
		await pi.command("imap-mode", "read-write");
		assert.ok(pi.active().includes("imap_move"));
		await pi.command("imap-mode", "read-only");
		assert.ok(!pi.active().includes("imap_move"));
	});

	test("write tools work in read-write mode", async () => {
		await appendMessage("INBOX", "To be moved", "move me");
		await appendMessage("INBOX", "To be deleted", "delete me");
		const pi = fakePi();
		await pi.start();
		await pi.command("imap-mode", "read-write");

		const [moved] = await imap.searchMessages(config, "INBOX", { subject: "To be moved" });
		await pi.run("imap_set_flags", { mailbox: "INBOX", uids: [moved.uid], add: ["\\Flagged"] });
		await appendMessage("Archive", "placeholder", "creates the Archive mailbox");
		await pi.run("imap_move", { mailbox: "INBOX", uids: [moved.uid], destination: "Archive" });
		const [archived] = await imap.searchMessages(config, "Archive", { subject: "To be moved" });
		assert.ok(archived.flags.includes("\\Flagged"));

		const [doomed] = await imap.searchMessages(config, "INBOX", { subject: "To be deleted" });
		await pi.run("imap_delete", { mailbox: "INBOX", uids: [doomed.uid] });
		assert.equal((await imap.searchMessages(config, "INBOX", { subject: "To be deleted" })).length, 0);
	});

	test("tool output is readable text", async () => {
		const pi = fakePi();
		await pi.start();
		const out = await pi.run("imap_search", { subject: "Hello from Alice" });
		assert.match(out, /UID \d+ .*subject: Hello from Alice/);
		const uid = Number(out.match(/UID (\d+)/)![1]);
		const read = await pi.run("imap_read", { uid, maxChars: 5 });
		assert.match(read, /Subject: Hello from Alice/);
		assert.match(read, /\[truncated:/);
	});
});

describe("connection failures do not crash the process", () => {
	const targets = [
		{ name: "STARTTLS", port: config.port, secure: false },
		...(process.env.IMAP_TEST_TLS_PORT
			? [{ name: "implicit TLS", port: Number(process.env.IMAP_TEST_TLS_PORT), secure: true }]
			: []),
	];

	for (const target of targets) {
		for (const mode of ["stall", "reset"] as const) {
			test(`${target.name}: server ${mode}s after connecting`, async () => {
				const proxy = await faultyProxy(target.port, mode);
				const cfg = { ...config, host: "127.0.0.1", port: proxy.port, secure: target.secure, timeoutMs: 500 };
				try {
					// Without an 'error' listener this used to end the process with
					// "Unhandled 'error' event" instead of rejecting.
					await assert.rejects(
						imap.withClient(cfg, async (client) => {
							proxy.fail();
							return client.list();
						}),
						mode === "stall" ? /Socket timeout/ : /Connection not available|IMAP connection failed/,
					);
				} finally {
					proxy.close();
				}
			});

			test(`${target.name}: server ${mode}s at any point of the session`, async () => {
				for (const afterMs of [0, 10, 30, 60, 100, 200]) {
					const proxy = await faultyProxy(target.port, mode, afterMs);
					const cfg = { ...config, host: "127.0.0.1", port: proxy.port, secure: target.secure, timeoutMs: 500 };
					try {
						// Depending on timing the call may still succeed; it just must not crash or hang.
						await imap.listMailboxes(cfg).catch(() => undefined);
					} finally {
						proxy.close();
					}
				}
			});
		}
	}

	test("rejects a bad IMAP_TIMEOUT", () => {
		const env = { IMAP_HOST: "h", IMAP_USER: "u", IMAP_PASSWORD: "p" };
		assert.equal(imap.configFromEnv({ ...env, IMAP_TIMEOUT: "5" }).timeoutMs, 5000);
		assert.throws(() => imap.configFromEnv({ ...env, IMAP_TIMEOUT: "soon" }), /IMAP_TIMEOUT/);
	});
});
