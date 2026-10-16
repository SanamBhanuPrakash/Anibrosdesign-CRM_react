import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { SmtpTransport, renderMail } from '../platform/mail';

/**
 * Delivery regression for the nodemailer major upgrade (6 → 10, which closed the production-dependency advisories).
 * A tiny in-process SMTP listener records exactly what the transport puts on the wire, so this checks the real
 * delivery path (EHLO, MAIL FROM, RCPT TO, DATA) without any external mail service.
 */
interface Captured {
  mailFrom: string[];
  rcptTo: string[];
  data: string[];
  commands: string[];
}

function startSmtp(): Promise<{ port: number; seen: Captured; close: () => Promise<void> }> {
  const seen: Captured = { mailFrom: [], rcptTo: [], data: [], commands: [] };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let inData = false;
    let body = '';
    let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) {
            return;
          }
          body += buf.slice(0, end);
          buf = buf.slice(end + 5);
          seen.data.push(body);
          body = '';
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        seen.commands.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-test\r\n250 8BITMIME\r\n');
        else if (up.startsWith('MAIL FROM')) {
          seen.mailFrom.push(line);
          sock.write('250 ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          seen.rcptTo.push(line);
          sock.write('250 ok\r\n');
        } else if (up === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (up === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        seen,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

let smtp: Awaited<ReturnType<typeof startSmtp>>;
let tx: SmtpTransport;

beforeAll(async () => {
  smtp = await startSmtp();
  tx = new SmtpTransport({ host: '127.0.0.1', port: smtp.port, secure: false, from: 'Anibros CRM <no-reply@anibros.test>' });
});
afterAll(async () => {
  tx?.close();
  await smtp?.close();
});

describe('SMTP delivery (nodemailer 10)', () => {
  it('delivers a rendered verification mail with the right envelope, subject and link', async () => {
    const mail = renderMail('verify_email', 'person@example.com', { name: 'Priya' }, 'tok_ABC123');
    const r = await tx.send(mail);
    expect(r.messageId).toBeTruthy();
    expect(smtp.seen.mailFrom.at(-1)).toContain('no-reply@anibros.test');
    expect(smtp.seen.rcptTo.at(-1)).toContain('person@example.com');
    const raw = smtp.seen.data.at(-1)!;
    expect(raw).toMatch(/^Subject: =\?UTF-8\?Q\?Verify_your_email/im); // RFC 2047 encoded because of the dash
    const decoded = raw.replace(/=\r?\n/g, '').replace(/=3D/g, '='); // quoted-printable body
    expect(decoded).toContain('token=tok_ABC123');
    expect(raw).toMatch(/Content-Type: multipart\/alternative/i);
  });

  it('cannot be used to inject headers or extra recipients through the subject or address', async () => {
    const before = smtp.seen.rcptTo.length;
    await tx
      .send({ to: 'victim@example.com', subject: 'Hello\r\nBcc: attacker@evil.test', html: '<p>x</p>', text: 'x' })
      .catch(() => undefined);
    const raw = smtp.seen.data.at(-1) ?? '';
    // the injected text may only ever appear folded inside the Subject value, never as its own header
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(smtp.seen.rcptTo.slice(before).join(' ')).not.toContain('attacker@evil.test');

    const beforeRcpt = smtp.seen.rcptTo.length;
    const dataBefore = smtp.seen.data.length;
    for (const bad of ['a@example.com\r\nRCPT TO:<attacker@evil.test>', 'x@example.com, attacker@evil.test', 'Name <attacker@evil.test>', 'a@b.test;c@d.test', ' a@b.test']) {
      await expect(tx.send({ to: bad, subject: 'x', html: '<p>x</p>', text: 'x' }), bad).rejects.toThrow(/plain e-mail address/);
    }
    // nothing at all reached the wire for any of them
    expect(smtp.seen.rcptTo.length).toBe(beforeRcpt);
    expect(smtp.seen.data.length).toBe(dataBefore);
  });

  it('reports a refused connection as an error (so the job retries) instead of pretending it was sent', async () => {
    const dead = new SmtpTransport({ host: '127.0.0.1', port: 1, secure: false, from: 'x@anibros.test' });
    await expect(dead.send({ to: 'a@example.com', subject: 's', html: '<p>x</p>', text: 'x' })).rejects.toThrow();
    dead.close();
  });
});
