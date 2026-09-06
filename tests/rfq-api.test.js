const assert = require('node:assert/strict');
const { createServer } = require('../server');

function createMockDatabase() {
  const rows = [];
  return {
    rows,
    async ping() {
      return true;
    },
    async saveInquiry(row) {
      rows.push(row);
    }
  };
}

function createFailDatabase() {
  return {
    async ping() {
      return true;
    },
    async saveInquiry() {
      throw new Error('constraint violation');
    }
  };
}

function createMockEmail({ fail = false, messageId = 'mock-message-id', sentRef = null } = {}) {
  return async (payload) => {
    if (sentRef) {
      sentRef.subject = payload.subject;
      sentRef.text = payload.text;
      sentRef.to = payload.to;
      sentRef.from = payload.from;
    }
    if (fail) {
      throw new Error('Resend send failed');
    }
    return { id: messageId };
  };
}

function buildPayload(overrides = {}) {
  return {
    name: 'John Smith',
    company: 'Test Automation',
    email: 'john.smith.test@example.com',
    country: 'United States',
    product: 'Machine Guard',
    quantity: '3 sets',
    specs: '1800 × 1200 × 2000 mm',
    notes: 'Need delivery to Dallas.',
    material: '',
    date: '',
    usecase: 'Used for automated equipment.',
    consent: true,
    phone_or_whatsapp: '+1 555-111-2222',
    ...overrides
  };
}

async function submitRfq(base, overrides = {}) {
  const payload = buildPayload(overrides);
  const response = await fetch(`${base}/api/rfq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  return { response, body, payload };
}

async function runCase(title, options) {
  const db = options.createDb ? options.createDb() : createMockDatabase();
  const emailSender = options.emailSender;
  const server = createServer({
    port: 0,
    databaseService: db,
    emailSender,
    supabaseUrl: options.supabaseUrl,
    supabaseServiceRoleKey: options.supabaseServiceRoleKey,
    RESEND_API_KEY: options.resendApiKey,
    RESEND_FROM: options.resendFrom,
    RESEND_TO: options.resendTo
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return await options.testFn({ base, db, dbRows: db.rows });
  } finally {
    server.close();
  }
}

(async () => {
  const sentRef1 = {};
  await runCase('Resend mock 成功：正常保存并发送邮件', {
    createDb: () => createMockDatabase(),
    emailSender: createMockEmail({ sentRef: sentRef1, messageId: 'mock-resend-id' }),
    resendFrom: 'noreply@resend.dev',
    resendTo: 'ops@example.test',
    testFn: async ({ base, db, dbRows }) => {
      const { response, body } = await submitRfq(base, {
        name: 'John Smith Success'
      });
      assert.equal(response.status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.notification.status, 'sent');
      assert.equal(body.data.notification.providerId, 'mock-resend-id');
      assert.equal(body.data.notification.connected, true);
      assert.equal(body.data.status, 'new');
      assert.equal(dbRows.length, 1);
      assert.equal(/^RFQ-\d{8}-[A-Z0-9]{6}$/.test(body.data.id), true);
      assert.equal(dbRows[0].id, body.data.id);
      assert.equal(sentRef1.subject, `New RFQ | Machine Guard | 3 sets`);
      assert.equal(sentRef1.to, 'ops@example.test');
      assert.equal(sentRef1.from, 'noreply@resend.dev');
    }
  });

  await runCase('Resend 未配置时返回 not_configured，但 RFQ 仍保存', {
    createDb: () => createMockDatabase(),
    emailSender: null,
    testFn: async ({ base, dbRows }) => {
      const { response, body } = await submitRfq(base, {
        name: 'John Smith NotConfigured'
      });
      assert.equal(response.status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.notification.status, 'not_configured');
      assert.equal(body.data.notification.connected, false);
      assert.equal(dbRows.length, 1);
      assert.equal(dbRows[0].name, 'John Smith NotConfigured');
    }
  });

  await runCase('数据库失败返回错误，不发送邮件', {
    createDb: () => {
      const db = createFailDatabase();
      return db;
    },
    emailSender: async () => {
      throw new Error('should not send email when db failed');
    },
    testFn: async ({ base, db }) => {
      const { response, body } = await submitRfq(base, { name: 'John Smith FailDB' });
      assert.equal(response.status, 500);
      assert.equal(body.success, false);
      assert.equal(body.message.includes('数据库保存失败'), true);
      assert.equal((db.rows || []).length, 0);
    }
  });

  const sentRef2 = {};
  await runCase('邮件发送失败但 RFQ 仍保存', {
    createDb: () => createMockDatabase(),
    emailSender: createMockEmail({ fail: true, sentRef: sentRef2 }),
    testFn: async ({ base, dbRows }) => {
      const { response, body } = await submitRfq(base, {
        name: 'John Smith MailFail'
      });
      assert.equal(response.status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.notification.status, 'failed');
      assert.equal(body.data.notification.connected, true);
      assert.equal(dbRows.length, 1);
      assert.equal(dbRows[0].name, 'John Smith MailFail');
      assert.equal(/邮件发送失败/.test(body.data.notification.message), true);
    }
  });

  await runCase('参数错误返回 400', {
    createDb: () => createMockDatabase(),
    emailSender: createMockEmail({}),
    testFn: async ({ base }) => {
      const response = await fetch(`${base}/api/rfq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.message, '参数校验失败');
    }
  });

  console.log('测试通过：Resend mock 成功、数据库失败、未配置邮件、邮件失败仍保存、参数错误');
})().catch((error) => {
  console.error('测试失败:', error.message);
  process.exit(1);
});
