const assert = require('node:assert/strict');
const { createServer, buildDatabaseService } = require('../server');

function createMockDatabase(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  return {
    rows,
    async ping() {
      return true;
    },
    async saveInquiry(row) {
      rows.push(row);
    },
    async listInquiries(status = '') {
      return rows
        .filter((row) => !status || row.status === status)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    },
    async updateInquiryStatus(id, status) {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      row.status = status;
      return { ...row };
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

function adminAuthorization(username = 'rfq-admin', password = 'test-password') {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
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
    RESEND_TO: options.resendTo,
    ADMIN_USERNAME: options.adminUsername || 'rfq-admin',
    ADMIN_PASSWORD: options.adminPassword || 'test-password'
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
  const productionDatabaseService = buildDatabaseService({
    databaseService: null,
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'test-only-placeholder',
    databaseTable: 'rfqs'
  });
  assert.equal(typeof productionDatabaseService.ping, 'function');
  assert.equal(typeof productionDatabaseService.saveInquiry, 'function');
  assert.equal(typeof productionDatabaseService.listInquiries, 'function');
  assert.equal(typeof productionDatabaseService.updateInquiryStatus, 'function');

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

      const healthResponse = await fetch(`${base}/api/health`);
      const health = await healthResponse.json();
      assert.equal(healthResponse.status, 200);
      assert.equal(health.databaseConnected, true);
      assert.equal(health.emailConnected, true);
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

  await runCase('RFQ 管理接口拒绝未认证访问', {
    createDb: () => createMockDatabase(),
    testFn: async ({ base }) => {
      const response = await fetch(`${base}/api/admin/rfqs`);
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.success, false);
      assert.equal(response.headers.get('www-authenticate').includes('RFQ Admin'), true);

      const pageResponse = await fetch(`${base}/admin`, {
        headers: { Authorization: adminAuthorization() }
      });
      const page = await pageResponse.text();
      assert.equal(pageResponse.status, 200);
      assert.equal(page.includes('<h1>RFQ Management</h1>'), true);
    }
  });

  const adminRows = [
    {
      id: 'RFQ-20260907-AAAAAA', created_at: '2026-09-07T09:00:00.000Z', name: 'New Lead', company: 'Alpha',
      email: 'new@example.com', phone_or_whatsapp: '', country: 'US', product: 'CNC Milling', quantity: '10',
      specifications: '100 mm', notes: '', status: 'new'
    },
    {
      id: 'RFQ-20260906-BBBBBB', created_at: '2026-09-06T09:00:00.000Z', name: 'Quoted Lead', company: 'Beta',
      email: 'quoted@example.com', phone_or_whatsapp: '', country: 'US', product: 'CNC Turning', quantity: '5',
      specifications: '50 mm', notes: '', status: 'quoted'
    }
  ];
  await runCase('RFQ 管理接口支持筛选和更新状态', {
    createDb: () => createMockDatabase(adminRows),
    testFn: async ({ base, dbRows }) => {
      const headers = { Authorization: adminAuthorization() };
      const listResponse = await fetch(`${base}/api/admin/rfqs?status=new`, { headers });
      const listBody = await listResponse.json();
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.data.rfqs.length, 1);
      assert.equal(listBody.data.rfqs[0].id, 'RFQ-20260907-AAAAAA');

      const updateResponse = await fetch(`${base}/api/admin/rfqs/RFQ-20260907-AAAAAA/status`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'contacted' })
      });
      const updateBody = await updateResponse.json();
      assert.equal(updateResponse.status, 200);
      assert.equal(updateBody.data.rfq.status, 'contacted');
      assert.equal(dbRows[0].status, 'contacted');

      const invalidResponse = await fetch(`${base}/api/admin/rfqs/RFQ-20260907-AAAAAA/status`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deleted' })
      });
      assert.equal(invalidResponse.status, 400);
      assert.equal(dbRows[0].status, 'contacted');
    }
  });

  console.log('测试通过：RFQ 保存与通知、参数校验、管理后台认证、状态筛选与更新');
})().catch((error) => {
  console.error('测试失败:', error.message);
  process.exit(1);
});
