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
    async listInquiries(options = {}) {
      const { status = '', search = '', sort = 'newest', page = 1, pageSize = 20 } = options;
      const searchValue = search.toLowerCase();
      const searchFields = ['id', 'name', 'company', 'email', 'country', 'product'];
      const stats = { total: rows.length, new: 0, contacted: 0, quoted: 0, won: 0, lost: 0 };
      rows.forEach((row) => {
        if (Object.hasOwn(stats, row.status)) stats[row.status] += 1;
      });
      const filtered = rows
        .filter((row) => !status || row.status === status)
        .filter((row) => !searchValue || searchFields.some((field) => String(row[field] || '').toLowerCase().includes(searchValue)))
        .sort((left, right) => {
          const comparison = String(left.created_at).localeCompare(String(right.created_at));
          return sort === 'oldest' ? comparison : -comparison;
        });
      const from = (page - 1) * pageSize;
      return {
        rows: filtered.slice(from, from + pageSize).map((row) => ({ ...row })),
        total: filtered.length,
        stats
      };
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

function createFailAdminDatabase() {
  return {
    rows: [],
    async ping() {
      return true;
    },
    async saveInquiry() {
      return true;
    },
    async listInquiries() {
      throw new Error('admin query failed');
    },
    async updateInquiryStatus() {
      throw new Error('admin update failed');
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
      email: 'new@example.com', phone_or_whatsapp: '+1 555 010 1000', country: 'US', product: 'CNC Milling', quantity: '10',
      specifications: '100 mm', notes: '', status: 'new'
    },
    {
      id: 'RFQ-20260906-BBBBBB', created_at: '2026-09-06T09:00:00.000Z', name: 'Quoted Lead', company: 'Beta',
      email: 'quoted@example.com', phone_or_whatsapp: '', country: 'US', product: 'CNC Turning', quantity: '5',
      specifications: '50 mm', notes: '', status: 'quoted'
    },
    {
      id: 'RFQ-20260905-CCCCCC', created_at: '2026-09-05T09:00:00.000Z', name: 'Contacted Lead', company: 'Gamma',
      email: 'contacted@example.com', phone_or_whatsapp: '', country: 'Canada', product: 'Prototype', quantity: '2',
      specifications: '25 mm', notes: '', status: 'contacted'
    },
    {
      id: 'RFQ-20260904-DDDDDD', created_at: '2026-09-04T09:00:00.000Z', name: 'Won Lead', company: 'Delta',
      email: 'won@example.com', phone_or_whatsapp: '', country: 'Germany', product: 'CNC Milling', quantity: '40',
      specifications: '200 mm', notes: '', status: 'won'
    },
    {
      id: 'RFQ-20260903-EEEEEE', created_at: '2026-09-03T09:00:00.000Z', name: 'Lost Lead', company: 'Epsilon',
      email: 'lost@example.com', phone_or_whatsapp: '', country: 'France', product: 'CNC Turning', quantity: '12',
      specifications: '75 mm', notes: '', status: 'lost'
    },
    {
      id: 'RFQ-20260902-FFFFFF', created_at: '2026-09-02T09:00:00.000Z', name: 'Second New Lead', company: 'Zeta',
      email: 'second-new@example.com', phone_or_whatsapp: '', country: 'Japan', product: 'Small Production', quantity: '100',
      specifications: '15 mm', notes: '', status: 'new'
    }
  ];
  await runCase('RFQ 管理接口支持读取、统计、筛选、搜索、分页、排序和状态更新', {
    createDb: () => createMockDatabase(adminRows),
    testFn: async ({ base, dbRows }) => {
      const headers = { Authorization: adminAuthorization() };
      const listResponse = await fetch(`${base}/api/admin/rfqs`, { headers });
      const listBody = await listResponse.json();
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.data.rfqs.length, 6);
      assert.equal(listBody.data.rfqs[0].id, 'RFQ-20260907-AAAAAA');
      assert.deepEqual(listBody.data.stats, { total: 6, new: 2, contacted: 1, quoted: 1, won: 1, lost: 1 });
      assert.deepEqual(listBody.data.pagination, { page: 1, pageSize: 20, total: 6, hasMore: false });

      const filteredResponse = await fetch(`${base}/api/admin/rfqs?status=new&search=Alpha`, { headers });
      const filteredBody = await filteredResponse.json();
      assert.equal(filteredResponse.status, 200);
      assert.equal(filteredBody.data.rfqs.length, 1);
      assert.equal(filteredBody.data.rfqs[0].id, 'RFQ-20260907-AAAAAA');
      assert.equal(filteredBody.data.pagination.total, 1);

      for (const search of ['RFQ-20260906-BBBBBB', 'Contacted Lead', 'Delta', 'lost@example.com', 'Japan', 'Prototype']) {
        const response = await fetch(`${base}/api/admin/rfqs?search=${encodeURIComponent(search)}`, { headers });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.data.rfqs.length, 1);
      }

      const pageResponse = await fetch(`${base}/api/admin/rfqs?page=2&pageSize=2`, { headers });
      const pageBody = await pageResponse.json();
      assert.equal(pageResponse.status, 200);
      assert.deepEqual(pageBody.data.rfqs.map((row) => row.id), ['RFQ-20260905-CCCCCC', 'RFQ-20260904-DDDDDD']);
      assert.deepEqual(pageBody.data.pagination, { page: 2, pageSize: 2, total: 6, hasMore: true });

      const oldestResponse = await fetch(`${base}/api/admin/rfqs?sort=oldest&pageSize=2`, { headers });
      const oldestBody = await oldestResponse.json();
      assert.equal(oldestResponse.status, 200);
      assert.deepEqual(oldestBody.data.rfqs.map((row) => row.id), ['RFQ-20260902-FFFFFF', 'RFQ-20260903-EEEEEE']);

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

      for (const query of ['status=deleted', 'sort=random', 'page=0', 'pageSize=101', `search=${'x'.repeat(101)}`]) {
        const response = await fetch(`${base}/api/admin/rfqs?${query}`, { headers });
        assert.equal(response.status, 400);
      }
    }
  });

  await runCase('RFQ 管理数据库失败返回明确错误', {
    createDb: () => createFailAdminDatabase(),
    testFn: async ({ base }) => {
      const headers = { Authorization: adminAuthorization() };
      const listResponse = await fetch(`${base}/api/admin/rfqs`, { headers });
      const listBody = await listResponse.json();
      assert.equal(listResponse.status, 500);
      assert.equal(listBody.message, 'Unable to load RFQs.');

      const updateResponse = await fetch(`${base}/api/admin/rfqs/RFQ-20260907-AAAAAA/status`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'quoted' })
      });
      const updateBody = await updateResponse.json();
      assert.equal(updateResponse.status, 500);
      assert.equal(updateBody.message, 'Unable to update RFQ status.');
    }
  });

  console.log('测试通过：RFQ/Resend/健康检查、后台认证、统计、筛选、搜索、分页、排序与状态更新');
})().catch((error) => {
  console.error('测试失败:', error.message);
  process.exit(1);
});
