const http = require('node:http');
const fs = require('node:fs/promises');
const fse = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let supabase = null;
try {
  supabase = require('@supabase/supabase-js');
} catch (err) {
  supabase = null;
}

const ROOT_DIR = path.resolve(__dirname);

function parseEnvFile(filePath) {
  if (!fse.existsSync(filePath)) return {};
  const text = fse.readFileSync(filePath, 'utf8');
  const result = {};
  text.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const idx = t.indexOf('=');
    if (idx < 0) return;
    const key = t.slice(0, idx).trim();
    const value = t.slice(idx + 1).trim();
    if (!key) return;
    result[key] = value;
  });
  return result;
}

function parseIntFallback(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseList(value) {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function buildConfig(overrides = {}) {
  const env = parseEnvFile(path.join(ROOT_DIR, '.env'));
  const merged = { ...env, ...process.env, ...overrides };
  const nodeEnv = merged.NODE_ENV || merged.NODE_ENVIRONMENT || 'development';
  const isProd = nodeEnv === 'production';

  return {
    port: parseIntFallback(merged.PORT, 3000),
    host: merged.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
    uiPath: path.join(ROOT_DIR, 'smart-rfq-visual-demo.html'),
    maxPayloadBytes: parseIntFallback(merged.RFQ_MAX_PAYLOAD_BYTES, 50000),
    supabaseUrl: merged.supabaseUrl || merged.SUPABASE_URL || '',
    supabaseServiceRoleKey: merged.supabaseServiceRoleKey || merged.SUPABASE_SERVICE_ROLE_KEY || '',
    databaseTable: merged.databaseTable || merged.SUPABASE_RFQ_TABLE || 'rfqs',
    resendApiKey: merged.resendApiKey || merged.RESEND_API_KEY || '',
    resendFrom: merged.resendFrom || merged.RESEND_FROM || '',
    resendTo: merged.resendTo || merged.RESEND_TO || '',
    corsOrigins: parseList(merged.CORS_ORIGINS || merged.CORS_ALLOW_ORIGINS || merged.ALLOWED_ORIGINS),
    allowedDevOrigin: merged.CORS_ALLOW_DEV_ORIGIN === '1' || merged.CORS_ALLOW_DEV_ORIGIN === 'true',
    securityHeadersEnabled: merged.SECURITY_HEADERS_ENABLED !== '0',
    nodeEnv,
    isProd,
    // For tests
    databaseService: merged.databaseService || null,
    emailSender: merged.emailSender || null
  };
}

function setCorsHeaders(req, res, config) {
  const requestOrigin = String(req.headers.origin || '');
  let allowOrigin = '*';

  if (config.isProd && config.corsOrigins.length > 0) {
    allowOrigin = config.corsOrigins.includes(requestOrigin) ? requestOrigin : 'null';
  } else if (config.isProd && !config.corsOrigins.length) {
    allowOrigin = requestOrigin || 'null';
  }

  if (!config.isProd && config.allowedDevOrigin && requestOrigin) {
    allowOrigin = requestOrigin;
  }

  if (config.isProd && requestOrigin && allowOrigin === 'null') {
    return; // 不允许未知来源跨域，浏览器会阻断
  }

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '0');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      resolve(body);
    });

    req.on('error', (error) => reject(error));
  });
}

function normalize(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim() || fallback;
}

function validateSubmission(payload) {
  const required = [];
  const errors = [];

  if (!payload.name) required.push('name');
  if (!payload.email) required.push('email');
  if (!payload.country) required.push('country');
  if (!payload.product) required.push('product');
  if (!payload.quantity) required.push('quantity');

  if (!payload.consent) errors.push('请勾选同意条款');
  if (!payload.email.includes('@')) errors.push('邮箱格式不正确');
  if (required.length) errors.push(`缺少必填字段：${required.join('、')}`);

  return {
    ok: errors.length === 0,
    errors
  };
}

function buildMissingList(payload) {
  const missing = [];
  if (!payload.material) missing.push('请确认产品材料、面板或表面处理要求。');
  if (!payload.specs) missing.push('请提供大致尺寸、结构要求或参考图纸。');
  if (!payload.usecase) missing.push('请说明产品的实际使用场景。');
  if (!payload.date) missing.push('请确认期望交付时间。');
  if (!/送货|delivery|deliver|城市|city|州|省|Texas|Dallas/i.test(payload.notes)) missing.push('请提供具体送货城市或邮编。');
  if (payload.product.includes('防护罩')) {
    missing.push('请确认门的开启方向，以及是否需要安全联锁。');
    missing.push('如有设备运动范围或参考图纸，请一并提供。');
  }
  return [...new Set(missing)].slice(0, 4);
}

function buildSummary(payload) {
  const specs = payload.specs || '未填写';
  const usecase = payload.usecase || '未填写';
  const notes = payload.notes || '未填写';
  return `${payload.country}客户计划采购${payload.quantity}${payload.product}，${specs !== '未填写' ? `主要规格为${specs}，` : ''}${usecase !== '未填写' ? `用途是${usecase.replace(/[。.]$/, '')}，` : ''}${notes !== '未填写' ? `补充说明：${notes}` : '等待进一步确认细节。'}`;
}

function buildEnglishDraft(payload) {
  const firstName = payload.name.split(/\s+/)[0] || payload.name;
  const questions = [];
  if (!payload.material) questions.push('the preferred material or panel specification');
  if (!payload.specs) questions.push('the approximate dimensions or a reference drawing');
  if (payload.product.includes('防护罩')) questions.push('the door opening direction and whether a safety interlock is required');
  if (!payload.date) questions.push('the preferred delivery date');
  const ask = questions.length ? `Before preparing a proposal, could you please confirm ${questions.join(', ')}?` : 'The information provided is sufficient for an initial technical review.';
  return `Hi ${firstName},\n\nThank you for your inquiry regarding ${payload.quantity} of ${payload.product}. We have received the information you provided.\n\n${ask}\n\nOnce these details are confirmed, our team can review the requirements and prepare the next step. Please note that final pricing and lead time will be confirmed after an engineering review.`;
}

function calcCompleteness(payload) {
  const fields = [payload.name, payload.email, payload.country, payload.product, payload.quantity, payload.specs, payload.material, payload.date, payload.usecase, payload.notes];
  const filled = fields.filter((value) => value && value !== '未填写').length;
  return {
    percent: Math.round(filled / fields.length * 100),
    priority: filled >= 8 ? '较高' : filled >= 6 ? '普通' : '较低'
  };
}

function generateInquiryId() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('');
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `RFQ-${date}-${random}`;
}

function buildDatabaseService(config) {
  if (config.databaseService) return config.databaseService;
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return null;
  if (!supabase || !supabase.createClient) return null;

  const client = supabase.createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return {
    async ping() {
      const { error } = await client
        .from(config.databaseTable)
        .select('id', { head: true, count: 'exact' })
        .limit(1);
      if (error) {
        throw error;
      }
      return true;
    },
    async saveInquiry(row) {
      const { error } = await client
        .from(config.databaseTable)
        .insert([row]);
      if (error) {
        throw new Error(error.message || '数据库保存失败');
      }
      return true;
    }
  };
}

function normalizeErrorMessage(err) {
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isDatabaseConfigured(config) {
  return !!config.databaseService && Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

function buildEmailSender(config) {
  if (config.emailSender) return config.emailSender;
  if (!config.resendApiKey || !config.resendFrom || !config.resendTo) return null;

  return async function sendWithResend(payload) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: config.resendFrom,
        to: config.resendTo,
        subject: payload.subject,
        text: payload.text,
        html: payload.html
      })
    });

    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text };
    }

    if (!response.ok) {
      throw new Error(parsed.error || parsed.message || `发送失败（HTTP ${response.status}）`);
    }

    return parsed;
  };
}

function isEmailConfigured(config) {
  return !!(config.emailSender || (config.resendApiKey && config.resendFrom && config.resendTo));
}

async function sendMailNotification(config, payload, summary, missingList) {
  if (!isEmailConfigured(config)) {
    return {
      connected: false,
      status: 'not_configured',
      message: '尚未连接：请先配置邮件服务（RESEND_API_KEY/RESEND_FROM/RESEND_TO）。'
    };
  }

  const questions = missingList.length ? missingList : ['当前资料较完整，业务员可直接进行技术确认。'];
  const subject = `New RFQ | ${payload.product} | ${payload.quantity}`;
  const requirements = [
    payload.specs ? `- Specifications: ${payload.specs}` : '- Specifications: 未填写',
    payload.usecase ? `- Use Case: ${payload.usecase}` : '- Use Case: 未填写',
    payload.notes ? `- Notes: ${payload.notes}` : '- Notes: 未填写'
  ];

  const missingText = missingList.length ? missingList.map((item, index) => `${index + 1}. ${item}`) : ['1. 当前资料较完整，业务员可直接进行技术确认。'];

  const mailPayload = {
    from: config.resendFrom,
    to: config.resendTo,
    subject,
    text: [
      `RFQ ID: ${payload.id}`,
      `Name: ${payload.name}`,
      `Company: ${payload.company || '未填写'}`,
      `Email / Contact: ${payload.email}`,
      `Product: ${payload.product}`,
      `Quantity: ${payload.quantity}`,
      `Requirements:`,
      ...requirements,
      `Submitted time: ${payload.createdAt}`,
      '',
      '中文摘要：',
      summary,
      '',
      '待补项：',
      ...missingText
    ].join('\n')
  };

  try {
    const response = await config.emailSender(mailPayload);
    return {
      connected: true,
      status: 'sent',
      message: '邮件已发送',
      providerId: response && response.id ? response.id : null
    };
  } catch (error) {
    console.error('邮件发送失败:', normalizeErrorMessage(error), 'from=', config.resendFrom, 'to=', config.resendTo);
    return {
      connected: true,
      status: 'failed',
      message: `邮件发送失败：${normalizeErrorMessage(error)}`
    };
  }
}

function mapRequestPayload(payloadInput) {
  return {
    name: normalize(payloadInput.name),
    company: normalize(payloadInput.company, '未填写'),
    email: normalize(payloadInput.email),
    phone_or_whatsapp: normalize(payloadInput.phone_or_whatsapp),
    country: normalize(payloadInput.country),
    product: normalize(payloadInput.product),
    quantity: normalize(payloadInput.quantity),
    specs: normalize(payloadInput.specs),
    notes: normalize(payloadInput.notes),
    material: normalize(payloadInput.material),
    date: normalize(payloadInput.date),
    usecase: normalize(payloadInput.usecase),
    consent: !!payloadInput.consent
  };
}

function buildDbRecord(record) {
  return {
    id: record.id,
    created_at: record.createdAt,
    name: record.name,
    company: record.company,
    email: record.email,
    phone_or_whatsapp: record.phone_or_whatsapp,
    country: record.country,
    product: record.product,
    quantity: record.quantity,
    specifications: record.specs,
    notes: record.notes,
    status: 'new'
  };
}

async function handleApiRfq(req, res, config) {
  let rawBody;
  try {
    rawBody = await readBody(req, config.maxPayloadBytes);
  } catch (error) {
    if (error.message === 'payload_too_large') {
      return sendJson(res, 413, { success: false, message: '请求内容过大' });
    }
    return sendJson(res, 400, { success: false, message: '读取请求失败' });
  }

  let payloadInput = {};
  try {
    payloadInput = JSON.parse(rawBody || '{}');
  } catch {
    return sendJson(res, 400, { success: false, message: 'JSON 解析失败' });
  }

  const payload = mapRequestPayload(payloadInput);

  const validation = validateSubmission(payload);
  if (!validation.ok) {
    return sendJson(res, 400, {
      success: false,
      message: '参数校验失败',
      errors: validation.errors
    });
  }

  const record = {
    id: generateInquiryId(),
    createdAt: new Date().toISOString(),
    name: payload.name,
    company: payload.company,
    email: payload.email,
    phone_or_whatsapp: payload.phone_or_whatsapp || '未填写',
    country: payload.country,
    product: payload.product,
    quantity: payload.quantity,
    specs: payload.specs || '未填写',
    notes: payload.notes || '未填写',
    material: payload.material || '未填写',
    date: payload.date || '未填写',
    usecase: payload.usecase || '未填写',
    consent: payload.consent,
    sourceIp: req.socket.remoteAddress || '',
    userAgent: req.headers['user-agent'] || '',
    status: 'new'
  };

  try {
    await config.databaseService.saveInquiry(buildDbRecord(record));
  } catch (error) {
    console.error('数据库保存失败:', normalizeErrorMessage(error), 'table=', config.databaseTable);
    return sendJson(res, 500, {
      success: false,
      message: `数据库保存失败：${normalizeErrorMessage(error)}`
    });
  }

  const missing = buildMissingList({
    ...payload,
    specs: record.specs,
    material: record.material === '未填写' ? '' : record.material,
    notes: record.notes === '未填写' ? '' : record.notes
  });
  const summary = buildSummary({
    ...payload,
    specs: record.specs,
    usecase: record.usecase,
    notes: record.notes
  });
  const englishDraft = buildEnglishDraft(payload);
  const completeness = calcCompleteness(record);
  const aiPayload = {
    id: record.id,
    ...record,
    missing,
    summary,
    englishDraft,
    completeness
  };

  const notification = await sendMailNotification(config, aiPayload, summary, missing);

  return sendJson(res, 201, {
    success: true,
    message: notification.connected ? '保存成功，通知已处理' : '保存成功，但邮件尚未连接',
    data: {
      id: record.id,
      receivedAt: record.createdAt,
      status: record.status,
      aiSummary: summary,
      missingList: missing,
      replyDraft: englishDraft,
      completenessPercent: completeness.percent,
      completenessPriority: completeness.priority,
      notification
    },
    record: {
      id: record.id,
      createdAt: record.createdAt,
      name: record.name,
      company: record.company,
      email: record.email,
      country: record.country,
      product: record.product,
      quantity: record.quantity,
      specs: record.specs,
      material: record.material,
      date: record.date,
      usecase: record.usecase,
      notes: record.notes,
      consent: record.consent,
      sourceIp: record.sourceIp,
      userAgent: record.userAgent,
      status: record.status
    }
  });
}

async function serveStatic(res, filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end('Not Found');
  }
}

async function getHealthStatus(config) {
  const status = {
    databaseConnected: false,
    emailConnected: false
  };

  if (config.databaseService) {
    try {
      await config.databaseService.ping();
      status.databaseConnected = true;
    } catch {
      status.databaseConnected = false;
    }
  }

  status.emailConnected = isEmailConfigured(config);

  return status;
}

function getPath(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

function createServer(overrides = {}) {
  const config = buildConfig(overrides);
  const dbService = buildDatabaseService(config);
  const emailSender = buildEmailSender(config);
  const serverConfig = {
    ...config,
    databaseService: dbService,
    emailSender
  };

  const server = http.createServer(async (req, res) => {
    try {
      setCorsHeaders(req, res, serverConfig);
      if (serverConfig.securityHeadersEnabled) {
        setSecurityHeaders(res);
      }

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const pathname = getPath(req.url || '');
      if (req.method === 'GET' && pathname === '/api/health') {
        const health = {
          ok: true,
          ...(await getHealthStatus(serverConfig))
        };
        return sendJson(res, 200, health);
      }

      if (req.method === 'POST' && pathname === '/api/rfq') {
        if (!serverConfig.databaseService) {
          return sendJson(res, 500, {
            success: false,
            message: '数据库未连接：请先配置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY。'
          });
        }
        return handleApiRfq(req, res, serverConfig);
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/smart-rfq-visual-demo.html')) {
        return serveStatic(res, serverConfig.uiPath);
      }

      if (req.method === 'GET') {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      sendJson(res, 405, { message: 'Method Not Allowed' });
    } catch (error) {
      console.error('请求处理失败：', normalizeErrorMessage(error));
      sendJson(res, 500, {
        success: false,
        message: '服务器内部错误，请稍后再试。'
      });
    }
  });

  server._rfqConfig = serverConfig;
  return server;
}

function startServer(config) {
  const server = createServer(config);
  return new Promise((resolve, reject) => {
    server.listen(server._rfqConfig.port, server._rfqConfig.host, () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = {
  createServer,
  parseEnvFile,
  buildConfig,
  buildSummary,
  buildEnglishDraft,
  buildMissingList,
  calcCompleteness,
  sendMailNotification,
  generateInquiryId,
  buildDatabaseService,
  mapRequestPayload,
  buildDbRecord
};

if (require.main === module) {
  startServer().then((server) => {
    const config = server._rfqConfig;
    console.log(`RFQ server running at http://${config.host}:${config.port}`);
  }).catch((error) => {
    console.error('启动服务失败：', error.message);
    process.exit(1);
  });
}
